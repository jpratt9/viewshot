# KAN-583: Full page stitch doesn't line up on pages that turn scroll anchoring off with !important in a style attribute

Ticket: https://prattsolutions.atlassian.net/browse/KAN-583 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-581, is Done.

## What the repo does now

Line numbers are from `463e505`, with a clean working tree.

- **The only thing that turns anchoring on:**
  - `measurePage` (`background.js:327`) adds `<style id="__vsAnchor">@layer{*{overflow-anchor:auto!important}}</style>` first in `<head>` (`:335-340`; KAN-575, KAN-581, KAN-582).
  - The cleanup branch of `scrollAndReport` removes it, along with `window.__vsScroller` (`:385`).
- **Why it loses on this page:**
  - An `!important` in an element's `style` attribute outranks every style sheet rule, whether the rule is in a layer or not.
  - Nothing in `background.js` sets or reads an element's inline `overflow-anchor`.
- **What the repo already does with inline values** (the pattern this plan copies):
  - `hideStuckSticky` saves each element's inline `position` as `[getPropertyValue, getPropertyPriority]`, sets its own `static !important`, and puts the page's back with `setProperty` (`:666-671`).
  - `markFixedAndSticky` keeps `[element, visibility]` pairs in `window.__shotHidden`, which `restoreFixedAndSticky` puts back (`:767-769`).
- **Tests:** `npm test` passes 410.
  - The fake documents answer `querySelectorAll` without looking at the selector: `load()`'s returns `light` (`tests/fullpage.test.js:84`), and `tests/inner-scroller.test.js:26`'s returns the inner scroller.
  - All of `background.js`'s `document.querySelectorAll` calls today pass `'*'`.
  - `positioned()` (`tests/fullpage.test.js:492`) is a fake element with a working inline `style`: `setProperty`, `getPropertyValue` and `getPropertyPriority`.

**Reproduced in Chrome 153.0.8010.48**, as the ticket says.

- **The script:** `/tmp/vs387-chrome/run-583.js`, a copy of `run-581.js` (see `docs/KAN-581-plan.md`).
  - It also reports four things for `<html>` and `<body>`, before and after the capture: the `style` attribute's text, the inline `overflow-anchor` value, its priority, and the computed value.
  - Its PNGs are read with `/tmp/vs387-chrome/bands-515.py`.
  - The run is headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The results.**
  - "In place" means each band shows once, at its place at the start (yellow 600, red 1300, green 1500, blue 2500), in a 3000 px image.
  - `grow-noanchor-important-inline` was run on a copy of `463e505`. The `HEAD` results for the other pages are from the KAN-582 runs of the same `background.js`.

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `grow-noanchor-important-inline` | offsets 713, 1426, 2139, 2587; yellow at 600 and at 900, red 1600, green 1800, blue 2800; 3300 tall | offsets 713, 1013, 1726, 2439, 2587; in place |
  | `grow-noanchor-important-layer` | offsets 713, 1013, 1726, 2439, 2587; in place | a PNG byte-identical to `HEAD`'s |
  | `grow-noanchor-important` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor` | in place | byte-identical to `HEAD`'s |
  | `shrink-noanchor` | in place | byte-identical to `HEAD`'s |
  | `grow` | in place | byte-identical to `HEAD`'s |
  | `still` | in place | byte-identical to `HEAD`'s |
  | `grow-compensate` | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall (KAN-580) | byte-identical to `HEAD`'s |

- **The ticket's case:** with the change, `<html>` and `<body>` have the capture's own inline `overflow-anchor: auto !important` while the page is shot.
  - Chrome's anchoring then moves the offset 300 px on the first scroll (713 → 1013), and KAN-515's `moved` handles the rest.
- **The page's own values afterwards:**
  - On `grow-noanchor-important-inline`, both elements are back to inline `none`, priority `important`, computed `none`.
  - Chrome re-serializes the attribute's text:
    - `<html>`'s `overflow-anchor:none!important;` comes back as `overflow-anchor: none !important;`.
    - `<body>`'s `overflow-anchor:none!important;margin:0;background:#fff` comes back as `margin: 0px; background: rgb(255, 255, 255); overflow-anchor: none !important;`.
  - The other pages have no inline `overflow-anchor`, and their `style` attributes are left as they were.

