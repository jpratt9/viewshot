# Plan for KAN-209: Region capture is lost if the selection takes longer than ~30 seconds

## Files to change

- `background.js`
- `tests/region-cancel.test.js`

## Changes

1. **`background.js`: Move `saveCapture` logic out of `runCapture`**
   Extract the clipboard and download logic from the end of `runCapture` into a separate `async function saveCapture(png, opts, tab)`. This allows both `runCapture` (for visible/fullpage) and the top-level listener (for resumed region captures) to share the exact same saving path.
   - Replace lines 227-232 with a call to `await saveCapture(png, opts, tab)`.

2. **`background.js`: Modify `runCapture` to exit early for region capture**
   In `runCapture`, when `mode === 'region'`, save the state (`tab`, `opts`) into `chrome.storage.session` as `pendingRegion`, call `captureRegion(tab)`, and `return` immediately (bypassing the `finally` block so `opts.hideScrollbar` stays active).
   - Lines 221: Change the region check to:
     ```javascript
     if (mode === 'region') {
       if (opts.hideScrollbar) { await setScrollbarHidden(tab, true); await sleep(50); }
       await chrome.storage.session.set({ pendingRegion: { tab, opts } });
       await captureRegion(tab);
       return;
     }
     ```

3. **`background.js`: Simplify `captureRegion` and `cancelRegion`**
   `captureRegion` no longer needs to wait on a Promise or use a temporary listener. It simply injects the region selection script. `cancelRegion` removes the `pendingRegion` from storage and restores the scrollbar if it was hidden.
   - Lines 463-490: Delete `cancelPendingRegion`. Update `captureRegion` to just call `scriptWithTimeout`. Update `cancelRegion` to clear `pendingRegion` from session storage and restore the scrollbar.

4. **`background.js`: Handle `shot-region` in the top-level listener**
   Add an `else if (msg?.type === 'shot-region')` block to the top-level `chrome.runtime.onMessage.addListener` (around line 30).
   - Read and remove `pendingRegion` from `chrome.storage.session`.
   - If `msg.rect` is present, capture the screen, crop it using an `OffscreenCanvas`, and pass the result to `saveCapture(png, opts, tab)`.
   - In a `finally` block, restore the scrollbar if `opts.hideScrollbar` was set.

5. **`tests/region-cancel.test.js`: Update tests to match the new architecture**
   Since `captureRegion` no longer returns a blocking Promise, tests that assert on the `abandoned` promise need to be updated. For example, verifying that an abandoned region is cleared now means checking that `chrome.storage.session.get('pendingRegion')` is empty after cancellation.

## Steps

1. Extract `saveCapture` from `runCapture`. → verify: Visible and Fullpage captures still save correctly.
2. Modify `runCapture`, `captureRegion`, and `cancelRegion` for session storage. → verify: Starting a region capture saves `{tab, opts}` to `chrome.storage.session`. Cancelling it clears it and restores the scrollbar.
3. Add `shot-region` handling to the top-level listener. → verify: Dragging a region completes the capture and saves the file.
4. Test worker suspension. → verify: Start a region capture, manually suspend the background worker in `chrome://serviceworker-internals`, then drag a region. The capture should still successfully encode and save.
5. Update `tests/region-cancel.test.js` to use `chrome.storage.session` for its assertions. → verify: `npm test` passes.

## Open Questions

None. This strictly implements the fix direction provided in the ticket using MV3 session storage and top-level listeners.
