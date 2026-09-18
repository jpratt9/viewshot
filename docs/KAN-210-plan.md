# Plan for KAN-210: Full page fails on tall pages and WebP output is silently cut off

## What the code does now

- `captureFullPage(tab)` (`background.js:339-400`) makes one canvas of `vw × dpr` by `total × dpr` (`:345`) and never checks that size.
  - Past Chrome's encode limits (65,535 px a side, 268,435,456 px² in all), the final `convertToBlob` (`:399`) throws.
  - That only happens after every slice has been scrolled and captured.
- `runCapture` calls it without the output format (`:250`). `encode` (`:259-273`) then re-encodes at whatever size it gets:
  - WebP comes back cropped to 16,383 px.
  - JPEG comes back clamped to 65,500 px.

## The change

Scale the stitch down to fit, and work the scale out from `measurePage`'s numbers before the first scroll.

- **The limit depends on what the image will be saved as:**
  - WebP: 16,383 px a side.
  - JPEG: 65,500 px a side.
  - PNG: 65,535 px a side. This also covers the clipboard, which always gets a PNG, and a recording format, which `encode` saves as PNG.
  - Every format: 268,435,456 px² in all.
- **How it's applied:**
  - `scale = min(1, side / w, side / h, sqrt(area / (w × h)))`.
  - The canvas is made at `floor(w × scale) × floor(h × scale)`.
  - Each slice is drawn at that scale. Its top and bottom are rounded to whole rows, so neighbouring slices meet without a seam.
  - At scale 1, every number is exactly what it is today.
- **Why scale rather than split:** the ticket allows either.
  - Scaling keeps one image: one download, and it still fits the clipboard. The change stays inside `captureFullPage`.
  - Splitting would need several downloads, names for them, and some other plan for the clipboard, which holds one image.
  - The cost of scaling: a page past the limit comes out at lower resolution. For WebP at dpr 2, that means any page taller than 8,191 CSS px.

## Files to change

1. **`background.js`**
   - Above `captureFullPage` (`:338`), add the limits:
     ```javascript
     // Chrome encodes no canvas past 65,535 px a side or 268,435,456 px² in all -
     // convertToBlob throws IndexSizeError - and cuts a JPEG at 65,500 px and a
     // WebP at 16,383 px without a word (KAN-210). A full page that would be
     // bigger is scaled down to fit, worked out before the first scroll: the old
     // stitch only found out after it had scrolled every screen.
     const MAX_SIDE = { png: 65535, jpg: 65500, webp: 16383 };
     const MAX_AREA = 268435456;
     ```
   - `:339`: `async function captureFullPage(tab)` becomes `async function captureFullPage(tab, format)`.
   - `:345`, the canvas:
     ```javascript
     const w = Math.round(m.vw * m.dpr), h = Math.round(m.total * m.dpr);
     const side = MAX_SIDE[format] || MAX_SIDE.png; // a recording format is saved as PNG
     const scale = Math.min(1, side / w, side / h, Math.sqrt(MAX_AREA / (w * h)));
     const canvas = new OffscreenCanvas(Math.floor(w * scale), Math.floor(h * scale));
     ```
   - `:384`, the slice:
     ```javascript
     // Whole rows at each end, so scaled slices meet without a seam.
     const top = Math.round(actual * m.dpr * scale);
     ctx.drawImage(bmp, 0, top, Math.round(bmp.width * scale), Math.round((actual * m.dpr + bmp.height) * scale) - top); // where it really is, not where we asked
     ```
   - `:393`, the trim: `Math.round((landed + m.vh) * m.dpr * scale)`.
   - `:250`: `png = await captureFullPage(tab, opts.toClipboard ? 'png' : opts.format);`

2. **`tests/fullpage.test.js`**
   - `FakeCanvas` (`:44-54`):
     - `convertToBlob` throws the ticket's `IndexSizeError: The size of "OffscreenCanvas" is zero.` past 65,535 px a side or 268,435,456 px², as Chrome does.
     - `drawImage` records the drawn width and height as well as `x` and `y`.
   - New tests, in a section after `'restores the original scroll offset when done'` (`:219-225`):
     - a. `'a page too tall to encode is scaled to fit'`: a 40,000 CSS px page at dpr 2 (80,000 px). The capture now resolves, the canvas is 65,535 px or less tall, and its width is scaled by the same factor.
     - b. `'a WebP full page is held to 16,383 px'`: `captureFullPage(TAB, 'webp')` on a 10,000 CSS px page at dpr 2.
     - c. `'a JPEG full page is held to 65,500 px'`: a 34,000 CSS px page at dpr 2 (68,000 px).
     - d. `'a wide window is held to the area limit'`: `iw` 3840 at dpr 2, on a 20,000 CSS px page. Width × height must stay at or under 268,435,456.
     - e. `'scaled slices meet with no gap'`: for (a), each slice starts at or above the bottom of the one before, and the last reaches the canvas's bottom.
   - Pages that fit need no new test. `'stitches a normal document-scrolling page unchanged'` (`:186`) and `'trims the canvas to what was actually stitched'` (`:206`) must keep passing as they are.

3. **`tests/capture-errors.test.js`**: add one test at the call site, next to `'an uninjectable page still reaches the shutter'` (`:218-222`).
   - `runCapture` hands `captureFullPage` the format the image will be saved as:
     - `{ format: 'webp' }` gives `'webp'`;
     - `{ format: 'jpg', toClipboard: true }` gives `'png'`.
   - `bg.ctx.captureFullPage` is stubbed to record its argument and then throw.

## Steps

1. Add the tests (2 and 3) before touching the code. → verify: `npm test` fails exactly the 6 new tests, and everything else passes:
   - (a), (c) and (d) fail because the fake's `convertToBlob` throws;
   - (b) fails because the canvas is 20,000 px tall;
   - (e) fails because (a)'s capture rejects;
   - the call-site test fails because it records `undefined`.
2. Make the `background.js` change (1). → verify: `npm test` passes all 312 tests (306 plus 6).
3. Check in headless Chrome at `--force-device-scale-factor=2`. Adapt `/tmp/vs387-chrome/run-218.js`, which runs Full page from the popup and downloads to a temp dir, and use a page with a coloured marker at its very bottom. Run each case against `HEAD` and against the change. → verify:
   - PNG, 34,000 CSS px page (68,000 px):
     - before: `!` after every screen has been scrolled, and no file;
     - after: a PNG 65,535 px or less tall, with its width scaled by the same factor and the marker at the bottom.
   - WebP, 10,000 CSS px page (20,000 px):
     - before: a WebP 16,383 px tall with no marker;
     - after: 16,383 px or less tall, with the marker there.
   - PNG, 3,000 CSS px page:
     - before and after: 6,000 px tall, at full resolution.

## Open questions

None. The ticket allows splitting or scaling; this plan scales, for the reasons above.
