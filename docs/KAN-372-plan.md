# KAN-372: A recording start stopped before its recorder starts still flashes ! when getUserMedia then fails

Ticket: https://prattsolutions.atlassian.net/browse/KAN-372 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-364, is Done.

## What the repo does now

Line numbers are from `eb2032d`, with a clean working tree. They match the ticket's, which were taken from the KAN-364 change before it was committed.

- **The offscreen document's start** (`offscreen.js:36-131`):
  - just before `getUserMedia`, it gives the start its own `{ stopped: false }` and points `lastStart` at it (`:52-53`);
  - it awaits `getUserMedia` with no `try` (`:54`);
  - only once `getUserMedia` answers does it check `start.stopped` (`:60`). A stopped start then stops the stream's tracks, logs a warning and returns.
- **A Stop that finds no `rec`** marks `lastStart` stopped (`offscreen.js:135`).
- **A failed start:**
  - the message handler runs `startRecording(...).catch(onRecError)` (`offscreen.js:15`);
  - `onRecError` (`offscreen.js:194-198`) logs "[ViewShot] recording failed:", calls `teardown()` and sends `rec-failed`. It doesn't know which start failed, or whether that start was stopped;
  - the worker handles `rec-failed` with `recFailed()` (`background.js:24`), which removes `rec` and flashes `!` (`background.js:436-438`, with `flashBadge` at `:423-432`);
  - `recFailed` also handles a start that fails in the worker (`background.js:18`), including one that fails before `rec` is written. That start must still flash `!`.
- **So the ticket's case plays out like this:**
  - a start is stopped while `getUserMedia` is answering, and `getUserMedia` then fails;
  - the start never reaches the check at `:60`, so it sends `rec-failed`, and `!` flashes right after the user's own Stop;
  - before KAN-364, the Stop was dropped, and the same thing happened.
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 215 tests.
  - **`loadOffscreen` (`:479-523`):**
    - it keeps the document's message listener (`message`) and every message the document sends (`sent`);
    - its fake `getUserMedia` answers at once (`:503`);
    - its `console.error` is silent (`:499`).
  - **The KAN-364 tests** (`:1217-1254`) cover a Stop while `getUserMedia` is answering, but only with a `getUserMedia` that answers.
  - **No test has a `getUserMedia` that fails,** stopped or not. So nothing checks that a failed start in the document sends `rec-failed`.
- **Not reproduced in Chrome.** As the ticket says, it was found by reading the code.

## Change

Two files change: `offscreen.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`offscreen.js`:** in `startRecording`, the `getUserMedia` await (`:54`) moves into a `try`. When `getUserMedia` fails:
   - **a stopped start** logs a warning with the error and returns, so nothing reaches `onRecError` and no `rec-failed` is sent;
   - **any other start** rethrows the error, which reaches `onRecError` as before.

   ```diff
   @@ -51,7 +51,15 @@ async function startRecording(streamId, format, width, height) {
      log('requesting getUserMedia for streamId', streamId, 'mandatory=', mandatory);
      const start = { stopped: false };
      lastStart = start;
   -  const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory } });
   +  let stream;
   +  try {
   +    stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory } });
   +  } catch (e) {
   +    // A start stopped while getUserMedia was answering has nothing to report:
   +    // rec-failed would flash ! right after the user's own Stop.
   +    if (start.stopped) { console.warn('[ViewShot] getUserMedia failed for a start that was already stopped:', e); return; }
   +    throw e;
   +  }
      log('got MediaStream, video tracks:', stream.getVideoTracks().length);
      // The worker reads `rec` for the last time before it sends rec-start-offscreen,
      // so its Stop can still arrive while getUserMedia is answering. The worker has
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end (after `:1254`) with two tests. Both send the start through the document's message listener, so a failure goes where it does in Chrome, through `.catch(onRecError)`.
   - **"a start stopped while it waits on getUserMedia reports nothing when getUserMedia then fails":**
     - The start's `getUserMedia` hasn't answered when Stop arrives.
     - `getUserMedia` then fails.
     - The document sends nothing.
   - **"a start whose getUserMedia fails, with no Stop, still reports it":**
     - The document sends `rec-failed`.
     - The error `onRecError` logs is the one `getUserMedia` failed with.
     - This test passes today. It's there to catch a lost rethrow.

   ```diff
   @@ -1252,3 +1252,31 @@ test('a Stop that reaches a document that never started a recording does nothing
      assert.doesNotThrow(() => o.ctx.stopRecording('out.webm'), 'a Stop with no start to mark threw'); // the worker's rec-stop-offscreen
      assert.strictEqual(busy(o), false, 'the document was left busy with nothing to save');
    });
   +
   +// --- a stopped start whose getUserMedia fails -------------------------------
   +// A start stopped while getUserMedia was answering only checked for that Stop
   +// once getUserMedia answered. When getUserMedia failed instead, the start
   +// reported rec-failed, and the worker flashed ! right after the user's Stop.
   +
   +test('a start stopped while it waits on getUserMedia reports nothing when getUserMedia then fails', async () => {
   +  const o = loadOffscreen();
   +  let refuse;
   +  o.ctx.navigator.mediaDevices.getUserMedia = () => new Promise((res, rej) => { refuse = () => rej(new Error('Error starting tab capture')); });
   +  o.message({ type: 'rec-start-offscreen', streamId: 'sid', format: 'webm', width: 100, height: 100 });
   +  o.message({ type: 'rec-stop-offscreen', filename: 'out.webm' });
   +  refuse();
   +  await settle();
   +  assert.deepStrictEqual(o.sent, [], 'the stopped start reported its failure');
   +});
   +
   +test('a start whose getUserMedia fails, with no Stop, still reports it', async () => {
   +  const o = loadOffscreen();
   +  const refused = new Error('Error starting tab capture');
   +  const errors = [];
   +  o.ctx.console.error = (...args) => errors.push(args);
   +  o.ctx.navigator.mediaDevices.getUserMedia = async () => { throw refused; };
   +  o.message({ type: 'rec-start-offscreen', streamId: 'sid', format: 'webm', width: 100, height: 100 });
   +  await settle();
   +  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed'], 'the failed start was never reported');
   +  assert.strictEqual(errors[0]?.[1], refused, 'the error logged is not the one getUserMedia failed with');
   +});
   ```

