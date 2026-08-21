import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../../components/Markdown'
import {
  INTERVIEW_ANSWER_STYLES,
  createInterviewAnswerRequest,
  createInterviewAnswerSnapshot,
  isSameInterviewAnswer,
  type InterviewAnswerRequest,
  type InterviewAnswerSnapshot,
  type InterviewAnswerStyle,
  type InterviewPinnedAnswerChange,
  type PinnedInterviewAnswer
} from '../../../../shared/interviewAnswer'

export type AiWorkspaceTab = 'analysis' | 'answer' | 'consultant'
export type AiWorkspaceIntent = 'answer' | 'analyze' | 'consultant' | 'summarize' | 'minutes'

export type InterviewAiControls = {
  answerStyle: InterviewAnswerStyle
  /** Style used for the currently displayed answer, if it differs from the selector. */
  currentAnswerStyle?: InterviewAnswerStyle
  pinnedAnswers: readonly PinnedInterviewAnswer[]
  onAnswerStyleChange: (style: InterviewAnswerStyle) => void
  onRegenerateExactQuestion: (request: InterviewAnswerRequest) => void
  onPinnedAnswerChange: (change: InterviewPinnedAnswerChange) => void
}

export type AiWorkspaceProps = {
  meeting: boolean
  activeTab: AiWorkspaceTab
  activeIntent: AiWorkspaceIntent
  streaming: boolean
  screenReady: boolean
  autoAnalyze: boolean
  autoAnswer: boolean
  error: string | null
  notice: string | null
  question: string
  answerHistory: string[]
  answer: string
  analysisHistory: string[]
  analysis: string
  consultantHistory: string[]
  consultant: string
  onTabChange: (tab: AiWorkspaceTab) => void
  onToggleAutoAnalyze: () => void
  onToggleAutoAnswer: () => void
  onCancel: () => void
  onConsultScreen: () => void
  onAnalyze: () => void
  /** Interview callers receive the selected style; meeting callers receive no argument. */
  onAnswer: (style?: InterviewAnswerStyle) => void
  onClearAnswers: () => void
  onClearAnalyses: () => void
  onClearConsultant: () => void
  /** Optional until Overlay owns the controlled style and pin state. */
  interviewControls?: InterviewAiControls
}

