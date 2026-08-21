# Windows release and update operations

Production releases are created only by `.github/workflows/release.yml` from a stable tag matching the exact `package.json` version, for example `v1.2.3`.

## Required repository secrets

- `WIN_CSC_LINK`: base64-encoded or remotely hosted Windows code-signing certificate accepted by electron-builder.
- `WIN_CSC_KEY_PASSWORD`: certificate password.

The workflow refuses to build when either secret is absent, passes `forceCodeSigning=true`, and verifies both the packaged executable and NSIS installer with Windows Authenticode before creating the GitHub release. Build and publish run as separate least-privilege jobs: signing secrets are available only to the signed-build step, while the write-capable token is available only after the artifacts and checksums have been verified. The publish job uploads to a draft, verifies the complete asset list, and only then publishes it.

Each release contains the installer, blockmap, `latest.yml`, `build-metadata.json`, and `SHA256SUMS.txt`. The normal CI workflow also creates an unsigned Windows package as a short-lived test artifact; it cannot publish a release.

## Main-process updater integration

The updater coordinator is isolated and dependency-injected so its state machine can be tested without Electron globals. The main process creates it after `app.whenReady()` using this production-only gate:

```ts
const updates = createProductionUpdateCoordinator({
  enabled: app.isPackaged && process.platform === 'win32',
  currentVersion: app.getVersion(),
  channel: 'latest',
  onStatus: (status) => overlayWindow?.webContents.send('updates:status', status)
})

updates.start()
app.on('before-quit', () => updates.stop())
```

Every release/update IPC handler validates that the caller is the trusted overlay. The sandboxed preload exposes only build information, status events, check, emergency rollback check, download, and install actions; it never exposes the underlying `autoUpdater` object. Settings shows the installed version/build and permits an explicit check or restart after a signed update has downloaded. The emergency downgrade check is guarded by a separate two-click confirmation and succeeds only when the release workflow has published a verified rollback channel.

Packaged build information is available through `readPackagedBuildMetadata(process.resourcesPath)`. Development builds return `null` when the generated resource is absent or invalid.

## Emergency rollback

Run the `Prepare Signed Windows Rollback` workflow manually with an older published stable tag and the exact confirmation `ROLLBACK`. It verifies the older installer signature and publisher against the current release, checks that the manifest version/path/SHA-512 match that installer, generates independent rollback checksums, and attaches the verified older assets to the current release from a separate write-only publish job.

After an operator publishes the rollback channel, the user can open Settings and confirm **Emergency rollback**. This switches electron-updater to the dedicated `rollback` channel and enables downgrade only for that request. Normal scheduled checks reset to `latest` with downgrade disabled. Remove the rollback assets from the current GitHub release after the incident is resolved.

The GitHub channel implementation updates assets on the current release. If repository-level immutable releases are enabled, that emergency workflow will fail safely; publish a newly signed corrective version instead or move the rollback channel to a dedicated mutable update feed.

References: [Electron releases](https://releases.electronjs.org/), [electron-builder publishing](https://www.electron.build/publish/), [Windows code signing](https://www.electron.build/docs/features/code-signing/), and [electron-updater](https://www.electron.build/docs/features/auto-update/).
