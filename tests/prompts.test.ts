import { describe, expect, it } from 'vitest'
import type { SessionConfig } from '../src/renderer/src/App'
import {
  buildMeetingSystemPrompt,
  buildMinutesPrompt,
  buildSpeechKeyterms
} from '../src/renderer/src/views/overlay/prompts'

function meetingConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    mode: 'meeting',
    role: '',
    resumeText: '',
    jobDescription: '',
    docNames: [],
    docsText: '',
    userName: '',
    projectContext: '',
    techStack: '',
    ...overrides
  }
}

describe('meeting prompt scoping', () => {
  it('keeps a generic meeting neutral', () => {
    const prompt = buildMeetingSystemPrompt(meetingConfig(), false)

    expect(prompt).not.toContain('The company context is Optum')
    expect(prompt).not.toContain('Java 21')
    expect(prompt).not.toContain('GraphQL contract')
  })

  it('adds Optum and Java/GraphQL rules only in consultant mode', () => {
    const prompt = buildMeetingSystemPrompt(meetingConfig({ mode: 'consultant' }), true)

    expect(prompt).toContain('The company context is Optum')
    expect(prompt).toContain('Java 21')
    expect(prompt).toContain('GraphQL contract')
  })

  it('does not seed generic meetings with unrelated technical vocabulary', () => {
    expect(buildSpeechKeyterms(meetingConfig(), { meeting: true, consultant: false })).toEqual([])
    expect(
      buildSpeechKeyterms(meetingConfig({ techStack: 'Ruby, Rails' }), {
        meeting: true,
        consultant: false
      })
    ).toEqual(expect.arrayContaining(['Ruby', 'Rails']))
  })
})

describe('session recap scoping', () => {
  it('uses interview-specific recap sections instead of meeting minutes', () => {
    const prompt = buildMinutesPrompt({
      ...meetingConfig(),
      mode: 'interview'
    })

    expect(prompt).toContain('# Interview Recap')
    expect(prompt).toContain('## Questions Asked')
    expect(prompt).not.toContain('# Minutes of Meeting')
  })
})