function ResultHistory({
  history,
  current,
  streaming,
  cursorClass
}: {
  history: string[]
  current: string
  streaming: boolean
  cursorClass: string
}) {
  return (
    <div>
      {history.map((entry, index) => (
        <div key={index} className="mb-3 border-b border-white/10 pb-3 opacity-80">
          <Markdown>{entry}</Markdown>
        </div>
      ))}
      {current && (
        <div>
          <Markdown>{current}</Markdown>
          {streaming && <span className={`ml-0.5 animate-pulse ${cursorClass}`}>▍</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Status for the pane, rendered BELOW the results rather than in place of them.
 * A cut-off or failed response still leaves usable streamed text on screen, and
 * the pane auto-scrolls to the bottom, so the notice lands right where you are
 * already reading.
 */
function PaneBanner({ notice, error }: { notice: string | null; error: string | null }) {
  if (!notice && !error) return null
  return (
    <div className="mt-2 space-y-1 first:mt-0">
      {notice && (
        <p
          role="status"
          className="rounded border border-amber-300/25 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded border border-red-400/25 bg-red-500/10 px-2 py-1 text-[11px] text-red-300"
        >
          {error}
        </p>
      )}
    </div>
  )
}

function ResultPane({
  children,
  changeKey
}: {
  children: React.ReactNode
  changeKey: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldFollowRef = useRef(true)
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    const element = scrollRef.current
    if (!element || !shouldFollowRef.current) return
    element.scrollTop = element.scrollHeight
  }, [changeKey])

  const jumpToLatest = (): void => {
    shouldFollowRef.current = true
    setFollowing(true)
    requestAnimationFrame(() => {
      const element = scrollRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
  }

  return (
    <div className="relative min-h-0 flex-1">
      {!following && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-2 right-2 z-10 rounded-full bg-indigo-500 px-2.5 py-1 text-[10px] font-semibold text-white shadow-lg hover:bg-indigo-400"
        >
          Jump to latest
        </button>
      )}
      <div
        ref={scrollRef}
        onScroll={() => {
          const element = scrollRef.current
          if (!element) return
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          shouldFollowRef.current = nearBottom
          setFollowing(nearBottom)
        }}
        aria-live="polite"
        className="selectable h-full overflow-y-auto px-3 py-2 text-sm leading-relaxed text-zinc-100"
      >
        {children}
      </div>
    </div>
  )
}

function QuestionCard({
  question,
  answer,
  regenerateStyle = 'standard',
  snapshot = null,
  pinnedId,
  busy = false,
  onRegenerate,
  onPinnedAnswerChange
}: {
  question: string
  answer: string
  /**
   * The style the NEXT answer should use — i.e. whatever the selector currently
   * shows, not the style that produced the answer on screen. Regenerating is how
   * you apply a style change to a question you already asked.
   */
  regenerateStyle?: InterviewAnswerStyle
  snapshot?: InterviewAnswerSnapshot | null
  pinnedId?: string
  busy?: boolean
  onRegenerate?: (request: InterviewAnswerRequest) => void
  onPinnedAnswerChange?: (change: InterviewPinnedAnswerChange) => void
}) {
  const [copied, setCopied] = useState(false)
  if (!question) return null

  return (
    <div className="selectable flex max-h-20 shrink-0 items-start gap-2 overflow-y-auto border-b border-white/10 bg-black/15 px-3 py-1.5 text-[11px]">
      <div className="min-w-0 flex-1">
        <span className="mr-1 font-semibold uppercase tracking-wide text-indigo-300">Question</span>
        <span className="text-zinc-300">{question}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {answer && (
          <button
            type="button"
            onClick={() => {
              void window.api.copyText(answer).then((ok) => {
                if (!ok) return
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              })
            }}
            className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        {onRegenerate && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onRegenerate(createInterviewAnswerRequest(question, regenerateStyle, 'regenerate'))
            }
            title={`Regenerate a ${regenerateStyle} answer for this exact question`}
            className="rounded bg-indigo-500/20 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-500/30 disabled:opacity-40"
          >
            Regenerate
          </button>
        )}
        {snapshot && onPinnedAnswerChange && (
          <button
            type="button"
            aria-pressed={Boolean(pinnedId)}
            disabled={busy}
            onClick={() =>
              pinnedId
                ? onPinnedAnswerChange({ action: 'unpin', id: pinnedId })
                : onPinnedAnswerChange({ action: 'pin', answer: snapshot })
            }
            title={pinnedId ? 'Unpin this answer' : 'Pin this answer for quick reference'}
            className={`rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40 ${
              pinnedId
                ? 'bg-amber-400/25 text-amber-100 hover:bg-amber-400/35'
                : 'bg-white/5 text-zinc-300 hover:bg-white/10'
            }`}
          >
            {pinnedId ? 'Unpin' : 'Pin'}
          </button>
        )}
      </div>
    </div>
  )
}

function InterviewControlsBar({
  controls,
  pinnedOpen,
  onTogglePinned
}: {
  controls: InterviewAiControls
  pinnedOpen: boolean
  onTogglePinned: () => void
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-black/10 px-3 py-1">
      <label className="flex items-center gap-1.5 text-[10px] text-zinc-400">
        <span>Answer style</span>
        <select
          aria-label="Interview answer style"
          value={controls.answerStyle}
          onChange={(event) =>
            controls.onAnswerStyleChange(event.target.value as InterviewAnswerStyle)
          }
          className="rounded border border-white/10 bg-zinc-900 px-1.5 py-0.5 text-[10px] capitalize text-zinc-100 focus:border-indigo-400/50 focus:outline-none"
        >
          {INTERVIEW_ANSWER_STYLES.map((style) => (
            <option key={style} value={style}>
              {style[0].toUpperCase() + style.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-expanded={pinnedOpen}
        onClick={onTogglePinned}
        className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-400/20"
      >
        Pinned {controls.pinnedAnswers.length > 0 ? `(${controls.pinnedAnswers.length})` : ''}
      </button>
    </div>
  )
}

function PinnedAnswersPopover({
  answers,
  onPinnedAnswerChange,
  onClose
}: {
  answers: readonly PinnedInterviewAnswer[]
  onPinnedAnswerChange: (change: InterviewPinnedAnswerChange) => void
  onClose: () => void
}) {
  return (
    <div className="absolute inset-x-2 bottom-2 top-20 z-20 overflow-y-auto rounded-lg border border-amber-300/20 bg-zinc-950/95 p-2 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-200">
          Pinned answers
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-white/10"
        >
          Close
        </button>
      </div>
      {answers.length === 0 ? (
        <p className="text-xs text-zinc-500">Pin a completed answer to keep it within quick reach.</p>
      ) : (
        <div className="space-y-2">
          {answers.map((entry) => (
            <details key={entry.id} className="rounded border border-white/10 bg-white/[0.03] p-2">
              <summary className="cursor-pointer text-xs font-medium text-zinc-200">
                {entry.question}
              </summary>
              <div className="mt-2 text-xs text-zinc-300">
                <Markdown>{entry.answer}</Markdown>
              </div>
              <button
                type="button"
                onClick={() => onPinnedAnswerChange({ action: 'unpin', id: entry.id })}
                className="mt-2 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-400/20"
              >
                Unpin
              </button>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

export function AiWorkspace({
  meeting,
  activeTab,
  activeIntent,
  streaming,
  screenReady,
  autoAnalyze,
  autoAnswer,
  error,
  notice,
  question,
  answerHistory,
  answer,
  analysisHistory,
  analysis,
  consultantHistory,
  consultant,
  onTabChange,
  onToggleAutoAnalyze,
  onToggleAutoAnswer,
  onCancel,
  onConsultScreen,
  onAnalyze,
  onAnswer,
  onClearAnswers,
  onClearAnalyses,
  onClearConsultant,
  interviewControls
}: AiWorkspaceProps) {
  const lengths = useMemo(
    () => ({
      analysis: analysisHistory.join('').length + analysis.length,
      answer: answerHistory.join('').length + answer.length,
      consultant: consultantHistory.join('').length + consultant.length
    }),
    [analysis, analysisHistory, answer, answerHistory, consultant, consultantHistory]
  )
  const previousLengthsRef = useRef(lengths)
  // The question card belongs to the current question only. Falling back to the
  // previous answer after a failed/cancelled request lets users copy Q1 as if it
  // answered Q2.
  const latestAnswer = answer
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [unread, setUnread] = useState<Record<AiWorkspaceTab, boolean>>({
    analysis: false,
    answer: false,
    consultant: false
  })

  useEffect(() => {
    const previous = previousLengthsRef.current
    setUnread((current) => {
      const next = { ...current, [activeTab]: false }
      for (const tab of ['analysis', 'answer', 'consultant'] as const) {
        if (tab !== activeTab && lengths[tab] > previous[tab]) next[tab] = true
      }
      return next
    })
    previousLengthsRef.current = lengths
  }, [activeTab, lengths])

  const changeTab = (tab: AiWorkspaceTab): void => {
    setUnread((current) => ({ ...current, [tab]: false }))
    onTabChange(tab)
  }

  const interviewStyle = interviewControls?.answerStyle ?? 'standard'
  const currentAnswerStyle = interviewControls?.currentAnswerStyle ?? interviewStyle
  const currentAnswerSnapshot = createInterviewAnswerSnapshot(
    question,
    latestAnswer,
    currentAnswerStyle
  )
  const currentPinnedAnswer = currentAnswerSnapshot
    ? interviewControls?.pinnedAnswers.find((entry) =>
        isSameInterviewAnswer(entry, currentAnswerSnapshot)
      )
    : undefined

  if (!meeting) {
    return (
      <section
        aria-labelledby="ai-answer-title"
        className="no-drag relative mx-3 mb-3 flex min-h-32 flex-[1_1_0%] flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-500/10"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
          <span id="ai-answer-title" className="text-[11px] font-medium uppercase tracking-wide text-indigo-300">
            AI answer
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleAutoAnswer}
              aria-pressed={autoAnswer}
              title="Auto-answer when the interviewer asks a question"
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                autoAnswer ? 'bg-indigo-400/25 text-indigo-200' : 'bg-white/5 text-zinc-500'
              }`}
            >
              Auto {autoAnswer ? 'on' : 'off'}
            </button>
            {streaming ? (
              <button type="button" onClick={onCancel} className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500">
                Stop
              </button>
            ) : (
              <button type="button" onClick={() => onAnswer(interviewControls?.answerStyle)} className="rounded bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-400">
                Answer
              </button>
            )}
            <button
              type="button"
              onClick={onClearAnswers}
              title="Clear the answer history"
              disabled={answerHistory.length === 0 && !answer}
              className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-30"
            >
              Clear
            </button>
          </div>
        </div>
        {interviewControls && (
          <InterviewControlsBar
            controls={interviewControls}
            pinnedOpen={pinnedOpen}
            onTogglePinned={() => setPinnedOpen((value) => !value)}
          />
        )}
        {pinnedOpen && interviewControls && (
          <PinnedAnswersPopover
            answers={interviewControls.pinnedAnswers}
            onPinnedAnswerChange={interviewControls.onPinnedAnswerChange}
            onClose={() => setPinnedOpen(false)}
          />
        )}
        <QuestionCard
          key={question}
          question={question}
          answer={latestAnswer}
          regenerateStyle={interviewStyle}
          snapshot={currentAnswerSnapshot}
          pinnedId={currentPinnedAnswer?.id}
          busy={streaming}
          onRegenerate={interviewControls?.onRegenerateExactQuestion}
          onPinnedAnswerChange={interviewControls?.onPinnedAnswerChange}
        />
        <ResultPane changeKey={`${answerHistory.length}:${answer.length}:${error ?? ''}:${notice ?? ''}`}>
          {answerHistory.length > 0 || answer ? (
            <ResultHistory history={answerHistory} current={answer} streaming={streaming} cursorClass="text-indigo-300" />
          ) : streaming ? (
            <span className="text-zinc-500">Generating…</span>
          ) : error || notice ? null : (
            <span className="text-zinc-500">
              Auto-answers a detected question, or press <kbd className="rounded bg-white/10 px-1">Ctrl+Shift+Enter</kbd> / Answer.
            </span>
          )}
          <PaneBanner notice={notice} error={error} />
        </ResultPane>
      </section>
    )
  }

  const clearDisabled =
    activeTab === 'analysis'
      ? analysisHistory.length === 0 && !analysis
      : activeTab === 'consultant'
        ? consultantHistory.length === 0 && !consultant
        : answerHistory.length === 0 && !answer
  const clear =
    activeTab === 'analysis'
      ? onClearAnalyses
      : activeTab === 'consultant'
        ? onClearConsultant
        : onClearAnswers

  const pane = activeTab === 'consultant'
    ? consultantHistory.length > 0 || consultant
      ? <ResultHistory history={consultantHistory} current={consultant} streaming={streaming && activeIntent === 'consultant'} cursorClass="text-cyan-300" />
      : streaming && activeIntent === 'consultant'
        ? <span className="text-zinc-500">Reviewing the screen and discussion…</span>
        : <span className="text-zinc-500">Turn Screen on, start listening, then choose Review screen for an architecture and delivery review.</span>
    : activeTab === 'analysis'
      ? analysisHistory.length > 0 || analysis
        ? <ResultHistory history={analysisHistory} current={analysis} streaming={streaming && activeIntent === 'analyze'} cursorClass="text-emerald-300" />
        : streaming && activeIntent === 'analyze'
          ? <span className="text-zinc-500">Analysing the discussion…</span>
          : <span className="text-zinc-500">Live analysis appears here: key points, corrections, risks and useful follow-ups.</span>
      : answerHistory.length > 0 || answer
        ? <ResultHistory history={answerHistory} current={answer} streaming={streaming && activeIntent === 'answer'} cursorClass="text-indigo-300" />
        : streaming && activeIntent === 'answer'
          ? <span className="text-zinc-500">Generating…</span>
          : <span className="text-zinc-500">Answers to questions aimed at you appear here. Press <kbd className="rounded bg-white/10 px-1">Ctrl+Shift+Enter</kbd> / Answer.</span>

  return (
    <section className="no-drag mx-3 mb-3 flex min-h-32 flex-[1_1_0%] flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-500/10">
      <div className="flex flex-wrap items-center justify-between gap-1 border-b border-white/10 px-3 py-1.5">
        <div role="tablist" aria-label="AI workspace" className="flex flex-wrap items-center gap-1">
          {(['analysis', 'answer', 'consultant'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => changeTab(tab)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                activeTab === tab
                  ? tab === 'consultant' ? 'bg-cyan-400/25 text-cyan-100' : 'bg-indigo-400/25 text-indigo-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {tab}
              {unread[tab] && <span aria-label="new result" className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button type="button" onClick={onToggleAutoAnalyze} aria-pressed={autoAnalyze} title="Continuously analyse the team discussion" className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${autoAnalyze ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/5 text-zinc-500'}`}>
            Auto-analyse {autoAnalyze ? 'on' : 'off'}
          </button>
          <button type="button" onClick={onToggleAutoAnswer} aria-pressed={autoAnswer} title="Auto-answer when a question is aimed at you" className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${autoAnswer ? 'bg-indigo-400/25 text-indigo-200' : 'bg-white/5 text-zinc-500'}`}>
            Auto-answer {autoAnswer ? 'on' : 'off'}
          </button>
          {streaming ? (
            <button type="button" onClick={onCancel} className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500">Stop</button>
          ) : activeTab === 'consultant' ? (
            <button type="button" onClick={onConsultScreen} disabled={!screenReady} className="rounded bg-cyan-500/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-cyan-400 disabled:opacity-40">Review screen</button>
          ) : activeTab === 'analysis' ? (
            <button type="button" onClick={onAnalyze} className="rounded bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-400">Analyse</button>
          ) : (
            <button type="button" onClick={() => onAnswer()} className="rounded bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-400">Answer</button>
          )}
          <button type="button" onClick={clear} title={`Clear the ${activeTab} history`} disabled={clearDisabled} className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-30">Clear</button>
        </div>
      </div>
      {activeTab === 'answer' && (
        <QuestionCard
          key={question}
          question={question}
          answer={latestAnswer}
        />
      )}
      <ResultPane changeKey={`${activeTab}:${lengths[activeTab]}:${error ?? ''}:${notice ?? ''}`}>
        {pane}
        <PaneBanner notice={notice} error={error} />
      </ResultPane>
    </section>
  )
}
