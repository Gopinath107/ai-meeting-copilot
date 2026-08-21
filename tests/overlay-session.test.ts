import { describe, expect, it } from 'vitest'
import {
  createSessionTrackingState,
  deleteTranscriptEntry,
  editTranscriptEntry,
  filterTranscriptEntries,
  formatTranscript,
  formatTranscriptExport,
  formatTranscriptTimestamp,
  mergeTranscriptForMinutes,
  sealTranscriptSourceForReconnect,
  speakerLabel,
  shouldMarkAiRangeHandled,
  transcriptExportFilename
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

  it('keeps a frozen speaker label when a new diarization stream reuses the index', () => {
    expect(
      speakerLabel(
        { source: 'interviewer', text: 'Old segment', speaker: 0, speakerName: 'Alice' },
        { 0: 'Bob' },
        true
      )
    ).toBe('Alice')
  })

  it('filters finalized lines by transcript text or participant label and keeps full indexes', () => {
    const lines = [
      { source: 'interviewer' as const, text: 'Budget review', speaker: 0 },
      { source: 'you' as const, text: 'I will follow up' },
      { source: 'interviewer' as const, text: 'Draft preview', provisional: true }
    ]

    expect(filterTranscriptEntries(lines, 'alice', { 0: 'Alice' }, true)).toEqual([
      { line: lines[0], index: 0 }
    ])
    expect(filterTranscriptEntries(lines, 'follow UP', { 0: 'Alice' }, true)).toEqual([
      { line: lines[1], index: 1 }
    ])
    expect(filterTranscriptEntries(lines, 'draft', { 0: 'Alice' }, true)).toEqual([])
  })

  it('edits and deletes finalized transcript entries immutably', () => {
    const lines = [
      { source: 'interviewer' as const, text: 'Original' },
      { source: 'you' as const, text: 'Pending', provisional: true }
    ]

    const edited = editTranscriptEntry(lines, 0, '  Corrected text  ')
    expect(edited).toEqual([
      { source: 'interviewer', text: 'Corrected text' },
      { source: 'you', text: 'Pending', provisional: true }
    ])
    expect(lines[0].text).toBe('Original')
    expect(editTranscriptEntry(lines, 0, '   ')).toBeNull()
    expect(editTranscriptEntry(lines, 1, 'Not allowed')).toBeNull()
    expect(deleteTranscriptEntry(lines, 0)).toEqual([
      { source: 'you', text: 'Pending', provisional: true }
    ])
    expect(deleteTranscriptEntry(lines, 1)).toBeNull()
  })

  it('formats timestamped text exports and safe deterministic filenames', () => {
    const timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime()

    expect(formatTranscriptTimestamp(timestamp)).toBe('03:04:05')
    expect(formatTranscriptTimestamp(Number.POSITIVE_INFINITY)).toBe('--:--:--')
    expect(
      formatTranscriptExport(
        [{ source: 'interviewer', text: 'Decision made', speaker: 0, timestampMs: timestamp }],
        { 0: 'Alice' },
        true
      )
    ).toBe('[03:04:05] Alice: Decision made')
    expect(transcriptExportFilename(true, timestamp)).toBe(
      'meeting-transcript_2026-01-02_03-04-05.txt'
    )
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

describe('ASR reconnect transcript sealing', () => {
  it('commits the old provisional line so a new socket cannot replace it', () => {
    expect(
      sealTranscriptSourceForReconnect(
        [{ source: 'interviewer', text: 'Old socket words', provisional: true, timestampMs: 10 }],
        'interviewer',
        '',
        20
      )
    ).toEqual([
      {
        source: 'interviewer',
        text: 'Old socket words',
        provisional: false,
        timestampMs: 10,
        bestEffort: true
      }
    ])
  })

  it('appends an unfinished interim tail without changing the other source', () => {
    expect(
      sealTranscriptSourceForReconnect(
        [{ source: 'you', text: 'Mic stays connected', provisional: true }],
        'interviewer',
        'System tail',
        25
      )
    ).toEqual([
      { source: 'you', text: 'Mic stays connected', provisional: true },
      { source: 'interviewer', text: 'System tail', timestampMs: 25, bestEffort: true }
    ])
  })
})
