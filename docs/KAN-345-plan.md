# KAN-345: Two recordings started at once can leave one that Stop can't end

Ticket: https://prattsolutions.atlassian.net/browse/KAN-345 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-216, is Done.

## What the repo does now

Line numbers are from `6bdaa2a`, with a clean working tree. They match the ticket's, which were taken from the KAN-216 change before it was committed.

- **Every `rec-start` message starts right away.** The handler (`background.js:12-19`) calls `startRecording` (`:16-17`) as soon as a message arrives. If the start is rejected, the handler logs the error, answers `false` and runs `recFailed()`.
- **`startRecording` checks `rec` and only writes it several awaits later.** It reads `rec` (`background.js:418-419`), looks up the tab (`:422`), runs `ensureOffscreen()` (`:423`), and only then writes `rec` (`:426`). Two starts in that gap both get past the check.
- **`recFailed()` removes `rec` whichever start wrote it** (`background.js:410-412`). If the second start fails after the first has written `rec`, it removes the first recording's `rec` and flashes `!`.
  - After that, `stopRecording` (`background.js:503`) finds no `rec` and returns, so Stop can't end the first recording.
- **Screenshots already avoid this with a promise-chain gate.** `captureGate` (`background.js:61`) runs `captureVisibleTab` calls one at a time, and `captureGate = shot.catch(() => {})` (`:78`) keeps one failure from stalling the next call.
- **Tests:**
  - `npm test` passes 205 tests.
  - Every worker test sends at most one `rec-start`.
  - The storage fake in `loadBg` (`tests/capture-errors.test.js:62`) doesn't keep anything that is written to it.
  - "the worker won't start a recording over one that is running" (`:767-780`) fakes a `rec` that is already there.
