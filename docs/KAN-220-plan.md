# KAN-220: Show capture progress and errors in the popup

Ticket: https://prattsolutions.atlassian.net/browse/KAN-220. It is a To Do Story labelled `viewshot`, with no comments. It blocks KAN-213, and it is blocked by KAN-206, which is Done.

## What the repo does now

As of `fdb62c1`:

- **The worker answers every `capture` message at once.**
  - The branch at `background.js:11` calls `sendResponse(true)` before any work starts, then runs `runCapture(...).catch(captureFailed)`.
  - The comment above it (`background.js:4-9`) gives the reason. Region closes the popup, and while the worker cold-starts, a message whose sender closes in the same turn is lost.
- **A failure shows only as a badge.** `captureFailed` (`background.js:229-232`) logs the error and calls `flashBadge('!')`, which shows `!` for 3 s (`background.js:836-845`).
- **A success shows nothing.**
  - `saveCapture` (`background.js:1062-1069`) awaits `chrome.downloads.download` or `copyImage`.
  - `copyImage` (`background.js:785`) returns only once one of its contexts has answered `'done'`.
  - Nothing is sent to the popup afterwards.
- **Full page reports nothing while it runs.** The loop in `captureFullPage` (`background.js:374`) reads `m.total` again on each screen (`:399`) and steps by `m.vh` (`:508-509`). A page therefore takes `ceil(m.total / m.vh)` screens.
- **The popup:**
  - The screenshot branch (`popup.js:169-185`) awaits the ack, then closes the popup for Region only (`:185`). Nothing greys the buttons out, so a second press sends a second capture.
  - `toggleRec` (`popup.js:97-108`) greys the mode buttons out only before startup finishes, and for the recording formats.
  - `showError` (`popup.js:9`) fills the popup's only message box, `#err` (`popup.html:14`, styled at `popup.css:31`). It is used only for problems the popup finds before sending, and for a message that can't reach the worker.
  - The popup's `onMessage` listener (`popup.js:225`) handles only `shot-clipboard`.
- **Tests:** `npm test` runs 362 tests, and all pass.
  - `tests/region-dispatch.test.js:165` pins Region's synchronous ack.
  - "still runs the capture after acknowledging it" (`tests/region-dispatch.test.js:173-178`) sends a Visible capture.
  - The page harnesses in `tests/fullpage.test.js:119` and `tests/inner-scroller.test.js:36` have no `chrome.runtime.sendMessage`.

## Change

Eight files change: four code files and four test files. `README.md`, `manifest.json`, `package.json` and `offscreen.js` don't change.

1. **`background.js`:**
   - Region is still answered at once. Visible and Full page are answered once the capture has finished: `true`, or `{ error }` with the error text (`:4-11`).
   - Full page tells the popup which screen it is on (`:403`).

   ```diff
   @@ -1,14 +1,22 @@
   -// The `capture` branch answers synchronously, before it starts any work. The
   +// Region's `capture` is answered synchronously, before any work starts. The
    // popup closes itself on Region, and a sendMessage whose sender is torn down in
    // the same turn is dropped while the worker is cold-starting - the wake is
    // still in flight when the frame goes away, so the capture never runs at all. A
    // warm worker wins that race, which is why it only failed sometimes: the
    // "press Region twice" bug. The popup awaits this ack before window.close().
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
   -  if (msg?.type === 'capture') { sendResponse(true); runCapture(msg.mode, msg.opts, msg.tabId).catch(captureFailed); }
   +  if (msg?.type === 'capture' && msg.mode === 'region') { sendResponse(true); runCapture(msg.mode, msg.opts, msg.tabId).catch(captureFailed); }
   +  // Visible and Full page leave the popup open, so they are answered once the
   +  // image is saved or copied, or with the error text when the capture fails,
   +  // and the popup says which (KAN-220). The badge still flashes: the popup can
   +  // have been closed by then.
   +  else if (msg?.type === 'capture') {
   +    runCapture(msg.mode, msg.opts, msg.tabId).then(() => sendResponse(true), (e) => { captureFailed(e); sendResponse({ error: e.message || String(e) }); });
   +    return true;
   +  }
      else if (msg?.type === 'rec-start') {
   @@ -401,6 +409,10 @@
          if (i > 0 && actual <= landed) break;
          landed = actual;
   +      // Which screen this is, out of how many the page is now tall enough for,
   +      // for the popup (KAN-220). Not waited for, and nothing may be listening:
   +      // a shortcut's capture has no popup, and a popup can close mid-stitch.
   +      chrome.runtime.sendMessage({ type: 'capture-progress', screen: i + 1, screens: Math.max(i + 1, Math.ceil(m.total / m.vh)) }).catch(() => {});
          // The sticky elements that stick to the page, listed on the first slice
   ```

