import {
  normalizeUpdateChannel,
  updateErrorMessage,
  type UpdateChannel,
  type UpdateStatus
} from '../shared/release'

export type UpdaterConfiguration = {
  channel: UpdateChannel
  allowDowngrade: boolean
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
}

export type UpdaterInfo = {
  version: string
}

export type UpdaterProgress = {
  percent: number
}

export type UpdaterEventHandlers = {
  checking: () => void
  available: (info: UpdaterInfo) => void
  notAvailable: (info: UpdaterInfo) => void
  progress: (info: UpdaterProgress) => void
  downloaded: (info: UpdaterInfo) => void
  error: (error: unknown) => void
}

export interface UpdaterAdapter {
  configure(configuration: UpdaterConfiguration): void
  subscribe(handlers: UpdaterEventHandlers): () => void
  checkForUpdatesAndNotify(): Promise<unknown>
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export type UpdateCoordinatorOptions = {
  enabled: boolean
  currentVersion: string
  channel?: UpdateChannel
  initialDelayMs?: number
  intervalMs?: number
  onStatus?: (status: UpdateStatus) => void
}

const DEFAULT_INITIAL_DELAY_MS = 30_000
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

export class UpdateCoordinator {
  private readonly channel: UpdateChannel
  private readonly onStatus?: (status: UpdateStatus) => void
  private readonly initialDelayMs: number
  private readonly intervalMs: number
  private status: UpdateStatus
  private mode: 'update' | 'rollback' = 'update'
  private activeCheck: 'update' | 'rollback' | null = null
  private started = false
  private unsubscribe: (() => void) | null = null
  private initialTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly adapter: UpdaterAdapter,
    private readonly options: UpdateCoordinatorOptions
  ) {
    this.channel = normalizeUpdateChannel(options.channel)
    this.onStatus = options.onStatus
    this.initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
    this.intervalMs = Math.max(60_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.status = {
      phase: options.enabled ? 'idle' : 'disabled',
      channel: this.channel,
      currentVersion: options.currentVersion
    }
  }

  get currentStatus(): UpdateStatus {
    return { ...this.status }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.adapter.subscribe({
      checking: () => {
        const mode = this.activeCheck ?? this.mode
        this.publish({ phase: mode === 'rollback' ? 'rollback-checking' : 'checking' })
      },
      available: (info) =>
        this.publish({
          phase: (this.activeCheck ?? this.mode) === 'rollback' ? 'rollback-available' : 'available',
          targetVersion: info.version,
          checkedAt: new Date().toISOString()
        }),
      notAvailable: () => {
        const mode = this.activeCheck ?? this.mode
        this.activeCheck = null
        if (mode === 'rollback') this.configure('update')
        this.publish({ phase: 'up-to-date', checkedAt: new Date().toISOString() })
      },
      progress: (info) =>
        this.publish({ phase: 'downloading', percent: Math.max(0, Math.min(100, info.percent)) }),
      downloaded: (info) => {
        this.publish({ phase: 'downloaded', targetVersion: info.version, percent: 100 })
        this.activeCheck = null
      },
      error: (error) => {
        const mode = this.activeCheck ?? this.mode
        this.activeCheck = null
        if (mode === 'rollback') this.configure('update')
        this.publish({ phase: 'error', message: updateErrorMessage(error) })
      }
    })

    if (!this.options.enabled) {
      this.publish({ phase: 'disabled', message: 'Updates run only in packaged Windows builds.' })
      return
    }

    this.configure('update')
    this.publish({ phase: 'idle' })
    this.initialTimer = setTimeout(() => void this.checkForUpdates(), this.initialDelayMs)
    this.initialTimer.unref?.()
    this.intervalTimer = setInterval(() => void this.checkForUpdates(), this.intervalMs)
    this.intervalTimer.unref?.()
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.initialTimer = null
    this.intervalTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.activeCheck = null
    this.started = false
  }

  async checkForUpdates(): Promise<boolean> {
    if (!this.beginCheck('update')) return false
    this.publish({ phase: 'checking', message: undefined, percent: undefined })
    try {
      await this.adapter.checkForUpdatesAndNotify()
      return true
    } catch (error) {
      this.activeCheck = null
      this.publish({ phase: 'error', message: updateErrorMessage(error) })
      return false
    }
  }

  async checkForRollback(): Promise<boolean> {
    if (!this.beginCheck('rollback')) return false
    this.publish({ phase: 'rollback-checking', message: undefined, percent: undefined })
    try {
      await this.adapter.checkForUpdates()
      return true
    } catch (error) {
      this.activeCheck = null
      this.configure('update')
      this.publish({ phase: 'error', message: updateErrorMessage(error) })
      return false
    }
  }

  async downloadUpdate(): Promise<boolean> {
    if (!this.options.enabled) return false
    try {
      await this.adapter.downloadUpdate()
      return true
    } catch (error) {
      this.publish({ phase: 'error', message: updateErrorMessage(error) })
      return false
    }
  }

  installDownloadedUpdate(): boolean {
    if (!this.options.enabled || this.status.phase !== 'downloaded') return false
    this.adapter.quitAndInstall()
    return true
  }

  private beginCheck(mode: 'update' | 'rollback'): boolean {
    if (
      !this.options.enabled ||
      this.activeCheck !== null ||
      this.status.phase === 'available' ||
      this.status.phase === 'rollback-available' ||
      this.status.phase === 'downloading' ||
      this.status.phase === 'downloaded'
    ) {
      return false
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    this.activeCheck = mode
    this.configure(mode)
    return true
  }

  private configure(mode: 'update' | 'rollback'): void {
    this.mode = mode
    const channel = mode === 'rollback' ? 'rollback' : this.channel
    this.adapter.configure({
      channel,
      allowDowngrade: mode === 'rollback',
      allowPrerelease: channel === 'beta',
      autoDownload: true,
      autoInstallOnAppQuit: true
    })
    this.status = { ...this.status, channel }
  }

  private publish(next: Partial<UpdateStatus>): void {
    this.status = {
      ...this.status,
      ...next,
      currentVersion: this.options.currentVersion
    }
    this.onStatus?.({ ...this.status })
  }
}
