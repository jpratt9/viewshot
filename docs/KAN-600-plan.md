# KAN-600: Full page stitch leaves a blank band on a page with mandatory scroll snapping

Ticket: https://prattsolutions.atlassian.net/browse/KAN-600 (To Do, Task, labels `bug` and `viewshot`, no comments, no links).

## What the repo does now

Line numbers are from `f34f5e2`, with a clean working tree.

- **The capture already puts one rule of its own into the page.**
  - `measurePage` puts `<style id="__vsAnchor">` with `@layer{*{overflow-anchor:auto!important}}` first in `<head>` (`background.js:335-340`). That turns scroll anchoring on for the capture (KAN-575, KAN-581, KAN-582).
  - The cleanup scroll takes the rule out before it puts the page back (`scrollAndReport` with `cleanup`, `:396-401`).
- **Nothing turns scroll snapping off.** `background.js` never mentions snapping.
- **Each slice after the first asks for `target`.**
  - It scrolls on from where the last slice's rows are (`:499`, and `scrollAndReport`'s `from`, `:409-410`).
  - The next `target` is one viewport past the last `target`, not past where the slice landed (`:648`).
- **A page with `scroll-snap-type: y mandatory` lands each scroll on its nearest snap point.** The slice is drawn where it landed (`actual`, `:502`). That goes wrong in two ways:
  - **Snap points closer together than the viewport:** where the snap points pull two slices apart, the rows between them are never shot. They are left blank.
  - **Snap points further apart than the viewport:** the next scroll can land back where the last slice was. `actual <= landed` (`:506`) takes that for a page that won't scroll, so the stitch stops and the image is cut short.
- **Tests:** `npm test` passes 417. None has a page that snaps.

**Reproduced in the test harness** with `/tmp/kan600-plan/probe-600.js`.
- The page is `load()` with a 3000 px body scroller in a 713 px viewport at dpr 1.
- Each scroll lands on the snap point nearest to where it asks. Past the end, a snap point snaps to the end (2287), as in Chrome.
- The probe prints the rows no slice covers.

| Snap points every | | `captureAt` and draws | image | rows no slice covers |
|---|---|---|---|---|
| 500 px | `HEAD` | 0, 500, 1500, 2000, 2287 | 3000 px | 1213-1499 |
| 500 px | with the change | 0, 713, 1426, 2139, 2287 | 3000 px | none |
| 1000 px | `HEAD` | 0, 1000 | 1713 px | 713-999 |
| 1000 px | with the change | 0, 713, 1426, 2139, 2287 | 3000 px | none |

The 500 px row on `HEAD` matches the ticket's Chrome run: the same offsets, and the same blank rows.

**Reproduced in Chrome 153.0.8010.48**, headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/kan600-plan/run-600.js`, which is `/tmp/kan596-plan/run-596.js` with one more page, `snap-1000`.
  - `snap` is the ticket's page: `still` with `html { scroll-snap-type: y mandatory }`, and snap points every 500 px from 0 to 2500. They are 1 px absolutely positioned markers with `scroll-snap-align: start`.
  - `snap-1000` is the same page with snap points every 1000 px.
- **Reading the PNGs:** `/tmp/vs387-chrome/bands-515.py` and `/tmp/vs387-chrome/clear-596.py`.

| Page | `HEAD` | With the change |
|---|---|---|
| `snap` | offsets 500, 1500, 2000, 2287; red not in it; rows 1213-1499 blank; 3000 px tall | offsets 713, 1426, 2139, 2287; in place, with no rows blank; byte-identical to `still`'s |
| `snap-1000` | offsets 1000 only; blue not in it; rows 713-999 blank; 1713 px tall | offsets 713, 1426, 2139, 2287; in place, with no rows blank; byte-identical to `still`'s |

- **About the `HEAD` column for `snap`:** it is the ticket's run. That run used `54b6fd9`'s `background.js`, which `f34f5e2` doesn't change.
- **After the capture,** every one of these runs left the page back at 0, where it started.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan600-plan/tree`.

**The rule:** the capture's anchoring rule also turns scroll snapping off, for every element, while the page is shot. The page's scrolls then land where the slices ask, as on a page that doesn't snap. The cleanup scroll takes the rule out, as it does today, and snapping comes back with it.

