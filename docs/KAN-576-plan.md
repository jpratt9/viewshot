# KAN-576: Full page stitch takes a page's own scroll between slices for content moving above the viewport

Ticket: https://prattsolutions.atlassian.net/browse/KAN-576 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-515, is Done.

## What the repo does now

Line numbers are from `04c9ffb`, with a clean working tree.

- **Each slice after the first scrolls on from where the page is.**
  - `scrollAndReport` (`background.js:379-412`) reads `from = el.scrollTop` before it scrolls. With `fromHere` set, it adds `from` to `to` (`:403-405`). It returns `{ from, actual, total }` (`:411`).
  - `scrollPageTo` (`:438-447`) passes `fromHere` through.
  - The loop asks for `target - landed` from there on every slice after the first (`:487`, `i > 0`).
- **The page's whole move is taken for content above the screen changing height.**
  - `moved = from - landed` (`:488`).
  - The slice is drawn at `actual = reached - moved` (`:489`). The draws that use it are at `:595` and `:607`.
  - The page's height is counted as `total - moved` (`:490`). The stop check (`:620`), the next target (`:621`) and the trim (`:647`) read that value.
  - Nothing else feeds `moved`. `total` comes back on every slice, but nothing compares it with the page's height at the slice before.
  - The result for a page that scrolls itself between slices:
    - its own scroll is taken for content above that grew;
    - the next slice goes that far past its target;
    - that slice and every one after it are drawn that far back.

    That is the choice the KAN-515 plan names (`docs/KAN-515-plan.md:235-237`).
- **Tests:** `npm test` passes 413.
  - No test has a page that scrolls itself.
  - The KAN-515 tests (`tests/fullpage.test.js:338-365`) use `anchoredPage(by)`, whose height and offset change by the same amount, as scroll anchoring changes them.

**The ticket's harness case, reproduced.** The page is `load()` with a 3000 px body scroller in a 713 px viewport at dpr 1. It scrolls itself 200 px down right after the second shot, and its height doesn't change.

| | `captureAt` | draws | image |
|---|---|---|---|
| `HEAD` | 0, 713, 1626, 2287 | 0, 713, 1426, 2087 | trimmed to 2800 px |
| With the change | 0, 713, 1426, 2139, 2287 | 0, 713, 1426, 2139, 2287 | 3000 px |

**Reproduced in Chrome 153.0.8010.48.** The ticket says it wasn't.

- **The script:** `/tmp/vs387-chrome/run-576.js`, a copy of `run-583.js` (see `docs/KAN-583-plan.md`) with one more page, `selfscroll`.
  - `selfscroll` is PageG with anchoring on and nothing that changes height.
  - The page has its own `window.scrollItself()`, which scrolls it 200 px down.
  - The run wraps the worker's `captureVisible` so the page calls `scrollItself()` in its own world right after the second shot, the same moment the harness uses. `captureVisible` is a global the stitch looks up on every shot, because `background.js` is a classic script.
  - The other pages run exactly as they do in `run-583.js`.
- **The run:** headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1. The PNGs are read with `/tmp/vs387-chrome/bands-515.py`.
- **The results.**
  - "In place" means each band shows once, at its place at the start (yellow 600, red 1300, green 1500, blue 2500), in a 3000 px image.
  - `selfscroll` and `still` were run on a copy of `04c9ffb`. The `HEAD` results for the other pages are the ones the KAN-583 plan gives for the same `background.js`.

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `selfscroll` | offsets 713, 913, 1626, 2287; yellow 600, red 1300, green nowhere, blue 2300; 2800 tall | offsets 713, 913, 1426, 2139, 2287; in place, a PNG byte-identical to `still`'s |
  | `still` | offsets 713, 1426, 2139, 2287; in place | byte-identical to `HEAD`'s |
  | `grow` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor` | in place | byte-identical to `HEAD`'s |
  | `shrink-noanchor` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor-important` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor-important-layer` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor-important-inline` | in place | byte-identical to `HEAD`'s |
  | `grow-compensate` | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall (KAN-580) | byte-identical to `HEAD`'s |

