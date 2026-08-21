import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptEntry, TranscriptInterim, TranscriptSource } from './session'
import { filterTranscriptEntries, formatTranscriptTimestamp } from './session'

const INTERVIEWER_COLORS = [
  'text-amber-300',
  'text-orange-300',
  'text-yellow-300',
  'text-rose-300'
]
const PAGE_SIZE = 160

export type CaptureDisplayState = 'idle' | 'starting' | 'active' | 'finalizing'

function TranscriptLine({
  source,
  text,
  interim,
  speaker,
  meeting,
  name,
  timestampMs,
  lineIndex,
  onEdit,
  onDelete,
  mutationsDisabled
}: {
  source: TranscriptSource
  text: string
  interim: boolean
  speaker?: number
  meeting: boolean
  name?: string
  timestampMs?: number
  lineIndex?: number
  onEdit?: (index: number, text: string) => boolean
  onDelete?: (index: number) => void
  mutationsDisabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const isInterviewer = source === 'interviewer'
  const color = isInterviewer
    ? INTERVIEWER_COLORS[(speaker ?? 0) % INTERVIEWER_COLORS.length]
    : 'text-sky-300'
  const speakerWord = meeting ? 'Speaker' : 'Interviewer'
  const label = isInterviewer
    ? name?.trim() || (speaker == null ? speakerWord : `${speakerWord} ${speaker + 1}`)
    : 'You'
  const editable =
    !interim && !mutationsDisabled && lineIndex != null && onEdit != null && onDelete != null

  function beginEdit(): void {
    setDraft(text)
    setConfirmingDelete(false)
    setEditing(true)
  }

  function saveEdit(): void {
    if (lineIndex == null || !onEdit?.(lineIndex, draft)) return
    setEditing(false)
  }

  return (
    <div className={`transcript-line group rounded px-1 py-0.5 hover:bg-white/[0.035] ${interim ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <span className={`mr-1.5 text-[10px] font-semibold uppercase ${color}`}>{label}</span>
          {timestampMs != null && (
            <time
              dateTime={new Date(timestampMs).toISOString()}
              title={new Date(timestampMs).toLocaleString()}
              className="mr-1.5 text-[9px] tabular-nums text-zinc-600"
            >
              {formatTranscriptTimestamp(timestampMs)}
            </time>
          )}
          {editing ? (
            <form
              className="mt-1 flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                saveEdit()
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditing(false)
                }}
                aria-label={`Edit transcript line by ${label}`}
                className="min-w-0 flex-1 rounded border border-indigo-400/40 bg-black/50 px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                className="rounded bg-indigo-500/25 px-1.5 py-0.5 text-[10px] text-indigo-100 hover:bg-indigo-500/35 disabled:opacity-40"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/10"
              >
                Cancel
              </button>
            </form>
          ) : (
            <span>{text}</span>
          )}
        </div>
        {editable && !editing && (
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {confirmingDelete ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onDelete(lineIndex)
                    setConfirmingDelete(false)
                  }}
                  className="rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] text-red-200 hover:bg-red-500/30"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:bg-white/10"
                >
                  Keep
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={beginEdit}
                  title="Edit finalized transcript line"
                  className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  title="Delete finalized transcript line"
                  className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:bg-red-500/15 hover:text-red-200"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function ParticipantNameEditor({
  speakers,
  names,
  onChange
}: {
  speakers: number[]
  names: Readonly<Record<number, string>>
  onChange: (speaker: number, name: string) => void
}) {
  if (speakers.length === 0) return null

  const normalizedNames = Object.values(names)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  const duplicateNames = new Set(
    normalizedNames.filter((name, index) => normalizedNames.indexOf(name) !== index)
  )

  return (
    <div className="flex max-h-20 shrink-0 flex-wrap items-center gap-1.5 overflow-y-auto border-b border-white/10 px-3 py-1.5">
      <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-500">Participants</span>
      {speakers.map((speaker) => (
        <label key={speaker} className="flex items-center gap-1 text-[10px] text-zinc-400">
          <span>Speaker {speaker + 1}</span>
          <input
            value={names[speaker] ?? ''}
            onChange={(event) => onChange(speaker, event.target.value)}
            aria-label={`Name for Speaker ${speaker + 1}`}
            aria-invalid={duplicateNames.has((names[speaker] ?? '').trim().toLowerCase())}
            placeholder="Name"
            className="w-24 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-400/50 focus:outline-none"
          />
        </label>
      ))}
      {duplicateNames.size > 0 && (
        <span role="alert" className="basis-full text-[10px] text-amber-300">
          Give each detected speaker a different name so attribution stays clear.
        </span>
      )}
    </div>
  )
}

export function TranscriptPanel({
  lines,
  interim,
  meeting,
  speakerNames,
  captureState,
  onSpeakerNameChange,
  onCopy,
  onExport,
  onEditLine,
  onDeleteLine,
  mutationsDisabled,
  collapsed,
  onToggleCollapsed
}: {
  lines: TranscriptEntry[]
  interim: TranscriptInterim
  meeting: boolean
  speakerNames: Readonly<Record<number, string>>
  captureState: CaptureDisplayState
  onSpeakerNameChange: (speaker: number, name: string) => void
  onCopy: () => Promise<boolean>
  onExport: () => boolean
  onEditLine: (index: number, text: string) => boolean
  onDeleteLine: (index: number) => void
  mutationsDisabled: boolean
  /** Collapsed keeps the header (and its live line count) but frees the body. */
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const [following, setFollowing] = useState(true)
  // null means the live tail. A number pins a fixed, PAGE_SIZE-line window.
  const [windowEnd, setWindowEnd] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [exported, setExported] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const speakers = useMemo(
    () =>
      [
        ...new Set(
          lines.flatMap((line) =>
            line.speaker == null || line.speakerName ? [] : [line.speaker]
          )
        )
      ].sort((a, b) => a - b),
    [lines]
  )
  const searching = Boolean(searchQuery.trim())
  const indexedLines = useMemo(
    () =>
      searching
        ? filterTranscriptEntries(lines, searchQuery, speakerNames, meeting)
        : lines.map((line, index) => ({ line, index })),
    [lines, meeting, searchQuery, searching, speakerNames]
  )
  const end = windowEnd == null ? indexedLines.length : Math.min(windowEnd, indexedLines.length)
  const start = Math.max(0, end - PAGE_SIZE)
  const visibleLines = indexedLines.slice(start, end)
  const atLatestWindow = windowEnd == null || end >= indexedLines.length

  useEffect(() => {
    if (collapsed || searching || !atLatestWindow || !shouldFollowRef.current) return
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [atLatestWindow, collapsed, indexedLines, interim, searching])

  function handleScroll(): void {
    const element = scrollRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    if (!nearBottom && windowEnd == null) setWindowEnd(indexedLines.length)
    shouldFollowRef.current = nearBottom && atLatestWindow
    setFollowing(shouldFollowRef.current)
  }

  function showLatest(): void {
    setWindowEnd(null)
    shouldFollowRef.current = true
    setFollowing(true)
    requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
  }

  function updateSearchQuery(value: string): void {
    const hasQuery = Boolean(value.trim())
    setSearchQuery(value)
    setWindowEnd(null)
    shouldFollowRef.current = !hasQuery
    setFollowing(!hasQuery)
  }

  const empty = lines.length === 0 && !interim.interviewer && !interim.you
  const hasFinalizedLines = lines.some((line) => !line.provisional && line.text.trim())
  const noSearchResults = searching && indexedLines.length === 0
  const unseenLines = windowEnd == null ? 0 : Math.max(0, indexedLines.length - windowEnd)

  return (
    <div
      className={`no-drag mx-3 mb-2 flex flex-col overflow-hidden rounded-xl border border-white/10 bg-black/30 ${
        collapsed ? 'shrink-0' : 'min-h-32 flex-[1_1_0%]'
      }`}
    >
      <div
        className={`flex shrink-0 items-center justify-between gap-2 px-3 py-1.5 ${
          collapsed ? '' : 'border-b border-white/10'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            Live transcript
          </span>
          <span className="truncate text-[10px] tabular-nums text-zinc-600" aria-live="polite">
            {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!collapsed && !following && !searching && (
            <button
              type="button"
              onClick={showLatest}
              className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-500/30"
            >
              Jump to latest{unseenLines > 0 ? ` (${unseenLines})` : ''}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="transcript-panel-body"
            aria-label={collapsed ? 'Show live transcript' : 'Hide live transcript'}
            title={
              collapsed
                ? 'Show the live transcript'
                : 'Collapse the transcript to give the answer more room'
            }
            className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
          >
            {collapsed ? 'Show ▸' : 'Hide ▾'}
          </button>
        </div>
      </div>

      {!collapsed && (
      <div id="transcript-panel-body" className="contents">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-3 py-1">
        <label htmlFor="transcript-search" className="sr-only">
          Search finalized transcript
        </label>
        <div className="relative min-w-0 flex-1">
          <input
            id="transcript-search"
            type="search"
            value={searchQuery}
            onChange={(event) => updateSearchQuery(event.target.value)}
            placeholder="Search transcript or speaker..."
            className="w-full rounded border border-white/10 bg-black/25 py-0.5 pl-2 pr-6 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-400/40 focus:outline-none"
          />
          {searching && (
            <button
              type="button"
              onClick={() => updateSearchQuery('')}
              aria-label="Clear transcript search"
              className="absolute inset-y-0 right-0 px-2 text-[10px] text-zinc-500 hover:text-zinc-200"
            >
              x
            </button>
          )}
        </div>
        {searching && (
          <span className="shrink-0 text-[9px] tabular-nums text-zinc-500">
            {indexedLines.length} found
          </span>
        )}
        <button
          type="button"
          disabled={!hasFinalizedLines}
          onClick={() => {
            void onCopy().then((ok) => {
              if (!ok) return
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
          title="Copy the full finalized transcript"
          className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10 disabled:opacity-30"
        >
          {copied ? 'Copied' : 'Copy all'}
        </button>
        <button
          type="button"
          disabled={!hasFinalizedLines}
          onClick={() => {
            if (!onExport()) return
            setExported(true)
            window.setTimeout(() => setExported(false), 1500)
          }}
          title="Download the full finalized transcript as a text file"
          className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10 disabled:opacity-30"
        >
          {exported ? 'Downloaded' : 'Export .txt'}
        </button>
      </div>

      <ParticipantNameEditor
        speakers={speakers}
        names={speakerNames}
        onChange={onSpeakerNameChange}
      />

      {indexedLines.length > PAGE_SIZE && (
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-1 text-[10px] text-zinc-500">
          <span>
            Showing {start + 1}-{end} of {indexedLines.length} lines
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setWindowEnd(start)
                shouldFollowRef.current = false
                setFollowing(false)
              }}
              disabled={start === 0}
              className="rounded bg-white/5 px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-30"
            >
              Earlier
            </button>
            <button
              type="button"
              onClick={() => {
                if (end + PAGE_SIZE >= indexedLines.length) showLatest()
                else setWindowEnd(end + PAGE_SIZE)
              }}
              disabled={atLatestWindow}
              className="rounded bg-white/5 px-1.5 py-0.5 hover:bg-white/10 disabled:opacity-30"
            >
              Later
            </button>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        className="selectable min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-sm text-zinc-200"
      >
        {noSearchResults ? (
          <span className="text-zinc-500">
            No finalized transcript lines match &ldquo;{searchQuery.trim()}&rdquo;.
          </span>
        ) : empty ? (
          <span className="text-zinc-500">
            {captureState === 'starting'
              ? 'Preparing system audio and screen capture…'
              : captureState === 'finalizing'
                ? 'Finalizing the last words…'
                : captureState === 'active'
                  ? 'Listening… speech will appear here.'
                  : 'Press “Start listening” to begin live transcription.'}
          </span>
        ) : (
          <>
            {visibleLines.map(({ line, index }) => (
              <TranscriptLine
                key={`${line.timestampMs ?? `legacy-${index}`}-${line.source}-${line.text}`}
                source={line.source}
                text={line.text}
                speaker={line.speaker}
                interim={Boolean(line.provisional)}
                meeting={meeting}
                timestampMs={line.timestampMs}
                lineIndex={line.provisional ? undefined : index}
                onEdit={onEditLine}
                onDelete={onDeleteLine}
                mutationsDisabled={mutationsDisabled}
                name={
                  line.speakerName ??
                  (line.speaker == null ? undefined : speakerNames[line.speaker])
                }
              />
            ))}
            {!searching && atLatestWindow && interim.interviewer && (
              <TranscriptLine
                source="interviewer"
                text={interim.interviewer}
                interim
                meeting={meeting}
              />
            )}
            {!searching && atLatestWindow && interim.you && (
              <TranscriptLine source="you" text={interim.you} interim meeting={meeting} />
            )}
          </>
        )}
      </div>
      </div>
      )}
    </div>
  )
}
