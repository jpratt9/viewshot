# KAN-624 Plan

## Files to change

1. `offscreen.js`
   - **IndexedDB recovery block** (around line 369): Make the `onsuccess` callback for `store.getAllKeys()` an `async` function. 
   - When downloading the recovered left-over chunks, if `meta.format === 'webm'`, await `withDuration(chunks, chunks.length * 1000)` instead of creating a raw Blob. We estimate the duration by multiplying the number of saved chunks by 1000ms (the timeslice passed to `MediaRecorder.start`). For other formats, create a standard Blob as before.

## Steps

1. Modify the recovery logic in `offscreen.js` to asynchronously process WebM recordings with `withDuration` using the chunk-based heuristic.
   → verify: Add a test or run the existing tests to ensure `withDuration` is successfully called for a recovered WebM file. The test output should not throw an error and `recovered-shot.webm` should be successfully "downloaded" (or simulated in the test) with injected metadata.

## Open questions
None.
