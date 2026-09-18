# KAN-507: Full page never hides a fixed or sticky element inside a shadow root

Ticket: https://prattsolutions.atlassian.net/browse/KAN-507 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-501, is Done.

## What the repo does now

Line numbers are from `85a1c76`, with a clean working tree. The ticket's refs (`background.js:434`, `:482`) still point at the right code.

- **Finding the elements:** both passes walk `document.querySelectorAll('*')`.
  - `markSticky` (`background.js:434-436`) lists the sticky elements. It runs once, at `i === 0` (`:373`).
  - `setFixedHidden(tab, true)` (`background.js:482-485`) hides the fixed ones. It runs once, at `i === 1` (`:376`).
  - `querySelectorAll` doesn't go into a shadow root, so neither pass finds an element inside one.
- **The check for a scroller of its own** (`markSticky`, `:444-449`) only climbs `parentElement`.
  - For an element directly under a shadow root, `parentElement` is null. The climb stops there, and never reaches the host or anything the host sits in.
- **Everything after the finding works on the element itself**, so an element found in a shadow root needs nothing more there:
  - `hideStuckSticky` (`:461`) and the restore in `setFixedHidden(tab, false)` go through the lists they are handed.
  - The `static` read in `markSticky` sets and puts back the element's own inline `position`.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 320.
  - The fake page's `document.querySelectorAll` (`:73`) returns the test's `fixed` list.
  - The sandbox has no `HTMLElement` and no `chrome.dom`.
  - The fakes from `positioned()` (`:347`) have no `getRootNode`.

**Reproduced in Chrome 153.0.8010.48.**

- **The run:** headless, with a disposable profile and `HEAD` loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** a new one written while planning, `/tmp/vs387-chrome/run-507.js`. It copies `run-501.js` and swaps in PageC.
- **PageC:** 3010 px tall and white. Each of its fixed and sticky elements sits inside a shadow root:
  - **`#head`:** `position: sticky; top: 0`, 30 px tall, cyan `#00ffff`.
    - It is in the open shadow root of a host inside `#box`. The box is 300 px tall with `overflow: auto`, sits at 100, and is scrolled 500 px down on load.
    - So `#head` is painted stuck to the top of the box, at 100-129.
  - **`#heading`:** `position: sticky; top: 0`, 40 px tall, green `#22cc22`. It is in the open shadow root of a 1400 px host at 1200, so its place is 1200-1239.
  - **`#chat`:** `position: fixed; top: 300px; right: 0`, 200×50, red `#ff0000`, in an open shadow root.
  - **`#cookie`:** `position: fixed; bottom: 0`, full width, 40 px tall, blue `#0000ff`, in a closed shadow root.
  - **For the probe:** an `<svg>`, plus an `<input>`, a `<details>` and a `<video controls>` in a 0 px box.
  - **For timing:** 50,000 `div`s in a `hidden` container.
- **The slices:** at 0, 713, 1426, 2139 and 2297.

The rows of the saved image that each colour shows in, on `HEAD`:

| Element | Rows |
|---|---|
| cyan `#head` (sticky, in a box) | 100-129 |
| green `#heading` (sticky) | 1200-1239, 1426-1465, 2139-2178, 2297-2336 |
| red `#chat` (fixed, open root) | 300-349, 1013-1062, 1726-1775, 2597-2646 |
| blue `#cookie` (fixed, closed root) | 673-712, 1386-1425, 2099-2138, 2970-3009 |

That is the ticket's case:
- The fixed elements are in every slice. The fourth slice's copies don't show because the last slice overlaps it and is drawn over it.
- The sticky heading is in its place, and again at the top of each slice it is stuck in.

Cyan is right on `HEAD` only by accident: `#head` is never found, and it moves with the page anyway.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:**
- Both passes search every shadow root they come to, open or closed, including a root inside another root.
- The check for a scroller of its own climbs out of a shadow root through its host.

