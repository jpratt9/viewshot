# KAN-515: Full page stitch doesn't line up when content above the viewport changes height during the capture

Ticket: https://prattsolutions.atlassian.net/browse/KAN-515 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-502, is Done.

## What the repo does now

Line numbers are from `ddbb60c`, with a clean working tree. The ticket's refs (`background.js:366`, `:398-399`) came from the uncommitted KAN-502 change.

- **Each slice is drawn at the offset its own scroll reached.**
  - `scrollAndReport` (`background.js:355-380`) scrolls to an absolute offset and returns `{ actual, total }`, read straight after the scroll (`:379`).
  - The loop takes those at `:448-449`.
  - It draws every slice at `actual`: `:516-518` for the canvas growth, `:554-555` for an inner scroller, `:566-567` for the page itself.
  - The next target is always one screen on from the last target (`:580`).
- **Nothing sees the page move between slices.**
  - Content above the screen that loads in or goes away changes the height of everything above the rows on screen. Chrome's scroll anchoring, on by default, moves the offset by the same amount, so those rows stay where they are.
  - The next scroll still goes to the old absolute target, so every slice after it is drawn off by that amount. Where the page grew, rows are stitched twice. Where it shrank, rows are left out.
  - The image's height is off by the same amount (`:607-608`).
- **Tests:** `npm test` passes 402. No test has content above the screen change height. The KAN-502 test (`tests/fullpage.test.js:423`) moves content, but it only checks whether a sticky heading is shown or hidden.

**Reproduced in Chrome 153.0.8010.48.** The ticket says it wasn't.

- **The run:** headless, with a disposable profile and the tree loaded unpacked. PNG, with a 1280×713 viewport at dpr 1, the same setup as the KAN-502 run.
- **The script:** `/tmp/vs387-chrome/run-515.js`, a copy of `run-502.js` with PageG swapped in and `--page` to pick the variant. It is read with `/tmp/vs387-chrome/bands-515.py`.
- **PageG:** white, and 3000 px tall at the start.
  - A cyan 60 px `top: 0` header sits at 0 and a grey block at 100 px.
  - 40 px bands sit at yellow 600, red 1300, green 1500 and blue 2500. These are their places in the page as it was at the start.
  - The block changes height on the page's first scroll, the one to 713, when it is above the screen:

  | `--page` | Grey block |
  |---|---|
  | `grow` | 200 → 500 px |
  | `shrink` | 500 → 200 px |
  | `grow-noanchor` | 200 → 500 px, with `overflow-anchor: none` |
  | `still` | never changes |

- **The offsets the page went through,** logged by a scroll listener in the page. The 713 → 1013 and 713 → 413 steps are Chrome's scroll anchoring:

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `grow` | 713, 1013, 1426, 2139, 2587 | 713, 1013, 1726, 2439, 2587 |
  | `shrink` | 713, 413, 1426, 1987 | 713, 413, 1126, 1839, 1987 |
  | `grow-noanchor` | 713, 1426, 2139, 2587 | the same |
  | `still` | 713, 1426, 2139, 2287 | the same |

- **The rows each band fills in the saved PNG:**

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `grow` | red at 1300 and at 1600, green 1800, blue 2800; 3300 tall | red 1300, green 1500, blue 2500; 3000 tall |
  | `shrink` | red 1300, green nowhere, blue 2200; 2700 tall | red 1300, green 1500, blue 2500; 3000 tall |
  | `grow-noanchor` | yellow at 600 and at 900, red 1600, green 1800, blue 2800; 3300 tall | the same as `HEAD` |
  | `still` | every band in its place; 3000 tall | a PNG byte-identical to `HEAD`'s |

