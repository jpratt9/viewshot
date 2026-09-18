# KAN-206: Copy to clipboard never works and fails silently

## Files to change

1. **`popup.js`**
   - **~line 43:** Add a `chrome.runtime.onMessage.addListener` to handle `shot-clipboard`. It should fetch the `dataUrl`, convert it to a blob, write to `navigator.clipboard`, and call `sendResponse('done')`. If it catches an error, it calls `sendResponse({ error: e.message })`.

2. **`offscreen.js`**
   - **line 24:** Modify the `shot-clipboard` message handler to catch errors from `copyToClipboard` and reply with `{ error: e.message }` instead of unconditionally replying `'done'`.
   - **line 29-36:** Remove the silent `catch` inside `copyToClipboard` so that it throws the error back to the listener.

3. **`background.js`**
   - **line 571-583:** Update `copyImage(pngDataUrl, tabId)` to first try messaging the popup with `shot-clipboard` (which has focus if open). If that fails, try injecting a script into `tabId` to do the copy (the tab has focus if the popup is closed). If both fail or are inaccessible, fall back to the existing `ensureOffscreen()` clipboard write, and explicitly `throw new Error(res.error)` if the offscreen document (or any context) returns an error.
   - **line 806:** Change `saveCapture` to pass `tab.id` to `copyImage(png, tab.id)`.

4. **`tests/offscreen-lifecycle.test.js`**
   - No direct changes needed, but ensure existing `copyImage` calls mock `tabId` correctly or the tests gracefully skip the tab injection step when no `tabId` is provided. The fallback to the offscreen document ensures the lifecycle tests remain valid.

## Steps

1. Update `popup.js` to handle `shot-clipboard`.
   → verify: The popup can receive and execute clipboard writes when open.
2. Update `offscreen.js` to return errors from `copyToClipboard`.
   → verify: `offscreen.js` no longer swallows the `NotAllowedError`.
3. Update `background.js` to try the popup and tab contexts, and throw returned errors.
   → verify: `copyImage` correctly bubbles errors to `saveCapture`, triggering the `!` badge on failure.
4. Run all unit tests to ensure `offscreen-lifecycle.test.js` still passes.
   → verify: `npm test` outputs 300 passing tests.

## Open Questions
- None.