2. **`popup.js`:**
   - A `capturing` flag, with `toggleRec` greying out all three mode buttons while it is set (`:7`, `:97-108`).
   - A `showStatus` beside `showError`. Each hides the other's box (`:9`).
   - The screenshot branch shows "Capturing…", then "Saved.", "Copied to the clipboard." or the error text. Region still closes the popup after its ack (`:169-185`).
   - The listener shows `capture-progress` while this popup's own capture runs (`:225`).

   ```diff
   @@ -5,8 +5,11 @@
    let ready = false;
   +let capturing = false; // a Visible or Full page this popup sent hasn't been answered yet (KAN-220)
    
   -const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };
   +// One box at a time: an error, or how the capture is going.
   +const showError = (text) => { $('status').hidden = true; const e = $('err'); e.textContent = text; e.hidden = false; };
   +const showStatus = (text) => { $('err').hidden = true; const e = $('status'); e.textContent = text; e.hidden = false; };
   @@ -97,14 +100,15 @@
    // Record is greyed out too while a recording runs (Stop enabled): a second
   -// start would record over that one, and it would be lost.
   +// start would record over that one, and it would be lost. All three are
   +// greyed out while a capture this popup sent is running (KAN-220).
    function toggleRec() {
      ...
   -  vis.disabled = !ready || rec && !$('stopBtn').disabled;
   -  document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = !ready || rec; });
   +  vis.disabled = !ready || capturing || rec && !$('stopBtn').disabled;
   +  document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = !ready || capturing || rec; });
    }
   @@ -166,23 +170,33 @@
   +      // Visible and Full page leave the popup open, and the worker answers them
   +      // once the image is saved or copied, or with the error text when the
   +      // capture fails. The mode buttons stay greyed out until then (KAN-220):
   +      // a second press would run a second capture over this one.
   +      const shot = btn.dataset.mode !== 'region';
   +      if (shot) { capturing = true; toggleRec(); showStatus('Capturing…'); }
          await save();
          // Wait for the worker to acknowledge before closing anything. ...
   +      let res;
          try {
   -        await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, tabId: activeTab?.id, opts });
   +        res = await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, tabId: activeTab?.id, opts });
          } catch (e) {
            console.error('[ViewShot] capture message failed:', e);
   -        showError('Couldn’t reach the extension worker. Try again.');
   -        return; // keep the popup open so the error is visible
   +        res = { error: 'Couldn’t reach the extension worker. Try again.' };
   +      } finally {
   +        if (shot) { capturing = false; toggleRec(); }
          }
   +      if (res?.error) { showError(res.error); return; } // keep the popup open so the error is visible
   +      if (shot) showStatus(opts.toClipboard ? 'Copied to the clipboard.' : 'Saved.');
          // Region hands the page over to a drag. Left open, the popup covers the
          // dimmed overlay, holds the focus its Escape-to-cancel needs, and makes
          // the dimming look like a bug rather than a live selection.
   -      if (btn.dataset.mode === 'region') window.close();
   +      else window.close();
   @@ -223,6 +237,9 @@
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
   +  // How far a Full page has got (KAN-220). Only while this popup's own capture
   +  // runs: the worker sends it for a shortcut's capture too.
   +  if (msg?.type === 'capture-progress') { if (capturing) showStatus(`Capturing screen ${msg.screen} of ${msg.screens}…`); return; }
      if (msg?.type === 'shot-clipboard') {
   ```

3. **`popup.html`:** the status box, under the error box (`:14`).

   ```diff
      <div class="err" id="err" hidden></div>
   +  <div class="status" id="status" hidden></div>
   ```

4. **`popup.css`:** the status box has `.err`'s shape in greys the popup already uses (`:31`).

   ```diff
    .err { margin: 8px 0 0; padding: 7px 9px; background: #2a1414; border: 1px solid #e5534b; border-radius: 6px; color: #ff9b94; font-size: 12px; }
   +/* How a Visible or Full page capture is going, and that it was saved or copied (KAN-220). */
   +.status { margin: 8px 0 0; padding: 7px 9px; background: #1d1d1d; border: 1px solid #333; border-radius: 6px; color: #cfcfcf; font-size: 12px; }
   ```