- **Not reproduced in Chrome.** As the ticket says, it was found by reading the code.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`background.js`**
   - **New `recStartGate`**, declared just above `startRecording` (after `:412`). It is a promise chain, like `captureGate`.
   - **The `rec-start` handler (`:16-17`)** runs each start after the previous one has finished, including that start's answer and its `recFailed()` cleanup.
     - A second start then reads `rec` only once the first start has written it, or once the first start's cleanup has removed it.
     - If the first start wrote `rec`, the second start returns at the existing "a recording is already running" check (`:419`). It never looks up its tab, so a failure there can't happen, and neither can the cleanup.
   - **`recStartGate = start.catch(() => {})`** keeps a rejected cleanup from stalling every later start, as `:78` does for screenshots.

   ```diff
   @@ -13,8 +13,10 @@ chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        // Answered once the start has worked or failed: the popup enables Stop
        // from `rec`, and a start that fails before `rec` is written leaves
        // nothing there for it to see.
   -    startRecording(msg.streamId, msg.opts, msg.tabId)
   +    const start = recStartGate
   +      .then(() => startRecording(msg.streamId, msg.opts, msg.tabId))
          .then(() => sendResponse(true), (e) => { console.error('[ViewShot]', e); sendResponse(false); return recFailed(); });
   +    recStartGate = start.catch(() => {}); // one start's failure must not stall the next
        return true;
      }
      else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
   @@ -411,6 +413,12 @@ function recFailed() {
      return chrome.storage.local.remove('rec').then(() => flashBadge('!'));
    }
    
   +// Starts go through this gate one at a time, each once the one before has
   +// finished, cleanup included. startRecording checks `rec` and writes it only
   +// after several awaits, so two starts that overlapped both got past the check,
   +// and a second one that then failed removed the `rec` the first had written.
   +let recStartGate = Promise.resolve();
   +
    async function startRecording(streamId, opts, tabId) {
      log('rec-start received, opts=', opts, 'streamId=', streamId);
      // One recording at a time. Starting another would overwrite `rec`, and the
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end (after `:1029`):
   - **`keepStore(chrome)`:** a `chrome.storage.local` fake that keeps what is written to it. Two tests use it.
   - **"a second start that fails leaves the first recording its rec":**
     - Two starts are sent back to back. The second start's tab lookup fails only after the first start has written `rec`.
     - The test checks that `rec` still names the first tab, that `rec-start-offscreen` is sent once, that the badge only shows `REC`, and that both starts are answered `true`.
   - **"a start that fails, cleanup and all, does not hold up the next one":**
     - The first start fails, and its cleanup's `remove` rejects.
     - The test checks that the second start still runs: it is answered `true`, and it writes `rec`.

   ```diff
   @@ -1027,3 +1027,58 @@ for (const [what, reply] of [['says the start failed', false], ['can\'t be reach
        assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start', 'rec-start']);
      });
    }
   +
   +// --- two recordings started at once -----------------------------------------
   +// startRecording checks `rec` and writes it only after several awaits. Two
   +// starts inside that gap both got past the check, and when the second then
   +// failed, its cleanup removed the `rec` the first had written: Stop could no
   +// longer end the first recording.
   +
   +// chrome.storage.local that keeps what is written to it.
   +function keepStore(chrome) {
   +  const store = {};
   +  Object.assign(chrome.storage.local, {
   +    get: async (k) => (k in store ? { [k]: store[k] } : {}),
   +    set: async (o) => { Object.assign(store, o); },
   +    remove: async (k) => { delete store[k]; },
   +  });
   +  return store;
   +}
   +
   +test('a second start that fails leaves the first recording its rec', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  const store = keepStore(chrome);
   +  const sent = [];
   +  const replies = [];
   +  let closeSecondTab;
   +  chrome.offscreen = { hasDocument: async () => true };
   +  chrome.runtime.sendMessage = async (m) => { sent.push(m.type); };
   +  const get = chrome.tabs.get;
   +  // The second start's tab closes, but only once the first start has written rec.
   +  chrome.tabs.get = (id) => (id === 99 ? new Promise((_, no) => { closeSecondTab = () => no(new Error('No tab with id: 99.')); }) : get(id));
   +  bg.message(WEBM_START, (r) => replies.push(r));
   +  bg.message({ ...WEBM_START, streamId: 'sid2', tabId: 99 }, (r) => replies.push(r));
   +  await settle();
   +  closeSecondTab?.();
   +  await settle();
   +  assert.strictEqual(store.rec?.url, TAB.url, 'the second start removed the first recording\'s rec');
   +  assert.deepStrictEqual(sent, ['rec-start-offscreen'], 'the offscreen document was told to start twice');
   +  assert.deepStrictEqual(bg.badges, ['REC'], 'REC was flashed away over a running recording');
   +  assert.deepStrictEqual(replies, [true, true]);
   +});
   +
   +test('a start that fails, cleanup and all, does not hold up the next one', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  const store = keepStore(chrome);
   +  const replies = [];
   +  chrome.offscreen = { hasDocument: async () => true };
   +  const remove = chrome.storage.local.remove;
   +  chrome.storage.local.remove = async () => { chrome.storage.local.remove = remove; throw new Error('storage failed'); };
   +  bg.message({ ...WEBM_START, tabId: 99 }, (r) => replies.push(r)); // its tab has closed
   +  bg.message(WEBM_START, (r) => replies.push(r));
   +  await settle();
   +  assert.deepStrictEqual(replies, [false, true], 'the next start was never run');
   +  assert.strictEqual(store.rec?.url, TAB.url, 'the next start was never run');
   +});
   ```

Choices:

- **The fix queues starts rather than making `recFailed()` check who wrote `rec`.**
  - The ticket's cause is that two starts both get past the check before either writes `rec`. Queuing starts closes that gap.
  - Checking the owner would only change the cleanup. Two starts could still both write `rec`, and the second would overwrite the first recording's tab and title.
  - The queue follows the existing `captureGate` pattern (`background.js:61-78`).
- **The queue covers each start's answer and cleanup, not just `startRecording`.**
  - Otherwise the next start could read `rec` before the failed start's `recFailed()` had removed it.
- **A start that runs while another recording is running is still answered `true`.**
  - It returns at the existing check (`:419`), as it did before KAN-216 added answers.
  - The popup that sent it shows no error. Its storage listener already enabled Stop when the first start wrote `rec`, so Stop there ends the recording that is running.
- **Only the worker changes.** Within one popup, Record is already greyed out once pressed (`popup.js:116`), so two starts need two popups.
- **Stop isn't queued.**
  - The popup only enables Stop once `rec` is written.
  - The offscreen document only sends `rec-stop` and `rec-cap-hit` once a recording has started.
  - So neither can arrive while a start is still under way.
- **No README, manifest or version change.**

Checked while planning, on copies of the repo outside this folder:

- **As it is now:** `npm test` passes 205 tests.
- **Test changes only:** 207 tests run. 205 pass, and these 2 fail:

  | Test | Failure |
  |---|---|
  | "a second start that fails leaves the first recording its rec" | "the second start removed the first recording's rec" |
  | "a start that fails, cleanup and all, does not hold up the next one" | `Error: storage failed`. The current handler leaves the cleanup's rejection unhandled, and the test runner reports it against this test |

- **Both changes:** 207 tests pass.
- **Both changes, with one piece put back as it is now:**

  | Piece put back | Tests that fail |
  |---|---|
  | The handler calls `startRecording` directly, without the queue | only "a second start that fails leaves the first recording its rec" |
  | `recStartGate = start`, without `.catch(() => {})` | only "a start that fails, cleanup and all, does not hold up the next one", with "the next start was never run" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 207 tests. 205 pass, and the 2 tests listed under "Test changes only" fail with those messages. No other test fails.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 207 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA).
   - **Setup:** the headless setup from step 3 of `docs/KAN-216-plan.md`:
     - `Extensions.loadUnpacked`;
     - popups opened with `Extensions.triggerAction`;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - a badge and `rec` trace kept in the worker;
     - Format set to WebM and Name set to `{title}-{time}`.
   - **Slow failure:** in the worker, wrap `chrome.tabs.get` so that tab id `999999` rejects after 1 s. That second start then fails only after the first start has written `rec`.

   → verify each case:
   - **Two starts at once:**
     1. In a popup on PageA, mint a stream id for PageA.
     2. Send two `rec-start` messages back to back: the first with PageA's tab id and that stream id, the second with `tabId: 999999`.
     3. The worker logs "a recording is already running; not starting another" for the second start, and both starts are answered `true`.
     4. `rec` stays on PageA, and the badge shows `REC` with no `!`.
     5. Stop is enabled in the popup. Pressing it saves `PageA-….webm` and clears the badge.
   - **A failed start, then a real one:**
     1. Send a `rec-start` with `tabId: 999999`, then straight away one for PageA with a new stream id.
     2. After about 1 s, the first start is answered `false` and the badge flashes `!`.
     3. The second start then runs: it is answered `true`, `rec` names PageA, and the badge shows `REC`.
     4. Stop saves the recording.
   - **A normal Record press:** Stop is enabled within about a second, and Stop saves the file and clears the badge.
   - **The same two-starts case on the code as it is now,** for comparison: the second start removes `rec` and flashes `!`. Stop then can't end the first recording, and nothing is saved.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None.

- The ticket names the gap: the check at `background.js:418-419` and the write at `:426`. It also names the cleanup that removes the wrong `rec` (`:12-19`, `:410-412`) and the result: Stop can't end the first recording.
- It doesn't ask for anything new in the popup, and the popup that sent the second start already shows the running recording's Stop.
