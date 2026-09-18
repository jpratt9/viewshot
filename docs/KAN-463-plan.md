# KAN-463: Closing the offscreen document while a recording is starting leaves it recording nothing

Ticket: https://prattsolutions.atlassian.net/browse/KAN-463 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-369, is Done.

## What the repo does now

Line numbers are from `37a84d4`, with a clean working tree. They match the ticket's, which were taken from KAN-369's change before it was committed.

- **`closeOffscreen` (`background.js:543-558`) has two checks, and both run before its awaits finish.**
  - It returns if `getRec()` finds a recording (`:544-545`).
  - It returns if the document answers `offscreen-busy` with `true` (`:553`).
  - Otherwise it closes the document (`:554`).
  - The document answers `true` only while a recording is running or a stopped one is unsaved (`offscreen.js:20`).
- **A start uses the document before either check can see it.**
  - `startRecording` (`background.js:604-651`) calls `ensureOffscreen` (`:613`) and asks `offscreen-id` (`:618`). It writes `rec` only after that (`:621`).
  - The document sets its own `rec` only after `getUserMedia` answers (`offscreen.js:91`).
  - After a close in between, the start's last `getRec()` (`background.js:645`) finds no document. It forgets the recording, and the start returns without recording anything.
- **A clipboard copy uses the document before either check can see it.**
  - `copyImage` (`background.js:561-571`) calls `ensureOffscreen` (`:566`), waits on the `shot-clipboard` answer (`:567`), and calls `closeOffscreen` in its `finally` (`:569`).
  - The document doesn't count the write in `offscreen-busy` (`offscreen.js:20`, `:24`).
- **The worker already counts starts.**
  - `recStartPending` (`background.js:600`) counts every start from the moment the worker receives it until it has finished, cleanup included.
  - A popup start: `:14`, `:21`. The `toggle-recording` command: `:53`, `:72`.
  - Nothing counts copies.
- **Two things call `closeOffscreen`:** `copyImage`'s `finally` (`:569`), and `rec-saved` (`:33`).
- **Tests:** `npm test` passes 296 tests.
  - **`tests/capture-errors.test.js`:**
    - Recording starts are driven through `loadBg`, with `keepStore` (`:1338-1346`), `WEBM_START` (`:1212`) and `UNREACHABLE` (`:1213`).
    - KAN-369's section ends at `:1538`.
  - **`tests/offscreen-lifecycle.test.js`:** KAN-369's `rec-saved` tests are at `:142-183`.
  - No test closes the document during a start or a clipboard write.
- **Not reproduced in Chrome.** The ticket says so, and it wasn't reproduced while planning either.

## Change

Three files change: `background.js`, `tests/capture-errors.test.js` and `tests/offscreen-lifecycle.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`background.js`**
   - **New `copiesPending` count**, next to `copyImage` (`:560`). `copyImage` adds one before `ensureOffscreen` (`:566`), and takes it off in its `finally`, before its own `closeOffscreen` (`:569`).
   - **`closeOffscreen`** returns while `recStartPending` or `copiesPending` is above 0. The check sits right before `closeDocument` (`:554`), after every await.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -551,6 +551,11 @@
         // the document in between lost the recording, so ask it first. One that
         // can't answer has no recording in it.
         if ((await chrome.runtime.sendMessage({ type: 'offscreen-busy' }).catch(() => false)) === true) return;
   +    // Two uses of the document count as neither: a start, which writes `rec`
   +    // only after ensureOffscreen, and a clipboard copy waiting on its write.
   +    // Closing under a start left it recording nothing. Read after the awaits,
   +    // so one that began during them counts as well.
   +    if (recStartPending || copiesPending) return;
         await chrome.offscreen.closeDocument();
       } catch (e) {
         console.warn('[ViewShot] closeDocument failed:', e);
   @@ -558,14 +563,18 @@
    }
    
    // ---- clipboard via the offscreen document ----
   +// Copies still writing: from their ensureOffscreen until the document answers.
   +let copiesPending = 0;
    async function copyImage(pngDataUrl) {
      // The offscreen listener answers only after the clipboard write resolves, so
      // awaiting here means it is safe to tear the document down straight after.
      // A new document that never answered is closed too.
   +  copiesPending++;
      try {
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: 'shot-clipboard', dataUrl: pngDataUrl });
      } finally {
   +    copiesPending--;
        await closeOffscreen();
      }
    }
   ```