5. **`tests/fullpage.test.js`:**
   - The harness gets a `sendMessage` that records what it is sent (`:69`, `:119`, `:134`).
   - Two tests go at the end: the progress on a 4-screen page, and a stitch that nobody is listening to still finishing.

   ```diff
   @@ -67,6 +67,7 @@
      const scriptCalls = [];
   +  const sent = []; // what the worker told the popup
   @@ -116,7 +117,7 @@
   -      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
   +      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async (m) => { sent.push({ ...m }); } }, // copy out of the vm realm
   @@ -132,7 +133,7 @@
   -  return { ctx: context, canvases, scriptCalls, captureAt, shownAt };
   +  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent };
   ```

   ```js
   // --- progress for the popup (KAN-220) --------------------------------------
   // A full page takes about a second a screen, and the popup showed nothing
   // while it ran. The worker now says which screen it is shooting, out of how
   // many the page is tall enough for.

   test('tells the popup which screen it is shooting, out of how many', async () => {
     const { ctx, sent } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
     await ctx.captureFullPage(TAB);
     assert.deepStrictEqual(sent, [1, 2, 3, 4].map((screen) => ({ type: 'capture-progress', screen, screens: 4 })));
   });

   test('finishes the stitch when nothing is listening for its progress', async () => {
     const { ctx, captureAt } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
     // A shortcut's capture, or a popup closed since: Chrome rejects the send.
     ctx.chrome.runtime.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
     await ctx.captureFullPage(TAB);
     assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200]);
   });
   ```

6. **`tests/inner-scroller.test.js`:** its harness gets a `sendMessage` too, because its stitches now send progress (`:36`).

   ```diff
   -      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } }, commands: ...
   +      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => {} }, commands: ...
   ```

7. **`tests/region-dispatch.test.js`:** "still runs the capture after acknowledging it" sends Region, the one capture still acknowledged before it runs (`:175`).

   ```diff
   -  listener({ type: 'capture', mode: 'visible', opts: {} }, {}, () => {});
   +  listener({ type: 'capture', mode: 'region', opts: {} }, {}, () => {});
   ```

8. **`tests/capture-errors.test.js`:** six tests at the end. They use the file's `loadBg` and `loadPopup`, whose `reply` can be left pending.

   ```js
   // --- the popup says how the capture went (KAN-220) --------------------------
   // Visible and Full page leave the popup open, but the worker answered as soon
   // as the message came in: a failure showed only as a ! for 3 seconds, a
   // success as nothing at all, and the buttons stayed live for a second press.

   const MODES = ['visible', 'fullpage', 'region'];

   test('a Visible capture from the popup is answered once the image is saved', async () => {
     const bg = loadBg();
     const order = [];
     bg.ctx.chrome.downloads.download = async () => { order.push('downloaded'); };
     const ret = bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id }, (v) => order.push(v));
     assert.strictEqual(ret, true, 'the port has to stay open for an answer that comes later');
     await settle();
     assert.deepStrictEqual(order, ['downloaded', true]);
   });

   test('a capture from the popup that fails is answered with its error text, and still flashes the badge', async () => {
     const bg = loadBg({ captureFails: () => 'Tabs cannot be edited right now' });
     const replies = [];
     bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id }, (v) => replies.push(JSON.parse(JSON.stringify(v)))); // copy out of the vm realm
     await settle();
     assert.deepStrictEqual(replies, [{ error: 'Tabs cannot be edited right now' }]);
     assert.deepStrictEqual(bg.badges, ['!'], 'the popup may have been closed by then');
   });

   test('the popup greys out the mode buttons and says it is capturing until the worker answers', async () => {
     let answer;
     const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
     await p.ready();
     const done = p.click('visible');
     await settle();
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [true, true, true], 'a second press would run a second capture over this one');
     assert.strictEqual(p.els.status.hidden, false);
     assert.strictEqual(p.els.status.textContent, 'Capturing…');
     answer(true);
     await done;
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
     assert.strictEqual(p.els.status.textContent, 'Saved.');
   });

   test('the popup says a copy was copied', async () => {
     const p = loadPopup('https://a.com/x', { store: { opts: { format: 'png', toClipboard: true } } });
     await p.ready();
     await p.click('visible');
     assert.strictEqual(p.els.status.textContent, 'Copied to the clipboard.');
   });

   test('the popup shows the error text of a capture that failed, and gives the buttons back', async () => {
     const p = loadPopup('https://a.com/x', { reply: { error: 'Full page stopped: another tab is now showing' } });
     await p.ready();
     await p.click('fullpage');
     assert.strictEqual(p.els.err.hidden, false);
     assert.strictEqual(p.els.err.textContent, 'Full page stopped: another tab is now showing');
     assert.strictEqual(p.els.status.hidden, true, 'still said it was capturing');
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
   });

   test('the popup shows which screen Full page is on, and only for its own capture', async () => {
     let answer;
     const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
     await p.ready();
     p.message({ type: 'capture-progress', screen: 1, screens: 3 }); // a shortcut's: this popup sent nothing
     assert.ok(!p.els.status || p.els.status.hidden, 'showed progress for a capture this popup never sent');
     const done = p.click('fullpage');
     await settle();
     p.message({ type: 'capture-progress', screen: 2, screens: 3 });
     assert.strictEqual(p.els.status.textContent, 'Capturing screen 2 of 3…');
     answer(true);
     await done;
     assert.strictEqual(p.els.status.textContent, 'Saved.');
   });
   ```

