## Plan for KAN-526

### 1. Update `markSticky` to report new sticky elements
File: `background.js`
Lines: ~615-661

Change `markSticky` to return whether new sticky elements were found.
```javascript
async function markSticky(tab, first) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id },
    func: (first) => {
      // ... existing search logic ...
      const listed = first ? [] : window.__shotSticky || [];
      const added = onPage.filter((el) => !listed.some(([e]) => e === el)).map((el) => [el, el.style.visibility]);
      window.__shotSticky = [...listed, ...added];
      return added.length > 0;
    },
    args: [first],
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result;
}
```
→ verify: `markSticky` returns `true` when new sticky elements are found.

### 2. Update `hideStuckSticky` to report visibility changes
File: `background.js`
Lines: ~663-685

Change `hideStuckSticky` to return whether the visibility of any sticky element was changed during the pass.
```javascript
async function hideStuckSticky(tab) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id },
    func: () => {
      // ... existing logic ...
      let changed = false;
      list.forEach(([el, v], k) => {
        el.style.setProperty('position', ...was[k]);
        const set = Math.abs(painted[k] - place[k]) > 1 ? 'hidden' : v;
        if (el.style.visibility !== set) {
          el.style.visibility = set;
          changed = true;
        }
      });
      return changed;
    },
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result;
}
```
→ verify: `hideStuckSticky` returns `true` when a sticky element gets hidden or revealed.

### 3. Check for sticky elements after the shot to trigger a retry
File: `background.js`
Lines: ~488-490

Update the loop in `captureFullPage` to also run the sticky passes after the shot and reshoot if any pass returns `true`.
```javascript
        // And the fixed and sticky ones the page put in, or pinned, after the hide above:
        // they are in this shot, at their spot on the screen. One found here sends the
        // slice back to settle and run the passes above again before it is shot again.
        let reshot = false;
        if (i > 0 && await setFixedHidden(tab, true)) reshot = true;
        if (hid) {
          if (await markSticky(tab, false)) reshot = true;
          if (await hideStuckSticky(tab)) reshot = true;
        }
        if (i === 0 || shot === 2 || !reshot) break;
```
→ verify: A slice is shot again if a sticky element is added or changes stuck status between the second pass and the shot.

### Open questions
None.
