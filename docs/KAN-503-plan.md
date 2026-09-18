# KAN-503: Full page never hides a sticky element that appears after the capture reads the top of the page

Ticket: https://prattsolutions.atlassian.net/browse/KAN-503 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-403, is Done.

## What the repo does now

Line numbers are from `5322d67`, with a clean working tree. The ticket's refs (`background.js:428-441`, `:445-455`) came from the uncommitted KAN-403 change. The same code is now `markSticky` at `background.js:427-467` and `hideStuckSticky` at `:477-492`.

- **The list is made once.** `markSticky` is called only on the first slice: `if (i === 0 && positions.length > 1)` at `:373`.
  - It walks the page and every shadow root for elements whose computed `position` is `sticky` (`:436-443`).
  - It keeps the ones that stick to the page (`:458-463`).
  - It stores them in `window.__shotSticky`, each with its own inline visibility, and replaces whatever list was there (`:464`).
- **Every slice checks only that list.** `hideStuckSticky` is called on every slice at `:379`. It reads each listed element's painted top and its `static` place, and hides the element if they are more than a pixel apart.
- **The fixed hide skips sticky elements:** `if (getComputedStyle(el).position !== 'fixed') continue;` (`:510`).
- **What follows:** some sticky elements are never listed, so nothing hides them:
  - one put in the page after the first slice;
  - one that only turns sticky after the first slice.

  Each is stitched in at the top of every later slice it is stuck in.
- **The restore** (`setFixedHidden(false)`, `:519`) gives each entry of `window.__shotSticky` its own visibility back.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 329.
  - Every sticky fake is in the page, and sticky, from the start.
  - "marks and hides fixed elements once, and checks sticky ones on every slice" (`:556-561`) counts 7 injected passes:
    - the listing, the fixed hide and the restore, once each;
    - the check, on each of the four slices.

**Reproduced in Chrome 153.0.8010.48.** The ticket says it wasn't.

- **The run:** headless, with a disposable profile and `HEAD` loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** a new one written while planning, `/tmp/vs387-chrome/run-503.js`, read with `/tmp/vs387-chrome/bands-503.py`. It copies `run-502.js` and swaps in PageG.
- **PageG:** white and 3000 px tall.
  - The first scroll event, from the scroll to the second slice, runs a handler that changes three of its elements.
  - Nothing changes size, and scroll anchoring is off.
  - **`#top`:** cyan `#00ffff`, 60 px, `position: sticky; top: 0` in `<body>` from the start, at 0.
  - **`#nav`:** green `#00ff00`, 50 px, at 60 px in `<body>`. The handler makes it `position: sticky` with `top: 60px`, so it is stuck already in the slice whose scroll ran the handler.
  - **`#added`:** magenta `#ff00ff`, a 40 px `position: sticky; top: 0` heading. The handler puts it at the top of a 1600 px section at 1000 px, in place of an empty 40 px block.
  - **`#turned`:** yellow `#ffff00`, 50 px, at 1200 px in the same section. The handler makes it `position: sticky` with `top: 150px`.
- **The slices:** at 0, 713, 1426, 2139 and 2287.
- **Before the capture**, a script injected through `chrome.scripting.executeScript` reads:
  - `#top` sticky at 0;
  - `#nav` static at 60;
  - `#turned` static at 1200;
  - no `#added`;
  - the page 3000 px tall, scrolled to 0.

| Element | Rows on `HEAD` |
|---|---|
| cyan `#top` (sticky from the start) | 0-59 |
| green `#nav` (made sticky, `top: 60px`) | 60-109, 773-822, 1486-1535, 2199-2248, 2347-2396 |
| magenta `#added` (put in, place 1000) | 1000-1039, 1426-1465, 2139-2178, 2287-2326 |
| yellow `#turned` (made sticky, place 1200) | 1200-1249, 1576-1625, 2437-2486 |

- **That is the ticket's case.** The three elements that turn up after the first slice are stitched in again in every later slice they are stuck in: `#nav` 60 px down, `#added` at the top, `#turned` 150 px down.
- `#turned`'s copy from the fourth slice doesn't show: the last slice overlaps it and is drawn over it.
- **`after` reports:**
  - all four elements `visible`;
  - `#top` and `#added` with their inline `position: sticky`, and the other two with none;
  - the page 3000 px tall, scrolled to 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:**
