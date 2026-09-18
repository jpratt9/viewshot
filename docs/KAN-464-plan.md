# Plan for KAN-464: A GIF whose encode never finishes is lost silently and keeps the offscreen document open for good

## Files to change

- `offscreen.js`

## Changes

1. **`offscreen.js` (inside `stopRecording`)**
   Add a timeout for `gif.js` encoding that resets on `start` and `progress` events, and aborts the encoder if no progress is made for 30 seconds. Listen for the `abort` event to tear down the recording and notify the worker.
   ```javascript
     if (format === 'gif') {
       if (rec.timer) clearInterval(rec.timer);
       let progressTimer;
       const onHang = () => { rec.gif.abort(); };
       const resetTimer = () => { clearTimeout(progressTimer); progressTimer = setTimeout(onHang, 30000); };
       rec.gif.on('start', resetTimer);
       rec.gif.on('progress', resetTimer);
       rec.gif.on('abort', () => {
         clearTimeout(progressTimer);
         saving--;
         onRecError(new Error('GIF encoding timed out or aborted'));
       });
       rec.gif.on('finished', (blob) => {
         clearTimeout(progressTimer);
         download(blob, filename);
       });
       resetTimer();
       rec.gif.render();
       // GIF frames are already captured into the worker, so the stream is no
       // longer needed and `rec` can be cleared synchronously here.
       stream.getTracks().forEach((t) => t.stop());
       rec = null;
     } else {
   ```
   **Verify:** Mock a hanging `gif.js` encoder in tests or manually that never fires `progress` or `finished`. Verify that after 30 seconds, `abort` is fired, `saving` goes down, and `onRecError` sends `rec-failed` to the worker.

## Open Questions

None. This directly addresses the silent hang by enforcing a strict timeout on encode progress, reusing the existing `onRecError` to safely tear down the document.
