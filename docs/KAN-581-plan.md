# KAN-581: Full page stitch doesn't line up on pages that turn scroll anchoring off with !important

Ticket: https://prattsolutions.atlassian.net/browse/KAN-581 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-575, is Done.

## What the repo does now

Line numbers are from `a12e162`, with a clean working tree.

- **The anchoring rule (KAN-575):**
  - `measurePage` (`background.js:327`) adds `<style id="__vsAnchor">*{overflow-anchor:auto!important}</style>` to the end of `<head>` (`:331-336`). A page with no `<head>` gets it on the root element instead.
  - The cleanup scroll removes it (`:381`).
- **Why it loses:**
  - The rule is not in a cascade layer, and neither are the page's own rules.
  - When two `!important` declarations are both outside layers, the more specific selector wins. `*` has zero specificity, so the ticket's `html, body { overflow-anchor: none !important }` wins on `html` and `body`.
  - Anchoring stays off, so the offset doesn't move when the grey block grows. KAN-515's `moved` (`:468`) therefore stays 0.
- **Nothing else in the repo sets `overflow-anchor`.**
- **Tests:** `npm test` passes 409.
  - Only one test reads the rule's text: "turns scroll anchoring on while the page is shot, and back off after" (`tests/fullpage.test.js:390`). It expects `*{overflow-anchor:auto!important}` at every shot (`:396`).
  - "uses the anchoring rule a capture that died left behind, and takes it out" (`:410`) puts the same text in its left-behind rule (`:412`), but never checks it.

**Reproduced in Chrome 153.0.8010.48**, as the ticket says.

- **The run:** set up as in KAN-575: headless, a disposable profile, the tree loaded unpacked, PNG output, a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/vs387-chrome/run-581.js`, a copy of `run-575.js` with three more `--page` variants. Its PNGs are read with `/tmp/vs387-chrome/bands-515.py`.
- **The page:** PageG, as described in `docs/KAN-575-plan.md`. The three new variants:

  | `--page` | Anchoring | Grey block |
  |---|---|---|
  | `grow-compensate-important` | as `grow-compensate`, but with `html, body { overflow-anchor: none !important }` | 200 → 500 px |
  | `grow-noanchor-important-layer` | `@layer page { html, body { overflow-anchor: none !important } }` | 200 → 500 px |
  | `grow-noanchor-important-inline` | `overflow-anchor:none!important` in the `style` attributes of `<html>` and `<body>` | 200 → 500 px |

- **The results.**
  - "In place" means each band shows once, at its place at the start (yellow 600, red 1300, green 1500, blue 2500), in a 3000 px image.
  - Offsets come from a scroll listener in the page. The cleanup scroll back to 0 is left out.

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `grow-noanchor-important` | offsets 713, 1426, 2139, 2587; yellow at 600 and at 900, red 1600, green 1800, blue 2800; 3300 tall | offsets 713, 1013, 1726, 2439, 2587; in place (the same PNG as `grow-noanchor`) |
  | `grow-noanchor` | offsets 713, 1013, 1726, 2439, 2587; in place | a PNG byte-identical to `HEAD`'s |
  | `shrink-noanchor` | offsets 713, 413, 1126, 1839, 1987; in place | byte-identical to `HEAD`'s |
  | `grow` | in place | byte-identical to `HEAD`'s |
  | `still` | in place | byte-identical to `HEAD`'s |
  | `grow-compensate` | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall (KAN-580) | byte-identical to `HEAD`'s |
  | `grow-compensate-important` | offsets 713, 1013, 1726, 2439, 2587; in place | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall |
  | `grow-noanchor-important-layer` | as `grow-noanchor-important` | unchanged |
  | `grow-noanchor-important-inline` | as `grow-noanchor-important` | unchanged |

- **The ticket's case:** on `HEAD`, `grow-noanchor-important` stitches the yellow band in twice, just as the ticket says.
  - With the change, Chrome's anchoring moves the offset 300 px on the first scroll (713 → 1013), and KAN-515's `moved` handles the rest.
- **What it doesn't fix:** an `!important` rule inside the page's own cascade layer, or in a `style` attribute. See Open questions.
- **What it breaks:** `grow-compensate-important`.
  - It lines up on `HEAD`. There, the page's `!important` keeps anchoring off, and KAN-515 reads the page's own +300.
  - With the change it leaves 300 rows out, as `grow-compensate` has done since KAN-575.
  - Both are KAN-580's pages: they turn anchoring off and move their own offset. The settled question in the KAN-575 plan accepted this cost of forcing anchoring on.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan581-plan/tree`.

