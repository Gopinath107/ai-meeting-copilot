import { useEffect, useRef, useState } from 'react'
import type { SessionConfig } from '../App'
import { AudioCapture, type AudioSourceKind } from '../audio/AudioCapture'
import { Markdown } from '../components/Markdown'

function Meter({
  label,
  level,
  seconds,
  active
}: {
  label: string
  level: number
  seconds: number
  active: boolean
}) {
  const pct = Math.min(100, Math.round(level * 160))
  return (
    <div className="flex-1">
      <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-400">
        <span>{label}</span>
        <span>{active ? `${seconds.toFixed(1)}s` : 'idle'}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-lime-300 transition-[width] duration-75"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

type TranscriptSource = 'interviewer' | 'you'

// Distinct colours so a panel of interviewers is easy to tell apart.
const INTERVIEWER_COLORS = ['text-amber-300', 'text-orange-300', 'text-yellow-300', 'text-rose-300']

/**
 * Speech-to-text models (Sarvam/Whisper-style and Deepgram) hallucinate filler
 * during silence or background noise — classic phantoms are "you", "thank you",
 * "thanks for watching", "okay", or a single short token. Treat those as noise
 * so they never reach the transcript or fire a phantom auto-answer.
 */
const NOISE_PHRASES = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subscribe',
  'bye',
  'okay',
  'ok',
  'mm',
  'mmm',
  'hmm',
  'mhm',
  'uh',
  'um',
  'ah',
  'oh',
  'yeah',
  'yep',
  'right',
  'so',
  'the',
  'a',
  'i'
])
// Common Whisper/Saaras hallucination sentences — subtitle and voiceover
// boilerplate the models emit over silence, music, or background noise.
const NOISE_PATTERNS: RegExp[] = [
  /^\[.*\]$/, // [music], [applause], [silence]
  /^\(.*\)$/, // (laughs), (music)
  /\bthanks?\s+(you\s+)?for\s+watching\b/,
  /\bplease\s+(like|subscribe|comment)\b/,
  /\bsubscribe\s+to\b/,
  /\bsee\s+you\s+(in\s+the\s+)?next\s+(video|time|one)\b/,
  /\bi'?ll\s+see\s+you\s+next\s+time\b/,
  /\bdon'?t\s+forget\s+to\s+subscribe\b/
]

function isNoise(raw: string): boolean {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?,…\-\s]+$/g, '')
    .trim()
  if (t.length === 0) return true
  if (NOISE_PHRASES.has(t)) return true
  // A lone, very short token with no spaces is almost always a misfire.
  if (!/\s/.test(t) && t.length <= 2) return true
  // The same short word repeated ("you you you", "so so so").
  const words = t.split(/\s+/)
  if (words.length >= 2 && words.every((w) => w === words[0]) && words[0].length <= 4) {
    return true
  }
  // Known subtitle/voiceover hallucination phrases.
  if (NOISE_PATTERNS.some((re) => re.test(t))) return true
  return false
}

// --- Voice-activity gate ----------------------------------------------------
// ASR models invent text during silence. We only accept a transcript when real
// speech-level audio energy occurred on its source within this window (the
// window covers the model's finalisation latency).
const VOICE_WINDOW_MS = 2500
// Speech must exceed the adaptive noise floor and this hard-minimum RMS.
const SPEECH_RMS_MIN = 0.008
const SPEECH_FLOOR_MULT = 2.5

/**
 * Decide whether an interviewer utterance is a prompt that deserves an answer.
 *
 * The old logic only fired when the text ended with a literal '?', so it missed
 * the way interviewers actually speak: imperatives and indirect questions
 * ("Tell me about yourself", "Walk me through your project", "Explain how X
 * works") rarely end in '?', and the speech-to-text doesn't always add one.
 * We bias toward triggering, but require a little substance (>= 2 words) when
 * there's no '?', so a stray one-word phantom can't set it off.
 */
