import { describe, expect, it } from 'vitest'
import { outputTokenBudgetForIntent } from '../src/shared/aiPolicy'
import {
  createMinutesChunkPlan,
  estimateTextTokens,
  formatMinutesPartials
} from '../src/shared/minutesChunking'

describe('AI output budgets', () => {
  it('gives long-form intents more room than background summaries', () => {
    expect(outputTokenBudgetForIntent('minutes')).toBeGreaterThan(
      outputTokenBudgetForIntent('summarize')
    )
    expect(outputTokenBudgetForIntent('answer')).toBeGreaterThan(
      outputTokenBudgetForIntent('summarize')
    )
  })
})

describe('createMinutesChunkPlan', () => {
  it('keeps a short transcript in one request', () => {
    const plan = createMinutesChunkPlan('Interviewer: Status?\nYou: On track.')

    expect(plan.requiresHierarchicalSummary).toBe(false)
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0].text).toContain('You: On track.')
  })

  it('splits a long transcript in order without dropping content', () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) => `Speaker ${index % 2}: item-${index.toString().padStart(3, '0')} ${'detail '.repeat(12)}`
    )
    const transcript = lines.join('\n')
    const plan = createMinutesChunkPlan(transcript, {
      maxTokensPerChunk: 256,
      charactersPerToken: 2
    })

    expect(plan.requiresHierarchicalSummary).toBe(true)
    expect(plan.chunks.length).toBeGreaterThan(1)
    plan.chunks.forEach((chunk, index) => {
      expect(chunk.index).toBe(index)
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(256)
    })
    const reconstructedLines = plan.chunks.flatMap((chunk) => chunk.text.split('\n'))
    expect(reconstructedLines).toEqual(lines.map((line) => line.trim()))
  })

  it('splits a single oversized line on safe boundaries', () => {
    const transcript = `Speaker: ${'one two three four five. '.repeat(100)}`
    const plan = createMinutesChunkPlan(transcript, {
      maxTokensPerChunk: 256,
      charactersPerToken: 1
    })

    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.every((chunk) => chunk.text.length <= 256)).toBe(true)
    expect(plan.chunks.map((chunk) => chunk.text).join(' ').replace(/\s+/g, ' ')).toBe(
      transcript.trim().replace(/\s+/g, ' ')
    )
  })

  it('handles empty input and produces a conservative estimate', () => {
    expect(createMinutesChunkPlan('  \r\n ')).toEqual({
      chunks: [],
      estimatedInputTokens: 0,
      requiresHierarchicalSummary: false
    })
    expect(estimateTextTokens('12345678')).toBe(2)
  })

  it('labels partial summaries for a deterministic final reduce request', () => {
    expect(formatMinutesPartials([' First ', 'Second'])).toBe(
      '--- Transcript section 1 summary ---\nFirst\n\n--- Transcript section 2 summary ---\nSecond'
    )
  })
})
