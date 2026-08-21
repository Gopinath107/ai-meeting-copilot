// Self-heal dependencies before `npm run dev`.
//
// This environment has an antivirus/EDR that intermittently deletes the whole
// `node_modules` folder. When that happens, `electron-vite dev` fails with
// "electron-vite is not recognized". This guard runs first: if the toolchain is
// missing it reinstalls; if only the Electron binary is missing it repairs that
// (fast, from the local cache). When everything is present it does nothing.
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const requiredPackages = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {})
]
const electronExecutable =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron'
const electronExe = join(
  nm,
  'electron',
  'dist',
  electronExecutable
)
const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmCli = [process.env.npm_execpath, bundledNpmCli].find(
  (candidate) => candidate && existsSync(candidate)
)

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...extraEnv }
  })
  return r.status ?? 1
}

function runNpm(args, extraEnv = {}) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], extraEnv)
  if (process.platform !== 'win32') return run('npm', args, extraEnv)
  console.error('[ensure-deps] npm CLI could not be located. Reinstall Node.js with npm included.')
  return 1
}

function installedVersionMatchesLock(name) {
  try {
    const expected = lockfile.packages?.[`node_modules/${name}`]?.version
    if (typeof expected !== 'string' || !expected) return false
    const installed = JSON.parse(readFileSync(join(nm, name, 'package.json'), 'utf8')).version
    return installed === expected
  } catch {
    return false
  }
}

const dependenciesHealthy = existsSync(nm) && requiredPackages.every(installedVersionMatchesLock)

if (!dependenciesHealthy) {
  console.log('[ensure-deps] node_modules missing or incomplete — running npm ci...')
  const useSystemCa =
    process.allowedNodeEnvironmentFlags.has('--use-system-ca') &&
    !/(?:^|\s)--use-system-ca(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')
    ? '--use-system-ca'
    : ''
  const code = runNpm(['ci', '--no-audit', '--no-fund'], {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${useSystemCa}`.trim()
  })
  process.exit(code)
} else if (!existsSync(electronExe)) {
  console.log('[ensure-deps] Electron binary missing — repairing from cache...')
  const code = run(process.execPath, [join(root, 'scripts', 'ensure-electron.mjs')])
  process.exit(code)
}