**The rule:**
- The rule moves into an anonymous cascade layer: `@layer{*{overflow-anchor:auto!important}}`.
- An `!important` declaration in a layer beats every `!important` stylesheet declaration outside a layer, whatever its selector. Specificity only decides between declarations in the same layer.
- Nothing else changes. It is the same `<style id="__vsAnchor">`, added and removed the same way and at the same times.

1. **`background.js`**
   - **`measurePage` (`:328-334`):** the rule's new text, plus a comment line saying why it is in a layer.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -328,10 +328,12 @@
      // Scroll anchoring on for the capture, over a page's own `overflow-anchor:
      // none`: content above the screen that changes height then moves the offset,
      // which is how the stitch sees it (KAN-575). The cleanup scroll takes it out.
   +  // The rule sits in a cascade layer, where `!important` outranks a page's own
   +  // `!important` outside one, whatever its selector (KAN-581).
      if (!document.getElementById('__vsAnchor')) {
        const style = document.createElement('style');
        style.id = '__vsAnchor';
   -    style.textContent = '*{overflow-anchor:auto!important}';
   +    style.textContent = '@layer{*{overflow-anchor:auto!important}}';
        (document.head || document.documentElement).appendChild(style);
      }
      const de = document.documentElement, b = document.body;
   ```

2. **`tests/fullpage.test.js`**
   - **The section comment (`:383-388`):** adds why the rule is in a layer.
   - **"turns scroll anchoring on while the page is shot, and back off after" (`:396`):** expects the new text.
   - **"uses the anchoring rule a capture that died left behind, and takes it out" (`:412`):** its left-behind rule gets the new text, because that is what a capture that dies now leaves. The test doesn't read it.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -385,7 +385,9 @@
    // anchoring moves the offset (KAN-515). A page with `overflow-anchor: none`
    // moves the rows on screen instead, so the slices after it were drawn off from
    // the ones before. Anchoring is now on for every element while the page is
   -// shot, with a rule put in the way the scrollbar one is (KAN-575).
   +// shot, with a rule put in the way the scrollbar one is (KAN-575). The rule
   +// sits in a cascade layer, so a page's own `!important` on a more specific
   +// selector doesn't outrank it (KAN-581).
    
    test('turns scroll anchoring on while the page is shot, and back off after', async () => {
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   @@ -393,7 +395,7 @@
      const rules = [];
      ctx.chrome.tabs.captureVisibleTab = async (...a) => { rules.push(styles.get('__vsAnchor')?.textContent); return shoot(...a); };
      await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(rules, Array(4).fill('*{overflow-anchor:auto!important}'), 'shot a slice without the rule');
   +  assert.deepStrictEqual(rules, Array(4).fill('@layer{*{overflow-anchor:auto!important}}'), 'shot a slice without the rule');
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   @@ -409,7 +411,7 @@
    
    test('uses the anchoring rule a capture that died left behind, and takes it out', async () => {
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   -  const left = { id: '__vsAnchor', textContent: '*{overflow-anchor:auto!important}', remove() { styles.delete(this.id); } };
   +  const left = { id: '__vsAnchor', textContent: '@layer{*{overflow-anchor:auto!important}}', remove() { styles.delete(this.id); } };
      styles.set(left.id, left);
      const add = ctx.document.head.appendChild;
      let added = 0;
   ```

**Choices:**

- **A cascade layer, not a more specific selector.** A more specific selector only beats less specific ones. A page rule on an id, such as `#app { overflow-anchor: none !important }`, would still win.
- **An anonymous layer (`@layer{…}`).** A named layer would merge into the page's layer if the page used the same name. Nothing needs to refer to this layer by name.
- **The style goes where it does now:** at the end of `<head>`, the same way `setScrollbarHidden` adds its own style (`:792`).
  - That puts its layer after any layer the page declares in `<head>`.
  - So a page's own `!important` inside one of those layers still wins (`grow-noanchor-important-layer`). See Open questions.
