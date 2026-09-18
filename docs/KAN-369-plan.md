# KAN-369: The offscreen document stays open after every recording until a clipboard copy closes it

Ticket: https://prattsolutions.atlassian.net/browse/KAN-369 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-371, is Done.

## What the repo does now

Line numbers are from `99cfe96`, with a clean working tree. The ticket's line numbers are from `e9c78e2`.

- **The offscreen document saves a recording with an `<a download>` and lets go of the file a minute later.**
  - `download` (`offscreen.js:290-297`) clicks an `<a download>` on a blob URL the document owns (`:292-295`).
  - 60 s later it revokes the URL and takes one off `saving` (`:296`). It does nothing after that.
  - GIF and video saves both go through it. A GIF is saved once gif.js fires `finished` (`:206`), and a video once the recorder's `stop` has fired (`:219-222`). `stopRecording` adds one to `saving` for each stop (`:202`).
  - The document answers `offscreen-busy` with `true` while a recording is running or `saving > 0` (`:20`).
- **Only a clipboard copy closes the document.**
  - `closeOffscreen` (`background.js:539-554`) returns while a recording is running (`:540-541`), or while the document answers `offscreen-busy` with `true` (`:549`). Otherwise it closes the document (`:550`).
  - The comment above it (`:534-538`) says to close the document the moment its work is finished.
  - Its only caller is `copyImage` (`:565`).
  - The worker's `stopRecording` (`:747-759`) removes `rec`, clears the badge and sends `rec-stop-offscreen` (`:755-757`). Nothing closes the document after that.
  - The worker's listener (`:10-38`) hears nothing from the document once a save is done.
- **Screenshots are saved through `chrome.downloads`** (`background.js:227`). Recordings aren't.
- **Tests:** `npm test` passes 291 tests.
  - **In `tests/offscreen-lifecycle.test.js`:**
    - `load()` (`:12-72`) fakes the offscreen API. Its `sendMessage` answers `'done'` to anything other than a ping or `offscreen-id` (`:22-29`).
    - `send` calls the worker's own message listener (`:66`).
    - KAN-211's test is at `:122-140`.
  - **In `tests/capture-errors.test.js`:**
    - `loadOffscreen` (`:493-551`) keeps every message the document sends in `sent` (`:519`), and holds its timers until `runTimers()` (`:538`, `:549`).
    - "an error from a normally stopped recorder leaves its save and replacement alone" (`:586-611`) runs the save's timer (`:603`), then asserts that the document has sent nothing (`:607`).
- **Seen in Chrome, not reproduced while planning:**
  - **The ticket, Chrome 152:** after a GIF was saved, the document was still open 65 s after its download started.
  - **Commit `e9c78e2`:** a clipboard capture 65 s after a GIF's download closed the document, and the GIF had been saved.

## Change

Four files change: `offscreen.js`, `background.js`, `tests/offscreen-lifecycle.test.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`offscreen.js`:** when `download` revokes the file's URL (`:296`), it also sends `rec-saved` to the worker.

   ```diff
   --- a/offscreen.js
   +++ b/offscreen.js
   @@ -293,7 +293,10 @@
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
   -  setTimeout(() => { URL.revokeObjectURL(url); saving--; }, 60000);
   +  // Once the download is done with the file, the worker can close this
   +  // document: nothing else does after a recording, and it shares its main
   +  // thread with the popup. The worker still asks offscreen-busy first.
   +  setTimeout(() => { URL.revokeObjectURL(url); saving--; chrome.runtime.sendMessage({ type: 'rec-saved' }); }, 60000);
    }
    
    // Release everything this document holds. The frame timer and the capture
   ```

2. **`background.js`:** on `rec-saved`, the listener calls `closeOffscreen` (after `:29`). It catches errors the way the branches next to it do (`:24`, `:28`).

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -27,6 +27,10 @@
      // that reports trouble with a recording that is finished.
      else if (msg?.type === 'rec-cap-hit') stopRecording().then((stopped) => { if (stopped) return flashBadge('MAX'); }).catch((e) => console.error('[ViewShot]', e));
      else if (msg?.type === 'rec-failed') recFailed();
   +  // A recording's file is saved and the document has let go of it. Nothing else
   +  // closes the document after a recording; closeOffscreen still leaves it to a
   +  // recording running in it, or another one still being saved.
   +  else if (msg?.type === 'rec-saved') closeOffscreen().catch((e) => console.error('[ViewShot]', e));
      // The popup reads `rec` from storage without waking the worker, so a leftover
      // key would go unnoticed for as long as the popup was the only thing running.
      // This message is what checks it for the popup: opening one is also the way a
   ```

