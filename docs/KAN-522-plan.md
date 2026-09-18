# KAN-522: Full page stitches in a fixed element once when it appears during a slice's settle

Ticket: https://prattsolutions.atlassian.net/browse/KAN-522 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-516, is Done.

## What the repo does now

Line numbers are from `90eeafc`, with a clean working tree. The ticket's refs (`background.js:378`, `:382`) came from the uncommitted KAN-516 change. `90eeafc` committed that change, and the refs still point at the same lines.

- **Each slice after the first** (`captureFullPage`, `background.js:365-402`) runs these steps, in order:
  1. the scroll (`:366`);
  2. the sticky listing, `markSticky` (`:374`);
  3. the fixed hide, `setFixedHidden(tab, true, i === 1)` (`:378`);
  4. the sticky check, `hideStuckSticky` (`:381`);
  5. the 500 ms settle, `sleep(500)` (`:382`);
  6. the frame check, `pageIsDrawing` (`:391`). It asks the page for a frame with `reportFrame` (`:314-319`), which answers `true` from `requestAnimationFrame`, or `false` from its 1000 ms timer;
  7. the shot, `captureVisible` (`:392`).
- **Nothing after the settle looks for fixed elements.** The fixed hide is the only pass that hides them, and it runs before the settle.
- **What follows:** a fixed element the page puts in, or pins, during the settle is in that slice's shot, at its spot on the screen.
  - The next slice's fixed hide finds it, because after the first pass each one adds the fixed elements that aren't on the list yet (`:513`, `:521`).
  - It is hidden from there on.
- **The restore** (`:404`, which runs the branch at `:526-533`) gives every listed element its own visibility back.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 335.
  - The harness runs every timer straight away, except the two deadlines (`:75-76`).
  - No test has an element turn up between a slice's fixed hide and its shot. The KAN-516 tests (`:610-636`) bring theirs in with the scroll to the third slice, before that slice's fixed hide.
  - "hides fixed elements on every slice but the first, and lists and checks sticky ones on every slice" (`:597-602`) counts 12 injected passes on a four-slice page.

**Reproduced in Chrome 153.0.8010.48**, as the ticket describes.

- **The run:** headless, with a disposable profile and a copy of `HEAD` (`git archive`, in `/tmp/kan522-head`) loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** `/tmp/vs387-chrome/run-516.js`, read with `/tmp/vs387-chrome/bands-516.py`. Both are as the KAN-516 plan left them.
- **PageH:** white and 3000 px tall.
  - Nothing in the flow changes size, and scroll anchoring is off.
  - The first scroll event, from the scroll to the second slice at 713, starts a 200 ms timer. So its handler runs during that slice's settle, after that slice's fixed hide.
  - **`#bar`:** cyan `#00ffff`, 60 px, `position: fixed; top: 0` from the start.
  - **`#late`:** magenta `#ff00ff`. The handler puts it in as a 50 px `position: fixed; bottom: 0` banner.
  - **`#turned`:** yellow `#ffff00`, 50 px, `position: absolute` at 1500 px. The handler makes it `position: fixed; top: 100px`.
- **The slices:** at 0, 713, 1426, 2139 and 2287.

| Element | Rows on `HEAD` |
|---|---|
| cyan `#bar` (fixed from the start) | 0-59 |
| magenta `#late` (put in, fixed to the bottom) | 1376-1425 |
| yellow `#turned` (made fixed, `top: 100px`) | 813-862 |

- **That is the ticket's case.**
  - Both elements turn up during the second slice's settle, so the second slice shows them once: `#late` at its bottom, and `#turned` 100 px down.
  - The third slice's fixed hide finds them, and they are hidden from there on.
- **`after` reports:**
  - all three elements `visible`, with their inline `position: fixed`;
  - the page 3000 px tall, scrolled to 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:**
- Each slice after the first runs the fixed hide a second time, once the settle is over and before the frame check.
- The second pass adds to the list the first pass made, so it hides only the fixed elements that turned up during the settle.
- The first pass stays where it is, before the settle.

