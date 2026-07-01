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
 *   2. Install dependencies (npm install).
 *   3. Repair the Electron binary (scripts/ensure-electron.mjs).
 *   4. Type-check the project (non-fatal — just a heads-up).
 *
 * Works on Windows / macOS / Linux. Designed to be safe behind a
 * corporate TLS-inspecting proxy (uses the system certificate store
 * on Node 22+).
 */
import { existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const nodeMajor = Number(process.versions.node.split('.')[0])

// On Node 22+ this makes Node trust the machine's certificate store, which is
// what corporate proxies inject their CA into. Harmless elsewhere.
const childEnv = { ...process.env }
if (nodeMajor >= 22) {
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
    shell: true
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
run('npm', ['install', '--no-audit', '--no-fund'])

// 3. Electron binary --------------------------------------------------------
step('Repairing Electron binary')
run(process.execPath, [join(here, 'ensure-electron.mjs')])

// 4. Type-check (informational) ---------------------------------------------
step('Type-checking')
run('npm', ['run', 'typecheck'], { fatal: false })

console.log('\nSetup complete. Start the app with:\n\n    npm run dev\n')
