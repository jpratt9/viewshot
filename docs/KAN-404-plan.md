# KAN-404: Full page saves the first screen repeated when the window stops drawing mid-capture

Ticket: https://prattsolutions.atlassian.net/browse/KAN-404 (To Do, Task, labels `bug` and `viewshot`, no comments, no blockers).

## What the repo does now

Line numbers are from `f68ce54`, with a clean working tree. The ticket's own ref (`:243-244`) is that commit's and still points at the tab guard.

- **The stitch** (`captureFullPage`, `background.js:210-262`): `measurePage` (`:172`) reports the page height and viewport, `positions` (`:218-220`) is one offset per screen, and the loop scrolls to each with `scrollPageTo` (`:202`), captures with `captureVisible` (`:239`) and draws the slice at the offset the page actually landed on (`:246`).
- **Its two guards:**
  - `if (i > 0 && actual <= landed) break;` (`:230`) — the *scroll offset* refused to advance. It breaks before `landed = actual` (`:231`), so `landed` is always the last **drawn** offset and the trim at `:255` is right.
  - `if (!now.active || now.windowId !== tab.windowId) throw ...` (`:243-244`) — the tab being shot is no longer this one. It throws, after the capture and before the draw.
- **Nothing looks at the frame.** `captureVisible` hands back a data URL and `:245-246` decode and draw it unconditionally. When the window stops presenting frames, the offsets still advance (so the first guard never fires) and the tab is still active in the same window (so the second never fires): the same first-screen frame is drawn at every offset, `filled` (`:255`) covers the whole canvas, and `runCapture` (`:143`) downloads it. No error, no badge.
- **Tests** (`tests/fullpage.test.js`, 319 lines): `npm test` passes 233 across the suite.
  - `load()` (`:42-103`) fakes the page. Its `captureVisibleTab` (`:85-90`) records the offset the page really sat at into `captureAt` and returns **the same string, `'data:image/png;base64,AAAA'`, for every call** — the fake window never draws.
  - `'never captures the same viewport twice'` (`:180`) asserts the *requested offsets* are unique, not that the frames differ. `'stops after one slice when the page will not advance'` (`:186`) exercises the offset guard with `lockedEl`.
  - **Nothing pins the frames.** `grep -n "identical\|prevUrl\|lastUrl\|duplicate" *.js tests/*.js` returns nothing in the source.
  - `captureFullPage` is only driven by this file; the `'fullpage'` runs in `tests/capture-errors.test.js` and `tests/region-cancel.test.js` use a `document.documentElement` with no `scrollHeight` (`capture-errors.test.js:83`, `region-cancel.test.js:59`), so `positions` comes out empty and no slice is ever captured there.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`.

The rule this takes: **a slice that comes back identical to the one before it, twice over, means nothing is being redrawn — stop.** It throws rather than breaking, the way the tab guard does: nothing bogus is saved, `finally` (`:250-253`) puts the page back, and `captureFailed` (`:122`) flashes `!`. Breaking instead would need `landed` unwound, because the check can only run after the capture, by which point `landed` is already the offset of the slice that must not be drawn.

**Twice over, not once.** One repeat is not enough evidence: a flat stretch of page — a long gap, a plain background — really does shoot the same bytes at two different offsets, with no scrollbar to move since it is hidden by default and fixed/sticky elements hidden from slice 2 on. That page was saved correctly before this change and has to stay saved. A window that has stopped drawing repeats for the whole rest of the capture, so it is still caught, one slice later. See "Checked in Chrome" for both measured.

1. **`background.js`:** keep the previous slice, count the repeats, and stop on the second.

   ```diff
   @@ -222,7 +222,7 @@ async function captureFullPage(tab) {
   -  let hid = false, landed = 0;
   +  let hid = false, landed = 0, prev = '', repeats = 0;
      // finally: a slice that throws part-way must still put the page back, not
      // leave it scrolled to where the stitch stopped with its headers hidden.
   @@ -244,6 +244,16 @@ async function captureFullPage(tab) {
          if (!now.active || now.windowId !== tab.windowId) throw new Error('Full page stopped: another tab is now showing');
   +      // captureVisibleTab hands back the last frame the window presented. A
   +      // window that isn't drawing - minimized, occluded - presents none, so
   +      // every slice comes back as the frame before it. The offsets still
   +      // advance and the tab is still the one showing, so neither guard above
   +      // fires: the stitch drew that one screen at every offset and saved a tall
   +      // image that is the first screen over and over, with nothing to say so.
   +      // Twice over, not once: a flat stretch of page - a long gap, a plain
   +      // background, and no scrollbar to move since it is hidden by default -
   +      // really does shoot the same bytes at two offsets, and must still save.
   +      repeats = url === prev ? repeats + 1 : 0;
   +      if (repeats >= 2) throw new Error('Full page stopped: the window is not drawing (minimized?)');
   +      prev = url;
          const bmp = await createImageBitmap(await (await fetch(url)).blob());
   ```

2. **`tests/fullpage.test.js`:** the fake window has to draw before the existing tests mean anything, plus five tests.

   ```diff
   @@ -7,6 +7,7 @@
    const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
   +const PNG = 'data:image/png;base64,AAAA';
   @@ -42,1 +43,1 @@
   -function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0, leaveAt = 0, leave = {} }) {
   +function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0, leaveAt = 0, leave = {}, frozen = false, sameAt = [] }) {
   @@ -53,6 +55,7 @@
      const captureAt = [];
   +  let last = PNG;
   @@ -85,6 +88,11 @@
            captureVisibleTab: async () => {
   -          captureAt.push(Math.max(de ? de.scrollTop : 0, body ? body.scrollTop : 0));
   +          const at = Math.max(de ? de.scrollTop : 0, body ? body.scrollTop : 0);
   +          captureAt.push(at);
              if (captureAt.length === failAt) throw new Error('capture failed');
   -          return 'data:image/png;base64,AAAA';
   +          // A window that draws hands back a different frame at each offset; one
   +          // that isn't drawing hands back the frame it last presented, forever.
   +          // sameAt: the slices a flat stretch of page shoots identically.
   +          if (frozen || sameAt.includes(captureAt.length)) return last;
   +          return (last = PNG + at);
            },
   @@ (appended)
   +// --- a window that stops drawing -------------------------------------------
   +// captureVisibleTab hands back the last frame the window presented. A window
   +// that isn't drawing - minimized, occluded - presents none, so every slice came
   +// back as the frame before it. The offsets still advanced and the tab was still
   +// the one showing, so neither guard fired: the stitch drew that one screen at
   +// every offset and saved a tall image that is the first screen over and over.
   +
   +test('stops rather than stitch the same frame down the canvas', async () => {
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), frozen: true });
   +  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534], 'stitched the repeated frame down the canvas');
   +});
   +
   +test('puts the page back when the window stops drawing', async () => {
   +  const body = el(3052, 767);
   +  body.scrollTop = 640;
   +  const header = { style: { visibility: '' } };
   +  const { ctx } = load({ de: el(767, 767), body, fixed: [header], frozen: true });
   +  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
   +  assert.strictEqual(body.scrollTop, 640, 'left scrolled to where the stitch stopped');
   +  assert.strictEqual(header.style.visibility, '', 'left the pinned header hidden');
   +});
   +
   +test('still stitches every slice of a window that is drawing', async () => {
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767) });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068, 4570],
   +    'a drawing window lost slices to the frame check');
   +});
   +
   +test('saves a page whose flat stretch shoots the same slice twice', async () => {
   +  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), sameAt: [3] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068, 4570],
   +    'a long gap or a plain background lost the whole capture');
   +});
   +
   +test('stops once the same frame comes back twice over', async () => {
   +  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), sameAt: [3, 4] });
   +  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
   +});
   ```

Choices:

- **The frames are compared as the data URLs they already are.** `captureVisible` returns a PNG data URL and the draw path re-decodes it anyway; comparing the strings needs nothing new, and JS string equality checks length first. No hashing, no pixel walk, no extra decode.
- **It holds one previous slice.** That is one more full-screen PNG data URL alive at a time (a few MB), next to a canvas that already holds the whole page.
- **It throws, and does not break.** See above: `landed` is set before the capture, so a break here would trim to a slice that was never drawn and save an image with a blank band. The ticket asks for it to "stop, the way the tab-switch guard does", and that guard throws.
- **It sits after the tab guard.** A tab that was switched away reports the more specific error, which is also the likelier one.
- **Only slices after the first are compared** — `prev` starts `''`, which no data URL equals.
- **The harness change is not optional.** With one frame for every offset, the guard fires in every existing multi-slice test (13 of them). Returning a frame per offset is what a drawing window does, and it is the only way those tests test anything about frames at all.
- **No README, manifest or version change.** Nothing user-facing is added: the badge and the error path already exist.

## Steps

1. Make the `tests/fullpage.test.js` change.
   → verify: the two frozen-window tests fail with "Missing expected rejection" and nothing else does. **Done** — 236 run, 234 passed at that point (the `sameAt` pair came in with the threshold, below).
2. Make the `background.js` change.
   → verify: `npm test` passes the whole suite. **Done** — 238 tests, 238 pass.
3. Check it in Chrome with the repo loaded unpacked, on an http page (PageA): white background, 3000 px tall, a 60 px `position: sticky; top: 0` green (`#22cc22`) header first in the body, and a paragraph every 200 px so no two screens are alike. Format PNG. **Done** — see below.