3. **`tests/offscreen-lifecycle.test.js`:** three new tests after `:140`:
   - "closes the document once a stopped recording has been saved";
   - "a saved recording leaves the document to a recording still running in it";
   - "a saved recording leaves the document to another one still being saved in it".

   ```diff
   --- a/tests/offscreen-lifecycle.test.js
   +++ b/tests/offscreen-lifecycle.test.js
   @@ -139,6 +139,35 @@
      assert.strictEqual(calls.close, 1, 'the document outlived the recording it was saving');
    });
    
   +// Once the recording is saved, though, nothing closed the document: it stayed
   +// open until a clipboard copy closed it, and with that setting off, for good.
   +// The document now says when the download is done with the file, and the
   +// worker closes it then, through the same checks a copy's close goes through.
   +test('closes the document once a stopped recording has been saved', async () => {
   +  const { calls, docLives, send } = load({ hasDoc: true }); // Stop has removed `rec`
   +  send({ type: 'rec-saved' });
   +  await new Promise((r) => setImmediate(r));
   +  assert.strictEqual(calls.close, 1, 'the document outlived the recording it saved');
   +  assert.strictEqual(docLives(), false);
   +});
   +
   +test('a saved recording leaves the document to a recording still running in it', async () => {
   +  const { calls, docLives, send } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
   +  send({ type: 'rec-saved' });
   +  await new Promise((r) => setImmediate(r));
   +  assert.strictEqual(calls.close, 0, 'closing mid-recording would destroy the capture');
   +  assert.strictEqual(docLives(), true);
   +});
   +
   +test('a saved recording leaves the document to another one still being saved in it', async () => {
   +  const { ctx, calls, docLives, send } = load({ hasDoc: true });
   +  ctx.chrome.runtime.sendMessage = async (m) => (m.type === 'offscreen-busy' ? true : 'done');
   +  send({ type: 'rec-saved' });
   +  await new Promise((r) => setImmediate(r));
   +  assert.strictEqual(calls.close, 0, 'closing mid-save would lose the other recording');
   +  assert.strictEqual(docLives(), true);
   +});
   +
    // --- unless the browser or the extension ended it -----------------------------
    // `rec` is kept in chrome.storage.local so a recording outlives a worker
    // restart. It also outlived Chrome quitting and the extension reloading, which
   ```

4. **`tests/capture-errors.test.js`:**
   - **`:607`** now expects exactly one message, the first recording's `rec-saved`. There is still no `rec-failed`.
   - **A new section after `:1521`, with one test:** "a saved recording tells the worker once the download is done with the file". The document sends nothing until the file's URL is revoked, and then exactly one `rec-saved`.

   ```diff
   --- a/tests/capture-errors.test.js
   +++ b/tests/capture-errors.test.js
   @@ -604,7 +604,7 @@
      assert.strictEqual(busy(o), false);
      await o.ctx.startRecording('sid2', 'webm', 100, 100);
      first.fail(new Error('another late error'));
   -  assert.deepStrictEqual(o.sent, []);
   +  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-saved']); // the first recording's save, and no rec-failed
      assert.deepStrictEqual(stops, [1, 0]);
      assert.strictEqual(busy(o), true);
      assert.strictEqual(o.recorders[1].state, 'recording');
   @@ -1520,6 +1520,23 @@
      assert.strictEqual(busy(o), false, 'the document stayed busy after its file was saved');
    });
    
   +// --- a document left open after every recording -----------------------------
   +// Nothing closed the document once a recording was saved: it stayed open until
   +// a clipboard copy closed it, and with that setting off, for good. The document
   +// now tells the worker once the download is done with the file.
   +
   +test('a saved recording tells the worker once the download is done with the file', async () => {
   +  const o = loadOffscreen();
   +  await o.ctx.startRecording('sid', 'webm', 100, 100);
   +  o.ctx.stopRecording('out.webm');
   +  o.recorders[0].finish();
   +  await settle();
   +  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out.webm']);
   +  assert.deepStrictEqual(o.sent, [], 'the worker was told while the download still needed the file');
   +  o.runTimers(); // the file's URL is revoked
   +  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-saved'], 'nothing told the worker the document could be closed');
   +});
   +
    // --- a Stop while getUserMedia is still answering ---------------------------
    // The worker reads `rec` for the last time before it sends rec-start-offscreen,
    // so a Stop pressed after that could reach the offscreen document before its
   ```

Choices:

- **The document says when it's done, and the worker closes it.**
  - Only the document knows when its save is done. KAN-211 reasoned the same way.
  - The worker can't time the minute itself. Chrome stops an idle MV3 worker after 30 s, so a timer there would never fire.
- **The worker goes through `closeOffscreen`, so the document sends `rec-saved` every time.**
  - `closeOffscreen` already leaves the document to a recording running in it (`getRec`), and to another save still in it (`offscreen-busy`).
  - With two saves inside one minute, the first `rec-saved` gets `true` from `offscreen-busy` and leaves the document open. The second one closes it.
- **The message goes at the revoke, not at the click.**
  - KAN-211 made the revoke the end of the document's work, because closing the document revokes its URLs.
  - b7e90a7 left the document open because closing it mid-download could lose the file.
  - In `e9c78e2`'s check, a document was closed 65 s after a GIF's download, and the GIF was saved.
