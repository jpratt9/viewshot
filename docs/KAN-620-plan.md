# Plan for KAN-620

## Files and Changes

- `background.js`:
  - Line 358: Add `let __vsAnchorMoves = 0;` before the observer is created.
  - Line 359: Update the `MutationObserver` callback to:
    ```javascript
    window.__vsAnchorObserver = new MutationObserver(() => {
      if (root.firstChild !== style) {
        if (++__vsAnchorMoves > 10) window.__vsAnchorObserver.disconnect();
        else root.prepend(style);
      }
    });
    ```
    This caps the number of times the rule can be put back to 10 per capture, preventing an infinite microtask loop if the page's own observer fights it.
- `tests/fullpage.test.js`:
  - Around line 655: Add a new test (`gives up putting the rule back if the page fights it without end`) that mocks `root.prepend` to immediately put the page's style first and synchronously call the observer back.
  - Assert that the observer gives up after 10 moves instead of blowing the call stack.

## Steps

1. Update `background.js` to cap the observer's moves. → verify: Code inspection.
2. Add the test to `tests/fullpage.test.js`. → verify: `npm test` passes without hanging or throwing a `RangeError`.

## Open Questions

None.
