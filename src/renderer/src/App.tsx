import { useEffect, useState } from 'react'
import SetupView from './views/SetupView'
import OverlayView from './views/OverlayView'

export type SessionMode = 'interview' | 'meeting' | 'consultant'

export type SessionConfig = {
  mode: SessionMode
  role: string
  resumeName?: string
  resumeText?: string
  jobDescription?: string
  docNames: string[]
  docsText?: string
  // Meeting-mode context: helps the AI ground its analysis and answers.
  userName?: string
  projectContext?: string
  techStack?: string
}

export default function App() {
  const [view, setView] = useState<'setup' | 'overlay'>('setup')
  const [config, setConfig] = useState<SessionConfig | null>(null)
  const [clickThrough, setClickThrough] = useState(false)
  const [hotkeyNotice, setHotkeyNotice] = useState('')

  useEffect(() => {
    const off = window.api.onHotkey((payload) => {
      if (payload.action === 'click-through') {
        setClickThrough(Boolean(payload.value))
      } else if (payload.action === 'ask' && view === 'setup') {
        setHotkeyNotice('Start a session before using the Answer shortcut.')
      }
    })
    return off
  }, [view])

  useEffect(() => {
    if (!hotkeyNotice) return
    const timer = window.setTimeout(() => setHotkeyNotice(''), 4500)
    return () => window.clearTimeout(timer)
  }, [hotkeyNotice])

  return (
    <div className="h-full min-h-[420px] w-full min-w-[360px] p-2">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/15 bg-zinc-950/95 shadow-2xl backdrop-blur-xl">
        {clickThrough && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-medium text-black">
            click-through
          </div>
        )}
        {hotkeyNotice && (
          <div
            role="status"
            className="no-drag absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-amber-300/30 bg-zinc-950/95 px-3 py-2 text-xs text-amber-200 shadow-xl"
          >
            {hotkeyNotice}
          </div>
        )}
        {view === 'setup' ? (
          <SetupView
            onStart={(cfg) => {
              setConfig(cfg)
              setView('overlay')
            }}
          />
        ) : (
          <OverlayView config={config} onBack={() => setView('setup')} />
        )}
      </div>
    </div>
  )
}
