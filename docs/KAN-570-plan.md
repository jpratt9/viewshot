## Plan for KAN-570

### 1. Re-hide tracked fixed elements
File: `background.js`
Lines: ~673-686

Update `markFixedAndSticky` to enforce the `hidden` visibility on all fixed elements during every pass, rather than skipping the ones already in the tracking list. If an element's visibility has changed (because the page unhid it) or it's a new element, mark `fixedReshot` as true to trigger a reshoot.

```javascript
      let fixedReshot = false;
      const roots = [document];
      while (roots.length) {
        for (const el of roots.pop().querySelectorAll('*')) {
          const shadow = el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el);
          if (shadow) roots.push(shadow);
          
          const pos = getComputedStyle(el).position;
          if (doFixed && pos === 'fixed') {
            if (!fixedList.some(([e]) => e === el)) {
              fixedAdded.push([el, el.style.visibility]);
              fixedReshot = true;
            }
            if (el.style.visibility !== 'hidden') {
              el.style.visibility = 'hidden';
              fixedReshot = true;
            }
          }
          if (pos === 'sticky') stickyList.push(el);
        }
      }
      
      if (doFixed) {
        window.__shotHidden = [...fixedList, ...fixedAdded];
      }
```
→ verify: Any fixed element that the page sets back to `visible` will be caught, re-hidden, and trigger a reshoot after the slice is shot.

### 2. Verify Tests Pass
File: `tests/fullpage.test.js`

Because the internal logic of the injected `func` handles this without adding any additional script calls, no test changes are strictly required, but verify that the existing 402 unit tests continue to pass to ensure no unexpected side effects.
→ verify: `npm test` passes all tests successfully.

### Open questions
None.
