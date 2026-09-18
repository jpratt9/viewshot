# KAN-606: Full page stitch leaves a blank band on a page that turns on mandatory scroll snapping with !important in a style attribute

Ticket: https://prattsolutions.atlassian.net/browse/KAN-606 (To Do, Task, labels `bug` and `viewshot`, no comments). It has no issue links, so nothing blocks it.

## What the repo does now

Line numbers are from `6f06d35`, with a clean working tree.

- **The only thing that turns snapping off:** the `__vsAnchor` rule, `@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}`. `measurePage` puts it first in `<head>` (`background.js:343-349`; KAN-600), and the cleanup branch of `scrollAndReport` takes it out (`:407`).
- **Why it loses on this page:** an `!important` in an element's `style` attribute outranks every style sheet rule, whether the rule is in a layer or not. The "Choices" section of `docs/KAN-600-plan.md` names this case. It says covering it "would take KAN-583's inline treatment for one more property".
- **KAN-583's inline treatment only covers `overflow-anchor`** (`:350-360`):
  - it finds every element with `[style*="overflow-anchor" i]`;
  - for each one whose value is `!important` and not `auto`, it keeps `[node, value]` in `window.__vsAnchored` and sets the capture's own `auto !important`;
  - it keeps a list that a capture that died left behind (`|| []`);
  - the cleanup scroll puts each kept value back with `setProperty('overflow-anchor', value, 'important')`, then deletes the list (`:408-409`).
  - Nothing in `background.js` reads or sets an element's inline `scroll-snap-type`.
- **Tests:** `npm test` passes 421.
  - `load()`'s fake `querySelectorAll` (`tests/fullpage.test.js:85`) answers `'*'` with `light` and every other query with `anchorOff`.
  - "turns scroll snapping off while the page is shot" (`:643-662`) models snapping only through the rule's text (`:652`), because the harness has no CSS.
  - KAN-583's three tests (`:599-633`) use `positioned()` elements (`:710-724`), whose inline `style` has `setProperty`, `getPropertyValue` and `getPropertyPriority`.
  - "puts back the page's own inline anchoring a capture that died left on" (`:626-633`) starts with a list holding one `[node, value]` entry.
  - `tests/inner-scroller.test.js:26`'s fake answers every query except `'*'` with nothing.

**Reproduced in Chrome 153.0.8010.48**, as the ticket says. The run is headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/kan606-plan/run-606.js`. It is `/tmp/kan611-plan/run-611.js`, which already has the ticket's page. It also reports these for `<html>` and `<body>`, before and after the capture:
  - the inline `scroll-snap-type`, with its priority;
  - the computed `scroll-snap-type`.
- **Running it:** `/tmp/kan606-plan/run.sh <ext dir> <page> <label>` runs one capture. It prints:
  - the page's offsets and the PNG's md5;
  - the inline values after the capture;
  - the rows of each colour band down the middle column (`/tmp/kan611-plan/bands.py`).
- **The page:** `snap-inline` is `snap` with `scroll-snap-type:y mandatory!important` added to the style attributes of `<html>` and `<body>`. `snap` is PageG `still`, with `html { scroll-snap-type: y mandatory }` and snap points every 500 px from 0 to 2500.

| Page | `HEAD` (`/tmp/kan606-plan/head`) | With the change (`/tmp/kan606-plan/tree`) |
|---|---|---|
| `snap-inline` | offsets 500, 1500, 2000, 2287, then 0; 3000 px, with yellow at 600, green at 1500 and blue at 2500, and no red; md5 `19fabe3feda26c1be453dc73f0890fba`, the ticket's PNG | offsets 713, 1426, 2139, 2287, then 0; 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500; md5 `c5eebb48c46485161d24873e68c29c93`, byte-identical to `still`'s |

- **The page's own values afterwards:** with the change, both elements are back to inline `y mandatory`, priority `important`, computed `y mandatory`. Chrome writes the attribute's text out again, as it does for KAN-583:
  - `<html>`'s `scroll-snap-type:y mandatory!important;` comes back as `scroll-snap-type: y mandatory !important;`;
  - `<body>`'s `scroll-snap-type:y mandatory!important;margin:0;background:#fff` comes back as `margin: 0px; background: rgb(255, 255, 255); scroll-snap-type: y mandatory !important;`.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`.
- Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan606-plan/tree`.
- `git apply --check` accepts both on the repo as it is.
- `tests/inner-scroller.test.js` needs no change, because its fake finds nothing for the new query.

**The rule:** KAN-583's inline pass runs for `scroll-snap-type` as well, with `none` as the capture's own value.
- Each entry in `window.__vsAnchored` names its property, and the cleanup scroll puts each value back under that name.
- An entry with no name comes from a capture that died before this change, and is `overflow-anchor`.

1. **`background.js`**
   - **`measurePage` (`:350-360`):**
     - The loop runs once per property, over `[['overflow-anchor', 'auto'], ['scroll-snap-type', 'none']]`.
     - Each entry it keeps is `[node, value, name]`.
     - The comment says so (KAN-606).
   - **`scrollAndReport`, the cleanup branch (`:408`):** it puts each value back under the entry's property, or `overflow-anchor` when the entry has none.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -350,13 +350,17 @@ function measurePage() {
      // A page's own `!important` in a style attribute outranks every style sheet
      // rule, so each element with one gets the capture's own inline
      // `auto !important`, and the cleanup scroll puts the page's back (KAN-583).
   +  // Snapping gets the same, with `none !important` (KAN-606).
      // A list a capture that died left behind is kept, so those get theirs back.
   +  // One left before KAN-606 doesn't name the property: it only held anchoring.
      window.__vsAnchored = window.__vsAnchored || [];
   -  for (const node of document.querySelectorAll('[style*="overflow-anchor" i]')) {
   -    const value = node.style.getPropertyValue('overflow-anchor');
   -    if (value === 'auto' || node.style.getPropertyPriority('overflow-anchor') !== 'important') continue;
   -    window.__vsAnchored.push([node, value]);
   -    node.style.setProperty('overflow-anchor', 'auto', 'important');
   +  for (const [name, own] of [['overflow-anchor', 'auto'], ['scroll-snap-type', 'none']]) {
   +    for (const node of document.querySelectorAll(`[style*="${name}" i]`)) {
   +      const value = node.style.getPropertyValue(name);
   +      if (value === own || node.style.getPropertyPriority(name) !== 'important') continue;
   +      window.__vsAnchored.push([node, value, name]);
   +      node.style.setProperty(name, own, 'important');
   +    }
      }
      const de = document.documentElement, b = document.body;
      let el = de.scrollHeight > de.clientHeight + 1 ? de
   @@ -405,7 +409,7 @@ function scrollAndReport(to, cleanup, last) {
      if (cleanup) {
        delete window.__vsScroller;
        document.getElementById('__vsAnchor')?.remove();
   -    for (const [node, value] of window.__vsAnchored || []) node.style.setProperty('overflow-anchor', value, 'important');
   +    for (const [node, value, name = 'overflow-anchor'] of window.__vsAnchored || []) node.style.setProperty(name, value, 'important');
        delete window.__vsAnchored;
      }
      const isRoot = el === de || el === b || el === document.scrollingElement;
   ```

