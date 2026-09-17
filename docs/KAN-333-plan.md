# KAN-333: The Quality label shows 92% while the popup sends and saves the default quality as 0.9

Ticket: https://prattsolutions.atlassian.net/browse/KAN-333

Read the description and its one comment. The comment confirms KAN-323 shipped in `cccfcef` and the cited line numbers match that commit. KAN-333 is To Do, labeled `bug` and `viewshot`.

## Current behavior

- `popup.js:1` and `background.js:1` both default quality to `0.92`.
- `popup.html:31` defines a range from `0.3` to `1` with `step="0.05"`; `0.92` is not a permitted step value.
- `popup.js:28` assigns the requested quality to the range. `popup.js:29` builds the label from the requested value, so it can show 92% after the browser snaps the range to 0.9.
- `popup.js:70` reads the range's actual value; `popup.js:80` saves it, and `popup.js:156` sends the capture options to the worker.
- Keyboard captures use `getOpts()` at `background.js:30`, retaining the 0.92 default until settings are saved. Encoding consumes `opts.quality` at `background.js:132`.

## File to change

`popup.html:31`: change only `step="0.05"` to `step="0.01"`. This makes the existing 92% default representable, preserves every existing 5% selection, and matches the whole-percent label. The existing apply, read, save, input listener, and encoding paths can then carry the same default value without JavaScript changes or settings migration. Previously saved 90% remains 90%.

## Implementation and verification

1. Change the Quality range step to `0.01` in `popup.html:31` → verify: inspect the diff for the single attribute change; retain the existing bounds and both 0.92 defaults.
2. Load the extension in an isolated Chrome profile with no saved settings or popup cache → verify: after opening the popup, the actual range value is `0.92`, the label is `92%`, and `read().quality` is `0.92`. Change Name and blur it; confirm both `chrome.storage.local` and the localStorage mirror save quality `0.92`. Reopen and confirm the same value and label.
3. Check the capture paths and existing selections in that isolated profile → verify: a popup JPG/WebP capture sends quality `0.92`; the worker's `getOpts()` returns `0.92` both with empty settings and after saving the default. Confirm a saved `0.9` still displays 90%, and moving the slider to 91% updates and saves `0.91`.
4. Run `npm test` after implementation → verify: the existing suite passes. Use Chrome for the range behavior: `tests/defaults.test.js:26` uses plain mock elements whose value properties do not implement browser range snapping, and its quality test at `:125` checks only numeric bounds. No new test infrastructure is needed for this single-attribute fix.

## Open questions

None that block this plan. Preserve the explicit 0.92 default already used by both capture paths.

## Planning validation

Read the ticket, comment, affected code, and existing test harness. No implementation changes, browser checks, or tests were performed during planning. The verification steps above are for implementation.
