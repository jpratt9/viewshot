# KAN-403: Full page stitches a sticky element into every slice it stays stuck in

Ticket: https://prattsolutions.atlassian.net/browse/KAN-403 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-218, is Done.

## What the repo does now

Line numbers are from `0ff60ef`, with a clean working tree. The ticket's refs (`background.js:265-283`, `:285`) come from KAN-218's uncommitted tree. That code is at `:421-434` and `:436-462` today.

- **The marking** (`markStickyOnFirstScreen`, `background.js:421-434`):
  - It runs once, at `i === 0` (`:373`), while the page is at the top.
  - It keeps the sticky elements whose rect meets the first screen in `window.__shotSticky`, and records nothing else about them.
- **The hiding** (`setFixedHidden`, `background.js:436-462`):
  - It runs once, at `i === 1` (`:376`), and hides every `fixed` element plus the sticky elements in `window.__shotSticky`.
  - Nothing touches them again until the `finally` restores them (`:399`).
- **So in the ticket's case, the heading repeats:**
  - A sticky heading whose place is below the first screen is never marked, so it is never hidden.
  - The slice that holds its place shows it there.
  - Every later slice where it is still stuck to its container shows it again at the top. Those are the ticket's four copies, at `1200`, `1426`, `2139` and `2287`.
- **The ticket's `window.scrollY` can't be used as it is.** On a page whose `<body>` scrolls, `scrollY` always reads 0 (`background.js:275-279`). The stitch already has the real offset: `scrollPageTo` returns the scroller's `scrollTop` (`:331-336`), and the loop keeps it as `actual` (`:366`).
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 313.
  - `load()` (`:42-119`) fakes the page. `document.querySelectorAll` answers the `fixed` array a test passes in, and `getComputedStyle` answers each element's `pos`.
  - The sticky section (`:330-380`) builds its elements with `positioned()` (`:338`). Their rect never moves when the page scrolls, so no test can have an element get stuck.
  - Its tests pin KAN-218's rule:
    - `:347` checks that a sticky element below the first screen is never touched.
    - `:354` checks that a first-screen header is hidden once and then restored.
    - `:375` checks that the capture runs exactly 3 of these scripts, however many slices there are.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:** a sticky element is hidden in exactly the slices where it is away from its place in the page.
- Its place is read once, at the top of the page, as `rect.top + offset`.
- Before each later slice, it is hidden if `rect.top + offset` is more than a pixel off that place, and shown otherwise.
- `fixed` keeps today's behaviour: hidden from the second slice on.

