import type {
  AiAskRequest,
  AiIntent,
  AiTextMessage,
  ScreenshotContext
} from '../../../../shared/ai'

export function createAiRequestId(
  sessionGeneration: number,
  sequence: number,
  intent: AiIntent
): string {
  return `${sessionGeneration}-${sequence}-${intent}`
}

/** Keep multimodal attachment policy in one pure, independently testable place. */
export function createAiAskRequest({
  requestId,
  intent,
  messages,
  screenshot
}: {
  requestId: string
  intent: AiIntent
  messages: AiTextMessage[]
  screenshot?: ScreenshotContext
}): AiAskRequest {
  const request: AiAskRequest = { requestId, intent, messages }
  if (screenshot && (intent === 'answer' || intent === 'analyze')) {
    request.screenshot = screenshot
  }
  return request
}

/** Detect direct questions as well as spoken interview prompts without '?'. */
export function looksLikeQuestion(raw: string): boolean {
  const text = raw.trim()
  if (text.length < 3) return false
  if (/\?\s*$/.test(text)) return true
  if (text.split(/\s+/).length < 2) return false
  const normalized = text.toLowerCase()
  const imperative =
    /^(?:please\s+)?(?:design|implement|build|write|code|solve|debug|fix|optimise|optimize|refactor|review|explain|describe|compare|contrast|outline|demonstrate|show me|walk me through|talk me through)\b/
  if (imperative.test(normalized)) return true
  const starters =
    /^(what|why|how|when|where|which|who|whose|whom|can|could|would|will|shall|should|do|does|did|are|is|was|were|have|has|had|may|might)\b/
  if (starters.test(normalized)) return true
  const prompts =
    /\b(tell me|walk me through|run me through|take me through|describe|explain|elaborate|define|compare|contrast|give me|share|discuss|talk about|talk to me about|let'?s talk|how would you|what would you|what is|what are|how do you|how does|why do|why is|difference between|your thoughts on|your experience with)\b/
  return prompts.test(normalized)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A name mention alone is not direction ("Gopi owns that task"). Require the
 * utterance, with a leading name/vocative removed, to remain a real prompt.
 */
export function isDirectedAtMe(raw: string, userName?: string): boolean {
  const normalized = raw.trim().toLowerCase()
  if (normalized.length < 3) return false

  const firstName = userName?.trim().toLowerCase().split(/\s+/)[0]
  if (firstName && firstName.length >= 2) {
    const escaped = escapeRegExp(firstName)
    const mention = new RegExp(`\\b${escaped}\\b`)
    if (mention.test(normalized)) {
      const withoutLeadingName = normalized
        .replace(new RegExp(`^\\s*${escaped}\\b[\\s,:;.!?\u2014-]*`), '')
        .trim()
      if (withoutLeadingName !== normalized && looksLikeQuestion(withoutLeadingName)) return true

      // Also accept ordinary interrogatives that mention the user later:
      // "Can Gopi explain the decision?"
      if (
        /^(what|why|how|when|where|which|who|can|could|would|will|should|do|does|did|are|is|was|were|have|has|had|may|might)\b/.test(
          normalized
        ) &&
        looksLikeQuestion(normalized)
      ) {
        return true
      }
    }
  }

  const secondPersonCue =
    /\b(what do you think|your thoughts|your take|can you|could you|would you|how would you|what would you|do you (know|think|have)|any (thoughts|ideas|input)|over to you|what about you|your opinion)\b/
  return secondPersonCue.test(normalized) && looksLikeQuestion(raw)
}

/**
 * Pick the current prompt without treating every same-source line since the
 * previous answer as one giant question. This matters when microphone capture
 * is off and an entire multi-person discussion is labelled as interviewer.
 */
export function selectLatestQuestion(
  lines: ReadonlyArray<{ source: 'interviewer' | 'you'; text: string }>,
  lastAnsweredCount: number,
  userName?: string
): string {
  const start = Math.min(Math.max(0, lastAnsweredCount), lines.length)
  if (start >= lines.length) return ''
  // With the mic on, the candidate is usually already stalling or starting to
  // speak ("umm, sure") by the time the answer is due. Those trailing lines must
  // not hide the question we still owe an answer to.
  let end = lines.length
  while (end > start && lines[end - 1].source === 'you') end -= 1
  if (end === start) return ''
  const turn: string[] = []
  for (let index = end - 1; index >= start; index -= 1) {
    if (lines[index].source !== 'interviewer') break
    turn.unshift(lines[index].text)
  }

  if (turn.length === 0) return ''

  let questionStart = -1
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    if (looksLikeQuestion(turn[index]) || isDirectedAtMe(turn[index], userName)) {
      questionStart = index
      break
    }
  }
  if (
    questionStart > 0 &&
    !/[?.!]\s*$/.test(turn[questionStart - 1]) &&
    /^(?:and|or|also|then|with|using|in)\b/i.test(turn[questionStart].trim()) &&
    looksLikeQuestion(turn[questionStart - 1])
  ) {
    questionStart -= 1
  }
  if (questionStart < 0) return ''
  const current = turn.slice(questionStart)
  return current.slice(-6).join(' ').trim()
}
