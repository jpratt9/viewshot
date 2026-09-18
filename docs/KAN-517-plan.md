# KAN-517: Full page stitches in a sticky element once when the capture's own scroll makes it appear

Ticket: https://prattsolutions.atlassian.net/browse/KAN-517 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-503, is Done.

## What the repo does now

Line numbers are from `ecad8a2`, with a clean working tree. The ticket's refs (`background.js:374`, `:380`, `:381`) came from the uncommitted KAN-503 change. At `ecad8a2`, the listing is still at `:374`, but the check is at `:381` and the settle at `:382`.

- **Each slice** (`captureFullPage`, `background.js:365-406`) runs these steps, in order:
  1. the scroll (`:366`);
  2. the sticky listing, `markSticky(tab, i === 0)` (`:374`), on every slice of a page with more than one;
  3. the fixed hide (`:378`), on every slice after the first;
  4. the sticky check, `hideStuckSticky` (`:381`);
  5. the 500 ms settle, `sleep(500)` (`:382`);
  6. the fixed hide again (`:386`, KAN-522), on every slice after the first;
  7. the frame check, `pageIsDrawing` (`:395`), and then the shot, `captureVisible` (`:396`).
- **Nothing after the settle lists or checks sticky elements.** The second fixed hide only takes `position: fixed` (`:525`).
- **What follows:** some sticky elements aren't on the list when that slice is checked:
  - one the page puts in after the slice's listing, in reaction to the capture's scroll, say;
  - one the page makes sticky after that listing.

  If that element is stuck in the slice, it is stitched in there at its stuck spot. The next slice's listing adds it, because after the first slice each listing adds the ones not on the list yet (`:474-475`). From there on, it is hidden wherever it is stuck.
- **Whether a slice's listing sees the change depends on timing.** The page's scroll event fires when the page next renders, not during the scroll. So the listing, a separate script, can run before a scroll handler or after it.
- **The restore** (`:408`, which runs the branch at `:530-537`) gives each listed element its own visibility back (`:534`).
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 338.
  - The KAN-503 tests (`:439-466`) change the page with the scroll itself, before that slice's listing.
  - The only tests that change the page during a settle are KAN-522's (`:656-685`), and they change fixed elements.
  - The pass count test (`:597-602`) counts 15 injected passes on a four-slice page.
  - The order test (`:687-694`) expects two passes before the first slice's frame check, and four before the second's.

**Reproduced in Chrome 153.0.8010.48**, as the ticket describes.

- **The run:** headless, with a disposable profile and a copy of `HEAD` (`git archive`, in `/tmp/kan517-head`) loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** `/tmp/vs387-chrome/run-503.js`, read with `/tmp/vs387-chrome/bands-503.py`. Both are as the KAN-503 plan left them.
- **PageG:** white and 3000 px tall.
  - Nothing changes size, and scroll anchoring is off.
  - The first scroll event, from the scroll to the second slice at 713, runs a handler that changes three elements.
  - **`#top`:** cyan `#00ffff`, 60 px, `position: sticky; top: 0` from the start, at 0.
  - **`#nav`:** green `#00ff00`, 50 px, at 60 px in `<body>`. The handler makes it `position: sticky` with `top: 60px`, so it is stuck at once in the slice whose scroll ran the handler.
  - **`#added`:** magenta `#ff00ff`, a 40 px `position: sticky; top: 0` heading. The handler puts it at the top of a 1600 px section at 1000 px.
  - **`#turned`:** yellow `#ffff00`, 50 px, at 1200 px in the same section. The handler makes it `position: sticky` with `top: 150px`.
- **The slices:** at 0, 713, 1426, 2139 and 2287.

| Element | `HEAD`, runs 1-3 | `HEAD`, run 4 |
|---|---|---|
| cyan `#top` (sticky from the start) | 0-59 | 0-59 |
| green `#nav` (made sticky, `top: 60px`) | 60-109, 773-822 | 60-109 |
| magenta `#added` (put in, place 1000) | 1000-1039 | 1000-1039 |
| yellow `#turned` (made sticky, place 1200) | 1200-1249 | 1200-1249 |

- **That is the ticket's case.** In 3 of 4 runs, the second slice's listing ran before the handler. `#nav` is then stitched in once more at the top of the second slice, 60 px down (773-822). From the third slice on, it is hidden.
- **`#added` and `#turned`** sit in their places in the second slice, so the third slice's listing finds them before they are stuck.
- **`after` reports:**
  - all four elements `visible`;
  - `#top` and `#added` with their inline `position: sticky`, and the other two with none;
  - the page 3000 px tall, scrolled to 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:**
