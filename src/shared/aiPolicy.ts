import type { AiIntent } from './ai'

/**
 * Output budgets are intentionally per intent: short background summaries must
 * stay cheap, while minutes and detailed answers need room to finish cleanly.
 */
// The interview "detailed" style asks for a three-point outline plus a 350-550
// word answer, and technical questions add a fenced code block on top. That lands
// within a few tokens of 1_400, so answers were routinely cut off mid-sentence —
// and Azure reports a truncated stream as an error, not a completion.
export const AI_OUTPUT_TOKEN_BUDGETS: Readonly<Record<AiIntent, number>> = {
  answer: 2_400,
  analyze: 1_400,
  summarize: 700,
  minutes: 2_400
}

export function outputTokenBudgetForIntent(intent: AiIntent): number {
  return AI_OUTPUT_TOKEN_BUDGETS[intent]
}
