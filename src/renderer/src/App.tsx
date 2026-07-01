import { useEffect, useState } from 'react'
import SetupView from './views/SetupView'
import OverlayView from './views/OverlayView'

export type SessionMode = 'interview' | 'meeting'

export type SessionConfig = {
  mode: SessionMode
  role: string
  meetingUrl: string
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

  useEffect(() => {
    const off = window.api.onHotkey((payload) => {
      if (payload.action === 'click-through') {
        setClickThrough(Boolean(payload.value))
      }
    })
    return off
  }, [])

  return (
    <div className="h-full w-full p-2">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/80 shadow-2xl backdrop-blur-xl">
        {clickThrough && (
          <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full bg-amber-500/90 px-2 py-0.5 text-[10px] font-medium text-black">
            click-through
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
