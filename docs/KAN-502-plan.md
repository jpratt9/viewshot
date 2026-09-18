# KAN-502: Full page blanks a sticky element whose place moves during the capture

Ticket: https://prattsolutions.atlassian.net/browse/KAN-502 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-403, is Done.

## What the repo does now

Line numbers are from `f943ea2`, with a clean working tree. The ticket's refs (`background.js:428-441`, `:445-455`) came from the uncommitted KAN-403 change. The same code is now `markSticky` at `background.js:429-477` and `hideStuckSticky` at `:481-491`.

- **Each place is read once** (`markSticky`, called only on the first slice at `:373`):
  - It lists every sticky element, including those in shadow roots (`:438-445`).
  - It sorts out the ones that stick to the page from the ones inside a scroller of their own (`:464-469`).
  - Then it records each one's place as `rect.top + offset` (`:470-473`). The page's own sticky elements are read with `position: static`, and the others where they are painted. The record is at `:472`: `window.__shotSticky = list.map((el) => [el, el.getBoundingClientRect().top + y, el.style.visibility])`.
- **Every slice compares against that place** (`hideStuckSticky`, called on every slice at `:379`):
  - At `:486` it hides any element painted more than a pixel away from the recorded place: `Math.abs(el.getBoundingClientRect().top + y - top) > 1 ? 'hidden' : v`.
  - Nothing reads the place again.
- **What follows:**
  - An element whose place moves after the first slice is away from the recorded place in the slice that holds its new place. Content loading in above it is one way that happens.
  - So it is hidden there, and it is hidden where it is stuck as well. It appears nowhere in the image.
  - The same goes for an element inside a scroller of its own, whose recorded place is where it was painted at the top.
- **The restore** (`setFixedHidden(false)`, `:518`) gives each entry of `window.__shotSticky` its own visibility back.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 328.
  - The sticky fakes `stickyAt` (`:379`) and `stickyToBottomAt` (`:393`) each have a place that never moves.
  - "counts a sticky element within a pixel of its place as in it" (`:434-443`) reads the fake half a pixel off once the page has scrolled, however the rect is read.

**Reproduced in Chrome 153.0.8010.48.** The ticket says it wasn't.

- **The run:** headless, with a disposable profile and `HEAD` loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** a new one written while planning, `/tmp/vs387-chrome/run-502.js`, read with `/tmp/vs387-chrome/bands-502.py`. It copies `run-511.js` and swaps in PageF.
- **PageF:** white, and 3000 px tall when the capture starts.
  - **`#top`:** cyan `#00ffff`, 60 px, `position: sticky; top: 0` in `<body>`, at 0. Nothing loads in above it, so its place never moves.
  - **`#lazy`:** a 200 px block at 1000 px. The first time the page scrolls, it grows to 500 px, the way a lazy image comes in.
  - **`#moved`:** magenta `#ff00ff`, 40 px, `position: sticky; top: 0`, at the top of a 1400 px section right after `#lazy`. Its place goes from 1200 px to 1500 once `#lazy` grows.
  - Scroll anchoring is off (`overflow-anchor: none`), so Chrome doesn't move the page to make up for the growth.
- **The slices:** at 0, 713, 1426, 2139 and 2287. `#lazy` grows on the scroll to 713.

| Element | Rows on `HEAD` |
|---|---|
| cyan `#top` (place never moves) | 0-59 |
| magenta `#moved` (place moves from 1200 to 1500) | none |

- **That is the ticket's case:** the heading is left out of the image. In the slice at 1426 it is in its new place at 1500-1539, but it is away from the 1200 recorded at the top, so it is hidden.
- **`after` reports:**
  - both elements `visible`, with their own inline `position: sticky`;
  - `#lazy` at 500 px, and the page at 3300 px, scrolled to 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:** each slice reads where the page has each sticky element now, with it set to `static`, and hides it if it is painted more than a pixel away from there. An element inside a scroller of its own is always painted where the page has it, so it is no longer listed or touched.

