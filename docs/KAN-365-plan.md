# KAN-365: A page that runs the edge-glow blip after its 2 s deadline can put the glow into the recording

Ticket: https://prattsolutions.atlassian.net/browse/KAN-365 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-211, is Done.

## What the repo does now

Line numbers are from `83951e3`, with a clean working tree. They match the ticket's, which were taken from the KAN-350 and KAN-211 changes before they were committed.

- **The blip** (`background.js:509-539`):
  - `startRecording` awaits it (`:466`) after it writes `rec` (`:458`). The viewport read and the recorder come after it (`:474-482`).
  - Its script (`:520-526`) adds an overlay with a green inset glow, and fades it in and out over `BLIP_ANIM_MS`, which is 650 ms (`:515`).
  - The script is serialized into the page, so it can't see the worker's variables. It gets `BLIP_ANIM_MS` through `args` (`:527`).
  - Once the script has answered, the worker waits 700 ms (`:538`), so the glow is gone before the recorder starts. The comment at `:512-514` says why.
- **The deadline** (KAN-350):
  - `scriptWithTimeout` (`:96-111`) races `executeScript` against `sleep(SCRIPT_TIMEOUT_MS)`, which is 2 s (`:105`).
  - When the deadline wins, the blip's `catch` (`:529-537`) logs "blip failed" and returns without the 700 ms wait. `startRecording` then goes on to `getViewport` (`:474`), reads `rec` again (`:478`) and sends `rec-start-offscreen` (`:479-482`).
  - The race only stops the worker waiting. The page still runs the script once its main thread gets to it, and the script shows the glow whenever it runs.
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 217 tests.
  - **The fakes in `loadBg` (`:21-99`):**
    - `executeScript` runs the script's `func` with its `args` straight away (`:57-60`);
    - `Date.now()` reads a fake clock that sleeps and `tick()` move forward (`:78`, `:81`, `:96`);
    - timers of `SCRIPT_TIMEOUT_MS` are held until the test calls `expire()` (`:77`, `:97`);
    - `document.createElement` returns an element with no `animate` (`:83`).
  - **No test has a blip that shows its glow.** Every blip script the tests run throws at `animate` and ends in the `catch`. No test replaces `document`, and `animate` appears nowhere in the tests.
  - **The KAN-350 tests** (`:1129-1176`) have blip scripts that never answer. None of them runs one late.