2. **`tests/capture-errors.test.js`:** a new section after KAN-369's (after `:1538`).
   - **A helper, `heldStart`:**
     - it gives the test a document that can be closed;
     - it holds a start past `ensureOffscreen`, at its `offscreen-id` question;
     - it can hold the document's `offscreen-busy` answer as well.
   - **"a close while a recording is starting leaves the start its document":**
     1. `rec-saved` arrives while the start is held.
     2. The document stays open.
     3. The start then records and keeps its `rec`.
   - **"a close already asking the document when a recording starts leaves the start its document":**
     1. `rec-saved` is waiting on `offscreen-busy` when the start arrives.
     2. The document stays open, and the start records.

   ```diff
   --- a/tests/capture-errors.test.js
   +++ b/tests/capture-errors.test.js
   @@ -1535,6 +1535,60 @@
      assert.deepStrictEqual(o.sent, [], 'the worker was told while the download still needed the file');
      o.runTimers(); // the file's URL is revoked
      assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-saved'], 'nothing told the worker the document could be closed');
   +});
   +
   +// --- a close while a recording is starting ----------------------------------
   +// A start writes `rec` only after ensureOffscreen, and the document has no
   +// recording of its own until the start reaches it, so closeOffscreen saw
   +// nothing in between. A close there - a clipboard copy finishing, or rec-saved
   +// - left the start writing `rec` against a document that was gone: REC came
   +// off, nothing was recorded, and no ! showed.
   +
   +// A document that can be closed, and a start held past ensureOffscreen: its
   +// offscreen-id question waits for answers.id(). holdBusy holds the document's
   +// offscreen-busy answer the same way, until answers.busy().
   +function heldStart(bg, { holdBusy = false } = {}) {
   +  const { chrome } = bg.ctx;
   +  const store = keepStore(chrome);
   +  const doc = { open: true, closes: 0 };
   +  chrome.offscreen = { hasDocument: async () => doc.open, closeDocument: async () => { doc.closes++; doc.open = false; } };
   +  const started = [];
   +  const answers = {};
   +  chrome.runtime.sendMessage = async (m) => {
   +    if (m.type === 'offscreen-id') return answers.id ? 'doc-1' : new Promise((r) => { answers.id = () => r('doc-1'); });
   +    if (m.type === 'offscreen-busy' && holdBusy) return new Promise((r) => { answers.busy = () => r(false); });
   +    if (m.type === 'rec-start-offscreen') { if (!doc.open) throw new Error(UNREACHABLE); started.push(m.streamId); }
   +  };
   +  return { store, doc, started, answers };
   +}
   +
   +test('a close while a recording is starting leaves the start its document', async () => {
   +  const bg = loadBg();
   +  const { store, doc, started, answers } = heldStart(bg);
   +  bg.message(WEBM_START, () => {});
   +  await settle(); // past ensureOffscreen, and `rec` not written yet
   +  bg.message({ type: 'rec-saved' }); // a recording's file let go meanwhile
   +  await settle();
   +  assert.strictEqual(doc.closes, 0, 'the document was closed under a recording that was starting');
   +  answers.id();
   +  await settle();
   +  assert.deepStrictEqual(started, ['sid'], 'the start recorded nothing');
   +  assert.strictEqual(store.rec?.url, TAB.url, 'the start was forgotten');
   +});
   +
   +test('a close already asking the document when a recording starts leaves the start its document', async () => {
   +  const bg = loadBg();
   +  const { doc, started, answers } = heldStart(bg, { holdBusy: true });
   +  bg.message({ type: 'rec-saved' }); // nothing is starting yet
   +  await settle(); // the close waits on offscreen-busy
   +  bg.message(WEBM_START, () => {});
   +  await settle(); // the start is past ensureOffscreen
   +  answers.busy(); // the document has nothing in it yet
   +  await settle();
   +  assert.strictEqual(doc.closes, 0, 'a close that began before the start closed the document under it');
   +  answers.id();
   +  await settle();
   +  assert.deepStrictEqual(started, ['sid'], 'the start recorded nothing');
    });
    
    // --- a Stop while getUserMedia is still answering ---------------------------
   ```