- **That is the ticket's case:** on `HEAD`, red is stitched in twice where the page grew, and green is left out where it shrank.
- **With the change,** the grey block is shown at the height it had when the first slice was shot, 100-299 on `grow`. The image shows each part of the page as it was when that part was shot.
- **`grow-noanchor` is not fixed.** With anchoring off, the rows move on screen rather than the offset, and nothing in the offset shows it. See Open questions.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan515-plan/tree`.

**The rule:**
- From the second slice on, each scroll goes one step on from where the last slice's rows are now (`from`), not to an absolute offset.
- `from - landed` is how far the page has moved under the stitch (`moved`). The slice is drawn `moved` px back, and the page's height is counted `moved` px shorter.
- On a page where nothing moves, `from` is the last offset, so every scroll and draw is the same as today.

1. **`background.js`**
   - **`scrollAndReport` (`:355-380`):**
     - It takes a third parameter, `fromHere`.
     - Before scrolling, it reads `from = el.scrollTop` (after `:373`) and adds that to `to` when `fromHere` is set.
     - It returns `from` along with `actual` and `total` (`:379`).
   - **`scrollPageTo` (`:406-414`):**
     - It passes `fromHere` through (`:411`).
     - Its fallback gains `from: 0` (`:413`). Without it, a scroll that comes back with no result makes `moved` `NaN`, and the loop never ends. With it, that scroll still reads as a page that won't advance.
   - **`captureFullPage` (`:448-449`):**
     - The scroll asks for `target - landed` from where the page is now. That is an absolute 0 on the first slice.
     - `moved = from - landed`, `actual = reached - moved`, and `m.total = total - moved`.
     - The code after it reads `actual`, `landed` and `m.total` as before and is unchanged: the two stop checks (`:452`, `:579`), the next target (`:580`), the canvas growth (`:516-535`), the draws (`:554-555`, `:566-567`), the footer (`:585`) and the trim (`:607-608`).
   - **No new page script:** the call-order tests (`tests/fullpage.test.js:646`, `:653`, `:743`, `:803`) are untouched.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -352,7 +352,7 @@
      };
    }
    
   -function scrollAndReport(to, cleanup) {
   +function scrollAndReport(to, cleanup, fromHere) {
      const de = document.documentElement, b = document.body;
      let el = window.__vsScroller;
      if (!el) {
   @@ -371,12 +371,15 @@
      }
      if (cleanup) delete window.__vsScroller;
      const isRoot = el === de || el === b || el === document.scrollingElement;
   +  // Where the page is before it moves. fromHere scrolls `to` on from there.
   +  const from = el.scrollTop;
   +  if (fromHere) to += from;
      // 'instant' overrides a page's `scroll-behavior: smooth` (Bootstrap 5,
      // Tailwind's scroll-smooth). Without it the scroll animates, the read below
      // still sees the old offset, and the stitch stops after the first screen.
      el.scrollTo({ top: to, behavior: 'instant' });
      if (isRoot) window.scrollTo({ left: 0, top: to, behavior: 'instant' }); // no-op unless the document itself is the scroller
   -  return { actual: el.scrollTop, total: el.scrollHeight };
   +  return { from, actual: el.scrollTop, total: el.scrollHeight };
    }
    
    // Ask the page for a frame. A window that isn't drawing - minimized, occluded -
   @@ -403,14 +406,15 @@
      return result === true;
    }
    
   -// Scroll to y and report where the page ACTUALLY landed. The caller stitches
   -// at the returned offset rather than the requested one, so a page that clamps,
   -// animates, or ignores the scroll still produces a correctly aligned image.
   -async function scrollPageTo(tab, y, cleanup = false) {
   -  const [{ result }] = await scriptWithTimeout({
   -    target: { tabId: tab.id }, func: scrollAndReport, args: [y, cleanup],
   +// Scroll to y (with fromHere, y past where the page is now) and report where
   +// the page ACTUALLY landed. The caller stitches at the returned offset rather
   +// than the requested one, so a page that clamps, animates, or ignores the
   +// scroll still produces a correctly aligned image.
   +async function scrollPageTo(tab, y, cleanup = false, fromHere = false) {
   +  const [{ result }] = await scriptWithTimeout({
   +    target: { tabId: tab.id }, func: scrollAndReport, args: [y, cleanup, fromHere],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
   -  return result || { actual: 0, total: 0 };
   +  return result || { from: 0, actual: 0, total: 0 };
    }
    
    // ---- full page: scroll the viewport and stitch ----
   @@ -445,8 +449,16 @@
      // leave it scrolled to where the stitch stopped with its headers hidden.
      try {
        while (true) {
   -      const { actual, total } = await scrollPageTo(tab, target);
   -      m.total = total;
   +      // The first slice goes to the top. Each later one scrolls on from where
   +      // the last one's rows are now, not to a fixed offset. Content above them
   +      // that loads in or goes away moves them, and Chrome's scroll anchoring
   +      // moves the page with them, so they are now `moved` px from where they
   +      // were drawn. The slice is drawn, and the page's height counted, that
   +      // much back, so it lines up with the slices before it (KAN-515).
   +      const { from, actual: reached, total } = await scrollPageTo(tab, target - landed, false, i > 0);
   +      const moved = i > 0 ? from - landed : 0;
   +      const actual = reached - moved;
   +      m.total = total - moved;
          // The page refused to advance (unscrollable, or a scroller we can't drive).
          // Stop rather than stack the same viewport down the canvas.
          if (i > 0 && actual <= landed) break;
   ```