- Each slice lists and checks the sticky elements a second time, once the settle is over and before the frame check.
- The second listing adds to the list, so it adds only the ones the page put in, or made sticky, during the settle.
- The second check runs over the whole list, the way every check does.
- The first listing and check stay where they are, before the settle.

1. **`background.js`**:
   - One line goes in after KAN-522's second fixed hide (`:386`): `if (hid) { await markSticky(tab, false); await hideStuckSticky(tab); }`.
   - `markSticky` (`:433-479`) and `hideStuckSticky` (`:489-504`) don't change.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -384,6 +384,10 @@
          // hide above ran before they were there (KAN-522). It goes before the
          // frame check, so the frame the shot waits for has this hide in it.
          if (i > 0) await setFixedHidden(tab, true);
   +      // And the sticky ones the page put in, or made sticky, while it settled:
   +      // the listing above ran before they were there (KAN-517). The check runs
   +      // again for every listed one, before the frame check too.
   +      if (hid) { await markSticky(tab, false); await hideStuckSticky(tab); }
          // captureVisibleTab hands back the last frame the window presented. A
          // window that isn't drawing - minimized, occluded - presents none, so
          // every slice comes back as the frame before it. The offsets still
   ```

2. **`tests/fullpage.test.js`**:
   - **The sticky section's comment** (`:357-359`) gets the new rule.
   - **Three new tests** after "starts a new sticky list on the first slice" (`:468-477`):
     - "hides a header the page makes sticky while the second slice settles, in that slice": a 60 px header at 0 whose computed `position` reads `static` until the second slice's settle starts.
     - "hides a sticky heading the page adds while the second slice settles, in that slice": a heading whose place is 300 px down, put into the page (`light`) when the second slice's settle starts. It is stuck at the top of that slice at once.
     - "hides a bar the page makes sticky while the first slice settles, in that slice":
       - The page starts scrolled to 640, so the scroll to the top is the capture's own.
       - A `bottom: 0` bar whose place is 2400 px down reads `static` until the first slice's settle starts. Then it is stuck to the bottom of the first screen.
   - **The pass count test** (`:597-602`): it is renamed. The count goes from 15 to 23, for the second listing and check on each of the four slices.
   - **The order test** (`:687-694`): it is renamed "asks for a frame only after the passes that follow the settle". Its expected order has the second listing and check before each slice's `reportFrame`.
   - **How the new tests reach the settle:** the way KAN-522's do. After `load()`, each one wraps the sandbox's `setTimeout`, and the page changes on the 500 ms call.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -356,7 +356,9 @@
    // place is read as `static`, and the first slice is checked too (KAN-501).
    // And a place can move while the capture runs, so it is read on every slice
    // (KAN-502). One can also be added to the page, or turn sticky, once the page
   -// has scrolled, so every slice lists the ones that have (KAN-503).
   +// has scrolled, so every slice lists the ones that have (KAN-503). The page can
   +// do that while the slice settles, too, so each slice lists and checks them
   +// again once it has (KAN-517).
    
    // Keeps what the capture did to the element's visibility, in order, and holds
    // the inline `position` a capture sets on it and puts back.
   @@ -476,6 +478,58 @@
      assert.deepStrictEqual(gone.seen, [], 'wrote to an element on a list an earlier capture left behind');
    });
    
   +test('hides a header the page makes sticky while the second slice settles, in that slice', async () => {
   +  // A 60 px header at the top of the page that the page makes sticky on a timer
   +  // its first scroll starts: the second slice's listing still reads it as
   +  // static, and it is stuck at once (KAN-517).
   +  const body = el(3000, 713);
   +  const header = stickyAt(body, 0, 3000, 60);
   +  let turned = false;
   +  Object.defineProperty(header, 'pos', { get: () => (turned ? 'sticky' : 'static') });
   +  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
   +  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713) turned = true; return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slice it turned sticky in');
   +  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
   +});
   +
   +test('hides a sticky heading the page adds while the second slice settles, in that slice', async () => {
   +  // A 40 px heading whose place is 300 px down, in a container running to
   +  // 2600 px, that the page puts in on a timer its first scroll starts: the
   +  // second slice's listing can't find it, and it is stuck at once (KAN-517).
   +  const body = el(3000, 713);
   +  const heading = stickyAt(body, 300, 2600);
   +  const light = []; // what the page has in it
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading], light });
   +  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && !light.length) light.push(heading); return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // Not in the page for the first slice, stuck at the top of the four after.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into the slice it turned up in');
   +  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
   +});
   +
   +test('hides a bar the page makes sticky while the first slice settles, in that slice', async () => {
   +  // The page was scrolled when the capture started, so the scroll to the top is
   +  // the capture's own too. A 40 px `bottom: 0` bar whose place is 2400 px down,
   +  // made sticky on a timer that scroll starts, is stuck to the bottom of the
   +  // first screen at once (KAN-517).
   +  const body = el(3000, 713);
   +  body.scrollTop = 640;
   +  const bar = stickyToBottomAt(body, 2400, 0, 713);
   +  let turned = false;
   +  Object.defineProperty(bar, 'pos', { get: () => (turned ? 'sticky' : 'static') });
   +  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [bar] });
   +  const timer = ctx.setTimeout; // the page's timer runs during the first slice's 500 ms settle
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 0) turned = true; return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  // Stuck to the bottom of the first three slices, in its place in the last two.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['hidden', 'hidden', 'hidden', '', ''], 'the bar was stitched into the first slice, where it was stuck');
   +  assert.strictEqual(bar.style.visibility, '', 'left the bar hidden');
   +});
   +
    test('leaves a sticky element that is never stuck alone', async () => {
      const body = el(3052, 767);
      const heading = stickyAt(body, 900, 940); // its container ends where it does, so it only ever scrolls by
   @@ -594,11 +648,11 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('hides fixed elements before and after the settle on every slice but the first, and lists and checks sticky ones on every slice', async () => {
   +test('hides fixed elements before and after the settle on every slice but the first, and lists and checks sticky ones before and after the settle on every slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the fixed hide twice on each of the three slices after the first, the restore once, and the sticky listing and check on each of the four slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 15, 'the fixed hide ran on the first slice or missed a later one or its settle, or a slice went unlisted or unchecked');
   +  // the fixed hide twice on each of the three slices after the first, the restore once, and the sticky listing and check twice on each of the four slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 23, 'the fixed hide ran on the first slice or missed a later one or its settle, or a slice or its settle went unlisted or unchecked');
    });
    
    // --- fixed elements that turn up after the second slice ---------------------
   @@ -684,13 +738,14 @@
      assert.strictEqual(header.style.visibility, '', 'left the header hidden');
    });
    
   -test('asks for a frame only after the fixed hide that follows the settle', async () => {
   +test('asks for a frame only after the passes that follow the settle', async () => {
      // The shot is taken once the page has started a frame, and that frame has to
   -  // come after the hide, or the shot can show what the hide took out.
   +  // come after the hides, or the shot can show what they took out (KAN-517).
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(1534, 767) }); // two slices
      await ctx.captureFullPage(TAB);
   -  // the second slice: the sticky listing, the fixed hide, the sticky check, the fixed hide again, and then the frame
   -  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'reportFrame', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'scrollAndReport'], 'asked for the frame before the fixed hide that follows the settle');
   +  // the first slice: the sticky listing and check, both again once it has settled, and then the frame;
   +  // the second: the sticky listing, the fixed hide and the sticky check, all three again once it has settled, and then the frame
   +  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'scrollAndReport', 'func', 'func', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'scrollAndReport'], 'asked for the frame before a pass that follows the settle');
    });
    
    // --- fixed and sticky elements inside a shadow root -------------------------
   ```