- **No `.catch` on the document's send.** Its other sends don't have one either (`offscreen.js:96`, `:152`, `:312`).
- **A `rec-saved` can close the document during work that `offscreen-busy` doesn't count:**
  - **A clipboard write.**
  - **A recording start,** between `ensureOffscreen` (`background.js:609`) and writing `rec` (`:617`). That start then records nothing, because its last `getRec` (`:641`) finds no document.
  - **Why it's left alone:** both windows are milliseconds wide, and `rec-saved` only comes 60 s after a save. Two clipboard copies that overlap already have the same race. Not handled here.
- **Recordings are still saved with `<a download>`.** See "Open questions".
- **No README, manifest or version change.**

## Steps

1. Make the `tests/offscreen-lifecycle.test.js` and `tests/capture-errors.test.js` changes above.
   → verify: `npm test` runs 295 tests. 292 pass, and the 3 tests under "Test changes only" fail with those messages. No other test fails.
2. Make the `offscreen.js` and `background.js` changes above.
   → verify: `npm test` passes all 295 tests.
3. Check the change in Chrome 153.0.8010.48, with "Copy to clipboard" off.
   - **Setup:** the one in step 4 of `docs/KAN-240-plan.md`:
     - `--headless=new`, with a disposable profile and `download.default_directory` set;
     - the repo loaded with `Extensions.loadUnpacked`;
     - the popup driven with `Extensions.triggerAction`;
     - a 1280×800 window.

     Record from the popup on an http page.
   - **Trace in the worker, over CDP:**
     - log the type of each message its listener gets;
     - log `chrome.offscreen.hasDocument()` every 5 s.

     The offscreen document already logs `downloading <name>` (`offscreen.js:291`).

   → verify each case:
   - **WebM, about 3 s, then Stop:**
     - `hasDocument()` stays `true` until the worker gets `rec-saved`, about 60 s after `downloading …webm`. It is `false` from the next poll on.
     - The `.webm` is saved, and `ffprobe` reads it as VP9 with frames in it.
   - **GIF, about 3 s, then Stop:** the same as WebM, and `ffprobe` reads frames from the `.gif`.
   - **The WebM case on the code as it is now,** for comparison: `hasDocument()` is still `true` 90 s after the download.
   - **A second recording inside the first one's minute:**
     1. Start a WebM about 30 s after the first download, and keep it running past the end of that minute.
     2. The first `rec-saved` reaches the worker while the second recording runs, and `hasDocument()` stays `true`.
     3. Stop it. Both files are saved, and the document closes about 60 s after the second download.
   - **A clipboard capture with no recording since the extension loaded:** it creates the document and closes it, as it does now.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `background.js`, `tests/offscreen-lifecycle.test.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

- **Should recordings be saved through `chrome.downloads` instead, which is the follow-up b7e90a7 names?**
  - This plan keeps `<a download>`. It closes the document when `download` lets go of the file, a minute after the download starts. That is where KAN-211 put the end of the document's work.
  - Saving through `chrome.downloads` could close the document as soon as Chrome has the file. It's a bigger change:
    - the document would hand the worker a blob URL;
    - the worker would download it and tell the document when to let go;
    - the `offscreen-busy` check would still be needed while a GIF encodes.
  - None of that was checked while planning. If KAN-369 means that change, this plan has to be redone.

## Checked while planning

On copies of the repo at `99cfe96` in `/tmp`:

- **As it is now:** `npm test` passes 291 tests.
- **Test changes only:** 295 tests run. 292 pass, and these 3 fail:

  | Test | Failure |
  |---|---|
  | "an error from a normally stopped recorder leaves its save and replacement alone" | "Expected values to be strictly deep-equal" at `:607`: `[]` against `['rec-saved']` |
  | "a saved recording tells the worker once the download is done with the file" | "nothing told the worker the document could be closed" |
  | "closes the document once a stopped recording has been saved" | "the document outlived the recording it saved" |

- **All the changes:** all 295 tests pass.
- **All the changes, with one piece put back:**

  | Piece put back | Tests that fail |
  |---|---|
  | The worker closes the document itself (`chrome.offscreen.closeDocument()`) instead of calling `closeOffscreen` | "a saved recording leaves the document to a recording still running in it" ("closing mid-recording would destroy the capture"), and "a saved recording leaves the document to another one still being saved in it" ("closing mid-save would lose the other recording") |
  | The document sends `rec-saved` at the click, not at the revoke | "a saved recording tells the worker once the download is done with the file" ("the worker was told while the download still needed the file") |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Noticed while planning, not changed

- **A GIF whose encode never finishes still keeps the document open for good.** gif.js has no error event, so `saving` never gets back to 0 and no `rec-saved` is sent. KAN-211's plan records this under "Choices".
