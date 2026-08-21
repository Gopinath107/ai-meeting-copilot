import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseBuildMetadata, type BuildMetadata } from '../shared/release'

const MAX_BUILD_METADATA_BYTES = 64 * 1024

export function readPackagedBuildMetadata(resourcesPath: string): BuildMetadata | null {
  try {
    const file = join(resourcesPath, 'build-metadata.json')
    const stat = statSync(file)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BUILD_METADATA_BYTES) return null
    return parseBuildMetadata(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}