3. **`tests/offscreen-lifecycle.test.js`:** one new test after KAN-369's "a saved recording leaves the document to another one still being saved in it" (after `:169`).
   - The test: "a saved recording leaves the document to a clipboard write still under way in it".
   - `rec-saved` arrives while a copy waits on its write, and the document stays open.
   - Once the write is answered, the copy's own close shuts the document.

   ```diff
   --- a/tests/offscreen-lifecycle.test.js
   +++ b/tests/offscreen-lifecycle.test.js
   @@ -165,7 +165,29 @@
      send({ type: 'rec-saved' });
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(calls.close, 0, 'closing mid-save would lose the other recording');
   +  assert.strictEqual(docLives(), true);
   +});
   +
   +// A copy uses the document from its ensureOffscreen until the document answers
   +// the write, and the document doesn't count it: rec-saved in between closed
   +// the document under the write, and the copy failed.
   +test('a saved recording leaves the document to a clipboard write still under way in it', async () => {
   +  const { ctx, calls, docLives, send } = load();
   +  let answer;
   +  ctx.chrome.runtime.sendMessage = async (m) => {
   +    calls.sent.push(m);
   +    if (m.type === 'shot-clipboard') return new Promise((r) => { answer = r; });
   +    return m.type === 'offscreen-ping' ? 'pong' : 'done';
   +  };
   +  const copy = ctx.copyImage(PNG);
   +  await new Promise((r) => setImmediate(r)); // the write is under way
   +  send({ type: 'rec-saved' });
   +  await new Promise((r) => setImmediate(r));
   +  assert.strictEqual(calls.close, 0, 'closing mid-write would fail the copy');
      assert.strictEqual(docLives(), true);
   +  answer('done');
   +  await copy;
   +  assert.strictEqual(calls.close, 1, 'the copy left its document open');
    });
    
    // Nothing waits on the listener's close, so a failure in it is only ever seen
   ```

Choices:

- **The worker counts this work, not the document.**
  - A start uses the document from `ensureOffscreen` on, and a copy uses it before its message has arrived. The document can't know about either yet.
  - The counts live in the worker's memory, and so do the start and the copy. A restart ends all of them together, so a count can't outlive its work the way a flag in storage could.
- **Starts reuse `recStartPending`.**
  - It already counts every start from the moment the worker receives it until cleanup is done.
  - That is more than the window between `ensureOffscreen` and the `rec` write. Outside that window, `getRec` already keeps the document open, or no document is needed yet.
- **Copies get a new count, `copiesPending`, kept the same way as `recStartPending`.**
  - It comes off before the copy's own `closeOffscreen`, so a lone copy still closes its document. Existing tests pin that (see "Checked while planning").
- **The check sits right before `closeDocument`, not at the top of `closeOffscreen`.**
  - Nothing is awaited between the check and the close.
  - A close that was already waiting on `getRec`, `hasDocument` or `offscreen-busy` when a start or copy began still sees it.
  - Checking only at the top missed that case (see the table below).
- **Counting copies also keeps one copy's close from closing the document under another copy's write.**
  - The ticket leaves overlapping copies to KAN-213.
  - This follows from counting copies at all. It doesn't cover a copy whose `ensureOffscreen` hasn't started yet when the other copy closes the document.
