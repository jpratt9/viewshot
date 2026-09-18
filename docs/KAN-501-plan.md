# KAN-501: Full page stitches a bottom-sticky element over the first screen instead of at its own place

Ticket: https://prattsolutions.atlassian.net/browse/KAN-501 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-403, is Done.

## What the repo does now

Line numbers are from `445c738`, with a clean working tree. The ticket's refs (`background.js:428-441`, `:445-455`) still point at the right code.

- **The marking** (`markSticky`, `background.js:428-441`):
  - It runs once, at `i === 0` (`:373`), while the page is at the top.
  - It records each sticky element's place as `getBoundingClientRect().top + offset`, which is the rect as painted.
  - A `bottom: 0` element whose place is below the first screen is stuck to the bottom of the viewport at that moment. So what gets recorded is the spot it's stuck at.
- **The per-slice pass** (`hideStuckSticky`, `background.js:445-455`):
  - It runs only from the second slice on (`if (i > 0)`, `:378`), so the first slice is captured with the element stuck at the bottom of the viewport.
  - Every later slice finds the element away from that recorded spot and hides it, including the slice that holds its real place.
- **So in the ticket's case:** the element shows once, at the bottom of the first screen and over the content there, and never at its own place.
- **The restore:**
  - `finally` calls `setFixedHidden(tab, false)` only if `hid` is set (`:401`). The fixed hide sets it at `i === 1` (`:376`).
  - Inside the page, the restore only runs `else if (window.__shotHidden)` (`:471`).
  - Nothing is hidden before `i === 1` today, so that is enough today.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 316.
  - The sticky section's fakes, `positioned()` (`:344`) and `stickyAt()` (`:356`), only model `top: 0` elements, and they have no inline `position`.
  - The fake page's `getComputedStyle` (`:77`) reports no `overflow`.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:** a sticky element's place is where the document puts it, and the first slice is checked like every other.
- The place is read with the element set to `position: static`, which is where a sticky element that isn't stuck sits.

