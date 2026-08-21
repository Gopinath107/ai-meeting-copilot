export const INTERVIEW_ANSWER_STYLES = ['concise', 'standard', 'detailed'] as const

export type InterviewAnswerStyle = (typeof INTERVIEW_ANSWER_STYLES)[number]
export type InterviewAnswerReason = 'answer' | 'regenerate'

export type InterviewAnswerRequest = {
  /** The captured question to answer. Regeneration must reuse this value verbatim. */
  question: string
  style: InterviewAnswerStyle
  reason: InterviewAnswerReason
  progressive: true
}

export type InterviewAnswerSnapshot = {
  question: string
  answer: string
  style: InterviewAnswerStyle
}

export type PinnedInterviewAnswer = InterviewAnswerSnapshot & {
  id: string
}

export type InterviewPinnedAnswerChange =
  | { action: 'pin'; answer: InterviewAnswerSnapshot }
  | { action: 'unpin'; id: string }

export type ProgressiveOutlineStage = {
  kind: 'outline'
  pointCount: 3
  instruction: string
}

export type ProgressiveFullAnswerStage = {
  kind: 'full'
  targetWords: readonly [minimum: number, maximum: number]
  instruction: string
}

export type ProgressiveAnswerStage = ProgressiveOutlineStage | ProgressiveFullAnswerStage

export type ProgressiveAnswerPlan = {
  request: InterviewAnswerRequest
  stages: readonly [ProgressiveOutlineStage, ProgressiveFullAnswerStage]
  /** Append this instruction to the answer request sent to the model. */
  instruction: string
}

type StylePolicy = {
  targetWords: readonly [minimum: number, maximum: number]
  fullInstruction: string
}

const STYLE_POLICIES: Readonly<Record<InterviewAnswerStyle, StylePolicy>> = {
  concise: {
    targetWords: [80, 140],
    fullInstruction:
      'Give a direct answer with only the strongest example or trade-off. Avoid repeated context.'
  },
  standard: {
    targetWords: [180, 300],
    fullInstruction:
      'Give a balanced interview-ready answer with reasoning, one concrete example, and key trade-offs.'
  },
  detailed: {
    targetWords: [350, 550],
    fullInstruction:
      'Give a thorough answer with assumptions, step-by-step reasoning, examples, trade-offs, and likely follow-up points.'
  }
}

export function isInterviewAnswerStyle(value: unknown): value is InterviewAnswerStyle {
  return typeof value === 'string' && INTERVIEW_ANSWER_STYLES.includes(value as InterviewAnswerStyle)
}

export function normalizeInterviewAnswerStyle(value: unknown): InterviewAnswerStyle {
  return isInterviewAnswerStyle(value) ? value : 'standard'
}

export function createInterviewAnswerRequest(
  question: string,
  style: InterviewAnswerStyle,
  reason: InterviewAnswerReason = 'answer'
): InterviewAnswerRequest {
  if (!question.trim()) throw new Error('An interview question is required')
  return { question, style, reason, progressive: true }
}

/**
 * Build a one-stream progressive response: the first visible tokens are a
 * three-point speaking outline, followed by the complete interview answer.
 */
export function createProgressiveAnswerPlan(
  question: string,
  style: InterviewAnswerStyle = 'standard',
  reason: InterviewAnswerReason = 'answer'
): ProgressiveAnswerPlan {
  const request = createInterviewAnswerRequest(question, style, reason)
  const policy = STYLE_POLICIES[style]
  const outline: ProgressiveOutlineStage = {
    kind: 'outline',
    pointCount: 3,
    instruction:
      'Begin immediately with the heading "Quick outline" and exactly three short, one-line bullets. Do not add a preamble.'
  }
  const full: ProgressiveFullAnswerStage = {
    kind: 'full',
    targetWords: policy.targetWords,
    instruction:
      `Then write a "Full answer" of about ${policy.targetWords[0]}-${policy.targetWords[1]} words. ${policy.fullInstruction}`
  }

  return {
    request,
    stages: [outline, full],
    instruction: [
      'Respond progressively so the candidate can start speaking before the complete answer is ready.',
      outline.instruction,
      full.instruction,
      'Keep the outline and full answer consistent. Do not invent personal experience; phrase hypothetical examples honestly.',
      reason === 'regenerate'
        ? 'This replaces an answer you already gave to this same question. Keep it correct, but lead with a different angle or example and restructure it rather than restating your previous wording.'
        : ''
    ]
      .filter(Boolean)
      .join(' ')
  }
}

export function createInterviewAnswerSnapshot(
  question: string,
  answer: string,
  style: InterviewAnswerStyle
): InterviewAnswerSnapshot | null {
  if (!question.trim() || !answer.trim()) return null
  return { question, answer, style }
}

export function isSameInterviewAnswer(
  pinned: Pick<PinnedInterviewAnswer, 'question' | 'answer'>,
  candidate: Pick<InterviewAnswerSnapshot, 'question' | 'answer'>
): boolean {
  return pinned.question === candidate.question && pinned.answer === candidate.answer
}
