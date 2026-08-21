#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { resolve, basename } from 'node:path'

const directory = resolve(process.argv[2] || 'dist')
const outputName = process.argv[3] || 'SHA256SUMS.txt'
const releaseFile = /(?:\.exe|\.blockmap)$/i
const metadataFile = /^(?:(?:latest|rollback)\.yml|build-metadata\.json)$/i

if (!existsSync(directory)) {
  console.error(`[checksums] Directory does not exist: ${directory}`)
  process.exit(1)
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const entries = await fs.readdir(directory, { withFileTypes: true })
const files = entries
  .filter((entry) => entry.isFile() && (releaseFile.test(entry.name) || metadataFile.test(entry.name)))
  .map((entry) => resolve(directory, entry.name))
  .sort((left, right) => basename(left).localeCompare(basename(right)))

if (files.length === 0) {
  console.error(`[checksums] No release artifacts found in ${directory}`)
  process.exit(1)
}

const lines = []
for (const file of files) lines.push(`${await sha256(file)}  ${basename(file)}`)
await fs.writeFile(resolve(directory, outputName), `${lines.join('\n')}\n`, 'utf8')
console.log(`[checksums] Wrote ${lines.length} entries to ${outputName}`)
