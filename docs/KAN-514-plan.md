# Plan for KAN-514

## Changes

### 1. `background.js` - Update `scrollAndReport` to return total height
**Path:** `background.js:329`
Change `scrollAndReport` to return both the current scroll position and the total height.
```javascript
  return { actual: el.scrollTop, total: el.scrollHeight };
```

### 2. `background.js` - Update `scrollPageTo` to return the new object
**Path:** `background.js:358`
Change the wrapper to return the object.
```javascript
  return result || { actual: 0, total: 0 };
```

### 3. `background.js` - Make `captureFullPage` dynamically iterate and resize canvas
**Path:** `background.js:384-457`
Change the static `positions` array and `for` loop to a `while(true)` loop that recalculates `m.total` on each slice and resizes the `canvas` if it needs to grow.

- Replace `const positions = ...` with loop state variables: `let target = 0, i = 0, footerCanvas = null;`.
- Calculate `const maxCanvasHeight = Math.floor(Math.min(side, MAX_AREA / (w * scale)));`.
- Use `while (true)`:
  - `const { actual, total } = await scrollPageTo(tab, target);`
  - `m.total = total;`
  - `if (i > 0 && actual <= landed) break; landed = actual;`
- Update the `i === 0` footer logic for inner scrollers:
  - Instead of drawing `footerH` to `ctx` immediately at `m.total`, draw it to an `OffscreenCanvas` (`footerCanvas`) so it can be deferred until the very end (since `m.total` might grow).
- Before drawing the current slice:
  - Calculate `const drawTop = ...` and `const drawBottom = drawTop + sliceDrawH;`.
  - If `drawBottom > canvas.height`:
    - `if (drawBottom > maxCanvasHeight) break;` (format limits reached)
    - Resize `canvas` using a new `OffscreenCanvas(canvas.width, Math.min(maxCanvasHeight, drawBottom + 2000))` and draw the old canvas onto it.
- At the end of the loop body:
  - `if (actual >= m.total - m.vh) break;`
  - `target = Math.min(target + m.vh, Math.max(0, m.total - m.vh)); i++;`
- After the loop (but inside `try`), draw `footerCanvas` if it exists:
  - Calculate `drawFooterTop` using the final `m.total`.
  - Resize `canvas` if `drawFooterTop + footerCanvas.height > canvas.height`.
  - `ctx.drawImage(footerCanvas, 0, drawFooterTop);`

## Verification Steps
1. **Change `scrollAndReport` and `scrollPageTo`** → verify: `scrollPageTo` correctly returns `{ actual, total }`.
2. **Implement dynamic loop in `captureFullPage`** → verify: The capture loop advances based on the newly returned `m.total`.
3. **Implement dynamic canvas resizing** → verify: The `canvas` grows in height if `drawBottom > canvas.height`.
4. **Implement deferred footer draw for inner scrollers** → verify: The footer is drawn at the correct final `m.total` offset.
5. **Run test suite** → verify: All existing tests in `tests/fullpage.test.js` and `tests/inner-scroller.test.js` pass, as they mock the API correctly.

## Open Questions
None. The ticket requires dynamic position iteration and canvas resizing, which this plan fulfills while respecting encoding limits (`MAX_SIDE`, `MAX_AREA`).
