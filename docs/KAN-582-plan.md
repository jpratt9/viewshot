# KAN-582: Full page stitch doesn't line up on pages that turn scroll anchoring off with !important inside their own cascade layer

Ticket: https://prattsolutions.atlassian.net/browse/KAN-582 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-581, is Done.

## What the repo does now

Line numbers are from `d4508ae`, with a clean working tree.

- **The anchoring rule (KAN-575, KAN-581):**
  - `measurePage` (`background.js:327`) adds `<style id="__vsAnchor">@layer{*{overflow-anchor:auto!important}}</style>` with `(document.head || document.documentElement).appendChild(style)` (`:333-338`).
  - That puts it at the end of `<head>`, or at the end of the root element when there is no `<head>`.
  - The cleanup scroll removes it (`:383`).
- **Why it loses on this page:**
  - For `!important` declarations, the cascade layer declared first wins.
  - Layers are declared in the order their style sheets come in the document. A layer in the page's own `<head>` styles therefore comes before the capture's.
  - So `@layer page { html, body { overflow-anchor: none !important } }` keeps anchoring off.
- **Tests:** `npm test` passes 409.
  - The fake documents only give the capture `appendChild`: the one from `load()` (`tests/fullpage.test.js:87`), the one from `scrollbarStyle` (`:1248`), and the one in `tests/inner-scroller.test.js:26`.
  - Two tests watch it:
    - "uses the anchoring rule a capture that died left behind, and takes it out" counts `head.appendChild` calls (`:416-418`).
    - "puts the anchoring rule on the root element of a page with no <head>" catches `de.appendChild` (`:429`).

**Reproduced in Chrome 153.0.8010.48**, as the ticket says.

- **The run and the page:** as in `docs/KAN-581-plan.md`.
  - The script is `/tmp/vs387-chrome/run-581.js`, and its PNGs are read with `/tmp/vs387-chrome/bands-515.py`.
  - Headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The results.**
  - "In place" means each band shows once, at its place at the start (yellow 600, red 1300, green 1500, blue 2500), in a 3000 px image.
  - `grow-noanchor-important-layer` was run on a copy of `d4508ae`. The `HEAD` results for the other pages are from the KAN-581 runs of the same `background.js` (`2baaa8e`); `d4508ae` changed only a doc.

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `grow-noanchor-important-layer` | offsets 713, 1426, 2139, 2587; yellow at 600 and at 900, red 1600, green 1800, blue 2800; 3300 tall | offsets 713, 1013, 1726, 2439, 2587; in place |
  | `grow-noanchor-important` | offsets 713, 1013, 1726, 2439, 2587; in place | a PNG byte-identical to `HEAD`'s |
  | `grow-noanchor` | in place | byte-identical to `HEAD`'s |
  | `shrink-noanchor` | in place | byte-identical to `HEAD`'s |
  | `grow` | in place | byte-identical to `HEAD`'s |
  | `still` | in place | byte-identical to `HEAD`'s |
  | `grow-compensate` | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall (KAN-580) | byte-identical to `HEAD`'s |
  | `grow-compensate-important` | as `grow-compensate` (KAN-580) | byte-identical to `HEAD`'s |
  | `grow-noanchor-important-inline` | as `grow-noanchor-important-layer` (KAN-583) | unchanged |

- **The ticket's case:**
  - With the change, the capture's layer is the first one declared.
  - Chrome's anchoring then moves the offset 300 px on the first scroll (713 → 1013), and KAN-515's `moved` handles the rest.
- **What it doesn't fix:** `grow-noanchor-important-inline`. A `style` attribute's `!important` beats every style sheet rule; that is KAN-583.
- **Nothing else changes** on these pages.

## Change

