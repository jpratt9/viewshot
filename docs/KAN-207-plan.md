# KAN-207: Full page captures only the first screen on sites with smooth scrolling

Ticket: https://prattsolutions.atlassian.net/browse/KAN-207 (To Do, no comments, labels `bug` and `viewshot`). No ticket blocks it.

## What the repo does now

- **Line numbers:** the ticket's references are now 4 lines lower in the file, because `02df5f2` added 4 lines to `encode()`. `scrollAndReport` is at `background.js:133-141`, and the loop's break is at `background.js:171`.
- **`scrollAndReport` (`background.js:133-141`)**
  - It picks the scroller: `html`, then `body`, then `document.scrollingElement`.
  - It sets `el.scrollTop = to` (`:138`), calls `window.scrollTo(0, to)` (`:139`), and returns `el.scrollTop` (`:140`).
  - Neither scroll passes a `behavior`, so both follow the page's CSS `scroll-behavior`.
- **`captureFullPage` (`background.js:154-196`)**
  - Each slice goes through `scrollPageTo` (`:146-151`), which calls `scrollAndReport`.
  - `if (i > 0 && actual <= landed) break;` (`:171`) stops the loop when the page didn't move.
  - The output is then trimmed to `(landed + vh) * dpr` (`:187`).
  - Restoring the original scroll position (`:183`) goes through `scrollPageTo` as well.
- **Injected styles:** the only style added during a capture is the scrollbar hider (`setScrollbarHidden`, `background.js:221-245`; style text at `:236`). `runCapture` only adds it when "Hide scrollbar before capturing" is on (`background.js:77`, `:83`). Nothing in the extension touches `scroll-behavior`.
- **Reproduced for this plan in headless Chrome 152.0.7977.83.** Setup:
  - a copy of the extension with `"host_permissions": ["<all_urls>"]`;
  - `runCapture('fullpage', await getOpts())` saving a PNG;
  - a `--window-size=1280,800` window, which gives a 713px viewport;
  - pages 4000px tall.

  Results:
  - Root with `html{scroll-behavior:smooth}`: the image was **1280x713**, the first screen only.
  - `body` as the scroller with `body{scroll-behavior:smooth}` (`html,body{height:100%;margin:0;overflow-x:hidden}body{overflow-y:auto}`): **1280x713**, the first screen only.
  - No smooth scrolling: **1280x4000**, the whole page.
- **Tests:** in `tests/fullpage.test.js`, the fake scrollers don't model smooth scrolling.
  - `el()` (`:11-18`) applies a `scrollTop` write at once.
  - `lockedEl()` (`:22-24`) ignores writes.
  - The fake `window.scrollTo(_x, y)` (`:55`) writes `de.scrollTop` directly.
  - The fake elements have no `scrollTo()` method.

## Change

The ticket offers two fixes: CSS injected alongside the scrollbar style, or `behavior: 'instant'`. This plan uses `behavior: 'instant'`:

- The scrollbar style is only injected when "Hide scrollbar before capturing" is on (`background.js:77`, `:83`). With that option off, the CSS route would leave the bug in place, and injecting the CSS anywhere else would need a new add/remove helper.
- `behavior: 'instant'` is a two-line change inside `scrollAndReport`. It covers every scroll the stitch makes, including the final restore, whatever the options are.

Two files change:

1. **`background.js`, in `scrollAndReport`:** lines `:138-139` are replaced by instant scrolls, with a 3-line comment above them.
   - `el.scrollTop = to` becomes `el.scrollTo({ top: to, behavior: 'instant' })`.
   - `window.scrollTo(0, to)` becomes `window.scrollTo({ left: 0, top: to, behavior: 'instant' })`. The `left: 0` keeps the horizontal reset the old call did.
2. **`tests/fullpage.test.js`:**
   - `el()` gets a `scrollTo(o)` that writes `scrollTop`, and `lockedEl()` gets a `scrollTo()` that does nothing.
   - A new `smoothEl()` fake doesn't move on a `scrollTop` write or a default `scrollTo`. Only `behavior: 'instant'` moves it.
   - The fake `window.scrollTo` accepts both call forms (positional and options object) and passes them to `de.scrollTo`, so the same harness runs the old code and the new code.
   - A new section at the end adds 2 tests:
     - `scrollAndReport` on a smooth-scrolling root lands before it reports;
     - `captureFullPage` on a smooth-scrolling root captures every screen.

Nothing else changes:

- `measurePage`, the rest of `captureFullPage`, `setScrollbarHidden` and the popup stay as they are.
- The "Hide scrollbar" option has no effect on the fix.
- For the version, see Open questions.

Patch for `background.js`:

```diff
--- a/background.js
+++ b/background.js
@@ -135,8 +135,11 @@
   const el = de.scrollHeight > de.clientHeight + 1 ? de
            : (b && b.scrollHeight > b.clientHeight + 1) ? b
            : (document.scrollingElement || de);
-  el.scrollTop = to;
-  window.scrollTo(0, to); // no-op unless the document itself is the scroller
+  // 'instant' overrides a page's `scroll-behavior: smooth` (Bootstrap 5,
+  // Tailwind's scroll-smooth). Without it the scroll animates, the read below
+  // still sees the old offset, and the stitch stops after the first screen.
+  el.scrollTo({ top: to, behavior: 'instant' });
+  window.scrollTo({ left: 0, top: to, behavior: 'instant' }); // no-op unless the document itself is the scroller
   return el.scrollTop;
 }
 
```

Patch for `tests/fullpage.test.js`:

