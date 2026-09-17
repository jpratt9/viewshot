# KAN-416: A page that never runs an injected script leaves a screenshot hung and the page scrolled with its scrollbar hidden

Ticket: https://prattsolutions.atlassian.net/browse/KAN-416 (To Do, Task, labels `bug` and `viewshot`, no comments, blocked by KAN-409 which is Done).

## What the repo does now

Line numbers are from `dfd39ab`, with a clean working tree.

- **The fence exists and the capture path doesn't use it.** `scriptWithTimeout` (`background.js:113-118`) races `chrome.scripting.executeScript` against `sleep(SCRIPT_TIMEOUT_MS)` (`:112`, 2000). Its only two callers are in `startRecording` — the blip (`:565`) and the viewport read (`:591`).
- **Every injection a capture makes is a bare call.** Eight of them, all reached from `runCapture` (`:129`):

  | Line | In | Swallows its own errors? |
  |---|---|---|
  | `:216` | `pageIsDrawing` → `reportFrame` | no |
  | `:227` | `scrollPageTo` → `scrollAndReport` | no |
  | `:234` | `captureFullPage` → `measurePage` | no |
  | `:304` | `markStickyOnFirstScreen` | no |
  | `:319` | `setFixedHidden` | no |
  | `:355` | `setScrollbarHidden` | yes (`try/catch`, `:354-370`) |
  | `:389` | `cancelRegion` | yes (`try/catch`, `:385-394`) |
  | `:406` | `captureRegion` → `files: ['region.js']` | no |

- **A page that never runs them hangs the capture.** `executeScript` answers only once the page has run the script, so a blocked main thread means the promise never settles. `runCapture` never settles either: `captureFullPage`'s `finally` (`:290-293`) never restores the fixed/sticky elements or the scroll offset, and `runCapture`'s `finally` (`:154-156`) never removes `__shotHideScrollbar`. No rejection, so `captureFailed` (`:124`) never flashes `!`.
- **The `try/catch` at `:354` and `:389` doesn't help.** It catches a *rejection* — a page that refuses scripts, e.g. `chrome://` — not a call that never settles. `cancelRegion` is the first thing `runCapture` does, on every mode, so a blocked page hangs there before anything else is tried.
- **Tests** (`npm test` passes 239):
  - `tests/capture-errors.test.js` already has the machinery: `scriptFails` for a page that refuses scripts (`:58`), `captureHangs` for a `captureVisibleTab` that never answers (`:50`), and a `deadlines` array that parks the `captureTimeout`/`scriptTimeout` sleeps (`:77`) until a test calls `expire()` (`:97`).
  - `tests/fullpage.test.js:67`, `tests/region-cancel.test.js:58` and `tests/shortcut-format.test.js:47` collapse every sleep except `CAPTURE_TIMEOUT_MS`, which they read out of the sandbox.
  - Nothing anywhere covers a script that never answers on a capture.

## Change

Five files change: `background.js` and four test files. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

The rule this takes, from the ticket: **every script a capture runs in the page goes behind `scriptWithTimeout`**, so a page that won't run one fails the capture the way a page that refuses one does, and the `finally` gets to put the page back.

The deadline is its own constant rather than `SCRIPT_TIMEOUT_MS`. The ticket asks for that check: 2 s is what a recording's ~10 s stream id allows, and a capture has no such clock — the only cost of waiting is the user waiting. `CAPTURE_SCRIPT_TIMEOUT_MS` is 5000, the same as `CAPTURE_TIMEOUT_MS`, which is already what this path tolerates from a `captureVisibleTab` that never answers. See the open question.

