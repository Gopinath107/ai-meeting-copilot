import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import {
  UpdateCoordinator,
  type UpdateCoordinatorOptions,
  type UpdaterAdapter,
  type UpdaterConfiguration,
  type UpdaterEventHandlers
} from './updateCoordinator'

class ElectronUpdaterAdapter implements UpdaterAdapter {
  configure(configuration: UpdaterConfiguration): void {
    autoUpdater.channel = configuration.channel
    // Setting channel enables downgrade internally, so assign this after channel.
    autoUpdater.allowDowngrade = configuration.allowDowngrade
    autoUpdater.allowPrerelease = configuration.allowPrerelease
    autoUpdater.autoDownload = configuration.autoDownload
    autoUpdater.autoInstallOnAppQuit = configuration.autoInstallOnAppQuit
  }

  subscribe(handlers: UpdaterEventHandlers): () => void {
    const checking = (): void => handlers.checking()
    const available = (info: UpdateInfo): void => handlers.available({ version: info.version })
    const notAvailable = (info: UpdateInfo): void => handlers.notAvailable({ version: info.version })
    const progress = (info: ProgressInfo): void => handlers.progress({ percent: info.percent })
    const downloaded = (info: UpdateInfo): void => handlers.downloaded({ version: info.version })
    const error = (value: Error): void => handlers.error(value)

    autoUpdater.on('checking-for-update', checking)
    autoUpdater.on('update-available', available)
    autoUpdater.on('update-not-available', notAvailable)
    autoUpdater.on('download-progress', progress)
    autoUpdater.on('update-downloaded', downloaded)
    autoUpdater.on('error', error)

    return () => {
      autoUpdater.removeListener('checking-for-update', checking)
      autoUpdater.removeListener('update-available', available)
      autoUpdater.removeListener('update-not-available', notAvailable)
      autoUpdater.removeListener('download-progress', progress)
      autoUpdater.removeListener('update-downloaded', downloaded)
      autoUpdater.removeListener('error', error)
    }
  }

  checkForUpdatesAndNotify(): Promise<unknown> {
    return autoUpdater.checkForUpdatesAndNotify({
      title: 'Interview Copilot update ready',
      body: 'Restart the app to install the signed update.'
    })
  }

  checkForUpdates(): Promise<unknown> {
    return autoUpdater.checkForUpdates()
  }

  downloadUpdate(): Promise<unknown> {
    return autoUpdater.downloadUpdate()
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true)
  }
}

export function createProductionUpdateCoordinator(
  options: UpdateCoordinatorOptions
): UpdateCoordinator {
  return new UpdateCoordinator(new ElectronUpdaterAdapter(), options)
}
