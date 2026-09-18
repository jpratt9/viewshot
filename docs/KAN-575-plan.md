# KAN-575: Full page stitch doesn't line up on pages with scroll anchoring off when content above the viewport changes height

Ticket: https://prattsolutions.atlassian.net/browse/KAN-575 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-515, is Done.

## What the repo does now

Line numbers are from `de828de`, with a clean working tree.

- **How the stitch sees content above the screen change height:** by how far the offset moved between slices (KAN-515).
  - `scrollAndReport` reads `from = el.scrollTop` before it scrolls (`background.js:375`).
  - `captureFullPage` takes `moved = from - landed` and draws each slice `moved` px back (`:458-461`).
  - That works where Chrome's scroll anchoring moves the offset to keep the rows on screen in place.
- **With anchoring off (`overflow-anchor: none`),** the rows move on screen and the offset stays where it is:
  - `moved` stays 0;
  - a slice whose rows move while it settles is shot with them moved.
- **Nothing turns anchoring on.** The only style the capture puts in the page is `setScrollbarHidden`'s (`:765-792`). It hides the scrollbar, and only when the "hide scrollbar" option is on (`:285`, `:290`).
- **The full page's page state:**
  - `measurePage` (`:327-353`) runs once at the start of every full page and leaves `window.__vsScroller` in the page.
  - The last scroll, `scrollPageTo(tab, m.prevY, true)` in the `finally` (`:613`), takes it out with `if (cleanup) delete window.__vsScroller;` (`:372`).
- **Tests:** `npm test` passes 405. The fake documents in `tests/fullpage.test.js:82` and `tests/inner-scroller.test.js:26` have no `getElementById`, `createElement` or `head`.

**Reproduced in Chrome 153.0.8010.48**, as the ticket says.

- **The run:** headless, with a disposable profile and the tree loaded unpacked. PNG, with a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/vs387-chrome/run-575.js`, a copy of `run-515.js` with more `--page` variants. It is read with `/tmp/vs387-chrome/bands-515.py`.
- **PageG:** white, and 3000 px tall at the start.
  - A cyan 60 px `top: 0` header sits at 0 and a grey block at 100 px.
  - 40 px bands sit at yellow 600, red 1300, green 1500 and blue 2500, their places in the page at the start.
  - The block changes height on the page's first scroll, the one to 713, when it is above the screen:

  | `--page` | Anchoring | Grey block |
  |---|---|---|
  | `grow-noanchor` | `html, body { overflow-anchor: none }` | 200 → 500 px |
  | `shrink-noanchor` | the same | 500 → 200 px |
  | `grow-noanchor-important` | `html, body { overflow-anchor: none !important }` | 200 → 500 px |
  | `grow-compensate` | `overflow-anchor: none`; the page adds the height it added to its own offset, as pages that turn anchoring off to do this themselves do | 200 → 500 px |
  | `grow` | on (the default) | 200 → 500 px |
  | `still` | on | never changes |

- **The results.** "In place" means each band shows once, at its place at the start (600, 1300, 1500, 2500), in a 3000 px image. Offsets are from a scroll listener in the page.

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `grow-noanchor` | offsets 713, 1426, 2139, 2587; yellow at 600 and at 900, red 1600, green 1800, blue 2800; 3300 tall | offsets 713, 1013, 1726, 2439, 2587; in place |
  | `shrink-noanchor` | offsets 713, 1426, 1987; red 1000, green 1200, blue 2200; 2700 tall | offsets 713, 413, 1126, 1839, 1987; in place |
  | `grow-noanchor-important` | as `grow-noanchor` | unchanged: as `grow-noanchor` on `HEAD` |
  | `grow-compensate` | offsets 713, 1013, 1726, 2439, 2587; in place | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall |
  | `grow` | in place | a PNG byte-identical to `HEAD`'s |
  | `still` | in place | a PNG byte-identical to `HEAD`'s |

- **That is the ticket's case:** on `HEAD`, `grow-noanchor` stitches the yellow band in twice, and `shrink-noanchor` leaves 300 rows out.
- **With the change,** Chrome's anchoring moves the offset on those pages, and KAN-515's `moved` does the rest.
- **What it doesn't fix:**
  - `grow-noanchor-important` stays as it is, because the page's own `!important` rule on `html, body` outranks the rule on `*`.
- **What it breaks:**
  - `grow-compensate` lines up on `HEAD`, because KAN-515 reads the page's own +300.
  - With the change, anchoring moves the offset 300 px and the page moves it another 300. The image leaves out 300 rows. See Open questions.

## Change

Three files change: `background.js`, `tests/fullpage.test.js` and `tests/inner-scroller.test.js`. All three diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan575-plan/tree`.

