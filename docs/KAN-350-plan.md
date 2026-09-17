# KAN-350: A recording start that never finishes holds up every later start

Ticket: https://prattsolutions.atlassian.net/browse/KAN-350 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-345, is Done.

## What the repo does now

Line numbers are from `425efa0`, with a clean working tree. They match the ticket's, which were taken from the KAN-345 change before it was committed.

- **Starts run one at a time.**
  - The `rec-start` handler (`background.js:12-21`) runs each start after the one before it has finished. It does this through `recStartGate` (`:16-19`, declared at `:416-420`).
  - The `.catch(() => {})` at `:19` only lets the next start through when this one fails. A start that never finishes holds up every start after it.
- **`startRecording` (`background.js:422-456`) waits on the page twice, after it writes `rec` (`:434`):**
  - **The edge-glow blip (`:442`):** `blipRecordingIndicator` (`:487-509`) calls `chrome.scripting.executeScript` (`:489`), then waits 700 ms (`:508`).
  - **The viewport read (`:450`):** `getViewport` (`:463-478`) calls `chrome.scripting.executeScript` (`:466`).
  - **Neither call has a time limit.** Their `catch` blocks (`:500-507`, `:474-477`) handle a page that refuses the script: the blip is skipped, and the viewport read returns `null`, so the recording isn't sized to the tab. A call that never answers never reaches them.
  - **Only after both** does it send `rec-start-offscreen` (`:451-454`).
- **Stop can land in the middle of a start.**
  - The popup enables Stop as soon as `rec` is written (`popup.js:190-195`), which is before both page calls.
  - `stopRecording` (`background.js:511-520`) removes `rec`, clears the badge and sends `rec-stop-offscreen`. It doesn't touch the start that is still under way.
  - Reading the code, that start then goes on and sends `rec-start-offscreen` anyway. This hasn't been checked in Chrome.
- **The offscreen document:**
  - ignores a stop while it has no `rec` of its own (`offscreen.js:121-122`). It only sets `rec` once `getUserMedia` answers (`offscreen.js:47-49`);
  - refuses a second start while it has a `rec` (`offscreen.js:34`). It only logs a warning, and the worker isn't told.
- **The popup:**
  - greys Record out before its first await (`popup.js:116`);
  - waits for the worker's answer with no time limit (`popup.js:136`);
  - brings Record back after a failed start only when that answer arrives (`popup.js:140-143`).
- **The repo's only time limit:** `captureWithTimeout` (`background.js:89-94`, added for KAN-251) races `captureVisibleTab` against `sleep(CAPTURE_TIMEOUT_MS)`. That constant is 5 s (`:62`).
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 208 tests.
  - **The fakes in `loadBg` (`:21-97`):**
    - The fake `setTimeout` runs every timer at once, except those of `CAPTURE_TIMEOUT_MS`. It holds those until the test calls `expire()` (`:75-78`, `:95`).
    - The fake `executeScript` answers at once (`:55-60`).
    - The storage fake keeps nothing (`:62`).
  - **`keepStore` (`:1038-1046`)** is a storage fake that keeps what is written to it.
  - **Three recording-start tests use a storage fake that never returns `rec`:**

    | Test | Storage fake |
    |---|---|
    | "a recording uses the tab it was sent for, even when the worker finds no active tab" (`:674-692`) | its own `set` (`:683`) |
    | "a start the offscreen document never gets is undone" (`:958-972`) | its own `set` and `remove` (`:964-965`) |
    | "a start that works tells the popup so" (`:984-993`) | the default |

  - No test has a page call that never answers.
