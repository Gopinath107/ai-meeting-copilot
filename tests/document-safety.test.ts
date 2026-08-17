import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { assertSafeDocxArchive } from '../src/main/documentSafety'

function singleEntryArchive(
  uncompressedBytes: number,
  flags = 0,
  data = Buffer.alloc(Math.min(uncompressedBytes, 1_024)),
  compressionMethod = 0
): Buffer {
  const localHeaderSize = 30
  const centralDirectorySize = 46
  const directoryOffset = localHeaderSize + data.byteLength
  const buffer = Buffer.alloc(directoryOffset + centralDirectorySize + 22)
  buffer.writeUInt32LE(0x04034b50, 0)
  buffer.writeUInt16LE(flags, 6)
  buffer.writeUInt16LE(compressionMethod, 8)
  buffer.writeUInt32LE(data.byteLength, 18)
  buffer.writeUInt32LE(uncompressedBytes, 22)
  data.copy(buffer, localHeaderSize)

  buffer.writeUInt32LE(0x02014b50, directoryOffset)
  buffer.writeUInt16LE(flags, directoryOffset + 8)
  buffer.writeUInt16LE(compressionMethod, directoryOffset + 10)
  buffer.writeUInt32LE(data.byteLength, directoryOffset + 20)
  buffer.writeUInt32LE(uncompressedBytes, directoryOffset + 24)
  buffer.writeUInt32LE(0, directoryOffset + 42)

  const eocd = directoryOffset + centralDirectorySize
  buffer.writeUInt32LE(0x06054b50, eocd)
  buffer.writeUInt16LE(1, eocd + 8)
  buffer.writeUInt16LE(1, eocd + 10)
  buffer.writeUInt32LE(centralDirectorySize, eocd + 12)
  buffer.writeUInt32LE(directoryOffset, eocd + 16)
  return buffer
}

describe('DOCX archive preflight', () => {
  it('accepts a bounded ordinary archive directory', () => {
    expect(() => assertSafeDocxArchive(singleEntryArchive(1_024))).not.toThrow()
  })

  it('rejects a compressed archive that claims excessive expanded size', () => {
    expect(() => assertSafeDocxArchive(singleEntryArchive(33 * 1024 * 1024))).toThrow(
      /expands beyond/i
    )
  })

  it('rejects encrypted and malformed archives before parsing', () => {
    expect(() => assertSafeDocxArchive(singleEntryArchive(1_024, 1))).toThrow(/Encrypted/)
    expect(() => assertSafeDocxArchive(Buffer.from('not a zip'))).toThrow(/incomplete|missing/)
  })

  it('rejects actual inflated output beyond the limit when directory sizes are forged', () => {
    const expanded = Buffer.alloc(33 * 1024 * 1024)
    const compressed = deflateRawSync(expanded)
    const archive = singleEntryArchive(1_024, 0, compressed, 8)

    expect(() => assertSafeDocxArchive(archive)).toThrow(/expands beyond/i)
  })
})
