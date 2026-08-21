export const UPDATE_CHANNELS = ['latest', 'beta', 'rollback'] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'rollback-checking'
  | 'available'
  | 'rollback-available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export type UpdateStatus = {
  phase: UpdatePhase
  channel: UpdateChannel
  currentVersion: string
  targetVersion?: string
  percent?: number
  message?: string
  checkedAt?: string
}

export type BuildMetadata = {
  schemaVersion: 1
  appVersion: string
  electronVersion: string
  builtAt: string
  commit: string
  ref: string
  runId: string | null
  runNumber: string | null
  channel: string
  buildPlatform: string
  nodeVersion: string
}

export type ReleaseRuntimeInfo = {
  appVersion: string
  packaged: boolean
  build: BuildMetadata | null
}

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return UPDATE_CHANNELS.includes(value as UpdateChannel) ? (value as UpdateChannel) : 'latest'
}

export function parseBuildMetadata(value: unknown): BuildMetadata | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<BuildMetadata>
  if (
    candidate.schemaVersion !== 1 ||
    !isReleaseVersion(candidate.appVersion) ||
    !isReleaseVersion(candidate.electronVersion) ||
    typeof candidate.builtAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.builtAt)) ||
    typeof candidate.commit !== 'string' ||
    typeof candidate.ref !== 'string' ||
    (candidate.runId !== null && typeof candidate.runId !== 'string') ||
    (candidate.runNumber !== null && typeof candidate.runNumber !== 'string') ||
    typeof candidate.channel !== 'string' ||
    typeof candidate.buildPlatform !== 'string' ||
    typeof candidate.nodeVersion !== 'string'
  ) {
    return null
  }
  return candidate as BuildMetadata
}

export function updateErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return 'The update service failed.'
}