1. **`background.js`**:
   - One call goes in after the settle (`:382`): `setFixedHidden(tab, true)`, with `first` left at its default, `false`.
   - `setFixedHidden` itself (`:502-537`) doesn't change.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -380,6 +380,10 @@
          // included: a `bottom` one can be stuck there already (KAN-501).
          if (hid) await hideStuckSticky(tab);
          await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   +      // And the fixed ones the page put in, or pinned, while it settled: the
   +      // hide above ran before they were there (KAN-522). It goes before the
   +      // frame check, so the frame the shot waits for has this hide in it.
   +      if (i > 0) await setFixedHidden(tab, true);
          // captureVisibleTab hands back the last frame the window presented. A
          // window that isn't drawing - minimized, occluded - presents none, so
          // every slice comes back as the frame before it. The offsets still
   ```

2. **`tests/fullpage.test.js`**:
   - **The pass count test** (`:597-602`): it is renamed. The count goes from 12 to 15, for the second fixed hide on each of the three slices after the first.
   - **A new section** after "starts a new fixed list on the first fixed hide" (`:638-647`), and before the shadow-root section (`:649`). It has three tests:
     - "hides a fixed element the page adds while the second slice settles": a banner that only goes into the page (`light`) when the second slice's settle starts.
     - "hides an element the page only makes fixed while the second slice settles": a header whose computed `position` reads `static` until then.
     - "asks for a frame only after the fixed hide that follows the settle": the injected scripts on a two-slice page, in order. The second slice runs four passes before its `reportFrame`.
   - **How the two hide tests reach the settle:** after `load()`, each one wraps the sandbox's `setTimeout`. The page changes on the 500 ms call, while it sits at the second slice. `load()` doesn't change.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -594,11 +594,11 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('hides fixed elements on every slice but the first, and lists and checks sticky ones on every slice', async () => {
   +test('hides fixed elements before and after the settle on every slice but the first, and lists and checks sticky ones on every slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the fixed hide on each of the three slices after the first, the restore once, and the sticky listing and check on each of the four slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 12, 'the fixed hide ran on the first slice or missed a later one, or a slice went unlisted or unchecked');
   +  // the fixed hide twice on each of the three slices after the first, the restore once, and the sticky listing and check on each of the four slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 15, 'the fixed hide ran on the first slice or missed a later one or its settle, or a slice went unlisted or unchecked');
    });
    
    // --- fixed elements that turn up after the second slice ---------------------
   @@ -646,6 +646,53 @@
      assert.deepStrictEqual(gone.seen, [], 'wrote to an element on a list an earlier capture left behind');
    });
    
   +// --- fixed elements that turn up while a slice settles ----------------------
   +// Each slice after the first hid the fixed elements straight after its scroll,
   +// before the settle, so one the page put in, or pinned, during the settle was
   +// stitched into that slice at its spot on the screen, and hidden only from the
   +// next slice on (KAN-522). The fixed hide now runs again once the slice has
   +// settled, before the frame the shot waits for.
   +
   +test('hides a fixed element the page adds while the second slice settles', async () => {
   +  // A banner the page puts in on a timer its first scroll starts: it turns up
   +  // after the second slice's fixed hide, and before that slice's shot.
   +  const body = el(3000, 713);
   +  const banner = positioned('fixed', 663, 713);
   +  const light = []; // what the page has in it
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
   +  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && !light.length) light.push(banner); return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // Not in the page for the first slice, hidden in the four after.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the banner was stitched into the slice it turned up in');
   +  assert.strictEqual(banner.style.visibility, '', 'left the banner hidden');
   +});
   +
   +test('hides an element the page only makes fixed while the second slice settles', async () => {
   +  // A header the page pins to the viewport on a timer its first scroll starts:
   +  // the second slice's fixed hide still reads it as static.
   +  const body = el(3000, 713);
   +  const header = positioned('fixed', 0, 60);
   +  let pinned = false;
   +  Object.defineProperty(header, 'pos', { get: () => (pinned ? 'fixed' : 'static') });
   +  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
   +  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713) pinned = true; return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slice it was pinned in');
   +  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
   +});
   +
   +test('asks for a frame only after the fixed hide that follows the settle', async () => {
   +  // The shot is taken once the page has started a frame, and that frame has to
   +  // come after the hide, or the shot can show what the hide took out.
   +  const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(1534, 767) }); // two slices
   +  await ctx.captureFullPage(TAB);
   +  // the second slice: the sticky listing, the fixed hide, the sticky check, the fixed hide again, and then the frame
   +  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'reportFrame', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'scrollAndReport'], 'asked for the frame before the fixed hide that follows the settle');
   +});
   +
    // --- fixed and sticky elements inside a shadow root -------------------------
    // document.querySelectorAll doesn't go into a shadow root, so a fixed or
    // sticky element inside a web component was never found: a fixed one was
   ```

Choices:

- **A second pass, not the first one moved after the settle.**
  - Moving it would also hide the late elements. Only the pass count and the order test fail on it (see the table below).
  - But it would change when every fixed element is hidden, including a header pinned from the start: a frame before its shot, not 500 ms before.
  - The frame check answers when the page starts a frame, and `requestAnimationFrame` runs before that frame is painted.
  - `captureVisibleTab` hands back the last frame the window presented (the comment at `:383`). A shot that beats that frame to the screen would show everything the hide took out.
  - With a second pass, whatever the first pass hides still has the whole settle to paint out. At worst, the second pass leaves a late element in its slice, which is what happens now.
- **The second pass never starts a new list.** `first` stays `false`.
  - On the second slice, the first pass has just made the list, and its elements have the `hidden` it gave them.
  - Starting again there would record that `hidden` as their own, and the restore would leave them hidden. With that, 5 tests fail (see the table below).
- **Only on the slices after the first.** Fixed elements are kept on the first slice (the comment at `:375-377`), so that slice gets no fixed hide before or after its settle.
  - A fixed element that turns up during the first slice's settle is in the first slice, the way one there from the start is. It is hidden from the second slice on.
  - That doesn't change.