## Checked in Chrome

Chrome **153.0.8010.48** (the ticket measured 152), driven over CDP: `--enable-unsafe-extension-debugging` with `--remote-debugging-port` (the `--remote-debugging-pipe` setup earlier plans used would not hand Chrome its fds on this machine; `Extensions.loadUnpacked` works the same over the port), `Extensions.loadUnpacked`, PageA served from a local http server and opened with `Target.createTarget({forTab: true})`, the popup opened with `Extensions.triggerAction` after one warm-up, Full page pressed with `Runtime.evaluate` and `userGesture: true`, downloads to a temp dir with `Browser.setDownloadBehavior`, and a trace of `chrome.action.setBadgeText` and of what `runCapture` settled to kept in the worker. Stitched PNGs read back with Pillow: the row ranges containing green, and an md5 per viewport-high block.

- **A window that is drawing is untouched.** On the 3000 px page, `f68ce54` and this change save the same image: 1280x3060, green at rows `0-59` only, the five block hashes `8c13834d, 4aaa8b92, 31ec0879, afeef48f, 056b71f3` both times, no badge. The same run in a real (headed) window at dpr 2 gives 2560x6120 with five distinct slices and green once.
- **The ticket's case.** A real window could not be made to stop drawing from CDP on this machine — `Browser.setWindowBounds` with `windowState: 'minimized'` reports minimized while `document.visibilityState` stays `visible` and frames keep coming, and covering the window with a second one did not stop them either. So the condition the ticket describes was injected at the API it is about: `chrome.tabs.captureVisibleTab` wrapped in the worker to hand back the frame it last returned, from the second call on.
  - **On `f68ce54`:** a 1280x3060 PNG is saved with **green at `0-59`, `626-685`, `1252-1311`, `1878-1937`, `2434-2493`** — the sticky header at the top of every slice, the ticket's symptom exactly — and no badge. Five slices, three of them byte-identical.
  - **With this change:** the capture stops after 1.7 s with `Full page stopped: the window is not drawing (minimized?)`, the badge flashes `!`, **no file is saved**, and the page is left as it was: `scrollTop` 0, the header `visible`, no `__shotHideScrollbar` style and no `__shotHidden` left behind.