- The list is made on the first slice, as now.
- Every later slice adds the sticky elements that stick to the page and aren't on the list yet, each with its own inline visibility.
- The elements already on the list keep the visibility recorded for them.
- The per-slice check then covers the new ones as well.

1. **`background.js`**:
   - **The call** (`:371-373`): the listing runs on every slice of a page with more than one, not only on the first. It is told whether this is the first slice.
   - **`markSticky`** (`:427-467`): it takes `first`. On the first slice it starts a new list, as now. On a later one it keeps the list and adds only the elements not on it.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -368,9 +368,10 @@
          // Stop rather than stack the same viewport down the canvas.
          if (i > 0 && actual <= landed) break;
          landed = actual;
   -      // The sticky elements that stick to the page, listed on the first slice.
   -      // From here on there is something for the finally to put back.
   -      if (i === 0 && positions.length > 1) { await markSticky(tab); hid = true; }
   +      // The sticky elements that stick to the page, listed on the first slice
   +      // and added to on every later one (KAN-503). From here on there is
   +      // something for the finally to put back.
   +      if (positions.length > 1) { await markSticky(tab, i === 0); hid = true; }
          // Keep fixed elements (pinned headers, banners) on the FIRST slice only;
          // hide them on later slices so they aren't stitched in repeatedly.
          if (i === 1) await setFixedHidden(tab, true);
   @@ -424,10 +425,10 @@
    // hiding only the ones the first screen showed stitched them in again at the
    // top of every slice they stayed stuck in (KAN-403). So each slice hides the
    // ones that are away from their place (see hideStuckSticky).
   -async function markSticky(tab) {
   +async function markSticky(tab, first) {
      await scriptWithTimeout({
        target: { tabId: tab.id },
   -    func: () => {
   +    func: (first) => {
          const list = [];
          // querySelectorAll doesn't go into a shadow root, so each one it passes
          // is searched in turn, closed ones too (KAN-507). chrome.dom throws on
   @@ -461,8 +462,14 @@
            }
            return true;
          });
   -      window.__shotSticky = onPage.map((el) => [el, el.style.visibility]);
   +      // After the first slice, only the ones that have turned up since are
   +      // added: put in the page, or made sticky, once it scrolled (KAN-503). One
   +      // listed already keeps the visibility recorded for it: by now it has the
   +      // one hideStuckSticky gave it, not its own.
   +      const listed = first ? [] : window.__shotSticky || [];
   +      window.__shotSticky = [...listed, ...onPage.filter((el) => !listed.some(([e]) => e === el)).map((el) => [el, el.style.visibility])];
        },
   +    args: [first],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
    }
   ```

2. **`tests/fullpage.test.js`**:
   - **Two new tests after `:436`:**
     - "hides a sticky heading the page adds after the first slice in the slices it is stuck in": the section's first page, but the heading is only put in the page (`light`) once the page scrolls.
     - "hides a header the page only makes sticky once it scrolls": a 60 px header at 0 whose computed `position` reads `static` until the page scrolls.
   - **The pass count test** (`:556-561`): it is renamed, and the count goes from 7 to 10, because the listing now runs on each of the four slices.
   - **The section's comment** (`:355-358`): it gets the new rule.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -355,7 +355,8 @@
    // A `bottom` one can be stuck already at the top of the page, so each one's
    // place is read as `static`, and the first slice is checked too (KAN-501).
    // And a place can move while the capture runs, so it is read on every slice
   -// (KAN-502).
   +// (KAN-502). One can also be added to the page, or turn sticky, once the page
   +// has scrolled, so every slice lists the ones that have (KAN-503).
    
    // Keeps what the capture did to the element's visibility, in order, and holds
    // the inline `position` a capture sets on it and puts back.
   @@ -435,6 +436,35 @@
      assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
    });
    
   +test('hides a sticky heading the page adds after the first slice in the slices it is stuck in', async () => {
   +  // The first test's page, but the heading's section is only put in the page
   +  // once it scrolls, the way a list that renders as it goes does: the pass on
   +  // the first slice can't find it (KAN-503).
   +  const body = el(3000, 713);
   +  const heading = stickyAt(body, 1200, 2600);
   +  const light = []; // what the page has in it
   +  const scrollTo = body.scrollTo;
   +  body.scrollTo = function (o) { scrollTo.call(this, o); if (this.scrollTop && !light.length) light.push(heading); };
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading], light });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // In its place in the second slice, stuck at the top of the last three.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into a slice it was stuck in');
   +  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
   +});
   +
   +test('hides a header the page only makes sticky once it scrolls', async () => {
   +  // A 60 px header at the top of the page that turns sticky once the page has
   +  // scrolled: the pass on the first slice reads it as static (KAN-503).
   +  const body = el(3000, 713);
   +  const header = stickyAt(body, 0, 3000, 60);
   +  Object.defineProperty(header, 'pos', { get: () => (body.scrollTop ? 'sticky' : 'static') });
   +  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into a slice it was stuck in');
   +  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
   +});
   +
    test('leaves a sticky element that is never stuck alone', async () => {
      const body = el(3052, 767);
      const heading = stickyAt(body, 900, 940); // its container ends where it does, so it only ever scrolls by
   @@ -553,11 +583,11 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('marks and hides fixed elements once, and checks sticky ones on every slice', async () => {
   +test('hides fixed elements once, and lists and checks sticky ones on every slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the marking, the fixed hide and the restore once each, and the sticky check on each of the four slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 7, 'the marking or the fixed hide ran more than once, or a slice went unchecked');
   +  // the fixed hide and the restore once each, and the sticky listing and check on each of the four slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 10, 'the fixed hide ran more than once, or a slice went unlisted or unchecked');
    });
    
    // --- fixed and sticky elements inside a shadow root -------------------------
   ```

Choices:

- **The listing runs on every slice, before the check.** The check then covers a new element on the slice that finds it. With the listing after the check, 5 tests fail (see "Checked while planning").
- **Only new elements are added.**
  - By the next slice, an element already listed has the visibility the check gave it: `hidden` where it was stuck.
  - Recording that again as its own would have the restore leave it hidden. With every element recorded again, 10 tests fail.
- **The first slice still starts a new list, as now.**
  - A list can only be there at the start if an earlier capture never reached its restore: a stopped worker, or KAN-213's overlapping captures. This change leaves that case as it is.
  - No test starts from such a list, so none fails when `first` is ignored and the first slice adds to it.
- **The cost:** one more script, and one more walk of the page, on each slice after the first.
  - KAN-507 measured the walk at 67-72 ms on PageC's 50,020 elements.
  - Each slice already waits 500 ms to settle, and captures are at least 550 ms apart (`CAPTURE_MIN_GAP_MS`, `:159`).
- **The fixed hide is unchanged:** it still runs once, on the second slice. A fixed element that turns up later is KAN-516.
- **The listing still runs at the same point:** straight after the scroll and before the 500 ms settle, the same as the check. See "Open questions" for an element that turns up during that settle.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan503-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 329.
- **Test change only:** 331 run and 328 pass. Three fail:
  - "hides a sticky heading the page adds after the first slice in the slices it is stuck in", with "the heading was stitched into a slice it was stuck in". The heading is shown in every slice: `['', '', '', '', '']`.
  - "hides a header the page only makes sticky once it scrolls", with "the header was stitched into a slice it was stuck in", and the same `['', '', '', '', '']`.
  - "hides fixed elements once, and lists and checks sticky ones on every slice", with "the fixed hide ran more than once, or a slice went unlisted or unchecked" (`7 !== 10`).
- **Both changes:** all 331 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | First message |
  |---|---|---|
  | Listed on the first slice only (the call as it is now) | 3: the two new tests and the pass count | "the heading was stitched into a slice it was stuck in" |
  | Every listed element recorded again, not only the new ones | 10: every test with a sticky element hidden in one slice and shown in a later one or after the capture, the two new ones among them | "left the heading hidden" |
  | A new list on every slice (`first` read as always true) | the same 10 | the same |
  | The listing after the check | 5: "hides a header the page only makes sticky once it scrolls", the pass count, and the three with a bar stuck on the first slice | "the header was stitched into a slice it was stuck in" |
  | The first slice adding to a left-over list (`first` ignored) | none | — |

**Chrome 153.0.8010.48:** headless, with `run-503.js`, once on `HEAD` and three times on this change (`--ext /tmp/kan503-plan/tree`).

| Element | `HEAD` | This change |
|---|---|---|
| cyan `#top` (sticky from the start) | 0-59 | 0-59 |
| green `#nav` (made sticky, `top: 60px`) | 60-109, 773-822, 1486-1535, 2199-2248, 2347-2396 | run 1: 60-109; runs 2 and 3: 60-109, 773-822 |
| magenta `#added` (put in, place 1000) | 1000-1039, 1426-1465, 2139-2178, 2287-2326 | 1000-1039 |
| yellow `#turned` (made sticky, place 1200) | 1200-1249, 1576-1625, 2437-2486 | 1200-1249 |

- **`#added` and `#turned`:**
  - Both turn up in the second slice, where they sit in their places, so the third slice's listing finds them at the latest.
  - On all three runs, the change hides them in every slice they are stuck in.
- **`#nav`:**
  - It is already stuck in the second slice, the one whose scroll runs the handler.
  - Whether that slice's listing finds it depends on whether the page has run the handler by then.
  - In run 1 it had, and `#nav` shows once. In runs 2 and 3 it hadn't, and `#nav` is stitched in once more at the top of the second slice, at 773-822.
  - From the third slice on it is hidden, on all three runs.
- **On both builds, `after` reports:**
  - all four elements `visible`;
  - `#top` and `#added` with inline `position: sticky`, and the other two with none;
  - the page 3000 px tall, scrolled to 0.
- **Capture log:** no run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 331 and 328 pass. Three fail:
   - the two new tests, with "the heading was stitched into a slice it was stuck in" and "the header was stitched into a slice it was stuck in";
   - the pass count, with `7 !== 10`.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 331.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-503.js`, which was written while planning.
   - Run it headless, with `--ext` pointed first at a copy of `HEAD` (`mkdir -p /tmp/kan503-head && git archive HEAD | tar -x -C /tmp/kan503-head`), then at the repo.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-503.py <png>`.

   → verify:
   - **On `HEAD`**, the rows in the first table above:
     - cyan at 0-59;
     - green at 60-109, 773-822, 1486-1535, 2199-2248 and 2347-2396;
     - magenta at 1000-1039, 1426-1465, 2139-2178 and 2287-2326;
     - yellow at 1200-1249, 1576-1625 and 2437-2486.
   - **On the repo:**
     - cyan at 0-59, magenta at 1000-1039 and yellow at 1200-1249, once each;
     - green at 60-109, and at most once more, at 773-822 (see "Open questions").
   - **On both builds**, `after` reports all four elements `visible`, and the page 3000 px tall, scrolled to 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-503-plan.md`.

## Noticed while planning, not changed

Nothing beyond the open question below.

## Open questions

1. **Should an element that turns up in reaction to the capture's own scroll be hidden in that same slice?**
   - **What Chrome showed:** PageG's `#nav` turns sticky on the scroll to the second slice, and is stuck there at once. In 2 of 3 runs, that slice's listing ran before the page's scroll handler, and `#nav` was stitched in once at the top of the second slice (773-822).
   - **What this plan does:** it hides such an element from the next slice on.
   - **What the other way would take:** hiding it in the same slice means listing and checking after the page has reacted to the scroll, after the 500 ms settle for example. The capture would then have to wait for a frame painted after the hide.
   - **What that would affect:** it moves every sticky check (KAN-403, KAN-501, KAN-502) and would need its own measurements.
   - The ticket doesn't say which it wants.

   Filed as KAN-517, blocked by KAN-503.

## Added when shipping

- **One more test** in `tests/fullpage.test.js`, after "hides a header the page only makes sticky once it scrolls": "starts a new sticky list on the first slice".
  - It leaves a list on the page before the capture, the way a capture that never got to its restore would. Then it checks that nothing on that list is written.
  - It passes on the code as it was, and with this change.
  - It fails when `first` is ignored and the first slice adds to the left-over list. That is the one piece no test caught in "Checked while planning".
- `npm test` passes all 332.
