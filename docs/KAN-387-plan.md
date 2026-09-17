# KAN-387: A blip the page runs just before its deadline can still put the glow into the recording

Ticket: https://prattsolutions.atlassian.net/browse/KAN-387 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-365, is Done.

## What the repo does now

Line numbers are from the working tree, which carries the uncommitted KAN-398 change (`9349bbd` plus that change; it adds 3 lines above the blip, and touches nothing this plan touches).

- **The blip** (`background.js:512-545`):
  - `startRecording` awaits it (`:469`) after it writes `rec` (`:461`), and the viewport read and the recorder come after it (`:477-486`).
  - Its script (`:523-532`) adds an overlay with a green inset glow and fades it in and out over `BLIP_ANIM_MS`, 650 ms (`:518`).
  - KAN-365 (`81bf1e6`) tells the script its deadline through `args` (`:533`), and the script returns before it adds the overlay once that has passed (`:526`).
  - Once the script has answered, the worker waits `BLIP_ANIM_MS + 50` (`:544`), so the glow is gone before the recorder starts.
- **The deadline** (`scriptWithTimeout`, `:109-115`): races `executeScript` against `sleep(SCRIPT_TIMEOUT_MS)`, 2 s (`:108`). When the sleep wins, the blip's `catch` (`:535-543`) logs "blip failed" and returns **without** the 700 ms wait.
- **The gap this ticket names:** a page that runs the script just *before* its deadline passes the `:526` check and shows the glow. If its answer reaches the worker after the worker's timer has fired, the worker is already in that `catch`: it skips the wait, `startRecording` goes on to `getViewport` (`:477`) and `rec-start-offscreen` (`:482-485`), and the recorder can start inside the glow's 650 ms.
- **Tests** (`tests/capture-errors.test.js`, 1413 lines): `npm test` passes 223 tests.
  - `:1296-1332` covers a script run after its deadline (no glow) and one run before it (glow shown) — both call `blipRecordingIndicator` directly.
  - `:1334-1356` covers a start waiting out a glow the blip **answered** for.
  - **No test covers a blip that shows the glow and then times out.** The KAN-350 tests (`:1131-1186`) have blips the page never runs at all.
  - The fakes in `loadBg` (`:21-99`): `executeScript` runs the script's `func` with its `args` straight away (`:57-60`); `Date.now()` reads a fake clock moved by sleeps and `tick()`; a `setTimeout` of exactly `SCRIPT_TIMEOUT_MS` or `CAPTURE_TIMEOUT_MS` is held until `expire()`; any other sleep moves the clock and runs at once.
- **Not reproduced in Chrome.** As the ticket says, this was found while planning KAN-365.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

This takes the ticket's second option — **holding `rec-start-offscreen` after a blip that timed out, until 700 ms after that blip's deadline** — because the ticket says it closes the gap where the first option only narrows it. See "Choices" for what the first option would cost instead.

