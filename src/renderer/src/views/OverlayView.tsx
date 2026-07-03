import { useEffect, useRef, useState } from 'react'
import type { SessionConfig, SessionMode } from '../App'
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
const VOICE_WINDOW_MS = 1800
// Sarvam runs its OWN server-side voice-activity detection and finalises an
// utterance in a batch shortly AFTER the speaker pauses — often after the strict
// window above has lapsed. Sarvam therefore gets a much wider window so its valid
// finals aren't wrongly dropped as "silence hallucinations" (it barely
// hallucinates over true silence, unlike Whisper/Deepgram-style engines).
const SARVAM_VOICE_WINDOW_MS = 6000
// Speech must exceed the adaptive noise floor and this hard-minimum RMS.
const SPEECH_RMS_MIN = 0.012
const SPEECH_FLOOR_MULT = 3
// Deepgram gives a per-utterance confidence (0-1). Real speech is typically
// > 0.6; only clearly low-confidence guesses (< this) are dropped so we keep
// correct-but-borderline words instead of losing them (accuracy over caution).
// (Sarvam sends no confidence, so its finals are undefined and skip this check.)
const MIN_CONFIDENCE = 0.45
// When people talk non-stop (e.g. two speakers overlapping), Deepgram never sees
// the silence it needs to finalise, so the live preview would sit there growing
// and never commit — it "waits for silence". If a preview keeps growing this long
// without a final, we promote it to a committed line right away so the transcript
// keeps moving. Deepgram's real final later replaces that line in place (no
// duplicate). Keep this short for an "immediate" feel.
const INTERIM_PROMOTE_MS = 1500

// --- Meeting auto-response timing -------------------------------------------
// Meeting mode fires the AI on a natural pause (debounce), but during a fast
// multi-speaker back-and-forth those pauses are rare, so a hard cap forces a
// timely response even while people keep talking.
// Pause after the last line before we treat the turn as over (general case).
const AUTO_SILENCE_MS = 1100
// Shorter wait when a question was clearly directed at me — respond faster.
const AUTO_DIRECTED_MS = 700
// Hard cap: once a burst starts, respond within this long no matter how
// continuously Speaker 1 and Speaker 2 keep talking.
const AUTO_MAX_WAIT_MS = 3800

// --- Long-meeting memory ----------------------------------------------------
// A meeting can run up to ~2 hours, far more transcript than fits in one model
// request. We keep a rolling summary of everything already discussed and only
// send that summary plus the newest verbatim lines. Once this many un-summarised
// finals build up (beyond the recent window kept verbatim), we fold them into
// the running summary in the background.
const SUMMARY_TRIGGER = 18
// Most-recent finals always kept verbatim (never folded into the summary yet),
// so the latest exchange stays exact for the AI.
const SUMMARY_KEEP_RECENT = 12

// Common software/architecture terms always sent as Deepgram keyterms so jargon
// is transcribed correctly even when the user leaves the tech-stack field empty
// (e.g. "Spring Boot" instead of "ring board"). Merged with the user's own
// stack/context terms in buildKeyterms(). English-only, nova-3 feature.
const DEFAULT_TECH_KEYTERMS = [
  'Spring Boot',
  'Spring',
  'Hibernate',
  'Java',
  'Kotlin',
  'JavaScript',
  'TypeScript',
  'Python',
  'Node.js',
  'Express',
  'React',
  'Angular',
  'Vue',
  'Next.js',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'Kafka',
  'RabbitMQ',
  'Elasticsearch',
  'Docker',
  'Kubernetes',
  'Microservices',
  'REST API',
  'GraphQL',
  'gRPC',
  'JWT',
  'OAuth',
  'OpenID Connect',
  'JSON',
  'YAML',
  'SQL',
  'NoSQL',
  'CI/CD',
  'Jenkins',
  'Terraform',
  'AWS',
  'Azure',
  'GCP',
  'Lambda',
  'DynamoDB',
  'Nginx',
  'API Gateway',
  'load balancer',
  'caching',
  'authentication',
  'authorization',
  'endpoint',
  'middleware',
  'schema',
  'migration',
  'webhook',
  'idempotency',
  'rate limiting'
]

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

/**
 * In a group meeting, decide whether an utterance is aimed at ME specifically
 * (so the AI should draft an answer for me to say) rather than being general
 * team discussion (which the AI just analyses). We trigger on my name or on
 * clear second-person question cues.
 */
