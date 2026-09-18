# KAN-525: Full page can stitch in a fixed element once between a slice's last fixed hide and its shot

Ticket: https://prattsolutions.atlassian.net/browse/KAN-525 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-522, is Done.

## What the repo does now

Line numbers are from `9320377`, with a clean working tree. The ticket's refs came from the uncommitted KAN-522 change, and have moved since:

| Ticket | Now | What |
|---|---|---|
| `background.js:386` | `:470` | the second fixed hide |
| `:395` | `:483` | the frame check, `pageIsDrawing` |
| `:396` | `:484` | the shot, `captureVisible` |
| `:159` | `:175` | `CAPTURE_MIN_GAP_MS` |
| `:177` | `:192-193` | `captureVisible` waiting out the rest of it |
| `:314-319` | `:386-391` | `reportFrame` |
| `:387` | `:475` | the comment on the last frame the window presented |

- **Each slice** (`captureFullPage`, `background.js:418-595`) runs these steps, in order:
  1. the scroll (`:442`);
  2. the sticky listing, `markSticky` (`:458`);
  3. on the slices after the first, the fixed hide, `setFixedHidden(tab, true, i === 1)` (`:462`);
  4. the sticky check, `hideStuckSticky` (`:465`);
  5. the 500 ms settle, `sleep(500)` (`:466`);
  6. on the slices after the first, the fixed hide again (`:470`, KAN-522). It is the slice's last fixed hide;
  7. the sticky listing and check again (`:474`, KAN-517);
  8. the frame check, `pageIsDrawing` (`:483`). `reportFrame` (`:386-391`) answers `true` from the first `requestAnimationFrame` callback, or `false` from its `FRAME_TIMEOUT_MS` timer (`:232`);
  9. the shot, `captureVisible` (`:484`). It first waits out whatever is left of `CAPTURE_MIN_GAP_MS` since the last shot (`:192-193`);
  10. the tab check (`:488-489`), and then the draw (`:490` on).
- **KAN-517 came after the ticket.** Step 7 now sits between the last fixed hide and the frame check, so the gap holds two more page scripts than the ticket says.
- **Nothing after step 6 looks for fixed elements,** and `setFixedHidden` (`:680-715`) answers nothing. So both of the ticket's ways are there:
  - A fixed element the page puts in, or pins, after step 6 is in the shot, at its spot on the screen. The next slice's first fixed hide finds it.
  - The frame check answers from a `requestAnimationFrame` callback, which runs before its frame is painted. `captureVisibleTab` hands back the last frame the window presented, so a shot that gets there before that frame does still shows what step 6 hid.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 397.
  - The harness runs every `requestAnimationFrame` callback straight away (`:85`), and each shot records the page as it is at that moment (`:106-109`). No test can have a frame painted after its callbacks.
  - No test has an element turn up after a slice's last fixed hide. The KAN-522 tests (`:712-741`) bring theirs in when the settle starts.
  - "hides fixed elements before and after the settle on every slice but the first, ..." (`:653-658`) counts 23 injected passes on a four-slice page. "asks for a frame only after the passes that follow the settle" (`:743-751`) lists a two-slice page's scripts in order.

**Reproduced in Chrome 153.0.8010.48, both ways.** The ticket's PageH shows neither, so this plan adds `/tmp/vs387-chrome/run-525.js`, read with `/tmp/vs387-chrome/bands-525.py`.

- **The run:** headless, with a disposable profile and a copy of `HEAD` (`git archive`, in `/tmp/kan525-head`) loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **Both pages:** white and 3000 px tall. Nothing in the flow changes size, and scroll anchoring is off. The slices are at 0, 713, 1426, 2139 and 2287.
  - **`#bar`:** cyan `#00ffff`, 60 px, `position: fixed; top: 0` from the start.
  - **`#late`:** magenta `#ff00ff`. The first scroll event starts a 200 ms timer, and its handler puts it in as a 50 px `position: fixed; bottom: 0` banner. That is during the second slice's settle, so that slice's last fixed hide hides it.
