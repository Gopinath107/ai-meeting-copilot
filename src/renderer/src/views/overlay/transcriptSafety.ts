/**
 * Exact filler and common subtitle hallucinations that are safe to reject.
 *
 * Do not reject arbitrary short tokens here: "C", "R", "Go", "AI" and
 * "UI" are all valid answers in technical interviews.
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

const NOISE_PATTERNS: RegExp[] = [
  /^\[.*\]$/,
  /^\(.*\)$/,
  /\bthanks?\s+(you\s+)?for\s+watching\b/,
  /\bplease\s+(like|subscribe|comment)\b/,
  /\bsubscribe\s+to\b/,
  /\bsee\s+you\s+(in\s+the\s+)?next\s+(video|time|one)\b/,
  /\bi'?ll\s+see\s+you\s+next\s+time\b/,
  /\bdon'?t\s+forget\s+to\s+subscribe\b/
]

export function isLikelyTranscriptNoise(raw: string): boolean {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?,…\-\s]+$/g, '')
    .trim()
  if (!normalized) return true
  if (NOISE_PHRASES.has(normalized)) return true

  const words = normalized.split(/\s+/)
  if (
    words.length >= 2 &&
    words.every((word) => word === words[0]) &&
    words[0].length <= 4
  ) {
    return true
  }

  return NOISE_PATTERNS.some((pattern) => pattern.test(normalized))
}
