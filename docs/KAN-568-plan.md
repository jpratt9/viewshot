## Plan for KAN-568

### 1. Merge DOM walks in `background.js`
File: `background.js`
Lines: ~631-752

Remove `markSticky` and `setFixedHidden` and replace them with a combined `markFixedAndSticky` function that performs a single DOM walk, and a `restoreFixedAndSticky` function.
```javascript
async function markFixedAndSticky(tab, doFixed, fixedFirst, stickyFirst) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id },
    func: (doFixed, fixedFirst, stickyFirst) => {
      const fixedAdded = [];
      const stickyList = [];
      const fixedList = fixedFirst ? [] : window.__shotHidden || [];
      const stickyListed = stickyFirst ? [] : window.__shotSticky || [];
      
      const roots = [document];
      while (roots.length) {
        for (const el of roots.pop().querySelectorAll('*')) {
          const shadow = el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el);
          if (shadow) roots.push(shadow);
          
          const pos = getComputedStyle(el).position;
          if (doFixed && pos === 'fixed' && !fixedList.some(([e]) => e === el)) {
            fixedAdded.push([el, el.style.visibility]);
            el.style.visibility = 'hidden';
          }
          if (pos === 'sticky') stickyList.push(el);
        }
      }
      
      let fixedReshot = false;
      if (doFixed) {
        window.__shotHidden = [...fixedList, ...fixedAdded];
        fixedReshot = fixedAdded.length > before; // before is missing here, we can just use fixedAdded.length > 0
      }
      
      const slotOf = (n) => {
        const root = n.parentElement instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(n.parentElement);
        return root && [...root.querySelectorAll('slot')].find((s) => s.assignedElements().includes(n));
      };
      const onPage = stickyList.filter((el) => {
        for (let p = el.assignedSlot || slotOf(el) || el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.assignedSlot || slotOf(p) || p.parentElement || p.getRootNode().host) {
          if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) return false;
        }
        return true;
      });
      const added = onPage.filter((el) => !stickyListed.some(([e]) => e === el)).map((el) => [el, el.style.visibility]);
      window.__shotSticky = [...stickyListed, ...added];
      
      return { fixedReshot: fixedAdded.length > 0, stickyReshot: added.length > 0 };
    },
    args: [doFixed, fixedFirst, stickyFirst],
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result;
}

async function restoreFixedAndSticky(tab) {
  await scriptWithTimeout({
    target: { tabId: tab.id },
    func: () => {
      for (const [el, v] of window.__shotHidden || []) el.style.visibility = v;
      for (const [el, v] of window.__shotSticky || []) el.style.visibility = v;
      window.__shotHidden = null;
      window.__shotSticky = null;
    },
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
}
```
→ verify: `markFixedAndSticky` successfully parses and tracks both elements in one DOM walk.

### 2. Update `captureFullPage` to use the merged function
File: `background.js`
Lines: ~464-511, 604

Update the calls in `captureFullPage` to use the new function, simplifying the logic since `hid` covers both passes.

Replace Lines ~464-468:
```javascript
      if (m.total > m.vh) hid = true;
      if (hid) {
        await markFixedAndSticky(tab, i > 0, i === 1, i === 0);
        await hideStuckSticky(tab);
      }
```

Replace Lines ~479-483:
```javascript
        if (hid) {
          await markFixedAndSticky(tab, i > 0, false, false);
          await hideStuckSticky(tab);
        }
```

Replace Lines ~507-511:
```javascript
        let reshot = false;
        if (hid) {
          const res = await markFixedAndSticky(tab, i > 0, false, false);
          if (res.fixedReshot || res.stickyReshot) reshot = true;
          if (await hideStuckSticky(tab)) reshot = true;
        }
        if (i === 0 || shot === 2 || !reshot) break;
```

Replace Line ~604:
```javascript
    if (hid) await restoreFixedAndSticky(tab); // restore
```
→ verify: `captureFullPage` no longer makes multiple DOM walks.

### 3. Update tests to match new `func` call counts
File: `tests/fullpage.test.js`
Lines: ~657, 750, 818

Because `markSticky` and `setFixedHidden` are combined, the total number of `func` script injections decreases. Update the exact arrays and counts in the three specific script call verification tests.

→ verify: `npm test` passes all 402 unit tests successfully.

### Open questions
None.