- **Before the frame check,** so the frame the shot waits for is one asked for after the hide.
  - No other wait is added.
  - On PageH, the late elements were missing from all four runs (see "Checked while planning").
- **What it can't catch:** a fixed element the page puts in after the second pass.
  - The gap between the second pass and the shot is the frame check plus whatever is left of `CAPTURE_MIN_GAP_MS` (`:159`).
  - That is the gap the whole 500 ms settle used to be.
- **The cost:** one more walk of the page on each slice after the first.
  - KAN-507 measured the walk at 67-72 ms on PageC's 50,020 elements.
  - Each slice after the first now walks the page three times: the sticky listing and the two fixed hides. Merging them is a refactor the ticket doesn't need.
- **The sticky passes stay where they are,** straight after the scroll. KAN-517 is the same timing for sticky elements.
- **The tests key on the settle's 500 ms.**
  - The settle is written as `sleep(500)` (`:382`), not as a named constant like `CAPTURE_SCRIPT_TIMEOUT_MS`. Naming it would be a refactor the ticket doesn't need.
  - If the number changes, the two hide tests fail rather than pass without testing anything: the page never changes, so the element is never hidden.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan522-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 335.
- **Test change only:** 338 run and 334 pass. Four fail:
  - the pass count, with `12 !== 15`;
  - "hides a fixed element the page adds while the second slice settles", with "the banner was stitched into the slice it turned up in". The banner is in the second slice: `['', '', 'hidden', 'hidden', 'hidden']`.
  - "hides an element the page only makes fixed while the second slice settles", with "the header was stitched into the slice it was pinned in", and the same `['', '', 'hidden', 'hidden', 'hidden']`.
  - "asks for a frame only after the fixed hide that follows the settle", with "asked for the frame before the fixed hide that follows the settle". The second slice runs three passes before its `reportFrame`, not four.
- **Both changes:** all 338 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | First message |
  |---|---|---|
  | No second fixed hide (the code as it is now) | 4: the pass count, the two new hide tests and the order test | "the fixed hide ran on the first slice or missed a later one or its settle, or a slice went unlisted or unchecked" |
  | The second hide starting a new list on the second slice (`i === 1` passed as `first`) | 5: "puts the page back when a slice fails part-way", "still hides a fixed element wherever it sits", "hides a fixed element inside a shadow root, open or closed", "searches a shadow root nested inside another" and "puts the page back when the window stops drawing" | "left the pinned header hidden" |
  | The second hide before the settle | 2: the two new hide tests | "the banner was stitched into the slice it turned up in" |
  | The second hide after the frame check | 1: the order test | "asked for the frame before the fixed hide that follows the settle" |
  | The second hide on the first slice too | 8: the five in the second row, "runs no sticky pass on a page that fits one screen", the pass count and the order test | "left the pinned header hidden" |
  | The first hide moved after the settle, with no second one | 2: the pass count and the order test | "the fixed hide ran on the first slice or missed a later one or its settle, or a slice went unlisted or unchecked" |

**Chrome 153.0.8010.48:** headless, with `run-516.js`, once on `HEAD` and four times on this change (`--ext /tmp/kan522-plan/tree`).

| Element | `HEAD` | This change, all four runs |
|---|---|---|
| cyan `#bar` (fixed from the start) | 0-59 | 0-59 |
| magenta `#late` (put in, fixed to the bottom) | 1376-1425 | absent |
| yellow `#turned` (made fixed, `top: 100px`) | 813-862 | absent |

- **The two late elements:**
  - The second slice's second fixed hide finds them, so no slice shows them.
  - Before it is pinned, `#turned` sits at 1500 px, below the first two slices.
- **On both builds, `after` reports:**
  - all three elements `visible`, with their inline `position: fixed`;
  - the page 3000 px tall, scrolled to 0.
- **Capture log:** no run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 338 and 334 pass. Four fail:
   - the pass count, with `12 !== 15`;
   - "hides a fixed element the page adds while the second slice settles", with "the banner was stitched into the slice it turned up in";
   - "hides an element the page only makes fixed while the second slice settles", with "the header was stitched into the slice it was pinned in";
   - "asks for a frame only after the fixed hide that follows the settle", with "asked for the frame before the fixed hide that follows the settle".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 338.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-516.js`.
   - Run it headless with `--ext` pointed at a copy of `HEAD` first (`mkdir -p /tmp/kan522-head && git archive HEAD | tar -x -C /tmp/kan522-head`). Then run it four times with `--ext` pointed at the repo.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-516.py <png>`.

   → verify:
   - **On `HEAD`:** cyan at 0-59, magenta at 1376-1425 and yellow at 813-862.
   - **On the repo, every run:** cyan at 0-59, with magenta and yellow absent.
   - **On both builds**, `after` reports all three elements `visible`, and the page 3000 px tall, scrolled to 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-522-plan.md`.

## Noticed while planning, not changed

Nothing.

## Open questions

None.
