# KAN-597 Plan

## Files to change

1. `background.js`
   - Modify `reportFrame` (~line 360) to also return `anchorTop: window.__vsAnchor?.getBoundingClientRect().top`.
   - Modify `captureFullPage` (~line 595) to calculate `frameFrom = frame.top - (last.anchorTop - frame.anchorTop)` if an anchor is present, using the exact same scroll anchor math from KAN-590. Use `frameFrom` instead of just `frame.total === total` to determine if the page scrolled itself. If it scrolled itself (`Math.round(frameFrom) !== Math.round(reached)`), put it back.

2. `tests/fullpage.test.js`
   - Add a new test "KAN-597: puts a page back when it scrolls itself and grows while settling". The test will set up a scroll, and then while the `reportFrame` timeout/settle is running, increase `scrollTop` and `scrollHeight`, and mock `getBoundingClientRect` on the anchor so `anchorTop` reflects the move. The test should verify that `el.scrollTo(reached)` is called to put the page back.

## Steps

1. Update `reportFrame` in `background.js` to return `anchorTop`.
   → verify: The `pageIsDrawing` function now returns `{ top, total, anchorTop }` when the tab responds.
2. Update `captureFullPage` in `background.js` to calculate `frameFrom` and conditionally `scrollPageTo` if `frameFrom !== reached`.
   → verify: The `backs < 2` put-back logic triggers if the page scrolled itself, even when `frame.total !== total`.
3. Add the KAN-597 test to `tests/fullpage.test.js` and run it.
   → verify: `npm test` passes and correctly invokes the put-back logic, drawing the final image at the correct offset.

## Open questions
None. The ticket's scenario exactly aligns with extending the `__vsAnchor` logic from KAN-590 into the `reportFrame` check.