- **Not reproduced in Chrome.** As the ticket says, it was found by reading the code.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`background.js`**
   - **New `scriptWithTimeout(injection)`**, placed after `captureWithTimeout` (`:89-94`). It is the same race with the same `CAPTURE_TIMEOUT_MS`, but it calls `chrome.scripting.executeScript` instead of `captureVisibleTab`.
   - **`getViewport` (`:466`) and `blipRecordingIndicator` (`:489`)** call it instead of `chrome.scripting.executeScript`.
     - A call that times out ends up in their existing `catch`. The blip is then skipped along with its wait, and the recording isn't sized to the tab.
     - Their comments now mention this case.
   - **`startRecording` reads `rec` again, just before it sends `rec-start-offscreen` (after `:450`).**
     - If Stop has removed `rec`, the start logs a warning and returns without starting the recorder.
     - The popup is told `true`, as for any start that ends without an error.

   ```diff
   @@ -93,6 +93,18 @@ function captureWithTimeout(windowId) {
      ]);
    }
    
   +// executeScript answers only once the page has run the script. A recording
   +// start waits on two of these, and every later start waits on it
   +// (recStartGate), so a page that never runs them (its main thread blocked, say)
   +// would hold up all of them for good. So a call that takes longer than
   +// CAPTURE_TIMEOUT_MS fails instead, the way a page that refuses scripts does.
   +function scriptWithTimeout(injection) {
   +  return Promise.race([
   +    chrome.scripting.executeScript(injection),
   +    sleep(CAPTURE_TIMEOUT_MS).then(() => { throw new Error(`executeScript did not answer within ${CAPTURE_TIMEOUT_MS / 1000}s`); }),
   +  ]);
   +}
   +
    // A capture has no UI thread to report into: the popup has closed on Region and
    // never existed for the keyboard shortcuts. So a failure flashes the badge -
    // silence was indistinguishable from a capture that simply did nothing, which
   @@ -448,6 +460,10 @@ async function startRecording(streamId, opts, tabId) {
      // at the bottom). innerWidth/innerHeight × devicePixelRatio gives the
      // physical pixels that match what tabCapture actually delivers.
      const dims = await getViewport(tab?.id);
   +  // Stop removes `rec`, and it can land while the blip or the viewport read is
   +  // still under way: up to two deadlines on a page that never answers. A
   +  // recorder started after that would run on with nothing that can stop it.
   +  if (!(await chrome.storage.local.get('rec')).rec) { console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
      await chrome.runtime.sendMessage({
        type: 'rec-start-offscreen', streamId, format: opts.format,
        width: dims?.width, height: dims?.height,
   @@ -459,11 +475,12 @@ async function startRecording(streamId, opts, tabId) {
    // × devicePixelRatio). This is what tabCapture actually streams — pinning
    // getUserMedia's min/max to these values eliminates both letterboxing AND the
    // bottom-padding-black-bar that comes from using outer window dims. Returns
   -// null on chrome:// pages or any URL where executeScript can't inject.
   +// null on chrome:// pages, any URL where executeScript can't inject, and a
   +// page that doesn't answer in time.
    async function getViewport(tabId) {
      if (!tabId) return null;
      try {
   -    const [{ result }] = await chrome.scripting.executeScript({
   +    const [{ result }] = await scriptWithTimeout({
          target: { tabId },
          func: () => ({
            width: Math.round(window.innerWidth * window.devicePixelRatio),
   @@ -486,7 +503,7 @@ async function getViewport(tabId) {
    const BLIP_ANIM_MS = 650;
    async function blipRecordingIndicator(tabId) {
      try {
   -    await chrome.scripting.executeScript({
   +    await scriptWithTimeout({
          target: { tabId },
          func: (animMs) => {
            const o = document.createElement('div');
   @@ -499,7 +516,8 @@ async function blipRecordingIndicator(tabId) {
        });
      } catch (e) {
        // chrome:// URLs and similar refuse executeScript — skip the wait so we
   -    // don't delay the recording start for nothing.
   +    // don't delay the recording start for nothing. A page that doesn't answer
   +    // in time is skipped the same way.
        // Expected on those pages, so only a warning: chrome://extensions lists
        // every console.error from the worker as an extension error.
        console.warn('[ViewShot] blip failed:', e);
   ```