**The rule:**
- While a full page is shot, every element has scroll anchoring on, with the ticket's rule, `*{overflow-anchor:auto!important}`.
- The rule is in a `<style id="__vsAnchor">`, put in the way `setScrollbarHidden` puts its own style in.
- `measurePage` puts it in, and the cleanup scroll takes it out, the same as `window.__vsScroller`.
- The KAN-515 code then sees these pages move as it sees any page with anchoring on.

1. **`background.js`**
   - **`measurePage` (`:327`):** puts the style in, unless one is there already. A capture that died can leave one behind.
   - **`scrollAndReport` (`:372`):** its cleanup branch takes the style out.
   - **No new page script:** the call-order tests (`tests/fullpage.test.js:706`, `:806`, `:875`) are untouched.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -325,6 +325,15 @@
    // These two run in the page. executeScript serializes them standalone, so they
    // can't share a helper and each repeats the same three-line pick.
    function measurePage() {
   +  // Scroll anchoring on for the capture, over a page's own `overflow-anchor:
   +  // none`: content above the screen that changes height then moves the offset,
   +  // which is how the stitch sees it (KAN-575). The cleanup scroll takes it out.
   +  if (!document.getElementById('__vsAnchor')) {
   +    const style = document.createElement('style');
   +    style.id = '__vsAnchor';
   +    style.textContent = '*{overflow-anchor:auto!important}';
   +    (document.head || document.documentElement).appendChild(style);
   +  }
      const de = document.documentElement, b = document.body;
      let el = de.scrollHeight > de.clientHeight + 1 ? de
             : (b && b.scrollHeight > b.clientHeight + 1) ? b
   @@ -369,7 +378,7 @@
        }
        el = el || document.scrollingElement || de;
      }
   -  if (cleanup) delete window.__vsScroller;
   +  if (cleanup) { delete window.__vsScroller; document.getElementById('__vsAnchor')?.remove(); }
      const isRoot = el === de || el === b || el === document.scrollingElement;
      // Where the page is before it moves. fromHere scrolls `to` on from there.
      const from = el.scrollTop;
   ```

2. **`tests/fullpage.test.js`**
   - **`load()`'s fake document** (`:82`) gains `getElementById`, `createElement` and `head`. They are backed by a `styles` map, which `load()` returns (`:137`).
   - **A new section** before "a stitch that stops part-way" (`:377`), with three tests:
     - the rule is in the page at every shot and gone after the capture;
     - it is taken out when a slice fails;
     - a rule left behind by a capture that died is used, not doubled, and is taken out.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -71,6 +71,7 @@
      let onMessage; // background.js's chrome.runtime.onMessage listener
      let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
   +  const styles = new Map(); // the <style> elements the capture puts in the page, by id
      const context = {
        console,
        URL, btoa, Date, clearTimeout,
   @@ -79,7 +80,12 @@
        HTMLElement,
        // light: what document.querySelectorAll finds, which is all of `fixed`
        // unless a test puts some of them in a shadow root and passes its host.
   -    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => light },
   +    document: {
   +      documentElement: de, body, scrollingElement: de, querySelectorAll: () => light,
   +      getElementById: (id) => styles.get(id) || null,
   +      createElement: () => ({ remove() { styles.delete(this.id); } }),
   +      head: { appendChild: (s) => styles.set(s.id, s) },
   +    },
        // A window that is drawing runs the callback; from frozenAt on it never does.
        // The probe for slice k runs before capture k, so captureAt is one short.
        requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
   @@ -134,7 +140,7 @@
      vm.runInContext(CODE, context);
      captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
   -  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, message: (m) => onMessage(m, {}, () => {}) };
   +  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, styles, message: (m) => onMessage(m, {}, () => {}) };
    }
    
    const TAB = { id: 1, windowId: 9 };
   @@ -373,7 +379,46 @@
      await ctx.captureFullPage(TAB);
      assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0], 'went on past a scroll that came back with nothing');
    });
   +
   +// --- pages that turn scroll anchoring off ----------------------------------
   +// The stitch sees content above the screen change height by how far scroll
   +// anchoring moves the offset (KAN-515). A page with `overflow-anchor: none`
   +// moves the rows on screen instead, so the slices after it were drawn off from
   +// the ones before. Anchoring is now on for every element while the page is
   +// shot, with a rule put in the way the scrollbar one is (KAN-575).
    
   +test('turns scroll anchoring on while the page is shot, and back off after', async () => {
   +  const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  const rules = [];
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { rules.push(styles.get('__vsAnchor')?.textContent); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(rules, Array(4).fill('*{overflow-anchor:auto!important}'), 'shot a slice without the rule');
   +  assert.strictEqual(styles.size, 0, 'left the rule in the page');
   +});
   +
   +test('takes the anchoring rule back out when a slice fails', async () => {
   +  const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1, failAt: 2 });
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  let shotWith;
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { shotWith = styles.has('__vsAnchor'); return shoot(...a); };
   +  await assert.rejects(ctx.captureFullPage(TAB));
   +  assert.ok(shotWith, 'shot the slice that failed without the rule');
   +  assert.strictEqual(styles.size, 0, 'left the rule in the page');
   +});
   +
   +test('uses the anchoring rule a capture that died left behind, and takes it out', async () => {
   +  const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   +  const left = { id: '__vsAnchor', textContent: '*{overflow-anchor:auto!important}', remove() { styles.delete(this.id); } };
   +  styles.set(left.id, left);
   +  const add = ctx.document.head.appendChild;
   +  let added = 0;
   +  ctx.document.head.appendChild = (s) => { added++; return add(s); };
   +  await ctx.captureFullPage(TAB);
   +  assert.strictEqual(added, 0, 'put a second rule in');
   +  assert.strictEqual(styles.size, 0, 'left the rule in the page');
   +});
   +
    // --- a stitch that stops part-way ------------------------------------------
    // The page was only put back after the last slice, so a slice that threw left
    // it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   ```

