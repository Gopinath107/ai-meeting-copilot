import { describe, expect, it } from 'vitest'
import {
  createSessionTrackingState,
  formatTranscript,
  mergeTranscriptForMinutes,
  shouldMarkAiRangeHandled
} from '../src/renderer/src/views/overlay/session'

describe('overlay session lifecycle', () => {
  it('creates clean tracking state for every new session', () => {
    const stale = createSessionTrackingState()
    stale.lastAnsweredCount = 42
    stale.lastAnalyzedCount = 31
    stale.summarizedUpto = 100
    stale.meetingSummary = 'old meeting'
    stale.turnHasQuestion = true

    expect(createSessionTrackingState()).toEqual({
      lastAnalyzedCount: 0,
      lastAnsweredCount: 0,
      summarizedUpto: 0,
      summarizeTarget: 0,
      turnHasQuestion: false,
      turnDirected: false,
      queuedInterviewQuestion: false,
      meetingSummary: '',
      summaryAccumulator: '',
      answerAccumulator: '',
      analysisAccumulator: '',
      consultantAccumulator: '',
      minutesAccumulator: ''
    })
  })

  it('only consumes an AI range after successful non-empty output', () => {
    expect(shouldMarkAiRangeHandled('done', 'answer')).toBe(true)
    expect(shouldMarkAiRangeHandled('done', '   ')).toBe(false)
    expect(shouldMarkAiRangeHandled('error', 'partial')).toBe(false)
    expect(shouldMarkAiRangeHandled('cancelled', 'partial')).toBe(false)
    expect(shouldMarkAiRangeHandled('timeout', 'partial')).toBe(false)
  })
})

describe('minutes transcript finalization', () => {
  it('keeps finalized lines and adds a distinct interim tail', () => {
    expect(
      mergeTranscriptForMinutes(
        [{ source: 'interviewer', text: 'Status update' }],
        { interviewer: 'What happens next?', you: '' }
      )
    ).toEqual([
      { source: 'interviewer', text: 'Status update', provisional: false },
      {
        source: 'interviewer',
        text: 'What happens next?',
        bestEffort: true,
        provisional: false
      }
    ])
  })

  it('does not overwrite a finalized utterance when a new interim starts similarly', () => {
    expect(
      mergeTranscriptForMinutes(
        [{ source: 'you', text: 'I will send' }],
        { interviewer: '', you: 'I will send the report today' }
      )
    ).toEqual([
      { source: 'you', text: 'I will send', provisional: false },
      {
        source: 'you',
        text: 'I will send the report today',
        bestEffort: true,
        provisional: false
      }
    ])
  })

  it('extends a line that was previously promoted from interim speech', () => {
    expect(
      mergeTranscriptForMinutes(
        [{ source: 'you', text: 'I will send', provisional: true }],
        { interviewer: '', you: 'I will send the report today' }
      )
    ).toEqual([
      {
        source: 'you',
        text: 'I will send the report today',
        provisional: false,
        bestEffort: true
      }
    ])
  })

  it('marks a best-effort tail in the transcript sent to minutes generation', () => {
    expect(
      formatTranscript(
        [{ source: 'interviewer', text: 'One last point', bestEffort: true }],
        {},
        true
      )
    ).toContain('[best-effort unfinalized tail]')
  })
})
