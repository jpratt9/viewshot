# KAN-590 Plan

## Files to change

1. `tests/fullpage.test.js`:
   - Line ~117: Update the `el` mock object to include a safe default `querySelectorAll: () => []` so `scrollAndReport` can safely query elements.
   - Line ~418 (after the KAN-576 test): Add a new test for KAN-590: `lines the slices up on a page that scrolls itself and grows`.
     - Set up the test with a 3000px body.
     - Override `body.querySelectorAll` to return a mock element whose `getBoundingClientRect().top` dynamically reflects `-body.scrollTop` (simulating a normal document element).
     - Have the page scroll itself by 200px and grow `scrollHeight` by 100px right after the second slice.
     - Verify `captureAt` correctly resolves to `[0, 713, 1426, 2139, 2387]` rather than overshooting.

2. `tests/inner-scroller.test.js`:
   - Line ~26: In the fake `document` context, ensure `querySelectorAll: () => []` is present to support root scrollers. (Note: this is likely already there from prior mocks, but verify).

3. `background.js`:
   - In `scrollAndReport`, add logic to find an anchor element before scrolling. It should query `el.querySelectorAll('*')` for the first element that is within the viewport bounds, has a height > 0, and is not `position: fixed` or `sticky`.
   - Update the `from` calculation:
     - If `last && window.__vsAnchor` exists and is still in the document, calculate the offset difference: `from = last.actual + (last.anchorTop - window.__vsAnchor.getBoundingClientRect().top)`.
     - Otherwise, fall back to the existing `el.scrollHeight === last.total ? last.actual : el.scrollTop`.
   - At the end of `scrollAndReport`, assign the newly found anchor to `window.__vsAnchor` and return its `top` position as `anchorTop` alongside the other values.

## Steps

1. In `tests/fullpage.test.js` and `tests/inner-scroller.test.js`, add `querySelectorAll: () => []` to the `el` mock and fake document to prevent TypeErrors in the new anchor lookup.
   → verify: `npm test` runs all existing tests cleanly.
2. In `background.js`, implement the element lookup logic and update the `from` assignment to track the previous anchor's movement relative to the viewport.
   → verify: `npm test` passes all tests, confirming the fallback behavior works perfectly when no anchors are found.
3. In `tests/fullpage.test.js`, add the KAN-590 specific test that provides a mock anchor node, modifies `body.scrollTop` and `body.scrollHeight` simultaneously, and asserts `captureAt` correctness.
   → verify: `npm test` passes the new test, demonstrating that the page's own scroll is successfully decoupled from height changes.

## Open questions
None. The ticket explicitly referenced "reading one element's place" as the necessary measure, which this tracking mechanism fulfills.