- **PageJ** (`--page J`), for "It turns up in that gap": a `MutationObserver` on `#late` sees that hide. Straight after it, the page puts in `#gap` (green `#00ff00`, 50 px, `position: fixed; top: 300px`) and pins `#pin` (yellow `#ffff00`, 50 px, `position: absolute` at 1500 px until then, then `position: fixed; top: 400px`).
- **PageK** (`--page K`), for "Its hide isn't on screen yet": the page asks for a frame at every vsync, as a page that animates does. Straight after the hide of `#late`, it makes its next frame spend 150 ms in a `ResizeObserver` callback. That runs after the frame's `requestAnimationFrame` callbacks, and before the frame is painted.

| Element | PageJ on `HEAD` | PageK on `HEAD`, four runs |
|---|---|---|
| cyan `#bar` (fixed from the start) | 0-59 | 0-59 |
| magenta `#late` (put in during the settle) | absent | 1376-1425 on three runs, absent on one |
| green `#gap` (put in after the last fixed hide) | 1013-1062 | not on the page |
| yellow `#pin` (pinned after the last fixed hide) | 1113-1162 | 1500-1549, its own place: PageK never pins it |

- **That is the ticket's case, both ways.**
  - Each element is in the second slice once, at its spot on the screen: 713 + 300, 713 + 400 and 713 + 663.
  - The third slice's first fixed hide finds `#gap` and `#pin`, and they are hidden from there on.
- **Why PageH never showed the second way:** on a page that isn't drawing, Chrome runs a frame straight after the hide, before the worker's next script gets there.
  - On PageK without its frame at every vsync, `#late` was absent from the shot.
  - A `--debug` timeline of that run had the slowed frame start within 1 ms of the hide. It painted the hide long before the frame check asked for a frame.
  - Only a page that already draws at every vsync leaves the hide to the frame the frame check asks for.
- **`after` reports,** on both pages:
  - every element `visible`, with its inline position;
  - the page 3000 px tall, scrolled to 0.
- **Each capture** took 5 shots and logged no `[ViewShot]` line.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:**
- The frame check answers from the frame after the one it asks for. By the time that frame starts, the page has painted the one with the slice's hides in it.
- On every slice after the first, the fixed hide runs once more, after the shot. If it hides an element no pass before it had, that element may be in the shot. Then the slice settles again, runs the passes that follow the settle again, and is shot again. The second shot is kept.
- `setFixedHidden` answers whether it hid an element no pass before it had.