2. **`tests/fullpage.test.js`:** a new section before "a stitch that stops part-way" (`:321`). It holds:
   - `anchoredPage(by)`, a fake page whose content above the screen changes height by `by` px while the second slice settles. The offset moves by the same amount, as scroll anchoring moves it.
   - Two tests on that fake, one with a page that grows and one with a page that shrinks.
   - One test for a scroll that comes back with nothing.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -316,8 +316,64 @@
      const { ctx, captureAt } = load({ de: smoothEl(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
      await ctx.captureFullPage(TAB);
      assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200], 'stopped before the end of the page');
   +});
   +
   +// --- content above the screen that changes height --------------------------
   +// Each slice was drawn where the page was when it was shot. Content above the
   +// screen that loads in or goes away moves everything under it, and Chrome's
   +// scroll anchoring moves the page with it, so every slice after that was drawn
   +// off from the ones before: the rows the page grew by went in twice, and the
   +// rows it shrank by not at all. They are now drawn back by as much (KAN-515).
   +
   +// A page whose content above the screen changes height by `by` px while the
   +// second slice settles, with the offset moved by as much, the way scroll
   +// anchoring does it.
   +function anchoredPage(by) {
   +  let height = 3000, top = 0, changed = false;
   +  const body = {
   +    clientHeight: 713,
   +    get scrollHeight() { return height; },
   +    get scrollTop() { return top; },
   +    set scrollTop(v) { top = Math.max(0, Math.min(v, height - 713)); },
   +    scrollTo(o) { this.scrollTop = o.top; },
   +  };
   +  const page = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  const timer = page.ctx.setTimeout;
   +  page.ctx.setTimeout = (fn, ms) => { if (ms === 500 && top && !changed) { changed = true; height += by; top += by; } return timer(fn, ms); };
   +  return page;
   +}
   +
   +test('lines the slices up after content above the screen grows', async () => {
   +  const { ctx, canvases, captureAt } = anchoredPage(300);
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 1013, 1726, 2439, 2587]);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], 'drew the rows the page grew by twice');
    });
    
   +test('lines the slices up after content above the screen shrinks', async () => {
   +  const { ctx, canvases, captureAt } = anchoredPage(-300);
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 413, 1126, 1839, 1987]);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], 'left out the rows the page shrank by');
   +});
   +
   +test('stops after one slice when a scroll comes back with nothing', async () => {
   +  // A scroll with no result reads as a page that won't advance, as it did
   +  // before the scroll reported where it started. Without `from` in
   +  // scrollPageTo's fallback, the slice is drawn at NaN and the stitch never
   +  // ends (KAN-515).
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767) });
   +  const run = ctx.chrome.scripting.executeScript;
   +  let scrolls = 0;
   +  ctx.chrome.scripting.executeScript = async (o) => {
   +    if (o.func.name !== 'scrollAndReport' || ++scrolls === 1) return run(o);
   +    if (scrolls > 5) throw new Error('kept on scrolling');
   +    return [{}];
   +  };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0], 'went on past a scroll that came back with nothing');
   +});
   +
    // --- a stitch that stops part-way ------------------------------------------
    // The page was only put back after the last slice, so a slice that threw left
    // it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   ```

**Choices:**

- **Scroll anchoring does the measuring.**
  - `from` is read in the scroll script that already runs on every slice.
  - A separate read before each scroll would add a page script per slice and change the four call-order tests.
- **Nothing is shot again.** Content above that grew stays in the image at the size it had in the slice that holds it.
- **A page that scrolls itself between slices** can't be told apart from anchoring.
  - Its own scroll is taken as the page having moved, and the slices after it are drawn back by that much.
  - Today they are drawn at their absolute targets.
- **No README, manifest or version change.**

## Steps

1. Apply the `background.js` diff. → verify: `npm test` passes 402, so nothing changes on a page that doesn't move.
2. Apply the `tests/fullpage.test.js` diff. → verify:
   - `npm test` passes 405.
   - With step 1 taken back out, the grow and shrink tests fail, with `captureAt` at `[0, 1013, 1426, 2139, 2587]` and `[0, 413, 1426, 1987]`.
3. In real Chrome, run `node /tmp/vs387-chrome/run-515.js --ext /Users/john/dev/viewshot --page grow`, then `--page shrink` and `--page still`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. → verify:
   - On `grow` and `shrink`, red, green and blue each show once, at 1300, 1500 and 2500, and the image is 3000 tall.
   - `still` matches `HEAD`'s run.

## Checked while planning

**Tests:** run on copies of `HEAD` (`git archive`) in `/tmp/kan515-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 402 |
| `HEAD` + the `background.js` diff | passes 402 |
| `HEAD` + both diffs | passes 405 |
| `HEAD` + the test diff only | 403 pass; grow and shrink fail |
| both diffs, without `- moved` on `m.total` | shrink fails: its last slice is shot at 1687 and drawn at 1987, so the image ends 300 rows short |
| both diffs, without `from: 0` in the fallback | "stops after one slice when a scroll comes back with nothing" fails with "kept on scrolling" |

**Chrome:** see the tables under "What the repo does now".

## Open questions

1. **Should pages that turn scroll anchoring off (`overflow-anchor: none`) be covered too?**
   - On those pages, content above the screen moves the rows on screen and leaves the offset alone. `from` doesn't change, and this plan leaves their stitch as it is today (`grow-noanchor` above).
   - The ticket doesn't say whether they count. Covering them would need one of two approaches, and the ticket doesn't choose between them:
     - Force anchoring on for the capture, with a `* { overflow-anchor: auto !important }` rule injected like the scrollbar style. This changes how the page itself behaves while it is shot.
     - Read one element's place in the page on every slice. That is a new page pass.