function isDirectedAtMe(raw: string, userName?: string): boolean {
  const t = raw.trim().toLowerCase()
  if (t.length < 3) return false
  const name = userName?.trim().toLowerCase()
  if (name) {
    const first = name.split(/\s+/)[0]
    if (first && first.length >= 2) {
      const re = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      if (re.test(t)) return true
    }
  }
  // Second-person cues that indicate the speaker is asking the listener (me).
  const youCues =
    /\b(what do you think|your thoughts|your take|can you|could you|would you|how would you|what would you|do you (know|think|have)|any (thoughts|ideas|input)|over to you|what about you|your opinion)\b/
  if (youCues.test(t) && looksLikeQuestion(raw)) return true
  return false
}

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
  meeting?: boolean
  name?: string
}) {
  const isInterviewer = source === 'interviewer'
  const color = isInterviewer
    ? INTERVIEWER_COLORS[(speaker ?? 0) % INTERVIEWER_COLORS.length]
    : 'text-sky-300'
  const speakerWord = meeting ? 'Speaker' : 'Interviewer'
  const label = isInterviewer
    ? name?.trim()
      ? name.trim()
      : speaker != null
        ? `${speakerWord} ${speaker + 1}`
        : speakerWord
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
    { source: TranscriptSource; text: string; speaker?: number; provisional?: boolean }[]
  >([])
  const [interim, setInterim] = useState<{ interviewer: string; you: string }>({
    interviewer: '',
    you: ''
  })
  const [dgStatus, setDgStatus] = useState<string>('')
  const [suggestion, setSuggestion] = useState<string>('')
  // Completed past answers, kept on screen so a new response never wipes what
  // you're still reading. New answers append below these; the Clear button empties them.
  const [answerHistory, setAnswerHistory] = useState<string[]>([])
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

  // ----- Meeting mode -----
  const mode: SessionMode = config?.mode ?? 'interview'
  const isMeeting = mode === 'meeting'
  // Speech provider for this session. Deepgram is the default in BOTH modes: its
  // nova-3 English model is multidialect (British/UK, American and other native
  // accents) and the most accurate choice for ~100% English speech, and it also
  // labels each speaker. Sarvam's only English model is en-IN (Indian-accent
  // tuned), so it's offered as an option but not the default. 'auto' = Sarvam
  // primary + Deepgram fallback.
  type Provider = 'auto' | 'deepgram' | 'sarvam'
  const [provider, setProvider] = useState<Provider>('deepgram')
  const [analysis, setAnalysis] = useState('')
  // Completed past analyses, kept on screen (same reasoning as answerHistory).
  const [analysisHistory, setAnalysisHistory] = useState<string[]>([])
  const [autoAnalyze, setAutoAnalyze] = useState(isMeeting)
  const [activeTab, setActiveTab] = useState<'analysis' | 'answer'>(
    isMeeting ? 'analysis' : 'answer'
  )
  // Which kind of AI request is currently streaming, so tokens land in the right
  // pane (the main process only runs one stream at a time).
  const intentRef = useRef<'answer' | 'analyze' | 'summarize' | 'minutes'>('answer')
  const analysisAccRef = useRef('')
  // Minutes of Meeting: generated on demand when the meeting is ended, from the
  // full transcript. Shown in a modal overlay so it never disrupts the live UI.
  const [minutes, setMinutes] = useState('')
  const [minutesOpen, setMinutesOpen] = useState(false)
  const [minutesError, setMinutesError] = useState<string | null>(null)
  const [minutesCopied, setMinutesCopied] = useState(false)
  const minutesAccRef = useRef('')
  const autoAnalyzeRef = useRef(autoAnalyze)
  const lastAnalyzedCountRef = useRef(0)
  // How many transcript lines had been produced the last time we answered a
  // question. Interviewer lines AFTER this point are the current, unanswered
  // question — so we never re-answer a question from an earlier turn (the mic is
  // off, so old and new questions aren't separated by a "Me:" line).
  const lastAnsweredCountRef = useRef(0)
  useEffect(() => {
    autoAnalyzeRef.current = autoAnalyze
  }, [autoAnalyze])

  // Map each diarized speaker index to a real name the user types in. Used in
  // the transcript UI and in the transcript text handed to the AI.
  const [speakerNames, setSpeakerNames] = useState<Record<number, string>>({})
  const speakerNamesRef = useRef(speakerNames)
  useEffect(() => {
    speakerNamesRef.current = speakerNames
  }, [speakerNames])

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

  // --- Immediate-commit for non-stop / overlapping speech --------------------
  // Live copy of the interim previews so the promote timer can read the latest
  // text without a stale closure.
  const interimRef = useRef(interim)
  useEffect(() => {
    interimRef.current = interim
  }, [interim])
  // Whether a source currently has a line that was committed early from a still-
  // growing preview (awaiting Deepgram's real final to replace it in place).
  const hasProvisionalRef = useRef<Record<TranscriptSource, boolean>>({
    interviewer: false,
    you: false
  })
  // One-shot timer per source that promotes a long-running preview to a committed
  // line (see INTERIM_PROMOTE_MS) so non-stop speech never waits for silence.
  const promoteTimerRef = useRef<Record<TranscriptSource, ReturnType<typeof setTimeout> | null>>({
    interviewer: null,
    you: null
  })

  // Auto-answer is turn-based: we treat a run of interviewer finals as ONE turn
  // and answer only after they've been silent long enough that a mid-sentence
  // pause ("what is the gap... in Python") can't be mistaken for the end. This
  // gives a single answer per question instead of one per fragment.
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hard cap for meeting mode: armed once when a burst of speech starts and NOT
  // reset by later lines, so a fast back-and-forth between Speaker 1 and Speaker
  // 2 (gaps shorter than the pause window) still triggers a timely response
  // instead of waiting for a real silence that may never come.
  const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnHasQuestionRef = useRef(false)
  const turnDirectedRef = useRef(false)

  // Conversation memory: prior (question -> answer) turns so the model can
  // resolve follow-ups like "explain that code", "add error handling", or
  // "make it shorter" against ITS OWN previous answer (the transcript alone
  // never contains what the AI said).
  const historyRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
  const pendingUserRef = useRef<string | null>(null)
  const answerAccRef = useRef('')

  // Long-meeting memory: a running prose summary of everything discussed earlier,
  // plus how far into the finals it covers, so the AI keeps full context across a
  // 2-hour session without us resending the entire transcript. Older lines are
  // folded into `meetingSummaryRef` in the background; recent lines stay verbatim.
  const meetingSummaryRef = useRef('')
  const summarizedUptoRef = useRef(0)
  const summarizeTargetRef = useRef(0)
  const summaryAccRef = useRef('')

  function buildSystemPrompt(): string {
    if (isMeeting) return buildMeetingSystemPrompt()
    const role = config?.role?.trim()
    const jd = config?.jobDescription?.trim()
    const resume = config?.resumeText?.trim()
    const docs = config?.docsText?.trim()
    return [
      'You are an expert real-time interview assistant helping the candidate answer out loud.',
      'Reply in the first person AS the candidate, concise and natural.',
      'The question comes from speech-to-text and may contain recognition errors, especially for technical terms (e.g. "ring board" means "Spring Boot", "power gres" means "PostgreSQL", "jason" means "JSON"). Infer the intended meaning and answer using the correct canonical terms rather than the literal mis-transcribed words.',
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

  function buildMeetingSystemPrompt(): string {
    const role = config?.role?.trim()
    const project = config?.projectContext?.trim()
    const stack = config?.techStack?.trim()
    const docs = config?.docsText?.trim()
    const name = config?.userName?.trim()
    return [
      'You are a principal software engineer and solution architect with 20-30 years of hands-on experience, silently assisting me during a live team meeting.',
      'Several participants (labelled Speaker 1, Speaker 2, ... in the transcript) are discussing an application and its features (for example a login page, an API, a data model).',
      'Two request types will come to you — obey the one named in the user message:',
      '',
      '[ANALYZE] Evaluate the ongoing discussion at a senior/architect level. Respond ONLY with this compact Markdown structure, omitting any section that has nothing substantive to add:',
      '**Topic:** the specific feature/area under discussion (one line).',
      '**Assessment:** is what they are saying technically correct and sound? Explicitly confirm what is right and flag what is wrong, risky, or imprecise.',
      '**Corrections:** the correct approach for anything that was wrong — precise and actionable.',
      '**Suggestions:** best practices, trade-offs, edge cases, security/scalability/maintainability concerns they are missing.',
      '**Follow-ups:** 2-3 sharp questions that move the discussion forward or expose gaps.',
      'Keep it tight and skimmable — short bullets, **bold** key terms, correct terminology. No filler, no restating the transcript.',
      '',
      '[ANSWER] A question has been directed at me. Answer in the FIRST PERSON as me, in a clear, confident, senior voice, ready to say out loud. Lead with the direct answer, then 2-4 crisp supporting points. Use short "-" bullets for multi-part answers and fenced code blocks (with a language tag) for any code, commands, JSON, or SQL. Be precise and pragmatic, mention the key trade-off, and stay concise.',
      '',
      'The transcript is machine-generated (speech-to-text) and WILL contain recognition errors, especially for technical terms and product names. Silently reconstruct the intended meaning before responding: interpret garbled words against the tech stack and project context below (for example "ring board" or "sprint boot" almost certainly means "Spring Boot"; "power gres" means "PostgreSQL"; "jason" means "JSON"; "cuber netties" means "Kubernetes"). Always reason about the speaker\'s INTENT, not the literal mis-transcribed words, and use the correct canonical term in your reply. If a word is truly ambiguous, pick the most likely meaning given the tech stack and proceed.',
      '',
      'Rules for both: Never fabricate facts, numbers, names, APIs, or library behaviour — use only real, standard, documented technology, and if unsure say so or use a well-known correct alternative. Prefer precision over sounding impressive. Ground everything in the project context below.',
      name ? `My name: ${name}.` : '',
      role ? `My role: ${role}.` : '',
      project ? `Project / application context:\n${project}` : '',
      stack ? `Tech stack: ${stack}.` : '',
      docs ? `Reference docs:\n${docs}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  function recentTranscript(n: number): string {
    return finalsRef.current
      .slice(-n)
      .map((l) => {
        if (l.source !== 'interviewer') return `Me: ${l.text}`
        const named = l.speaker != null ? speakerNamesRef.current[l.speaker]?.trim() : ''
        const who = named
          ? named
          : `${isMeeting ? 'Speaker' : 'Interviewer'}${l.speaker != null ? ' ' + (l.speaker + 1) : ''}`
        return `${who}: ${l.text}`
      })
      .join('\n')
  }

  // The single most recent thing the OTHER side said — i.e. the actual question
  // to answer right now. We only want to answer THIS, using earlier lines as
  // context, so the AI stops re-answering previous questions. We take the
  // interviewer/speaker lines that appeared since our last answer (the current
  // unanswered turn), joined so a question split across a couple of finals stays
  // whole.
  function latestQuestion(): string {
    const finals = finalsRef.current
    const start = Math.min(lastAnsweredCountRef.current, finals.length)
    const turn: string[] = []
    // Walk back from the end, collecting the trailing run of interviewer lines,
    // but never earlier than the point we last answered.
    for (let i = finals.length - 1; i >= start; i--) {
      if (finals[i].source !== 'interviewer') break
      turn.unshift(finals[i].text)
    }
    // Fallback: if nothing new is attributable (e.g. everything got merged), use
    // the last interviewer line so we still answer something current.
    if (turn.length === 0) {
      for (let i = finals.length - 1; i >= 0; i--) {
        if (finals[i].source === 'interviewer') return finals[i].text.trim()
      }
    }
    return turn.join(' ').trim()
  }

  // Recent verbatim lines prefixed with the running summary of everything said
  // earlier, so the AI always has the full history of the meeting — not just the
  // last few sentences — even hours in.
  function transcriptWithHistory(n: number): string {
    const summary = meetingSummaryRef.current.trim()
    const recent = recentTranscript(n)
    if (!summary) return recent
    const label = isMeeting ? 'meeting' : 'conversation'
    return (
      `Summary of what was discussed earlier in this ${label} (context — do not repeat it back):\n` +
      `${summary}\n\n` +
      `Most recent exchange (verbatim, continues from the summary above):\n${recent}`
    )
  }

  // --- Rolling summariser (long-meeting memory) -----------------------------
  // Runs opportunistically while the stream is idle. It folds older transcript
  // lines into `meetingSummaryRef` so we keep full context without ever sending
  // the whole 2-hour transcript to the model.
  function buildSummarizerPrompt(): string {
    return [
      'You maintain a running summary of a long live meeting so an AI assistant keeps full context even after one or two hours.',
      'You are given the summary so far and the newer transcript lines that follow it. Merge the new lines into the summary and return the UPDATED summary.',
      'Preserve every durable fact: decisions, action items and owners, requirements, agreed designs/architecture, open questions, disagreements, numbers, dates, and key technical details. Drop small talk and filler.',
      'Write terse notes under short bold headings such as **Context**, **Decisions**, **Open questions**, **Action items**. Keep the whole summary under ~350 words by compressing older points, never dropping important ones.',
      'The transcript is speech-to-text and may contain recognition errors; silently correct obvious technical or product-term mistakes.',
      'Output ONLY the updated summary text — no preamble, no commentary.'
    ].join('\n')
  }

  function summarizeRange(fromIdx: number, toIdx: number): void {
    const lines = finalsRef.current.slice(fromIdx, toIdx)
    if (lines.length === 0) return
    const text = lines
      .map((l) => {
        if (l.source !== 'interviewer') return `Me: ${l.text}`
        const named = l.speaker != null ? speakerNamesRef.current[l.speaker]?.trim() : ''
        const who = named
          ? named
          : `${isMeeting ? 'Speaker' : 'Interviewer'}${l.speaker != null ? ' ' + (l.speaker + 1) : ''}`
        return `${who}: ${l.text}`
      })
      .join('\n')
    intentRef.current = 'summarize'
    summaryAccRef.current = ''
    summarizeTargetRef.current = toIdx
    setStreaming(true)
    streamingRef.current = true
    pendingUserRef.current = null
    armWatchdog()
    window.api.aiAsk([
      { role: 'system', content: buildSummarizerPrompt() },
      {
        role: 'user',
        content:
          `Summary so far:\n${meetingSummaryRef.current.trim() || '(nothing summarised yet)'}\n\n` +
          `New transcript lines to fold in:\n${text}\n\nReturn the updated running summary.`
      }
    ])
  }

  // If enough un-summarised lines have piled up (beyond the recent window we keep
  // verbatim) and nothing else is streaming, fold them into the summary.
  function maybeSummarize(): void {
    if (streamingRef.current) return
    const from = summarizedUptoRef.current
    const to = finalsRef.current.length - SUMMARY_KEEP_RECENT
    if (to - from < SUMMARY_TRIGGER) return
    summarizeRange(from, to)
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
    intentRef.current = 'answer'
    setActiveTab('answer')
    // Keep the previous answer on screen: move it into history instead of wiping
    // it, so a new answer never erases what you're still reading.
    const prev = answerAccRef.current.trim()
    if (prev) setAnswerHistory((h) => [...h, prev].slice(-30))
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

  /**
   * Meeting mode: analyse the recent discussion (validate correctness, suggest
   * fixes, propose follow-up questions). Routed to the Analysis pane. Analysis
   * is stateless — it is not added to the answer conversation memory.
   */
  function streamAnalysis(user: string): void {
    if (streamingRef.current) window.api.aiCancel()
    intentRef.current = 'analyze'
    setActiveTab('analysis')
    // Keep the previous analysis on screen: move it into history instead of
    // wiping it, so continuous auto-analysis never erases what you're reading.
    const prev = analysisAccRef.current.trim()
    if (prev) setAnalysisHistory((h) => [...h, prev].slice(-30))
    setAnalysis('')
    setAiError(null)
    setStreaming(true)
    streamingRef.current = true
    analysisAccRef.current = ''
    pendingUserRef.current = null
    lastAnalyzedCountRef.current = finalsRef.current.length
    armWatchdog()
    window.api.aiAsk([
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: user }
    ])
  }

  // Manual "Clear" for the answer / analysis panes — the only thing that empties
  // them now (new responses append instead of wiping).
  function clearAnswers(): void {
    setAnswerHistory([])
    setSuggestion('')
    answerAccRef.current = ''
  }
  function clearAnalyses(): void {
    setAnalysisHistory([])
    setAnalysis('')
    analysisAccRef.current = ''
  }

  function analyzeDiscussion(): void {
    if (finalsRef.current.length === 0) return
    // Only the lines that are NEW since the last analysis are what we analyse now;
    // everything before is context. This stops the analysis from re-covering
    // previous points every time.
    const newCount = Math.max(1, finalsRef.current.length - lastAnalyzedCountRef.current)
    const latest = recentTranscript(newCount)
    streamAnalysis(
      `[ANALYZE] Earlier discussion (context only — already covered, do NOT re-analyse):\n${transcriptWithHistory(16)}\n\n` +
        `THE LATEST PART TO ANALYSE NOW (new since the last analysis):\n${latest}\n\n` +
        `Analyse ONLY this latest part using the ANALYZE format. Do not repeat analysis of the earlier context above.`
    )
  }

  // Meeting mode trigger: runs when the pause debounce OR the hard cap fires.
  // Clears both timers, then answers (if a question was aimed at me) or analyses
  // the discussion. If a stream is already running we skip — the next line will
  // re-arm the timers, so nothing is lost.
  function fireMeetingAuto(): void {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (maxWaitTimerRef.current) {
      clearTimeout(maxWaitTimerRef.current)
      maxWaitTimerRef.current = null
    }
    const directed = turnDirectedRef.current
    turnDirectedRef.current = false
    if (directed && autoAnswerRef.current) {
      // A question aimed at me has priority: answer it even if analysis is
      // currently streaming (streamAnswer cancels the in-flight analysis first).
      // Previously we bailed out when a stream was busy, so directed questions
      // were silently dropped while auto-analyse hogged the single AI stream —
      // that was the "answer is not generating" bug.
      askAi()
    } else if (autoAnalyzeRef.current) {
      // Analysis is lower priority: don't interrupt an in-flight answer/analysis.
      if (streamingRef.current) return
      // Only analyse once there is enough fresh discussion to be worth it.
      if (finalsRef.current.length - lastAnalyzedCountRef.current >= 2) analyzeDiscussion()
    }
  }

  function askAi(): void {
    if (finalsRef.current.length === 0) return
    const question = latestQuestion()
    if (!question) return
    // Mark this turn as answered so the next auto-answer only picks up questions
    // asked AFTER this point (prevents re-answering the same/previous question).
    lastAnsweredCountRef.current = finalsRef.current.length
    if (isMeeting) {
      streamAnswer(
        `[ANSWER] Recent meeting discussion (context only — do NOT answer anything here):\n${transcriptWithHistory(14)}\n\n` +
          `THE QUESTION TO ANSWER NOW (the most recent thing directed at me):\n"${question}"\n\n` +
          `Answer ONLY this most recent question, in the first person, ready to say out loud. Ignore and do not re-answer any earlier questions — use the discussion above only as background if this question refers back to it.`
      )
      return
    }
    streamAnswer(
      `Interview transcript (context only — do NOT answer anything here):\n${transcriptWithHistory(14)}\n\n` +
        `THE QUESTION TO ANSWER NOW (the interviewer's most recent question):\n"${question}"\n\n` +
        `Answer ONLY this most recent question thoroughly. Do not re-answer earlier questions; use the transcript above only as background if this question refers back to it.`
    )
  }

  function askManual(): void {
    const q = manualQuestion.trim()
    if (!q) return
    // A manual ask handles the current moment, so don't let the auto-answer
    // re-fire on the same transcript question right after.
    lastAnsweredCountRef.current = finalsRef.current.length
    const ctx = transcriptWithHistory(8)
    const user = isMeeting
      ? (ctx ? `[ANSWER] Recent meeting discussion (context):\n${ctx}\n\n` : '[ANSWER] ') +
        `Answer this for me, in the first person, ready to say out loud:\n"${q}"`
      : (ctx ? `Recent conversation (context):\n${ctx}\n\n` : '') +
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

  // --- Minutes of Meeting ---------------------------------------------------
  // System prompt that turns the raw transcript into structured, professional
  // meeting minutes. Grounded in the session's project/stack context so garbled
  // technical terms are corrected and nothing is invented.
  function buildMinutesPrompt(): string {
    const role = config?.role?.trim()
    const project = config?.projectContext?.trim()
    const stack = config?.techStack?.trim()
    const docs = config?.docsText?.trim()
    return [
      'You are an expert meeting secretary. Produce accurate, professional Minutes of Meeting (MoM) from the raw speech-to-text transcript provided.',
      'The transcript is machine-generated and will contain recognition errors, especially for technical and product terms — silently correct them to the intended canonical terms using the project context and tech stack below (for example "ring board" means "Spring Boot", "power gres" means "PostgreSQL", "jason" means "JSON").',
      'Output ONLY the minutes in clean Markdown — no preamble and no closing remarks. Use these sections in order, and omit any section that has nothing substantive:',
      '# Minutes of Meeting',
      '**Attendees:** the participants, using the speaker names/labels that appear in the transcript.',
      '## Summary',
      'A short paragraph (3-5 sentences) capturing the purpose and outcome of the meeting.',
      '## Key Discussion Points',
      'Concise bullets of the main topics discussed and the important details of each.',
      '## Decisions Made',
      'Each concrete decision that was agreed, as a bullet.',
      '## Action Items',
      'A checklist in the form "- [ ] Task — Owner (due date if mentioned)". Only include real tasks that were actually assigned or agreed.',
      '## Open Questions / Follow-ups',
      'Any unresolved questions or items to revisit.',
      'Be strictly faithful to what was actually said — never invent decisions, owners, dates, numbers, or facts that are not in the transcript. Skip greetings, small talk, and filler.',
      role ? `Host role context: ${role}.` : '',
      project ? `Project / application context:\n${project}` : '',
      stack ? `Tech stack: ${stack}.` : '',
      docs ? `Reference docs:\n${docs}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  // Called by the "End & Minutes" button. Stops capture, then asks the LLM to
  // turn the entire transcript (every finalised line) into minutes, streamed
  // into the minutes modal.
  function generateMinutes(): void {
    setMinutesError(null)
    setMinutesOpen(true)
    if (finalsRef.current.length === 0) {
      setMinutes('')
      setMinutesError('No transcript yet — start listening and capture the meeting first.')
      return
    }
    if (capturing) stopCapture()
    if (streamingRef.current) window.api.aiCancel()
    intentRef.current = 'minutes'
    minutesAccRef.current = ''
    setMinutes('')
    setStreaming(true)
    streamingRef.current = true
    pendingUserRef.current = null
    armWatchdog()
    // finals holds every line ever transcribed, so this is the complete meeting.
    const full = recentTranscript(finalsRef.current.length)
    window.api.aiAsk([
      { role: 'system', content: buildMinutesPrompt() },
      {
        role: 'user',
        content: `Here is the full meeting transcript:\n\n${full}\n\nGenerate the Minutes of Meeting now, following the required format.`
      }
    ])
  }

  async function copyMinutes(): Promise<void> {
    const text = minutesAccRef.current || minutes
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setMinutesCopied(true)
      setTimeout(() => setMinutesCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable; ignore silently.
    }
  }

  useEffect(() => {
    const off = window.api.onAudioStats((s) => setSeconds(s))
    return off
  }, [])

  useEffect(() => {
    const offToken = window.api.onAiToken((t) => {
      armWatchdog()
      if (intentRef.current === 'summarize') {
        // Background memory update — accumulate silently, never touch the UI.
        summaryAccRef.current += t
      } else if (intentRef.current === 'minutes') {
        minutesAccRef.current += t
        setMinutes((prev) => prev + t)
      } else if (intentRef.current === 'analyze') {
        analysisAccRef.current += t
        setAnalysis((prev) => prev + t)
      } else {
        answerAccRef.current += t
        setSuggestion((prev) => prev + t)
      }
    })
    const offDone = window.api.onAiDone(() => {
      clearWatchdog()
      setStreaming(false)
      streamingRef.current = false
      // Only answers become conversation memory; analysis is stateless.
      if (intentRef.current === 'summarize') {
        const s = summaryAccRef.current.trim()
        if (s) {
          meetingSummaryRef.current = s
          summarizedUptoRef.current = summarizeTargetRef.current
        }
        summaryAccRef.current = ''
      } else if (intentRef.current === 'answer') {
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
      }
      pendingUserRef.current = null
      // Now that the stream is idle, fold any backlog of older lines into memory.
      setTimeout(() => maybeSummarize(), 0)
    })
    const offErr = window.api.onAiError((m) => {
      clearWatchdog()
      // A failed background summarise must stay silent — keep the old summary and
      // retry later rather than showing an error over the transcript.
      if (intentRef.current === 'summarize') {
        setStreaming(false)
        streamingRef.current = false
        summaryAccRef.current = ''
        pendingUserRef.current = null
        return
      }
      // A failed minutes generation is shown inside the minutes modal.
      if (intentRef.current === 'minutes') {
        setMinutesError(m)
        setStreaming(false)
        streamingRef.current = false
        minutesAccRef.current = ''
        pendingUserRef.current = null
        return
      }
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

  // Long-meeting memory: periodically fold older transcript into the running
  // summary while the stream is idle, so context survives a 2-hour session even
  // if the user turns auto-analyse/answer off.
  useEffect(() => {
    const id = setInterval(() => maybeSummarize(), 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.api.onStealthChanged(setStealth)
    return off
  }, [])

  useEffect(() => {
    const last = finals[finals.length - 1]
    if (!last || last.source !== 'interviewer') return

    if (isMeeting) {
      // Meeting mode runs off two independent toggles, so don't early-return on
      // autoAnswer. Track whether this turn was aimed at me, then either draft an
      // answer (aimed at me) or analyse the discussion.
      if (isDirectedAtMe(last.text, config?.userName)) turnDirectedRef.current = true
      // Debounce: (re)arm the "they've stopped talking" pause timer. Use a
      // shorter wait when a question is aimed at me so I get an answer faster.
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
      const wait = turnDirectedRef.current ? AUTO_DIRECTED_MS : AUTO_SILENCE_MS
      autoTimerRef.current = setTimeout(fireMeetingAuto, wait)
      // Hard cap: arm ONCE at the start of a burst and never reset it, so a fast
      // Speaker 1 ↔ Speaker 2 exchange (no long pause) still fires in time.
      if (!maxWaitTimerRef.current) {
        maxWaitTimerRef.current = setTimeout(fireMeetingAuto, AUTO_MAX_WAIT_MS)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
      return
    }

    if (!autoAnswerRef.current) return
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
    }, AUTO_SILENCE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finals])

  useEffect(() => {
    // Cancel a pending promote timer for a source.
    const clearPromote = (src: TranscriptSource): void => {
      const t = promoteTimerRef.current[src]
      if (t) {
        clearTimeout(t)
        promoteTimerRef.current[src] = null
      }
    }
    // Commit a preview that has run too long without finalising, so the
    // transcript keeps flowing during non-stop speech. Marked `provisional` so
    // Deepgram's real final can replace it in place instead of duplicating.
    const promote = (src: TranscriptSource): void => {
      promoteTimerRef.current[src] = null
      const t = interimRef.current[src]?.trim()
      if (!t || hasProvisionalRef.current[src]) return
      hasProvisionalRef.current[src] = true
      setFinals((prev) => [...prev, { source: src, text: t, provisional: true }])
      setInterim((prev) => ({ ...prev, [src]: '' }))
    }
    const offT = window.api.onTranscript(({ source, text, isFinal, speaker, confidence }) => {
      const kind: AudioSourceKind = source === 'interviewer' ? 'system' : 'mic'
      // Sarvam sends no confidence (its finals are undefined) and does its own
      // server-side VAD, so it needs a wider local window; confidence-bearing
      // engines (Deepgram) keep the strict window to catch their hallucinations.
      const serverVad = typeof confidence !== 'number'
      const voiceWindow = serverVad ? SARVAM_VOICE_WINDOW_MS : VOICE_WINDOW_MS
      // Voice-activity gate: if no speech-level audio energy occurred on this
      // source recently, the model invented this text over silence — ignore it.
      const heardVoice = Date.now() - vadRef.current[kind].lastVoiceTs <= voiceWindow
      // Deepgram's per-utterance confidence (0-1). High = trust its own VAD.
      const conf = typeof confidence === 'number' ? confidence : undefined
      const lowConfidence = conf !== undefined && conf < MIN_CONFIDENCE
      if (isFinal) {
        // A final ends the current utterance, so cancel any pending promote timer.
        clearPromote(source)
        // Decide whether to keep this finalised line.
        //  - Deepgram (has a confidence): TRUST its professional VAD + confidence.
        //    Drop only obvious hallucination phrases (isNoise) or genuinely
        //    low-confidence guesses. We deliberately do NOT require our crude RMS
        //    energy meter here: on system/loopback audio it often under-reads and
        //    was silently dropping correct medium-confidence words — the main
        //    cause of the "accuracy is too low / words missing" problem.
        //  - Sarvam (no confidence): fall back to the RMS voice window to reject
        //    text invented over true silence.
        const isBad = isNoise(text) || (conf !== undefined ? lowConfidence : !heardVoice)
        if (isBad) {
          if (!isNoise(text) && !heardVoice)
            console.debug('[vad] dropped silent hallucination:', text)
          if (!isNoise(text) && lowConfidence)
            console.debug('[conf] dropped low-confidence text:', conf, text)
          // If a provisional line already showed this (real) speech, keep it as a
          // committed line rather than erasing it; only clear the gray preview.
          if (hasProvisionalRef.current[source]) {
            hasProvisionalRef.current[source] = false
            setFinals((prev) =>
              prev.map((l) =>
                l.provisional && l.source === source ? { ...l, provisional: false } : l
              )
            )
          }
          setInterim((prev) => ({ ...prev, [source]: '' }))
          return
        }
        // Accepted final: if we committed this utterance early, replace that
        // provisional line in place (now with the accurate text + speaker label);
        // otherwise append a new line. This is what prevents duplicates.
        setFinals((prev) => {
          const idx = prev.findIndex((l) => l.provisional && l.source === source)
          if (idx !== -1) {
            const next = prev.slice()
            next[idx] = { source, text, speaker, provisional: false }
            return next
          }
          return [...prev, { source, text, speaker }]
        })
        hasProvisionalRef.current[source] = false
        setInterim((prev) => ({ ...prev, [source]: '' }))
      } else if (heardVoice || conf !== undefined) {
        // Live preview (interim). Deepgram sends a confidence with every partial
        // and its own professional VAD already decided this is speech — so show
        // partials immediately instead of waiting for our crude RMS meter.
        if (hasProvisionalRef.current[source]) {
          // This utterance was already committed early: keep refining that line
          // in place instead of showing a separate gray preview below it.
          setFinals((prev) =>
            prev.map((l) => (l.provisional && l.source === source ? { ...l, text } : l))
          )
        } else {
          setInterim((prev) => ({ ...prev, [source]: text }))
          // Arm a one-shot timer (only when a fresh preview starts) so a preview
          // that never finalises — non-stop / overlapping speech — is committed
          // within INTERIM_PROMOTE_MS instead of waiting for a silence.
          if (!promoteTimerRef.current[source]) {
            promoteTimerRef.current[source] = setTimeout(() => promote(source), INTERIM_PROMOTE_MS)
          }
        }
      }
    })
    const offS = window.api.onTranscriptStatus(({ status, message }) => {
      setDgStatus(message ? `${status}: ${message}` : status)
    })
    return () => {
      offT()
      offS()
      clearPromote('interviewer')
      clearPromote('you')
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
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
      if (maxWaitTimerRef.current) clearTimeout(maxWaitTimerRef.current)
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

  // Build Deepgram keyterms from the session so domain jargon (tech stack,
  // product/feature names) is recognised accurately instead of misheard. We take
  // the tech stack plus multi-word / capitalised / dotted terms from the project
  // context (e.g. "OAuth", "PostgreSQL", "login page"), de-duplicated and capped.
  function buildKeyterms(): string[] {
    const terms = new Set<string>(DEFAULT_TECH_KEYTERMS)
    const addList = (s?: string): void => {
      for (const part of (s ?? '').split(/[,;\n/|]+/)) {
        const t = part.trim()
        if (t.length >= 2 && t.length <= 40) terms.add(t)
      }
    }
    addList(config?.techStack)
    const ctx = config?.projectContext ?? ''
    // Capture 1-3 word Capitalised phrases ("Spring Boot", "React Native"),
    // CamelCase ("PostgreSQL"), and dotted tech tokens ("node.js") as single
    // keyterms — feeding the whole phrase is what makes Deepgram recognise it.
    const phrase = /\b([A-Z][a-zA-Z0-9.+#]*(?:\s+[A-Z][a-zA-Z0-9.+#]*){0,2})\b/g
    const dotted = /\b([a-zA-Z]+(?:\.[a-zA-Z]+)+)\b/g
    for (const re of [phrase, dotted]) {
      for (const m of ctx.match(re) ?? []) {
        const t = m.trim()
        if (t.length >= 2 && t.length <= 40) terms.add(t)
      }
    }
    if (config?.role) terms.add(config.role)
    return [...terms].slice(0, 80)
  }

  async function startCapture(): Promise<void> {
    setAudioError(null)
    setFinals([])
    setInterim({ interviewer: '', you: '' })
    setDgStatus('')
    setSpeakerNames({})
    setAnswerHistory([])
    setAnalysisHistory([])
    lastAnalyzedCountRef.current = 0
    lastAnsweredCountRef.current = 0
    hasProvisionalRef.current = { interviewer: false, you: false }
    if (promoteTimerRef.current.interviewer) clearTimeout(promoteTimerRef.current.interviewer)
    if (promoteTimerRef.current.you) clearTimeout(promoteTimerRef.current.you)
    promoteTimerRef.current = { interviewer: null, you: null }
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
    window.api.audioStart(micEnabled, provider, buildKeyterms())
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
    // Cancel any pending auto-response timers so they can't fire after we stop.
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (maxWaitTimerRef.current) {
      clearTimeout(maxWaitTimerRef.current)
      maxWaitTimerRef.current = null
    }
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
            onClick={generateMinutes}
            disabled={streaming && intentRef.current === 'minutes'}
            title="End the meeting and generate the Minutes of Meeting from the full transcript"
            className="rounded-md bg-amber-500/90 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-400 disabled:opacity-40"
          >
            {capturing ? 'End & Minutes' : 'Minutes of Meeting'}
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
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as Provider)}
            disabled={capturing}
            title="Choose the speech engine. Deepgram handles all English accents (American, British/UK, Indian and other native accents) and labels each speaker; Sarvam's only English model is Indian-accent tuned and can't separate speakers."
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-100 focus:border-indigo-400/50 focus:outline-none disabled:opacity-50"
          >
            <option value="deepgram">Deepgram · English + labels</option>
            <option value="sarvam">Sarvam · Indian English</option>
            <option value="auto">Auto (Sarvam + fallback)</option>
          </select>
          {audioError && (
            <span className="truncate text-[10px] text-red-300" title={audioError}>
              {audioError}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Meter
            label={isMeeting ? 'Meeting (system)' : 'Interviewer (system)'}
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
                  interim={!!line.provisional}
                  meeting={isMeeting}
                  name={line.speaker != null ? speakerNames[line.speaker] : undefined}
                />
              ))}
              {interim.interviewer && (
                <TranscriptLine
                  source="interviewer"
                  text={interim.interviewer}
                  interim
                  meeting={isMeeting}
                />
              )}
              {interim.you && (
                <TranscriptLine source="you" text={interim.you} interim meeting={isMeeting} />
              )}
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
          placeholder={
            isMeeting
              ? 'Ask for an answer or type a question to address…'
              : 'Type a question (scenario / long) and press Enter…'
          }
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
      {isMeeting ? (
        <div className="no-drag mx-3 mb-3 flex h-[42%] flex-col overflow-hidden rounded-xl border border-indigo-400/20 bg-indigo-500/10">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab('analysis')}
                className={`rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                  activeTab === 'analysis'
                    ? 'bg-indigo-400/25 text-indigo-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Analysis
              </button>
              <button
                onClick={() => setActiveTab('answer')}
                className={`rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                  activeTab === 'answer'
                    ? 'bg-indigo-400/25 text-indigo-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Answer
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setAutoAnalyze((v) => !v)}
                title="Continuously analyse the team discussion"
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  autoAnalyze ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/5 text-zinc-500'
                }`}
              >
                Auto-analyse {autoAnalyze ? 'on' : 'off'}
              </button>
              <button
                onClick={() => setAutoAnswer((v) => !v)}
                title="Auto-answer when a question is aimed at you"
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  autoAnswer ? 'bg-indigo-400/25 text-indigo-200' : 'bg-white/5 text-zinc-500'
                }`}
              >
                Auto-answer {autoAnswer ? 'on' : 'off'}
              </button>
              {streaming ? (
                <button
                  onClick={cancelAi}
                  className="rounded bg-red-500/80 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-red-500"
                >
                  Stop
                </button>
              ) : activeTab === 'analysis' ? (
                <button
                  onClick={analyzeDiscussion}
                  className="rounded bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-400"
                >
                  Analyse
                </button>
              ) : (
                <button
                  onClick={askAi}
                  className="rounded bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-400"
                >
                  Answer
                </button>
              )}
              <button
                onClick={activeTab === 'analysis' ? clearAnalyses : clearAnswers}
                title={`Clear the ${activeTab === 'analysis' ? 'analysis' : 'answer'} history`}
                disabled={
                  activeTab === 'analysis'
                    ? analysisHistory.length === 0 && !analysis
                    : answerHistory.length === 0 && !suggestion
                }
                className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-30"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed text-zinc-100">
            {aiError ? (
              <span className="text-red-300">{aiError}</span>
            ) : activeTab === 'analysis' ? (
              analysisHistory.length > 0 || analysis ? (
                <div>
                  {analysisHistory.map((a, i) => (
                    <div key={i} className="mb-3 border-b border-white/10 pb-3 opacity-80">
                      <Markdown>{a}</Markdown>
                    </div>
                  ))}
                  {analysis && (
                    <div>
                      <Markdown>{analysis}</Markdown>
                      {streaming && intentRef.current === 'analyze' && (
                        <span className="ml-0.5 animate-pulse text-emerald-300">▍</span>
                      )}
                    </div>
                  )}
                </div>
              ) : streaming && intentRef.current === 'analyze' ? (
                <span className="text-zinc-500">Analysing the discussion…</span>
              ) : (
                <span className="text-zinc-500">
                  Live analysis of the discussion appears here — what’s correct, what to fix, and
                  smart follow-up questions.
                </span>
              )
            ) : answerHistory.length > 0 || suggestion ? (
              <div>
                {answerHistory.map((a, i) => (
                  <div key={i} className="mb-3 border-b border-white/10 pb-3 opacity-80">
                    <Markdown>{a}</Markdown>
                  </div>
                ))}
                {suggestion && (
                  <div>
                    <Markdown>{suggestion}</Markdown>
                    {streaming && intentRef.current === 'answer' && (
                      <span className="ml-0.5 animate-pulse text-indigo-300">▍</span>
                    )}
                  </div>
                )}
              </div>
            ) : streaming && intentRef.current === 'answer' ? (
              <span className="text-zinc-500">Generating…</span>
            ) : (
              <span className="text-zinc-500">
                Answers to questions aimed at you appear here. Press{' '}
                <kbd className="rounded bg-white/10 px-1">Ctrl+Shift+Enter</kbd> / Answer.
              </span>
            )}
          </div>
        </div>
      ) : (
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
              <button
                onClick={clearAnswers}
                title="Clear the answer history"
                disabled={answerHistory.length === 0 && !suggestion}
                className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-white/10 disabled:opacity-30"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed text-zinc-100">
            {aiError ? (
              <span className="text-red-300">{aiError}</span>
            ) : answerHistory.length > 0 || suggestion ? (
              <div>
                {answerHistory.map((a, i) => (
                  <div key={i} className="mb-3 border-b border-white/10 pb-3 opacity-80">
                    <Markdown>{a}</Markdown>
                  </div>
                ))}
                {suggestion && (
                  <div>
                    <Markdown>{suggestion}</Markdown>
                    {streaming && <span className="ml-0.5 animate-pulse text-indigo-300">▍</span>}
                  </div>
                )}
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
      )}

      {/* Hotkey legend */}
      <div className="drag border-t border-white/10 px-4 py-2 text-[10px] text-zinc-500">
        <span className="mr-3">Ctrl+Shift+Space show/hide</span>
        <span className="mr-3">Ctrl+Shift+Enter answer</span>
        <span className="mr-3">Ctrl+Shift+\ click-through</span>
        <span>Ctrl+Shift+H hide</span>
      </div>

      {/* Minutes of Meeting modal */}
      {minutesOpen && (
        <div className="no-drag fixed inset-0 z-50 flex flex-col bg-zinc-950/95 backdrop-blur">
          <div className="drag flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <span className="text-sm font-semibold text-amber-200">Minutes of Meeting</span>
            <div className="no-drag flex items-center gap-1.5">
              {streaming && intentRef.current === 'minutes' ? (
                <button
                  onClick={cancelAi}
                  className="rounded bg-red-500/80 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-500"
                >
                  Stop
                </button>
              ) : (
                <>
                  <button
                    onClick={copyMinutes}
                    disabled={!minutes}
                    className="rounded bg-white/10 px-2 py-1 text-[11px] font-medium text-zinc-100 hover:bg-white/20 disabled:opacity-40"
                  >
                    {minutesCopied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    onClick={generateMinutes}
                    disabled={finals.length === 0}
                    className="rounded bg-amber-500/90 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-400 disabled:opacity-40"
                  >
                    Regenerate
                  </button>
                </>
              )}
              <button
                onClick={() => setMinutesOpen(false)}
                className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
              >
                Close
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed text-zinc-100">
            {minutesError ? (
              <span className="text-red-300">{minutesError}</span>
            ) : minutes ? (
              <div>
                <Markdown>{minutes}</Markdown>
                {streaming && intentRef.current === 'minutes' && (
                  <span className="ml-0.5 animate-pulse text-amber-300">▍</span>
                )}
              </div>
            ) : streaming && intentRef.current === 'minutes' ? (
              <span className="text-zinc-500">Generating minutes from the meeting…</span>
            ) : (
              <span className="text-zinc-500">No minutes yet.</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
