import { join } from 'node:path'
import { Worker, type WorkerOptions } from 'node:worker_threads'

type DocxWorkerResponse =
  | { ok: true; text: string }
  | { ok: false; error: string }

export type DocxWorkerFactory = (scriptPath: string, options: WorkerOptions) => Worker

export interface DocxParseOptions {
  timeoutMs: number
  maxCharacters: number
  /** Test seam; production always uses Node's Worker implementation. */
  workerFactory?: DocxWorkerFactory
  /** Test seam; production resolves the worker emitted beside the main bundle. */
  workerPath?: string
}

function isDocxWorkerResponse(value: unknown): value is DocxWorkerResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DocxWorkerResponse>
  return (
    (candidate.ok === true && typeof candidate.text === 'string') ||
    (candidate.ok === false && typeof candidate.error === 'string')
  )
}

/**
 * Parse a DOCX in a disposable worker. Unlike Promise.race, timing out here
 * actually stops the safety scan, decompression, and Mammoth parsing work.
 */
export function extractDocxTextInWorker(
  archive: Buffer,
  options: DocxParseOptions
): Promise<string> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(new Error('DOCX parsing timeout must be a positive integer'))
  }
  if (!Number.isSafeInteger(options.maxCharacters) || options.maxCharacters <= 0) {
    return Promise.reject(new Error('DOCX character limit must be a positive integer'))
  }

  // Use a dedicated, exact-size ArrayBuffer so it can always be transferred.
  // Buffers backed by Node's shared pool can be marked as non-transferable.
  const transferableArchive = Uint8Array.from(archive)
  const workerFactory =
    options.workerFactory ?? ((path, workerOptions) => new Worker(path, workerOptions))
  const workerPath = options.workerPath ?? join(__dirname, 'docxWorker.js')

  let worker: Worker
  try {
    worker = workerFactory(workerPath, {
      workerData: {
        archive: transferableArchive.buffer,
        maxCharacters: options.maxCharacters
      },
      transferList: [transferableArchive.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    })
  } catch (error) {
    return Promise.reject(
      new Error(`Could not start the DOCX parser: ${(error as Error).message}`, { cause: error })
    )
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false

    const cleanup = (keepTerminationListeners = false): void => {
      clearTimeout(timer)
      worker.removeListener('message', onMessage)
      if (!keepTerminationListeners) {
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
      }
    }
    const rejectOnce = (error: Error, terminate: boolean): void => {
      if (settled) return
      settled = true
      cleanup(terminate)
      if (terminate) {
        // Reject only after Node confirms the runaway worker has stopped.
        void worker.terminate().then(
          () => {
            cleanup()
            reject(error)
          },
          (terminationError) => {
            cleanup()
            reject(
              new Error(`${error.message}; the parser worker could not be terminated`, {
                cause: terminationError
              })
            )
          }
        )
      } else {
        reject(error)
      }
    }
    const onMessage = (message: unknown): void => {
      if (!isDocxWorkerResponse(message)) {
        rejectOnce(new Error('DOCX parser returned an invalid response'), true)
        return
      }
      if (!message.ok) {
        rejectOnce(new Error(message.error), false)
        return
      }
      if (settled) return
      settled = true
      cleanup()
      // Enforce the cap again in the parent in case a future worker regresses.
      resolve(message.text.slice(0, options.maxCharacters))
    }
    const onError = (error: Error): void => {
      rejectOnce(new Error(`DOCX parser worker failed: ${error.message}`, { cause: error }), false)
    }
    const onExit = (code: number): void => {
      if (code !== 0) {
        rejectOnce(new Error(`DOCX parser worker exited unexpectedly (code ${code})`), false)
      } else {
        rejectOnce(new Error('DOCX parser worker exited without returning text'), false)
      }
    }

    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    const timer = setTimeout(() => {
      rejectOnce(new Error(`DOCX parsing timed out after ${options.timeoutMs} ms`), true)
    }, options.timeoutMs)
  })
}