- **On `HEAD`, `selfscroll` is the ticket's case in real Chrome.** The page's own 713 → 913 is taken for content above that grew. Green, at 1426-1625 in the page, is never shot, and blue is drawn 200 px up.
- **`grow-compensate` is unchanged.** Its height changes between the second and third slices, so the change still scrolls on from where the page is, as today.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan576-plan/tree`.

**The rule:**
- The page's height tells a page's own scroll apart from content above changing height.
  - Content above the rows that loads in or goes away changes the page's height by as much as scroll anchoring moves the offset.
  - A page that scrolls itself moves the offset and leaves the height as it was.
- If the page is as tall as it was, each slice after the first scrolls on from where the last slice's scroll left the page. Otherwise it scrolls on from where the page is now, as today.
- On a page that doesn't scroll itself, both are the same offset, so every scroll and draw is the same as today.

1. **`background.js`**
   - **`scrollAndReport` (`:379-412`):**
     - Its third parameter, `fromHere`, becomes `last`. `last` is the last slice's report, `{ from, actual, total }`. The first slice and the cleanup scroll pass nothing.
     - `from` (`:403-405`) is `last.actual` when the page's `scrollHeight` is still `last.total`, and `el.scrollTop` otherwise. `to` is scrolled on from it when `last` is given.
     - It still returns `{ from, actual, total }` (`:411`). `from` is now where the last slice's rows are, which is what the loop's comment at `:481-486` says the scroll goes on from.
   - **`scrollPageTo` (`:438-447`):** passes `last` through in place of `fromHere`. Its fallback is unchanged.
   - **`captureFullPage`:**
     - It keeps the last slice's report in `last` (after `:475`) and passes it to the scroll (`:487`) in place of `i > 0`.
     - `last` is `null` for the first slice, so that slice still goes to the top.
     - The code after `:487` is unchanged: `moved`, `actual`, `m.total`, the stop checks, the next target, the draws, the footer and the trim.
   - **No new page script:**
     - The call-order tests (`tests/fullpage.test.js:814`, `:914`, `:983-996`) are untouched.
     - The same script already reads `scrollHeight` (`:411`), so no fake document needs anything new.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -376,7 +376,7 @@
      };
    }
    
   -function scrollAndReport(to, cleanup, fromHere) {
   +function scrollAndReport(to, cleanup, last) {
      const de = document.documentElement, b = document.body;
      let el = window.__vsScroller;
      if (!el) {
   @@ -400,9 +400,14 @@
        delete window.__vsAnchored;
      }
      const isRoot = el === de || el === b || el === document.scrollingElement;
   -  // Where the page is before it moves. fromHere scrolls `to` on from there.
   -  const from = el.scrollTop;
   -  if (fromHere) to += from;
   +  // Where the last slice's rows are now, before the page moves. With `last`,
   +  // the last slice's report, `to` is scrolled on from there. Content above
   +  // them that changed height moved them, and scroll anchoring moved the page
   +  // with them (KAN-515). A page as tall as it was when that scroll left it has
   +  // had nothing change height: if it has moved since, it scrolled itself, and
   +  // the rows are still where that scroll left them (KAN-576).
   +  const from = last && el.scrollHeight === last.total ? last.actual : el.scrollTop;
   +  if (last) to += from;
      // 'instant' overrides a page's `scroll-behavior: smooth` (Bootstrap 5,
      // Tailwind's scroll-smooth). Without it the scroll animates, the read below
      // still sees the old offset, and the stitch stops after the first screen.
   @@ -435,13 +440,13 @@
      return result === true;
    }
    
   -// Scroll to y (with fromHere, y past where the page is now) and report where
   -// the page ACTUALLY landed. The caller stitches at the returned offset rather
   -// than the requested one, so a page that clamps, animates, or ignores the
   -// scroll still produces a correctly aligned image.
   -async function scrollPageTo(tab, y, cleanup = false, fromHere = false) {
   +// Scroll to y (with `last`, the last slice's report, y past where its rows are
   +// now) and report where the page ACTUALLY landed. The caller stitches at the
   +// returned offset rather than the requested one, so a page that clamps,
   +// animates, or ignores the scroll still produces a correctly aligned image.
   +async function scrollPageTo(tab, y, cleanup = false, last = null) {
      const [{ result }] = await scriptWithTimeout({
   -    target: { tabId: tab.id }, func: scrollAndReport, args: [y, cleanup, fromHere],
   +    target: { tabId: tab.id }, func: scrollAndReport, args: [y, cleanup, last],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
      return result || { from: 0, actual: 0, total: 0 };
    }
   @@ -473,6 +478,7 @@
      let maxCanvasHeight = Math.floor(Math.min(side, MAX_AREA / (w * scale)));
    
      let hid = false, landed = 0, target = 0, i = 0;
   +  let last = null; // the last slice's scroll report: where it left the page, and how tall the page was (KAN-576)
      let footerCanvas = null;
      // finally: a slice that throws part-way must still put the page back, not
      // leave it scrolled to where the stitch stopped with its headers hidden.
   @@ -484,7 +490,8 @@
          // moves the page with them, so they are now `moved` px from where they
          // were drawn. The slice is drawn, and the page's height counted, that
          // much back, so it lines up with the slices before it (KAN-515).
   -      const { from, actual: reached, total } = await scrollPageTo(tab, target - landed, false, i > 0);
   +      last = await scrollPageTo(tab, target - landed, false, last);
   +      const { from, actual: reached, total } = last;
          const moved = i > 0 ? from - landed : 0;
          const actual = reached - moved;
          m.total = total - moved;
   ```

