# KAN-604 Plan

## Files to change

- `background.js`:
  - `background.js:526`: Inside `captureFullPage`'s shot loop, remove the `if (backs < 2)` condition from `await sleep(500);`. It should just be `await sleep(500);` so that a slice put back a second time settles before it is shot.
- `tests/fullpage.test.js`:
  - `tests/fullpage.test.js:456`: In the test `"shoots a slice it puts back before the page scrolls itself again"`, update the expected `captureAt` array to `[0, 913, 1426, 2139, 2287]` (was `713`), because the page will now settle after the second put-back and scroll itself to `913`.
  - `tests/fullpage.test.js:539`: In the test `"shoots a slice it put back twice only once, even when a fixed element turns up after that shot"`, update the expected `captureAt` array to `[0, 913, 1426, 2139, 2287]` (was `713`) for the same reason.

## Steps

1. In `background.js`, remove the `if (backs < 2)` check before `await sleep(500);` inside `captureFullPage`.
   → verify: Run `npm test`. The two tests mentioned above will fail.
2. In `tests/fullpage.test.js`, update the expected `captureAt` arrays for both tests from `713` to `913` at the second index.
   → verify: Run `npm test`. All tests should pass.

## Open questions
None.
