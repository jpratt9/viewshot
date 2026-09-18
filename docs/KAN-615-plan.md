# KAN-615: Full page stitch draws rows twice when a page puts a layer that turns anchoring off in front of the __vsAnchor rule while it is being shot

Ticket: https://prattsolutions.atlassian.net/browse/KAN-615 (To Do, Task, labels `bug` and `viewshot`). It is blocked by KAN-611, which is Done, and its one comment says it is unblocked.

## What the repo does now

Line numbers are from `42c9b7c`, with a clean working tree.

- **`measurePage` puts the rule first once, before the first scroll.**
  - It puts `<style id="__vsAnchor">` first in `<head>`, or first in the root element when there is no `<head>` (`background.js:343-349`). A rule that a capture that died left behind is moved first too (KAN-611).
  - `captureFullPage` runs `measurePage` once, before its slice loop (`:482-485`).
- **Nothing puts the rule back in front while the page is shot.**
  - `scrollAndReport` touches the rule only in the cleanup scroll, to take it out (`:411`).
  - `reportFrame` (`:444-452`), `hideStuckSticky` (`:722`) and `markFixedAndSticky` (`:746`) don't touch it.
  - Nothing in `background.js` watches the DOM.
- **Where the rule sits decides whether it wins.** Its `!important` outranks a page's own `!important` in a layer only while its layer is declared first (KAN-582, the comment at `:331-334`). A page that puts a style sheet of its own in front of the rule declares its layer first from then on.
- **Tests:** `npm test` passes 423.
  - No test has the page put a style sheet in front of the rule during a capture.
  - Two harnesses run `measurePage` against a page with a `prepend`: `load` in `tests/fullpage.test.js` (`:47-146`), and the context in `tests/inner-scroller.test.js` (`:24-39`). Neither has a `MutationObserver`.

**Reproduced in Chrome 153.0.8010.48**, headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/kan615-plan/run-615.js`. It is `/tmp/kan611-plan/run-611b.js`, the ticket's script, with three changes:
  - it loads `/tmp/kan615-plan/cdp.js`;
  - after the capture, the page puts a `<style id="probe">` first in `<head>`, and 300 ms later the script reports whether `#__vsAnchor` is in the page and what `<head>` starts with. An observer the capture left connected would put the rule back in front of `probe`;
  - it has one more page, `layer-midcapture-forced` (see "Choices").
- `cdp.js`, `pipe.js` and `bands.py` in `/tmp/kan615-plan` are `/tmp/kan611-plan`'s, pointed at this folder.
- **The page:** `layer-midcapture`, the ticket's. It is `grow-noanchor-important-layer` without its `<style>`. On the page's first scroll, which is the capture's scroll to 713, its scroll event does two things:
  - it puts `<style>@layer page { html, body { overflow-anchor: none !important } }</style>` first in `<head>`;
  - it grows the grey block at 100 px from 200 to 500 px.
- **Reading the PNGs:** `/tmp/kan615-plan/run.sh <ext dir> <page> <label>` runs one capture. It prints:
  - the page's offsets;
  - the PNG's md5;
  - `rule-after` and `head`, from the probe;
  - the rows of each colour band down the middle column.

| Page | `HEAD` | With the change |
|---|---|---|
| `layer-midcapture` | offsets 713, 1426, 2139, 2587, then 0; 3300 px, with yellow at 600 and at 900, red at 1600, green at 1800 and blue at 2800; md5 `c372eb39610318deb9d5fd17fa7f2d05`, the ticket's PNG | offsets 713, 1013, 1726, 2439, 2587, then 0; 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500; md5 `c5eebb48c46485161d24873e68c29c93`, the PNG the ticket gives for "in place". No `#__vsAnchor` after the capture, and `probe` stays first |

- The test harness has no CSS, so no layer can win in it. It can only show where the rule is.

## Change