2. **`tests/fullpage.test.js`:** a new section after the KAN-515 tests. It goes after `:382` and before "pages that turn scroll anchoring off" (`:384`).
   - It holds one test: the ticket's harness page, which scrolls itself 200 px down right after the second shot.
   - The test checks where each slice was shot, where each was drawn, and the image's height.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -380,7 +380,28 @@
      await ctx.captureFullPage(TAB);
      assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0], 'went on past a scroll that came back with nothing');
    });
   +
   +// --- a page that scrolls itself between slices -----------------------------
   +// Each slice scrolled on from where the page was, so a page that scrolled
   +// itself between slices had its own scroll taken for content above the screen
   +// changing height: the rows it scrolled past were left out, and every slice
   +// after was drawn that far above where the page has it. A page as tall as it
   +// was when the last slice's scroll left it has had nothing above change
   +// height, so the next slice now scrolls on from where that scroll left it
   +// (KAN-576).
    
   +test('lines the slices up on a page that scrolls itself between them', async () => {
   +  const body = el(3000, 713);
   +  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  // The page scrolls itself 200 px down right after the second shot. Its height doesn't change.
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { const url = await shoot(...a); if (captureAt.length === 2) body.scrollTop += 200; return url; };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'scrolled on from where the page scrolled itself to');
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], "drew the slices back by the page's own scroll");
   +  assert.strictEqual(canvases[canvases.length - 1].height, 3000, "cut the image short by the page's own scroll");
   +});
   +
    // --- pages that turn scroll anchoring off ----------------------------------
    // The stitch sees content above the screen change height by how far scroll
    // anchoring moves the offset (KAN-515). A page with `overflow-anchor: none`
   ```

**Choices:**

- **The page's height tells the two apart.**
  - The height is already read in the scroll script that runs on every slice, so there is no new page pass.
  - The KAN-575 plan names another way: reading one element's place in the page on every slice. That way needs a rule for which element to read.
- **A page is taken to have scrolled itself only when it is as tall as it was.**
  - Suppose a page scrolls itself between two slices and its height also changes between them, for example because an image below the screen loads. Its whole move is still taken for content above changing height, as today. See Open questions.
  - Suppose content above changes height while other content changes by exactly the opposite amount. The page is now taken to have scrolled itself.
  - Taking the smaller of the move and the height change would cover part of the first case. But it gets one case wrong that is right today: a page where content above shrinks while content below grows.
- **The page's own scroll is scrolled past, not shot.** The next slice goes one screen on from where the last slice's scroll left the page, as the slices after it did before KAN-515. The rows the page scrolled past are shot, and no rows are shot twice.
- **`fromHere` becomes `last`,** because the page script now needs the last slice's offset and height. Passing the whole report keeps it to one argument, in the shape `scrollAndReport` already returns.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 414 tests and 413 pass. The one that fails is "lines the slices up on a page that scrolls itself between them", with `captureAt` at `[0, 713, 1626, 2287]`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 414.
3. In real Chrome, run `node /tmp/vs387-chrome/run-576.js --ext /Users/john/dev/viewshot --page <page>` for these pages: `selfscroll`, `still`, `grow`, `grow-noanchor`, `shrink-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline` and `grow-compensate`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. If a run saves no file, run it again. → verify:
   - On `selfscroll`:
     - the page's offsets are 713, 913, 1426, 2139, 2287;
     - yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image.
   - All nine PNGs have the md5s listed under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan576-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 413 |
| `HEAD` + the `background.js` diff only | passes 413 |
| `HEAD` + the test diff only | 413 of 414 pass; the new test fails, with `captureAt` at `[0, 713, 1626, 2287]` |
| `HEAD` + both diffs | passes 414 |
| both diffs, scrolling on from `last.actual` whatever the height | grow and shrink fail, with `captureAt` at `[0, 1013, 1426, 2139, 2587]` and `[0, 413, 1426, 1987]`, the offsets from before KAN-515 |

**The harness page:** `/tmp/kan576-plan/probe.js <tree>` runs the new test's page on a tree and prints `captureAt`, the draws and the image's height. The results are in the first table under "What the repo does now".

**Chrome:** see the second table and notes under "What the repo does now".
- **PNG md5s:**
  - `c5eebb48c46485161d24873e68c29c93`: every "in place" run. That includes `selfscroll` with the change and `still` on `HEAD`.
  - `9f3d4fa5468292b823f7555248f646c6`: `shrink-noanchor`.
  - `f891b0521729f45f95db8d3006ee90e0`: `grow-compensate`.
  - `da1fb0758094f02254de3919bce5b166`: `selfscroll` on `HEAD`.
- **The md5s match the KAN-583 plan.** The first three are the md5s it lists for these pages.
- **Runs that saved no file:** the first runs of `selfscroll` and `still` on `HEAD`. Both saved a file when run again.

## Open questions — settled

The plan left one question open. It is settled here, and it doesn't change the code shipped in `6e85e7c`.

1. **Should a page that scrolls itself between two slices, while its height also changes between them, be covered too?** Not as part of KAN-576.
   - **What the ticket covers:** a page that scrolls itself between slices, where "its height doesn't change". `6e85e7c` lines that page up; see the `selfscroll` runs above.
   - **Why this case is different:** the page's height is what tells the two apart.
     - When the height changes in the same gap, for example because content below the screen loads in, the whole move is still taken for content above changing height, as before.
     - `selfscroll-grow` shows this. It is `selfscroll`, plus 100 px added at the end of the page at the moment it scrolls itself, in `/tmp/vs387-chrome/run-576.js`.
     - Run after the change, it leaves green out and draws blue 200 px up, in a 2900 px image. That is the same PNG as on `04c9ffb`.
   - **What covering it would take:** some measure of content above the rows other than the page's height. One example is reading one element's place in the page on every slice, the other way the KAN-575 plan names. That needs a rule for which element to read.
   - **Follow-up:** KAN-590, filed from this question.

**Other follow-ups:**
- **KAN-591**, filed from the choice above about content above that changes height while other content changes by exactly the opposite amount.
- **KAN-592**, a page that scrolls itself while a slice settles, before its shot, filed alongside the other two.

**This ticket blocks all three.**