```diff
--- a/tests/fullpage.test.js
+++ b/tests/fullpage.test.js
@@ -14,13 +14,27 @@
     scrollHeight, clientHeight,
     get scrollTop() { return top; },
     set scrollTop(v) { top = Math.max(0, Math.min(v, Math.max(0, scrollHeight - clientHeight))); },
+    scrollTo(o) { this.scrollTop = o.top; },
   };
 }
 
 // Reports overflow but refuses to move: an overlay-locked page, or a scroller
 // nested somewhere we can't reach.
 function lockedEl(scrollHeight, clientHeight) {
-  return { scrollHeight, clientHeight, get scrollTop() { return 0; }, set scrollTop(_v) {} };
+  return { scrollHeight, clientHeight, get scrollTop() { return 0; }, set scrollTop(_v) {}, scrollTo() {} };
+}
+
+// A scroller with `scroll-behavior: smooth`: a scrollTop write or a default
+// scrollTo only starts an animation, so the offset still reads the old value
+// straight after. Only `behavior: 'instant'` moves it at once.
+function smoothEl(scrollHeight, clientHeight) {
+  const real = el(scrollHeight, clientHeight);
+  return {
+    scrollHeight, clientHeight,
+    get scrollTop() { return real.scrollTop; },
+    set scrollTop(_v) {},
+    scrollTo(o) { if (o.behavior === 'instant') real.scrollTop = o.top; },
+  };
 }
 
 // background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
@@ -52,7 +66,7 @@
       // Faithful to the browser: window.scrollTo drives the document scroller.
       // It therefore does nothing when html is pinned to the viewport height,
       // which is exactly the case that broke.
-      scrollTo: (_x, y) => { if (de) de.scrollTop = y; },
+      scrollTo: (x, y) => { if (de) de.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); },
     },
     OffscreenCanvas: FakeCanvas,
     createImageBitmap: async () => ({ width: iw * dpr, height: ih * dpr }),
@@ -188,3 +202,22 @@
   await ctx.captureFullPage(TAB);
   assert.strictEqual(body.scrollTop, 640);
 });
+
+// --- pages with smooth scrolling -------------------------------------------
+// Bootstrap 5 and Tailwind's scroll-smooth put `scroll-behavior: smooth` on the
+// root. A scroll there only starts an animation, so the offset read straight
+// after was still the old one, the second slice looked stuck, and Full page
+// saved the first screen alone.
+
+test('scrolling a smooth-scrolling page lands before it reports', () => {
+  const de = smoothEl(3000, 800);
+  const { ctx } = load({ de, body: el(3000, 3000), ih: 800, dpr: 1 });
+  assert.strictEqual(ctx.scrollAndReport(1600), 1600);
+  assert.strictEqual(de.scrollTop, 1600);
+});
+
+test('stitches every screen of a smooth-scrolling page', async () => {
+  const { ctx, captureAt } = load({ de: smoothEl(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
+  await ctx.captureFullPage(TAB);
+  assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200], 'stopped before the end of the page');
+});
```

Both patches were tried on a copy of the repo in `/tmp`:

- **Tests before the `background.js` change:** with the updated fakes, the 15 existing tests still pass. The 2 new tests fail: `scrollAndReport(1600)` returned `0`, and `captureFullPage` captured `[0]` instead of `[0, 800, 1600, 2200]`.
- **Tests after the change:** all 17 tests in the file pass, and `npm test` passes all 112.
- **Headless Chrome 152 with the change:** Chrome accepted `behavior: 'instant'` without an error. The smooth-scrolling root, the smooth-scrolling `body` scroller and the plain page all saved **1280x4000** images, which is the whole page.

## Steps

1. Apply the `tests/fullpage.test.js` patch.
   → verify: `node --test tests/fullpage.test.js` passes the 15 existing tests and fails the 2 new ones (`0` where `1600` was expected; `[0]` captured).
2. Apply the `background.js` patch.
   → verify: `node --test tests/fullpage.test.js` passes all 17 tests.
3. Check the fix in real Chrome.
   → verify: use the headless Chrome 152 setup from step 3 of `docs/KAN-212-plan.md`:
   - **Browser setup:** `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging`; `Extensions.loadUnpacked` on a temporary copy whose manifest has `"host_permissions": ["<all_urls>"]`; the download folder set in the profile's `Default/Preferences`. Also pass `--window-size=1280,800`.
   - **Pages:** serve three pages, each with 10 bands 400px tall, using `python3 -m http.server`:
     - root smooth: `html{scroll-behavior:smooth}body{margin:0}`;
     - `body` scroller smooth: `html,body{height:100%;margin:0;overflow-x:hidden}body{overflow-y:auto;scroll-behavior:smooth}`;
     - plain: `body{margin:0}`.
   - **Capture:** for each page, store `{ format: 'png', filename: 'kan207' }` in the service worker and run `await runCapture('fullpage', await getOpts())`.
   - **Expected result:**
     - Each saved PNG is 4000px tall, read from bytes 20-23 of its header (page height × `devicePixelRatio` 1). It is not 713px, which would be one viewport.
     - Nothing lands in `~/Downloads`.
4. Check that nothing else changed.
   → verify:
   - `git status --short` lists only `background.js`, `tests/fullpage.test.js` and this plan in `docs/`.
   - `npm test` passes all 112 tests: the current 110 plus the 2 new ones.

## Open questions

1. **Version bump.** Should the version go from 0.3.2 to 0.3.3 in `manifest.json:4` and `package.json:3`? The ticket doesn't say.
   - KAN-226 and KAN-212 kept 0.3.2, partly because nothing a user sees changed. This fix does change what users see: Full page works on Bootstrap and Tailwind sites.
   - For fixes users could see, the repo has gone both ways: `d076bef` and `380fb7b` bumped the version, while `7d0a487` and `1f71c31` didn't.
   - The steps above don't bump it.