## Change

Three files change: `background.js`, `tests/fullpage.test.js` and `tests/inner-scroller.test.js`. All three diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan583-plan/tree`.

**The override:**
- `measurePage` finds every element with an inline `overflow-anchor` using `[style*="overflow-anchor" i]`.
- For each one whose value is `!important` and not `auto`, it:
  - keeps `[element, value]` in `window.__vsAnchored`;
  - sets the capture's own `overflow-anchor: auto !important` inline.
- The cleanup scroll sets each kept value back, with `!important`, and deletes the list. So it has the same lifetime as `#__vsAnchor` and `window.__vsScroller`.

1. **`background.js`**
   - **`measurePage`:** the new pass goes after the `#__vsAnchor` block (`:340`).
   - **`scrollAndReport`:** the cleanup branch (`:385`) puts the values back.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -337,6 +337,17 @@
        style.id = '__vsAnchor';
        style.textContent = '@layer{*{overflow-anchor:auto!important}}';
        (document.head || document.documentElement).prepend(style);
   +  }
   +  // A page's own `!important` in a style attribute outranks every style sheet
   +  // rule, so each element with one gets the capture's own inline
   +  // `auto !important`, and the cleanup scroll puts the page's back (KAN-583).
   +  // A list a capture that died left behind is kept, so those get theirs back.
   +  window.__vsAnchored = window.__vsAnchored || [];
   +  for (const node of document.querySelectorAll('[style*="overflow-anchor" i]')) {
   +    const value = node.style.getPropertyValue('overflow-anchor');
   +    if (value === 'auto' || node.style.getPropertyPriority('overflow-anchor') !== 'important') continue;
   +    window.__vsAnchored.push([node, value]);
   +    node.style.setProperty('overflow-anchor', 'auto', 'important');
      }
      const de = document.documentElement, b = document.body;
      let el = de.scrollHeight > de.clientHeight + 1 ? de
   @@ -382,7 +393,12 @@
        }
        el = el || document.scrollingElement || de;
      }
   -  if (cleanup) { delete window.__vsScroller; document.getElementById('__vsAnchor')?.remove(); }
   +  if (cleanup) {
   +    delete window.__vsScroller;
   +    document.getElementById('__vsAnchor')?.remove();
   +    for (const [node, value] of window.__vsAnchored || []) node.style.setProperty('overflow-anchor', value, 'important');
   +    delete window.__vsAnchored;
   +  }
      const isRoot = el === de || el === b || el === document.scrollingElement;
      // Where the page is before it moves. fromHere scrolls `to` on from there.
      const from = el.scrollTop;
   ```

2. **`tests/fullpage.test.js`**
   - **`load()` (`:47`, `:81-84`):** gains an `anchorOff` option. Its fake `querySelectorAll` answers `'*'` with `light`, as before, and the new query with `anchorOff`, which is empty unless a test passes one.
   - **The section comment (`:383-391`):** says why an inline `!important` needs the capture's own inline value.
   - **After "puts the anchoring rule first in <head>, before any layer the page declares" (`:436-444`):** an `inlineAnchor` helper and three tests, each using `positioned()` elements:
     - "turns anchoring on over a page's own `!important` in a style attribute, and puts it back after";
     - "leaves a page's own inline anchoring without `!important` to the style sheet rule";
     - "puts back the page's own inline anchoring a capture that died left on".

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -44,7 +44,7 @@
    
    // background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
    // the capture are all mocked — nothing real is touched.
   -function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixed, failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
   +function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixed, anchorOff = [], failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
      const canvases = [];
      class FakeCanvas {
        constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
   @@ -78,10 +78,11 @@
        // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
        setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
        HTMLElement,
   -    // light: what document.querySelectorAll finds, which is all of `fixed`
   +    // light: what document.querySelectorAll('*') finds, which is all of `fixed`
        // unless a test puts some of them in a shadow root and passes its host.
   +    // anchorOff: what the query for an inline `overflow-anchor` finds.
        document: {
   -      documentElement: de, body, scrollingElement: de, querySelectorAll: () => light,
   +      documentElement: de, body, scrollingElement: de, querySelectorAll: (sel) => (sel === '*' ? light : anchorOff),
          getElementById: (id) => styles.get(id) || null,
          createElement: () => ({ remove() { styles.delete(this.id); } }),
          head: { appendChild: (s) => styles.set(s.id, s), prepend: (s) => styles.set(s.id, s) },
   @@ -388,7 +389,9 @@
    // shot, with a rule put in the way the scrollbar one is (KAN-575). The rule
    // sits in a cascade layer, so a page's own `!important` on a more specific
    // selector doesn't outrank it (KAN-581). It goes first in <head>, so its layer
   -// comes before any the page declares (KAN-582).
   +// comes before any the page declares (KAN-582). No style sheet rule outranks
   +// an `!important` in a style attribute, so an element with one gets the
   +// capture's own inline value for the capture (KAN-583).
    
    test('turns scroll anchoring on while the page is shot, and back off after', async () => {
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   @@ -443,6 +446,42 @@
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   +// An element's inline `overflow-anchor`, as [value, priority].
   +const inlineAnchor = (e) => [e.style.getPropertyValue('overflow-anchor'), e.style.getPropertyPriority('overflow-anchor')];
   +
   +test("turns anchoring on over a page's own `!important` in a style attribute, and puts it back after", async () => {
   +  const htmlEl = positioned('static'), bodyEl = positioned('static');
   +  for (const e of [htmlEl, bodyEl]) e.style.setProperty('overflow-anchor', 'none', 'important');
   +  const { ctx } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1, anchorOff: [htmlEl, bodyEl] });
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  const shots = [];
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { shots.push([htmlEl, bodyEl].map(inlineAnchor)); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shots, Array(4).fill([['auto', 'important'], ['auto', 'important']]), "shot a slice with the page's own inline anchoring off");
   +  assert.deepStrictEqual([htmlEl, bodyEl].map(inlineAnchor), [['none', 'important'], ['none', 'important']], "did not put the page's own inline anchoring back");
   +});
   +
   +test("leaves a page's own inline anchoring without `!important` to the style sheet rule", async () => {
   +  const bodyEl = positioned('static');
   +  bodyEl.style.setProperty('overflow-anchor', 'none');
   +  const { ctx } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1, anchorOff: [bodyEl] });
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  const shots = [];
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { shots.push(inlineAnchor(bodyEl)); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(shots, Array(4).fill(['none', '']), 'changed inline anchoring the style sheet rule already outranks');
   +  assert.deepStrictEqual(inlineAnchor(bodyEl), ['none', ''], "changed the page's own inline anchoring");
   +});
   +
   +test("puts back the page's own inline anchoring a capture that died left on", async () => {
   +  const htmlEl = positioned('static');
   +  htmlEl.style.setProperty('overflow-anchor', 'auto', 'important'); // the capture's own, left on
   +  const { ctx } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1, anchorOff: [htmlEl] });
   +  ctx.window.__vsAnchored = [[htmlEl, 'none']];
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(inlineAnchor(htmlEl), ['none', 'important'], "left the page's own inline anchoring on");
   +});
   +
    // --- a stitch that stops part-way ------------------------------------------
    // The page was only put back after the last slice, so a slice that threw left
    // it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   ```

