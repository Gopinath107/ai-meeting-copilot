import { parentPort, workerData } from 'node:worker_threads'
import * as mammoth from 'mammoth'
import { assertSafeDocxArchive } from './documentSafety'

type DocxWorkerInput = {
  archive?: unknown
  maxCharacters?: unknown
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 2_000)
}

async function parseDocx(): Promise<void> {
  if (!parentPort) throw new Error('DOCX parser must run inside a worker thread')

  try {
    const input = workerData as DocxWorkerInput
    if (!(input.archive instanceof ArrayBuffer)) {
      throw new Error('DOCX parser received invalid archive data')
    }
    if (!Number.isSafeInteger(input.maxCharacters) || (input.maxCharacters as number) <= 0) {
      throw new Error('DOCX parser received an invalid character limit')
    }

    const archive = Buffer.from(input.archive)
    // Keep both the real expansion check and Mammoth inside the killable boundary.
    assertSafeDocxArchive(archive)
    const result = await mammoth.extractRawText({ buffer: archive })
    parentPort.postMessage({
      ok: true,
      text: result.value.slice(0, input.maxCharacters as number)
    })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: errorMessage(error) })
  } finally {
    parentPort.close()
  }
}

void parseDocx()