1. **`background.js`**:
   - **The walk:** it starts with the document, then searches each shadow root it finds on the way.
     - `chrome.dom.openOrClosedShadowRoot` hands back a closed root too. `el.shadowRoot` reads null for a closed one.
     - It is only asked about an `HTMLElement`. It throws on anything else, such as an `<svg>`, and nothing else can host a shadow root.
   - **The walk is written out in both functions.** `executeScript` serializes each one standalone. That is the same reason `measurePage` and `scrollAndReport` each repeat their scroller pick (`background.js:280-281`).
   - **The climb** steps with `p.parentElement || p.getRootNode().host`.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -431,8 +431,17 @@
        target: { tabId: tab.id },
        func: (y) => {
          const list = [];
   -      for (const el of document.querySelectorAll('*')) {
   -        if (getComputedStyle(el).position === 'sticky') list.push(el);
   +      // querySelectorAll doesn't go into a shadow root, so each one it passes
   +      // is searched in turn, closed ones too (KAN-507). chrome.dom throws on
   +      // anything but an HTMLElement, an <svg> say, and nothing else can host
   +      // a shadow root.
   +      const roots = [document];
   +      while (roots.length) {
   +        for (const el of roots.pop().querySelectorAll('*')) {
   +          if (getComputedStyle(el).position === 'sticky') list.push(el);
   +          const shadow = el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el);
   +          if (shadow) roots.push(shadow);
   +        }
          }
          // One can be stuck already at the top of the page: a `bottom: 0` bar whose
          // place is further down sits pinned to the bottom of the first screen, and
   @@ -440,9 +449,11 @@
          // where `static` would put it, so each is read that way, all at once, and
          // put back before anything is painted. Only the ones that stick to the
          // page, though: one inside a scroller of its own moves with the page,
   -      // stuck or not, so its place is where it is painted.
   +      // stuck or not, so its place is where it is painted. The climb goes on
   +      // through the host of a shadow root: a component in a scrolled box sticks
   +      // to that box (KAN-507).
          const onPage = list.filter((el) => {
   -        for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
   +        for (let p = el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.parentElement || p.getRootNode().host) {
              if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) return false;
            }
            return true;
   @@ -479,9 +490,16 @@
            // every later slice would stitch it in again. Sticky elements are
            // hideStuckSticky's, slice by slice.
            const list = [];
   -        for (const el of document.querySelectorAll('*')) {
   -          if (getComputedStyle(el).position !== 'fixed') continue;
   -          list.push([el, el.style.visibility]); el.style.visibility = 'hidden';
   +        // Shadow roots too, the same walk as markSticky's (KAN-507):
   +        // executeScript serializes each standalone, so they can't share it.
   +        const roots = [document];
   +        while (roots.length) {
   +          for (const el of roots.pop().querySelectorAll('*')) {
   +            const shadow = el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el);
   +            if (shadow) roots.push(shadow);
   +            if (getComputedStyle(el).position !== 'fixed') continue;
   +            list.push([el, el.style.visibility]); el.style.visibility = 'hidden';
   +          }
            }
            window.__shotHidden = list;
          } else {
   ```

2. **`tests/fullpage.test.js`**:
   - **Fakes for the page:**
     - an `HTMLElement` class;
     - a `chrome.dom.openOrClosedShadowRoot` that throws on anything but an `HTMLElement`, with Chrome's own message.
   - **A new `light` option on `load()`:** the list `document.querySelectorAll` returns. It defaults to `fixed`, so no existing test changes.
   - **`positioned()`** gets a `getRootNode()`: the document, which has no host.
   - **The `overflow: clip` wrapper** gets `parentElement: body`, because the climb now steps past it.
   - **A `shadowHost()` fake:** an element whose shadow root, open or closed, holds the given elements.
   - **Four tests are added.**

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -7,6 +7,10 @@
    const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    const PNG = 'data:image/png;base64,AAAA';
    
   +// The page's HTMLElement. chrome.dom.openOrClosedShadowRoot takes one of these
   +// and nothing else: Chrome 153 throws on an <svg> (KAN-507).
   +class HTMLElement {}
   +
    // A scrollable element that clamps writes the way a real one does — clamping is
    // what makes the last slice overlap the previous, so the tests need it.
    function el(scrollHeight, clientHeight) {
   @@ -40,7 +44,7 @@
    
    // background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
    // the capture are all mocked — nothing real is touched.
   -function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
   +function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixed, failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
      const canvases = [];
      class FakeCanvas {
        constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
   @@ -70,7 +74,10 @@
        URL, btoa, Date, clearTimeout,
        // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
        setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
   -    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
   +    HTMLElement,
   +    // light: what document.querySelectorAll finds, which is all of `fixed`
   +    // unless a test puts some of them in a shadow root and passes its host.
   +    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => light },
        // A window that is drawing runs the callback; from frozenAt on it never does.
        // The probe for slice k runs before capture k, so captureAt is one short.
        requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
   @@ -113,6 +120,12 @@
          commands: { onCommand: { addListener() {} } },
          action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
          storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
   +      dom: {
   +        openOrClosedShadowRoot: (e) => {
   +          if (!(e instanceof HTMLElement)) throw new Error('Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): ');
   +          return e.root || null;
   +        },
   +      },
        },
      };
      vm.createContext(context);
   @@ -350,6 +363,7 @@
      return {
        pos, seen,
        getBoundingClientRect: () => ({ top, bottom }),
   +    getRootNode: () => ({}), // the document, which has no host
        style: {
          set visibility(v) { seen.push(v); }, get visibility() { return seen.length ? seen[seen.length - 1] : ''; },
          setProperty(name, value, priority = '') { if (value) inline[name] = [value, priority]; else delete inline[name]; },
   @@ -478,7 +492,7 @@
      // itself whatever their own overflow says: <body> is the scroller on a page
      // whose <body> scrolls, and <html> can hold elements added straight to it.
      const cases = {
   -    'a wrapper with overflow: clip': () => ({ overflow: 'clip' }),
   +    'a wrapper with overflow: clip': (body) => ({ overflow: 'clip', parentElement: body }),
        '<body>, scrolling': (body) => Object.assign(body, { overflow: 'auto' }),
        '<html>, overflow: hidden': (_body, de) => Object.assign(de, { overflow: 'hidden' }),
      };
   @@ -524,6 +538,67 @@
      assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 7, 'the marking or the fixed hide ran more than once, or a slice went unchecked');
    });
    
   +// --- fixed and sticky elements inside a shadow root -------------------------
   +// document.querySelectorAll doesn't go into a shadow root, so a fixed or
   +// sticky element inside a web component was never found: a fixed one was
   +// stitched into every slice, and a sticky one into every slice it was stuck
   +// in (KAN-507).
   +
   +// A web component: an element in the page whose shadow root holds `inside`.
   +// Only an open root shows as `shadowRoot`; chrome.dom reaches either kind.
   +function shadowHost(mode, ...inside) {
   +  const root = { querySelectorAll: () => inside };
   +  const host = Object.assign(new HTMLElement(), { root, shadowRoot: mode === 'open' ? root : null, getRootNode: () => ({}) });
   +  root.host = host;
   +  for (const e of inside) e.getRootNode = () => root;
   +  return host;
   +}
   +
   +test('hides a fixed element inside a shadow root, open or closed', async () => {
   +  for (const mode of ['open', 'closed']) {
   +    const chat = positioned('fixed', 300, 350); // a chat button the component pins to the viewport
   +    const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [chat], light: [shadowHost(mode, chat)] });
   +    await ctx.captureFullPage(TAB);
   +    assert.deepStrictEqual(chat.seen, ['hidden', ''], `a fixed element was left to repeat down the stitch (${mode} shadow root)`);
   +  }
   +});
   +
   +test('hides a sticky heading inside a shadow root only in the slices it is stuck in', async () => {
   +  for (const mode of ['open', 'closed']) {
   +    const body = el(3000, 713);
   +    const heading = stickyAt(body, 1200, 2600);
   +    const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading], light: [shadowHost(mode, heading)] });
   +    await ctx.captureFullPage(TAB);
   +    assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], `the heading was stitched into a slice it was stuck in (${mode} shadow root)`);
   +    assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
   +  }
   +});
   +
   +test('leaves a sticky header in a component inside a scroller where it is painted', async () => {
   +  // Nothing in the component's shadow tree scrolls: the header sticks to the
   +  // box the component sits in, which only a climb through the host reaches.
   +  const body = el(3052, 767);
   +  const header = positioned('sticky');
   +  header.getBoundingClientRect = () => {
   +    const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
   +    return { top, bottom: top + 30 };
   +  };
   +  const host = shadowHost('open', header);
   +  host.parentElement = { overflow: 'auto' }; // the box
   +  const { ctx } = load({ de: el(767, 767), body, fixed: [header], light: [host] });
   +  await ctx.captureFullPage(TAB);
   +  assert.ok(!header.seen.includes('hidden'), 'blanked a header stuck inside the scroller its component sits in');
   +});
   +
   +test('asks chrome.dom about HTMLElements only', async () => {
   +  // It throws on anything else, an <svg> icon say, and a throw there stops
   +  // the capture. Nothing but an HTMLElement can host a shadow root anyway.
   +  const icon = {}; // an <svg>: an element, but not an HTMLElement
   +  const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767), light: [icon] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 767, 1534, 2285], 'an <svg> on the page stopped the capture');
   +});
   +
    // --- a window that stops drawing -------------------------------------------
    // captureVisibleTab hands back the last frame the window presented. A window
    // that isn't drawing - minimized, occluded - presents none, so every slice came
   ```

Choices:

- **Closed roots are searched too.** The ticket covers any shadow root.
  - A closed host's `shadowRoot` reads null from the extension's script (measured). So with `el.shadowRoot` alone, `#cookie` would still repeat down the stitch.
- **`chrome.dom` is already there to use:**
  - It is a content-script API, and a function injected by `executeScript` runs as a content script, in the isolated world. The probe found it there, called the way `markSticky` is called.
  - It arrived in Chrome 88, the first release with MV3, and it needs no permission. So the manifest and README don't change.
- **The `HTMLElement` guard:**
  - Chrome throws on an `<svg>` (measured). That throw would fail the whole capture on any page with an SVG icon.
  - For `<input>`, `<details>` and `<video controls>` it returns null. The browser's own shadow roots aren't handed out, so the walk doesn't go into them.
- **The climb through the host:**
  - Without it, `#head` would be read as `static`, 500 px above where it is painted, and hidden in every slice.
  - Cyan on PageC is the check for this, and the scroller test is the unit check.
- **Nothing after the finding changes:** the `static` read, the per-slice comparison, the fixed hide and the restore work as they do now, on more elements.
- **The cost**, measured on PageC's 50,020 elements, three times each:
  - The old walk takes 24-39 ms, and the new one 67-72 ms.
  - A capture walks twice, so it adds about 0.1 s at most on a page that size. Each slice already waits 500 ms to settle.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan507-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 320.
- **Test change only:** 324 run and 322 pass. Two tests fail:
  - "hides a fixed element inside a shadow root, open or closed" fails with "a fixed element was left to repeat down the stitch (open shadow root)".
  - "hides a sticky heading inside a shadow root only in the slices it is stuck in" fails with "the heading was stitched into a slice it was stuck in (open shadow root)".
  - The other two new tests pass on `HEAD`. Nothing in a shadow root is found there, so nothing is blanked, and `chrome.dom` is never called. They guard the change.
- **Both changes:** all 324 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing tests | Messages |
  |---|---|---|
  | Open roots only (`el.shadowRoot` in both walks) | the fixed and the sticky shadow-root tests | "…left to repeat down the stitch (closed shadow root)", "…stuck in (closed shadow root)" |
  | No `instanceof HTMLElement` guard | 16: every test whose fake page has an element in it and more than one slice, "asks chrome.dom about HTMLElements only" among them | "Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): " ("puts the page back when a slice fails part-way" fails its `/capture failed/` match on that error) |
  | No climb through the host | "leaves a sticky header in a component inside a scroller where it is painted" | "blanked a header stuck inside the scroller its component sits in" |
  | The walk in `markSticky` only | "hides a fixed element inside a shadow root, open or closed" | "a fixed element was left to repeat down the stitch (open shadow root)" |
  | The walk in `setFixedHidden` only | "hides a sticky heading inside a shadow root only in the slices it is stuck in" | "the heading was stitched into a slice it was stuck in (open shadow root)" |

**Chrome 153.0.8010.48:** headless, with `run-507.js --heavy 50000`. The script asks the page these questions from the worker, through `chrome.scripting.executeScript` with a `func`, which is how `markSticky` runs. It asks after the popup has granted `activeTab`, then runs the full-page capture.

| Asked in the injected script | Answer |
|---|---|
| `typeof chrome.dom.openOrClosedShadowRoot` | `function` |
| Does `document.querySelectorAll('*')` find `#head`, `#heading`, `#chat` or `#cookie`? | no, none of them |
| `shadowRoot` of the open host / the closed host | the root / `null` |
| `chrome.dom.openOrClosedShadowRoot` of the open host / the closed host | the root / the root |
| the same, of a plain `div` and of `<html>` | `null` |
| the same, of `<input>`, `<details>` and `<video controls>` | `null` |
| the same, of an `<svg>` | throws "Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): " |
| `instanceof HTMLElement`: `div` / `<svg>` | `true` / `false` |
| the walk over 50,020 elements, three runs: old / new | 24-39 ms / 67-72 ms |

- **On `HEAD`:** the bands in the table under "What the repo does now".
- **With the change** (`--ext /tmp/kan507-plan/tree`), each colour shows once, in its place:
  - cyan at 100-129;
  - green at 1200-1239;
  - red at 300-349;
  - blue at 673-712.
- **On both builds, `after` reports:**
  - all four elements `visible`;
  - their inline `position` still the page's own (`sticky` or `fixed`);
  - `#box`'s `scrollTop` at 500;
  - the page's `scrollTop` at 0.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 324 and 322 pass. Only the two tests named in "Checked while planning" fail, with the "(open shadow root)" messages.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 324.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-507.js`, which was written while planning. Run it headless with `--heavy 50000`, with `--ext` pointed first at a copy of `HEAD` (`git archive HEAD | tar -x -C /tmp/kan507-head`) and then at the repo. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-507.py <png>`.
   → verify:
   - **On `HEAD`:** the bands in the table under "What the repo does now".
   - **On the repo:** each colour once: cyan 100-129, green 1200-1239, red 300-349, blue 673-712.
   - **On both builds**, `after` reports the four elements `visible`, their inline `position` as `sticky` or `fixed`, `#box`'s `scrollTop` as 500, and the page's `scrollTop` as 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-507-plan.md`.

## Noticed while planning, not changed

- **A slotted sticky element is checked against the wrong ancestors.**
  - The climb for a scroller of its own goes from an element to its light-DOM parent, not to the `<slot>` it is shown in.
  - Take a sticky element slotted into a component whose shadow tree has a scroller around the slot. It is read as the page's and recorded at its `static` place. When that scroller is scrolled, the element is hidden in every slice.
  - This has been the case for light-DOM elements since KAN-501. With this change, the same goes for a shadow-tree element slotted into a component nested inside it.
  - The fix would be `p.assignedSlot ||` at the front of both climb steps.
  - Not reproduced in Chrome.

## Open questions

None.
