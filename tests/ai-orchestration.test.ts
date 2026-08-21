import { describe, expect, it } from 'vitest'
import type { ScreenshotContext } from '../src/shared/ai'
import {
  createAiAskRequest,
  createAiRequestId,
  isDirectedAtMe,
  looksLikeQuestion,
  selectLatestQuestion
} from '../src/renderer/src/views/overlay/aiOrchestration'

const screenshot: ScreenshotContext = {
  dataUrl: 'data:image/jpeg;base64,AA==',
  capturedAt: 1,
  width: 1,
  height: 1,
  detail: 'high'
}

describe('AI request orchestration', () => {
  it('creates deterministic, valid request identifiers', () => {
    expect(createAiRequestId(3, 7, 'answer')).toBe('3-7-answer')
  })

  it('attaches screenshots only to answer and analysis requests', () => {
    const messages = [{ role: 'user' as const, content: 'Help' }]

    expect(
      createAiAskRequest({ requestId: '1', intent: 'answer', messages, screenshot }).screenshot
    ).toBe(screenshot)
    expect(
      createAiAskRequest({ requestId: '2', intent: 'minutes', messages, screenshot }).screenshot
    ).toBeUndefined()
  })
})

describe('directed meeting questions', () => {
  it('does not answer an ordinary statement that only mentions the user', () => {
    expect(isDirectedAtMe('Gopi owns that task.', 'Gopi Kannan')).toBe(false)
  })

  it('recognizes a prompt after a leading name even without punctuation', () => {
    expect(isDirectedAtMe('Gopi can you explain the rollout plan', 'Gopi Kannan')).toBe(true)
  })

  it('recognizes a direct second-person question', () => {
    expect(isDirectedAtMe('What do you think about this proposal?', 'Gopi')).toBe(true)
  })

  it('does not answer a general question between other participants', () => {
    expect(isDirectedAtMe('What is the budget for this project?', 'Gopi')).toBe(false)
  })
})

describe('interview prompt detection', () => {
  it.each([
    'Design a URL shortener',
    'Implement an LRU cache',
    'Explain dependency injection',
    'Debug this concurrency problem',
    'Please optimise this query'
  ])('recognizes imperative prompt: %s', (prompt) => {
    expect(looksLikeQuestion(prompt)).toBe(true)
  })

  it('does not treat an ordinary statement as a prompt', () => {
    expect(looksLikeQuestion('We implemented the cache yesterday')).toBe(false)
  })

  it('selects only the newest prompt from a same-source discussion', () => {
    const lines = [
      { source: 'interviewer' as const, text: 'We discussed the database.' },
      { source: 'interviewer' as const, text: 'That migration finished yesterday.' },
      { source: 'interviewer' as const, text: 'Design a cache for this service' },
      { source: 'interviewer' as const, text: 'and explain its eviction policy.' }
    ]

    expect(selectLatestQuestion(lines, 0)).toBe(
      'Design a cache for this service and explain its eviction policy.'
    )
  })

  it('still finds the question once the candidate has started speaking', () => {
    // With the mic on, the candidate is usually already stalling by the time the
    // answer is due. Their lines must not hide the question we still owe.
    const lines = [
      { source: 'interviewer' as const, text: 'How do you handle backpressure in Kafka?' },
      { source: 'you' as const, text: 'Umm, sure, let me think about that.' }
    ]

    expect(selectLatestQuestion(lines, 0)).toBe('How do you handle backpressure in Kafka?')
  })

  it('has nothing to answer when only the candidate has spoken since the last answer', () => {
    const lines = [
      { source: 'interviewer' as const, text: 'Explain dependency injection' },
      { source: 'you' as const, text: 'It is about inverting construction of dependencies.' }
    ]

    expect(selectLatestQuestion(lines, 1)).toBe('')
  })

  it('does not re-answer a consumed question or a trailing ordinary statement', () => {
    const answered = [{ source: 'interviewer' as const, text: 'Explain dependency injection' }]
    expect(selectLatestQuestion(answered, answered.length)).toBe('')
    expect(
      selectLatestQuestion(
        [...answered, { source: 'interviewer' as const, text: "Thanks, that's all" }],
        answered.length
      )
    ).toBe('')
  })
})
