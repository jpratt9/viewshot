# KAN-598 Plan

## Files to change

1. `background.js`:
   - Line ~502: Change `const actual = reached - moved;` to `let actual = reached - moved;` so it can be updated after the shot.
   - Line ~582: Right before the `break;` that exits the `shot` loop (`if (i === 0 || shot > 1 || !reshot) break;`), add a check for the page scrolling itself without changing height:
     ```javascript
     if (frame.top !== reached && frame.total === total) {
       const shift = frame.top - reached;
       actual += shift;
       landed += shift;
     }
     ```
     This updates the `actual` drawing offset and the `landed` scroll tracking variable to match the exact offset where the slice was shot (`frame.top`), rather than where the initial scroll left it.

2. `tests/fullpage.test.js`:
   - Line ~462: In the test `"shoots a slice where the page is when it scrolls itself again before that shot"`, add `canvases` to the destructured `load` return value.
   - Line ~473: Add an assertion to verify the slices are drawn at the correct offsets:
     `assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 913, 1426, 2139, 2287], 'drew the slice where it was shot');`

## Steps

1. In `background.js`, redefine `actual` as a `let` and update it and `landed` by `frame.top - reached` if the page scrolled itself before the shot.
   → verify: The slice should now be drawn at its true captured offset, rather than the requested scroll offset.
2. In `tests/fullpage.test.js`, add the `canvases` assertion to the corresponding test to ensure it tracks the correct draw offsets.
   → verify: Run `npm test` and ensure all tests pass.

## Open questions
None.