- **`offscreen.js` doesn't change.**
- **No README, manifest or version change.**

## Steps

1. Make the `tests/capture-errors.test.js` and `tests/offscreen-lifecycle.test.js` changes above.
   → verify: `npm test` runs 299 tests. 296 pass, and the 3 tests under "Test changes only" fail with those messages. No other test fails.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 299 tests.
3. Check the change in Chrome 153.0.8010.48.
   - **Setup:** the one in step 4 of `docs/KAN-240-plan.md`:
     - `--headless=new`, with a disposable profile and `download.default_directory` set;
     - the repo loaded with `Extensions.loadUnpacked`;
     - the popup driven with `Extensions.triggerAction`;
     - a 1280×800 window.

     The page is an http page.
   - **Holding the window open:**
     - Over CDP, wrap `chrome.runtime.sendMessage` in the worker so that a chosen message type waits 2 s before it goes out.
     - While it waits, run `closeOffscreen()` in the worker, as a clipboard copy finishing or `rec-saved` would.
     - Log `chrome.offscreen.hasDocument()` after the close.

   → verify each case:
   - **A WebM start, holding `offscreen-id`:**
     - `hasDocument()` stays `true` through the close.
     - The recording starts. Stop it after about 3 s.
     - The `.webm` is saved, and `ffprobe` reads it as VP9 with frames in it.
   - **The same on `37a84d4`,** for comparison:
     - the document is closed, and REC comes off the badge;
     - the worker warns "stopped before the recorder started";
     - no `.webm` is saved.
   - **A Visible capture with "Copy to clipboard" on, holding `shot-clipboard`:**
     - `hasDocument()` stays `true` through the close.
     - The copy gets its answer, and no `!` shows.
     - `hasDocument()` is `false` after the copy.
   - **The same on `37a84d4`:** the document is closed under the write, and the badge flashes `!`.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js`, `tests/offscreen-lifecycle.test.js` and this plan.

## Open questions

None. The ticket names both windows, what can close the document in them, and what goes wrong.

## Checked while planning

On copies of the repo at `37a84d4` in `/tmp`:

- **As it is now:** `npm test` passes 296 tests.
- **Test changes only:** 299 tests run. 296 pass, and these 3 fail:

  | Test | Failure |
  |---|---|
  | "a close while a recording is starting leaves the start its document" | "the document was closed under a recording that was starting" |
  | "a close already asking the document when a recording starts leaves the start its document" | "a close that began before the start closed the document under it" |
  | "a saved recording leaves the document to a clipboard write still under way in it" | "closing mid-write would fail the copy" |

- **All the changes:** all 299 tests pass.
- **All the changes, with one piece put back:**

  | Piece put back | Tests that fail |
  |---|---|
  | Starts not counted: the check reads only `copiesPending` | both new start tests, with the messages above |
  | The check at the top of `closeOffscreen` instead of right before `closeDocument` | "a close already asking the document when a recording starts leaves the start its document" |
  | Copies not counted: the check reads only `recStartPending` | "a saved recording leaves the document to a clipboard write still under way in it" |
  | `copiesPending--` after the copy's own `closeOffscreen` instead of before it | 9 tests, every copy that should close its document: "closes the offscreen document after a clipboard copy", "still closes the document when the clipboard write rejects", "closes a new document that never answers, and fails the copy", "waits for the clipboard write to be acknowledged before closing", "leaves the document alone while a stopped recording is still being saved in it", both "… forgets a recording that couldn't survive it" tests, "a copy's document is closed once the recording it isn't holding is forgotten", and the new clipboard test |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Noticed while planning, not changed

- **A start that fails leaves the document open until the next close.**
  - A close skipped for a start doesn't come back later.
  - If that start then fails, the document stays open until the next clipboard copy, or until a later recording's `rec-saved`.
  - A failed start already leaves the document open today: `recFailed` (`background.js:589-591`) doesn't close it, and neither does any of `startRecording`'s early returns.