- **Cascade layers need Chrome 99 or later.**
  - An older Chrome drops the whole rule, so anchoring wouldn't be forced on at all.
  - The manifest sets no minimum version. Recording and the clipboard's offscreen document already need Chrome 109, the first version with `chrome.offscreen`.
- **No new test.** The fake document has no CSS engine, so tests can only check the rule's text, and the test that does is updated. Chrome is where the layer can be seen winning.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 409 tests. 408 pass, and "turns scroll anchoring on while the page is shot, and back off after" fails.
2. Apply the `background.js` diff. → verify: `npm test` passes all 409.
3. In real Chrome, run `node /tmp/vs387-chrome/run-581.js --ext /Users/john/dev/viewshot --page <page>` for `grow-noanchor-important`, `grow-noanchor`, `shrink-noanchor`, `grow`, `still` and `grow-compensate`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. If a run saves no file, run it again. → verify:
   - On `grow-noanchor-important`, yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image.
   - The other five PNGs have the md5s listed under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan581-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 409 |
| `HEAD` + the `background.js` diff only | 1 of 409 fails: "turns scroll anchoring on while the page is shot, and back off after" |
| `HEAD` + the test diff only | the same test fails |
| `HEAD` + both diffs | passes 409 |
| both diffs, with the style added first in `<head>` (`prepend`) | 84 of 409 fail, because the fake documents have no `prepend` |

**Chrome:** see the tables under "What the repo does now".
- **PNG md5s:**
  - `c5eebb48c46485161d24873e68c29c93`: every "in place" run.
  - `9f3d4fa5468292b823f7555248f646c6`: `shrink-noanchor`, on both trees.
  - `f891b0521729f45f95db8d3006ee90e0`: the 2700 px image. That is `grow-compensate` on both trees, and `grow-compensate-important` with the change.
  - `c372eb39610318deb9d5fd17fa7f2d05`: the 3300 px image. That is `grow-noanchor-important` on `HEAD`, and the `-layer` and `-inline` pages on both trees.
- **Runs that saved no file:** the first runs of `grow-noanchor-important` on both trees, and of `still` on `HEAD`. The capture never started and the page's offset log stayed empty, as happened in the KAN-575 plan. Each one saved a file when run again.
- **The style added first in `<head>`:** on a copy of the changed tree with `.prepend(style)` in place of `.appendChild(style)`, `grow-noanchor-important-layer` is in place: offsets 713, 1013, 1726, 2439, 2587, and md5 `c5eebb48…`.

## Open questions — settled

The plan left two questions open. Both are settled here, and neither changes the code shipped in `2baaa8e`.

1. **Should the rule also beat an `!important` rule inside the page's own cascade layer?** Not as part of KAN-581.
   - **What the ticket covers:** a page's own `!important` "on a more specific selector", reproduced with `html, body { overflow-anchor: none !important }`. `2baaa8e` lines that page up; see the `grow-noanchor-important` runs above.
   - **Why this case is different:** a rule inside the page's own layer wins on layer order, not on specificity. `grow-noanchor-important-layer` still stitches the yellow band in twice.
   - **What beating it would take:** adding the style first in `<head>` (`prepend` instead of `appendChild`).
     - That lined the page up in one Chrome run.
     - It would no longer match how `setScrollbarHidden` adds its style.
     - The fake documents in the tests would need a `prepend`. Without one, 84 tests fail.
   - **Follow-up:** KAN-582, filed from this question.
2. **Should an `overflow-anchor:none!important` in a page's `style` attribute be covered?** Not as part of KAN-581.
   - **Why no rule can fix it:** a `style` attribute's `!important` beats every style sheet rule, whether in a layer or not. `grow-noanchor-important-inline` still stitches the yellow band in twice.
   - **What beating it would take:** the capture setting its own inline `!important` on those elements. That means a new page pass, which has to:
     - find those elements;
     - save each one's own value and put it back afterwards, the way `window.__shotHidden` does for `visibility`.
   - **Follow-up:** KAN-583, filed from this question.

**This ticket blocks both.**
