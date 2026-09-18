# Plan for KAN-621

## Files and Changes

- `background.js`:
  - Lines 348-350: Change `const head = document.head || document.documentElement;` to `const root = document.documentElement;`. Update the prepend call to `root.prepend(style);`.
  - Lines 359-360: Update the `MutationObserver` to watch `root` instead of `head`, and check `if (root.firstChild !== style) root.prepend(style);`.
- `tests/fullpage.test.js`:
  - Update tests that spy on or mock `ctx.document.head.prepend` to intercept `prepend` on `ctx.document.documentElement` instead.
  - Update tests that mock `ctx.document.head.firstChild` to provide `firstChild` on `ctx.document.documentElement`.
  - Remove or simplify the test `"puts the anchoring rule on the root element of a page with no <head>"` since the rule is now always placed on the root element.
  - Rename tests that mention `<head>` in their description to say "the root element".
- `tests/inner-scroller.test.js`:
  - Update the `document` mock (around line 26) to place the dummy `prepend() {}` method on `documentElement` instead of `head`.

## Steps

1. Update `background.js` to place and observe `__vsAnchor` on `document.documentElement`. → verify: Check that the logic reads correctly.
2. Update the mocks and test descriptions in `tests/fullpage.test.js` and `tests/inner-scroller.test.js` to match the new behavior. → verify: `npm test` passes completely.

## Open Questions

None.
