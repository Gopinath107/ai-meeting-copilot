#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function gitValue(args, fallback = 'unknown') {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || fallback
  } catch {
    return fallback
  }
}

function buildTime() {
  const sourceEpoch = Number(process.env.SOURCE_DATE_EPOCH)
  if (Number.isFinite(sourceEpoch) && sourceEpoch > 0) {
    return new Date(sourceEpoch * 1000).toISOString()
  }
  return new Date().toISOString()
}

function releaseChannel(version) {
  if (process.env.RELEASE_CHANNEL) return process.env.RELEASE_CHANNEL
  const prerelease = version.match(/-([0-9A-Za-z-]+)/)?.[1]
  return prerelease || 'latest'
}

const metadata = {
  schemaVersion: 1,
  appVersion: manifest.version,
  electronVersion: String(manifest.devDependencies?.electron ?? '').replace(/^[~^]/, ''),
  builtAt: buildTime(),
  commit: process.env.GITHUB_SHA || gitValue(['rev-parse', 'HEAD']),
  ref: process.env.GITHUB_REF_NAME || gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
  runId: process.env.GITHUB_RUN_ID || null,
  runNumber: process.env.GITHUB_RUN_NUMBER || null,
  channel: releaseChannel(manifest.version),
  buildPlatform: `${process.platform}-${process.arch}`,
  nodeVersion: process.version
}

const output = join(root, 'build', 'generated', 'build-metadata.json')
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
console.log(`[build-metadata] ${output}`)
