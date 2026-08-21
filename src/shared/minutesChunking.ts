export type TranscriptChunk = {
  index: number
  text: string
  estimatedTokens: number
}

export type TranscriptChunkingOptions = {
  /** Approximate input-token ceiling for each summarization request. */
  maxTokensPerChunk?: number
  /** Conservative token estimate; English prose averages roughly 4 chars/token. */
  charactersPerToken?: number
}

export type MinutesChunkPlan = {
  chunks: TranscriptChunk[]
  estimatedInputTokens: number
  requiresHierarchicalSummary: boolean
}

export function estimateTextTokens(text: string, charactersPerToken = 4): number {
  const ratio = Number.isFinite(charactersPerToken)
    ? Math.min(8, Math.max(1, charactersPerToken))
    : 4
  return text.length === 0 ? 0 : Math.ceil(text.length / ratio)
}

function splitOversizedLine(line: string, maxCharacters: number): string[] {
  const parts: string[] = []
  let remaining = line.trim()
  while (remaining.length > maxCharacters) {
    const candidate = remaining.slice(0, maxCharacters + 1)
    const sentenceBoundary = Math.max(
      candidate.lastIndexOf('. '),
      candidate.lastIndexOf('? '),
      candidate.lastIndexOf('! ')
    )
    const whitespaceBoundary = candidate.lastIndexOf(' ')
    const boundary = sentenceBoundary >= maxCharacters * 0.5 ? sentenceBoundary + 1 : whitespaceBoundary
    const safeBoundary = boundary >= maxCharacters * 0.5 ? boundary : maxCharacters
    parts.push(remaining.slice(0, safeBoundary).trim())
    remaining = remaining.slice(safeBoundary).trim()
  }
  if (remaining) parts.push(remaining)
  return parts
}

/**
 * Build a lossless, order-preserving plan for hierarchical minutes generation.
 * Transcript lines remain intact where possible; oversized lines are split on
 * sentence/word boundaries. No overlap is added, avoiding duplicated decisions.
 */
export function createMinutesChunkPlan(
  transcript: string,
  options: TranscriptChunkingOptions = {}
): MinutesChunkPlan {
  const charactersPerToken = Number.isFinite(options.charactersPerToken)
    ? Math.min(8, Math.max(1, options.charactersPerToken as number))
    : 4
  const maxTokens = Number.isFinite(options.maxTokensPerChunk)
    ? Math.min(100_000, Math.max(256, Math.trunc(options.maxTokensPerChunk as number)))
    : 8_000
  const maxCharacters = Math.max(1, Math.floor(maxTokens * charactersPerToken))
  const normalized = transcript.replace(/\r\n?/g, '\n').trim()
  const estimatedInputTokens = estimateTextTokens(normalized, charactersPerToken)
  if (!normalized) {
    return { chunks: [], estimatedInputTokens: 0, requiresHierarchicalSummary: false }
  }

  const units = normalized
    .split('\n')
    .flatMap((line) => splitOversizedLine(line, maxCharacters))
    .filter(Boolean)
  const rawChunks: string[] = []
  let current = ''
  for (const unit of units) {
    const candidate = current ? `${current}\n${unit}` : unit
    if (candidate.length <= maxCharacters) {
      current = candidate
      continue
    }
    if (current) rawChunks.push(current)
    current = unit
  }
  if (current) rawChunks.push(current)

  const chunks = rawChunks.map((text, index) => ({
    index,
    text,
    estimatedTokens: estimateTextTokens(text, charactersPerToken)
  }))
  return {
    chunks,
    estimatedInputTokens,
    requiresHierarchicalSummary: chunks.length > 1
  }
}

/** A stable wrapper for the final reduce request after chunk summaries finish. */
export function formatMinutesPartials(partials: readonly string[]): string {
  return partials
    .map((partial, index) => `--- Transcript section ${index + 1} summary ---\n${partial.trim()}`)
    .join('\n\n')
}