1. **`background.js`:** a deadline, a parameter, and eight call sites.

   ```diff
   @@ -65,0 +66,8 @@
    const CAPTURE_TIMEOUT_MS = 5000;
   +// The same, for the scripts a capture runs in the page. A page whose main
   +// thread never frees up never runs them, and an executeScript that never
   +// answers left runCapture pending for good: the page stayed scrolled with its
   +// headers and scrollbar hidden and no badge ever flashed. Longer than
   +// SCRIPT_TIMEOUT_MS, which a recording's 10s stream id sets; a capture has no
   +// such clock, and a page busy for a few seconds should still get its shot.
   +const CAPTURE_SCRIPT_TIMEOUT_MS = 5000;
   @@ -113,4 +121,4 @@
   -function scriptWithTimeout(injection) {
   +function scriptWithTimeout(injection, ms = SCRIPT_TIMEOUT_MS) {
      return Promise.race([
        chrome.scripting.executeScript(injection),
   -    sleep(SCRIPT_TIMEOUT_MS).then(() => { throw new Error(`executeScript did not answer within ${SCRIPT_TIMEOUT_MS / 1000}s`); }),
   +    sleep(ms).then(() => { throw new Error(`executeScript did not answer within ${ms / 1000}s`); }),
      ]);
    }
   ```

   Then each of the eight sites in the table above swaps `chrome.scripting.executeScript({…})` for `scriptWithTimeout({…}, CAPTURE_SCRIPT_TIMEOUT_MS)`. Nothing else in those functions changes. For example:

   ```diff
    async function scrollPageTo(tab, y) {
   -  const [{ result }] = await chrome.scripting.executeScript({
   +  const [{ result }] = await scriptWithTimeout({
        target: { tabId: tab.id }, func: scrollAndReport, args: [y],
   -  });
   +  }, CAPTURE_SCRIPT_TIMEOUT_MS);
      return result || 0;
    }
   ```

   ```diff
    async function captureRegion(tab) {
   -  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['region.js'] });
   +  await scriptWithTimeout({ target: { tabId: tab.id }, files: ['region.js'] }, CAPTURE_SCRIPT_TIMEOUT_MS);
   ```

2. **`tests/capture-errors.test.js`:** a page that never runs a script, and two tests.

   ```diff
   @@ -21,1 +21,1 @@
   -function loadBg({ captureFails = null, captureHangs = null, scriptFails = false, noActiveTab = false } = {}) {
   +function loadBg({ captureFails = null, captureHangs = null, scriptFails = false, scriptHangs = false, noActiveTab = false } = {}) {
   @@ -27,0 +27,1 @@
      let scriptTimeout; // SCRIPT_TIMEOUT_MS, likewise
   +  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
   @@ -58,0 +59,1 @@
          if (scriptFails) throw new Error('Cannot access a chrome:// URL');
   +      if (scriptHangs) return new Promise(() => {}); // main thread blocked: the page never runs it
   @@ -77,1 +79,1 @@
   -      if (ms === captureTimeout || ms === scriptTimeout) { deadlines.push(fn); return; }
   +      if (ms === captureTimeout || ms === scriptTimeout || ms === pageScriptTimeout) { deadlines.push(fn); return; }
   @@ -91,0 +94,1 @@
      scriptTimeout = vm.runInContext('SCRIPT_TIMEOUT_MS', context);
   +  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
   @@ (appended)
   +// A page whose main thread never frees up accepts an injection and never runs
   +// it. Every script a capture runs in the page was unfenced, so the call never
   +// answered: runCapture stayed pending for good, its finally never put the page
   +// back, and no badge ever said so.
   +
   +test('a full page shot of a page that never runs a script flashes the badge', async () => {
   +  const bg = loadBg({ scriptHangs: true });
   +  bg.message({ type: 'capture', mode: 'fullpage', opts: OPTS, tabId: TAB.id });
   +  await settle();
   +  for (let i = 0; i < 4; i++) { bg.expire(); await settle(); } // each injection's deadline in turn
   +  assert.deepStrictEqual(bg.badges, ['!'], 'the capture hung instead of failing');
   +  assert.strictEqual(bg.shots.length, 0, 'shot a page it never managed to measure');
   +});
   +
   +test('a cosmetic script that never answers does not hold up the shot', async () => {
   +  const bg = loadBg({ scriptHangs: true });
   +  bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id });
   +  await settle();
   +  for (let i = 0; i < 4; i++) { bg.expire(); await settle(); } // the cancel and the scrollbar hide
   +  assert.strictEqual(bg.shots.length, 1, 'the scrollbar hide held the shot up for good');
   +  assert.deepStrictEqual(bg.badges, [], 'flashed for a script whose failure is ignored');
   +});
   ```

3. **`tests/fullpage.test.js`, `tests/region-cancel.test.js`, `tests/shortcut-format.test.js`:** park the new deadline, the way each already parks `CAPTURE_TIMEOUT_MS`. Same three lines in each:

   ```diff
      let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
   +  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
   -    setTimeout: (fn, ms) => { if (ms !== captureTimeout) fn(); },
   +    setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
      captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
   +  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
   ```

   **This is not cosmetic.** Those sandboxes collapse every sleep they don't recognise, so an unparked `CAPTURE_SCRIPT_TIMEOUT_MS` sleep fires at once and races the injection. It passes today only because 5000 happens to equal `CAPTURE_TIMEOUT_MS`: setting the new constant to 4000 with the parking left out fails **27 tests** across the stitch, region and shortcut suites.

