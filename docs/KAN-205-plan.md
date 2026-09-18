# KAN-205 Plan: Full page screenshot won't scroll down the important div on Gmail and gemini.com

## Files to Change

### `background.js`
1. `measurePage` (around `background.js:282`)
2. `scrollAndReport` (around `background.js:296`)
3. `captureFullPage` (around `background.js:346`)

## Steps

1. **Find any vertical scrollbar when root scrollers fail.**
   Modify the scroller discovery logic in both `measurePage` (`background.js:282-286`) and `scrollAndReport` (`background.js:297-300`). 
   If `document.documentElement` and `document.body` do not scroll, iterate through `document.querySelectorAll('*')` to find an element where `scrollHeight > clientHeight + 1` and `getComputedStyle` has `overflowY` as `auto` or `scroll`. 
   Define a boolean `isRoot` to track whether the picked scroller is the root or an inner element.
   *Verify: Open Gmail or gemini.com, trigger a full page capture, and verify that it picks the inner scrollable div instead of the `html` or `body` elements.*

2. **Return inner element metrics.**
   In `measurePage` (`background.js:287-293`), modify the returned object so that `vh` is `el.clientHeight` for inner scrollers (and `window.innerHeight` for root), and include `winH: window.innerHeight`. 
   If an inner scroller is used, also return its bounding rect (`rect: { top, bottom, height }`).
   *Verify: Inspect the `m` object in `captureFullPage` to ensure `vh` and `rect` correctly describe the inner scroller's dimensions.*

3. **Prevent unnecessary window scroll.**
   In `scrollAndReport` (`background.js:305`), update the `window.scrollTo` call so it only executes if the scroller `isRoot`.
   *Verify: The main window does not incorrectly jump to the inner scroller's offset during the capture loop.*

4. **Adjust canvas height calculation.**
   In `captureFullPage` (`background.js:352`), adjust the calculated canvas height `h`. If `m.rect` is present, calculate the total page height as `m.rect.top + m.total + (m.winH - m.rect.bottom)` (header height + inner scroll height + footer height) instead of just `m.total`.
   *Verify: The resulting canvas is tall enough to fit the un-scrolled page headers/footers plus the entire scrolled inner element.*

5. **Stitch the inner element without repeating headers and footers.**
   In `captureFullPage`'s stitch loop (`background.js:407-409`), replace the existing `ctx.drawImage` logic. If `m.rect` is present:
   - On the first slice (`i === 0`), draw the header (0 to `m.rect.top`) at the top of the canvas, and the footer (`m.rect.bottom` to `m.winH`) at the bottom of the canvas (`m.rect.top + m.total`).
   - On every slice, draw only the inner element's portion of the viewport (`m.rect.top` to `m.rect.bottom`), placing it at `m.rect.top + actual` on the canvas.
   If `m.rect` is absent, preserve the current full-viewport stitching logic.
   *Verify: The final image stitched from Gmail or gemini.com does not repeat the navigation bars or sidebars.*

6. **Adjust final canvas trim.**
   In `captureFullPage` (`background.js:418`), update the `filled` trim variable calculation. For inner scrollers, it should trim to `m.rect.top + landed + m.vh + (m.winH - m.rect.bottom)` instead of just `landed + m.vh`.
   *Verify: Stopping the capture early produces a correctly trimmed image that retains the page footer without extra blank space below it.*

## Open Questions
- None. The ticket is specific about seeking out any vertical scrollbar and preventing the rest of the viewport from stacking repeatedly.
