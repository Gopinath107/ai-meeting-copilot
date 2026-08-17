import { inflateRawSync } from 'node:zlib'

const MAX_DOCX_ENTRIES = 2_000
const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024

type DocxArchiveEntry = {
  compressedBytes: number
  compressionMethod: number
  flags: number
  localHeaderOffset: number
}

type DocxArchiveDirectory = {
  directoryOffset: number
  entries: DocxArchiveEntry[]
}

function expandedLimitError(): Error {
  return new Error(
    `DOCX expands beyond the ${MAX_DOCX_EXPANDED_BYTES / 1024 / 1024} MB safety limit`
  )
}

function inspectDocxArchive(buffer: Buffer): DocxArchiveDirectory {
  const minimumEocdSize = 22
  if (buffer.length < minimumEocdSize) throw new Error('DOCX archive is incomplete')

  const earliestEocd = Math.max(0, buffer.length - minimumEocdSize - 0xffff)
  let eocdOffset = -1
  for (let offset = buffer.length - minimumEocdSize; offset >= earliestEocd; offset -= 1) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50 &&
      offset + minimumEocdSize + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset < 0) throw new Error('DOCX archive directory is missing')

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4)
  const directoryDisk = buffer.readUInt16LE(eocdOffset + 6)
  const diskEntryCount = buffer.readUInt16LE(eocdOffset + 8)
  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const directorySize = buffer.readUInt32LE(eocdOffset + 12)
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error('Multi-disk DOCX archives are not supported')
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 DOCX archives are not supported')
  }
  if (entryCount === 0 || entryCount > MAX_DOCX_ENTRIES) {
    throw new Error(`DOCX archive has too many entries (maximum ${MAX_DOCX_ENTRIES})`)
  }
  if (directoryOffset + directorySize > eocdOffset) {
    throw new Error('DOCX archive directory is malformed')
  }

  let cursor = directoryOffset
  let expandedBytes = 0
  const entries: DocxArchiveEntry[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directoryOffset + directorySize || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('DOCX archive entry is malformed')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    if ((flags & 0x41) !== 0) throw new Error('Encrypted DOCX archives are not supported')
    const compressionMethod = buffer.readUInt16LE(cursor + 10)
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`DOCX archive uses unsupported compression method ${compressionMethod}`)
    }
    const compressedBytes = buffer.readUInt32LE(cursor + 20)
    expandedBytes += buffer.readUInt32LE(cursor + 24)
    if (expandedBytes > MAX_DOCX_EXPANDED_BYTES) {
      throw expandedLimitError()
    }
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    entries.push({
      compressedBytes,
      compressionMethod,
      flags,
      localHeaderOffset: buffer.readUInt32LE(cursor + 42)
    })
    cursor += 46 + nameLength + extraLength + commentLength
    if (cursor > directoryOffset + directorySize) {
      throw new Error('DOCX archive entry exceeds its directory')
    }
  }
  if (cursor !== directoryOffset + directorySize) {
    throw new Error('DOCX archive directory size is inconsistent')
  }
  return { directoryOffset, entries }
}

/**
 * Reject ZIP64, encrypted, malformed, or oversized DOCX archives. Every entry
 * is actually inflated with a hard output cap so forged directory sizes cannot
 * bypass the aggregate expansion limit.
 */
export function assertSafeDocxArchive(buffer: Buffer): void {
  const { directoryOffset, entries } = inspectDocxArchive(buffer)
  let actualExpandedBytes = 0

  for (const entry of entries) {
    const localHeader = entry.localHeaderOffset
    if (
      localHeader + 30 > directoryOffset ||
      buffer.readUInt32LE(localHeader) !== 0x04034b50
    ) {
      throw new Error('DOCX archive local entry is malformed')
    }
    const localFlags = buffer.readUInt16LE(localHeader + 6)
    const localCompressionMethod = buffer.readUInt16LE(localHeader + 8)
    if ((localFlags & 0x41) !== 0) throw new Error('Encrypted DOCX archives are not supported')
    if (localCompressionMethod !== entry.compressionMethod || localFlags !== entry.flags) {
      throw new Error('DOCX archive headers are inconsistent')
    }

    const nameLength = buffer.readUInt16LE(localHeader + 26)
    const extraLength = buffer.readUInt16LE(localHeader + 28)
    const dataStart = localHeader + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedBytes
    if (dataStart > directoryOffset || dataEnd > directoryOffset || dataEnd < dataStart) {
      throw new Error('DOCX archive entry data is malformed')
    }

    if (entry.compressionMethod === 0) {
      actualExpandedBytes += entry.compressedBytes
    } else {
      const remainingBytes = MAX_DOCX_EXPANDED_BYTES - actualExpandedBytes
      try {
        const expanded = inflateRawSync(buffer.subarray(dataStart, dataEnd), {
          // Permit one extra byte so we can distinguish exact-limit output from
          // a stream that crosses the aggregate ceiling.
          maxOutputLength: remainingBytes + 1
        })
        actualExpandedBytes += expanded.byteLength
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw expandedLimitError()
        }
        throw new Error('DOCX archive entry could not be decompressed safely', { cause: error })
      }
    }
    if (actualExpandedBytes > MAX_DOCX_EXPANDED_BYTES) throw expandedLimitError()
  }
}