2. **`tests/capture-errors.test.js`**
   - **Three existing tests get `keepStore(chrome)`**, so that the new `rec` read finds the `rec` their start wrote:
     - The tests at `:683` and `:964-965` keep their own `set` and `remove` fakes. Those now also write through to the store.
     - "a start that works tells the popup so" gets the line after `:987`.
   - **A new section at the end** (after `:1107`) adds two tests:
     - **"a start gives up on a page that never answers, and still records":**
       - Neither page call ever answers.
       - Before the deadlines pass, the start has had no answer.
       - Once both have passed, the start is answered `true`, and `rec-start-offscreen` is sent without a width or height.
     - **"a start stopped while it waits on the page records nothing, and the next start goes ahead":**
       - The first start's two page calls never answer. Stop is sent while it waits, and then a second start.
       - Once both deadlines have passed, both starts are answered `true`.
       - Only the second start sends `rec-start-offscreen`, and `rec` names the tab.

   ```diff
   @@ -680,7 +680,9 @@ test('a recording uses the tab it was sent for, even when the worker finds no ac
      chrome.offscreen = { hasDocument: async () => true }; // already open
      const run = chrome.scripting.executeScript;
      chrome.scripting.executeScript = (o) => { targets.push(o.target.tabId); return run(o); };
   -  chrome.storage.local.set = async (o) => { stored.push({ ...o.rec }); };
   +  keepStore(chrome); // the start reads `rec` back before it starts the recorder
   +  const set = chrome.storage.local.set;
   +  chrome.storage.local.set = async (o) => { stored.push({ ...o.rec }); return set(o); };
      chrome.runtime.sendMessage = async (m) => { sent.push({ ...m }); };
      Object.assign(bg.ctx.window, { innerWidth: 1280, innerHeight: 713, devicePixelRatio: 1 });
      bg.message({ type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: TAB.id });
   @@ -961,8 +963,10 @@ test('a start the offscreen document never gets is undone', async () => {
      const storage = [];
      let reply;
      chrome.offscreen = { hasDocument: async () => true }; // open, but not listening
   -  chrome.storage.local.set = async (o) => { storage.push(['set', ...Object.keys(o)]); };
   -  chrome.storage.local.remove = async (k) => { storage.push(['remove', k]); };
   +  keepStore(chrome); // the start reads `rec` back before it starts the recorder
   +  const { set, remove } = chrome.storage.local;
   +  chrome.storage.local.set = async (o) => { storage.push(['set', ...Object.keys(o)]); return set(o); };
   +  chrome.storage.local.remove = async (k) => { storage.push(['remove', k]); return remove(k); };
      chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') throw new Error(UNREACHABLE); };
      bg.message(WEBM_START, (r) => { reply = r; });
      await settle();
   @@ -985,6 +989,7 @@ test('a start that works tells the popup so', async () => {
      const bg = loadBg();
      let reply;
      bg.ctx.chrome.offscreen = { hasDocument: async () => true };
   +  keepStore(bg.ctx.chrome); // the start reads `rec` back before it starts the recorder
      // Chrome drops an answer sent after the listener returns, unless it returned true.
      assert.strictEqual(bg.message(WEBM_START, (r) => { reply = r; }), true, 'the popup would never hear back');
      await settle();
   @@ -1105,3 +1110,59 @@ test('a start queued behind one that fails waits for its cleanup', async () => {
      assert.deepStrictEqual(started, ['sid2'], 'the second start took the failed start\'s rec for a running recording');
      assert.strictEqual(store.rec?.url, TAB.url, 'the second recording was left without its rec');
    });
   +
   +// --- a recording start the page never answers -------------------------------
   +// startRecording waits on two scripts in the page, the edge-glow blip and the
   +// viewport read, and neither had a deadline. A page that never ran them held
   +// its start for good, and every start queued behind it (recStartGate): a later
   +// Record press got no answer and stayed greyed out. Stop, pressed meanwhile,
   +// only removed `rec`.
   +
   +test('a start gives up on a page that never answers, and still records', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  keepStore(chrome);
   +  const sent = [];
   +  let reply;
   +  chrome.offscreen = { hasDocument: async () => true };
   +  chrome.scripting.executeScript = () => new Promise(() => {}); // the page never runs either script
   +  chrome.runtime.sendMessage = async (m) => { sent.push(m); };
   +  bg.message(WEBM_START, (r) => { reply = r; });
   +  await settle();
   +  assert.strictEqual(reply, undefined, 'gave up before the deadline');
   +  bg.expire(); // the blip's deadline
   +  await settle();
   +  bg.expire(); // the viewport read's
   +  await settle();
   +  assert.strictEqual(reply, true, 'still waiting on a page that will never answer');
   +  const start = sent.find((m) => m.type === 'rec-start-offscreen');
   +  assert.ok(start, 'the recording was never started');
   +  assert.deepStrictEqual([start.width, start.height], [undefined, undefined], 'sized to a viewport that was never read');
   +});
   +
   +test('a start stopped while it waits on the page records nothing, and the next start goes ahead', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  const store = keepStore(chrome);
   +  const started = [];
   +  const replies = [];
   +  chrome.offscreen = { hasDocument: async () => true };
   +  const run = chrome.scripting.executeScript;
   +  let calls = 0;
   +  chrome.scripting.executeScript = (o) => (++calls <= 2 ? new Promise(() => {}) : run(o)); // only the first start's two never answer
   +  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') started.push(m.streamId); };
   +  bg.message(WEBM_START, (r) => replies.push(r));
   +  await settle();
   +  bg.message({ type: 'rec-stop' });
   +  await settle();
   +  assert.strictEqual(store.rec, undefined, 'Stop left the recording marked as running');
   +  bg.message({ ...WEBM_START, streamId: 'sid2' }, (r) => replies.push(r));
   +  await settle();
   +  bg.expire(); // the first start's blip
   +  await settle();
   +  bg.expire(); // its viewport read
   +  await settle();
   +  assert.deepStrictEqual(replies, [true, true], 'the next start was never run');
   +  assert.deepStrictEqual(started, ['sid2'], 'the stopped start went on to record');
   +  assert.strictEqual(store.rec?.url, TAB.url, 'the next recording was left without its rec');
   +});
   ```