1. **`background.js`, `measurePage` (`:328-340`):**
   - The rule becomes `@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}`.
   - A comment says why (KAN-600).

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -332,10 +332,14 @@ function measurePage() {
      // `!important` outside one, whatever its selector (KAN-581). It goes first in
      // <head>: between layers, the first one declared wins for `!important`, so it
      // comes before any layer the page declares (KAN-582).
   +  // Scroll snapping is off in the same rule: a page that snaps lands the
   +  // capture's scrolls on its snap points, not where the slices ask, and the
   +  // rows between two slices the snap points pulled apart were never shot
   +  // (KAN-600).
      if (!document.getElementById('__vsAnchor')) {
        const style = document.createElement('style');
        style.id = '__vsAnchor';
   -    style.textContent = '@layer{*{overflow-anchor:auto!important}}';
   +    style.textContent = '@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}';
        (document.head || document.documentElement).prepend(style);
      }
      // A page's own `!important` in a style attribute outranks every style sheet
   ```

2. **`tests/fullpage.test.js`:**
   - **The anchoring test (`:469-477`)** expects the rule's new text (`:475`).
   - **A new section after the anchoring section** goes after `:556`, before "a stitch that stops part-way" (`:558`). It has one test:
     - Its page is a 3000 px body scroller that snaps each scroll to the nearest of its snap points, every 500 px, unless the capture's rule turns snapping off.
     - It checks where each slice was shot and drawn, and the image's height.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -472,7 +472,7 @@ test('turns scroll anchoring on while the page is shot, and back off after', asy
      const rules = [];
      ctx.chrome.tabs.captureVisibleTab = async (...a) => { rules.push(styles.get('__vsAnchor')?.textContent); return shoot(...a); };
      await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(rules, Array(4).fill('@layer{*{overflow-anchor:auto!important}}'), 'shot a slice without the rule');
   +  assert.deepStrictEqual(rules, Array(4).fill('@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}'), 'shot a slice without the rule');
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   @@ -555,6 +555,35 @@ test("puts back the page's own inline anchoring a capture that died left on", as
      assert.deepStrictEqual(inlineAnchor(htmlEl), ['none', 'important'], "left the page's own inline anchoring on");
    });
    
   +// --- pages with scroll snapping --------------------------------------------
   +// A page with `scroll-snap-type` lands each of the capture's scrolls on one of
   +// its snap points, not where the slice asked. Each slice was drawn where it
   +// landed, but the next one still asked for one screen past the last one's
   +// target, so where the snap points pulled two slices apart, the rows between
   +// them were never shot. Snapping is now off while the page is shot, in the
   +// anchoring rule (KAN-600).
   +
   +test('turns scroll snapping off while the page is shot', async () => {
   +  // Snap points every 500 px: a scroll lands on the nearest one, unless the
   +  // capture's rule turns snapping off. The one at 2500 is past the end, so it
   +  // snaps to the end, 2287.
   +  const snaps = [0, 500, 1000, 1500, 2000, 2287];
   +  let styles;
   +  const body = el(3000, 713);
   +  const scroll = body.scrollTo;
   +  body.scrollTo = function (o) {
   +    const off = (styles.get('__vsAnchor')?.textContent || '').includes('scroll-snap-type:none!important');
   +    const top = off ? o.top : snaps.reduce((a, b) => (Math.abs(b - o.top) < Math.abs(a - o.top) ? b : a));
   +    scroll.call(this, { ...o, top });
   +  };
   +  const page = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  styles = page.styles;
   +  await page.ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(page.captureAt, [0, 713, 1426, 2139, 2287], 'shot the slices where the snap points pulled them');
   +  assert.deepStrictEqual(page.canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
   +  assert.strictEqual(page.canvases[page.canvases.length - 1].height, 3000, 'cut the image short');
   +});
   +
    // --- a stitch that stops part-way ------------------------------------------
    // The page was only put back after the last slice, so a slice that threw left
    // it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   ```

**Choices:**

- **Turn snapping off rather than step each slice from where the last one landed.** I tried that alternative in the harness: `target = Math.min(landed + m.vh, …)` at `:648`, in `/tmp/kan600-plan/stepfix`.
  - It still leaves rows out. With snap points every 500 px, rows 2213-2286 are left out. With snap points every 1000 px, rows 713-999 and 1713-1999 are.
  - While snapping is on, a page whose snap points are further apart than the viewport can't show some of its rows on screen at all.
- **The same rule as scroll anchoring**, which reuses what KAN-575, KAN-581 and KAN-582 built:
  - one `<style>` element, first in `<head>`;
  - a cascade layer, so a page's own `!important` in a style sheet doesn't outrank it;
  - the cleanup scroll takes it out.
  - With the rule out, snapping is back on, and the page is scrolled back to where it started.
- **Pages that don't snap are left as they are.** `scroll-snap-type: none` is the initial value, so the rule changes nothing on them. With both diffs, `npm test` passes all 418. The only existing test that changes is the anchoring test, and only in the rule's text it expects.
- **Not covered: `scroll-snap-type` with `!important` in a style attribute.** No style sheet rule outranks that (KAN-583), so such a page still snaps.
  - Covering it would take KAN-583's inline treatment for one more property.
  - The ticket's page sets snapping in a style sheet.
- **A rule left behind by a capture that died before this change** has the old text. The next capture uses it as it is (`:335`), so that one capture turns anchoring on but leaves snapping on.
- **The test's page snaps only while the rule's text lacks `scroll-snap-type:none!important`.** The harness has no CSS, so this is how it models the rule. The anchoring test checks the rule's text in the same way.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 418 tests and 416 pass. The two that fail:
   - "turns scroll anchoring on while the page is shot, and back off after", which gets the old rule text four times;
   - "turns scroll snapping off while the page is shot", with `captureAt` at `[0, 500, 1500, 2000, 2287]`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 418.
3. In real Chrome, run `node /tmp/kan600-plan/run-600.js --ext /Users/john/dev/viewshot --page <page>` for these pages: `snap`, `snap-1000`, `settlescroll-again`, `settlescroll`, `move-up`, `still`, `selfscroll`, `grow`, `grow-noanchor`, `shrink-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline`, `grow-compensate`, `selfscroll-grow` and `settlescroll-grow`.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`, and the two snap pages' with `python3 /tmp/vs387-chrome/clear-596.py <png>` too.
   - If a run saves no file, or saves something other than a PNG, run it again.

   → verify:
   - On `snap` and `snap-1000`:
     - the page's offsets are 713, 1426, 2139, 2287;
     - yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image;
     - `clear-596.py` finds no blank rows;
     - the md5 is `c5eebb48c46485161d24873e68c29c93`.
   - Every other page has the md5 listed for it under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan600-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 417 |
| `HEAD` + the test diff only | 416 of 418 pass. The anchoring test fails on the rule's text, and the new test fails with `captureAt` `[0, 500, 1500, 2000, 2287]` |
| `HEAD` + both diffs | passes 418 |

**Harness probe:** `node /tmp/kan600-plan/probe-600.js <tree>` gave the table under "What the repo does now". On the alternative in `/tmp/kan600-plan/stepfix`, the results were:
- snap points every 500 px: `captureAt` 0, 500, 1000, 1500, 2287, and rows 2213-2286 not covered;
- snap points every 1000 px: `captureAt` 0, 1000, 2000, 2287, and rows 713-999 and 1713-1999 not covered.

**Chrome:**
- `snap-1000` was run on `HEAD`, and `snap` and `snap-1000` with the change. Each saved a PNG the first time.
- **PNG md5s:**
  - `snap` on `HEAD` (the ticket's run): `19fabe3feda26c1be453dc73f0890fba`.
  - `snap-1000` on `HEAD`: `56b571895f6d7e87b6cf64e624cf62cf`.
  - `snap` and `snap-1000` with the change: `c5eebb48c46485161d24873e68c29c93`, the same as `still`'s.
- **Not run with the change while planning:** the other fourteen pages in step 3. Their md5s on `54b6fd9`'s `background.js`, from KAN-596's step 3, are what step 3 checks against:
  - `c5eebb48c46485161d24873e68c29c93`: `settlescroll-again`, `settlescroll`, `still`, `selfscroll`, `grow`, `grow-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer` and `grow-noanchor-important-inline`;
  - `9f3d4fa5468292b823f7555248f646c6`: `shrink-noanchor`;
  - `f891b0521729f45f95db8d3006ee90e0`: `grow-compensate`;
  - `cd5c1376da0a509ab24822a03dfc47c6`: `selfscroll-grow`;
  - `c372eb39610318deb9d5fd17fa7f2d05`: `move-up`;
  - `a591d5ec418a228282a7b0ac4190b12d`: `settlescroll-grow`.

## Open questions

None.
