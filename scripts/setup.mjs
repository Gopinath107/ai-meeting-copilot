#!/usr/bin/env node
/**
 * setup.mjs
 * ------------------------------------------------------------------
 * One command to get the project running on a brand-new machine:
 *
 *     npm run setup
 *
 * It performs every step automatically, with no manual fixes:
 *   1. Create .env from .env.example (if missing).
 *   2. Install the locked dependencies (`npm ci`).
 *   3. Repair the Electron binary (scripts/ensure-electron.mjs).
 *   4. Type-check the project (non-fatal — just a heads-up).
 *
 * Works on Windows / macOS / Linux. Designed to be safe behind a
 * corporate TLS-inspecting proxy (uses the system certificate store whenever
 * the installed Node runtime exposes that option).
 */
import { existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const supportsSystemCa = process.allowedNodeEnvironmentFlags.has('--use-system-ca')
const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmCli = [process.env.npm_execpath, bundledNpmCli].find(
  (candidate) => candidate && existsSync(candidate)
)

// Feature-detect system CA support instead of assuming every minor release of a
// Node major accepts the flag.
const childEnv = { ...process.env }
if (
  supportsSystemCa &&
  !/(?:^|\s)--use-system-ca(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')
) {
  childEnv.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --use-system-ca`.trim()
}

function step(title) {
  console.log(`\n=== ${title} ===`)
}

function run(command, args, { fatal = true } = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: childEnv,
    shell: false
  })
  if (result.status !== 0) {
    if (fatal) {
      console.error(`\nSetup failed at: ${command} ${args.join(' ')}`)
      process.exit(result.status || 1)
    }
    console.warn(`\nWarning: "${command} ${args.join(' ')}" reported problems (continuing).`)
    return false
  }
  return true
}

function runNpm(args, options) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], options)
  if (process.platform !== 'win32') return run('npm', args, options)
  console.error('npm CLI could not be located. Reinstall Node.js with npm included.')
  process.exit(1)
}

// 1. .env -------------------------------------------------------------------
step('Checking environment file (.env)')
const envFile = join(root, '.env')
const envExample = join(root, '.env.example')
if (!existsSync(envFile) && existsSync(envExample)) {
  copyFileSync(envExample, envFile)
  console.log('Created .env from .env.example. Open it and add your API keys.')
} else if (existsSync(envFile)) {
  console.log('.env already exists — leaving it untouched.')
} else {
  console.log('No .env.example found — skipping.')
}

// 2. Dependencies -----------------------------------------------------------
step('Installing dependencies')
runNpm(['ci', '--no-audit', '--no-fund'])

// 3. Electron binary --------------------------------------------------------
step('Repairing Electron binary')
run(process.execPath, [join(here, 'ensure-electron.mjs')])

// 4. Type-check (informational) ---------------------------------------------
step('Type-checking')
runNpm(['run', 'typecheck'], { fatal: false })

console.log('\nSetup complete. Start the app with:\n\n    npm run dev\n')