Choices:

- **Each of the two page calls gets its own deadline. The whole start and the queue don't get one.**
  - A deadline on the queue would let the next start run while the stuck one is still going. KAN-345 removed exactly that overlap.
  - A deadline on the whole start would leave its page calls running, so the start could still send `rec-start-offscreen` later.
- **Reuse `CAPTURE_TIMEOUT_MS` (5 s) and copy the shape of `captureWithTimeout`.**
  - **Why 5 s:** the ticket doesn't give a limit, and 5 s is the one the repo already uses for a Chrome call that never answers (KAN-251).
  - **No fake timer changes:** `loadBg` already holds timers of that length until `expire()`.
  - **A second helper next to `captureWithTimeout`**, not the same race written out twice in the two functions. Turning `captureWithTimeout` into a general helper would be a refactor this ticket doesn't need.
  - **Worst case, about 10 s per start:** a start on a page that never answers waits out both deadlines, with REC and Stop showing the whole time. A start queued behind it waits that long, then makes its own two calls.
- **A call that times out is treated like a page that refuses scripts.**
  - The start goes on without the blip and without the viewport size. The recording then isn't sized to the tab, which is KAN-242's bug for those pages.
  - KAN-217 keeps Record working on pages that refuse scripts. See the open question.
- **Read `rec` again before starting the recorder.**
  - **Without it, the deadlines would break the ticket's case** (Stop pressed while a start is stuck, then Record again), leaving a recording that nothing can stop:
    1. The stuck start wakes up after its deadlines and sends `rec-start-offscreen`, although Stop has already removed `rec`.
    2. The next start writes `rec`. The offscreen document refuses it with only a warning (`offscreen.js:34`).
    3. Stop then saves the first start's recording under the second start's name.
  - **The same gap is there today on any page**, during the blip's 700 ms wait (from reading the code). This read closes it too.
  - **It reads storage,** as the check at `:426` does, rather than adding new state to the worker.
  - **No check of who wrote `rec` is needed.** Starts run one at a time, so between this start's write and this read, only Stop can change `rec`.
  - **The stopped start is answered `true`.** Answering `false` would show "Couldn't start the recording" and flash `!` right after the user's own Stop.
- **Warnings, not errors.**
  - A call that times out is logged by the existing `catch` blocks, which already use `console.warn`.
  - The stopped start also logs a warning, as `:427` does for a start that finds a recording already running.
  - chrome://extensions lists every `console.error` from the worker as an extension error.
- **A late answer is ignored, and the deadline timer isn't cleared.** `captureWithTimeout` works the same way.
- **Only the two calls the ticket names get a deadline.** The other awaits in `startRecording` wait on Chrome, not on the page.
- **Three existing tests change.**
  - Their storage fakes never return `rec`, so the new read would stop their starts before `rec-start-offscreen`.
  - Two of them would then fail.
  - The third, "a start that works tells the popup so", would still pass, but only because its start stops early.
- **Only the worker changes.** The popup already waits for the worker's answer, and that answer now arrives.
- **No README, manifest or version change.** The README doesn't describe how a recording starts.

Checked while planning, on copies of the repo outside this folder, with Node 24.9.0:

- **As it is now:** `npm test` passes 208 tests.
- **Test changes only:** 210 tests run. 208 pass, and these 2 fail:

  | Test | Failure |
  |---|---|
  | "a start gives up on a page that never answers, and still records" | "still waiting on a page that will never answer" |
  | "a start stopped while it waits on the page records nothing, and the next start goes ahead" | "the next start was never run" |

