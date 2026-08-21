import { describe, expect, it } from 'vitest'
import {
  createInterviewAnswerRequest,
  createInterviewAnswerSnapshot,
  createProgressiveAnswerPlan,
  isSameInterviewAnswer,
  normalizeInterviewAnswerStyle
} from '../src/shared/interviewAnswer'

describe('progressive interview answer policy', () => {
  it('always emits an immediate three-point outline before the full answer', () => {
    const plan = createProgressiveAnswerPlan('How would you design a rate limiter?')

    expect(plan.stages.map((stage) => stage.kind)).toEqual(['outline', 'full'])
    expect(plan.stages[0]).toMatchObject({ kind: 'outline', pointCount: 3 })
    expect(plan.instruction).toContain('exactly three short, one-line bullets')
    expect(plan.instruction.indexOf('Quick outline')).toBeLessThan(
      plan.instruction.indexOf('Full answer')
    )
  })

  it('changes full-answer depth without changing the three-point outline contract', () => {
    const concise = createProgressiveAnswerPlan('Explain dependency injection', 'concise')
    const detailed = createProgressiveAnswerPlan('Explain dependency injection', 'detailed')

    expect(concise.stages[0]).toMatchObject({ kind: 'outline', pointCount: 3 })
    expect(detailed.stages[0]).toMatchObject({ kind: 'outline', pointCount: 3 })
    expect(concise.stages[1]).toMatchObject({ kind: 'full', targetWords: [80, 140] })
    expect(detailed.stages[1]).toMatchObject({ kind: 'full', targetWords: [350, 550] })
  })

  it('preserves the exact captured question for regeneration', () => {
    const question = '  Compare optimistic and pessimistic locking?  '
    const request = createInterviewAnswerRequest(question, 'detailed', 'regenerate')

    expect(request).toEqual({
      question,
      style: 'detailed',
      reason: 'regenerate',
      progressive: true
    })
  })

  it('asks a regeneration for a different angle instead of repeating itself', () => {
    const question = 'How would you scale this service?'
    const first = createProgressiveAnswerPlan(question, 'standard', 'answer')
    const again = createProgressiveAnswerPlan(question, 'standard', 'regenerate')

    expect(first.instruction).not.toContain('different angle')
    expect(again.instruction).toContain('different angle')
    // The regeneration still owes the same outline-then-answer contract.
    expect(again.instruction).toContain('exactly three short, one-line bullets')
  })

  it('rejects an empty question and normalizes an invalid persisted style', () => {
    expect(() => createInterviewAnswerRequest('   ', 'standard')).toThrow(
      'An interview question is required'
    )
    expect(normalizeInterviewAnswerStyle('verbose')).toBe('standard')
  })
})

describe('pinned interview answers', () => {
  it('creates snapshots only for completed question-answer pairs', () => {
    expect(createInterviewAnswerSnapshot('Question', '', 'standard')).toBeNull()
    expect(createInterviewAnswerSnapshot('', 'Answer', 'standard')).toBeNull()
    expect(createInterviewAnswerSnapshot('Question', 'Answer', 'concise')).toEqual({
      question: 'Question',
      answer: 'Answer',
      style: 'concise'
    })
  })

  it('matches the exact question and answer rather than only the question', () => {
    const pinned = { id: 'one', question: 'Why?', answer: 'First', style: 'standard' as const }

    expect(isSameInterviewAnswer(pinned, { question: 'Why?', answer: 'First', style: 'standard' })).toBe(
      true
    )
    expect(isSameInterviewAnswer(pinned, { question: 'Why?', answer: 'Second', style: 'standard' })).toBe(
      false
    )
  })
})