- **Not reproduced in Chrome.** As the ticket says, it was found by reading the code.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`background.js`:** in `blipRecordingIndicator`, the script is told its deadline, and skips the glow once that has passed.
   - `args` (`:527`) gets a second value, `Date.now() + SCRIPT_TIMEOUT_MS`: the time the worker stops waiting for the script.
   - The script (`:520`) takes it as `deadline`. If `Date.now()` is past it, the script returns before it adds the overlay.

   ```diff
   @@ -517,14 +517,17 @@ async function blipRecordingIndicator(tabId) {
      try {
        await scriptWithTimeout({
          target: { tabId },
   -      func: (animMs) => {
   +      func: (animMs, deadline) => {
   +        // The start stops waiting for this script at its deadline and goes on to
   +        // the recorder, so a glow shown after that would end up in the recording.
   +        if (Date.now() > deadline) return;
            const o = document.createElement('div');
            o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-shadow:inset 0 0 44px 10px rgba(57,211,83,.6);opacity:0;';
            (document.body || document.documentElement).appendChild(o);
            o.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: animMs, easing: 'ease-out' })
              .onfinish = () => o.remove();
          },
   -      args: [BLIP_ANIM_MS],
   +      args: [BLIP_ANIM_MS, Date.now() + SCRIPT_TIMEOUT_MS],
        });
      } catch (e) {
        // chrome:// URLs and similar refuse executeScript — skip the wait so we
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end (after `:1286`) with two tests. Each calls `blipRecordingIndicator` directly, with:
   - a page that runs the script only when the test calls `runScript()`;
   - a `document` whose elements can `animate`, and whose `documentElement.appendChild` records each glow the script adds.

   The tests:
   - **"a blip the page runs after its deadline shows no glow":** the clock passes the deadline, the deadline fires, and the blip returns. Only then does the page run the script. No glow is added.
   - **"a blip the page runs before its deadline still shows its glow":** the page runs the script a second before its deadline, and one glow is added. This test passes today. It's there to catch a check that skips a glow the page showed in time.

   ```diff
   @@ -1284,3 +1284,41 @@ test('a start whose getUserMedia fails, with no Stop, still reports it', async (
      assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed'], 'the failed start was never reported');
      assert.strictEqual(errors[0]?.[1], refused, 'the error logged is not the one getUserMedia failed with');
    });
   +
   +// --- a blip the page runs after its deadline --------------------------------
   +// A start stops waiting for the edge-glow blip at its deadline and goes on to
   +// the recorder. A page that only ran the blip script after that still showed
   +// the glow, and it could end up in the recording.
   +
   +test('a blip the page runs after its deadline shows no glow', async () => {
   +  const bg = loadBg();
   +  const { chrome, document } = bg.ctx;
   +  const glows = [];
   +  document.createElement = () => ({ style: {}, animate: () => ({}) });
   +  document.documentElement.appendChild = (el) => glows.push(el);
   +  const run = chrome.scripting.executeScript;
   +  let runScript;
   +  chrome.scripting.executeScript = (o) => new Promise((res) => { runScript = () => res(run(o)); }); // the page is busy until runScript()
   +  const blip = bg.ctx.blipRecordingIndicator(TAB.id);
   +  bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) + 1000);
   +  bg.expire(); // the deadline passed a second ago
   +  await blip; // the start has gone on without the glow
   +  runScript(); // only now does the page get to the script
   +  assert.deepStrictEqual(glows, [], 'the glow showed after the start had gone on without it');
   +});
   +
   +test('a blip the page runs before its deadline still shows its glow', async () => {
   +  const bg = loadBg();
   +  const { chrome, document } = bg.ctx;
   +  const glows = [];
   +  document.createElement = () => ({ style: {}, animate: () => ({}) });
   +  document.documentElement.appendChild = (el) => glows.push(el);
   +  const run = chrome.scripting.executeScript;
   +  let runScript;
   +  chrome.scripting.executeScript = (o) => new Promise((res) => { runScript = () => res(run(o)); }); // the page is busy until runScript()
   +  const blip = bg.ctx.blipRecordingIndicator(TAB.id);
   +  bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) - 1000);
   +  runScript(); // the page gets to the script a second before its deadline
   +  await blip;
   +  assert.strictEqual(glows.length, 1, 'the glow was skipped although the page ran the script in time');
   +});
   ```

Choices:

- **The script checks the deadline itself.**
  - Only the script knows when the page runs it.
  - The race in `scriptWithTimeout` only stops the worker waiting. Chrome has no way to take back a script it has already sent to the page.
- **The deadline goes through `args`, as `BLIP_ANIM_MS` does.** The script can't see the worker's variables.
- **`Date.now()` on both sides.**
  - The worker and the page read the same system clock. `performance.now()` counts from each context's own start, so it can't be compared between them.
  - The script runs in the extension's isolated world (`background.js` passes no `world`), where the page's own scripts can't replace `Date`.
- **The page's deadline is never later than the worker's.** `args` is built before `scriptWithTimeout` is called, and `scriptWithTimeout` starts its timer only after it has called `executeScript` (`:108-109`).
- **A script that skips the glow can still answer before the worker's timer fires.**
  - The worker then waits its 700 ms (`:538`) for a glow that never showed, and nothing reaches the recording.
  - No start waits longer than it could before: a page that runs the script just before its deadline already costs the same.
- **The script returns without logging anything.** Its log would go to the page's own console. The worker still logs "blip failed" whenever its deadline passes first (`:535`).
- **Only the blip changes.** `getViewport`'s script (`:497-500`) also runs late on such a page, but it only reads the window size and shows nothing.
- **The tests call `blipRecordingIndicator` directly.**
  - The change is inside it.
  - The "blip failed" test (`:225-234`) already calls `startRecording` directly.
  - The KAN-350 tests already cover a start going on once the blip's deadline passes.
- **No README, manifest or version change.** The README doesn't mention the blip.

Checked while planning, on a copy of the repo outside this folder (from `git archive HEAD`), with Node 24.9.0:

- **As it is now:** `npm test` passes 217 tests.
- **Test change only:** 219 tests run. 218 pass, and "a blip the page runs after its deadline shows no glow" fails with "the glow showed after the start had gone on without it".
- **Both changes:** all 219 tests pass.
- **Both changes, with one piece left out or wrong** (each time, only one test fails):

  | Piece | Failing test | Message |
  |---|---|---|
  | The `Date.now() > deadline` check left out | "a blip the page runs after its deadline shows no glow" | "the glow showed after the start had gone on without it" |
  | The deadline left out of `args` | "a blip the page runs after its deadline shows no glow" | "the glow showed after the start had gone on without it" |
  | `Date.now()` passed as the deadline, without `SCRIPT_TIMEOUT_MS` | "a blip the page runs before its deadline still shows its glow" | "the glow was skipped although the page ran the script in time" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 219 tests. 218 pass, and "a blip the page runs after its deadline shows no glow" fails with "the glow showed after the start had gone on without it". No other test fails.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 219 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page with a white background (PageA).
   - **Setup:** the setup from step 3 of `docs/KAN-372-plan.md`:
     - headless Chrome over CDP, with `Extensions.loadUnpacked`;
     - PageA opened as a tab target, with scripts for the page itself run in the `page` target inside it;
     - popups opened with `Extensions.triggerAction`, and buttons pressed with `Runtime.evaluate` and `userGesture: true`;
     - a trace of the badge and `rec` kept in the worker;
     - Format set to WebM, and Name set to `{title}-{time}`.
   - **A record of the glow in PageA:** before each case, in PageA's `page` target, set `window.__glows = []` and add a `MutationObserver` on `document.documentElement` (`childList`, `subtree`). It pushes `Date.now()` into `__glows` for each added element whose `style.zIndex` is `'2147483647'`. The overlay is added from the isolated world, but the DOM is shared, so the page sees it.
   - **A busy page on cue:** in PageA's `page` target, `setTimeout(() => { for (const end = Date.now() + 3000; Date.now() < end;); }, 0)` keeps PageA's main thread busy for 3 s.
   - **Green in a recording:** `ffmpeg -v error -i <file> -t 1 -vf "crop=8:ih/2:0:ih/4,scale=1:1" -f rawvideo -pix_fmt rgb24 - | xxd -p -c 3` prints one colour for each frame in the file's first second, averaged over a strip at the left edge. With no glow, every colour is close to `ffffff`. With the glow, green is well above red and blue.

   → verify each case:
   - **The ticket's case:**
     1. With the popup open, make PageA busy, then press Record straight away.
     2. The worker logs "blip failed: Error: executeScript did not answer within 2s", then `rec-start-offscreen sent`. If it logs no "blip failed", PageA ran the script in time: make it busy for longer and start again.
     3. Once PageA answers again, `__glows` is empty.
     4. Stop saves one `PageA-….webm`, and every colour ffmpeg prints for it is close to white.
   - **The same case on the code as it is now** (a copy from `git archive HEAD`, loaded unpacked), for comparison: `__glows` has one entry, later than the worker's "blip failed" warning. Note how it compares with the time of the document's `MediaRecorder state: recording` log, and whether ffmpeg prints green for any frame.
   - **A normal Record press, with PageA not busy:** `__glows` has one entry, and the worker logs no "blip failed". Stop saves one `PageA-….webm`, and every colour ffmpeg prints for it is close to white.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

- **Should the change also cover a script the page runs just before its deadline?**
  - That script shows the glow. If its answer reaches the worker only after the worker's timer has fired, the worker goes on without waiting, and the glow can still reach the recording.
  - The ticket only names a script run after its deadline, so the plan leaves this out. How often it happens depends on how long the answer takes to reach the worker, which hasn't been measured.
  - Two ways to deal with it:
    - **An earlier cutoff in the script,** for example `SCRIPT_TIMEOUT_MS - BLIP_ANIM_MS`. This narrows the gap to answers that take longer than 650 ms. A page that gets to the script in the last 650 ms before its deadline would show no glow, and the worker could wait 700 ms for nothing.
    - **Holding `rec-start-offscreen` after a blip that timed out,** until 700 ms after that blip's deadline. This closes the gap. The start would only wait when the viewport read answers within those 700 ms, so no start would wait longer than one whose page never answers either script does today.
