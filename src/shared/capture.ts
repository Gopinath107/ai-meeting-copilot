export type DisplaySourceInfo = {
  id: string
  name: string
  displayId: string
  isPrimary: boolean
  isSelected: boolean
}

export type AudioStopResult = {
  timedOut: boolean
  waitedMs: number
  finalizedKinds: Array<'system' | 'mic'>
}

export type PickedDocs = {
  names: string[]
  text: string
  warnings: string[]
}