Choices:

- **A second listing and check, not the first ones moved after the settle.**
  - KAN-503's settled open question said that hiding such an element in the same slice "moves every sticky check (KAN-403, KAN-501, KAN-502)".
  - A second pass moves none of them. The checks before the settle run as now, and whatever they hide still has the whole settle to paint out.
  - It is the same choice KAN-522 made for fixed elements, for the same reason: the frame check answers when the page starts a frame, before that frame is painted.
- **The second listing adds to the list.** It is given `first` as `false`.
  - By then, the first check has given every listed element that is stuck the `hidden` it needs.
  - Starting a new list would record that `hidden` as the element's own, and the restore would leave it hidden. With `i === 0` passed instead, 4 tests fail (see the table below).
- **The listing before the check,** as before the settle (KAN-503). With the check first, the three new tests fail.
- **On every slice, the first included,** like the listing and check before the settle (KAN-501).
  - If the page is scrolled when the capture starts, the scroll to the top counts as a scroll too, and the page can react to it.
  - With the second pass on the slices after the first only, 3 tests fail, the first-slice test among them.
- **The second check runs over every listed element, not only the new ones.**
  - `hideStuckSticky` has no way to pick the new ones out. Giving it one is a change the ticket doesn't need.
  - Checking an element again gives the same answer unless the page moved it during the settle. Then the second answer is the right one for the shot.
- **Before the frame check, and after the second fixed hide.** The two take different elements, so their order doesn't matter.
- **What it can't catch:**
  - a sticky element the page puts in, makes sticky, or moves after the second pass;
  - one whose hide isn't on screen by the shot.

  KAN-525 records the same gap for fixed elements.
