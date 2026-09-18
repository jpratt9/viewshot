# Plan for KAN-534

## Changes

### 1. `background.js` - Track initial scale and compute dynamic scale
**Path:** `background.js:386`
Change `scale` and `maxCanvasHeight` to `let` so they can be mutated. Store `const initialScale = scale;` to use when drawing the footer canvas at the end.

```javascript
  let scale = Math.min(1, side / w, side / h, Math.sqrt(MAX_AREA / (w * h)));
  const initialScale = scale;
  let canvas = new OffscreenCanvas(Math.floor(w * scale), Math.floor(h * scale));
  let ctx = canvas.getContext('2d');
  let maxCanvasHeight = Math.floor(Math.min(side, MAX_AREA / (w * scale)));
```

### 2. `background.js` - Dynamically scale down canvas mid-capture
**Path:** `background.js:460` (Inside `while (true)` loop, before `m.rect` branch)
Before drawing a slice, calculate its projected `currentBottom`. If it exceeds `maxCanvasHeight`, recalculate a smaller `newScale` based on the expanded `m.total`. Create a new canvas with the new limits and draw the existing canvas onto it, scaling it down. 

```javascript
      const currentBottom = m.rect
        ? Math.round((Math.max(0, m.rect.top) + actual) * m.dpr * scale + Math.max(0, Math.round(Math.min(m.winH, m.rect.bottom) * m.dpr) - Math.round(Math.max(0, m.rect.top) * m.dpr)) * scale)
        : Math.round((actual * m.dpr + bmp.height) * scale);

      if (currentBottom > maxCanvasHeight) {
        const pageHeight = m.rect ? Math.max(0, m.rect.top) + m.total + Math.max(0, m.winH - m.rect.bottom) : m.total;
        const new_h = Math.round(pageHeight * m.dpr);
        const newScale = Math.min(1, side / w, side / new_h, Math.sqrt(MAX_AREA / (w * new_h)));
        if (newScale < scale) {
          const oldScale = scale;
          scale = newScale;
          maxCanvasHeight = Math.floor(Math.min(side, MAX_AREA / (w * scale)));
          
          const newDrawBottom = Math.round(currentBottom / oldScale * scale);
          const newCanvas = new OffscreenCanvas(Math.floor(w * scale), Math.min(maxCanvasHeight, newDrawBottom + 2000));
          newCanvas.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, newCanvas.width, Math.round(canvas.height * (scale / oldScale)));
          canvas = newCanvas;
          ctx = canvas.getContext('2d');
        }
      }
```

### 3. `background.js` - Scale footer drawing
**Path:** `background.js` (Footer drawing logic)
Adjust the final footer draw to scale `footerCanvas` if `scale` changed from `initialScale`.

```javascript
      const drawFooterTop = Math.round((Math.max(0, m.rect.top) + landed + m.vh) * m.dpr * scale);
      const drawFooterW = Math.round(footerCanvas.width * (scale / initialScale));
      const drawFooterH = Math.round(footerCanvas.height * (scale / initialScale));
      const finalHeight = drawFooterTop + drawFooterH;
      if (finalHeight > canvas.height && drawFooterTop <= maxCanvasHeight) {
        const newCanvas = new OffscreenCanvas(canvas.width, Math.min(maxCanvasHeight, finalHeight));
        newCanvas.getContext('2d').drawImage(canvas, 0, 0);
        canvas = newCanvas;
        ctx = canvas.getContext('2d');
      }
      if (drawFooterTop <= maxCanvasHeight) {
        ctx.drawImage(footerCanvas, 0, 0, footerCanvas.width, footerCanvas.height, 0, drawFooterTop, drawFooterW, drawFooterH);
      }
```

## Verification Steps
1. **Apply changes** → verify: Update `background.js` logic.
2. **Run test suite** → verify: All existing tests pass.

## Open Questions
None.
