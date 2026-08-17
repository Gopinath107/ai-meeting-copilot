import { Markdown } from '../../components/Markdown'

export type AiWorkspaceTab = 'analysis' | 'answer' | 'consultant'
export type AiWorkspaceIntent = 'answer' | 'analyze' | 'consultant' | 'summarize' | 'minutes'

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

export function AiWorkspace({
  meeting,
  activeTab,
  activeIntent,
  streaming,
  screenReady,
  autoAnalyze,
  autoAnswer,
  error,
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
  onClearConsultant
}: {
  meeting: boolean
  activeTab: AiWorkspaceTab
  activeIntent: AiWorkspaceIntent
  streaming: boolean
  screenReady: boolean
  autoAnalyze: boolean
  autoAnswer: boolean
  error: string | null
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
  onAnswer: () => void
  onClearAnswers: () => void
  onClearAnalyses: () => void
  onClearConsultant: () => void
}) {
  if (!meeting) {
    return (
      <div className="no-drag mx-3 mb-3 flex h-[42%] flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-500/10">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-indigo-300">
            AI answer
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onToggleAutoAnswer}
              title="Auto-answer when the interviewer asks a question"
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                autoAnswer ? 'bg-indigo-400/25 text-indigo-200' : 'bg-white/5 text-zinc-500'
              }`}
            >
              Auto {autoAnswer ? 'on' : 'off'}
            </button>
            {streaming ? (
              <button
                onClick={onCancel}
                className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={onAnswer}
                className="rounded bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-400"
              >
                Answer
              </button>
            )}
            <button
              onClick={onClearAnswers}
              title="Clear the answer history"
              disabled={answerHistory.length === 0 && !answer}
              className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-30"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed text-zinc-100">
          {error ? (
            <span className="text-red-300">{error}</span>
          ) : answerHistory.length > 0 || answer ? (
            <ResultHistory
              history={answerHistory}
              current={answer}
              streaming={streaming}
              cursorClass="text-indigo-300"
            />
          ) : streaming ? (
            <span className="text-zinc-500">Generating…</span>
          ) : (
            <span className="text-zinc-500">
              Auto-answers when a question is detected, or press{' '}
              <kbd className="rounded bg-white/10 px-1">Ctrl+Shift+Enter</kbd> / Answer.
            </span>
          )}
        </div>
      </div>
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

  return (
    <div className="no-drag mx-3 mb-3 flex h-[42%] flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-500/10">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <div className="flex items-center gap-1">
          {(['analysis', 'answer', 'consultant'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                activeTab === tab
                  ? tab === 'consultant'
                    ? 'bg-cyan-400/25 text-cyan-100'
                    : 'bg-indigo-400/25 text-indigo-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onToggleAutoAnalyze}
            title="Continuously analyse the team discussion"
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              autoAnalyze ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/5 text-zinc-500'
            }`}
          >
            Auto-analyse {autoAnalyze ? 'on' : 'off'}
          </button>
          <button
            onClick={onToggleAutoAnswer}
            title="Auto-answer when a question is aimed at you"
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
              autoAnswer ? 'bg-indigo-400/25 text-indigo-200' : 'bg-white/5 text-zinc-500'
            }`}
          >
            Auto-answer {autoAnswer ? 'on' : 'off'}
          </button>
          {streaming ? (
            <button
              onClick={onCancel}
              className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500"
            >
              Stop
            </button>
          ) : activeTab === 'consultant' ? (
            <button
              onClick={onConsultScreen}
              disabled={!screenReady}
              className="rounded bg-cyan-500/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-cyan-400 disabled:opacity-40"
            >
              Review screen
            </button>
          ) : activeTab === 'analysis' ? (
            <button
              onClick={onAnalyze}
              className="rounded bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-400"
            >
              Analyse
            </button>
          ) : (
            <button
              onClick={onAnswer}
              className="rounded bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-400"
            >
              Answer
            </button>
          )}
          <button
            onClick={clear}
            title={`Clear the ${activeTab} history`}
            disabled={clearDisabled}
            className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-30"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed text-zinc-100">
        {error ? (
          <span className="text-red-300">{error}</span>
        ) : activeTab === 'consultant' ? (
          consultantHistory.length > 0 || consultant ? (
            <ResultHistory
              history={consultantHistory}
              current={consultant}
              streaming={streaming && activeIntent === 'consultant'}
              cursorClass="text-cyan-300"
            />
          ) : streaming && activeIntent === 'consultant' ? (
            <span className="text-zinc-500">Reviewing as Java/GraphQL architect…</span>
          ) : (
            <span className="text-zinc-500">
              Turn Screen on, start listening, then choose Review screen for user-story breakdown,
              API contracts, Java/GraphQL design, code, risks, and tests.
            </span>
          )
        ) : activeTab === 'analysis' ? (
          analysisHistory.length > 0 || analysis ? (
            <ResultHistory
              history={analysisHistory}
              current={analysis}
              streaming={streaming && activeIntent === 'analyze'}
              cursorClass="text-emerald-300"
            />
          ) : streaming && activeIntent === 'analyze' ? (
            <span className="text-zinc-500">Analysing the discussion…</span>
          ) : (
            <span className="text-zinc-500">
              Live analysis of the discussion appears here — what’s correct, what to fix, and
              smart follow-up questions.
            </span>
          )
        ) : answerHistory.length > 0 || answer ? (
          <ResultHistory
            history={answerHistory}
            current={answer}
            streaming={streaming && activeIntent === 'answer'}
            cursorClass="text-indigo-300"
          />
        ) : streaming && activeIntent === 'answer' ? (
          <span className="text-zinc-500">Generating…</span>
        ) : (
          <span className="text-zinc-500">
            Answers to questions aimed at you appear here. Press{' '}
            <kbd className="rounded bg-white/10 px-1">Ctrl+Shift+Enter</kbd> / Answer.
          </span>
        )}
      </div>
    </div>
  )
}
