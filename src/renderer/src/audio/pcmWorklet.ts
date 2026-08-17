// AudioWorklet processor that emits 16 kHz mono Int16 PCM in ~100 ms chunks.
// Loaded into the AudioWorklet thread via a Blob URL (see AudioCapture.ts), so it
// must be plain, self-contained classic-script JS with no imports.
export const pcmWorkletSource = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = []
    this._chunkSize = 1600 // ~100ms at 16 kHz
    this.port.onmessage = (event) => {
      const message = event.data
      if (message && message.type === 'flush' && typeof message.requestId === 'string') {
        this._emitBuffered()
        this.port.postMessage({ type: 'flushed', requestId: message.requestId })
      }
    }
  }

  _emitBuffered() {
    if (this._buffer.length === 0) return
    const pcm = new Int16Array(this._buffer)
    this._buffer = []
    this.port.postMessage(pcm, [pcm.buffer])
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0) {
      const ch0 = input[0]
      const channelCount = input.length
      const frames = ch0.length
      for (let i = 0; i < frames; i++) {
        let sample = ch0[i]
        if (channelCount > 1) {
          let sum = 0
          for (let c = 0; c < channelCount; c++) sum += input[c][i]
          sample = sum / channelCount
        }
        const clamped = Math.max(-1, Math.min(1, sample))
        this._buffer.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
      }
      if (this._buffer.length >= this._chunkSize) {
        this._emitBuffered()
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
`
