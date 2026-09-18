# KAN-619 Plan

## Files to change

1. `background.js`
   - **`measurePage` setup** (lines 352-400): Delete the entire block that creates, prepends, and observes `<style id="__vsAnchor">`, as well as the loop that saves and replaces inline `overflow-anchor` and `scroll-snap-type` values via `__vsAnchored`.
   - **`scrollAndReport` cleanup** (lines 447-451): Delete the block that disconnects `__vsAnchorObserver`, removes the `<style id="__vsAnchor">`, and restores `__vsAnchored` styles.
   - **`captureFullPage`** (around line 520): At the very beginning of the function, declare the stylesheet `const CSS = '* { overflow-anchor: auto !important; scroll-snap-type: none !important; }';` and insert it as a User origin stylesheet before invoking `measurePage`:
     `await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: CSS, origin: 'USER' }).catch(() => {});`
   - **`captureFullPage` finally block** (around line 725): Clean up the stylesheet when capture ends:
     `await chrome.scripting.removeCSS({ target: { tabId: tab.id }, css: CSS, origin: 'USER' }).catch(() => {});`

## Steps

1. In `background.js`, remove the outdated `__vsAnchor` setup and observer from `measurePage` and its cleanup from `scrollAndReport`.
   → verify: Read the code and verify `__vsAnchor` and `__vsAnchorObserver` are no longer present.
2. In `background.js`, inject the `CSS` using `chrome.scripting.insertCSS` with `origin: 'USER'` in `captureFullPage` before `measurePage` runs, and remove it in the `finally` block.
   → verify: Run `npm test`. Because `origin: 'USER'` `!important` declarations override even page-level layered and inline `!important` declarations without relying on asynchronous `MutationObserver` callbacks, the tests (including any mid-capture layout changes) will pass seamlessly.

## Open questions
None.
