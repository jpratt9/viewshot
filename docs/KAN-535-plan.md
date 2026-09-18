# Plan for KAN-535

## Changes

### 1. `background.js` - Mark scroller in `measurePage`
**Path:** `background.js:296`
In `measurePage`, store the discovered scroller on the `window` object of the isolated world so subsequent `executeScript` calls can reuse it without DOM crawling.

```javascript
  el = el || document.scrollingElement || de;
  window.__vsScroller = el;
```

### 2. `background.js` - Reuse scroller in `scrollAndReport`
**Path:** `background.js:311`
In `scrollAndReport`, add a `cleanup` argument. Use `window.__vsScroller` to find the scroller. Keep the existing search logic as a fallback. Delete the property if `cleanup` is true.

```javascript
function scrollAndReport(to, cleanup) {
  const de = document.documentElement, b = document.body;
  let el = window.__vsScroller;
  if (!el) {
    el = de.scrollHeight > de.clientHeight + 1 ? de
           : (b && b.scrollHeight > b.clientHeight + 1) ? b
           : null;
    if (!el) {
      for (const node of document.querySelectorAll('*')) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const style = window.getComputedStyle(node);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') { el = node; break; }
        }
      }
    }
    el = el || document.scrollingElement || de;
  }
  if (cleanup) delete window.__vsScroller;
```

### 3. `background.js` - Pass `cleanup` to `scrollPageTo`
**Path:** `background.js:354`
Update `scrollPageTo` to accept `cleanup` and pass it to `scrollAndReport`.

```javascript
async function scrollPageTo(tab, y, cleanup = false) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id }, func: scrollAndReport, args: [y, cleanup],
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
```

### 4. `background.js` - Trigger `cleanup` in full-page teardown
**Path:** `background.js:498`
```javascript
  } finally {
    if (hid) await setFixedHidden(tab, false); // restore
    await scrollPageTo(tab, m.prevY, true);
```

## Verification Steps
1. **Apply changes** → verify: Update `background.js` logic.
2. **Run test suite** → verify: All existing tests pass.

## Open Questions
None.
