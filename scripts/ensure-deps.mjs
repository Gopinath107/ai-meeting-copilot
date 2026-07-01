// Self-heal dependencies before `npm run dev`.
//
// This environment has an antivirus/EDR that intermittently deletes the whole
// `node_modules` folder. When that happens, `electron-vite dev` fails with
// "electron-vite is not recognized". This guard runs first: if the toolchain is
// missing it reinstalls; if only the Electron binary is missing it repairs that
// (fast, from the local cache). When everything is present it does nothing.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')
const toolchain = join(nm, 'electron-vite', 'package.json')
const electronExe = join(
  nm,
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv }
  })
  return r.status ?? 0
}

if (!existsSync(toolchain)) {
  console.log('[ensure-deps] node_modules missing or incomplete — running npm install...')
  const useSystemCa =
    Number(process.versions.node.split('.')[0]) >= 22 ? '--use-system-ca' : ''
  const code = run('npm', ['install', '--no-audit', '--no-fund'], {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${useSystemCa}`.trim()
  })
  process.exit(code)
} else if (!existsSync(electronExe)) {
  console.log('[ensure-deps] Electron binary missing — repairing from cache...')
  run(process.execPath, [join(root, 'scripts', 'ensure-electron.mjs')])
}