1. **`background.js`:** `blipRecordingIndicator` answers with the moment its glow is over, and `startRecording` holds the recorder until then. The wait sits after the viewport read, so it overlaps it: a page busy enough to miss the blip's deadline also takes its time over the viewport read, and that time now counts towards the 700 ms.

   ```diff
   @@ -466,7 +466,7 @@ async function startRecording(streamId, opts, tabId) {
      // where injection fails, blipRecordingIndicator returns immediately and we
      // skip straight to recording — the badge + Chrome's own blue capture border
      // are still visible to the user as recording-active cues.
   -  if (tab) await blipRecordingIndicator(tab.id);
   +  const blipOver = tab ? await blipRecordingIndicator(tab.id) : 0;
      // Query the captured tab's ACTUAL viewport (innerWidth/innerHeight) — NOT
      // chrome.tabs.Tab.width/height, which reports the outer window dims (tab
      // strip + omnibox + bookmarks bar + status bar all included). tabCapture
   @@ -475,6 +475,10 @@ async function startRecording(streamId, opts, tabId) {
      // at the bottom). innerWidth/innerHeight × devicePixelRatio gives the
      // physical pixels that match what tabCapture actually delivers.
      const dims = await getViewport(tab?.id);
   +  // A blip that ran out of time may have shown its glow just before its
   +  // deadline, and the wait for it to fade was skipped along with the blip.
   +  // The viewport read above has already used up part of that wait.
   +  if (blipOver > Date.now()) await sleep(blipOver - Date.now());
      // Stop removes `rec`, and it can land while the blip or the viewport read is
      // still under way: up to two deadlines on a page that never answers. A
      // recorder started after that would run on with nothing that can stop it.
   @@ -516,7 +520,10 @@ async function getViewport(tabId) {
    // itself shows up in the first ~Ns of the recorded output (canonical Screenity
    // pattern: animate UI cue → wait for it to fade → start capture on clean DOM).
    const BLIP_ANIM_MS = 650;
   +// Answers the moment the page's glow is over, for a glow the page showed just
   +// before its deadline: 0 whenever the wait below has already covered it.
    async function blipRecordingIndicator(tabId) {
   +  const deadline = Date.now() + SCRIPT_TIMEOUT_MS; // when the start stops waiting for the script
      try {
        await scriptWithTimeout({
          target: { tabId },
   @@ -530,7 +537,7 @@ async function blipRecordingIndicator(tabId) {
            o.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: animMs, easing: 'ease-out' })
              .onfinish = () => o.remove();
          },
   -      args: [BLIP_ANIM_MS, Date.now() + SCRIPT_TIMEOUT_MS],
   +      args: [BLIP_ANIM_MS, deadline],
        });
      } catch (e) {
        // chrome:// URLs and similar refuse executeScript — skip the wait so we
   @@ -539,9 +546,14 @@ async function blipRecordingIndicator(tabId) {
        // Expected on those pages, so only a warning: chrome://extensions lists
        // every console.error from the worker as an extension error.
        console.warn('[ViewShot] blip failed:', e);
   -    return;
   +    // A page that refuses scripts fails at once and shows nothing. A page that
   +    // ran out of time may have run the script just before its deadline, so its
   +    // glow can still be on screen: the start has to hold the recorder until the
   +    // animation is over.
   +    return Date.now() < deadline ? 0 : deadline + BLIP_ANIM_MS + 50;
      }
      await new Promise((r) => setTimeout(r, BLIP_ANIM_MS + 50));
   +  return 0;
    }
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end (after `:1413`) with two tests, both driving `startRecording`, as the existing "a start waits for the blip's glow to finish" test does.
   - **"a start holds the recorder for a glow the page showed just before the blip's deadline":** the page runs the blip script 100 ms before its deadline, so the glow shows, and its answer never arrives; the deadline then passes. The recorder must not start until at least `BLIP_ANIM_MS` after the glow.
   - **"a start on a page that refuses scripts holds the recorder for nothing":** `scriptFails` makes `executeScript` throw at once, as a chrome:// page does. The recorder starts with no wait at all. This one passes today; it's there to keep the hold off the pages that can never show a glow.

   ```diff
   @@ -1411,3 +1411,41 @@ test('the frame cap still flashes MAX when it ends a recording', async () => {
      assert.deepStrictEqual(sent, ['rec-stop-offscreen'], 'the recording was never stopped');
      assert.strictEqual(store.rec, undefined, 'the recording was left marked as running');
    });
   +
   +// --- a blip the page runs just before its deadline --------------------------
   +// A start stops waiting for the edge-glow blip at its deadline. A page that ran
   +// the script just before that had already shown the glow, and the start skipped
   +// the wait for it to fade along with the blip: the recorder started mid-glow.
   +
   +test('a start holds the recorder for a glow the page showed just before the blip\'s deadline', async () => {
   +  const bg = loadBg();
   +  const { chrome, document } = bg.ctx;
   +  keepStore(chrome);
   +  chrome.offscreen = { hasDocument: async () => true };
   +  const glows = [];
   +  let startedAt;
   +  document.createElement = () => ({ style: {}, animate: () => ({}) });
   +  document.documentElement.appendChild = () => glows.push(bg.ctx.Date.now());
   +  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); };
   +  const run = chrome.scripting.executeScript;
   +  let calls = 0;
   +  // The page runs the blip 100 ms before its deadline, and its answer never arrives.
   +  chrome.scripting.executeScript = (o) => (++calls === 1
   +    ? new Promise(() => { bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) - 100); run(o); })
   +    : run(o));
   +  const start = bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
   +  await settle();
   +  bg.tick(100);
   +  bg.expire(); // the start stops waiting for the blip
   +  await start;
   +  assert.strictEqual(glows.length, 1, 'the page showed no glow');
   +  assert.ok(startedAt - glows[0] >= vm.runInContext('BLIP_ANIM_MS', bg.ctx), 'the recorder started while the glow was still showing');
   +});
   +
   +test('a start on a page that refuses scripts holds the recorder for nothing', async () => {
   +  const bg = loadBg({ scriptFails: true });
   +  const { chrome } = bg.ctx;
   +  keepStore(chrome);
   +  chrome.offscreen = { hasDocument: async () => true };
   +  let startedAt;
   +  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); };
   +  const pressed = bg.ctx.Date.now();
   +  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
   +  assert.strictEqual(startedAt, pressed, 'the recorder waited out a glow the page never showed');
   +});
   ```

Choices:

- **The ticket's second option, not its first.** The first option (an earlier cutoff, `SCRIPT_TIMEOUT_MS - BLIP_ANIM_MS`) is a smaller diff — one expression in `args` — but it pays for the gap with the blip itself: a page that gets to the script in the last 650 ms before its deadline shows no glow at all, and the start still waits 700 ms for it. This option keeps the glow on every page that can show one, and only waits when a glow was actually shown.
- **The wait goes after the viewport read, not inside the blip's `catch`.** Putting it in the `catch` would be two lines fewer, but it would then run before `getViewport` and add its full 700 ms to a start that is already late. After the viewport read, the read's own time counts towards it: on a page busy enough to miss the blip's deadline, the read runs out its own 2 s deadline, and `blipOver` is long past by then, so the start waits nothing at all. This is the ticket's own reasoning for why this option costs nothing in the worst case.
- **`blipOver` is a moment, not a duration.** The wait is `blipOver - Date.now()` at the point of use, so whatever the viewport read took is already subtracted.
- **The `catch` tells a timeout from a refusal by the clock** (`Date.now() < deadline`), not by the error's text. A page that refuses scripts rejects at once, well inside the deadline; only the timeout can leave the worker there with the deadline passed. Reading `e.message` would tie the blip to the wording in `scriptWithTimeout` (`:112`).
- **`deadline` is computed once, at the top of the function.** It was already being computed inline for `args` (`:533`); hoisting it lets the `catch` compare against the same value, and keeps the page's deadline no later than the worker's (the worker's timer starts after `executeScript` is called).
- **`sleep` is the repo's own helper** (`:2`), already used for the capture gate and both script deadlines.
- **Only the blip changes.** `getViewport`'s script also runs late on such a page, but it only reads the window size and shows nothing.
- **The comment at `:464-468` still holds:** on a chrome:// page the blip returns immediately and the start goes straight to recording. The new guard is what keeps that true.
- **No README, manifest or version change.** The README doesn't mention the blip.

Checked while planning, on a copy of the working tree outside this folder (`tar` of the tree, minus `.git`), with Node 24.9.0:

- **As it is now:** `npm test` passes 223 tests.
- **Test change only:** 225 tests run. 224 pass, and "a start holds the recorder for a glow the page showed just before the blip's deadline" fails with "the recorder started while the glow was still showing".
- **Both changes:** all 225 tests pass.
- **Both changes, with one piece left out** (each time, only the named test fails):

  | Piece | Failing test | Message |
  |---|---|---|
  | The `if (blipOver > Date.now())` wait in `startRecording` | "a start holds the recorder for a glow the page showed just before the blip's deadline" | "the recorder started while the glow was still showing" |
  | The `Date.now() < deadline ? 0 :` guard in the `catch` | "a start on a page that refuses scripts holds the recorder for nothing" | "the recorder waited out a glow the page never showed" |
  | The `return 0` after the 700 ms wait | *none* | — (an answered blip returns `undefined` instead, and `undefined > Date.now()` is false, so it behaves the same. It's there for the contract in the comment; say the word and it goes.) |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 225 tests. 224 pass, and "a start holds the recorder for a glow the page showed just before the blip's deadline" fails with "the recorder started while the glow was still showing". No other test fails.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 225 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page with a white background (PageA).
   - **Setup:** the setup from step 3 of `docs/KAN-365-plan.md` (which takes it from `docs/KAN-372-plan.md`): headless Chrome over CDP with `Extensions.loadUnpacked`; PageA as a tab target; popups opened with `Extensions.triggerAction` and buttons pressed with `Runtime.evaluate` and `userGesture: true`; a trace of the badge and `rec` in the worker; Format set to WebM and Name to `{title}-{time}`.
   - **A record of the glow in PageA:** as in KAN-365's step 3 — `window.__glows = []` and a `MutationObserver` on `document.documentElement` that pushes `Date.now()` for each added element whose `style.zIndex` is `'2147483647'`.
   - **The script just before its deadline, answering late:** in PageA's `page` target, (a) keep the main thread busy for 1.9 s from the Record press (`setTimeout(() => { for (const end = Date.now() + 1900; Date.now() < end;); }, 0)`), so the script runs just inside its 2 s deadline, and (b) have the `MutationObserver` above burn 300 ms before it returns, so the script's answer reaches the worker after the deadline has passed. Both run in the page's own world; the overlay is added from the isolated world, but the DOM is shared.
   - **Green in a recording:** `ffmpeg -v error -i <file> -t 1 -vf "crop=8:ih/2:0:ih/4,scale=1:1" -f rawvideo -pix_fmt rgb24 - | xxd -p -c 3` prints one colour per frame in the file's first second, averaged over a strip at the left edge. With no glow every colour is close to `ffffff`; with the glow, green is well above red and blue.

   → verify each case:
   - **The ticket's case:** the worker logs "blip failed: Error: executeScript did not answer within 2s", `__glows` has one entry stamped *before* that warning (the page did show the glow), and the document's `MediaRecorder state: recording` log is at least 650 ms after that entry. Stop saves one `PageA-….webm`, and every colour ffmpeg prints for it is close to white. If the worker logs no "blip failed", the answer got back in time: raise the observer's 300 ms and start again.
   - **The same case on the code as it is now** (a copy of the current tree, loaded unpacked), for comparison: the recorder starts inside the glow's 650 ms, and ffmpeg prints green for some of the first second's frames.
   - **A chrome:// page:** press Record on `chrome://version`. The worker logs "blip failed: Error: Cannot access a chrome:// URL" and `rec-start-offscreen sent` within a few ms of it — no 700 ms, no 2.7 s. Stop saves a file.
   - **A normal Record press, with PageA not busy:** `__glows` has one entry, the worker logs no "blip failed", and the recorder starts at least 650 ms after the glow. Stop saves one `PageA-….webm`, and every colour ffmpeg prints is close to white.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js`, this plan, and the uncommitted KAN-398 change already in the tree.

## Open questions

- **Should the hold cover a glow whose animation hasn't started yet?** `o.animate()` starts on the page's next frame. A page busy enough to miss the blip's deadline may not produce that frame for a while, so the glow can become visible later than `deadline + 650` — after the hold is over. Neither option in the ticket covers this, and it hasn't been measured; the plan leaves it out. Closing it would mean the script reporting back when its animation actually finished, which the timed-out path has no channel for.
- **Is this worth a `GIF` cross-check?** The hold sits in `startRecording`, so it applies to both formats. The Chrome check in step 3 uses WebM only, as KAN-365's did.

## Noticed while planning, not changed

- The uncommitted KAN-398 change (`background.js`, `tests/capture-errors.test.js`) and its plan doc are still in the working tree, and its ticket is already Done. Committing it before this change starts would keep the two diffs apart; this plan doesn't depend on that.