Three files change: `background.js`, `tests/fullpage.test.js` and `tests/inner-scroller.test.js`. The diffs were applied and tested on copies of `HEAD` outside the repo, in `/tmp/kan615-plan`. `git apply --check` takes both `/tmp/kan615-plan/bg.diff` and `/tmp/kan615-plan/test.diff` on the repo as it is.

**The rule:** while the page is shot, the rule stays first in the node `measurePage` put it in.
- A `MutationObserver` on that node's children puts the rule back in front whenever it isn't the first child.
- The browser calls the observer back as soon as the page's script that changed `<head>` has run, before it next lays the page out. So what that script changed is laid out with the rule back in front.
- The cleanup scroll disconnects the observer before it takes the rule out.

1. **`background.js`, `measurePage` (`:343-349`) and `scrollAndReport`'s cleanup (`:409-411`):**
   - `measurePage` keeps the node it puts the rule in as `head`. After it sets the rule's text, it:
     - disconnects an observer a capture that died left connected (`window.__vsAnchorObserver`);
     - makes one that puts the rule first again when it isn't, and has it watch `head`'s children.
   - The cleanup scroll disconnects and deletes the observer before it takes the rule out.
   - A comment says why (KAN-615).

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -345,8 +345,19 @@ function measurePage() {
        style = document.createElement('style');
        style.id = '__vsAnchor';
      }
   -  (document.head || document.documentElement).prepend(style);
   +  const head = document.head || document.documentElement;
   +  head.prepend(style);
      style.textContent = '@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}';
   +  // It stays first while the page is shot: a page that puts a style sheet of
   +  // its own in front of it, on a scroll say, declares its layer first from
   +  // then on, and that layer's `!important` wins (KAN-615). The observer puts
   +  // the rule back in front as soon as the page's script that did it has run,
   +  // before the browser next lays the page out. The cleanup scroll disconnects
   +  // it. One a capture that died left connected is disconnected here, or it
   +  // would put the rule back once this capture's cleanup took it out.
   +  window.__vsAnchorObserver?.disconnect();
   +  window.__vsAnchorObserver = new MutationObserver(() => { if (head.firstChild !== style) head.prepend(style); });
   +  window.__vsAnchorObserver.observe(head, { childList: true });
      // A page's own `!important` in a style attribute outranks every style sheet
      // rule, so each element with one gets the capture's own inline
      // `auto !important`, and the cleanup scroll puts the page's back (KAN-583).
   @@ -408,6 +419,8 @@ function scrollAndReport(to, cleanup, last) {
      }
      if (cleanup) {
        delete window.__vsScroller;
   +    window.__vsAnchorObserver?.disconnect();
   +    delete window.__vsAnchorObserver;
        document.getElementById('__vsAnchor')?.remove();
        for (const [node, value, name = 'overflow-anchor'] of window.__vsAnchored || []) node.style.setProperty(name, value, 'important');
        delete window.__vsAnchored;
   ```

2. **`tests/fullpage.test.js`:**
   - `load` gets a `MutationObserver` that records what each one watches until it is disconnected. `load` returns the list as `observers`. Nothing calls one back unless a test does.
   - Two tests go after "puts the anchoring rule first in <head>, before any layer the page declares" (`:592-600`):
     - "keeps the anchoring rule first in <head> while the page is shot":
       - its `<head>` keeps its children in order;
       - the page puts a style sheet of its own first in `<head>` while the second slice settles;
       - the test then calls the observers on `<head>` back, as the browser would once the page's script has run;
       - it expects the rule first at each of the five shots, nothing still watching `<head>` after the capture, and the rule gone.
     - "disconnects the observer a capture that died left on <head>": a `window.__vsAnchorObserver` left behind must be disconnected.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -72,6 +72,7 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixe
      let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
      const styles = new Map(); // the <style> elements the capture puts in the page, by id
   +  const observers = []; // the MutationObservers the capture makes in the page
      const context = {
        console,
        URL, btoa, Date, clearTimeout,
   @@ -88,6 +89,14 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixe
          createElement: () => ({ remove() { styles.delete(this.id); } }),
          head: { appendChild: (s) => styles.set(s.id, s), prepend: (s) => styles.set(s.id, s) },
        },
   +    // The capture's observers: what each one watches, until it is disconnected.
   +    // Nothing calls one back unless a test does, as the browser would once the
   +    // page's script has run.
   +    MutationObserver: class {
   +      constructor(cb) { this.cb = cb; this.on = null; observers.push(this); }
   +      observe(node) { this.on = node; }
   +      disconnect() { this.on = null; }
   +    },
        // A window that is drawing runs the callback; from frozenAt on it never does.
        // The probe for slice k runs before capture k, so captureAt is one short.
        requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
   @@ -142,7 +151,7 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixe
      vm.runInContext(CODE, context);
      captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
   -  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, styles, message: (m) => onMessage(m, {}, () => {}) };
   +  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, styles, observers, message: (m) => onMessage(m, {}, () => {}) };
    }
    
    const TAB = { id: 1, windowId: 9 };
   @@ -599,6 +608,49 @@ test('puts the anchoring rule first in <head>, before any layer the page declare
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   +test('keeps the anchoring rule first in <head> while the page is shot', async () => {
   +  // The page puts a style sheet of its own first in <head> while the second
   +  // slice settles, and the browser calls the observers on <head> back once
   +  // the page's script has run. The rule stayed where it was, so the page's
   +  // layer was declared first for the rest of the capture, and one that turns
   +  // anchoring off kept it off (KAN-615).
   +  const body = el(3000, 713);
   +  const { ctx, styles, observers } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  const kids = []; // <head>'s children, in order
   +  const head = ctx.document.head = {
   +    get firstChild() { return kids[0] || null; },
   +    prepend(n) { if (kids.includes(n)) kids.splice(kids.indexOf(n), 1); kids.unshift(n); if (n.id) styles.set(n.id, n); },
   +  };
   +  let put = false;
   +  const timer = ctx.setTimeout;
   +  ctx.setTimeout = (fn, ms) => {
   +    if (ms === 500 && body.scrollTop === 713 && !put) {
   +      put = true;
   +      head.prepend({}); // the page's own <style>
   +      for (const o of observers) if (o.on === head) o.cb([], o);
   +    }
   +    return timer(fn, ms);
   +  };
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  const first = [];
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { first.push(kids[0].id); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(first, Array(5).fill('__vsAnchor'), "shot a slice with the page's own style sheet in front of the rule");
   +  assert.ok(observers.every((o) => !o.on), 'left <head> watched');
   +  assert.strictEqual(styles.size, 0, 'left the rule in the page');
   +});
   +
   +test('disconnects the observer a capture that died left on <head>', async () => {
   +  // Left connected, it would put the rule back once this capture's cleanup
   +  // took it out (KAN-615).
   +  const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   +  let off = false;
   +  ctx.window.__vsAnchorObserver = { disconnect() { off = true; } };
   +  await ctx.captureFullPage(TAB);
   +  assert.ok(off, 'left the observer a capture that died left behind connected');
   +  assert.strictEqual(styles.size, 0, 'left the rule in the page');
   +});
   +
    // An element's inline `overflow-anchor`, as [value, priority].
    const inlineAnchor = (e) => [e.style.getPropertyValue('overflow-anchor'), e.style.getPropertyPriority('overflow-anchor')];
    
   ```

3. **`tests/inner-scroller.test.js` (`:26-27`):** its context gets a `MutationObserver` that does nothing. Without one, all 4 of its tests fail with "ReferenceError: MutationObserver is not defined".

   ```diff
   --- a/tests/inner-scroller.test.js
   +++ b/tests/inner-scroller.test.js
   @@ -25,6 +25,7 @@ function load({ body, inner, iw = 1512, ih = 767, dpr = 2 }) {
        console, URL, btoa, Date, clearTimeout, setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); }, HTMLElement,
        document: { documentElement: body, body, scrollingElement: body, querySelectorAll: (sel) => (sel === '*' && inner ? [inner] : []), getElementById: () => null, createElement: () => ({}), head: { prepend() {} } },
        requestAnimationFrame: (cb) => { cb(); },
   +    MutationObserver: class { observe() {} disconnect() {} }, // measurePage's, on <head> (KAN-615)
        getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }),
        window: { innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr, scrollTo: (x, y) => { if (body) body.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); }, getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }) },
        OffscreenCanvas: FakeCanvas,
   ```

**Choices:**

- **An observer, rather than putting the rule first again from the page scripts the capture already runs.** The ticket's page puts its layer in and grows the block in the same scroll event. So the growth is laid out, with anchoring off, before the capture's next page script runs.
  - This was tried in Chrome, in `/tmp/kan615-plan/alt`: the rule was put first again at the start of every `scrollAndReport` and `reportFrame`.
  - It saves the ticket's PNG (`c372eb39…`), as `HEAD` does.
- **It watches only the node the rule is put in, and only that node's children.** That is where `measurePage` has always put the rule.
  - A sheet the page puts in the root element before `<head>` also comes before the rule in the document.
  - The rule has never been put in front of such a sheet, and this change doesn't do that either.
- **"Not first" is the only check.**
  - Once the rule is first, the next callback does nothing, so the observer's own `prepend` doesn't set it off again.
  - The same check puts the rule back if the page takes it out of `<head>` while the page is shot.
- **No cap on how many times it puts the rule back.** A page that answered every change to `<head>` by putting its own sheet first again would trade places with the rule without end, and the page would hang. No page in the checks does that, and the ticket doesn't ask for it.
- **A capture that died leaves the observer connected, as it leaves the rule.** The next capture disconnects it before it makes its own. Left connected, it would put the rule back after that capture's cleanup took it out, and the rule would stay in the page.
- **The observer lives in the extension's world, as `window.__vsScroller` and `window.__vsAnchored` do.** The DOM is shared, so it sees the page's changes to `<head>`. On `layer-midcapture`, the page's own script puts its sheet in, and the stitch lines up.
- **The fullpage test checks where the rule is at each shot, not the stitch.** The harness has no CSS, so no layer can win in it. The stitch itself is checked in Chrome, on `layer-midcapture`.
- **Two harnesses need a `MutationObserver`.**
  - Without one, 99 tests fail with "ReferenceError: MutationObserver is not defined": 95 in `tests/fullpage.test.js` and 4 in `tests/inner-scroller.test.js`.
  - `tests/capture-errors.test.js` (`:93`) and `tests/region-cancel.test.js` (`:60`) run `measurePage` on a root element that has no `prepend`. It throws there before it reaches the observer, as it does now.
- **Not covered: a page whose own script forces a layout after it puts its sheet in and changes height, before that script returns.** That layout runs with the page's layer first, before the observer is called back.
  - `layer-midcapture-forced` is `layer-midcapture` with a `scrollHeight` read after the growth.
  - With both diffs, it saves the ticket's PNG, `c372eb39…`.
  - The ticket's page reads `scrollHeight` only before the growth.
- **Not tried: a style sheet from `chrome.scripting.insertCSS` with `origin: 'USER'`.** A user style sheet's `!important` outranks a page's `!important` whatever layer or style attribute it is in. That would also cover the forced layout above and KAN-618. But it would replace the rule's element and KAN-583/KAN-606's inline pass, which is more than this ticket needs.
- **Not covered: KAN-618**, a page that sets an `!important` `overflow-anchor` or `scroll-snap-type` in a style attribute while it is being shot. That change is to an attribute, not to a child of `<head>`.
- **No README, manifest or version change.**

## Steps

1. Apply `/tmp/kan615-plan/test.diff` (`tests/fullpage.test.js` and `tests/inner-scroller.test.js`). → verify: `npm test` runs 425 tests and 423 pass.
   - "keeps the anchoring rule first in <head> while the page is shot" fails with "shot a slice with the page's own style sheet in front of the rule". The rule is first only at the first shot: `['__vsAnchor', undefined, undefined, undefined, undefined]`.
   - "disconnects the observer a capture that died left on <head>" fails with "left the observer a capture that died left behind connected".
2. Apply `/tmp/kan615-plan/bg.diff`. → verify: `npm test` passes all 425.
3. In real Chrome, run `/tmp/kan615-plan/run.sh /Users/john/dev/viewshot <page> repo` for these pages: `layer-midcapture`, `layer-stale-after`, `layer-stale-before`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline`, `grow-noanchor`, `grow`, `snap-inline`, `snap-stale`, `snap` and `still`. If a run prints `NO PNG`, run it again. → verify:
   - on the first seven, the offsets are 713, 1013, 1726, 2439, 2587, then 0;
   - on `snap-inline`, `snap-stale`, `snap` and `still`, the offsets are 713, 1426, 2139, 2287, then 0;
   - every PNG is 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500, and md5 `c5eebb48c46485161d24873e68c29c93`;
   - every run prints `rule-after=False`, with `probe` first in `head`.

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan615-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 423 |
| `HEAD` + `test.diff` only | 423 of 425 pass. The two new tests fail as step 1 says |
| `HEAD` + `bg.diff` only | 324 of 423 pass. The 99 that fail (95 in `tests/fullpage.test.js`, 4 in `tests/inner-scroller.test.js`) fail with "ReferenceError: MutationObserver is not defined" |
| `HEAD` + both diffs | passes 425 |

**Chrome:**
- **Pages run on `HEAD`:** `layer-midcapture`.
- **The other way** (`/tmp/kan615-plan/alt`, with the rule put first again at the start of every `scrollAndReport` and `reportFrame`): on `layer-midcapture`, the offsets are 713, 1426, 2139, 2587, then 0, and the md5 is `c372eb39610318deb9d5fd17fa7f2d05`, as on `HEAD`.
- **Pages run with both diffs:** all eleven in step 3, plus `layer-midcapture-forced`. Each run saved a PNG the first time.
- **PNG md5s:**
  - `layer-midcapture` on `HEAD`: `c372eb39610318deb9d5fd17fa7f2d05`, 3300 px.
  - All eleven in step 3 with both diffs: `c5eebb48c46485161d24873e68c29c93`, 3000 px, with `rule-after=False` and `probe` first in `<head>`.
  - `layer-midcapture-forced` with both diffs: `c372eb39610318deb9d5fd17fa7f2d05`, 3300 px (see "Choices").

## Open questions

None.

## Added when shipping

- **Steps 1 and 2 on this folder:** as the plan says. With the test diff alone, 423 of 425 pass, and the two that fail are the ones step 1 names, with the same values. With both diffs, `npm test` passes all 425, and the change is byte-identical to the diffs above.
- **Step 3, run on this folder:** all eleven pages saved `c5eebb48c46485161d24873e68c29c93` on their first run: 3000 px, with the bands in place, at the offsets step 3 lists. Every run printed `rule-after=False`, with `probe` first in `head`.
- **One more test** in `tests/fullpage.test.js`, after the two in "Change": "leaves the anchoring rule where it is when the page adds to <head> behind it". It pins the "not first" check that "Choices" relies on.
  - The page puts a style sheet of its own last in `<head>` while the second slice settles, and the test calls the observers on `<head>` back. The rule must go through `prepend` only once, in `measurePage`.
  - With an observer that puts the rule first on every callback, `put` is `['__vsAnchor', '__vsAnchor']`.
  - With the test, `npm test` passes all 426.
- **Filed from "Choices":**
  - KAN-619: a page whose own script forces a layout after it puts its sheet in and changes height (`layer-midcapture-forced`).
  - KAN-620: nothing caps how often the observer puts the rule back, so it and a page that keeps its own sheet first the same way would trade places without end.
  - KAN-621: a sheet the page puts in the root element before `<head>`.
