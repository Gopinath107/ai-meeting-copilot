#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || ''
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

if (!stableVersion.test(manifest.version)) {
  console.error(`[release] package.json version must be a stable semantic version, got ${manifest.version}`)
  process.exit(1)
}

const expected = `v${manifest.version}`
if (tag !== expected) {
  console.error(`[release] Tag ${tag || '(missing)'} does not match package version ${expected}`)
  process.exit(1)
}

console.log(`[release] Verified ${tag}`)
