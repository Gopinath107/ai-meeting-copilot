export type TranscriptSource = 'interviewer' | 'you'

export type TranscriptEntry = {
  source: TranscriptSource
  text: string
  /** Local wall-clock time when the utterance became a committed transcript line. */
  timestampMs?: number
  speaker?: number
  /**
   * A label frozen at the end of a diarization stream. Speaker indexes restart
   * when Deepgram reconnects, so old lines must not keep reading from the live
   * index-to-name map or a new Speaker 0 could relabel an earlier person.
   */
  speakerName?: string
  provisional?: boolean
  bestEffort?: boolean
}

export type TranscriptInterim = Record<TranscriptSource, string>

export type AiRangeKind = 'answer' | 'analysis'

export type PendingHandledRange = {
  kind: AiRangeKind
  end: number
}

export type AiRequestOutcome = 'done' | 'error' | 'cancelled' | 'timeout'

export type SessionTrackingState = {
  lastAnalyzedCount: number
  lastAnsweredCount: number
  summarizedUpto: number
  summarizeTarget: number
  turnHasQuestion: boolean
  turnDirected: boolean
  queuedInterviewQuestion: boolean
  meetingSummary: string
  summaryAccumulator: string
  answerAccumulator: string
  analysisAccumulator: string
  consultantAccumulator: string
  minutesAccumulator: string
}

/**
 * The complete non-React tracking state for a brand-new meeting/interview.
 * Keeping this pure makes reset behavior deterministic and easy to test.
 */
export function createSessionTrackingState(): SessionTrackingState {
  return {
    lastAnalyzedCount: 0,
    lastAnsweredCount: 0,
    summarizedUpto: 0,
    summarizeTarget: 0,
    turnHasQuestion: false,
    turnDirected: false,
    queuedInterviewQuestion: false,
    meetingSummary: '',
    summaryAccumulator: '',
    answerAccumulator: '',
    analysisAccumulator: '',
    consultantAccumulator: '',
    minutesAccumulator: ''
  }
}

/** Only a successful request that produced content may consume a transcript range. */
export function shouldMarkAiRangeHandled(outcome: AiRequestOutcome, output: string): boolean {
  return outcome === 'done' && output.trim().length > 0
}

function normalizeForDuplicateCheck(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/g, '')
}

/**
 * Merge any ASR interim tail into a stable transcript snapshot. If the interim
 * repeats a line, skip it. Only merge an extension into a line that was itself
 * promoted from interim speech; a genuinely finalized line remains a distinct
 * utterance even when the next utterance starts with the same words.
 */
export function mergeTranscriptForMinutes(
  finals: readonly TranscriptEntry[],
  interim: TranscriptInterim
): TranscriptEntry[] {
  const merged: TranscriptEntry[] = finals.map((line) => ({
    ...line,
    ...(line.bestEffort || line.provisional ? { bestEffort: true } : {})
  }))

  for (const source of ['interviewer', 'you'] as const) {
    const pending = interim[source].trim()
    if (!pending) continue

    let lastSourceIndex = -1
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (merged[index].source === source) {
        lastSourceIndex = index
        break
      }
    }

    if (lastSourceIndex === -1) {
      merged.push({ source, text: pending, bestEffort: true })
      continue
    }

    const existing = merged[lastSourceIndex].text.trim()
    const normalizedExisting = normalizeForDuplicateCheck(existing)
    const normalizedPending = normalizeForDuplicateCheck(pending)
    if (!normalizedPending || normalizedPending === normalizedExisting) continue

    if (merged[lastSourceIndex].provisional && normalizedPending.startsWith(normalizedExisting)) {
      merged[lastSourceIndex] = { ...merged[lastSourceIndex], text: pending, bestEffort: true }
    } else if (
      !merged[lastSourceIndex].provisional ||
      !normalizedExisting.startsWith(normalizedPending)
    ) {
      merged.push({ source, text: pending, bestEffort: true })
    }
  }

  return merged.map((line) => ({ ...line, provisional: false }))
}

/**
 * Close the transcript segment owned by a socket before ASR reconnects. New
 * sockets restart their provisional state, so leaving an old provisional line
 * open would let the first result from the new socket overwrite it.
 */
