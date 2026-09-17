# KAN-409: Full page still saves repeated screens when the window stops drawing near the end of the stitch

Ticket: https://prattsolutions.atlassian.net/browse/KAN-409 (To Do, Task, labels `bug` and `viewshot`, no comments, blocked by KAN-404 which is Done).

## What the repo does now

Line numbers are from `2ae7fb2`, with a clean working tree.

- **The guard KAN-404 left** (`background.js:254-256`), inside `captureFullPage`'s slice loop, after the tab guard and before the draw:

  ```js
  repeats = url === prev ? repeats + 1 : 0;
  if (repeats >= 2) throw new Error('Full page stopped: the window is not drawing (minimized?)');
  prev = url;
  ```

  `prev` and `repeats` are declared at `:222`. The counter resets on any slice that differs, so the stitch has to take **three identical slices** before it stops.
- **Why the threshold is two:** a flat stretch of page shoots the same bytes at two offsets on a window that is drawing perfectly well — the scrollbar is hidden by default and fixed/sticky elements are hidden from slice 2 on. Measured for KAN-404: a 2860 px page with an 1800 px gap. One repeat had to be tolerated.
- **So the tail is unguarded.** On a page of N slices, a window that stops drawing at slice N or N-1 never reaches two repeats: the loop runs out, `filled` (`:255` → now `:249`) covers the whole canvas, `runCapture` downloads it (`:144`), and there is no error and no badge. The image ends with one or two slices repeating the screen before them.
- **The same rule costs the flat page too** (KAN-410): more than about two viewports of identical pixels in a row and the whole capture is thrown away with a `!`.
- **What the stitch already injects:** `measurePage` (`:172`), `scrollAndReport` (`:186`) — top-level named functions, serialized standalone by `executeScript`, called through thin wrappers like `scrollPageTo` (`:202`) — plus `markStickyOnFirstScreen` (`:283`) and `setFixedHidden`. `args` is how a value reaches an injected function (`setFixedHidden` passes `hide`); it cannot close over a worker const.
- **Deadlines already in the file:** `CAPTURE_MIN_GAP_MS`, `CAPTURE_TIMEOUT_MS` (`:65-66`), `SCRIPT_TIMEOUT_MS` (`:108`, used only by the recording path's `scriptWithTimeout`).
- **Tests** (`tests/fullpage.test.js`, 371 lines): `npm test` passes 238.
  - `load()` (`:43`) takes `frozen` (the window never draws: `captureVisibleTab` hands back the frame it last returned, `:94`) and `sameAt` (the slices a flat stretch shoots identically).
  - The executeScript fake (`:81-84`) returns `func.apply(...)` **without awaiting it**, so an injected function that returns a promise would hand back the promise object.
  - There is no `requestAnimationFrame` in the sandbox.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

The rule this takes, from the ticket: **stop comparing pixels; ask the page for a frame before each slice and stop when it can't produce one.** A window that isn't presenting produces no frames, so `requestAnimationFrame` never runs — at any slice, including the last two. No page can fail it for being flat, so the flat-stretch limit goes with it (KAN-410, whose own fix direction is this same change).

The report answers with a timer as well as a frame, so it always answers: timers keep running in a window that isn't presenting. Without that fallback the injected promise would never settle and the capture would hang, since this path uses plain `executeScript` rather than `scriptWithTimeout` — as `measurePage`, `scrollAndReport` and the sticky passes all do.

1. **`background.js`:** a deadline, the injected report and its wrapper, the call, and the removal of the pixel rule.

   ```diff
   @@ -108,1 +108,6 @@
   +// How long the page gets to produce a frame before the stitch gives up on it.
   +// A window that is drawing answers in about 16ms; one that isn't never will,
   +// and the wait is paid once, on the slice the capture stops at.
   +const FRAME_TIMEOUT_MS = 1000;
    const SCRIPT_TIMEOUT_MS = 2000;
   @@ -199,0 +205,18 @@ (just above "Scroll to y and report where the page ACTUALLY landed")
   +// Ask the page for a frame. A window that isn't drawing - minimized, occluded -
   +// presents none, so requestAnimationFrame never runs and the timer answers false
   +// instead: timers keep running in a window that isn't presenting, which is what
   +// makes them the half of this that can always answer. Runs in the page, so it
   +// can't read FRAME_TIMEOUT_MS and is handed it.
   +function reportFrame(ms) {
   +  return new Promise((resolve) => {
   +    requestAnimationFrame(() => resolve(true));
   +    setTimeout(() => resolve(false), ms); // whichever lands first wins; the other is a no-op
   +  });
   +}
   +
   +async function pageIsDrawing(tab) {
   +  const [{ result }] = await chrome.scripting.executeScript({
   +    target: { tabId: tab.id }, func: reportFrame, args: [FRAME_TIMEOUT_MS],
   +  });
   +  return result === true;
   +}
   @@ -222,1 +240,1 @@
   -  let hid = false, landed = 0, prev = '', repeats = 0;
   +  let hid = false, landed = 0;
   @@ -238,0 +256,9 @@
          await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   +      // captureVisibleTab hands back the last frame the window presented. A
   +      // window that isn't drawing - minimized, occluded - presents none, so
   +      // every slice comes back as the frame before it. The offsets still
   +      // advance and the tab is still the one showing, so neither guard here
   +      // catches it, and the stitch drew that one screen at every offset and
   +      // saved a tall image that is the same screen over and over, with nothing
   +      // to say so. Ask the page for a frame rather than compare the pixels: a
   +      // flat stretch of page shoots the same bytes twice while drawing fine.
   +      if (!await pageIsDrawing(tab)) throw new Error('Full page stopped: the window is not drawing (minimized?)');
          const url = await captureVisible(tab.windowId);
   @@ -245,9 +272,0 @@ (the whole KAN-404 comment block and the three lines under it)
   -      // captureVisibleTab hands back the last frame the window presented. A
   -      // ... (nine comment lines)
   -      repeats = url === prev ? repeats + 1 : 0;
   -      if (repeats >= 2) throw new Error('Full page stopped: the window is not drawing (minimized?)');
   -      prev = url;
   ```

2. **`tests/fullpage.test.js`:** the fake window needs a frame to hand out, `frozen` becomes the slice it stops at, and the rule tests change with the rule.

   ```diff
   @@ -43,1 +43,1 @@
   -function load({ ..., frozen = false, sameAt = [] }) {
   +function load({ ..., frozenAt = 0, sameAt = [] }) {
   @@ -67,0 +67,3 @@ (next to the document fake)
        document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
   +    // A window that is drawing runs the callback; from frozenAt on it never does.
   +    // The probe for slice k runs before capture k, so captureAt is one short.
   +    requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
   @@ -81,4 +84,5 @@
            executeScript: async ({ func, args }) => {
              scriptCalls.push(func.name || 'anon');
   -          return [{ result: func.apply(null, args || []) }];
   +          // Chrome awaits a function that returns a promise; the frame report does.
   +          return [{ result: await func.apply(null, args || []) }];
            },
   @@ -94,1 +98,1 @@
   -          if (frozen || sameAt.includes(captureAt.length)) return last;
   +          if ((frozenAt && captureAt.length >= frozenAt) || sameAt.includes(captureAt.length)) return last;
   @@ -317,1 +321,1 @@ ("runs no sticky pass on a page that fits one screen")
   -  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'scrollAndReport'], ...);
   +  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], ...);
   @@ -335,7 +339,14 @@
    test('stops rather than stitch the same frame down the canvas', async () => {
   -  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), frozen: true });
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), frozenAt: 1 });
      await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
   -  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534], 'stitched the repeated frame down the canvas');
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [], 'stitched a frame the window never drew');
    });
   +
   +test('stops when the window stops drawing on the last slice', async () => {
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), frozenAt: 4 });
   +  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068],
   +    'saved a last slice repeating the one before it');
   +});
   @@ -345,1 +356,1 @@ ("puts the page back when the window stops drawing")
   -  const { ctx } = load({ de: el(767, 767), body, fixed: [header], frozen: true });
   +  const { ctx } = load({ de: el(767, 767), body, fixed: [header], frozenAt: 2 });
   @@ -365,4 +376,7 @@ (the old threshold test, replaced)
   -test('stops once the same frame comes back twice over', async () => {
   -  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), sameAt: [3, 4] });
   -  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
   -});
   +test('saves a page flat enough to shoot the same slice three times over', async () => {
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), sameAt: [2, 3, 4] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068, 4570],
   +    'a page of one flat colour lost the whole capture');
   +});
   ```

Choices:

- **The report runs before the capture, not after** — after the settle sleep, so what it proves is that the page painted *since the scroll*. It is also why a window frozen from the start now stops with nothing drawn at all, where the pixel rule needed two slices first.
- **It runs on every slice, including the first.** A window already stopped before the stitch began hands back a stale first screen too; a slice-1 check costs one round trip and catches it. It is also simpler than an `i > 0` condition.
- **`reportFrame` is a top-level named function**, like `measurePage` and `scrollAndReport`, with a `pageIsDrawing` wrapper like `scrollPageTo`. The name is also what keeps `scriptCalls` readable in the tests, which count the anonymous `func` injections.
- **Plain `executeScript`, not `scriptWithTimeout`.** The report always answers, so the outer race would only fence a page that refuses to run scripts at all — which the whole stitch already doesn't fence (`measurePage`, `scrollAndReport`, the sticky passes). Fencing one call and not the other four would be noise.
- **`FRAME_TIMEOUT_MS = 1000`.** A drawing page answers in about 16 ms, so this is only ever paid on the slice the capture stops at. Half `SCRIPT_TIMEOUT_MS`, which fences a script that may never run at all.
- **The pixel rule goes rather than staying alongside.** Kept, it would still throw away the flat page it was measured to break (KAN-410), which is the other half of what this change is for.
- **No README, manifest or version change.**

Checked while planning, on a copy of the tree outside this folder (`git archive HEAD`), with Node 24:

- **As it is now:** `npm test` passes 238.
- **Test change only:** 239 run, 235 pass. The four that fail are the ones the `background.js` change is for.
- **Both changes:** all 239 pass.
- **Both changes, with one piece left out:**

  | Piece | Failing tests | Message |
  |---|---|---|
  | The `if (!await pageIsDrawing(tab)) throw` call | 4: "stops rather than stitch the same frame down the canvas", "stops when the window stops drawing on the last slice", "puts the page back when the window stops drawing", "runs no sticky pass on a page that fits one screen" | "Missing expected rejection" / the `reportFrame` call missing from `scriptCalls` |
  | Removing the pixel rule (left in beside the report) | 1: "saves a page flat enough to shoot the same slice three times over" | "a page of one flat colour lost the whole capture" |

- **The in-page timer fallback was not measured by omission:** without it the injected promise never settles on a stopped window and the capture hangs, which hangs the test run rather than failing it.
- **Not checked in Chrome while planning.** Step 3 covers that, and step 3b is the one that matters.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 239, passes 235, and exactly the four tests named above fail. **Done.**
2. Make the `background.js` change above.
   → verify: `npm test` passes all 239. **Done** — 239 tests, 239 pass.
3. Check it in Chrome 153 with the repo loaded unpacked, over CDP — the setup from "Checked in Chrome" in `docs/KAN-404-plan.md`: `--enable-unsafe-extension-debugging` with `--remote-debugging-port`, `Extensions.loadUnpacked`, pages served from a local http server, the popup opened with `Extensions.triggerAction` after one warm-up, Full page pressed with `userGesture: true`, `Browser.setDownloadBehavior` to a temp dir, and a trace in the worker of the badge, of what `runCapture` settled to, and of every `chrome.scripting.executeScript` target and function name. Saved PNGs read back with Pillow: the row ranges containing the green sticky header, and an md5 per viewport-high block.
   - **PageA:** white, 3000 px, a 60 px `position: sticky; top: 0` green (`#22cc22`) header first in the body, a paragraph every 200 px.
   - **PageFlat:** white, 3000 px, the same green header, and one blank stretch tall enough for **three** identical slices (about 2000 px at a 626 px viewport).

   → verify each case:
   - **3a. A drawing window is unchanged.** Full page on PageA saves the same image as `2ae7fb2` does — same block hashes, green once at the top, no badge — and the worker's script trace shows one `reportFrame` per slice.
   - **3b. A page that isn't being painted stops the capture.** Press Full page on PageA, then `Target.activateTarget` another tab in the same window about 700 ms later. A background tab gets no frames, so this is the same mechanism a minimized window is: the capture must stop, save nothing, and flash `!`. **Note which error it reports** — the frame report now runs before the tab guard, so this case may report "the window is not drawing" where `2ae7fb2` reported "another tab is now showing". Both stop the capture; see open question 2.
   - **3c. The flat page.** Full page on PageFlat saves a correct full-height image with this change. On `2ae7fb2` the same page ends with `!` and no file — that is KAN-410, and the same run is its check.
   - **3d. The frozen-frame injection from KAN-404** (`chrome.tabs.captureVisibleTab` wrapped in the worker to hand back the frame it last returned, from the second call on), on PageA: with the pixel rule gone, this is caught only if the page also stops running `requestAnimationFrame`, which an injected stub does not. Expect it **not** to stop, and record that. It is a statement about the harness, not about Chrome — see open question 1.
   - **3e. A page that fits one screen** (626 px): still saves, one `reportFrame` in the trace.

## Checked in Chrome

Chrome **153.0.8010.48**, headless over CDP, the setup named in step 3, with the worker's `chrome.scripting.executeScript` wrapped to record each injected function's name. `2ae7fb2` is "before" throughout.

- **3a. A drawing window is unchanged.** PageA (3000 px, viewport 1280x626 at dpr 1) saves the same 1280x3060 image before and after — block hashes `8c13834d, 4aaa8b92, 31ec0879, afeef48f, 056b71f3` both times, green at `0-59` only, no badge. The trace shows five `reportFrame` calls, one per slice, and the capture takes the same time either way (2943 ms before, 2953 ms after): a drawing page answers the report inside the settle time.
- **3b. A page that isn't being painted stops the capture — the mechanism works.** Full page on PageA, then another tab activated in the same window 700 ms in:
  - **After:** stops with `Full page stopped: the window is not drawing (minimized?)` at 2781 ms, badge `!`, no file, page restored. The second `reportFrame` waited out its 1000 ms deadline and answered false. **A backgrounded page really does stop running `requestAnimationFrame`, and the report catches it.**
  - **Before:** stops at 1138 ms with `Either the '<all_urls>' or 'activeTab' permission is required` — `captureVisibleTab` is refused once the tab is no longer the active one. Badge `!`, no file.
  - So open question 2 is moot: `2ae7fb2` never reported "another tab is now showing" for this case either. That message still belongs to a tab *moved to another window* while it is still the active one there, which is what `tests/fullpage.test.js` covers with `leave: { windowId: 4 }`.
- **3c. The flat page (KAN-410), measured.** PageFlat, 3460 px with a 2600 px blank stretch — three byte-identical slices (`43e3048a` three times):
  - **Before:** `Full page stopped: the window is not drawing (minimized?)`, badge `!`, **no file** — a page that is drawing perfectly well, thrown away.
  - **After:** saves the whole 1280x3460 image, green once at `0-59`, six blocks. **KAN-410 is fixed by this change.**
  - A 3060 px version with a 2200 px gap (only *two* identical slices) saved identically before and after, which is the tolerance the old threshold was set to.
- **3d. KAN-404's frozen-frame injection is no longer caught, as predicted.** With `chrome.tabs.captureVisibleTab` wrapped in the worker to hand back a stale frame while the page keeps painting, the capture now saves the bad image — green at `0-59`, `626-685`, `1252-1311`, `1878-1937`, `2434-2493`. That injection lies to the stitch about the frames while the page is demonstrably drawing, so the report answers truthfully and the pixel rule that used to catch it is gone. It says nothing about a real window; 3b is the real-condition evidence. See open question 1.
- **3e. A page that fits one screen** (626 px): saves 1280x626, green once, no badge, one `reportFrame` in the trace.

## Open questions

1. **A minimized window is still unmeasured.** 3b proves the mechanism on a page Chrome has stopped painting, which is the same reason a minimized window goes stale — but the ticket's own case has never been reproduced on this machine, because CDP will not produce it (`Browser.setWindowBounds` with `windowState: 'minimized'` reports minimized while `document.visibilityState` stays `visible` and frames keep coming, and covering the window with a second one does not stop them). 3d shows the shape of the risk if the assumption is wrong somewhere: with the pixel rule gone, anything that stops presentation while leaving `requestAnimationFrame` running would bring KAN-404 straight back. **Press Full page and minimize the window by hand**, on a page taller than two screens: the capture must stop with `!` and save nothing. If it saves a file, the pixel rule has to come back alongside the report rather than instead of it.
2. ~~Which error should a tab switch report?~~ **Answered in 3b:** neither build reports the tab-guard message for a tab switch, because `captureVisibleTab` is refused first. Nothing to change.
