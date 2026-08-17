export type TranscriptSource = 'interviewer' | 'you'

export type TranscriptEntry = {
  source: TranscriptSource
  text: string
  speaker?: number
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

export function speakerLabel(
  line: TranscriptEntry,
  speakerNames: Readonly<Record<number, string>>,
  meeting: boolean
): string {
  if (line.source === 'you') return 'Me'
  const named = line.speaker == null ? '' : speakerNames[line.speaker]?.trim()
  if (named) return named
  const fallback = meeting ? 'Speaker' : 'Interviewer'
  return line.speaker == null ? fallback : `${fallback} ${line.speaker + 1}`
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