Choices:

- **The result is the answer to the popup's own `capture` message,** the way `rec-start` is answered once the start has worked or failed (`background.js:15-17`). It is not a broadcast, so only the popup that sent the capture gets it, even when a shortcut's capture runs at the same time.
- **Region is still answered at once.** It closes the popup, which is what the synchronous ack is for (`background.js:4-9`), and the ticket covers only Visible and Full page.
- **Progress is a broadcast, `capture-progress`, sent once per screen before that screen is shot.**
  - It isn't waited for, and a send that nobody receives is ignored, because a shortcut's capture has no popup.
  - The popup shows it only while its own capture runs.
- **The progress reads "screen N of M".**
  - M is worked out again on each screen from the page's current height, so a page that grows during the capture shows the new count.
  - M is never less than N.
  - Visible is one shot and shows only "Capturing…".
- **"Saved." comes once `chrome.downloads.download` has taken the file, and "Copied to the clipboard." once the copy has been written.** These are the points the worker already waits for (`background.js:1062-1069`). The popup chooses between the two from its own `toClipboard`.
- **The error text is the worker's own message, as it is,** in the existing red box. Some of those messages are Chrome's own wording, such as "Frame with ID 0 is showing error page".
- **The `!` badge still flashes,** because `captureFailed` doesn't change. The popup can have been closed by the time a capture fails.
- **"Couldn’t reach the extension worker. Try again." stays.** Now that the answer comes at the end, it also covers a worker that goes away mid-capture and closes the port.
- **All three mode buttons are greyed out from the press until the answer,** through `toggleRec`. A format change, or `rec` changing, during a capture can't enable them again. Stop and the options stay live, because the capture already has its settings.
- **One box at a time:** `showError` hides the status box and `showStatus` hides the error box. A new capture clears an old error.
- **The status box matches the popup's own style.** It copies `.err`'s shape, in greys `popup.css` already uses (`#1d1d1d`, `#333`, `#cfcfcf`).
- **No README change.** The README doesn't describe the popup's feedback, and `tests/readme.test.js` checks only permissions, shortcuts and formats.
- **No new files,** so the `package` script's file list stays as it is.
- **No version bump.**

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 362 tests.
  - **Test changes only:** 370 tests. 363 pass and 7 fail: the two worker-answer tests, "tells the popup which screen it is shooting, out of how many", and the four "the popup …" tests.
  - **Test changes plus `background.js`:** 366 pass, and only the four "the popup …" tests fail.
  - **Every change:** `npm test` passes all 370 tests.
- **Headed Chrome 153.0.8010.48, with the copy loaded unpacked.**
  - The script is `/tmp/vs387-chrome/run-220.js`, run on a local 4000 px page (ten 400 px bands). The viewport is 713 px at dpr 2.
  - Times are from the press, and the buttons are listed as Visible, Full page, Region (1 = greyed out).
  - **Full page:**
    - "Capturing…" at 0 ms.
    - "Capturing screen 1 of 6…" through "6 of 6…" at 79, 631, 1229, 1841, 2461 and 3039 ms.
    - "Saved." at 4383 ms.
    - The buttons were `111` until "Saved." and `000` after. The file was 2560×8000.
  - **Visible, same popup:** "Capturing…" at 0 ms and "Saved." at 107 ms. The file was 2560×1426.
  - **Visible with "Copy to clipboard" ticked:**
    - "Copied to the clipboard." at 218 ms, and nothing was downloaded.
    - The macOS clipboard held a PNG whose BMP rendering is 3,650,560 px, which is 2560×1426.
  - **Region:** unchanged. The popup closed after the ack, the overlay's two elements were on the page, and Escape removed them.
  - **Full page on a tab showing Chrome's error page** (`http://127.0.0.1:9/`, connection refused):
    - "Frame with ID 0 is showing error page" appeared in the red box at 79 ms, and the buttons came back.
    - The worker logged the same error, as before.
  - **Full page with no popup open** (what a shortcut runs, called in the worker as `runCapture('fullpage', …)`):
    - The file was saved at 2560×8000, and no badge showed.
    - There was no exception in the worker's console, so the progress messages nobody received were dropped quietly.

