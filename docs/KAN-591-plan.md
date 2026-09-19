# KAN-591 Plan

## Files to change
- `background.js`: ~line 613 (inside `captureFullPage`'s loop)

## Steps
1. **Update the post-shot shift calculation to use `targetFrameFrom`**
   - **Where**: `background.js` at the end of the `captureFullPage` loop inside the `if (i === 0 || shot > 1 || !reshot)` block.
   - **What**: Change `if (frame.top !== reached && frame.total === total)` to `if (frame.top !== targetFrameFrom)`.
   - **Why**: `targetFrameFrom` already correctly computes the logical offset of the frame by accounting for scroll anchoring (subtracting `last.anchorTop - frame.anchorTop`). If the page did not scroll itself but was only shifted by scroll anchoring, `targetFrameFrom` will equal `frame.top`. By using `targetFrameFrom`, the stitch correctly ignores layout shifts that Chrome anchored instead of misinterpreting them as the page's own scroll. This perfectly prevents repeating rows.
   - **Verify**: The modified logic passes all tests in `tests/fullpage.test.js` when simulating an anchored viewport shift without a page height change.

2. **Update the shift amount computation**
   - **Where**: `background.js`, immediately following the condition changed in Step 1.
   - **What**: Change `const shift = frame.top - reached;` to `const shift = frame.top - targetFrameFrom;`.
   - **Why**: Any true discrepancy between the frame's physical offset (`frame.top`) and its anchored logical offset (`targetFrameFrom`) represents the page's own scroll, which must be accurately reflected in `actual` and `landed`.
   - **Verify**: Run `npm test` to ensure all existing and newly written test cases pass seamlessly.

## Open Questions
None.