Choices:

- **All eight sites, not the six the ticket lists.** `cancelRegion` (`:389`) runs at the top of every capture, so leaving it bare leaves the same hang for every mode — measured: with only `cancelRegion` and `setScrollbarHidden` left bare, both new tests fail. `region.js` (`:406`) is the same call in the same path; its injection resolving is separate from the drag the user then makes, so fencing it doesn't put a clock on the selection (that is KAN-209).
- **The two swallowing call sites keep swallowing.** A timed-out scrollbar hide or region cancel is still ignored, so the shot is still taken — the second new test pins it. Only the injections whose result the capture needs turn a timeout into a failed capture.
- **A default parameter, not a second function.** `scriptWithTimeout(injection, ms = SCRIPT_TIMEOUT_MS)` leaves both recording callers untouched and needs no new helper.
- **The constant sits with `CAPTURE_TIMEOUT_MS`,** not with `SCRIPT_TIMEOUT_MS`: it is a capture deadline, and the two are deliberately the same 5 s.
- **Worst case on a hung page is the sum of the deadlines it reaches** — `cancelRegion`, then `setScrollbarHidden`, then `measurePage`, so about 15 s before the `!` on a full page. Bounded, where today it is forever. Failing the whole capture at the first timeout would be quicker and is not what the ticket asks for.
- **No README, manifest or version change.**

Checked while planning, on a copy of the tree outside this folder (`git archive HEAD`), with Node 24:

- **As it is now:** `npm test` passes 239.
- **All five files changed:** 241 tests, 241 pass.
- **With one piece left out:**

  | Piece | Failing tests |
  |---|---|
  | The fence on `cancelRegion` + `setScrollbarHidden` | both new tests — the capture hangs at the first injection, before the shot |
  | The fence on `measurePage` | "a full page shot of a page that never runs a script flashes the badge" |
  | The parking in the three sandboxes (with the constant set to 4000 rather than 5000) | 27, across `fullpage`, `region-cancel` and `shortcut-format` |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `background.js` change.
   → verify: `npm test` still passes 239. (The code goes first: the test sandboxes read `CAPTURE_SCRIPT_TIMEOUT_MS` out of the context, and `vm.runInContext` throws a ReferenceError if the constant isn't there yet.)
2. Make the four test-file changes.
   → verify: `npm test` runs 241 and passes 241. Then, as a check that the parking is real rather than a coincidence, set `CAPTURE_SCRIPT_TIMEOUT_MS` to 4000 for one run: it must still pass 241. Put 5000 back.
3. Check it in Chrome 153 with the repo loaded unpacked, over CDP — the setup from "Checked in Chrome" in `docs/KAN-409-plan.md`. PageA: white, 3000 px, a 60 px `position: sticky; top: 0` green (`#22cc22`) header, a paragraph every 200 px.
   → verify each case:
   - **A page that blocks its main thread.** In PageA, run `setTimeout(() => { for (const end = Date.now() + 20000; Date.now() < end;); }, 0)` to block for 20 s, then press Full page while it is blocked. The capture must end with a red `!` and **no file**, within about 15 s. On `dfd39ab` the same run never finishes: no badge, no file, and the worker's `runCapture` never settles (trace what it settled to, as the KAN-409 checks did).
   - **The page is put back.** After that failure, and once PageA's main thread frees up, the page is at `scrollTop` 0 with its header visible and no `__shotHideScrollbar` — the `finally` ran. This is the user-visible half of the ticket, so read it back from the page rather than inferring it.
   - **Nothing changes for a page that answers.** Full page on an idle PageA saves the same image as `dfd39ab` does: same block hashes, green once at the top, no badge.
   - **A page that refuses scripts is unaffected.** Visible on `https://chromewebstore.google.com/` still saves a PNG — `setScrollbarHidden`'s `catch` sees a rejection, not a timeout, exactly as before.

## Open questions

1. **Is 5 s the right deadline, and is failing a slow page acceptable?** The ticket asks for the check and doesn't answer it. The trade is real in both directions: a page whose main thread is busy for longer than the deadline now ends with `!` where today it would eventually have produced a correct capture, and the repo's own checks have used a page deliberately busy for 3 s (`docs/KAN-365-plan.md`). 5 s clears that case and matches what the path already waits for a `captureVisibleTab` that never answers; 2 s (reusing `SCRIPT_TIMEOUT_MS`, which would make this a smaller change with no new constant and no parameter) would not. If failing a slow page is the worse outcome, the deadline should go up rather than down — the bug being fixed is "forever", so any bound fixes it.