3. **`tests/inner-scroller.test.js`**
   - **The fake document (`:26`):** its `querySelectorAll` returns the inner scroller for `'*'` only, and nothing for the new query.

   ```diff
   --- a/tests/inner-scroller.test.js
   +++ b/tests/inner-scroller.test.js
   @@ -23,7 +23,7 @@
      let pageScriptTimeout;
      const context = {
        console, URL, btoa, Date, clearTimeout, setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); }, HTMLElement,
   -    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: () => (inner ? [inner] : []), getElementById: () => null, createElement: () => ({}), head: { prepend() {} } },
   +    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: (sel) => (sel === '*' && inner ? [inner] : []), getElementById: () => null, createElement: () => ({}), head: { prepend() {} } },
        requestAnimationFrame: (cb) => { cb(); },
        getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }),
        window: { innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr, scrollTo: (x, y) => { if (body) body.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); }, getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }) },
   ```

**Choices:**

- **Every element with an inline `overflow-anchor`, not only `<html>` and `<body>`.**
  - The ticket asks for "those elements", and a wrapper with `none` shuts its whole subtree out of anchoring just as `<body>` does.
  - The attribute query is case-insensitive (`i`), because CSS property names are.
  - Like the style sheet rule, it doesn't reach into shadow roots.
- **Only `!important` values other than `auto` are changed.**
  - An inline value without `!important` already loses to the style sheet rule's `!important`.
  - `auto` needs nothing. Skipping it also means a capture's own leftover `auto !important` is never taken for the page's value.
