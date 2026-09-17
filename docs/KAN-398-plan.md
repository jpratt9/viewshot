# KAN-398: The GIF frame cap flashes MAX even when the recording has already been stopped

Ticket: https://prattsolutions.atlassian.net/browse/KAN-398 (To Do, Task, labels `bug` and `viewshot`, no comments). No blockers.

Filed while doing KAN-371, which is Done.

## What the repo does now

Line numbers are from `9349bbd`, with a clean working tree. The ticket's match.

- **The cap** (`offscreen.js:110-118`): once a GIF has `GIF_MAX_FRAMES` frames (600, `:31`), the tick clears its own timer, warns, and sends `rec-cap-hit` (`:116`) so the whole stop runs through the worker, the same path the Stop button uses.
- **The worker's cap-hit branch** (`background.js:23`): `stopRecording().then(() => flashBadge('MAX'))`. The flash is not conditional on anything.
- **`stopRecording`** (`background.js:544-553`):
  - reads `rec`, and with no `rec` warns "stop with no active recording" and returns (`:547`);
  - otherwise builds the filename, removes `rec`, clears the badge and sends `rec-stop-offscreen` (`:548-552`).
  - Both paths return `undefined`, so the `.then` at `:23` can't tell them apart.
- **`flashBadge`** (`background.js:423-432`) sets the text, then 3 s later puts back `REC` if a recording is running, or an empty badge if not.
- **So a Stop that lands just before the 600th frame** removes `rec`, clears the badge and saves the file; the `rec-cap-hit` behind it finds no `rec`, and `MAX` still sits on the badge for 3 s over a recording that is already finished.
- **Callers of `stopRecording`:** only `:22` (`rec-stop`, ignores what it returns) and `:23`.
- **The same shape is already guarded for `!`:** 83951e3 (KAN-372) stopped `recFailed` (`background.js:436-438`) being reached for a start the user had already stopped.
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 221 tests.
  - `loadBg` (`:21-99`) runs `background.js` with fakes. Its `setBadgeText` records every non-empty text in `badges` (`:65`), and its `setTimeout` runs `flashBadge`'s 3 s timer at once, since 3000 is neither deadline.
  - `keepStore` (`:1059-1067`) swaps in a `chrome.storage.local` that keeps what is written to it.
  - No test sends `rec-cap-hit`.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`background.js`**
   - **`stopRecording`** answers whether it ended a recording: `false` on the no-`rec` path (`:547`), `true` once the stop has gone out (`:552`).
   - **The cap-hit branch** (`:23`) only flashes `MAX` when it gets `true`.

   ```diff
   @@ -20,7 +20,10 @@ chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
   -  else if (msg?.type === 'rec-cap-hit') stopRecording().then(() => flashBadge('MAX')).catch((e) => console.error('[ViewShot]', e));
   +  // MAX only when the cap is what ended the recording: a Stop that landed
   +  // first has already saved the file and cleared the badge, and a MAX over
   +  // that reports trouble with a recording that is finished.
   +  else if (msg?.type === 'rec-cap-hit') stopRecording().then((stopped) => { if (stopped) return flashBadge('MAX'); }).catch((e) => console.error('[ViewShot]', e));
      else if (msg?.type === 'rec-failed') recFailed();
    });
   @@ -544,7 +547,9 @@ async function stopRecording() {
      const { rec } = await chrome.storage.local.get('rec');
   -  if (!rec) { console.warn('[ViewShot] stop with no active recording'); return; }
   +  // Answered, so the frame cap can tell whether it is the one that ended the
   +  // recording: false means a Stop got here first.
   +  if (!rec) { console.warn('[ViewShot] stop with no active recording'); return false; }
      const filename = buildName(rec.filename, rec.format, { url: rec.url, title: rec.title });
   @@ -550,4 +555,5 @@ async function stopRecording() {
      await chrome.runtime.sendMessage({ type: 'rec-stop-offscreen', filename });
   +  return true;
    }
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end (after `:1386`) with two tests, both sending `rec-cap-hit` through the worker's message listener:
   - the cap with no `rec` sets no badge at all;
   - the cap with a `rec` still flashes `MAX`, stops the recording and clears `rec`.

   ```diff
   @@ -1386,3 +1386,31 @@ test('a GIF start stopped while it waits for its video records nothing, and the
    });
   +
   +// --- the GIF frame cap's MAX badge -----------------------------------------
   +// A GIF that fills its 600 frames sends rec-cap-hit, and the worker stopped
   +// the recording and flashed MAX whether or not there was one to stop. A Stop
   +// that landed first has already saved the file and cleared the badge, so the
   +// MAX reported a problem with a recording that was finished.
   +
   +test('the frame cap leaves the badge alone when a Stop got there first', async () => {
   +  const bg = loadBg();
   +  keepStore(bg.ctx.chrome); // no `rec`: the Stop removed it
   +  bg.message({ type: 'rec-cap-hit' });
   +  await settle();
   +  assert.deepStrictEqual(bg.badges, [], 'the cap flashed a badge over a recording that had already ended');
   +});
   +
   +test('the frame cap still flashes MAX when it ends a recording', async () => {
   +  const bg = loadBg();
   +  const store = keepStore(bg.ctx.chrome);
   +  const sent = [];
   +  bg.ctx.chrome.runtime.sendMessage = async (m) => { sent.push(m.type); };
   +  store.rec = { url: TAB.url, title: TAB.title, format: 'gif', filename: 'x' };
   +  bg.message({ type: 'rec-cap-hit' });
   +  await settle();
   +  assert.deepStrictEqual(bg.badges, ['MAX'], 'the cap did not report that it had ended the recording');
   +  assert.deepStrictEqual(sent, ['rec-stop-offscreen'], 'the recording was never stopped');
   +  assert.strictEqual(store.rec, undefined, 'the recording was left marked as running');
   +});
   ```

Choices:

- **`stopRecording` answers, rather than the branch reading `rec` for itself.** A second read would be a second trip to storage and could disagree with the one `stopRecording` just made. Its two existing paths already know the answer.
- **`false`/`true`, not a thrown error.** A cap that arrives after a Stop isn't a failure: the file is saved and the badge is right. The other caller (`:22`) ignores the value, as it does today.
- **The `MAX` flash keeps its own `return`,** so the branch's `.catch` still covers a badge call that fails, as it does now.
- **The cap keeps running through the worker.** The offscreen document still sends `rec-cap-hit` and nothing about `GIF_MAX_FRAMES` or the tick changes (`offscreen.js:110-118`).
- **Only the worker changes.** The offscreen document, popup, README, manifest and version stay as they are. The `!` badge and `recFailed` are untouched.

Checked while planning, on a copy of the repo outside this folder (from `git archive HEAD`), with Node 24.9.0:

- **As it is now:** `npm test` passes 221 tests.
- **Test change only:** 223 tests run. 222 pass, and "the frame cap leaves the badge alone when a Stop got there first" fails with "the cap flashed a badge over a recording that had already ended". The other new test passes, since today's code does flash `MAX` when there is a recording to stop.
- **Both changes:** all 223 tests pass.
- **Both changes, with one piece left out** (each time, only one new test fails):

  | Piece left out | The failing test reports |
  |---|---|
  | `stopRecording`'s `false`/`true` answers | "the cap did not report that it had ended the recording" |
  | The `if (stopped)` guard in the cap-hit branch | "the cap flashed a badge over a recording that had already ended" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 223 tests. 222 pass, and the badge-alone test fails with "the cap flashed a badge over a recording that had already ended". No other test fails.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 223 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA).
   - **Setup:** the headless setup from step 3 of `docs/KAN-371-plan.md`:
     - `Extensions.loadUnpacked`;
     - popups opened with `Extensions.triggerAction` on the tab target;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - a trace of `chrome.action.setBadgeText` and `rec` kept in the worker;
     - Format set to GIF, and Name set to `{title}-{time}`.
   - **Reaching the cap without waiting 60 s:** in the offscreen document, set `GIF_MAX_FRAMES` down (for example to 20) before pressing Record. It is a `const` at the top level of the document's script, so do it by attaching to the document and evaluating the assignment; if the binding can't be written, record for the full 60 s instead.
   - **Landing a Stop in the same moment as the cap:** wrap the document's `chrome.runtime.sendMessage` so a `rec-cap-hit` is held until the test releases it. Press Stop while it is held, then release.

   → verify each case:
   - **A cap with no Stop:** the badge goes `REC` → `MAX` for about 3 s → empty, one `PageA-….gif` is saved, and the worker logs no "stop with no active recording".
   - **The ticket's case:**
     1. Press Record, let the recording run, hold the `rec-cap-hit`.
     2. Press Stop. The trace shows `rec` removed and the badge cleared, and one `PageA-….gif` is saved.
     3. Release the held `rec-cap-hit`.
     4. The worker logs "stop with no active recording" and the badge stays empty for the next 4 s.
     5. No second file is saved.
   - **The same case on the code as it is now,** for comparison: after the release the badge shows `MAX` for about 3 s.
   - **A Stop with no cap involved:** Record then Stop saves one `PageA-….gif`, the badge ends empty, and `ffprobe` reads the file as a GIF with frames in it.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **A cap that arrives after a Stop still reaches `stopRecording`**, which logs "stop with no active recording" as a warning. That log is how the case was spotted in Chrome, and the ticket asks only about the badge, so it stays.

## Open questions

None. The ticket names the branch, the reason and the fix direction ("only flash `MAX` when the cap actually ended a recording"), and the repo already has the same guard for `!`.
