#!/usr/bin/env node
/**
 * ensure-electron.mjs
 * ------------------------------------------------------------------
 * Self-healing repair for the Electron binary.
 *
 * Why this exists:
 * On some machines (especially behind a corporate TLS-inspecting proxy)
 * Electron's own postinstall (`install.js`) finishes WITHOUT extracting the
 * binary, leaving `node_modules/electron/dist/electron.exe` and `path.txt`
 * missing. electron-vite then fails with: "Error: Electron uninstall".
 *
 * This script makes setup automatic with no manual steps:
 *   1. If the Electron binary is already valid -> do nothing.
 *   2. Else find the cached download zip and extract it locally.
 *   3. Else trigger Electron's real downloader, then extract.
 *   4. Write `path.txt` so `require('electron')` resolves.
 *
 * It is safe to run repeatedly. A failed repair returns a non-zero exit code so
 * setup cannot claim success while leaving an unusable Electron installation.
 *
 * Runs on Windows / macOS / Linux.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const electronDir = join(projectRoot, 'node_modules', 'electron')

const log = (msg) => console.log(`[ensure-electron] ${msg}`)
const done = (code = 0) => process.exit(code)

if (!existsSync(electronDir)) {
  log('electron is not installed. Run "npm install" first.')
  done(1)
}

const version = JSON.parse(
  readFileSync(join(electronDir, 'package.json'), 'utf8')
).version

const platform = process.env.npm_config_platform || process.platform
const arch = process.env.npm_config_arch || process.arch

// Path of the executable INSIDE node_modules/electron/dist for each platform.
const exeRelative =
  platform === 'win32'
    ? 'electron.exe'
    : platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron'

const distDir = join(electronDir, 'dist')
const binPath = join(distDir, exeRelative)
const pathTxt = join(electronDir, 'path.txt')

function isHealthy() {
  try {
    if (!existsSync(pathTxt)) return false
    if (!existsSync(binPath)) return false
    const versionFile = join(distDir, 'version')
    if (existsSync(versionFile)) {
      const installed = readFileSync(versionFile, 'utf8').replace(/^v/, '').trim()
      if (installed !== version) return false
    }
    return true
  } catch {
    return false
  }
}

if (isHealthy()) {
  log(`Electron ${version} is already installed correctly.`)
  done()
}

log(`Electron ${version} binary missing for ${platform}-${arch}. Repairing...`)

// ---- Locate the cached download zip (@electron/get cache layout) ----------
function cacheRoot() {
  if (process.env.ELECTRON_CACHE) return process.env.ELECTRON_CACHE
  if (platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local')
    return join(base, 'electron', 'Cache')
  }
  if (platform === 'darwin') {
    return join(os.homedir(), 'Library', 'Caches', 'electron')
  }
  return join(os.homedir(), '.cache', 'electron')
}

const zipName = `electron-v${version}-${platform}-${arch}.zip`

function findCachedZip() {
  const root = cacheRoot()
  if (!existsSync(root)) return null
  // The zip lives either directly under the cache root or one hash-dir deep.
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        const candidate = join(full, zipName)
        if (existsSync(candidate)) return candidate
      } else if (entry === zipName) {
        return full
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  return null
}

// ---- Extraction (synchronous on purpose) -----------------------------------
// We unzip via the OS tool with spawnSync so this stays fully synchronous. An
// async library (e.g. extract-zip) under top-level await can leave the event
// loop with an unsettled promise and make Node exit early with code 13, which
// would fail `npm install`.
function extractWithSystem(zipPath) {
  try {
    if (platform === 'win32') {
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'Expand-Archive -LiteralPath $env:COPILOT_ELECTRON_ARCHIVE -DestinationPath $env:COPILOT_ELECTRON_DESTINATION -Force'
        ],
        {
          stdio: 'inherit',
          env: {
            ...process.env,
            COPILOT_ELECTRON_ARCHIVE: zipPath,
            COPILOT_ELECTRON_DESTINATION: distDir
          }
        }
      )
      return r.status === 0
    }
    if (platform === 'darwin') {
      const r = spawnSync('ditto', ['-x', '-k', zipPath, distDir], {
        stdio: 'inherit'
      })
      if (r.status === 0) return true
      // fall through to unzip
    }
    const r = spawnSync('unzip', ['-o', zipPath, '-d', distDir], {
      stdio: 'inherit'
    })
    return r.status === 0
  } catch (err) {
    log(`System unzip failed: ${err.message}`)
    return false
  }
}

function extract(zipPath) {
  log(`Extracting ${zipPath}`)
  return extractWithSystem(zipPath)
}

function finalize() {
  // electron's index.js reads path.txt to locate the binary.
  writeFileSync(pathTxt, exeRelative)
  if (isHealthy()) {
    log(`Electron ${version} repaired successfully.`)
    return true
  }
  return false
}

// ---- Main flow -------------------------------------------------------------
let zip = findCachedZip()

if (!zip) {
  // Nothing cached: ask Electron to download it the normal way, then re-scan.
  log('No cached download found. Running Electron downloader...')
  const extraNodeOptions =
    process.allowedNodeEnvironmentFlags.has('--use-system-ca') &&
    !/(?:^|\s)--use-system-ca(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')
    ? '--use-system-ca'
    : ''
  spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    cwd: electronDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${extraNodeOptions}`.trim(),
      ELECTRON_GET_USE_PROXY: 'true'
    }
  })
  if (isHealthy()) {
    log(`Electron ${version} installed via downloader.`)
    done()
  }
  zip = findCachedZip()
}

if (zip) {
  if (extract(zip)) {
    if (finalize()) done()
  }
}

log('')
log('Could not repair Electron automatically.')
log('Most likely the download is blocked by a network/proxy. Try one of:')
log('  • Re-run on a network that allows github.com / electronjs.org, or')
log('  • Set HTTPS_PROXY and re-run:  npm run setup, or')
log(`  • Manually place ${zipName} in: ${cacheRoot()} and re-run "npm run setup".`)
done(1)