Choices:

- **Fixed in the start, not in the worker or `onRecError`.**
  - Only the start knows whether it was stopped (`start.stopped`, from KAN-364).
  - `recFailed` also handles starts that fail in the worker, some before `rec` is written (`background.js:18`), and those must still flash `!`. So the worker can't simply skip `!` whenever `rec` is gone.
  - `onRecError` handles failures from every start, and by the time one fails, `lastStart` may already be a later start.
- **The same outcome KAN-364 gives a stopped start whose `getUserMedia` answers.** That start returns quietly after a warning (`offscreen.js:60`). A stopped start whose `getUserMedia` fails now does the same. It has no stream to stop.
- **A warning with the error, not silence.** The document already logs a refused start and a stopped start with `console.warn` (`offscreen.js:39`, `:60`). The error goes into the warning in case `getUserMedia` fails for a reason worth seeing.
- **Every other failure is unchanged.**
  - A start that wasn't stopped rethrows the same error.
  - Errors after `getUserMedia` answers don't pass through this `catch`.
- **Why the second test is needed.** Without it, a lost rethrow would go unnoticed. The start would then fail on the undefined stream instead, and `onRecError` would still send `rec-failed`, but it would log that `TypeError` rather than `getUserMedia`'s error.
- **Only the offscreen document changes.** The worker, popup, README, manifest and version stay as they are.

Checked while planning, on a copy of the repo outside this folder (from `git archive HEAD`), with Node 24.9.0:

- **As it is now:** `npm test` passes 215 tests.
- **Test change only:** 217 tests run. 216 pass, and "a start stopped while it waits on getUserMedia reports nothing when getUserMedia then fails" fails with "the stopped start reported its failure".
- **Both changes:** all 217 tests pass.
- **Both changes, with one piece left out** (each time, only one test fails):

  | Piece left out | Failing test | Message |
  |---|---|---|
  | The `start.stopped` check in the `catch` | "a start stopped while it waits on getUserMedia reports nothing…" | "the stopped start reported its failure" |
  | The rethrow | "a start whose getUserMedia fails, with no Stop, still reports it" | "the error logged is not the one getUserMedia failed with" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 217 tests. 216 pass, and "a start stopped while it waits on getUserMedia reports nothing when getUserMedia then fails" fails with "the stopped start reported its failure". No other test fails.
2. Make the `offscreen.js` change above.
   → verify: `npm test` passes all 217 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA).
   - **Setup:** the setup from step 3 of `docs/KAN-364-plan.md`:
     - `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging`, with a temporary `--user-data-dir` that has `download.default_directory` in its `Default/Preferences`;
     - `Extensions.loadUnpacked`;
     - PageA opened with `Target.createTarget({ url, forTab: true })` and `Target.activateTarget`. That returns a tab target, which is what `Extensions.triggerAction` takes. Scripts for the page itself run in the `page` target inside it;
     - popups opened with `Extensions.triggerAction`, after one warm-up popup;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - a trace of the badge and `rec` kept in the worker: wrap `chrome.action.setBadgeText`, and add a `chrome.storage.local.onChanged` listener;
     - Format set to WebM, and Name set to `{title}-{time}`.
   - **A `getUserMedia` that fails on cue:**
     - Record once, so that the offscreen document is open (it stays open after a recording, KAN-369).
     - Attach to its `offscreen.html` target.
     - There, keep the original `navigator.mediaDevices.getUserMedia`, and replace it with one that never calls the real one. It rejects with `new DOMException('Error starting tab capture', 'AbortError')` when `__refuse()` is called.

   → verify each case:
   - **The ticket's case:**
     1. Press Record on PageA, and wait for the worker to log `rec-start-offscreen sent`.
     2. Press Stop. The trace shows `rec` removed and the badge cleared, and the document logs `rec-stop-offscreen`.
     3. Call `__refuse()` in the document.
     4. The document logs "getUserMedia failed for a start that was already stopped:" with the `AbortError`, and doesn't log "recording failed".
     5. For the next 4 s, the trace has no `!`, and the badge stays empty.
   - **The same case on the code as it is now,** for comparison: the document logs "recording failed". The badge shows `!`, then is empty 3 s later.
   - **A failed start with no Stop:**
     1. Press Record on PageA, wait for `rec-start-offscreen sent`, and call `__refuse()`.
     2. As before, the document logs "recording failed", and `rec` is removed.
     3. The badge shows `!` and is empty 3 s later, and Record comes back in the popup.
   - **Then with the original `getUserMedia` put back:** Record, then Stop, saves one `PageA-….webm`.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None.

- The ticket names the gap: the check at `offscreen.js:60` is never reached when `getUserMedia` fails. It also names the result: `!` right after the user's own Stop.
- It doesn't say what to log. The plan logs a warning with the error, as the start does for its other expected outcomes. Logging nothing would make the `if` just `return`, and no test would change.
