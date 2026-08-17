import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptEntry, TranscriptInterim, TranscriptSource } from './session'

const INTERVIEWER_COLORS = [
  'text-amber-300',
  'text-orange-300',
  'text-yellow-300',
  'text-rose-300'
]
const PAGE_SIZE = 240

export type CaptureDisplayState = 'idle' | 'starting' | 'active' | 'finalizing'

function TranscriptLine({
  source,
  text,
  interim,
  speaker,
  meeting,
  name
}: {
  source: TranscriptSource
  text: string
  interim: boolean
  speaker?: number
  meeting: boolean
  name?: string
}) {
  const isInterviewer = source === 'interviewer'
  const color = isInterviewer
    ? INTERVIEWER_COLORS[(speaker ?? 0) % INTERVIEWER_COLORS.length]
    : 'text-sky-300'
  const speakerWord = meeting ? 'Speaker' : 'Interviewer'
  const label = isInterviewer
    ? name?.trim() || (speaker == null ? speakerWord : `${speakerWord} ${speaker + 1}`)
    : 'You'

  return (
    <div className={interim ? 'opacity-60' : ''}>
      <span className={`mr-1.5 text-[10px] font-semibold uppercase ${color}`}>{label}</span>
      <span>{text}</span>
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

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-1.5">
      <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-500">Participants</span>
      {speakers.map((speaker) => (
        <label key={speaker} className="flex items-center gap-1 text-[10px] text-zinc-400">
          <span>Speaker {speaker + 1}</span>
          <input
            value={names[speaker] ?? ''}
            onChange={(event) => onChange(speaker, event.target.value)}
            aria-label={`Name for Speaker ${speaker + 1}`}
            placeholder="Name"
            className="w-24 rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-400/50 focus:outline-none"
          />
        </label>
      ))}
    </div>
  )
}

export function TranscriptPanel({
  lines,
  interim,
  meeting,
  speakerNames,
  statusBySource,
  captureState,
  onSpeakerNameChange
}: {
  lines: TranscriptEntry[]
  interim: TranscriptInterim
  meeting: boolean
  speakerNames: Readonly<Record<number, string>>
  statusBySource: Readonly<Record<TranscriptSource, string>>
  captureState: CaptureDisplayState
  onSpeakerNameChange: (speaker: number, name: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const [following, setFollowing] = useState(true)
  // null means the live tail. A number pins a fixed, PAGE_SIZE-line window.
  const [windowEnd, setWindowEnd] = useState<number | null>(null)

  const speakers = useMemo(
    () =>
      [...new Set(lines.flatMap((line) => (line.speaker == null ? [] : [line.speaker])))].sort(
        (a, b) => a - b
      ),
    [lines]
  )
  const end = windowEnd == null ? lines.length : Math.min(windowEnd, lines.length)
  const start = Math.max(0, end - PAGE_SIZE)
  const visibleLines = lines.slice(start, end)
  const atLatestWindow = windowEnd == null || end >= lines.length

  useEffect(() => {
    if (!atLatestWindow || !shouldFollowRef.current) return
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [atLatestWindow, lines, interim])

  function handleScroll(): void {
    const element = scrollRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
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

  const empty = lines.length === 0 && !interim.interviewer && !interim.you
  const statusEntries = (['interviewer', 'you'] as const).filter(
    (source) => statusBySource[source]
  )

  return (
    <div className="no-drag mx-3 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/30">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Live transcript
        </span>
        <div className="flex min-w-0 items-center gap-2">
          {statusEntries.map((source) => {
            const status = statusBySource[source]
            return (
              <span
                key={source}
                title={status}
                className={`max-w-40 truncate text-[10px] ${
                  status.startsWith('error') ? 'text-red-300' : 'text-emerald-300'
                }`}
              >
                {source === 'interviewer' ? 'System' : 'Mic'}: {status}
              </span>
            )
          })}
          {!following && atLatestWindow && (
            <button
              onClick={showLatest}
              className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-500/30"
            >
              Jump to latest
            </button>
          )}
        </div>
      </div>

      <ParticipantNameEditor
        speakers={speakers}
        names={speakerNames}
        onChange={onSpeakerNameChange}
      />

      {lines.length > PAGE_SIZE && (
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-1 text-[10px] text-zinc-500">
          <span>
            Showing {start + 1}-{end} of {lines.length} lines
          </span>
          <div className="flex gap-1">
            <button
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
              onClick={() => {
                if (end + PAGE_SIZE >= lines.length) showLatest()
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
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 text-sm text-zinc-200"
      >
        {empty ? (
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
            {visibleLines.map((line, offset) => (
              <TranscriptLine
                key={`${start + offset}-${line.source}`}
                source={line.source}
                text={line.text}
                speaker={line.speaker}
                interim={Boolean(line.provisional)}
                meeting={meeting}
                name={line.speaker == null ? undefined : speakerNames[line.speaker]}
              />
            ))}
            {atLatestWindow && interim.interviewer && (
              <TranscriptLine
                source="interviewer"
                text={interim.interviewer}
                interim
                meeting={meeting}
              />
            )}
            {atLatestWindow && interim.you && (
              <TranscriptLine source="you" text={interim.you} interim meeting={meeting} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
