import { useEffect, useRef } from 'react'

export type ScreenPreview = {
  dataUrl: string
  width: number
  height: number
  capturedAt: number
  likelyBlank: boolean
}

export function ScreenPreviewModal({
  preview,
  onClose
}: {
  preview: ScreenPreview | null
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!preview) return
    closeRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, preview])

  if (!preview) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="screen-preview-title"
      className="no-drag fixed inset-0 z-[60] flex flex-col bg-zinc-950/95 backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div>
          <div id="screen-preview-title" className="text-sm font-semibold text-cyan-100">
            Screen test preview
          </div>
          <div className="text-[10px] text-zinc-500">
            Captured locally at {new Date(preview.capturedAt).toLocaleTimeString()} · not sent to AI
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-white/10"
        >
          Close
        </button>
      </div>
      {preview.likelyBlank && (
        <div role="alert" className="m-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
          This frame looks blank. Protected video, DRM content, or Windows capture permissions may be blocking the selected display.
        </div>
      )}
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-3">
        <img
          src={preview.dataUrl}
          alt={`Preview of selected display, ${preview.width} by ${preview.height} pixels`}
          className="max-h-full max-w-full rounded-lg border border-white/15 bg-black object-contain shadow-xl"
        />
      </div>
    </div>
  )
}
