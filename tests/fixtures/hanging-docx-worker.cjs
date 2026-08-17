'use strict'

// Simulate a parser stuck in synchronous CPU/native work. The parent must use
// Worker.terminate(); posting a cancellation message cannot reach this loop.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