export function sealTranscriptSourceForReconnect(
  lines: readonly TranscriptEntry[],
  source: TranscriptSource,
  interimText: string,
  timestampMs = Date.now()
): TranscriptEntry[] {
  const pending = interimText.trim()
  let lastSourceIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].source === source) {
      lastSourceIndex = index
      break
    }
  }

  const lastWasProvisional =
    lastSourceIndex >= 0 && Boolean(lines[lastSourceIndex].provisional)
  const sealed = lines.map((line) =>
    line.source === source && line.provisional
      ? { ...line, provisional: false, bestEffort: true }
      : { ...line }
  )
  if (!pending) return sealed

  if (lastSourceIndex >= 0) {
    const existing = sealed[lastSourceIndex].text.trim()
    const normalizedExisting = normalizeForDuplicateCheck(existing)
    const normalizedPending = normalizeForDuplicateCheck(pending)
    if (
      !normalizedPending ||
      normalizedPending === normalizedExisting ||
      normalizedExisting.startsWith(normalizedPending)
    ) {
      return sealed
    }
    if (lastWasProvisional && normalizedPending.startsWith(normalizedExisting)) {
      sealed[lastSourceIndex] = {
        ...sealed[lastSourceIndex],
        text: pending,
        bestEffort: true
      }
      return sealed
    }
  }

  sealed.push({ source, text: pending, timestampMs, bestEffort: true })
  return sealed
}

export function speakerLabel(
  line: TranscriptEntry,
  speakerNames: Readonly<Record<number, string>>,
  meeting: boolean
): string {
  if (line.source === 'you') return 'Me'
  const frozenName = line.speakerName?.trim()
  if (frozenName) return frozenName
  const named = line.speaker == null ? '' : speakerNames[line.speaker]?.trim()
  if (named) return named
  const fallback = meeting ? 'Speaker' : 'Interviewer'
  return line.speaker == null ? fallback : `${fallback} ${line.speaker + 1}`
}

export type IndexedTranscriptEntry = {
  line: TranscriptEntry
  index: number
}

/** Return finalized transcript matches while retaining their indexes in the full list. */
export function filterTranscriptEntries(
  lines: readonly TranscriptEntry[],
  query: string,
  speakerNames: Readonly<Record<number, string>>,
  meeting: boolean
): IndexedTranscriptEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()

  return lines.flatMap((line, index) => {
    if (line.provisional) return []
    if (!normalizedQuery) return [{ line, index }]

    const searchable = `${speakerLabel(line, speakerNames, meeting)} ${line.text}`.toLocaleLowerCase()
    return searchable.includes(normalizedQuery) ? [{ line, index }] : []
  })
}

/** Immutable edit helper. Blank edits and invalid indexes are rejected. */
export function editTranscriptEntry(
  lines: readonly TranscriptEntry[],
  index: number,
  text: string
): TranscriptEntry[] | null {
  const normalizedText = text.trim()
  const current = lines[index]
  if (!current || current.provisional || !normalizedText) return null
  if (current.text === normalizedText) return lines.slice()

  const next = lines.slice()
  next[index] = { ...current, text: normalizedText }
  return next
}

/** Immutable delete helper. Provisional lines cannot be removed through finalized-line controls. */
export function deleteTranscriptEntry(
  lines: readonly TranscriptEntry[],
  index: number
): TranscriptEntry[] | null {
  const current = lines[index]
  if (!current || current.provisional) return null
  return [...lines.slice(0, index), ...lines.slice(index + 1)]
}

export function formatTranscriptTimestamp(timestampMs?: number): string {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return '--:--:--'
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

/** User-facing export format. AI prompts continue using formatTranscript without timestamps. */
export function formatTranscriptExport(
  lines: readonly TranscriptEntry[],
  speakerNames: Readonly<Record<number, string>>,
  meeting: boolean
): string {
  return lines
    .filter((line) => !line.provisional && line.text.trim())
    .map(
      (line) =>
        `[${formatTranscriptTimestamp(line.timestampMs)}] ${speakerLabel(line, speakerNames, meeting)}: ${line.text.trim()}${
          line.bestEffort ? ' [best-effort unfinalized tail]' : ''
        }`
    )
    .join('\n')
}

export function transcriptExportFilename(meeting: boolean, timestampMs = Date.now()): string {
  const date = new Date(timestampMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(
    date.getHours()
  )}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `${meeting ? 'meeting' : 'interview'}-transcript_${stamp}.txt`
}

export function formatTranscript(
  lines: readonly TranscriptEntry[],
  speakerNames: Readonly<Record<number, string>>,
  meeting: boolean
): string {
  return lines
    .map(
      (line) =>
        `${speakerLabel(line, speakerNames, meeting)}: ${line.text.trim()}${
          line.bestEffort ? ' [best-effort unfinalized tail]' : ''
        }`
    )
    .filter((line) => !line.endsWith(': '))
    .join('\n')
}
