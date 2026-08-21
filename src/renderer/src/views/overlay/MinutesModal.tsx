import { useEffect, useRef } from 'react'
import { Markdown } from '../../components/Markdown'

export function MinutesModal({
  open,
  kind,
  minutes,
  error,
  notice,
  preparing,
  stage,
  generating,
  copied,
  canRegenerate,
  onCancel,
  onCopy,
  onRegenerate,
  onClose
}: {
  open: boolean
  kind: 'interview' | 'meeting'
  minutes: string
  error: string | null
  notice: string | null
  preparing: boolean
  stage: 'idle' | 'summarizing' | 'generating'
  generating: boolean
  copied: boolean
  canRegenerate: boolean
  onCancel: () => void
  onCopy: () => void
  onRegenerate: () => void
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const title = kind === 'interview' ? 'Interview recap' : 'Minutes of Meeting'

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="minutes-dialog-title"
      className="no-drag fixed inset-0 z-50 flex flex-col bg-zinc-950/95 backdrop-blur"
    >
      <div className="drag flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span id="minutes-dialog-title" className="text-sm font-semibold text-amber-200">
          {title}
        </span>
        <div className="no-drag flex items-center gap-1.5">
          {generating ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded bg-red-500/80 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-500"
            >
              Stop
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCopy}
                disabled={!minutes || preparing}
                className="rounded bg-white/10 px-2 py-1 text-[11px] font-medium text-zinc-100 hover:bg-white/20 disabled:opacity-40"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={onRegenerate}
                disabled={!canRegenerate || preparing}
                className="rounded bg-amber-500/90 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-400 disabled:opacity-40"
              >
                Regenerate
              </button>
            </>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Close
          </button>
        </div>
      </div>
      <div
        aria-live="polite"
        className="selectable flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-zinc-100"
      >
        {notice && (
          <div className="mb-3 rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1.5 text-xs text-amber-200">
            {notice}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mb-3 rounded border border-red-400/20 bg-red-400/10 px-2 py-1.5 text-xs text-red-200"
          >
            {error}
          </div>
        )}
        {preparing ? (
          <span className="text-zinc-500">Step 1 of 2 · Finalizing the last words…</span>
        ) : minutes ? (
          <div>
            <Markdown>{minutes}</Markdown>
            {generating && <span className="ml-0.5 animate-pulse text-amber-300">▍</span>}
          </div>
        ) : generating ? (
          <span className="text-zinc-500">
            {stage === 'summarizing'
              ? 'Preparing the long transcript in bounded sections…'
              : `Step 2 of 2 · Generating ${kind === 'interview' ? 'the interview recap' : 'meeting minutes'}…`}
          </span>
        ) : (
          <span className="text-zinc-500">
            No {kind === 'interview' ? 'recap' : 'minutes'} yet.
          </span>
        )}
      </div>
    </div>
  )
}
