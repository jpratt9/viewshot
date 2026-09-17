# KAN-388: No test checks that a recording start waits for the blip's glow to finish

Ticket: https://prattsolutions.atlassian.net/browse/KAN-388 (To Do, Task, label `viewshot`, no comments). Its only blocker, KAN-365, is Done.

## What the repo does now

Line numbers are from `81bf1e6`, with a clean working tree. They match the ticket's, which were taken from the KAN-365 change before it was committed.

- **The wait** (`background.js:541`):
  - `startRecording` (`:446-484`) writes `rec` (`:458`) and awaits the blip (`:466`). After that it reads the viewport (`:474`), reads `rec` again (`:478`) and sends `rec-start-offscreen` (`:479-482`).
  - Once the blip's script has answered, `blipRecordingIndicator` waits `BLIP_ANIM_MS + 50`, which is 700 ms (`:541`). The 650 ms glow (`:515`) is over by the time the recorder is started. The comment at `:512-514` says why.
  - A script that fails, or misses its deadline, lands in the `catch` (`:532-540`), which returns without the wait.
  - In headless Chrome, while KAN-365 was checked, a normal Record press started the recorder 724 ms after the glow was added (commit message of `81bf1e6`).
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 219 tests.
  - **The fakes in `loadBg` (`:21-99`):**
    - `setTimeout` runs each timer at once and moves a fake clock on by its delay (`:78`). Only timers of `CAPTURE_TIMEOUT_MS` or `SCRIPT_TIMEOUT_MS` are held instead, until the test calls `expire()` (`:77`, `:97`). So the 700 ms wait moves the clock, and page-script deadlines don't.
    - `Date.now()` reads that clock (`:81`).
    - `executeScript` runs the script's `func` with its `args` straight away (`:57-60`).
    - `document` has no `body`, and its `createElement` returns an element with no `animate` (`:83`). The blip's script adds its element to `documentElement`, then throws at `animate` (`background.js:527`).
  - **So no start in the tests reaches the wait.** Every start whose blip script runs ends in the `catch`. That includes "a start that works tells the popup so" (`:996-1006`).
  - **The KAN-365 tests** (`:1288-1324`) call `blipRecordingIndicator` on its own, with elements that can `animate`. The second one (`:1310-1324`) goes through the wait, but only counts glows.
  - **Checked while planning:** with the wait deleted, all 219 tests still pass, as the ticket says.

## Change

One file changes: `tests/capture-errors.test.js`. The diff below was applied and tested on a copy of the repo (see "Checked while planning").

1. **`tests/capture-errors.test.js`:** a new section at the end (after `:1324`) with one test, "a start waits for the blip's glow to finish before it starts the recorder". It:
   - runs a whole start by calling `startRecording`, as the "blip failed" test does (`:231`), with the offscreen document already open;
   - uses `keepStore` (`:1051-1059`), so the start's second read of `rec` finds it;
   - gives `document` elements that can `animate`, so the blip's script runs to the end, and notes the clock's time when the glow is added;
   - notes the clock's time when `rec-start-offscreen` is sent;
   - checks that one glow was added, that `rec-start-offscreen` was sent, and that at least `BLIP_ANIM_MS` passed between the two.

   ```diff
   @@ -1322,3 +1322,25 @@ test('a blip the page runs before its deadline still shows its glow', async () =
      await blip;
      assert.strictEqual(glows.length, 1, 'the glow was skipped although the page ran the script in time');
    });
   +
   +// --- a start that doesn't wait for the blip's glow --------------------------
   +// A start waits for the edge-glow blip's glow to fade before it starts the
   +// recorder, or the glow ends up in the recording. loadBg's elements can't
   +// animate, so every start these tests ran had a blip that threw and skipped
   +// that wait: deleting it failed no test.
   +
   +test('a start waits for the blip\'s glow to finish before it starts the recorder', async () => {
   +  const bg = loadBg();
   +  const { chrome, document } = bg.ctx;
   +  keepStore(chrome); // the start reads `rec` back before it starts the recorder
   +  chrome.offscreen = { hasDocument: async () => true };
   +  const glows = [];
   +  let startedAt;
   +  document.createElement = () => ({ style: {}, animate: () => ({}) });
   +  document.documentElement.appendChild = () => glows.push(bg.ctx.Date.now());
   +  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); };
   +  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
   +  assert.strictEqual(glows.length, 1, 'the blip showed no glow');
   +  assert.ok(startedAt !== undefined, 'the recording was never started');
   +  assert.ok(startedAt - glows[0] >= vm.runInContext('BLIP_ANIM_MS', bg.ctx), 'the recorder started while the glow was still showing');
   +});
   ```