function looksLikeQuestion(raw: string): boolean {
  const text = raw.trim()
  if (text.length < 3) return false
  if (/\?\s*$/.test(text)) return true
  // No question mark: demand at least two words so lone "what" / "how" misfires die.
  if (text.split(/\s+/).length < 2) return false
  const t = text.toLowerCase()
  // Interrogatives / auxiliaries that start a direct question.
  const starters =
    /^(what|why|how|when|where|which|who|whose|whom|can|could|would|will|shall|should|do|does|did|are|is|was|were|have|has|had|may|might)\b/
  if (starters.test(t)) return true
  // Imperative lead-ins interviewers use instead of a question mark.
  const prompts =
    /\b(tell me|walk me through|run me through|take me through|describe|explain|elaborate|define|compare|contrast|give me|share|discuss|talk about|talk to me about|let'?s talk|how would you|what would you|what is|what are|how do you|how does|why do|why is|difference between|your thoughts on|your experience with)\b/
  if (prompts.test(t)) return true
  return false
}

function TranscriptLine({
  source,
  text,
  interim,
  speaker
}: {
  source: TranscriptSource
  text: string
  interim: boolean
  speaker?: number
}) {
  const isInterviewer = source === 'interviewer'
  const color = isInterviewer
    ? INTERVIEWER_COLORS[(speaker ?? 0) % INTERVIEWER_COLORS.length]
    : 'text-sky-300'
  const label = isInterviewer
    ? speaker != null
      ? `Interviewer ${speaker + 1}`
      : 'Interviewer'
    : 'You'
  return (
    <div className={interim ? 'opacity-60' : ''}>
      <span className={`mr-1.5 text-[10px] font-semibold uppercase ${color}`}>{label}</span>
      <span>{text}</span>
    </div>
  )
}

function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export default function OverlayView({
  config,
  onBack
}: {
  config: SessionConfig | null
  onBack: () => void
}) {
  const [finals, setFinals] = useState<
    { source: TranscriptSource; text: string; speaker?: number }[]
  >([])
  const [interim, setInterim] = useState<{ interviewer: string; you: string }>({
    interviewer: '',
    you: ''
  })
  const [dgStatus, setDgStatus] = useState<string>('')
  const [suggestion, setSuggestion] = useState<string>('')
  const [streaming, setStreaming] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [autoAnswer, setAutoAnswer] = useState(true)
  const [manualQuestion, setManualQuestion] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)

  const captureRef = useRef<AudioCapture | null>(null)
  const [capturing, setCapturing] = useState(false)
  // Mic (your own voice) is off by default — we only need the interviewer
  // (system audio). The toggle stays for testing/diagnostics.
  const [micEnabled, setMicEnabled] = useState(false)
  const [stealth, setStealth] = useState(true)
  const [levels, setLevels] = useState<{ system: number; mic: number }>({ system: 0, mic: 0 })
  const [seconds, setSeconds] = useState<{ system: number; mic: number }>({ system: 0, mic: 0 })
  const [audioError, setAudioError] = useState<string | null>(null)

  const finalsRef = useRef(finals)
  const autoAnswerRef = useRef(autoAnswer)
  const streamingRef = useRef(streaming)
  useEffect(() => {
    finalsRef.current = finals
  }, [finals])
  useEffect(() => {
    autoAnswerRef.current = autoAnswer
  }, [autoAnswer])
  useEffect(() => {
    streamingRef.current = streaming
  }, [streaming])

  // Per-source voice-activity state for the hallucination gate: `floor` is an
  // adaptive ambient-noise floor and `lastVoiceTs` is when speech-level energy
  // was last seen, so a transcript over true silence can be dropped.
  const vadRef = useRef<Record<AudioSourceKind, { floor: number; lastVoiceTs: number }>>({
    system: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 },
    mic: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 }
  })

  // Auto-answer is turn-based: we treat a run of interviewer finals as ONE turn
  // and answer only after they've been silent long enough that a mid-sentence
  // pause ("what is the gap... in Python") can't be mistaken for the end. This
  // gives a single answer per question instead of one per fragment.
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnHasQuestionRef = useRef(false)

  // Conversation memory: prior (question -> answer) turns so the model can
  // resolve follow-ups like "explain that code", "add error handling", or
  // "make it shorter" against ITS OWN previous answer (the transcript alone
  // never contains what the AI said).
  const historyRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
  const pendingUserRef = useRef<string | null>(null)
  const answerAccRef = useRef('')

  function buildSystemPrompt(): string {
    const role = config?.role?.trim()
    const jd = config?.jobDescription?.trim()
    const resume = config?.resumeText?.trim()
    const docs = config?.docsText?.trim()
    return [
      'You are an expert real-time interview assistant helping the candidate answer out loud.',
      'Reply in the first person AS the candidate, concise and natural.',
      'You are given the recent conversation as memory. If the candidate says things like "explain that", "add X", "optimise it", "make it shorter", or "that code", they mean YOUR previous answer — build on it directly instead of starting a new topic.',
      'Format every answer in Markdown so it is easy to scan: use short "-" bullet points for lists, steps, or multi-part answers, **bold** for key terms, and short paragraphs for narrative answers.',
      'For behavioural or scenario-based questions, answer with the STAR method (Situation, Task, Action, Result) in a natural spoken flow of about 60-120 words; bullets are optional here.',
      'For long multi-part questions, give one short bullet per part so nothing is missed.',
      'For technical or programming questions: open with 2-3 short bullets of explanation, then give the solution in a fenced code block tagged with the language (for example ```python). Write the SHORTEST correct, idiomatic implementation — minimal lines, no boilerplate, no obvious or verbose comments, no dead code — then finish with a one-line note on time and space complexity. Be precise and use correct terminology, but keep the code compact.',
      'Put any code, commands, JSON, or SQL inside fenced code blocks with the correct language tag — never inline in a sentence.',
      'Use specifics; avoid filler and disclaimers. Output only the answer the candidate should give.',
      'Never fabricate. Do not invent facts, numbers, statistics, dates, tools, company names, or personal experience. State concrete personal achievements only when they appear in the résumé or notes below; otherwise answer in general terms (e.g. "My approach would be…") rather than making up specifics.',
      'In code and technical answers, use only real, standard, documented APIs, libraries, and methods — never invent function names, parameters, or behaviour. If you are unsure something exists, use a well-known alternative you are confident is correct.',
      'If the question is ambiguous or required details are missing, state one brief assumption and answer it (or ask a short clarifying question) instead of guessing. Accuracy matters more than sounding impressive — never state something as fact unless you are confident it is true.',
      role ? `Target role: ${role}.` : '',
      jd ? `Job description:\n${jd}` : '',
      resume
        ? `Candidate résumé (ground answers in this real experience):\n${resume}`
        : config?.resumeName
          ? `Candidate résumé file: ${config.resumeName}.`
          : '',
      docs ? `Extra candidate notes:\n${docs}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  function recentTranscript(n: number): string {
    return finalsRef.current
      .slice(-n)
      .map((l) =>
        l.source === 'interviewer'
          ? `Interviewer${l.speaker != null ? ' ' + (l.speaker + 1) : ''}: ${l.text}`
          : `Me: ${l.text}`
      )
      .join('\n')
  }

  // Safety net: if the backend goes silent (dropped stream / stall) the UI must
  // never stay locked in "streaming" — otherwise every guarded ask is blocked.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function clearWatchdog(): void {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }
  function armWatchdog(): void {
    clearWatchdog()
    watchdogRef.current = setTimeout(() => {
      streamingRef.current = false
      setStreaming(false)
      setAiError((prev) => prev ?? 'No response from the AI (timed out). Ask again.')
    }, 30000)
  }

  function streamAnswer(user: string): void {
    // Supersede any in-flight request so a new question is never blocked.
    if (streamingRef.current) window.api.aiCancel()
    setSuggestion('')
    setAiError(null)
    setStreaming(true)
    streamingRef.current = true
    answerAccRef.current = ''
    pendingUserRef.current = user
    armWatchdog()
    window.api.aiAsk([
      { role: 'system', content: buildSystemPrompt() },
      ...historyRef.current,
      { role: 'user', content: user }
    ])
  }

  function askAi(): void {
    if (finalsRef.current.length === 0) return
    streamAnswer(
      `Interview transcript so far:\n${recentTranscript(14)}\n\nAnswer the interviewer's most recent question thoroughly. If they asked several questions, address each one.`
    )
  }

  function askManual(): void {
    const q = manualQuestion.trim()
    if (!q) return
    const ctx = recentTranscript(8)
    const user =
      (ctx ? `Recent conversation (context):\n${ctx}\n\n` : '') +
      `The interviewer asked:\n"${q}"\n\nGive me the best answer to say out loud.`
    streamAnswer(user)
    setManualQuestion('')
  }

  function cancelAi(): void {
    clearWatchdog()
    window.api.aiCancel()
    setStreaming(false)
    streamingRef.current = false
    pendingUserRef.current = null
  }

  useEffect(() => {
    const off = window.api.onAudioStats((s) => setSeconds(s))
    return off
  }, [])

  useEffect(() => {
    const offToken = window.api.onAiToken((t) => {
      armWatchdog()
      answerAccRef.current += t
      setSuggestion((prev) => prev + t)
    })
    const offDone = window.api.onAiDone(() => {
      clearWatchdog()
      setStreaming(false)
      streamingRef.current = false
      // Remember this turn so the next question can build on it. Cap each side
      // and keep only the last few turns to stay cheap and within context.
      const user = pendingUserRef.current
      const answer = answerAccRef.current.trim()
      if (user && answer) {
        historyRef.current.push(
          { role: 'user', content: user.slice(-700) },
          { role: 'assistant', content: answer.slice(-2000) }
        )
        if (historyRef.current.length > 8) {
          historyRef.current = historyRef.current.slice(-8)
        }
      }
      pendingUserRef.current = null
    })
    const offErr = window.api.onAiError((m) => {
      clearWatchdog()
      setAiError(m)
      setStreaming(false)
      streamingRef.current = false
      pendingUserRef.current = null
      answerAccRef.current = ''
    })
    return () => {
      offToken()
      offDone()
      offErr()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.api.onStealthChanged(setStealth)
    return off
  }, [])

  useEffect(() => {
    if (!autoAnswerRef.current) return
    const last = finals[finals.length - 1]
    if (!last || last.source !== 'interviewer') return
    // The interviewer is still in their turn. Remember if any fragment so far is
    // a question, then (re)arm the "they've stopped talking" timer. A short pause
    // inside a sentence must NOT end the turn, so the window is safely longer
    // than a natural one-second pause.
    if (looksLikeQuestion(last.text)) turnHasQuestionRef.current = true
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = null
      const ask = turnHasQuestionRef.current
      turnHasQuestionRef.current = false // the turn is over either way
      // One answer per turn; never cut off an answer that's already streaming.
      if (!ask || !autoAnswerRef.current || streamingRef.current) return
      askAi()
    }, 1600)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finals])

  useEffect(() => {
    const offT = window.api.onTranscript(({ source, text, isFinal, speaker }) => {
      const kind: AudioSourceKind = source === 'interviewer' ? 'system' : 'mic'
      // Voice-activity gate: if no speech-level audio energy occurred on this
      // source recently, the model invented this text over silence — ignore it.
      const heardVoice = Date.now() - vadRef.current[kind].lastVoiceTs <= VOICE_WINDOW_MS
      if (isFinal) {
        // Drop hallucinated filler so it neither clutters the transcript nor
        // triggers a phantom auto-answer when nobody is really speaking.
        if (!heardVoice || isNoise(text)) {
          if (!heardVoice) console.debug('[vad] dropped silent hallucination:', text)
          setInterim((prev) => ({ ...prev, [source]: '' }))
          return
        }
        setFinals((prev) => [...prev, { source, text, speaker }])
        setInterim((prev) => ({ ...prev, [source]: '' }))
      } else if (heardVoice) {
        setInterim((prev) => ({ ...prev, [source]: text }))
      }
    })
    const offS = window.api.onTranscriptStatus(({ status, message }) => {
      setDgStatus(message ? `${status}: ${message}` : status)
    })
    return () => {
      offT()
      offS()
    }
  }, [])

  useEffect(() => {
    window.api.getStealth().then(setStealth)
  }, [])

  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [finals, interim])

  function toggleStealth(): void {
    setStealth((prev) => {
      const next = !prev
      window.api.setStealth(next)
      return next
    })
  }

  useEffect(() => {
    return () => {
      captureRef.current?.stop()
      window.api.audioStop()
    }
  }, [])

  // Feed each level sample into the voice-activity tracker: the floor falls fast
  // toward quiet and rises slowly, so it follows the ambient baseline rather than
  // speech; energy clearly above it counts as a real voice.
  function registerLevel(kind: AudioSourceKind, level: number): void {
    const v = vadRef.current[kind]
    v.floor += (level - v.floor) * (level < v.floor ? 0.25 : 0.001)
    if (level > Math.max(SPEECH_RMS_MIN, v.floor * SPEECH_FLOOR_MULT)) {
      v.lastVoiceTs = Date.now()
    }
  }

  async function startCapture(): Promise<void> {
    setAudioError(null)
    setFinals([])
    setInterim({ interviewer: '', you: '' })
    setDgStatus('')
    vadRef.current = {
      system: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 },
      mic: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 }
    }
    const capture = new AudioCapture({
      onLevel: (kind, level) => {
        registerLevel(kind, level)
        setLevels((prev) => ({ ...prev, [kind]: level }))
      },
      onChunk: (kind, pcm) => window.api.sendAudioChunk(kind, pcm.buffer as ArrayBuffer),
      onError: (kind, err) => setAudioError(`${kind}: ${err.message}`)
    })
    captureRef.current = capture
    window.api.audioStart(micEnabled)
    setCapturing(true)
    try {
      await capture.startSystem()
    } catch (err) {
      setAudioError(`System audio: ${(err as Error).message}`)
    }
    if (micEnabled) {
      try {
        await capture.startMic()
      } catch (err) {
        setAudioError(`Mic: ${(err as Error).message}`)
      }
    }
  }

  function stopCapture(): void {
    captureRef.current?.stop()
    captureRef.current = null
    window.api.audioStop()
    setCapturing(false)
    setLevels({ system: 0, mic: 0 })
  }

  useEffect(() => {
    const off = window.api.onHotkey((payload) => {
      if (payload.action === 'ask') askAi()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Title bar (draggable) */}
      <div className="drag flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </span>
          <span className="text-sm font-semibold text-zinc-100">Live</span>
          {config?.role ? <span className="text-xs text-zinc-500">· {config.role}</span> : null}
        </div>
        <div className="no-drag flex items-center gap-1">
          <button
            onClick={toggleStealth}
            title={
              stealth
                ? 'Stealth ON — invisible to screenshots, recording & screen share. Click to show yourself.'
                : 'Stealth OFF — visible to screen share. Click to go invisible.'
            }
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
              stealth
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
            }`}
          >
            <EyeIcon off={stealth} />
            {stealth ? 'Invisible' : 'Visible'}
          </button>
          <button
            onClick={onBack}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Setup
          </button>
          <button
            onClick={() => window.api.hide()}
            title="Hide overlay — press Ctrl+Shift+Space (or click the tray dot) to bring it back"
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Hide
          </button>
        </div>
      </div>

      {/* Capture controls + level meters (Phase 2) */}
      <div className="no-drag mx-3 mb-2 rounded-xl border border-white/10 bg-black/20 p-2.5">
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={capturing ? stopCapture : startCapture}
            className={`rounded-md px-3 py-1 text-xs font-semibold text-white ${
              capturing ? 'bg-red-500/80 hover:bg-red-500' : 'bg-emerald-500/90 hover:bg-emerald-400'
            }`}
          >
            {capturing ? 'Stop listening' : 'Start listening'}
          </button>
          <button
            onClick={() => setMicEnabled((v) => !v)}
            disabled={capturing}
            className={`rounded-md px-2 py-1 text-xs ${
              micEnabled ? 'bg-white/15 text-zinc-100' : 'bg-white/5 text-zinc-500'
            } disabled:opacity-50`}
          >
            Mic {micEnabled ? 'on' : 'off'}
          </button>
          {audioError && (
            <span className="truncate text-[10px] text-red-300" title={audioError}>
              {audioError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Meter
            label="Interviewer (system)"
            level={levels.system}
            seconds={seconds.system}
            active={capturing}
          />
          {micEnabled && (
            <Meter label="You (mic)" level={levels.mic} seconds={seconds.mic} active={capturing} />
          )}
        </div>
      </div>

      {/* Transcript pane */}
      <div className="no-drag mx-3 mb-2 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/30">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Live transcript
          </span>
          {dgStatus && (
            <span
              className={`text-[10px] ${
                dgStatus.startsWith('error') ? 'text-red-300' : 'text-emerald-300'
              }`}
            >
              {dgStatus}
            </span>
          )}
        </div>
        <div
          ref={transcriptRef}
          className="h-full space-y-1.5 overflow-y-auto px-3 py-2 text-sm text-zinc-200"
        >
          {finals.length === 0 && !interim.interviewer && !interim.you ? (
            <span className="text-zinc-500">
              {capturing
                ? 'Listening… speech will appear here.'
                : 'Press “Start listening” to begin live transcription.'}
            </span>
          ) : (
            <>
              {finals.map((line, i) => (
                <TranscriptLine
                  key={i}
                  source={line.source}
                  text={line.text}
                  speaker={line.speaker}
                  interim={false}
                />
              ))}
              {interim.interviewer && (
                <TranscriptLine source="interviewer" text={interim.interviewer} interim />
              )}
              {interim.you && <TranscriptLine source="you" text={interim.you} interim />}
            </>
          )}
        </div>
      </div>

      {/* Manual question */}
      <div className="no-drag mx-3 mb-2 flex items-center gap-2">
        <input
          value={manualQuestion}
          onChange={(e) => setManualQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              askManual()
            }
          }}
          placeholder="Type a question (scenario / long) and press Enter…"
          className="flex-1 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/40 focus:outline-none"
        />
        <button
          onClick={askManual}
          disabled={streaming}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-400 disabled:opacity-40"
        >
          Ask
        </button>
      </div>

      {/* Suggestion pane */}
      <div className="no-drag mx-3 mb-3 flex h-[42%] flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-500/10">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-indigo-300">
            AI answer
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setAutoAnswer((v) => !v)}
              title="Auto-answer when the interviewer asks a question"
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                autoAnswer ? 'bg-indigo-400/25 text-indigo-200' : 'bg-white/5 text-zinc-500'
              }`}
            >
              Auto {autoAnswer ? 'on' : 'off'}
            </button>
            {streaming ? (
              <button
                onClick={cancelAi}
                className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={askAi}
                className="rounded bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-400"
              >
                Answer
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed text-zinc-100">
          {aiError ? (
            <span className="text-red-300">{aiError}</span>
          ) : suggestion ? (
            <div>
              <Markdown>{suggestion}</Markdown>
              {streaming && <span className="ml-0.5 animate-pulse text-indigo-300">▍</span>}
            </div>
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

      {/* Hotkey legend */}
      <div className="drag border-t border-white/10 px-4 py-2 text-[10px] text-zinc-500">
        <span className="mr-3">Ctrl+Shift+Space show/hide</span>
        <span className="mr-3">Ctrl+Shift+Enter answer</span>
        <span className="mr-3">Ctrl+Shift+\ click-through</span>
        <span>Ctrl+Shift+H hide</span>
      </div>
    </div>
  )
}