1. **`background.js`**: the `static` read moves from `markSticky` (once) to `hideStuckSticky` (every slice). `markSticky` now only lists the elements that stick to the page, with their own visibility. The offset isn't needed any more and goes. The restore reads the new `[el, visibility]` entries.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -368,15 +368,15 @@
          // Stop rather than stack the same viewport down the canvas.
          if (i > 0 && actual <= landed) break;
          landed = actual;
   -      // Where each sticky element sits, read while the page is still at the
   -      // top. From here on there is something for the finally to put back.
   -      if (i === 0 && positions.length > 1) { await markSticky(tab, actual); hid = true; }
   +      // The sticky elements that stick to the page, listed on the first slice.
   +      // From here on there is something for the finally to put back.
   +      if (i === 0 && positions.length > 1) { await markSticky(tab); hid = true; }
          // Keep fixed elements (pinned headers, banners) on the FIRST slice only;
          // hide them on later slices so they aren't stitched in repeatedly.
          if (i === 1) await setFixedHidden(tab, true);
          // Sticky ones only in the slices they are stuck in (KAN-403), the first
          // included: a `bottom` one can be stuck there already (KAN-501).
   -      if (hid) await hideStuckSticky(tab, actual);
   +      if (hid) await hideStuckSticky(tab);
          await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
          // captureVisibleTab hands back the last frame the window presented. A
          // window that isn't drawing - minimized, occluded - presents none, so
   @@ -422,14 +422,12 @@
    // sidebar further down in the slices after the one that holds its place.
    // Hiding every sticky element blanked those out of the image (KAN-218), and
    // hiding only the ones the first screen showed stitched them in again at the
   -// top of every slice they stayed stuck in (KAN-403). So each one's place is
   -// read at the top of the page, and each slice hides the ones that are away
   -// from it. `offset` is where the stitch landed, not window.scrollY, which
   -// reads 0 on a page whose <body> is what scrolls (see measurePage).
   -async function markSticky(tab, offset) {
   +// top of every slice they stayed stuck in (KAN-403). So each slice hides the
   +// ones that are away from their place (see hideStuckSticky).
   +async function markSticky(tab) {
      await scriptWithTimeout({
        target: { tabId: tab.id },
   -    func: (y) => {
   +    func: () => {
          const list = [];
          // querySelectorAll doesn't go into a shadow root, so each one it passes
          // is searched in turn, closed ones too (KAN-507). chrome.dom throws on
   @@ -443,13 +441,9 @@
              if (shadow) roots.push(shadow);
            }
          }
   -      // One can be stuck already at the top of the page: a `bottom: 0` bar whose
   -      // place is further down sits pinned to the bottom of the first screen, and
   -      // its rect is that spot (KAN-501). A sticky element that isn't stuck sits
   -      // where `static` would put it, so each is read that way, all at once, and
   -      // put back before anything is painted. Only the ones that stick to the
   -      // page, though: one inside a scroller of its own moves with the page,
   -      // stuck or not, so its place is where it is painted. The climb goes on
   +      // Only the ones that stick to the page are listed: one inside a scroller
   +      // of its own moves with the page, stuck or not, so it is always painted
   +      // where the page has it and never has to be hidden. The climb goes on
          // through the host of a shadow root: a component in a scrolled box sticks
          // to that box (KAN-507). And an element a component shows through a slot
          // is laid out under the slot, so the climb goes there first: a scroller
   @@ -467,26 +461,33 @@
            }
            return true;
          });
   -      const was = onPage.map((el) => [el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]);
   -      for (const el of onPage) el.style.setProperty('position', 'static', 'important');
   -      window.__shotSticky = list.map((el) => [el, el.getBoundingClientRect().top + y, el.style.visibility]);
   -      onPage.forEach((el, k) => el.style.setProperty('position', ...was[k]));
   +      window.__shotSticky = onPage.map((el) => [el, el.style.visibility]);
        },
   -    args: [offset],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
    }
    
   -// Within a pixel of its place counts as in it: rects and scroll offsets are
   +// Where the page has a sticky element is where `static` puts it: one that
   +// isn't stuck sits there, and one that is stuck can be anywhere else, a
   +// `bottom: 0` bar whose place is further down pinned to the bottom of the
   +// first screen, say (KAN-501). So each is read that way, all at once, and put
   +// back before anything is painted. On every slice, not once at the top: a
   +// place can move while the capture runs, when content above it loads in
   +// (KAN-502). Within a pixel of its place counts as in it: rects are
    // fractional.
   -async function hideStuckSticky(tab, offset) {
   +async function hideStuckSticky(tab) {
      await scriptWithTimeout({
        target: { tabId: tab.id },
   -    func: (y) => {
   -      for (const [el, top, v] of window.__shotSticky || []) {
   -        el.style.visibility = Math.abs(el.getBoundingClientRect().top + y - top) > 1 ? 'hidden' : v;
   -      }
   +    func: () => {
   +      const list = window.__shotSticky || [];
   +      const painted = list.map(([el]) => el.getBoundingClientRect().top);
   +      const was = list.map(([el]) => [el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]);
   +      for (const [el] of list) el.style.setProperty('position', 'static', 'important');
   +      const place = list.map(([el]) => el.getBoundingClientRect().top);
   +      list.forEach(([el, v], k) => {
   +        el.style.setProperty('position', ...was[k]);
   +        el.style.visibility = Math.abs(painted[k] - place[k]) > 1 ? 'hidden' : v;
   +      });
        },
   -    args: [offset],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
    }
    
   @@ -515,7 +516,7 @@
            // Not only after the fixed hide: a sticky element can be hidden on the
            // first slice, and a capture can stop there (KAN-501).
            for (const [el, v] of window.__shotHidden || []) el.style.visibility = v;
   -        for (const [el, , v] of window.__shotSticky || []) el.style.visibility = v; // whatever hideStuckSticky left hidden
   +        for (const [el, v] of window.__shotSticky || []) el.style.visibility = v; // whatever hideStuckSticky left hidden
            window.__shotHidden = null;
            window.__shotSticky = null;
          }
   ```

2. **`tests/fullpage.test.js`**:
   - **A new test after `:414`:** "hides a sticky heading only in the slices it is stuck in" run on a page whose heading is pushed 300 px down once the page scrolls.
   - **The tolerance test's fake** (`:437-439`): it is now painted half a pixel off where `static` puts it, instead of reading half a pixel off in both reads.
   - **The section's comment** (`:355-356`): it gets the new rule.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -354,6 +354,8 @@
    // in (KAN-403): a sticky element is hidden only in the slices it is stuck in.
    // A `bottom` one can be stuck already at the top of the page, so each one's
    // place is read as `static`, and the first slice is checked too (KAN-501).
   +// And a place can move while the capture runs, so it is read on every slice
   +// (KAN-502).
    
    // Keeps what the capture did to the element's visibility, in order, and holds
    // the inline `position` a capture sets on it and puts back.
   @@ -410,6 +412,26 @@
      assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
      // Shown in the slice that holds its place, hidden in the three it is stuck at the top of.
      assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into a slice it was stuck in');
   +  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
   +});
   +
   +test('shows a sticky heading in the slice that holds its place after the place moves', async () => {
   +  // The same page, but content above the heading loads in once the page
   +  // scrolls, the way a lazy image does, and pushes it 300 px down: its place
   +  // goes from 1200 px to 1500, and its container's end from 2600 to 2900. The
   +  // place read at the top is not where the page has it by then (KAN-502).
   +  const body = el(3000, 713);
   +  const heading = positioned('sticky');
   +  heading.getBoundingClientRect = () => {
   +    const y = body.scrollTop, at = y ? 1500 : 1200;
   +    const top = heading.style.getPropertyValue('position') === 'static' ? at - y : Math.min(Math.max(at - y, 0), at + 1400 - 40 - y);
   +    return { top, bottom: top + 40 };
   +  };
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // In its new place in the third slice, stuck at the top of the last two.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', '', 'hidden', 'hidden'], 'blanked the heading out of the slice that holds its new place, or stitched it in where it was stuck');
      assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
    });
    
   @@ -434,9 +456,9 @@
    test('counts a sticky element within a pixel of its place as in it', async () => {
      const body = el(3052, 767);
      const heading = stickyAt(body, 900, 940); // never stuck
   -  // Rects and scroll offsets are fractional: once the page has scrolled, this one reads half a pixel off.
   +  // Rects are fractional: once the page has scrolled, this one is painted half a pixel off where `static` puts it.
      const exact = heading.getBoundingClientRect;
   -  heading.getBoundingClientRect = () => { const r = exact(); const d = body.scrollTop ? 0.5 : 0; return { top: r.top + d, bottom: r.bottom + d }; };
   +  heading.getBoundingClientRect = () => { const r = exact(); const d = body.scrollTop && heading.style.getPropertyValue('position') !== 'static' ? 0.5 : 0; return { top: r.top + d, bottom: r.bottom + d }; };
      const { ctx } = load({ de: el(767, 767), body, fixed: [heading] });
      await ctx.captureFullPage(TAB);
      assert.ok(!heading.seen.includes('hidden'), 'blanked a sticky element half a pixel from its place');
   ```

Choices:

- **The place is read on every slice, not once at the top.** It costs one more layout per slice, with the same all-at-once `static` set and put-back as before. The two inline `position` writes the KAN-501 plan noted a page's `MutationObserver` can see now come on every slice instead of once. Nothing is painted between them either way.
- **The offset goes.**
  - The painted rect and the `static` rect are read at the same scroll position, so the offset cancels out.
  - `markSticky` and `hideStuckSticky` drop their `offset` parameter, and the comment about `window.scrollY` goes with it.
  - `actual` is still what the stitch draws at.
- **Elements inside a scroller of their own are no longer listed.**
  - Before, their painted place at the top was recorded and compared, so one whose place moved was blanked too.
  - They are always painted where the page has them, so they are never hidden, and their visibility is no longer written at all.
  - The climb that finds them (KAN-507, KAN-509, KAN-511) is unchanged.
- **The list is still made once, on the first slice.** A sticky element that only turns up later is KAN-503, which this doesn't change.
- **The misaligned stitch the ticket mentions is not changed.** Each slice is still drawn where the page was when it was shot.
- **The tolerance test's fake changes.**
  - With both reads at the same offset, a fake that reads half a pixel off in both no longer tests the tolerance: dropping the tolerance still passes it (see "Checked while planning").
  - The fake now paints the heading half a pixel off where `static` puts it.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan502-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 328.
- **Test change only:** 329 run and 328 pass.
  - "shows a sticky heading in the slice that holds its place after the place moves" fails with "blanked the heading out of the slice that holds its new place, or stitched it in where it was stuck".
  - The heading is hidden in every slice after the first: `['', 'hidden', 'hidden', 'hidden', 'hidden']`.
  - The changed tolerance test passes on the code as it is now.
- **Both changes:** all 329 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | First message |
  |---|---|---|
  | No `static` read, so the place is where it is painted | 9: every test that checks a stuck sticky element is hidden, the new one included | "the heading was stitched into a slice it was stuck in" |
  | The inline `position` not put back | the same 9 | the same |
  | No pixel of tolerance (`> 1` made `> 0`) | "counts a sticky element within a pixel of its place as in it" | "blanked a sticky element half a pixel from its place" |
  | No pixel of tolerance, with that test's fake as it is now | none | — |
  | Elements inside a scroller of their own listed too | 4: the four "… where it is painted" scroller tests | "blanked a header stuck inside its own scroller (overflow: auto)" |
  | The restore still reading `[el, place, v]` | 7, "puts a bar hidden on the first slice back when the capture stops there" among them | "left the heading hidden" |

**Chrome 153.0.8010.48:** headless, with `run-502.js`, on `HEAD` and on this change (`--ext /tmp/kan502-plan/tree`).

- **Before the capture**, from a script injected through `chrome.scripting.executeScript` the way `markSticky` runs:
  - `#top` is at 0 and `#moved` at 1200;
  - `#lazy` is 200 px;
  - the page is 3000 px, scrolled to 0.

| Element | `HEAD` | This change |
|---|---|---|
| cyan `#top` (place never moves) | 0-59 | 0-59 |
| magenta `#moved` (place moves from 1200 to 1500) | none | 1500-1539 |

- **On both builds, `after` reports:**
  - both elements `visible`, with their inline `position` still `sticky`;
  - `#lazy` at 500 px;
  - the page at 3300 px, scrolled to 0.
- **Capture log:** neither run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 329 and 328 pass. Only "shows a sticky heading in the slice that holds its place after the place moves" fails, with "blanked the heading out of the slice that holds its new place, or stitched it in where it was stuck".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 329.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-502.js`, which was written while planning. Run it headless, with `--ext` pointed first at a copy of `HEAD` (`mkdir -p /tmp/kan502-head && git archive HEAD | tar -x -C /tmp/kan502-head`) and then at the repo. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-502.py <png>`.
   → verify:
   - **On `HEAD`:** cyan at 0-59, and magenta left out.
   - **On the repo:** cyan at 0-59 and magenta at 1500-1539, once each.
   - **On both builds**, `after` reports both elements `visible` with inline `position: sticky`, `#lazy` at 500 px, and the page at 3300 px, scrolled to 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-502-plan.md`.

## Noticed while planning, not changed

- **The image stops at the height read at the top.**
  - PageF is 3000 px when the capture starts and 3300 px by the end.
  - The PNG has 3000 rows on both builds, so the page's last 300 px are left out.
  - `measurePage` reads the height once, and the slice positions and the canvas both come from it.

## Open questions

None.