Three files change: `background.js`, `tests/fullpage.test.js` and `tests/inner-scroller.test.js`. All three diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan582-plan/tree`.

**The placement:**
- The style goes first in `<head>` (or first in the root element), with `prepend` in place of `appendChild`.
- Its layer is then the first one declared in the document. Its `!important` therefore beats the `!important` in every layer the page declares, as well as outside a layer.
- Nothing else changes: the same element, the same rule, the same "unless one is there already" check, and the same cleanup.

1. **`background.js`**
   - **`measurePage` (`:331-337`):** `prepend` in place of `appendChild`, and the comment says why.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -329,12 +329,14 @@
      // none`: content above the screen that changes height then moves the offset,
      // which is how the stitch sees it (KAN-575). The cleanup scroll takes it out.
      // The rule sits in a cascade layer, where `!important` outranks a page's own
   -  // `!important` outside one, whatever its selector (KAN-581).
   +  // `!important` outside one, whatever its selector (KAN-581). It goes first in
   +  // <head>: between layers, the first one declared wins for `!important`, so it
   +  // comes before any layer the page declares (KAN-582).
      if (!document.getElementById('__vsAnchor')) {
        const style = document.createElement('style');
        style.id = '__vsAnchor';
        style.textContent = '@layer{*{overflow-anchor:auto!important}}';
   -    (document.head || document.documentElement).appendChild(style);
   +    (document.head || document.documentElement).prepend(style);
      }
      const de = document.documentElement, b = document.body;
      let el = de.scrollHeight > de.clientHeight + 1 ? de
   ```

2. **`tests/fullpage.test.js`**
   - **The fake `head` from `load()` (`:87`) and from `scrollbarStyle` (`:1248`):** each gains a `prepend`, alongside the `appendChild` that `setScrollbarHidden` still uses.
   - **The section comment (`:383-390`):** says why the rule goes first.
   - **"uses the anchoring rule a capture that died left behind, and takes it out" (`:416-418`):** counts `prepend` calls instead of `appendChild` ones. Counting `appendChild` would pass however many rules went in.
   - **"puts the anchoring rule on the root element of a page with no <head>" (`:429`):** catches `de.prepend`.
   - **A new test after it:** "puts the anchoring rule first in <head>, before any layer the page declares".

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -84,7 +84,7 @@
          documentElement: de, body, scrollingElement: de, querySelectorAll: () => light,
          getElementById: (id) => styles.get(id) || null,
          createElement: () => ({ remove() { styles.delete(this.id); } }),
   -      head: { appendChild: (s) => styles.set(s.id, s) },
   +      head: { appendChild: (s) => styles.set(s.id, s), prepend: (s) => styles.set(s.id, s) },
        },
        // A window that is drawing runs the callback; from frozenAt on it never does.
        // The probe for slice k runs before capture k, so captureAt is one short.
   @@ -387,7 +387,8 @@
    // the ones before. Anchoring is now on for every element while the page is
    // shot, with a rule put in the way the scrollbar one is (KAN-575). The rule
    // sits in a cascade layer, so a page's own `!important` on a more specific
   -// selector doesn't outrank it (KAN-581).
   +// selector doesn't outrank it (KAN-581). It goes first in <head>, so its layer
   +// comes before any the page declares (KAN-582).
    
    test('turns scroll anchoring on while the page is shot, and back off after', async () => {
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   @@ -413,9 +414,9 @@
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
      const left = { id: '__vsAnchor', textContent: '@layer{*{overflow-anchor:auto!important}}', remove() { styles.delete(this.id); } };
      styles.set(left.id, left);
   -  const add = ctx.document.head.appendChild;
   +  const add = ctx.document.head.prepend;
      let added = 0;
   -  ctx.document.head.appendChild = (s) => { added++; return add(s); };
   +  ctx.document.head.prepend = (s) => { added++; return add(s); };
      await ctx.captureFullPage(TAB);
      assert.strictEqual(added, 0, 'put a second rule in');
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
   @@ -426,12 +427,22 @@
      const { ctx, styles } = load({ de, body: el(3000, 3000), ih: 800, dpr: 1 });
      ctx.document.head = null;
      const inRoot = [];
   -  de.appendChild = (s) => { inRoot.push(s.id); styles.set(s.id, s); };
   +  de.prepend = (s) => { inRoot.push(s.id); styles.set(s.id, s); };
      await ctx.captureFullPage(TAB);
      assert.deepStrictEqual(inRoot, ['__vsAnchor'], 'did not put the rule on the root element');
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   +test('puts the anchoring rule first in <head>, before any layer the page declares', async () => {
   +  const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   +  const first = [];
   +  const put = ctx.document.head.prepend;
   +  ctx.document.head.prepend = (s) => { first.push(s.id); return put(s); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(first, ['__vsAnchor'], 'did not put the rule first in <head>');
   +  assert.strictEqual(styles.size, 0, 'left the rule in the page');
   +});
   +
    // --- a stitch that stops part-way ------------------------------------------
    // The page was only put back after the last slice, so a slice that threw left
    // it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   @@ -1245,7 +1256,7 @@
      Object.assign(ctx.document, {
        getElementById: (id) => byId.get(id) || null,
        createElement: () => { const el = { remove: () => byId.delete(el.id) }; return el; },
   -    head: { appendChild: (el) => byId.set(el.id, el) },
   +    head: { appendChild: (el) => byId.set(el.id, el), prepend: (el) => byId.set(el.id, el) },
      });
      const shots = [];
      const capture = ctx.chrome.tabs.captureVisibleTab;
   ```

