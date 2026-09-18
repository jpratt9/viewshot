## Plan for KAN-571

### 1. Prune tracking arrays
File: `background.js`
Lines: ~664-710

Update `markFixedAndSticky` to prune `fixedList` and `stickyListed` of any elements that no longer match the `fixed` or `sticky` position criteria. If an element is removed, restore its original visibility. If restoring the visibility changes its visual state, mark the appropriate reshot flag to ensure a clean capture.

Change from:
```javascript
      const fixedList = fixedFirst ? [] : window.__shotHidden || [];
      const stickyListed = stickyFirst ? [] : window.__shotSticky || [];
      
      let fixedReshot = false;
```

To:
```javascript
      let fixedList = fixedFirst ? [] : window.__shotHidden || [];
      let stickyListed = stickyFirst ? [] : window.__shotSticky || [];
      
      let fixedReshot = false;
      let stickyReshot = false;

      fixedList = fixedList.filter(([el, v]) => {
        if (getComputedStyle(el).position !== 'fixed') {
          if (el.style.visibility !== v) {
            el.style.visibility = v;
            fixedReshot = true;
          }
          return false;
        }
        return true;
      });

      stickyListed = stickyListed.filter(([el, v]) => {
        if (getComputedStyle(el).position !== 'sticky') {
          if (el.style.visibility !== v) {
            el.style.visibility = v;
            stickyReshot = true;
          }
          return false;
        }
        return true;
      });
```

And update the return statement:
Change from:
```javascript
      return { fixedReshot, stickyReshot: added.length > 0 };
```

To:
```javascript
      return { fixedReshot, stickyReshot: stickyReshot || added.length > 0 };
```

→ verify: Any element that stops being fixed or sticky will be removed from the tracking arrays, have its original visibility restored, and trigger a reshoot if necessary.

### 2. Verify Tests Pass
File: `tests/fullpage.test.js`

→ verify: `npm test` passes all tests successfully to ensure no regressions in existing lifecycle behaviors.

### Open questions
None.