1. **`background.js`**: the marking records every sticky element's place, a new per-slice pass hides the stuck ones, the fixed hide drops its sticky branch, and the restore puts the sticky elements back as well.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -368,12 +368,14 @@
          // Stop rather than stack the same viewport down the canvas.
          if (i > 0 && actual <= landed) break;
          landed = actual;
   -      // Which sticky elements this first screen shows, while the page is still
   -      // at the top: the ones further down have to be left alone below.
   -      if (i === 0 && positions.length > 1) await markStickyOnFirstScreen(tab);
   -      // Keep fixed/sticky elements (pinned headers, banners) on the FIRST slice
   -      // only; hide them on later slices so they aren't stitched in repeatedly.
   +      // Where each sticky element sits, read while the page is still at the
   +      // top and none of them is stuck yet.
   +      if (i === 0 && positions.length > 1) await markSticky(tab, actual);
   +      // Keep fixed elements (pinned headers, banners) on the FIRST slice only;
   +      // hide them on later slices so they aren't stitched in repeatedly.
          if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
   +      // Sticky ones only in the slices they are stuck in (KAN-403).
   +      if (i > 0) await hideStuckSticky(tab, actual);
          await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
          // captureVisibleTab hands back the last frame the window presented. A
          // window that isn't drawing - minimized, occluded - presents none, so
   @@ -413,46 +415,62 @@
    
    // Temporarily hide position:fixed / position:sticky elements (the cause of
    // repeated headers/banners in scroll-stitch), then restore them afterward.
   -// A sticky element is only worth hiding if it is one of the pinned ones the
   -// first slice already shows. The rest - sticky table headers, section headings,
   -// sidebars further down - never appear in that slice, so hiding them blanked
   -// them out of every slice that should have shown them. Run at the top of the
   -// page, where a sticky element is still where the document puts it.
   -async function markStickyOnFirstScreen(tab) {
   +// A sticky element repeats only in the slices it is stuck in, pinned to the
   +// top of the viewport instead of where the document puts it: a pinned header
   +// in every slice after the first, a sticky table header, section heading or
   +// sidebar further down in the slices after the one that holds its place.
   +// Hiding every sticky element blanked those out of the image (KAN-218), and
   +// hiding only the ones the first screen showed stitched them in again at the
   +// top of every slice they stayed stuck in (KAN-403). So each one's place is
   +// read at the top of the page, and each later slice hides the ones that are
   +// away from it. `offset` is where the stitch landed, not window.scrollY, which
   +// reads 0 on a page whose <body> is what scrolls (see measurePage).
   +async function markSticky(tab, offset) {
      await scriptWithTimeout({
        target: { tabId: tab.id },
   -    func: () => {
   +    func: (y) => {
          const list = [];
          for (const el of document.querySelectorAll('*')) {
            if (getComputedStyle(el).position !== 'sticky') continue;
   -        const r = el.getBoundingClientRect();
   -        if (r.bottom > 0 && r.top < window.innerHeight) list.push(el);
   +        list.push([el, el.getBoundingClientRect().top + y, el.style.visibility]);
          }
          window.__shotSticky = list;
        },
   +    args: [offset],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
    }
    
   +// Within a pixel of its place counts as in it: rects and scroll offsets are
   +// fractional.
   +async function hideStuckSticky(tab, offset) {
   +  await scriptWithTimeout({
   +    target: { tabId: tab.id },
   +    func: (y) => {
   +      for (const [el, top, v] of window.__shotSticky || []) {
   +        el.style.visibility = Math.abs(el.getBoundingClientRect().top + y - top) > 1 ? 'hidden' : v;
   +      }
   +    },
   +    args: [offset],
   +  }, CAPTURE_SCRIPT_TIMEOUT_MS);
   +}
   +
    async function setFixedHidden(tab, hide) {
      await scriptWithTimeout({
        target: { tabId: tab.id },
        func: (doHide) => {
          if (doHide) {
   -        // Only the sticky elements the first screen showed: window.__shotSticky
   -        // is what markStickyOnFirstScreen left behind. `fixed` is unconditional
   -        // - it is pinned to the viewport wherever the page is, so every later
   -        // slice would stitch it in again.
   -        const sticky = window.__shotSticky || [];
   +        // Only `fixed`: it is pinned to the viewport wherever the page is, so
   +        // every later slice would stitch it in again. Sticky elements are
   +        // hideStuckSticky's, slice by slice.
            const list = [];
            for (const el of document.querySelectorAll('*')) {
   -          const pos = getComputedStyle(el).position;
   -          if (pos !== 'fixed' && pos !== 'sticky') continue;
   -          if (pos === 'sticky' && !sticky.includes(el)) continue;
   +          if (getComputedStyle(el).position !== 'fixed') continue;
              list.push([el, el.style.visibility]); el.style.visibility = 'hidden';
            }
            window.__shotHidden = list;
          } else if (window.__shotHidden) {
            for (const [el, v] of window.__shotHidden) el.style.visibility = v;
   +        for (const [el, , v] of window.__shotSticky || []) el.style.visibility = v; // whatever hideStuckSticky left hidden
            window.__shotHidden = null;
            window.__shotSticky = null;
          }
   ```

2. **`tests/fullpage.test.js`**:
   - The harness records what each capture showed.
   - A new fake sticky element moves with the page and gets stuck.
   - The sticky tests change to the new rule, and one test is added.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -58,6 +58,9 @@
      // can't catch the bug: the old code drew at the offsets it asked for, which
      // look right even though every slice was the same unmoved viewport.
      const captureAt = [];
   +  // And what each capture showed of the fixed and sticky elements: the
   +  // visibility each one had at that moment, in the order the test passed them.
   +  const shownAt = [];
      let last = PNG;
      const scriptCalls = [];
      let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
   @@ -94,6 +97,7 @@
            captureVisibleTab: async () => {
              const at = Math.max(de ? de.scrollTop : 0, body ? body.scrollTop : 0);
              captureAt.push(at);
   +          shownAt.push(fixed.map((e) => e.style.visibility));
              if (captureAt.length === failAt) throw new Error('capture failed');
              // A window that draws hands back a different frame at each offset; one
              // that isn't drawing hands back the frame it last presented, forever.
   @@ -115,7 +119,7 @@
      vm.runInContext(CODE, context);
      captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
   -  return { ctx: context, canvases, scriptCalls, captureAt };
   +  return { ctx: context, canvases, scriptCalls, captureAt, shownAt };
    }
    
    const TAB = { id: 1, windowId: 9 };
   @@ -332,7 +336,9 @@
    // rest of the capture. That is right for a pinned header, which the first slice
    // already shows, but a sticky table header, section heading or sidebar further
    // down never appears in that slice: it was hidden in every slice that should
   -// have shown it, leaving blank space where it belongs.
   +// have shown it, leaving blank space where it belongs (KAN-218). Sparing it
   +// then stitched it in again at the top of every later slice it stayed stuck
   +// in (KAN-403): a sticky element is hidden only in the slices it is stuck in.
    
    // Keeps what the capture did to the element's visibility, in order.
    function positioned(pos, top, bottom) {
   @@ -344,18 +350,46 @@
      };
    }
    
   -test('leaves a sticky element that starts below the first screen alone', async () => {
   -  const heading = positioned('sticky', 900, 960); // a sticky table header a screen down
   -  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [heading] });
   +// A `top: 0` sticky element whose place in the page is `at`, in a container
   +// that ends at `end`: in its place until the page scrolls past it, then stuck
   +// to the top of the viewport until the end of its container carries it off.
   +function stickyAt(scroller, at, end, height = 40) {
   +  const e = positioned('sticky');
   +  e.getBoundingClientRect = () => {
   +    const top = Math.min(Math.max(at - scroller.scrollTop, 0), end - height - scroller.scrollTop);
   +    return { top, bottom: top + height };
   +  };
   +  return e;
   +}
   +
   +test('hides a sticky heading only in the slices it is stuck in', async () => {
   +  // The ticket's page: 3000 px tall in a 713 px viewport, with a 40 px heading
   +  // whose place is 1200 px down, in a container running to 2600 px.
   +  const body = el(3000, 713);
   +  const heading = stickyAt(body, 1200, 2600);
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading] });
      await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(heading.seen, [], 'blanked a sticky element the first slice never showed');
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // Shown in the slice that holds its place, hidden in the three it is stuck at the top of.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into a slice it was stuck in');
   +  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
    });
    
   +test('leaves a sticky element that is never stuck alone', async () => {
   +  const body = el(3052, 767);
   +  const heading = stickyAt(body, 900, 940); // its container ends where it does, so it only ever scrolls by
   +  const { ctx } = load({ de: el(767, 767), body, fixed: [heading] });
   +  await ctx.captureFullPage(TAB);
   +  assert.ok(!heading.seen.includes('hidden'), 'blanked a sticky element that was never stuck');
   +});
   +
    test('still hides a sticky header the first screen shows', async () => {
   -  const header = positioned('sticky', 0, 60);
   -  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [header] });
   +  const body = el(3052, 767);
   +  const header = stickyAt(body, 0, 3052, 60);
   +  const { ctx, shownAt } = load({ de: el(767, 767), body, fixed: [header] });
      await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(header.seen, ['hidden', ''], 'a pinned sticky header was stitched into every slice');
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden'], 'a pinned sticky header was stitched into every slice');
   +  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
    });
    
    test('still hides a fixed element wherever it sits', async () => {
   @@ -372,11 +406,11 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('marks and hides once on a page that needs several slices', async () => {
   +test('marks and hides fixed elements once, and checks sticky ones on every later slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the marking, the hiding, and the restore - one each, however many slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 3, 'the marking or the hiding ran more than once');
   +  // the marking, the fixed hide and the restore once each, and the sticky check on each of the three later slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 6, 'the marking or the fixed hide ran more than once, or a later slice went unchecked');
    });
    
    // --- a window that stops drawing -------------------------------------------
   ```

Choices:

- **Every sticky element goes through the per-slice check, the pinned header included.**
  - The header's place is 0. From the second slice on it is stuck at the top of the viewport, so it is hidden from the second slice on, the same as today.
  - So `setFixedHidden` now hides only `fixed`.
  - The first-screen test is gone. `markStickyOnFirstScreen` is renamed `markSticky` because it now records every sticky element.
- **The offset is `actual`, not `window.scrollY`.** This is the one departure from the ticket's wording, and it is the same comparison.
  - `actual` is the scroller's `scrollTop`. It equals `scrollY` on a page whose document scrolls, and it is right on one whose `<body>` scrolls, where `scrollY` reads 0.
  - Passing it in also saves repeating `measurePage`'s three-line scroller pick in a third function.
- **The per-slice pass walks only the recorded list**, not `querySelectorAll('*')`. Each slice adds one executeScript round trip and one rect read per sticky element. The marking walks the page once, as it does today.
- **The pass runs from the second slice on, and only when there is one.**
  - At the top, nothing marked there can be away from its place.
  - A page that fits one screen still runs none of these scripts.
- **The restore puts the sticky elements back too.**
  - It uses the visibility `markSticky` recorded, in the same `finally` call as the fixed elements.
  - `hideStuckSticky` only runs after `setFixedHidden(tab, true)` has set `hid`, so that restore always follows it.
- **A sticky element whose scroll container is not the page** (one inside an inner scroller) moves with the page. Its `rect.top + offset` never changes, so it is never hidden.
- **Within a pixel counts as in place**, because rects and scroll offsets are fractional at dpr 2 and under page zoom.
- **The tests check what each capture showed.**
  - `shownAt` records each positioned element's visibility at every capture. That lets a test state which slices showed it, which is the ticket's symptom.
  - `stickyAt()` builds on `positioned()`. It models a `top: 0` sticky element in a container.
- **No README, manifest or version change.** README's "sticky-header aware" (`README.md:6`) still holds.

## Checked while planning

Run on a copy of `HEAD` (`git archive`) in `/tmp/kan403-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 313.
- **Test change only:** 314 run and 312 pass. Two tests fail:
  - "hides a sticky heading only in the slices it is stuck in" fails with "the heading was stitched into a slice it was stuck in".
  - "marks and hides fixed elements once, and checks sticky ones on every later slice" fails on the call count.
- **Both changes:** all 314 pass.
- **Both changes, with one piece broken at a time:** each time, only the tests named below fail.

  | Piece broken | Failing tests | Messages |
  |---|---|---|
  | No `hideStuckSticky` call in the loop | "hides a sticky heading only…", "still hides a sticky header…", the call count | "the heading was stitched into a slice it was stuck in", "a pinned sticky header was stitched into every slice" |
  | `rect.top` compared without the offset | "hides a sticky heading only…", "leaves a sticky element that is never stuck alone", "still hides a sticky header…" | the two above, and "blanked a sticky element that was never stuck" |
  | The offset passed as 0 (what `window.scrollY` reads on these body-scroller pages) | the same three | the same three |
  | No sticky restore in `setFixedHidden(false)` | "hides a sticky heading only…", "still hides a sticky header…" | "left the heading hidden", "left the header hidden" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 314 and 312 pass. Only the two tests named in "Checked while planning" fail, with those messages.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 314.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-218.js --headful`.
   - **What the script does:** this is KAN-218's check, and it serves the ticket's own PageA:
     - a 60 px green sticky header at the top;
     - a 40 px red sticky heading whose place is 1200 px down, in a container running from 800 to 2600;
     - a blue fixed button.
     It loads the extension unpacked, presses Full page in the popup with PNG as the format, and saves to a temp dir.
   - **Reading the result:** `python3 /tmp/vs387-chrome/bands.py <file>` prints the device-pixel rows of each colour. Halve them for CSS px at dpr 2.
   - **Why a real window:** under `--headless=new`, KAN-218 got the first frame back for every slice. The ticket's figures come from a real window at 1280x713, dpr 2.
   - **Two builds:** run each case with `--ext` pointed first at a copy of `HEAD` (`git archive HEAD | tar -x -C /tmp/kan403-head`), then at the repo.

   → verify:
   - PageA (3000 px):
     - **On `HEAD`:** red at 1200-1239, 1426-1465, 2139-2178 and 2287-2326 CSS px. These are the ticket's four copies.
     - **With the change:** red at 1200-1239 only.
     - **On both builds:**
       - green appears once, at 0-59;
       - blue appears once, at 653-692;
       - `after` reports `top`, `btn` and `mid` as `visible`, and `scrollY` as 0.
   - A page that fits one screen (`--tall 0`), on both builds:
     - it saves;
     - green and blue appear once each;
     - `after` reports everything as `visible`.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-403-plan.md`.

## Noticed while planning, not changed

- **A sticky element can already be stuck at the top of the page.** For example, a `bottom: 0` bar whose place is further down is pinned to the bottom of the first screen.
  - Its stuck spot is recorded as its place, so it is hidden in every later slice, including the one that holds its real place.
  - It shows once, at the bottom of the first screen. Today's code does the same, because the first screen shows it.
- **An element whose place moves during the capture reads as stuck.** If content above it loads in and pushes it down, it is away from the place recorded at the top. It is then hidden in the slice that holds it, which is the one way this rule can blank an element that today's code shows. On such a page the stitch is already misaligned, since each slice is drawn where the page was when it was shot.
- **Two captures at once (KAN-213) now clash over `window.__shotSticky` as well as `window.__shotHidden`.**
  - A second capture's `markSticky` can record the first capture's `hidden` as a heading's own visibility.
  - The heading then stays hidden after both restores, like the fixed headers KAN-213 describes.
  - KAN-213's one-capture-at-a-time fix covers both.

## Open questions

None. The ticket names the mechanism: record each sticky element's place at the top, and hide and restore per slice. This plan follows it, with the stitch's own offset in place of `window.scrollY`, for the reason given above.