1. **`background.js`**:
   - **`reportFrame`** (`:386-391`): its `requestAnimationFrame` callback asks for another one, and the answer comes from that. The comment above it, and the one on `FRAME_TIMEOUT_MS` (`:229-231`), say so.
   - **`captureFullPage`:**
     - The lines from the settle to the tab check (`:466-489`) go inside a loop. They move one level in and are otherwise as they are, so `git diff -w` shows only the loop and the check.
     - The loop ends with the fixed hide after the shot.
     - `url` is declared before the loop, with `let`.
   - **`setFixedHidden`** (`:680-715`): the hide branch returns whether its list grew, and `setFixedHidden` returns that. The restore branch returns nothing, as now.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -226,9 +226,10 @@
    // only works for about 10 s: Chrome 152 took one used at 9.2 s and refused one
    // used at 10.3 s. Two 2 s deadlines leave a start, and one queued behind it,
    // time to use theirs.
   -// How long the page gets to produce a frame before the stitch gives up on it.
   -// A window that is drawing answers in about 16ms; one that isn't never will,
   -// and the wait is paid once, on the slice the capture stops at.
   +// How long the page gets to produce the two frames reportFrame waits for
   +// before the stitch gives up on it. A window that is drawing answers in about
   +// 33ms; one that isn't never will, and the wait is paid once, on the slice the
   +// capture stops at.
    const FRAME_TIMEOUT_MS = 1000;
    const SCRIPT_TIMEOUT_MS = 2000;
    function scriptWithTimeout(injection, ms = SCRIPT_TIMEOUT_MS) {
   @@ -383,9 +384,14 @@
    // instead: timers keep running in a window that isn't presenting, which is what
    // makes them the half of this that can always answer. Runs in the page, so it
    // can't read FRAME_TIMEOUT_MS and is handed it.
   +// It answers from the frame after the one it asks for. requestAnimationFrame
   +// runs before its frame is painted, so an answer from the first one let the
   +// shot beat that frame to the screen, and an element hidden just before the
   +// frame check could still be in the shot (KAN-525). By the time the next frame
   +// starts, the page has painted the one with the hides in it.
    function reportFrame(ms) {
      return new Promise((resolve) => {
   -    requestAnimationFrame(() => resolve(true));
   +    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        setTimeout(() => resolve(false), ms); // whichever lands first wins; the other is a no-op
      });
    }
   @@ -463,30 +469,42 @@
          // Sticky ones only in the slices they are stuck in (KAN-403), the first
          // included: a `bottom` one can be stuck there already (KAN-501).
          if (hid) await hideStuckSticky(tab);
   -      await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   -      // And the fixed ones the page put in, or pinned, while it settled: the
   -      // hide above ran before they were there (KAN-522). It goes before the
   -      // frame check, so the frame the shot waits for has this hide in it.
   -      if (i > 0) await setFixedHidden(tab, true);
   -      // And the sticky ones the page put in, or made sticky, while it settled:
   -      // the listing above ran before they were there (KAN-517). The check runs
   -      // again for every listed one, before the frame check too.
   -      if (hid) { await markSticky(tab, false); await hideStuckSticky(tab); }
   -      // captureVisibleTab hands back the last frame the window presented. A
   -      // window that isn't drawing - minimized, occluded - presents none, so
   -      // every slice comes back as the frame before it. The offsets still
   -      // advance and the tab is still the one showing, so neither guard here
   -      // catches it, and the stitch drew that one screen at every offset and
   -      // saved a tall image that is the same screen over and over, with nothing
   -      // to say so. Ask the page for a frame rather than compare the pixels: a
   -      // flat stretch of page shoots the same bytes twice while drawing fine.
   -      if (!await pageIsDrawing(tab)) throw new Error('Full page stopped: the window is not drawing (minimized?)');
   -      const url = await captureVisible(tab.windowId);
   -      // captureVisibleTab shoots whichever tab is showing in the window. If the
   -      // user switched tabs (or moved this one out) mid-stitch, this slice is
   -      // another tab: stop rather than stitch it in.
   -      const now = await chrome.tabs.get(tab.id);
   -      if (!now.active || now.windowId !== tab.windowId) throw new Error('Full page stopped: another tab is now showing');
   +      // A slice can be shot twice: see the fixed hide after the shot (KAN-525).
   +      let url;
   +      for (let shot = 1; ; shot++) {
   +        await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   +        // And the fixed ones the page put in, or pinned, while it settled: the
   +        // hide above ran before they were there (KAN-522). It goes before the
   +        // frame check, so the frame the shot waits for has this hide in it.
   +        if (i > 0) await setFixedHidden(tab, true);
   +        // And the sticky ones the page put in, or made sticky, while it settled:
   +        // the listing above ran before they were there (KAN-517). The check runs
   +        // again for every listed one, before the frame check too.
   +        if (hid) { await markSticky(tab, false); await hideStuckSticky(tab); }
   +        // captureVisibleTab hands back the last frame the window presented. A
   +        // window that isn't drawing - minimized, occluded - presents none, so
   +        // every slice comes back as the frame before it. The offsets still
   +        // advance and the tab is still the one showing, so neither guard here
   +        // catches it, and the stitch drew that one screen at every offset and
   +        // saved a tall image that is the same screen over and over, with nothing
   +        // to say so. Ask the page for a frame rather than compare the pixels: a
   +        // flat stretch of page shoots the same bytes twice while drawing fine.
   +        if (!await pageIsDrawing(tab)) throw new Error('Full page stopped: the window is not drawing (minimized?)');
   +        url = await captureVisible(tab.windowId);
   +        // captureVisibleTab shoots whichever tab is showing in the window. If the
   +        // user switched tabs (or moved this one out) mid-stitch, this slice is
   +        // another tab: stop rather than stitch it in.
   +        const now = await chrome.tabs.get(tab.id);
   +        if (!now.active || now.windowId !== tab.windowId) throw new Error('Full page stopped: another tab is now showing');
   +        // And the fixed ones the page put in, or pinned, after the hide above:
   +        // they are in this shot, at their spot on the screen (KAN-525). One
   +        // found here sends the slice back to settle and run the passes above
   +        // again before it is shot again. Shot straight away, it would wait out
   +        // the rest of CAPTURE_MIN_GAP_MS after those passes instead, and give
   +        // the page that long to put in another. The second shot is kept: the
   +        // next slice's first fixed hide finds whatever turns up after it.
   +        if (i === 0 || shot === 2 || !await setFixedHidden(tab, true)) break;
   +      }
          const bmp = await createImageBitmap(await (await fetch(url)).blob());
          
          const sliceTopTemp = m.rect ? Math.round(Math.max(0, m.rect.top) * m.dpr) : 0;
   @@ -678,7 +696,7 @@
    }
    
    async function setFixedHidden(tab, hide, first = false) {
   -  await scriptWithTimeout({
   +  const [{ result }] = await scriptWithTimeout({
        target: { tabId: tab.id },
        func: (doHide, first) => {
          if (doHide) {
   @@ -689,6 +707,7 @@
            // fixed, once it scrolled (KAN-516). One hidden already keeps the
            // visibility recorded for it: by now it has the `hidden` it was given.
            const list = first ? [] : window.__shotHidden || [];
   +        const before = list.length;
            // Shadow roots too, the same walk as markSticky's (KAN-507):
            // executeScript serializes each standalone, so they can't share it.
            const roots = [document];
   @@ -701,6 +720,7 @@
              }
            }
            window.__shotHidden = list;
   +        return list.length > before; // whether it hid one no pass before it had (KAN-525)
          } else {
            // Not only after the fixed hide: a sticky element can be hidden on the
            // first slice, and a capture can stop there (KAN-501).
   @@ -712,6 +732,7 @@
        },
        args: [hide, first],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
   +  return result;
    }
    
    // Temporarily hide the page scrollbar(s) so they don't show up in the shot.
   ```

2. **`tests/fullpage.test.js`**:
   - **The pass count test** (`:653-658`): it is renamed. The count goes from 23 to 26, for the fixed hide after the shot on each of the three slices after the first.
   - **The order test** (`:743-751`): the second slice's `reportFrame` is followed by one more `func`, the fixed hide after the shot, before the restore.
   - **A new section** after the order test, and before the shadow-root section (`:753`). It has five tests:
     - "shoots a slice again when a fixed element turns up between its last fixed hide and its shot": a banner the page puts in from its own frame callback, in the frame the second slice's frame check asks for. Each shot's URL carries its number, and the test reads which shots the stitch fetches: the second slice's first shot must not be one of them.
     - "shoots a slice again when the page makes an element fixed between its last fixed hide and its shot": a header whose computed `position` reads `static` until then.
     - "settles again and runs the passes that follow the settle before it shoots a slice again": a two-slice page's scripts in order, with each settle marked.
     - "shoots a slice twice at most, however many fixed elements the page puts in": a new banner at every shot after the first slice's.
     - "shoots a slice only once the page has painted the frame its fixed hide is in": the test models Chrome's frames. A frame is on the screen once the next one starts, and each shot records the screen, not the page.
   - **How they reach the gap:** after `load()`, each one wraps the sandbox's `requestAnimationFrame`, `setTimeout`, `chrome.tabs.captureVisibleTab` or `fetch`, the way the KAN-522 tests wrap `setTimeout`. `load()` doesn't change.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -650,11 +650,11 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('hides fixed elements before and after the settle on every slice but the first, and lists and checks sticky ones before and after the settle on every slice', async () => {
   +test('hides fixed elements before and after the settle and after the shot on every slice but the first, and lists and checks sticky ones before and after the settle on every slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the fixed hide twice on each of the three slices after the first, the restore once, and the sticky listing and check twice on each of the four slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 23, 'the fixed hide ran on the first slice or missed a later one or its settle, or a slice or its settle went unlisted or unchecked');
   +  // the fixed hide three times on each of the three slices after the first, the restore once, and the sticky listing and check twice on each of the four slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 26, 'the fixed hide ran on the first slice or missed a later one, its settle or its shot, or a slice or its settle went unlisted or unchecked');
    });
    
    // --- fixed elements that turn up after the second slice ---------------------
   @@ -746,8 +746,120 @@
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(1534, 767) }); // two slices
      await ctx.captureFullPage(TAB);
      // the first slice: the sticky listing and check, both again once it has settled, and then the frame;
   -  // the second: the sticky listing, the fixed hide and the sticky check, all three again once it has settled, and then the frame
   -  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'scrollAndReport', 'func', 'func', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'scrollAndReport'], 'asked for the frame before a pass that follows the settle');
   +  // the second: the sticky listing, the fixed hide and the sticky check, all three again once it has settled, the frame, and the fixed hide after the shot
   +  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'scrollAndReport', 'func', 'func', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'func', 'scrollAndReport'], 'asked for the frame before a pass that follows the settle');
   +});
   +
   +// --- fixed elements that turn up after a slice's last fixed hide ------------
   +// The fixed hide that follows the settle was the last one before the shot. A
   +// fixed element the page put in, or pinned, after it was stitched into that
   +// slice at its spot on the screen, and hidden only from the next slice on. And
   +// the frame check answered from requestAnimationFrame, which runs before its
   +// frame is painted, so the shot could still show an element that hide took out
   +// (KAN-525). A fixed hide now runs after the shot too, and one it finds sends
   +// the slice back to settle and be shot again, once. The frame check answers
   +// from the frame after the one it asks for.
   +
   +test('shoots a slice again when a fixed element turns up between its last fixed hide and its shot', async () => {
   +  // A banner the page puts in from a frame callback of its own, in the frame
   +  // the second slice's frame check asks for: after that slice's last fixed
   +  // hide, and before its shot.
   +  const body = el(3000, 713);
   +  const banner = positioned('fixed', 663, 713);
   +  const light = []; // what the page has in it
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
   +  const frame = ctx.requestAnimationFrame;
   +  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && !light.length) light.push(banner); return frame(cb); };
   +  // Which shots the stitch draws: each one's URL carries its number.
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => `${await shoot(...a)}#${captureAt.length}`;
   +  const drawn = [];
   +  const get = ctx.fetch;
   +  ctx.fetch = (url) => { drawn.push(Number(url.split('#')[1])); return get(url); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(drawn, [1, 3, 4, 5, 6], 'the banner was stitched into the slice it turned up in');
   +  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 2139, 2287]);
   +  // Not in the page for the first slice, in the second slice's first shot, and hidden in its second shot and the three slices after.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden', 'hidden']);
   +  assert.strictEqual(banner.style.visibility, '', 'left the banner hidden');
   +});
   +
   +test('shoots a slice again when the page makes an element fixed between its last fixed hide and its shot', async () => {
   +  // A header the page pins to the viewport in the frame the second slice's
   +  // frame check asks for: that slice's last fixed hide still read it as static.
   +  const body = el(3000, 713);
   +  const header = positioned('fixed', 0, 60);
   +  let pinned = false;
   +  Object.defineProperty(header, 'pos', { get: () => (pinned ? 'fixed' : 'static') });
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
   +  const frame = ctx.requestAnimationFrame;
   +  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713) pinned = true; return frame(cb); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slice it was pinned in');
   +  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 2139, 2287]);
   +  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
   +});
   +
   +test('settles again and runs the passes that follow the settle before it shoots a slice again', async () => {
   +  // A second shot straight after the first would wait out the rest of the
   +  // capture rate limit after its passes, and give the page that long to put
   +  // in another one.
   +  const body = el(1534, 767); // two slices
   +  const banner = positioned('fixed', 700, 767);
   +  const light = [];
   +  const { ctx, scriptCalls } = load({ de: el(767, 767), body, fixed: [banner], light });
   +  const frame = ctx.requestAnimationFrame;
   +  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 767 && !light.length) light.push(banner); return frame(cb); };
   +  const timer = ctx.setTimeout;
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500) scriptCalls.push('settle'); return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  // the second slice: the sticky listing, the fixed hide and the sticky check, the settle, all three again, the frame, and the fixed hide after the shot, which finds the banner;
   +  // then the settle, the three passes that follow it and the frame again, and no fixed hide after the second shot
   +  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'settle', 'func', 'func', 'reportFrame', 'scrollAndReport', 'func', 'func', 'func', 'settle', 'func', 'func', 'func', 'reportFrame', 'func', 'settle', 'func', 'func', 'func', 'reportFrame', 'func', 'scrollAndReport'], 'shot the slice again before it settled and ran the passes that follow the settle, or checked after its second shot');
   +});
   +
   +test('shoots a slice twice at most, however many fixed elements the page puts in', async () => {
   +  // A page that puts in another fixed banner at every shot after the first
   +  // slice's, after the slice's last fixed hide every time.
   +  const body = el(3000, 713);
   +  const banners = Array.from({ length: 10 }, () => positioned('fixed', 663, 713));
   +  const light = [];
   +  const { ctx, captureAt } = load({ de: el(713, 713), body, ih: 713, fixed: banners, light });
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  ctx.chrome.tabs.captureVisibleTab = (...a) => { if (body.scrollTop > 0) light.push(banners[light.length]); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 1426, 2139, 2139, 2287, 2287], 'shot a slice more than twice, or only once with a banner in it');
   +  assert.ok(banners.every((b) => b.style.visibility === ''), 'left a banner hidden');
   +});
   +
   +test('shoots a slice only once the page has painted the frame its fixed hide is in', async () => {
   +  // As in Chrome, a frame's requestAnimationFrame callbacks run before it is
   +  // painted, and captureVisibleTab hands back the last frame painted: here a
   +  // frame is on the screen once the next one starts, and the settle's frames
   +  // leave the page on the screen as it is. The banner turns up while the
   +  // second slice settles, so it is on the screen by the end of the settle; the
   +  // fixed hide that follows takes it out of the page, but not off the screen.
   +  const body = el(3000, 713);
   +  const banner = positioned('fixed', 663, 713);
   +  const light = [];
   +  const { ctx } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
   +  const page = () => (light.length ? banner.style.visibility : 'absent');
   +  let painted = page(), screen = painted;
   +  const timer = ctx.setTimeout;
   +  ctx.setTimeout = (fn, ms) => {
   +    if (ms === 500) {
   +      if (body.scrollTop === 713 && !light.length) light.push(banner);
   +      painted = screen = page();
   +    }
   +    return timer(fn, ms);
   +  };
   +  const frame = ctx.requestAnimationFrame;
   +  ctx.requestAnimationFrame = (cb) => frame(() => { screen = painted; painted = page(); cb(); });
   +  const shots = []; // the banner in each shot
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  ctx.chrome.tabs.captureVisibleTab = (...a) => { shots.push(screen); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shots, ['absent', 'hidden', 'hidden', 'hidden', 'hidden'], 'shot the second slice before the page painted the frame its fixed hide is in');
    });
    
    // --- fixed and sticky elements inside a shadow root -------------------------
   ```

Choices:

- **A check after the shot, not one more hide before it.**
  - Whatever the last hide before the shot is, the page can put an element in after it. Only a pass after the shot can tell whether it did.
  - PageJ is such a page: it answers the hide itself.
  - The check is the fixed hide itself, with `first` left at `false`: the same walk and the same list. The two fixed hides before the shot ignore its answer.
- **Once.**
  - The second shot is kept, whatever turns up after it. The next slice's first fixed hide finds that, as it finds such an element now.
  - A page that puts in a fixed element at every shot has each slice after the first shot twice, not forever.
  - With no cap, 2 tests fail (see the table below).
- **The settle and the passes that follow it again, before the second shot.**
  - Shot straight away, the second shot would wait out the rest of `CAPTURE_MIN_GAP_MS` (`:175`) inside `captureVisible`, after its passes. That is about 450 ms for another element to turn up in, where the first shot has only the frame check.
  - With the settle first, the rate limit has passed before the passes run, and the second shot's gap is the same as the first one's.
  - The sticky listing and check run again too, so the second shot is no later for sticky elements than the first (KAN-526).
- **Only on the slices after the first.**
  - Fixed elements are kept on the first slice (the comment at `:459-461`). One that turns up in its gap is in it, the way one there from the start is. That doesn't change.
  - With the check on the first slice too, it would start the fixed list before the second slice's first fixed hide makes it. 9 tests fail (see the table below).
- **The frame after, not a wait.**
  - A second `requestAnimationFrame` callback runs once the page has painted the frame the first one belonged to.
  - A fixed wait, like the Region shot's `sleep(80)` (`:49`), would have to guess how long a frame takes.
- **One deadline for both frames.**
  - `FRAME_TIMEOUT_MS` stays at 1000 ms and covers both. A window that is drawing answers in about 33 ms, and one that isn't still fails after 1 s.
  - A page that draws fewer than two frames a second now fails the frame check. One frame a second passed it before.
- **What it can't catch:**
  - a fixed element that turns up after a slice's second shot;
  - one that turns up in the gap and is gone again by the check after the shot;
  - a frame the page has painted but Chrome hasn't put on the screen by the shot. No run showed one.
- **The cost:**
  - Every slice: one more frame in the frame check, about 16 ms at 60 Hz.
  - Every slice after the first: one more walk of the page, after the shot. KAN-507 measured the walk at 67-72 ms on PageC's 50,020 elements. Each slice after the first now walks the page five times: the two sticky listings and the three fixed hides. Merging them is a refactor the ticket doesn't need.
  - A slice that is shot again: the settle, the three passes and the frame check again, and one more `captureVisibleTab`. That happens only when the check finds something.
- **KAN-526 is the same gap for sticky elements.**
  - It keeps its first way: a sticky element the page changes after the last sticky check.
  - Its second way, a sticky hide not on the screen by the shot, goes through the same frame check, so the frame after covers it too.
- **The tests key on the settle's 500 ms,** as KAN-522's do. If the number changes, the settle test and the frame test fail rather than pass without testing anything.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan525-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 397.
- **Test change only:** 402 run and 395 pass. Seven fail:
  - the pass count, with `23 !== 26`;
  - the order test, with "asked for the frame before a pass that follows the settle". Only the restore follows the second slice's `reportFrame`;
  - "shoots a slice again when a fixed element turns up between its last fixed hide and its shot", with "the banner was stitched into the slice it turned up in". The stitch drew shots `[1, 2, 3, 4, 5]`, the second with the banner in it;
  - "shoots a slice again when the page makes an element fixed between its last fixed hide and its shot", with "the header was stitched into the slice it was pinned in": `['', '', 'hidden', 'hidden', 'hidden']`;
  - "settles again and runs the passes that follow the settle before it shoots a slice again", with "shot the slice again before it settled and ran the passes that follow the settle, or checked after its second shot". The second slice is shot once;
  - "shoots a slice twice at most, however many fixed elements the page puts in", with "shot a slice more than twice, or only once with a banner in it": `[0, 713, 1426, 2139, 2287]`;
  - "shoots a slice only once the page has painted the frame its fixed hide is in", with "shot the second slice before the page painted the frame its fixed hide is in": `['absent', '', 'hidden', 'hidden', 'hidden']`.
- **Both changes:** all 402 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | First message |
  |---|---|---|
  | One `requestAnimationFrame`, as now | 1: the frame test | "shot the second slice before the page painted the frame its fixed hide is in" |
  | No check after the shot | 6: the pass count, the order test, the two shoot-again tests, the settle test and the cap test | "the fixed hide ran on the first slice or missed a later one, its settle or its shot, or a slice or its settle went unlisted or unchecked" |
  | The check always answering no (the hide branch returning nothing) | 4: the two shoot-again tests, the settle test and the cap test | "the banner was stitched into the slice it turned up in" |
  | The second shot straight after the check, with the passes but no settle | 1: the settle test | "shot the slice again before it settled and ran the passes that follow the settle, or checked after its second shot" |
  | The second shot straight after the check, with no settle or passes | 1: the settle test | the same |
  | No cap on the shots | 2: the settle test and the cap test | the same |
  | The check on the first slice too | 9: "puts the page back when a slice fails part-way", "still hides a fixed element wherever it sits", "runs no sticky pass on a page that fits one screen", the pass count, the order test, the settle test, "hides a fixed element inside a shadow root, open or closed", "searches a shadow root nested inside another" and "leaves a pinned header shown after two full pages at once" | "left the pinned header hidden" |
  | The first shot drawn, not the second | 1: "shoots a slice again when a fixed element turns up between its last fixed hide and its shot" | "the banner was stitched into the slice it turned up in" |

**Chrome 153.0.8010.48:** headless, with `run-525.js`.

- On `HEAD`: PageJ once and PageK four times.
- On this change (`--ext /tmp/kan525-plan/tree`): each page four times.
- On this change with one piece taken out: PageK three times with one `requestAnimationFrame`, and PageJ twice with no check after the shot.

| Element | `HEAD` | This change, every run | One `requestAnimationFrame` (PageK) | No check after the shot (PageJ) |
|---|---|---|---|---|
| cyan `#bar` | 0-59 | 0-59 | 0-59 | 0-59 |
| magenta `#late` | PageJ: absent. PageK: 1376-1425 on 3 of 4 runs | absent | 1376-1425 on all 3 runs | absent |
| green `#gap` (PageJ) | 1013-1062 | absent | not on the page | 1013-1062 on both runs |
| yellow `#pin` (PageJ) | 1113-1162 | absent | not pinned | 1113-1162 on both runs |