3. **`tests/inner-scroller.test.js`**
   - **The fake document (`:26`):** its `head` has a `prepend` in place of the `appendChild` that only `measurePage` called.

   ```diff
   --- a/tests/inner-scroller.test.js
   +++ b/tests/inner-scroller.test.js
   @@ -23,7 +23,7 @@
      let pageScriptTimeout;
      const context = {
        console, URL, btoa, Date, clearTimeout, setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); }, HTMLElement,
   -    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: () => (inner ? [inner] : []), getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
   +    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: () => (inner ? [inner] : []), getElementById: () => null, createElement: () => ({}), head: { prepend() {} } },
        requestAnimationFrame: (cb) => { cb(); },
        getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }),
        window: { innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr, scrollTo: (x, y) => { if (body) body.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); }, getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }) },
   ```

**Choices:**

- **`prepend`, the change the ticket tried.** It puts the style first, and with it the layer. It lined the ticket's page up in Chrome.
- **Only the anchoring style moves.** `setScrollbarHidden` (`:794`) still appends its own style, because nothing in this ticket needs its rules first.
- **Which fakes keep `appendChild`:**
  - The two fakes that `setScrollbarHidden` can reach keep it: the ones from `load()` and `scrollbarStyle`.
  - The fake in `tests/inner-scroller.test.js` loses it, because nothing else calls it there.
- **A rule left behind by a capture that died is still used where it is, as before.** One left by the code before this change stays at the end of `<head>` until the page reloads.
- **No README, manifest or version change.**

## Steps

1. Apply the two test diffs. → verify: `npm test` runs 410 tests and 404 pass. Six fail, because `measurePage` still calls `appendChild`: the new test, the no-`<head>` test, and the 4 in `tests/inner-scroller.test.js`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 410.
3. In real Chrome, run `node /tmp/vs387-chrome/run-581.js --ext /Users/john/dev/viewshot --page <page>` for `grow-noanchor-important-layer`, `grow-noanchor-important`, `grow-noanchor`, `shrink-noanchor`, `grow`, `still` and `grow-compensate`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. If a run saves no file, run it again. → verify:
   - On `grow-noanchor-important-layer`, yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image.
   - The other six PNGs have the md5s listed under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan582-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 409 |
| `HEAD` + the `background.js` diff only | 84 of 409 fail (80 in `tests/fullpage.test.js`, 4 in `tests/inner-scroller.test.js`), because the fakes have no `prepend` |
| `HEAD` + the two test diffs | 6 of 410 fail: the new test, the no-`<head>` test, and the 4 in `tests/inner-scroller.test.js` |
| `HEAD` + all three diffs | passes 410 |
| all three diffs, without the "unless one is there already" check | "uses the anchoring rule a capture that died left behind, and takes it out" fails |

**Chrome:** see the table under "What the repo does now".
- **PNG md5s:**
  - `c5eebb48c46485161d24873e68c29c93`: every "in place" run.
  - `9f3d4fa5468292b823f7555248f646c6`: `shrink-noanchor`.
  - `f891b0521729f45f95db8d3006ee90e0`: the 2700 px image (`grow-compensate` and `grow-compensate-important`).
  - `c372eb39610318deb9d5fd17fa7f2d05`: the 3300 px image. That is `grow-noanchor-important-layer` on `HEAD`, and `grow-noanchor-important-inline` on both trees.
- **Runs that saved no file:**
  - Three of the five runs of `grow-noanchor-important-layer` on `HEAD`.
  - The first runs of `grow-noanchor-important-layer`, `shrink-noanchor` and `grow-compensate` on the changed tree.
  - One of them logged "[ViewShot] Error: Cannot access contents of the page. Extension manifest must request permission to access the respective host." The others logged nothing, and the page's offset log stayed empty.
  - Every page saved a file when run again.
- **A stray file:** after one `grow-noanchor` run, the download folder also held a 33 MB `downloads.html`. It is a Chrome component (a CRX holding `model.tflite`) that landed in the folder the script sends downloads to. The PNG beside it is the one in the table.

## Open questions

None.
