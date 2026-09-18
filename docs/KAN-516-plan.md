# KAN-516: Full page never hides a fixed element that appears after the second slice

Ticket: https://prattsolutions.atlassian.net/browse/KAN-516 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-502, is Done.

## What the repo does now

Line numbers are from `41f6f32`, with a clean working tree. The ticket's refs (`background.js:376`, `:494-514`) came from the uncommitted KAN-502 change. The same code is now the call at `background.js:377` and `setFixedHidden` at `:501-533`.

- **The fixed hide runs once:** `if (i === 1) await setFixedHidden(tab, true);` at `:377`, on the second slice.
  - Its hide branch (`:505-521`) walks the page and every shadow root.
  - It hides each element whose computed `position` is `fixed` at that moment.
  - It replaces `window.__shotHidden` with that list, each element with its own inline visibility (`:521`).
- **Nothing else looks for fixed elements.** The only other call is the restore in the `finally` (`:403`), and the sticky passes only handle `sticky`.
- **What follows:** some fixed elements are never hidden:
  - one the page puts in after the second slice's pass;
  - one that only becomes `position: fixed` after it.

  It is pinned to the viewport, so it is stitched into every later slice at the same spot on the screen.
- **The restore** (`:522-529`) gives each entry of `window.__shotHidden` its own visibility back (`:525`).
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 332.
  - Every fixed fake is in the page, and fixed, from the start.
  - "hides fixed elements once, and lists and checks sticky ones on every slice" (`:597-602`) counts 10 injected passes:
    - the fixed hide and the restore, once each;
    - the sticky listing and check, on each of the four slices.

**Reproduced in Chrome 153.0.8010.48.** The ticket says it wasn't.

- **The run:** headless, with a disposable profile and `HEAD` loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** a new one written while planning, `/tmp/vs387-chrome/run-516.js`, read with `/tmp/vs387-chrome/bands-516.py`. It copies `run-503.js` and swaps in PageH.
- **PageH:** white and 3000 px tall.
  - The first scroll event, from the scroll to the second slice, starts a 200 ms timer. So its handler runs during that slice's 500 ms settle, after the slice's fixed hide.
  - Nothing in the flow changes size, and scroll anchoring is off.
  - **`#bar`:** cyan `#00ffff`, 60 px, `position: fixed; top: 0` from the start.
  - **`#late`:** magenta `#ff00ff`. The handler puts it in as a 50 px `position: fixed; bottom: 0` banner.
  - **`#turned`:** yellow `#ffff00`, 50 px, `position: absolute` at 1500 px. The handler makes it `position: fixed; top: 100px`.
- **The slices:** at 0, 713, 1426, 2139 and 2287.
- **Before the capture**, a script injected through `chrome.scripting.executeScript` reads:
  - `#bar` fixed at 0;
  - `#turned` absolute at 1500;
  - no `#late`;
  - the page 3000 px tall, scrolled to 0.

| Element | Rows on `HEAD` |
|---|---|
| cyan `#bar` (fixed from the start) | 0-59 |
| magenta `#late` (put in, fixed to the bottom) | 1376-1425, 2089-2138, 2950-2999 |
| yellow `#turned` (made fixed, `top: 100px`) | 813-862, 1526-1575, 2239-2286, 2387-2436 |

- **That is the ticket's case.** Both elements turn up after the second slice's fixed hide, and both are stitched in at the same spot on the screen in every slice from the second on: `#late` at the bottom, `#turned` 100 px down.
- The last slice overlaps the fourth and is drawn over it:
  - `#late`'s copy from the fourth slice doesn't show;
  - `#turned`'s is cut short at 2286, where the last slice starts.
- **`after` reports:**
  - all three elements `visible`, with their inline `position: fixed`;
  - the page 3000 px tall, scrolled to 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:**
- The fixed hide runs on every slice after the first, not only on the second.
- Its first pass makes the list, as now.
- Each later pass hides the fixed elements that aren't on the list yet, and adds them, each with its own inline visibility.
- The elements already on the list are skipped and keep the visibility recorded for them.