2. **`tests/fullpage.test.js`**
   - **`load()` (`:47`, `:83-85`):** it gains a `snapOn` option. Its fake `querySelectorAll` answers the `scroll-snap-type` query with it. Every other query except `'*'` still gets `anchorOff`.
   - **The snapping section's comment (`:635-641`):** it says why an inline `!important` needs the capture's own inline value (KAN-606).
   - **After "turns scroll snapping off while the page is shot" (`:643-662`):** an `inlineSnap` helper and two tests, using `positioned()` elements:
     - "turns scroll snapping off over a page's own `!important` in a style attribute, and puts it back after" is the ticket's page in the harness.
       - It snaps while either element still has its own inline value. The snap test before it snaps while the rule lacks `none` in the same way.
       - It checks where the slices are shot and drawn, the image's height, and the page's values afterwards.
     - "puts back the page's own inline snapping a capture that died left off".

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -44,7 +44,7 @@ function smoothEl(scrollHeight, clientHeight) {
    
    // background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
    // the capture are all mocked — nothing real is touched.
   -function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixed, anchorOff = [], failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
   +function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixed, anchorOff = [], snapOn = [], failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
      const canvases = [];
      class FakeCanvas {
        constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
   @@ -80,9 +80,10 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixe
        HTMLElement,
        // light: what document.querySelectorAll('*') finds, which is all of `fixed`
        // unless a test puts some of them in a shadow root and passes its host.
   -    // anchorOff: what the query for an inline `overflow-anchor` finds.
   +    // anchorOff: what the query for an inline `overflow-anchor` finds, and
   +    // snapOn: what the one for an inline `scroll-snap-type` finds.
        document: {
   -      documentElement: de, body, scrollingElement: de, querySelectorAll: (sel) => (sel === '*' ? light : anchorOff),
   +      documentElement: de, body, scrollingElement: de, querySelectorAll: (sel) => (sel === '*' ? light : sel.includes('scroll-snap-type') ? snapOn : anchorOff),
          getElementById: (id) => styles.get(id) || null,
          createElement: () => ({ remove() { styles.delete(this.id); } }),
          head: { appendChild: (s) => styles.set(s.id, s), prepend: (s) => styles.set(s.id, s) },
   @@ -638,7 +639,9 @@ test("puts back the page's own inline anchoring a capture that died left on", as
    // landed, but the next one still asked for one screen past the last one's
    // target, so where the snap points pulled two slices apart, the rows between
    // them were never shot. Snapping is now off while the page is shot, in the
   -// anchoring rule (KAN-600).
   +// anchoring rule (KAN-600). No style sheet rule outranks an `!important` in a
   +// style attribute, so an element with one gets the capture's own inline
   +// `none !important`, as it does for anchoring (KAN-606).
    
    test('turns scroll snapping off while the page is shot', async () => {
      // Snap points every 500 px: a scroll lands on the nearest one, unless the
   @@ -661,6 +664,40 @@ test('turns scroll snapping off while the page is shot', async () => {
      assert.strictEqual(page.canvases[page.canvases.length - 1].height, 3000, 'cut the image short');
    });
    
   +// An element's inline `scroll-snap-type`, as [value, priority].
   +const inlineSnap = (e) => [e.style.getPropertyValue('scroll-snap-type'), e.style.getPropertyPriority('scroll-snap-type')];
   +
   +test("turns scroll snapping off over a page's own `!important` in a style attribute, and puts it back after", async () => {
   +  // `scroll-snap-type: y mandatory !important` in <html>'s and <body>'s style
   +  // attributes outranks the capture's rule, so a scroll lands on the nearest
   +  // snap point until the capture's own inline `none` has replaced both.
   +  const snaps = [0, 500, 1000, 1500, 2000, 2287];
   +  const htmlEl = positioned('static'), bodyEl = positioned('static');
   +  for (const e of [htmlEl, bodyEl]) e.style.setProperty('scroll-snap-type', 'y mandatory', 'important');
   +  const body = el(3000, 713);
   +  const scroll = body.scrollTo;
   +  body.scrollTo = function (o) {
   +    const off = [htmlEl, bodyEl].every((e) => inlineSnap(e)[0] === 'none');
   +    const top = off ? o.top : snaps.reduce((a, b) => (Math.abs(b - o.top) < Math.abs(a - o.top) ? b : a));
   +    scroll.call(this, { ...o, top });
   +  };
   +  const page = load({ de: el(713, 713), body, ih: 713, dpr: 1, snapOn: [htmlEl, bodyEl] });
   +  await page.ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(page.captureAt, [0, 713, 1426, 2139, 2287], 'shot the slices where the snap points pulled them');
   +  assert.deepStrictEqual(page.canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
   +  assert.strictEqual(page.canvases[page.canvases.length - 1].height, 3000, 'cut the image short');
   +  assert.deepStrictEqual([htmlEl, bodyEl].map(inlineSnap), [['y mandatory', 'important'], ['y mandatory', 'important']], "did not put the page's own inline snapping back");
   +});
   +
   +test("puts back the page's own inline snapping a capture that died left off", async () => {
   +  const htmlEl = positioned('static');
   +  htmlEl.style.setProperty('scroll-snap-type', 'none', 'important'); // the capture's own, left on
   +  const { ctx } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1, snapOn: [htmlEl] });
   +  ctx.window.__vsAnchored = [[htmlEl, 'y mandatory', 'scroll-snap-type']];
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(inlineSnap(htmlEl), ['y mandatory', 'important'], "left the page's own inline snapping off");
   +});
   +
    // --- a stitch that stops part-way ------------------------------------------
    // The page was only put back after the last slice, so a slice that threw left
    // it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   ```

**Choices:**

- **Snapping uses anchoring's loop and list, rather than a second loop and list.** The query, the checks, keeping a list a capture that died left behind, and the cleanup are all KAN-583's, unchanged. Only the property and the capture's own value differ.
- **The property goes last in each entry, and is `overflow-anchor` when there is none.** A list left by a capture from before this change has `[node, value]` entries, and they are all anchoring.
  - The list keeps its name, `__vsAnchored`, so the next capture still finds such a list.
  - "puts back the page's own inline anchoring a capture that died left on" starts with one such entry, so it pins this: it fails without the default.
- **Every element with an inline `scroll-snap-type` is changed, not only `<html>` and `<body>`.** KAN-583 does the same for anchoring, and the rule's `*` does too. Like the rule, it doesn't reach into shadow roots.
- **Only `!important` values other than `none` are changed**, with the checks KAN-583's loop already has.
  - A value without `!important` already loses to the rule.
  - `none` needs nothing. Skipping it also means a capture's own leftover `none !important` is never taken for the page's value.
  - "leaves a page's own inline anchoring without `!important` to the style sheet rule" pins the shared `!important` check, so snapping has no copy of that test.
- **Values are put back by property, with `setProperty`**, as KAN-583 does. Chrome writes the attribute's text out again, with the same values (see above).
- **Not covered: a page that sets an inline `!important` `scroll-snap-type` while it is being shot.** The pass runs once, in `measurePage`, as KAN-583's does. The ticket doesn't ask for more.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 423 tests and 421 pass. The two that fail:
   - "turns scroll snapping off over a page's own `!important` in a style attribute, and puts it back after", with `captureAt` at `[0, 500, 1500, 2000, 2287]`;
   - "puts back the page's own inline snapping a capture that died left off", with the inline value still `none`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 423.
3. In real Chrome, run `/tmp/kan606-plan/run.sh /Users/john/dev/viewshot <page> repo` for these pages: `snap-inline`, `snap`, `snap-1000`, `snap-stale`, `still`, `grow-noanchor-important-inline`, `grow-noanchor-important-layer` and `grow-noanchor`. If a run prints `NO PNG`, run it again. → verify:
   - on `snap-inline`, `snap`, `snap-1000`, `snap-stale` and `still`, the offsets are 713, 1426, 2139, 2287, then 0;
   - on `grow-noanchor-important-inline`, `grow-noanchor-important-layer` and `grow-noanchor`, they are 713, 1013, 1726, 2439, 2587, then 0;
   - every PNG is 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500, and md5 `c5eebb48c46485161d24873e68c29c93`;
   - on `snap-inline`, after the capture, `<html>`'s and `<body>`'s inline `scroll-snap-type` are `y mandatory`, `important` again;
   - on `grow-noanchor-important-inline`, their inline `overflow-anchor` are `none`, `important` again.

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan606-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 421 |
| `HEAD` + the test diff only | 421 of 423 pass. The two new tests fail as step 1 says |
| `HEAD` + the `background.js` diff only | passes 421 |
| `HEAD` + both diffs | passes 423 |
| both diffs, without `overflow-anchor` as the default property in the cleanup | "puts back the page's own inline anchoring a capture that died left on" fails |
| both diffs, without skipping the capture's own value | both "puts back the page's own inline … a capture that died left …" tests fail |
| both diffs, starting a new list instead of keeping one left behind | the same two fail |
| both diffs, without the `!important` check | "leaves a page's own inline anchoring without `!important` to the style sheet rule" fails |

**Chrome:**
- **Pages run on `HEAD`:** `snap-inline`.
- **Pages run with both diffs:** all eight in step 3.
- Each run saved a PNG the first time.
- **PNG md5s:**
  - `c5eebb48c46485161d24873e68c29c93`: every run with both diffs.
  - `19fabe3feda26c1be453dc73f0890fba`: `snap-inline` on `HEAD`, the ticket's PNG.

## Open questions

None.