- **Both changes:** all 210 tests pass.
- **Both changes, with one piece left out:**

  | Piece left out | Tests that fail |
  |---|---|
  | Reading `rec` again | only "a start stopped while it waits on the page…", with "the stopped start went on to record" |
  | The blip's deadline | both new tests, with the two failures in the table above |
  | The viewport read's deadline | both new tests, with the two failures in the table above |
  | `keepStore` in the tests at `:683` and `:964-965` | "a recording uses the tab it was sent for…", with `TypeError: Cannot read properties of undefined (reading 'width')`, and "a start the offscreen document never gets is undone", with "still marked as recording with nothing recording" |
  | `keepStore` in "a start that works tells the popup so" | none. A check added only while planning showed that the test's start then stops before it sends `rec-start-offscreen` |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 210 tests. 208 pass, and the 2 new tests fail with the messages under "Test changes only". No other test fails.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 210 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked.
   - **Setup:** use the headless setup from step 3 of `docs/KAN-345-plan.md`:
     - `Extensions.loadUnpacked`;
     - popups opened with `Extensions.triggerAction`;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - a trace of the badge and `rec` kept in the worker;
     - Format set to WebM, and Name set to `{title}-{time}`.
   - **Pages:** an http page (PageA) and a chrome:// page.
   - **A wrapper for page calls that never answer:** in the worker, wrap `chrome.scripting.executeScript` so that, while a flag is set, calls for PageA's tab never answer.

   → verify each case:
   - **A page whose main thread is blocked (no wrapper):**
     1. On a copy of PageA, run `setTimeout(() => { for (;;); }, 0)`, then press Record.
     2. Note whether the worker logs "blip failed: Error: executeScript did not answer within 5s" about 5 s later, then "getViewport failed: …" about 5 s after that, and then `rec-start-offscreen sent`.
     3. If Chrome answers or rejects those calls instead, note what it does. The wrapped cases below still cover the change.
   - **Wrapped, with no Stop:**
     1. With the flag set, press Record on PageA.
     2. REC and Stop show at once.
     3. About 10 s later, the worker has logged both warnings and `rec-start-offscreen sent`.
     4. Stop saves a `.webm` and clears the badge.
   - **The ticket's case:**
     1. With the flag set, press Record on PageA.
     2. Within 10 s, press Stop, clear the flag, and press Record again.
     3. Once the first start's deadlines pass, the worker logs "stopped before the recorder started; not starting it".
     4. The second start then runs: it is answered `true`, `rec` names PageA, and REC shows. `rec-start-offscreen sent` is logged only once, for the second stream id.
     5. Stop saves one `PageA-….webm` and clears the badge.
   - **The same case on the code as it is now,** for comparison: the second Record press gets no answer, Record stays greyed out, and Stop stays disabled.
   - **A normal Record press on PageA, with the flag cleared:** Stop is enabled within about a second. Stop saves the file and clears the badge.
   - **Record on the chrome:// page:** it starts straight away, as before. The refused calls fail at once and never wait for a deadline.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **A late blip can still show.** If a page runs the blip script after its deadline has passed, the green glow appears then, and it may end up in the recording.
- **The offscreen document drops a Stop that arrives while `getUserMedia` is pending.**
  - The document only sets its `rec` once `getUserMedia` answers (`offscreen.js:47-49`), and a stop that finds no `rec` returns (`offscreen.js:121-122`).
  - The recorder then starts with nothing that can stop it.
  - The new `rec` read only covers the worker's side, up to `rec-start-offscreen`. This is from reading the code and hasn't been checked in Chrome.

## Open questions

- **When the page never answers, should the start go on or fail?**
  - **The plan goes on** (see Choices): no blip and no viewport size, as for a page that refuses scripts. A page that is only busy can still be recorded.
  - **Failing instead:**
    - **What the user sees:** the start is answered `false` after the first deadline, so "Couldn't start the recording. Try again." shows, `!` flashes, and Record comes back.
    - **What goes:** the start never reaches `rec-start-offscreen`, so the extra `rec` read and the three test fake changes would go.
    - **What changes instead:** the two `catch` blocks would rethrow a timeout, and the two new tests would expect `false`.
    - **What stays open:** the 700 ms gap described under Choices.