1. **`background.js`**:
   - **The call** (`:375-377`): the fixed hide runs on every slice after the first. It is told whether this is its first pass.
   - **`setFixedHidden`** (`:501-533`):
     - It takes `first`, which defaults to `false`.
     - Its first pass starts a new list, as now. A later one keeps `window.__shotHidden` and skips the elements already on it.
     - The restore is unchanged.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -373,8 +373,9 @@
          // something for the finally to put back.
          if (positions.length > 1) { await markSticky(tab, i === 0); hid = true; }
          // Keep fixed elements (pinned headers, banners) on the FIRST slice only;
   -      // hide them on later slices so they aren't stitched in repeatedly.
   -      if (i === 1) await setFixedHidden(tab, true);
   +      // hide them on later slices so they aren't stitched in repeatedly, and
   +      // on each one the ones that have turned up since (KAN-516).
   +      if (i > 0) await setFixedHidden(tab, true, i === 1);
          // Sticky ones only in the slices they are stuck in (KAN-403), the first
          // included: a `bottom` one can be stuck there already (KAN-501).
          if (hid) await hideStuckSticky(tab);
   @@ -498,15 +499,18 @@
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
    }
    
   -async function setFixedHidden(tab, hide) {
   +async function setFixedHidden(tab, hide, first = false) {
      await scriptWithTimeout({
        target: { tabId: tab.id },
   -    func: (doHide) => {
   +    func: (doHide, first) => {
          if (doHide) {
            // Only `fixed`: it is pinned to the viewport wherever the page is, so
            // every later slice would stitch it in again. Sticky elements are
   -        // hideStuckSticky's, slice by slice.
   -        const list = [];
   +        // hideStuckSticky's, slice by slice. After the first pass, only the
   +        // ones that have turned up since are added: put in the page, or made
   +        // fixed, once it scrolled (KAN-516). One hidden already keeps the
   +        // visibility recorded for it: by now it has the `hidden` it was given.
   +        const list = first ? [] : window.__shotHidden || [];
            // Shadow roots too, the same walk as markSticky's (KAN-507):
            // executeScript serializes each standalone, so they can't share it.
            const roots = [document];
   @@ -514,7 +518,7 @@
              for (const el of roots.pop().querySelectorAll('*')) {
                const shadow = el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el);
                if (shadow) roots.push(shadow);
   -            if (getComputedStyle(el).position !== 'fixed') continue;
   +            if (getComputedStyle(el).position !== 'fixed' || list.some(([e]) => e === el)) continue;
                list.push([el, el.style.visibility]); el.style.visibility = 'hidden';
              }
            }
   @@ -528,7 +532,7 @@
            window.__shotSticky = null;
          }
        },
   -    args: [hide],
   +    args: [hide, first],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
    }
   ```

2. **`tests/fullpage.test.js`**:
   - **The pass count test** (`:597-602`): it is renamed, and the count goes from 10 to 12, because the fixed hide now runs on each of the three slices after the first.
   - **A new section after it**, before the shadow-root section (`:604`), with three tests:
     - "hides a fixed element the page adds after the second slice": a banner that is only put in the page (`light`) once it scrolls to the third slice.
     - "hides an element the page only makes fixed after the second slice": a header whose computed `position` reads `static` until the page scrolls to the third slice.
     - "starts a new fixed list on the first fixed hide": a list left on the page before the capture is replaced, not added to. This pins `first`, the way "starts a new sticky list on the first slice" does for KAN-503.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -594,11 +594,56 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('hides fixed elements once, and lists and checks sticky ones on every slice', async () => {
   +test('hides fixed elements on every slice but the first, and lists and checks sticky ones on every slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the fixed hide and the restore once each, and the sticky listing and check on each of the four slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 10, 'the fixed hide ran more than once, or a slice went unlisted or unchecked');
   +  // the fixed hide on each of the three slices after the first, the restore once, and the sticky listing and check on each of the four slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 12, 'the fixed hide ran on the first slice or missed a later one, or a slice went unlisted or unchecked');
   +});
   +
   +// --- fixed elements that turn up after the second slice ---------------------
   +// The fixed hide ran once, on the second slice, so a fixed element the page put
   +// in, or pinned, after it was never hidden: it was stitched into every later
   +// slice at the same spot on the screen (KAN-516). Every slice after the first
   +// now hides the ones that have turned up since.
   +
   +test('hides a fixed element the page adds after the second slice', async () => {
   +  // A cookie banner the page only puts in once it has scrolled to the third
   +  // slice: the fixed hide on the second can't find it (KAN-516).
   +  const body = el(3000, 713);
   +  const banner = positioned('fixed', 663, 713);
   +  const light = []; // what the page has in it
   +  const scrollTo = body.scrollTo;
   +  body.scrollTo = function (o) { scrollTo.call(this, o); if (this.scrollTop >= 1426 && !light.length) light.push(banner); };
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // Not in the page for the first two slices, hidden in the three after.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the banner was stitched into the slices after it turned up');
   +  assert.strictEqual(banner.style.visibility, '', 'left the banner hidden');
   +});
   +
   +test('hides an element the page only makes fixed after the second slice', async () => {
   +  // A header the page only pins to the viewport once it has scrolled to the
   +  // third slice: the fixed hide on the second reads it as static (KAN-516).
   +  const body = el(3000, 713);
   +  const header = positioned('fixed', 0, 60);
   +  Object.defineProperty(header, 'pos', { get: () => (body.scrollTop >= 1426 ? 'fixed' : 'static') });
   +  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slices after it was pinned');
   +  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
   +});
   +
   +test('starts a new fixed list on the first fixed hide', async () => {
   +  // A capture that never got to its restore leaves its list on the page. The
   +  // next one's first fixed hide lists the page afresh rather than adding to
   +  // that list: an element on it may have left the page since (KAN-516).
   +  const gone = positioned('fixed', 100, 140);
   +  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
   +  ctx.window.__shotHidden = [[gone, '']];
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(gone.seen, [], 'wrote to an element on a list an earlier capture left behind');
    });
    
    // --- fixed and sticky elements inside a shadow root -------------------------
   ```

Choices:

- **The fixed hide runs on every slice after the first,** the way the sticky listing has since KAN-503, with the same `first` flag.
- **A fixed element found after the second slice is hidden on the slice whose pass finds it.**
  - Fixed elements are kept on the first slice only (the comment at `:375-376`). One that turns up later isn't in the first slice, so it isn't kept anywhere.
  - That is what the second slice's pass already does to one that turns up before it: it hides it as soon as it finds it.
  - Keeping a late one in the first slice it shows in would be a new rule, and the ticket doesn't ask for one.
- **Only new elements are added.**
  - By the next pass, an element already listed has the `hidden` the pass gave it.
  - Recording that again as its own would have the restore leave it hidden. With every element recorded again, 6 tests fail.
- **The first pass still starts a new list, as now.**
  - A list can only be there at the start if an earlier capture never reached its restore: a stopped worker, or KAN-213's overlapping captures. This change leaves that case as it is.
  - "starts a new fixed list on the first fixed hide" pins it.
- **`first` defaults to `false`.** The restore's call, `setFixedHidden(tab, false)` at `:403`, stays as it is and still passes a boolean in `args`.
- **The cost:** one more walk of the page on each slice after the second.
  - KAN-507 measured the walk at 67-72 ms on PageC's 50,020 elements.
  - Each slice already waits 500 ms to settle, and captures are at least 550 ms apart (`CAPTURE_MIN_GAP_MS`, `:159`).
  - With KAN-503's listing, each slice after the first now walks the page twice. Merging the two walks is a refactor the ticket doesn't need.
- **When the passes run is unchanged:** straight after the scroll, before the 500 ms settle. See "Noticed while planning, not changed".
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan516-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 332.
- **Test change only:** 335 run and 332 pass. Three fail:
  - "hides a fixed element the page adds after the second slice", with "the banner was stitched into the slices after it turned up". The banner is shown in every slice: `['', '', '', '', '']`.
  - "hides an element the page only makes fixed after the second slice", with "the header was stitched into the slices after it was pinned", and the same `['', '', '', '', '']`.
  - The pass count, with `10 !== 12`.

  "starts a new fixed list on the first fixed hide" passes on the code as it is now, where the second slice also replaces the list.
- **Both changes:** all 335 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | First message |
  |---|---|---|
  | The fixed hide on the second slice only (the call as it is now) | 3: the pass count and the two new hide tests | "the fixed hide ran on the first slice or missed a later one, or a slice went unlisted or unchecked" |
  | Elements already hidden recorded again, not only new ones | 6: every test with a fixed element hidden on one slice and put back after the capture, the two new hide tests among them | "left the pinned header hidden" |
  | A new list on every pass (`first` read as always true) | the same 6 | the same |
  | The first pass adding to a left-over list (`first` ignored) | 1: "starts a new fixed list on the first fixed hide" | "wrote to an element on a list an earlier capture left behind" |
  | `first` not passed to the page (`args: [hide]`) | the same 1 | the same |
  | The fixed hide on the first slice too | 2: "runs no sticky pass on a page that fits one screen" and the pass count | "ran the sticky passes on a page with one slice" |

**Chrome 153.0.8010.48:** headless, with `run-516.js`, once on `HEAD` and three times on this change (`--ext /tmp/kan516-plan/tree`).

| Element | `HEAD` | This change, all three runs |
|---|---|---|
| cyan `#bar` (fixed from the start) | 0-59 | 0-59 |
| magenta `#late` (put in, fixed to the bottom) | 1376-1425, 2089-2138, 2950-2999 | 1376-1425 |
| yellow `#turned` (made fixed, `top: 100px`) | 813-862, 1526-1575, 2239-2286, 2387-2436 | 813-862 |

- **The two late elements:**
  - Both turn up during the second slice's settle, after its fixed hide, so the second slice shows them once: `#late` at the bottom, and `#turned` 100 px down.
  - The third slice's pass finds them, and they are hidden from there on.
- **On both builds, `after` reports:**
  - all three elements `visible`, with their inline `position: fixed`;
  - the page 3000 px tall, scrolled to 0.
- **Capture log:** no run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 335 and 332 pass. Three fail:
   - the pass count, with `10 !== 12`;
   - "hides a fixed element the page adds after the second slice", with "the banner was stitched into the slices after it turned up";
   - "hides an element the page only makes fixed after the second slice", with "the header was stitched into the slices after it was pinned".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 335.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-516.js`, which was written while planning.
   - Run it headless, with `--ext` pointed first at a copy of `HEAD` (`mkdir -p /tmp/kan516-head && git archive HEAD | tar -x -C /tmp/kan516-head`), then at the repo.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-516.py <png>`.

   → verify:
   - **On `HEAD`**, the rows in the first table above:
     - cyan at 0-59;
     - magenta at 1376-1425, 2089-2138 and 2950-2999;
     - yellow at 813-862, 1526-1575, 2239-2286 and 2387-2436.
   - **On the repo:** cyan at 0-59, magenta at 1376-1425 and yellow at 813-862, once each.
   - **On both builds**, `after` reports all three elements `visible`, and the page 3000 px tall, scrolled to 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-516-plan.md`.

## Noticed while planning, not changed

- **A fixed element that turns up during a slice's settle is stitched in once, in that slice.**
  - The fixed hide runs straight after the scroll, before the 500 ms settle, as the sticky passes do.
  - PageH's two late elements turn up 200 ms into the second slice's settle, so on all three runs the second slice shows them once: magenta at 1376-1425, yellow at 813-862.
  - This change hides them from the next slice on.
  - KAN-517 records the same timing for sticky elements.
  - Filed as KAN-522, blocked by KAN-516.

## Open questions

None.
