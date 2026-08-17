import { describe, expect, it } from 'vitest'
import type { ScreenshotContext } from '../src/shared/ai'
import {
  createAiAskRequest,
  createAiRequestId,
  isDirectedAtMe
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