- **Shots:** on this change, PageJ took 6 on every run, because the second slice was shot twice. PageK took 5, as on `HEAD`.
- **On every run, `after` reports:**
  - every element `visible`, with its inline position;
  - the page 3000 px tall, scrolled to 0.
- **Capture log:** no run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 402 and 395 pass. Seven fail:
   - the pass count, with `23 !== 26`;
   - "asks for a frame only after the passes that follow the settle", with "asked for the frame before a pass that follows the settle";
   - "shoots a slice again when a fixed element turns up between its last fixed hide and its shot", with "the banner was stitched into the slice it turned up in";
   - "shoots a slice again when the page makes an element fixed between its last fixed hide and its shot", with "the header was stitched into the slice it was pinned in";
   - "settles again and runs the passes that follow the settle before it shoots a slice again", with "shot the slice again before it settled and ran the passes that follow the settle, or checked after its second shot";
   - "shoots a slice twice at most, however many fixed elements the page puts in", with "shot a slice more than twice, or only once with a banner in it";
   - "shoots a slice only once the page has painted the frame its fixed hide is in", with "shot the second slice before the page painted the frame its fixed hide is in".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 402.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-525.js`.
   - Run it headless with `--ext` pointed at a copy of `HEAD` first (`mkdir -p /tmp/kan525-head && git archive HEAD | tar -x -C /tmp/kan525-head`): `--page J` once, and `--page K` four times. Then run each page four times with `--ext` pointed at the repo.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-525.py <png>`.

   → verify:
   - **On `HEAD`:** PageJ has green at 1013-1062 and yellow at 1113-1162. PageK has magenta at 1376-1425 on most runs.
   - **On the repo, every run:** cyan at 0-59, with magenta, green and yellow absent, except PageK's yellow at its own place, 1500-1549. PageJ reports 6 shots, and PageK 5.
   - **On both builds,** `after` reports every element `visible`, and the page 3000 px tall, scrolled to 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-525-plan.md`.

## Noticed while planning, not changed

- **KAN-526** still names both of its ways. Once this change ships, only its first way is left: a sticky element the page changes after the last sticky check.

## Open questions

None.