- **The cost:** one more walk of the page, and one more check, on every slice.
  - Each slice after the first now walks the page four times: the two listings and the two fixed hides. The first slice walks it twice.
  - KAN-507 measured the walk at 67-72 ms on PageC's 50,020 elements. Merging the walks is a refactor the ticket doesn't need.
  - The extra check also sets `position: static` on every listed element and puts it back. A page's `MutationObserver` sees two more writes per element on each slice (the KAN-501 plan's note).
- **The tests key on the settle's 500 ms,** as KAN-522's do. If the number changes, they fail rather than pass without testing anything.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan517-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 338.
- **Test change only:** 341 run and 336 pass. Five fail:
  - "hides a header the page makes sticky while the second slice settles, in that slice", with "the header was stitched into the slice it turned sticky in". The header is in the second slice: `['', '', 'hidden', 'hidden', 'hidden']`.
  - "hides a sticky heading the page adds while the second slice settles, in that slice", with "the heading was stitched into the slice it turned up in", and the same `['', '', 'hidden', 'hidden', 'hidden']`.
  - "hides a bar the page makes sticky while the first slice settles, in that slice", with "the bar was stitched into the first slice, where it was stuck": `['', 'hidden', 'hidden', '', '']`.
  - the pass count, with `15 !== 23`;
  - "asks for a frame only after the passes that follow the settle", with "asked for the frame before a pass that follows the settle". It finds two passes before the first slice's `reportFrame` and four before the second's, not four and six.
- **Both changes:** all 341 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | First message |
  |---|---|---|
  | No second listing or check (the code as it is now) | 5: the three new tests, the pass count and the order test | "the header was stitched into the slice it turned sticky in" |
  | The second listing starting a new list on the first slice (`i === 0` passed as `first`) | 4: "shows a bottom-sticky bar at its own place, not over the first screen", "reads a sticky element as the page's when nothing between it and the page scrolls", "puts a bar hidden on the first slice back when the capture stops there" and "reads a slotted sticky element as the page's when nothing around its slot scrolls" | "the bar was stitched in where it was stuck, or blanked out of its own place" |
  | The second listing with no second check | 5: the same as the first row | the same |
  | The second check with no second listing | 5: the same as the first row | the same |
  | The second check before the second listing | 3: the three new tests | "the header was stitched into the slice it turned sticky in" |
  | The second pass before the settle | 3: the three new tests | the same |
  | The second pass after the frame check | 1: the order test | "asked for the frame before a pass that follows the settle" |
  | The second pass on the slices after the first only | 3: the first-slice test, the pass count and the order test | "the bar was stitched into the first slice, where it was stuck" |

**Chrome 153.0.8010.48:** headless, with `run-503.js`, four times on `HEAD` and four times on this change (`--ext /tmp/kan517-plan/tree`).

| Element | `HEAD` | This change, all four runs |
|---|---|---|
| cyan `#top` (sticky from the start) | 0-59 | 0-59 |
| green `#nav` (made sticky, `top: 60px`) | 60-109, and 773-822 in 3 of 4 runs | 60-109 |
| magenta `#added` (put in, place 1000) | 1000-1039 | 1000-1039 |
| yellow `#turned` (made sticky, place 1200) | 1200-1249 | 1200-1249 |

- **`#nav`:** the second slice's second listing finds it whether or not the handler had run by the first. So it shows only in its place, at 60-109.
- **On both builds, `after` reports:**
  - all four elements `visible`;
  - `#top` and `#added` with their inline `position: sticky`, and the other two with none;
  - the page 3000 px tall, scrolled to 0.
- **Capture log:** no run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 341 and 336 pass. Five fail:
   - "hides a header the page makes sticky while the second slice settles, in that slice", with "the header was stitched into the slice it turned sticky in";
   - "hides a sticky heading the page adds while the second slice settles, in that slice", with "the heading was stitched into the slice it turned up in";
   - "hides a bar the page makes sticky while the first slice settles, in that slice", with "the bar was stitched into the first slice, where it was stuck";
   - the pass count, with `15 !== 23`;
   - "asks for a frame only after the passes that follow the settle", with "asked for the frame before a pass that follows the settle".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 341.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-503.js`.
   - Run it headless four times with `--ext` pointed at a copy of `HEAD` (`mkdir -p /tmp/kan517-head && git archive HEAD | tar -x -C /tmp/kan517-head`). Then run it four times with `--ext` pointed at the repo.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-503.py <png>`.

   → verify:
   - **On `HEAD`:** green at 773-822 in at least one run, as well as at 60-109.
   - **On the repo, every run:** cyan at 0-59, green at 60-109 only, magenta at 1000-1039 and yellow at 1200-1249.
   - **On both builds**, `after` reports all four elements `visible`, and the page 3000 px tall, scrolled to 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-517-plan.md`.

## Noticed while planning, not changed

Nothing.

## Open questions

None.