Choices:

- **A whole start, not `blipRecordingIndicator` on its own.**
  - The ticket's gap is that no start reaches the wait.
  - The recorder is started when `startRecording` sends `rec-start-offscreen` (`background.js:479-482`), so that send is what the test times.
- **The test checks that `BLIP_ANIM_MS` passed, not exactly `BLIP_ANIM_MS + 50`.** The comment at `background.js:512-514` asks for the glow to be over before the recorder starts. So the test fails when the wait is gone or shorter than the glow, without pinning the 50 ms margin.
- **Times come from `loadBg`'s clock.**
  - Only sleeps move it (`:78`), and page-script deadlines are held (`:77`). So between the glow and the send, the clock moves by the wait and nothing else.
  - The test reads `BLIP_ANIM_MS` with `vm.runInContext`, as `loadBg` reads `SCRIPT_TIMEOUT_MS` (`:91`).
- **Two more checks, so a failure says what went wrong.**
  - With no glow, or no send, the time check alone would still fail, but on `NaN`, with a message about the glow still showing.
  - "the recording was never started" is the message the KAN-350 test already uses for a start that never sends (`:1147`).
- **`loadBg`'s `document` stays as it is.** Giving every test elements that can `animate` would send every start through the 700 ms wait, and change what many existing tests run. The ticket only asks for a test of the wait.
- **No change to `background.js`, the README, the manifest or the version.** The wait already works. Only the test is missing.

Checked while planning, on a copy of the repo outside this folder (from `git archive HEAD`), with Node 24.9.0:

- **As it is now:** `npm test` passes 219 tests.
- **With the test:** all 220 tests pass.
- **With the test, and one thing changed:**

  | Change | Tests that fail | Message |
  |---|---|---|
  | The wait at `background.js:541` deleted | only the new test | "the recorder started while the glow was still showing" |
  | The wait at `background.js:541` set to `BLIP_ANIM_MS - 100` | only the new test | "the recorder started while the glow was still showing" |
  | The blip script given a deadline that has already passed (`Date.now() - 1` in `args`, `background.js:530`), so it adds no glow | the new test, and "a blip the page runs before its deadline still shows its glow" | "the blip showed no glow", and "the glow was skipped although the page ran the script in time" |
  | `keepStore` left out of the new test | only the new test | "the recording was never started" |

- **Not checked in Chrome.** Only a test changes.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` passes all 220 tests.
2. Check that the new test catches a start that doesn't wait for the glow, on a copy of the repo outside this folder that has the test in it.
   → verify: with the wait at `background.js:541` deleted, `npm test` runs 220 tests. 219 pass, and "a start waits for the blip's glow to finish before it starts the recorder" fails with "the recorder started while the glow was still showing". With the wait set to `BLIP_ANIM_MS - 100` instead, the same test fails with the same message.
3. Check that nothing else changed.
   → verify: `git status --short` lists only `tests/capture-errors.test.js` and this plan.

## Open questions

None.

- The ticket names the gap: deleting the wait at `background.js:541` fails no test. It also names the cause: `loadBg`'s elements can't `animate`.
- It doesn't say how exact the check should be. The plan checks for `BLIP_ANIM_MS`, the glow's length, which is what the comment above the blip asks for.
