# Plan for KAN-469: A recording that fails, or is stopped before it starts, leaves the offscreen document open

## Files to change

- `background.js`

## Changes

1. **`background.js:598-600` (`recFailed`)**
   Chain `.finally(closeOffscreen)` to the returned promise so that a failed capture cleans up the document.
   ```javascript
   function recFailed() {
     return chrome.storage.local.remove('rec').then(() => flashBadge('!')).finally(closeOffscreen);
   }
   ```
   **Verify:** Start a capture, force it to fail (e.g., throwing in `getUserMedia` or `rec-failed`), and check that the offscreen document closes automatically after the `!` badge appears.

2. **`background.js:760-772` (`stopRecording`)**
   Call `closeOffscreen` at the end of the stop sequence, so that if a start was stopped before the document began recording (and thus won't send `rec-saved`), the document is closed.
   ```javascript
     await chrome.runtime.sendMessage({ type: 'rec-stop-offscreen', filename });
     closeOffscreen().catch((e) => console.error('[ViewShot]', e));
     return true;
   ```
   **Verify:** Start a capture and immediately stop it. Ensure the document closes when `rec-stop-offscreen` triggers an early return in the document.

3. **`background.js:21` (Popup `rec-start` listener)**
   Add a call to `closeOffscreen` inside the `recStartGate`'s `finally` block to catch starts that are stopped in the worker before they even reach the offscreen document.
   ```javascript
       recStartGate = start.catch(() => {}).finally(() => { recStartPending--; closeOffscreen().catch(e => console.error('[ViewShot]', e)); });
   ```
   **Verify:** A popup start that is stopped while still waiting for the tab's viewport size should close the offscreen document once the aborted start cleans up and `recStartPending` goes to 0.

4. **`background.js:72` (Shortcut `toggle-recording` listener)**
   Add the same `closeOffscreen` call inside the shortcut's `recStartGate`'s `finally` block.
   ```javascript
       recStartGate = start.catch(() => {}).finally(() => { recStartPending--; commandStartPending = false; closeOffscreen().catch(e => console.error('[ViewShot]', e)); });
   ```
   **Verify:** Similar to step 3, but using the keyboard shortcut to start and immediately stop the capture.

## Open Questions

None. The existing `closeOffscreen` method already safely checks if a recording is running (`getRec()`) or saving (`offscreen-busy`), meaning these extra calls will seamlessly do nothing when the document shouldn't be closed, while fixing the specific edge cases where it was left hanging.