1. **`background.js`**:
   - **Reading the place:** `markSticky` sets `position: static !important` inline on every sticky element at once, reads the rects, then puts each element's own inline `position` back. All of this happens in one script, so nothing is painted in between.
   - **Only elements that stick to the page are read that way.** One that has a scroller of its own below `<body>` keeps the rect it is painted at.
   - **The loop:**
     - `hid` is set as soon as `markSticky` has run.
     - The sticky pass runs on every slice from then on (`if (hid)`).
     - The fixed hide still runs at `i === 1`.
   - **The restore** in `setFixedHidden(tab, false)` runs whether or not the fixed hide did.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -369,13 +369,14 @@
          if (i > 0 && actual <= landed) break;
          landed = actual;
          // Where each sticky element sits, read while the page is still at the
   -      // top and none of them is stuck yet.
   -      if (i === 0 && positions.length > 1) await markSticky(tab, actual);
   +      // top. From here on there is something for the finally to put back.
   +      if (i === 0 && positions.length > 1) { await markSticky(tab, actual); hid = true; }
          // Keep fixed elements (pinned headers, banners) on the FIRST slice only;
          // hide them on later slices so they aren't stitched in repeatedly.
   -      if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
   -      // Sticky ones only in the slices they are stuck in (KAN-403).
   -      if (i > 0) await hideStuckSticky(tab, actual);
   +      if (i === 1) await setFixedHidden(tab, true);
   +      // Sticky ones only in the slices they are stuck in (KAN-403), the first
   +      // included: a `bottom` one can be stuck there already (KAN-501).
   +      if (hid) await hideStuckSticky(tab, actual);
          await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
          // captureVisibleTab hands back the last frame the window presented. A
          // window that isn't drawing - minimized, occluded - presents none, so
   @@ -422,8 +423,8 @@
    // Hiding every sticky element blanked those out of the image (KAN-218), and
    // hiding only the ones the first screen showed stitched them in again at the
    // top of every slice they stayed stuck in (KAN-403). So each one's place is
   -// read at the top of the page, and each later slice hides the ones that are
   -// away from it. `offset` is where the stitch landed, not window.scrollY, which
   +// read at the top of the page, and each slice hides the ones that are away
   +// from it. `offset` is where the stitch landed, not window.scrollY, which
    // reads 0 on a page whose <body> is what scrolls (see measurePage).
    async function markSticky(tab, offset) {
      await scriptWithTimeout({
   @@ -431,10 +432,25 @@
        func: (y) => {
          const list = [];
          for (const el of document.querySelectorAll('*')) {
   -        if (getComputedStyle(el).position !== 'sticky') continue;
   -        list.push([el, el.getBoundingClientRect().top + y, el.style.visibility]);
   +        if (getComputedStyle(el).position === 'sticky') list.push(el);
          }
   -      window.__shotSticky = list;
   +      // One can be stuck already at the top of the page: a `bottom: 0` bar whose
   +      // place is further down sits pinned to the bottom of the first screen, and
   +      // its rect is that spot (KAN-501). A sticky element that isn't stuck sits
   +      // where `static` would put it, so each is read that way, all at once, and
   +      // put back before anything is painted. Only the ones that stick to the
   +      // page, though: one inside a scroller of its own moves with the page,
   +      // stuck or not, so its place is where it is painted.
   +      const onPage = list.filter((el) => {
   +        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
   +          if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) return false;
   +        }
   +        return true;
   +      });
   +      const was = onPage.map((el) => [el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]);
   +      for (const el of onPage) el.style.setProperty('position', 'static', 'important');
   +      window.__shotSticky = list.map((el) => [el, el.getBoundingClientRect().top + y, el.style.visibility]);
   +      onPage.forEach((el, k) => el.style.setProperty('position', ...was[k]));
        },
        args: [offset],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
   @@ -468,8 +484,10 @@
              list.push([el, el.style.visibility]); el.style.visibility = 'hidden';
            }
            window.__shotHidden = list;
   -      } else if (window.__shotHidden) {
   -        for (const [el, v] of window.__shotHidden) el.style.visibility = v;
   +      } else {
   +        // Not only after the fixed hide: a sticky element can be hidden on the
   +        // first slice, and a capture can stop there (KAN-501).
   +        for (const [el, v] of window.__shotHidden || []) el.style.visibility = v;
            for (const [el, , v] of window.__shotSticky || []) el.style.visibility = v; // whatever hideStuckSticky left hidden
            window.__shotHidden = null;
            window.__shotSticky = null;
   ```

2. **`tests/fullpage.test.js`**:
   - The fakes now hold an inline `position`, and `stickyAt()` answers as `static` when that is set.
   - A new `stickyToBottomAt()` models a `bottom: 0` element.
   - The fake page's `getComputedStyle` reports `overflow`.
   - Three tests are added, and the call count goes from 6 to 7.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -74,7 +74,7 @@
        // A window that is drawing runs the callback; from frozenAt on it never does.
        // The probe for slice k runs before capture k, so captureAt is one short.
        requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
   -    getComputedStyle: (e) => ({ position: fixed.includes(e) ? (e.pos || 'fixed') : 'static' }),
   +    getComputedStyle: (e) => ({ position: fixed.includes(e) ? (e.pos || 'fixed') : 'static', overflow: e.overflow || 'visible' }),
        window: {
          innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr,
          // Faithful to the browser: window.scrollTo drives the document scroller.
   @@ -339,14 +339,23 @@
    // have shown it, leaving blank space where it belongs (KAN-218). Sparing it
    // then stitched it in again at the top of every later slice it stayed stuck
    // in (KAN-403): a sticky element is hidden only in the slices it is stuck in.
   +// A `bottom` one can be stuck already at the top of the page, so each one's
   +// place is read as `static`, and the first slice is checked too (KAN-501).
    
   -// Keeps what the capture did to the element's visibility, in order.
   +// Keeps what the capture did to the element's visibility, in order, and holds
   +// the inline `position` a capture sets on it and puts back.
    function positioned(pos, top, bottom) {
      const seen = [];
   +  const inline = {}; // property -> [value, priority]
      return {
        pos, seen,
        getBoundingClientRect: () => ({ top, bottom }),
   -    style: { set visibility(v) { seen.push(v); }, get visibility() { return seen.length ? seen[seen.length - 1] : ''; } },
   +    style: {
   +      set visibility(v) { seen.push(v); }, get visibility() { return seen.length ? seen[seen.length - 1] : ''; },
   +      setProperty(name, value, priority = '') { if (value) inline[name] = [value, priority]; else delete inline[name]; },
   +      getPropertyValue: (name) => (inline[name] ? inline[name][0] : ''),
   +      getPropertyPriority: (name) => (inline[name] ? inline[name][1] : ''),
   +    },
      };
    }
    
   @@ -356,7 +365,22 @@
    function stickyAt(scroller, at, end, height = 40) {
      const e = positioned('sticky');
      e.getBoundingClientRect = () => {
   -    const top = Math.min(Math.max(at - scroller.scrollTop, 0), end - height - scroller.scrollTop);
   +    const y = scroller.scrollTop;
   +    // `static` puts it in its place, stuck or not
   +    const top = e.style.getPropertyValue('position') === 'static' ? at - y : Math.min(Math.max(at - y, 0), end - height - y);
   +    return { top, bottom: top + height };
   +  };
   +  return e;
   +}
   +
   +// A `bottom: 0` sticky element whose place in the page is `at`, in a container
   +// that starts at `start`: stuck to the bottom of a `vh` viewport until the page
   +// scrolls down to its place, and in it from then on.
   +function stickyToBottomAt(scroller, at, start, vh, height = 40) {
   +  const e = positioned('sticky');
   +  e.getBoundingClientRect = () => {
   +    const y = scroller.scrollTop;
   +    const top = e.style.getPropertyValue('position') === 'static' ? at - y : Math.max(Math.min(at - y, vh - height), start - y);
        return { top, bottom: top + height };
      };
      return e;
   @@ -413,6 +437,49 @@
      assert.strictEqual(header.style.visibility, '', 'left the header hidden');
    });
    
   +test('shows a bottom-sticky bar at its own place, not over the first screen', async () => {
   +  // A 40 px `bottom: 0` bar whose place is 2400 px down, in a container that
   +  // starts at the top: at the top of the page it is stuck to the bottom of the
   +  // screen. It carries the page's own inline `position: sticky !important`.
   +  const body = el(3000, 713);
   +  const bar = stickyToBottomAt(body, 2400, 0, 713);
   +  bar.style.setProperty('position', 'sticky', 'important');
   +  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [bar] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
   +  // Stuck to the bottom of the first three slices, in its place in the last two.
   +  assert.deepStrictEqual(shownAt.map(([v]) => v), ['hidden', 'hidden', 'hidden', '', ''], 'the bar was stitched in where it was stuck, or blanked out of its own place');
   +  assert.strictEqual(bar.style.visibility, '', 'left the bar hidden');
   +  assert.deepStrictEqual([bar.style.getPropertyValue('position'), bar.style.getPropertyPriority('position')], ['sticky', 'important'], 'did not put the page\'s own position back');
   +});
   +
   +test('leaves a sticky element stuck inside a scroller of its own where it is painted', async () => {
   +  // A table header stuck to the top of a scrolled box. The box moves with the
   +  // page, so the header does too; `static` would put it 300 px further up, out
   +  // of the box's view, which is not where the page shows it.
   +  const body = el(3052, 767);
   +  const header = positioned('sticky');
   +  header.parentElement = { overflow: 'auto' }; // the box
   +  header.getBoundingClientRect = () => {
   +    const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
   +    return { top, bottom: top + 30 };
   +  };
   +  const { ctx } = load({ de: el(767, 767), body, fixed: [header] });
   +  await ctx.captureFullPage(TAB);
   +  assert.ok(!header.seen.includes('hidden'), 'blanked a header stuck inside its own scroller');
   +});
   +
   +test('puts a bar hidden on the first slice back when the capture stops there', async () => {
   +  // A page that won't scroll stops the stitch before the second slice's fixed
   +  // hide, the step that used to be the only one with anything to put back.
   +  const body = lockedEl(3052, 767);
   +  const bar = stickyToBottomAt(body, 2400, 0, 767);
   +  const { ctx, captureAt } = load({ de: el(767, 767), body, fixed: [bar] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0], 'the stitch did not stop at the first slice');
   +  assert.strictEqual(bar.style.visibility, '', 'left the bar hidden');
   +});
   +
    test('still hides a fixed element wherever it sits', async () => {
      const button = positioned('fixed', 700, 760); // a back-to-top button, pinned to the viewport
      const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [button] });
   @@ -427,11 +494,11 @@
      assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
    });
    
   -test('marks and hides fixed elements once, and checks sticky ones on every later slice', async () => {
   +test('marks and hides fixed elements once, and checks sticky ones on every slice', async () => {
      const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
      await ctx.captureFullPage(TAB);
   -  // the marking, the fixed hide and the restore once each, and the sticky check on each of the three later slices
   -  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 6, 'the marking or the fixed hide ran more than once, or a later slice went unchecked');
   +  // the marking, the fixed hide and the restore once each, and the sticky check on each of the four slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 7, 'the marking or the fixed hide ran more than once, or a slice went unchecked');
    });
    
    // --- a window that stops drawing -------------------------------------------
   ```

Choices:

- **Why `static`:**
  - A sticky element that isn't stuck is laid out exactly where `static` puts it. The sticky offset only applies while it is stuck, and the box keeps its place in the flow either way.
  - So the `static` rect is its place in the document whether it is stuck or not.
  - No other box moves when one sticky element goes `static`, which is why all of them can be read at once.
- **How the page is left:**
  - The set and the put-back happen in one script, so no frame is painted with anything `static`.
  - The inline declaration is `!important`, so a stylesheet's `position: sticky !important` doesn't win.
  - Each element's own inline `position` goes back exactly as it was, value and priority. An element that had none gets none.
- **Only elements that stick to the page are read as `static`.**
  - A sticky element inside a scroller of its own, such as a table header in a scrolled box, sticks to that box. It moves with the page whether it is stuck or not. So where it is painted is its place in the page, and it is never hidden, as today.
  - Read as `static`, it would be recorded where it would sit with its box scrolled to the top. It would then be hidden in every slice and blanked out of the image.
  - A scroller is any ancestor below `<body>` with `overflow` `auto`, `scroll` or `hidden`. `overflow: clip` doesn't make one.
  - `<body>` and `<html>` count as the page. That covers a page whose document scrolls as well as one whose `<body>` does (see `measurePage`).
- **The first slice is checked too**, because that is the slice a bottom-stuck bar covers.
  - A top-sticky element is in its place there, since the page is at the top, so nothing changes for those.
  - A page that fits one screen still runs none of these scripts.
- **`hid` now means "the page is marked, and the `finally` puts it back".** It is set right after `markSticky`, because the sticky pass can hide something from the first slice on. The fixed hide keeps its `i === 1`. Its `!hid` guard is gone because `i === 1` only comes once and `hid` is now already set by then.
- **The restore runs whether or not the fixed hide did.** A capture can stop on the first slice with a bar hidden: the frame check or the tab check can throw there, and a page that won't scroll stops before the second slice's fixed hide.
- **The per-slice comparison and its offset are unchanged** from KAN-403.
- **No README, manifest or version change.**

## Checked while planning

Run on a copy of `HEAD` (`git archive`) in `/tmp/kan501-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 316.
- **Test change only:** 319 run and 317 pass. Two tests fail:
  - "shows a bottom-sticky bar at its own place, not over the first screen" fails with "the bar was stitched in where it was stuck, or blanked out of its own place".
  - "marks and hides fixed elements once, and checks sticky ones on every slice" fails on the call count.
- **Both changes:** all 319 pass.
- **Both changes, with one piece broken at a time:** each time, only the tests named below fail.

  | Piece broken | Failing tests | Messages |
  |---|---|---|
  | The rect read as painted, not as `static` | "shows a bottom-sticky bar at its own place…" | "the bar was stitched in where it was stuck, or blanked out of its own place" |
  | Every sticky element read as `static` (no check for a scroller of its own) | "leaves a sticky element stuck inside a scroller of its own where it is painted" | "blanked a header stuck inside its own scroller" |
  | The first slice not checked (`if (i > 0)`) | the bar test, the call count | the bar message, "the marking or the fixed hide ran more than once, or a slice went unchecked" |
  | The restore only after the fixed hide (`else if (window.__shotHidden)`) | "puts a bar hidden on the first slice back when the capture stops there" | "left the bar hidden" |
  | The inline `position` not put back | the bar test, "hides a sticky heading only…", "still hides a sticky header…", "gives a sticky element back its own visibility…" | each test's own message |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 319 and 317 pass. Only the two tests named in "Checked while planning" fail, with those messages.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 319.
3. Check the change in Chrome with a new script, `/tmp/vs387-chrome/run-501.js`.
   - **The script:** a copy of `run-218.js` (KAN-403's check). Two things change:
     - its page becomes PageB;
     - its `after` reads PageB's elements: the visibility of `#bar` and `#head`, `#bar`'s inline and computed `position`, `#box`'s `scrollTop`, and the page's `scrollTop`.
   - **PageB:** 3000 px tall, white, with three elements:
     - **`#top`:** `position: sticky; top: 0`, 60 px tall, green `#22cc22`, the same as PageA.
     - **`#box`:** 300 px tall with `overflow: auto`, 40 px below the header, so it spans 100 to 400. A script scrolls it 500 px down on load. It holds `#head`: `position: sticky; top: 0`, 30 px tall, cyan `#00ffff`. That header is stuck to the top of the box, at 100-129.
     - **`#bar`:** `position: sticky; bottom: 0`, 40 px tall, magenta `#ff00ff`. It is a direct child of `<body>` and its place is at 2600. At the top of the page it is stuck to the bottom of the first screen, at 673-712.
   - **Running it:** use `--headful`, with `--ext` pointed first at a copy of `HEAD` (`git archive HEAD | tar -x -C /tmp/kan501-head`), then at the repo.
   - **Reading the bands:** allow ±6 per channel. A real window colour-manages the capture; in KAN-403's check, `#22cc22` came back as rgb(36,204,35).

   → verify:
   - **On `HEAD`:** magenta at 673-712 only, and none at 2600-2639. That is the ticket's case.
   - **With the change:** magenta at 2600-2639 only.
   - **On both builds:**
     - green appears once, at 0-59;
     - cyan appears once, at 100-129;
     - `after` reports `#bar` and `#head` as visible, `#bar`'s inline `position` as `sticky` (PageB sets it in the style attribute, so that is its own value put back) and its computed `position` as `sticky`, `#box`'s `scrollTop` as 500, and the page's `scrollTop` as 0.
   - **PageA with the change** (`run-218.js --headful --ext <repo>`):
     - red appears at 1200-1239 only;
     - green appears once, at 0-59;
     - blue appears once, at 653-692.
     That is KAN-403's result, unchanged.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-501-plan.md`.

## Noticed while planning, not changed

- **Reading places as `static` writes the inline `position` of every page-sticky element twice**: once to set it, once to put it back. A page watching its own style attributes with a `MutationObserver` sees both writes. Nothing else can, because nothing is painted in between.

## Open questions

None.
