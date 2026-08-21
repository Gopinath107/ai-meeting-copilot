import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isReleaseVersion,
  normalizeUpdateChannel,
  parseBuildMetadata,
  updateErrorMessage
} from '../src/shared/release'
import {
  UpdateCoordinator,
  type UpdaterAdapter,
  type UpdaterConfiguration,
  type UpdaterEventHandlers
} from '../src/main/updateCoordinator'
import { readPackagedBuildMetadata } from '../src/main/buildMetadata'

class FakeUpdater implements UpdaterAdapter {
  configurations: UpdaterConfiguration[] = []
  handlers: UpdaterEventHandlers | null = null
  updateChecks = 0
  rollbackChecks = 0
  downloads = 0
  installs = 0

  configure(configuration: UpdaterConfiguration): void {
    this.configurations.push(configuration)
  }

  subscribe(handlers: UpdaterEventHandlers): () => void {
    this.handlers = handlers
    return () => {
      this.handlers = null
    }
  }

  async checkForUpdatesAndNotify(): Promise<void> {
    this.updateChecks += 1
  }

  async checkForUpdates(): Promise<void> {
    this.rollbackChecks += 1
  }

  async downloadUpdate(): Promise<void> {
    this.downloads += 1
  }

  quitAndInstall(): void {
    this.installs += 1
  }
}

describe('release metadata', () => {
  it('validates build metadata without accepting malformed versions or dates', () => {
    const valid = {
      schemaVersion: 1,
      appVersion: '1.2.3',
      electronVersion: '43.4.0',
      builtAt: '2026-08-18T06:00:00.000Z',
      commit: 'abc123',
      ref: 'v1.2.3',
      runId: '10',
      runNumber: '20',
      channel: 'latest',
      buildPlatform: 'win32-x64',
      nodeVersion: 'v22.20.0'
    }

    expect(parseBuildMetadata(valid)).toEqual(valid)
    expect(parseBuildMetadata({ ...valid, electronVersion: '^43.4.0' })).toBeNull()
    expect(parseBuildMetadata({ ...valid, builtAt: 'not-a-date' })).toBeNull()
    expect(isReleaseVersion('2.0.0-beta.1')).toBe(true)
    expect(isReleaseVersion('v2.0.0')).toBe(false)
  })

  it('normalizes channels and update errors to safe defaults', () => {
    expect(normalizeUpdateChannel('rollback')).toBe('rollback')
    expect(normalizeUpdateChannel('unknown')).toBe('latest')
    expect(updateErrorMessage(new Error('network unavailable'))).toBe('network unavailable')
    expect(updateErrorMessage(null)).toBe('The update service failed.')
  })

  it('loads bounded packaged metadata and rejects invalid or oversized resources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'interview-copilot-release-'))
    const file = join(directory, 'build-metadata.json')
    const valid = {
      schemaVersion: 1,
      appVersion: '1.2.3',
      electronVersion: '43.4.0',
      builtAt: '2026-08-18T06:00:00.000Z',
      commit: 'abc123',
      ref: 'v1.2.3',
      runId: null,
      runNumber: null,
      channel: 'latest',
      buildPlatform: 'win32-x64',
      nodeVersion: 'v22.20.0'
    }

    try {
      writeFileSync(file, JSON.stringify(valid), 'utf8')
      expect(readPackagedBuildMetadata(directory)).toEqual(valid)
      writeFileSync(file, '{not-json', 'utf8')
      expect(readPackagedBuildMetadata(directory)).toBeNull()
      writeFileSync(file, 'x'.repeat(64 * 1024 + 1), 'utf8')
      expect(readPackagedBuildMetadata(directory)).toBeNull()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('update coordinator', () => {
  it('does not contact update services in an unpackaged build', async () => {
    const adapter = new FakeUpdater()
    const onStatus = vi.fn()
    const coordinator = new UpdateCoordinator(adapter, {
      enabled: false,
      currentVersion: '1.0.0',
      onStatus
    })

    coordinator.start()
    expect(await coordinator.checkForUpdates()).toBe(false)
    expect(await coordinator.checkForRollback()).toBe(false)
    expect(adapter.updateChecks).toBe(0)
    expect(adapter.rollbackChecks).toBe(0)
    expect(coordinator.currentStatus.phase).toBe('disabled')
    coordinator.stop()
  })

  it('maps update events and installs only a downloaded package', async () => {
    const adapter = new FakeUpdater()
    const coordinator = new UpdateCoordinator(adapter, {
      enabled: true,
      currentVersion: '1.0.0',
      initialDelayMs: 60_000,
      intervalMs: 60_000
    })

    coordinator.start()
    expect(await coordinator.checkForUpdates()).toBe(true)
    expect(adapter.configurations.at(-1)).toMatchObject({
      channel: 'latest',
      allowDowngrade: false,
      autoDownload: true
    })
    adapter.handlers?.available({ version: '1.1.0' })
    expect(coordinator.currentStatus).toMatchObject({ phase: 'available', targetVersion: '1.1.0' })
    expect(coordinator.installDownloadedUpdate()).toBe(false)
    adapter.handlers?.downloaded({ version: '1.1.0' })
    expect(coordinator.installDownloadedUpdate()).toBe(true)
    expect(adapter.installs).toBe(1)
    coordinator.stop()
  })

  it('uses a dedicated downgrade-enabled rollback channel', async () => {
    const adapter = new FakeUpdater()
    const coordinator = new UpdateCoordinator(adapter, {
      enabled: true,
      currentVersion: '2.0.0',
      initialDelayMs: 60_000,
      intervalMs: 60_000
    })

    coordinator.start()
    expect(await coordinator.checkForRollback()).toBe(true)
    expect(adapter.configurations.at(-1)).toMatchObject({
      channel: 'rollback',
      allowDowngrade: true,
      allowPrerelease: false
    })
    adapter.handlers?.available({ version: '1.9.0' })
    expect(coordinator.currentStatus).toMatchObject({
      phase: 'rollback-available',
      channel: 'rollback',
      targetVersion: '1.9.0'
    })
    coordinator.stop()
  })

  it('does not let a scheduled or manual update check interrupt a rollback check', async () => {
    const adapter = new FakeUpdater()
    const coordinator = new UpdateCoordinator(adapter, {
      enabled: true,
      currentVersion: '2.0.0',
      initialDelayMs: 60_000,
      intervalMs: 60_000
    })

    coordinator.start()
    expect(await coordinator.checkForRollback()).toBe(true)
    expect(await coordinator.checkForUpdates()).toBe(false)
    expect(adapter.rollbackChecks).toBe(1)
    expect(adapter.updateChecks).toBe(0)
    expect(adapter.configurations.at(-1)).toMatchObject({
      channel: 'rollback',
      allowDowngrade: true
    })

    adapter.handlers?.notAvailable({ version: '2.0.0' })
    expect(await coordinator.checkForUpdates()).toBe(true)
    expect(adapter.updateChecks).toBe(1)
    expect(adapter.configurations.at(-1)).toMatchObject({
      channel: 'latest',
      allowDowngrade: false
    })
    coordinator.stop()
  })
})
