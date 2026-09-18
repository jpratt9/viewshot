# Plan for KAN-454

## Changes

### 1. `background.js` - Use `captureVisibleTab` as the first fallback in `getViewport`
**Path:** `background.js:933`
If `scriptWithTimeout` fails to get the viewport dimensions from the page (e.g. on a `chrome://` page), `getViewport` currently falls back to `tab.width/height` with `cssPx: true`. `offscreen.js` then scales this by its own `devicePixelRatio`, which may be wrong if the offscreen document and the tab are on different displays.

Instead, we will first attempt to measure the physical pixel dimensions of the viewport directly by capturing a lightweight JPEG of the visible tab. Because `chrome.tabs.captureVisibleTab` returns an image matching the physical pixels of the screen, `bmp.width` and `bmp.height` provide the exact target dimensions without needing to know the display's scale factor.

If `captureVisibleTab` also fails (e.g. missing permissions), we will fall back to the existing `cssPx: true` logic as a last resort.

```javascript
  } catch (e) {
    console.warn('[ViewShot] getViewport script failed:', e);
    if (tab.width && tab.height) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 10 });
        const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
        return { width: bmp.width, height: bmp.height };
      } catch (err) {
        console.warn('[ViewShot] getViewport capture fallback failed:', err);
        return { width: tab.width, height: tab.height, cssPx: true };
      }
    }
    return null;
  }
```

## Verification Steps
1. **Apply changes** → verify: Update `background.js` logic.
2. **Run test suite** → verify: Ensure `npm test` passes.
3. **Verify fallback** → verify: The fallback correctly yields physical dimensions when script execution is forbidden but `activeTab` provides capture permissions.

## Open Questions
None.