- **A page with a flat stretch still saves.** A 2860 px page with an 1800 px blank gap: `f68ce54` saves 1280x2860 with block hashes `885d32d8, 43e3048a, 43e3048a, c69730cc, a86306a0` — two identical slices in the middle, on a window that is drawing perfectly well. **Stopping on the first repeat failed this page** with `!` and no file at all; stopping on the second saves it, byte for byte the same image as `f68ce54`, while still catching the frozen case above. That is why the threshold is two.
- **A page that fits one screen** (626 px, the viewport): saves 1280x626, green once, no badge, page restored. One slice is never compared.

## Open questions

1. ~~Does `--headless=new` present frames or not?~~ **Answered: it does**, in Chrome 153 on this machine. A full-page capture of the 3000 px page in `--headless=new` on `f68ce54` produced five distinct slices with the header once, so headless stays usable for checking screenshot work and this change does not break captures taken there. The ticket's note to the contrary did not reproduce.
2. **A flat stretch taller than two viewports would still fail.** The threshold tolerates one repeat, not two: a page with more than about two screens of identical pixels in a row — a very long gap, a plain-colour section — would still end with `!` and no file. Nothing measured hits it (the 1800 px gap above is the worst case tried). If it turns up, the way out is to stop comparing pixels and ask the page for a frame instead (a `requestAnimationFrame` that has to answer inside a deadline, the way `scriptWithTimeout` already fences a script), which no flat page can fail.
3. **A freeze that starts within the last two slices is not caught.** It takes two repeats to stop, so a window minimized just before the end still saves an image whose last slice or two repeat the one before. The whole-image case the ticket is about is caught.
