# Plan for KAN-618

## Files and Changes

- `background.js`:
  - Before the `MutationObserver` definition (around line 358), extract the inline style replacement into a helper function `const overrideStyle = (node) => { ... }`.
  - Update `window.__vsAnchorObserver` to observe `attributes: true, attributeFilter: ['style'], subtree: true` on `root`.
  - Inside the `MutationObserver` callback, add a loop over `records`. If a record's `type` is `'attributes'` and its `attributeName` is `'style'`, call `overrideStyle(record.target)`.
  - Ensure `window.__vsAnchored = window.__vsAnchored || [];` is moved above the `MutationObserver` so the callback can push to it.
  - The existing `querySelectorAll` loop before the first scroll should also just call `overrideStyle(node)`.

- `tests/fullpage.test.js`:
  - Add a test `turns scroll snapping off over a page's own !important in a style attribute set while it is being shot` near the existing snapping tests.
  - Mock `MutationObserver`'s `observe` to capture `attributes: true` requests, and update the test's `ctx.setTimeout` to set `scroll-snap-type: y mandatory !important` on an element dynamically (simulating a page doing it on scroll).
  - Verify that the observer is called back with an `attributes` record, that the element's style is overridden to `none !important`, and that the slices are shot at the non-snapped offsets.

## Steps

1. Update `background.js` to observe and override dynamic style attributes. → verify: Code inspection.
2. Add the test to `tests/fullpage.test.js`. → verify: `npm test` passes and correctly captures dynamic inline styles.

## Open Questions

None.
