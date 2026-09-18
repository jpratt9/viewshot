# KAN-623 Plan

## Files to change

1. `background.js`
   - **`getRec()`** (around line 146): When abandoning a recording (`if (!has)`), it should trigger recovery by calling `ensureOffscreen().catch(e => console.error(e));` *without* `await` to prevent deadlock (since `ensureOffscreen` itself `await`s `getRec()`).
   - **`onStartup` and `onInstalled` listeners** (around lines 52-53): Change these from synchronous inline removals to async functions that first check if `rec` exists in `chrome.storage.local`. If it does, they call `ensureOffscreen().catch(...)` to trigger recovery. Then they await `chrome.storage.local.remove('rec')`.

## Steps

1. Modify `getRec()` to call `ensureOffscreen().catch(e => console.error(e))` when abandoning a recording state, without awaiting it.
   → verify: Start a recording, then abruptly close the offscreen document via DevTools. Re-opening the popup will invoke `getRec()`, which will identify the document is gone, fire off `ensureOffscreen()`, and correctly recover/download the file without deadlocking.
2. Modify `onStartup` and `onInstalled` listeners to check for `rec` before clearing it, and call `ensureOffscreen().catch(...)` if found.
   → verify: Start a recording, reload the unpacked extension to simulate a restart. The service worker restarts, hits `onInstalled`, sees the old `rec` in storage, calls `ensureOffscreen()`, and automatically downloads the recovered recording.

## Open questions
None.