3. **`tests/inner-scroller.test.js`:** its fake document (`:26`) gains the same three members, which do nothing.

   ```diff
   --- a/tests/inner-scroller.test.js
   +++ b/tests/inner-scroller.test.js
   @@ -23,7 +23,7 @@
      let pageScriptTimeout;
      const context = {
        console, URL, btoa, Date, clearTimeout, setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); }, HTMLElement,
   -    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: () => (inner ? [inner] : []) },
   +    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: () => (inner ? [inner] : []), getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
        requestAnimationFrame: (cb) => { cb(); },
        getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }),
        window: { innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr, scrollTo: (x, y) => { if (body) body.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); }, getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }) },
   ```

**Choices:**

- **In `measurePage` and the cleanup scroll, not a new function like `setScrollbarHidden`.**
  - There is no new page script.
  - The rule has the same lifetime as `window.__vsScroller`.
  - It is only ever in the page during a full page, not during Visible or Region.
- **Not tied to "hide scrollbar."** The stitch needs anchoring whether or not the scrollbar is hidden.
- **The ticket's rule, word for word.** A page's own `!important` on a more specific selector still wins, as `grow-noanchor-important` shows.
- **No README, manifest or version change.**

## Steps

1. Apply the two test diffs. → verify: `npm test` runs 408. 405 pass, and the three new tests fail.
2. Apply the `background.js` diff. → verify: `npm test` passes 408.
3. In real Chrome, run `node /tmp/vs387-chrome/run-575.js --ext /Users/john/dev/viewshot --page <page>` for `grow-noanchor`, `shrink-noanchor`, `grow` and `still`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. → verify:
   - On `grow-noanchor` and `shrink-noanchor`, yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image.
   - `grow` and `still` match `HEAD`'s runs.

## Checked while planning

**Tests:** run on copies of `HEAD` (`git archive`) in `/tmp/kan575-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 405 |
| `HEAD` + the `background.js` diff only | 79 of 405 fail, because the fake documents have no `getElementById` |
| `HEAD` + the two test diffs | 405 pass, and the three new tests fail |
| `HEAD` + all three diffs | passes 408 |
| all three, without the cleanup's `remove()` | the three new tests fail |
| all three, without the "unless one is there already" check | "uses the anchoring rule a capture that died left behind, and takes it out" fails |

**Chrome:** see the tables under "What the repo does now".
- The first runs of `grow` and `grow-noanchor-important` on the changed tree saved no file. The capture never started, and the page's offset log was empty.
- Both were run again, and both saved a file.

## Open questions

1. **Is it acceptable that pages which turn anchoring off and keep their own rows in place stitch misaligned from now on?**
   - `grow-compensate` shows it:
     - It lines up on `HEAD`.
     - With the change, Chrome's anchoring and the page's own adjustment both move the offset (713 → 1313), and the image leaves out 300 rows.
   - Pages turn anchoring off for exactly this reason: they adjust the offset themselves, as a chat or a feed does when it puts content in above and adds its height to the offset.
   - The ticket names the rule planned here as one of two ways. The other, reading one element's place in the page on every slice, would leave these pages alone. It has a cost of its own:
     - it has to catch rows that move on screen while a slice settles, before its shot, which means a new page pass before every shot;
     - it needs a rule for which element to read.
   - That way is not planned or tried here.
