# Plan for KAN-577: No tests cover KAN-570's fixed re-hide or KAN-571's fixed/sticky prune in markFixedAndSticky

## Changes

1. **`tests/fullpage.test.js`**
   Add three new tests to the end of the file to cover the missing edge cases in `markFixedAndSticky`.

   *Test 1: `re-hides a listed fixed element the page unhides during the capture`*
   * Set up a page with a fixed header.
   * Hook `ctx.requestAnimationFrame` so that when `captureAt.length === 1` and `header.style.visibility === 'hidden'`, the test explicitly sets `header.style.visibility = ''`, simulating the page unhiding it.
   * Assert `shownAt` equals `['', '', 'hidden', 'hidden', 'hidden', 'hidden']`, proving the capture detects the unhide, successfully re-hides it, and issues a reshot.

   *Test 2: `prunes an element that loses its fixed positioning and restores its visibility`*
   * Set up a page with a fixed header.
   * Use `Object.defineProperty` to dynamically change the header's position to `static` once `captureAt.length >= 3` (after the first slice has been shot).
   * Assert `shownAt` equals `['', 'hidden', 'hidden', '', '', '']`, proving the element was correctly dropped from `__shotHidden` and its original empty visibility was restored.

   *Test 3: `prunes an element that loses its sticky positioning and restores its visibility`*
   * Set up a page with a sticky header.
   * Use `Object.defineProperty` to dynamically change the header's position to `static` once `captureAt.length >= 3`.
   * Hook `ctx.requestAnimationFrame` to manually hide the header (`visibility = 'hidden'`) when `captureAt.length === 2`, simulating a manual visibility shift before pruning.
   * Assert `shownAt` equals `['', '', 'hidden', '', '', '']`, proving the sticky element was pruned from `__shotSticky` and its original visibility was correctly restored, forcing a reshot.

## Steps

1. Add the three tests to `tests/fullpage.test.js`. → verify: `npm test` passes completely and the total test count increases by 3 (from 416 to 419).

## Open Questions
None.
