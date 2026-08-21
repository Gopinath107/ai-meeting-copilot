import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AiWorkspace,
  type AiWorkspaceProps,
  type InterviewAiControls
} from '../src/renderer/src/views/overlay/AiWorkspace'

const noop = vi.fn()

function workspaceProps(overrides: Partial<AiWorkspaceProps> = {}): AiWorkspaceProps {
  return {
    meeting: false,
    activeTab: 'answer',
    activeIntent: 'answer',
    streaming: false,
    screenReady: false,
    autoAnalyze: false,
    autoAnswer: true,
    error: null,
    notice: null,
    question: 'How would you make this service resilient?',
    answerHistory: [],
    answer: 'Use timeouts, bounded retries, and idempotent operations.',
    analysisHistory: [],
    analysis: '',
    consultantHistory: [],
    consultant: '',
    onTabChange: noop,
    onToggleAutoAnalyze: noop,
    onToggleAutoAnswer: noop,
    onCancel: noop,
    onConsultScreen: noop,
    onAnalyze: noop,
    onAnswer: noop,
    onClearAnswers: noop,
    onClearAnalyses: noop,
    onClearConsultant: noop,
    ...overrides
  }
}

const interviewControls: InterviewAiControls = {
  answerStyle: 'detailed',
  pinnedAnswers: [
    {
      id: 'resilience',
      question: 'How would you make this service resilient?',
      answer: 'Use timeouts, bounded retries, and idempotent operations.',
      style: 'detailed'
    }
  ],
  onAnswerStyleChange: noop,
  onRegenerateExactQuestion: noop,
  onPinnedAnswerChange: noop
}

describe('AiWorkspace interview controls', () => {
  it('renders controlled style, exact regeneration, and pin state for interviews', () => {
    const html = renderToStaticMarkup(
      <AiWorkspace {...workspaceProps({ interviewControls })} />
    )

    expect(html).toContain('Answer style')
    expect(html).toContain('Detailed')
    expect(html).toContain('Regenerate')
    expect(html).toContain('Regenerate a detailed answer for this exact question')
    expect(html).toContain('Unpin')
    expect(html).toContain('Pinned (1)')
  })

  it('does not add interview-only controls to the meeting workspace', () => {
    const html = renderToStaticMarkup(
      <AiWorkspace {...workspaceProps({ meeting: true, interviewControls })} />
    )

    expect(html).not.toContain('Answer style')
    expect(html).not.toContain('for this exact question')
    expect(html).not.toContain('Pinned (1)')
  })

  it('regenerates at the selected style, not the style that produced the answer', () => {
    const html = renderToStaticMarkup(
      <AiWorkspace
        {...workspaceProps({
          interviewControls: {
            ...interviewControls,
            answerStyle: 'concise',
            currentAnswerStyle: 'detailed'
          }
        })}
      />
    )

    // The displayed answer was produced as 'detailed'; the selector now says
    // 'concise'. Regenerating is how a style change is applied to a question that
    // was already asked, so it must follow the selector.
    expect(html).toContain('Regenerate a concise answer for this exact question')
    expect(html).not.toContain('Regenerate a detailed answer')
  })

  it('keeps the streamed answer and history visible when a response fails', () => {
    const html = renderToStaticMarkup(
      <AiWorkspace
        {...workspaceProps({
          answerHistory: ['An earlier answer about retries.'],
          answer: 'Partial answer that was cut off mid-',
          error: 'The AI response reached its output-token limit and was cut off.'
        })}
      />
    )

    // A truncated response is usually most of a usable answer. The error belongs
    // beside it, never in place of it.
    expect(html).toContain('An earlier answer about retries.')
    expect(html).toContain('Partial answer that was cut off mid-')
    expect(html).toContain('reached its output-token limit')
  })
})
