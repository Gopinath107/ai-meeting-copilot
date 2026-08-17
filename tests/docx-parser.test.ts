import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { extractDocxTextInWorker, type DocxWorkerFactory } from '../src/main/docxParser'

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 1)
}

function fakeFactory(worker: FakeWorker): DocxWorkerFactory {
  return () => worker as unknown as Worker
}

describe('isolated DOCX parser', () => {
  it('terminates a real worker that cannot service the event loop', async () => {
    const startedAt = Date.now()
    const parsing = extractDocxTextInWorker(Buffer.from('untrusted docx'), {
      timeoutMs: 100,
      maxCharacters: 200_000,
      workerPath: resolve('tests/fixtures/hanging-docx-worker.cjs')
    })

    await expect(parsing).rejects.toThrow('DOCX parsing timed out after 100 ms')
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })

  it('forcibly terminates work before reporting a timeout', async () => {
    const worker = new FakeWorker()
    const parsing = extractDocxTextInWorker(Buffer.from('untrusted docx'), {
      timeoutMs: 10,
      maxCharacters: 200_000,
      workerFactory: fakeFactory(worker),
      workerPath: 'test-worker.js'
    })

    await expect(parsing).rejects.toThrow('DOCX parsing timed out after 10 ms')
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.listenerCount('message')).toBe(0)
    expect(worker.listenerCount('error')).toBe(0)
    expect(worker.listenerCount('exit')).toBe(0)
  })

  it('enforces the character cap again on worker responses', async () => {
    const worker = new FakeWorker()
    const parsing = extractDocxTextInWorker(Buffer.from('docx'), {
      timeoutMs: 1_000,
      maxCharacters: 4,
      workerFactory: fakeFactory(worker),
      workerPath: 'test-worker.js'
    })

    worker.emit('message', { ok: true, text: 'too long' })

    await expect(parsing).resolves.toBe('too ')
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('kills workers that return malformed protocol messages', async () => {
    const worker = new FakeWorker()
    const parsing = extractDocxTextInWorker(Buffer.from('docx'), {
      timeoutMs: 1_000,
      maxCharacters: 100,
      workerFactory: fakeFactory(worker),
      workerPath: 'test-worker.js'
    })

    worker.emit('message', { text: 'missing discriminator' })

    await expect(parsing).rejects.toThrow('invalid response')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