## Steps

1. Make the test changes above in `tests/fullpage.test.js`, `tests/inner-scroller.test.js`, `tests/region-dispatch.test.js` and `tests/capture-errors.test.js`.
   → verify: `npm test` runs 370 tests. 363 pass, and only these 7 fail:
   - "a Visible capture from the popup is answered once the image is saved"
   - "a capture from the popup that fails is answered with its error text, and still flashes the badge"
   - "tells the popup which screen it is shooting, out of how many"
   - "the popup greys out the mode buttons and says it is capturing until the worker answers"
   - "the popup says a copy was copied"
   - "the popup shows the error text of a capture that failed, and gives the buttons back"
   - "the popup shows which screen Full page is on, and only for its own capture"

   "finishes the stitch when nothing is listening for its progress" and "still runs the capture after acknowledging it" pass already.
2. Make the `background.js` change above.
   → verify: `npm test` runs 370 tests. 366 pass, and only the four "the popup …" tests fail.
3. Make the `popup.js`, `popup.html` and `popup.css` changes above.
   → verify: `npm test` passes all 370 tests.
4. Check the change in headed Chrome: `node /tmp/vs387-chrome/run-220.js --ext /Users/john/dev/viewshot --headful`. Its copy step writes a PNG to the macOS clipboard.
   → verify:
   - **Full page:**
     - The popup shows "Capturing…", "Capturing screen 1 of 6…" through "6 of 6…", then "Saved.".
     - The buttons are `111` until "Saved." and `000` after.
     - The file is 2560×8000.
   - **Visible:** "Capturing…", then "Saved.". The file is 2560×1426.
   - **Copy:** "Copied to the clipboard.", with no file downloaded and a 2560×1426 PNG on the clipboard.
   - **Region:** the popup closes and the overlay is up.
   - **The error page:** the worker's error text is in the red box, and the buttons come back.
   - **No popup:** the file is saved, with no badge and no exception in the worker's console.
   - Press Full page by hand on a long page to see how the status box looks; that part is for John.
5. Check that nothing else changed.
   → verify: `git status --short` lists only the eight files above and this plan.

## Open questions — settled

The plan left one question open and left one check to John (step 4). Both are settled here, and neither changes the code shipped in `102f235`.

1. **Should a popup opened while a capture is already running know about it?** Not as part of KAN-220.
   - The ticket is about the popup a capture was started from: "For Visible and Full page the popup stays open, but it never learns how the capture went." The second click it warns about is one in that popup, and it points to the overlapping-captures bug for the rest.
   - Refusing a second capture from anywhere is KAN-213 ("Allow only one capture at a time").
   - A popup opened mid-capture showing that capture is KAN-545, filed from this question.
   - This ticket blocks both.
2. **How the status box looks** (step 4 left this to John). Screenshots of the popup were taken in headed Chrome 153.0.8010.48 (`/tmp/vs387-chrome/run-220c.js`) on a local page 8000 px tall.
   - **During a Full page:** "Capturing screen 3 of 12…" fits on one line in the grey box under the mode buttons, which are dimmed.
   - **After it:** "Saved." is in the same box, and the buttons are at full strength again.
   - **On Chrome's error page:** the error is in the red box, which has the same shape and sits in the same place.
   - Like the red box, the grey box sits close above the Format row, because `.status` copies `.err`'s margins.

## Added when shipping

- **Two more tests**, for code no test in "Change" covered:
  - "counts the screens again when the page grows during the capture" in `tests/fullpage.test.js`.
    - The page is 2400 px tall until its first scroll and 4000 px after, so the count goes 1 of 3, then 2 of 5 through 5 of 5.
    - It fails when the count is worked out once, from the height before the first screen.
  - "the popup says so when a capture can't reach the worker, and gives the buttons back" in `tests/capture-errors.test.js`. It fails when the buttons are given back only when the worker answers.
- **Step 4, run on this folder:** the same results as in "Checked while planning". Full page showed "Saved." at 4279 ms, Visible at 126 ms, and the copy said "Copied to the clipboard." at 189 ms.
- **Not fixed here:** the open question is KAN-545, and Chrome's error page getting Chrome's own wording is KAN-546.
- `npm test` passes all 372.