- **Put back by property, with `setProperty`.** This is how `hideStuckSticky` puts back `position`, and how the ticket asks for it.
  - Chrome then writes the attribute's text out again (see the results above), with the same values.
  - Restoring the attribute's text instead would undo any inline change the page made while it was shot.
- **In `measurePage` and the cleanup scroll.** No new page script, so the call-order tests are untouched, and the change lives exactly as long as `#__vsAnchor`.
- **A list left behind by a capture that died is kept (`|| []`),** so the next capture's cleanup gives those elements the page's values back.
- **No README, manifest or version change.**

## Steps

1. Apply the two test diffs. → verify: `npm test` runs 413 tests and 411 pass. The two that fail are "turns anchoring on over a page's own `!important` in a style attribute, and puts it back after" and "puts back the page's own inline anchoring a capture that died left on".
2. Apply the `background.js` diff. → verify: `npm test` passes all 413.
3. In real Chrome, run `node /tmp/vs387-chrome/run-583.js --ext /Users/john/dev/viewshot --page <page>` for `grow-noanchor-important-inline`, `grow-noanchor-important-layer`, `grow-noanchor-important`, `grow-noanchor`, `shrink-noanchor`, `grow`, `still` and `grow-compensate`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. If a run saves no file, run it again. → verify:
   - On `grow-noanchor-important-inline`:
     - yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image;
     - after the capture, `<html>`'s and `<body>`'s inline `overflow-anchor` are back to `none`, `important`.
   - The other seven PNGs have the md5s listed under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan583-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 410 |
| `HEAD` + the `background.js` diff only | 12 of 410 fail (8 in `tests/fullpage.test.js`, 4 in `tests/inner-scroller.test.js`), because the fakes answer the new query with elements that have no inline style |
| `HEAD` + the two test diffs | 2 of 413 fail: the override test and the one for a capture that died |
| `HEAD` + all three diffs | passes 413 |
| all three diffs, without the `!important` check | "leaves a page's own inline anchoring without `!important` to the style sheet rule" fails |
| all three diffs, starting a new list instead of keeping one left behind | "puts back the page's own inline anchoring a capture that died left on" fails |
| all three diffs, without skipping `auto` | "puts back the page's own inline anchoring a capture that died left on" fails |

**Chrome:** see the table and notes under "What the repo does now".
- **PNG md5s:**
  - `c5eebb48c46485161d24873e68c29c93`: every "in place" run.
  - `9f3d4fa5468292b823f7555248f646c6`: `shrink-noanchor`.
  - `f891b0521729f45f95db8d3006ee90e0`: `grow-compensate`.
  - `c372eb39610318deb9d5fd17fa7f2d05`: `grow-noanchor-important-inline` on `HEAD`.
- **Runs that saved no file:** the first runs of `grow-noanchor-important-layer` and `grow-noanchor` on the changed tree. Both saved a file when run again.

## Open questions

None.
