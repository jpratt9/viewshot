# Plan for KAN-495: A shortcut copy on a page whose main thread is blocked never finishes and keeps the offscreen document open

## What the code does now

- Step 2 of `copyImage` writes the image in the tab with a bare `chrome.scripting.executeScript` call (`background.js:581-593`). Every other injection goes through `scriptWithTimeout` (`background.js:218-223`); the only other `executeScript` call in the file is inside it, at `:220`.
- The page's scripts during a capture get `CAPTURE_SCRIPT_TIMEOUT_MS` (`background.js:161-170`). `cancelRegion` (`:489-494`) and `setScrollbarHidden` (`:455-477`) both pass it.
- On a page whose main thread never frees up, the `await` at `:581` never resolves:
  - Nothing is copied, no `!` flashes, and step 3 is never tried.
  - The `finally` at `:610-612` never runs, so `copiesPending` stays at 1 and `closeOffscreen` returns early at `:561` from then on.

## The change

Route step 2 through `scriptWithTimeout` with `CAPTURE_SCRIPT_TIMEOUT_MS`, the same deadline the capture's other page scripts get. The comment at `background.js:161-169` explains the choice:
- The bug is "forever", so any bound fixes it.
- A screenshot has no clock of its own to race.
- `SCRIPT_TIMEOUT_MS`'s 2 s exists only for a recording's stream id.

A timeout is a rejection, so the existing `.catch(() => null)` handles it the same way as a page that refuses the injection: the copy moves on to step 3. The offscreen document's write then fails for want of focus, and `copyImage` throws. From there the existing path takes over:
- `runCapture`'s caller runs `captureFailed`, which flashes `!` (`background.js:99`, `:229`).
- The `finally` drops `copiesPending` and runs `closeOffscreen`.

A page that frees up after the deadline still runs the write, because an injection can't be withdrawn. This is the same as the capture's other page scripts.

## Files to change

1. **`background.js:579-593`** (step 2 of `copyImage`): call `scriptWithTimeout` instead of `chrome.scripting.executeScript`, pass `CAPTURE_SCRIPT_TIMEOUT_MS`, and add a comment saying why.
   ```javascript
       // 2. Try the active tab
       // Fenced like every other page script: a page whose main thread never frees
       // up never runs it, and the copy stayed pending for good - no !, and
       // copiesPending held every later closeOffscreen off (KAN-495).
       if (tabId) {
         const tabRes = await scriptWithTimeout({
           target: { tabId },
           func: async (dataUrl) => {
             // ...unchanged...
           },
           args: [pngDataUrl]
         }, CAPTURE_SCRIPT_TIMEOUT_MS).catch(() => null);
   ```

2. **`tests/capture-errors.test.js`**: add one test after `'a cosmetic script that never answers does not hold up the shot'` (`:2029-2036`), in the section on pages whose main thread never frees up.
   - It uses `loadBg({ scriptHangs: true })` (`:21`, `:67`) and `expire()` (`:109`), which releases the held deadlines, the same way that section's other tests do.
   - Step 1 goes unanswered: `loadBg`'s `sendMessage` resolves `undefined`.
   - Step 3 is the offscreen document failing for want of focus.
   ```javascript
   // The clipboard write a shortcut's copy runs in the page was the one injection
   // left unfenced: the copy stayed pending for good, nothing was copied, no
   // badge said so, and copiesPending held every later closeOffscreen off (KAN-495).
   test('a copy whose tab write never runs fails, and lets the document close', async () => {
     const bg = loadBg({ scriptHangs: true });
     const closed = [];
     bg.ctx.chrome.offscreen = { hasDocument: async () => true, closeDocument: async () => { closed.push(true); } };
     bg.ctx.chrome.runtime.sendMessage = async (m) => {
       if (m.type === 'shot-clipboard-offscreen') return { error: "Failed to execute 'write' on 'Clipboard': Document is not focused." };
     };
     let failure;
     bg.ctx.copyImage(PNG, TAB.id).catch((e) => { failure = e; });
     await settle();
     assert.strictEqual(failure, undefined, 'gave up before the deadline');
     bg.expire(); // the tab write's deadline passes
     await settle();
     assert.match(String(failure), /not focused/, 'the copy never got past the tab');
     assert.strictEqual(vm.runInContext('copiesPending', bg.ctx), 0, 'the copy still counts as under way');
     assert.deepStrictEqual(closed, [true], 'the offscreen document was left open');
   });
   ```

## Steps

1. Add the test (2) before touching the code. → verify: `npm test` runs 305 tests, and the new test is the only failure. With no deadline to expire, the copy is still pending.
2. Change `background.js:581` and `:593`, and add the comment (1). → verify: `npm test` passes all 305.
3. Run `grep -n "chrome.scripting.executeScript" background.js`. → verify: the only match is inside `scriptWithTimeout` (`:220`).
4. Re-run the KAN-495 measurement in headless Chrome: `node /tmp/viewshot-copy-gaps.js`. It uses a PNG copy to the clipboard with scrollbar hiding off, runs the capture-visible shortcut's own call, and targets an http page stuck in `for (;;) {}`. → verify:
   - At ~40 s the copy is still pending: `cancelRegion`'s 30 s deadline has passed, and the tab write's 30 s deadline hasn't.
   - At ~80 s the copy has failed with `Document is not focused.` (step 3), `copiesPending` is 0, and the badge shows `!`.
   - `ensureOffscreen()` followed by `closeOffscreen()` now closes the document.
   - The unscriptable-page results (KAN-494) are unchanged.

## Open questions

None.
