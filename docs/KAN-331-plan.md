# KAN-331: The popup overwrites a Name or Quality edit that's still in progress when it finishes opening

Ticket: https://prattsolutions.atlassian.net/browse/KAN-331

Read the description and its one comment. The comment confirms KAN-323 shipped in `cccfcef`, unblocking this ticket, and explicitly assigns unfinished edits to KAN-331. This plan is based on the clean working tree after `c584c99`.

## Current behavior

- `popup.js:43` paints cached settings or defaults immediately. `load()` at `popup.js:49` then waits for storage and the active tab.
- `popup.js:66` skips reconciliation only if `save()` has set `optsSaved` (`popup.js:81`). Otherwise it calls `apply()`.
- `apply()` at `popup.js:26` assigns Quality, its label, and Name unconditionally (`:28-30`).
- Quality's `input` listener at `popup.js:183` updates only its label. Name has no `input` listener. Both save on `change` (`:184-185`). Consequently, an input event before loading finishes does not protect an unfinished edit.
- The existing tests at `tests/defaults.test.js:227` and `:236` exercise completed changes; they do not cover input without change. `bootPopup()` at `:39` already supports making edits before `settle()` lets loading finish.

## Files to change

### `popup.js`

- Near the existing popup state at `popup.js:6`, add two booleans, `filenameEdited` and `qualityEdited`, initially false.
- At `popup.js:183`, set `qualityEdited` in the existing Quality `input` listener, retaining its label update. Add a Name `input` listener next to `popup.js:185` that sets `filenameEdited`.
- In `apply()` at `popup.js:28`, assign Quality and its label only if `qualityEdited` is false. Assign Name at `popup.js:30` only if `filenameEdited` is false. Leave an edited element untouched, including a temporarily empty Name, so reconciliation does not reset its caret or interrupt an active slider drag.
- Retain the existing `optsSaved` branch, change listeners, save timing, and calls to `toggleQuality()` and `toggleRec()`. Untouched fields must still receive the authoritative stored settings. Flags need no reset during this popup's lifetime: its only apply calls are initial paint and startup reconciliation.

### `tests/defaults.test.js`

Add focused cases after the startup-edit tests at `tests/defaults.test.js:227`, using the existing mock DOM and `bootPopup()`/`settle()` helpers:

- Name receives `input` without `change` before loading completes: preserve its exact value, including a separate empty-string case. Confirm untouched Quality, format, and checkboxes reconcile from storage.
- Quality receives `input` without `change`: preserve its value and matching percentage label. Confirm untouched Name reconciles from storage.
- Both controls receive input: preserve both edits and the Quality label.
- In those cases, assert input and reconciliation do not save the unfinished edits or alter the cache. Then fire the existing change listener and verify it persists the retained edit together with the reconciled untouched settings.

Use stale or missing cache values that differ from storage so the tests detect accidentally skipping reconciliation of the entire form. Continue running the existing no-edit, completed-change, and recording-state tests.

## Implementation and verification

1. Add the input-before-change regression cases using existing test helpers → verify: run `node --test tests/defaults.test.js` against the unchanged implementation and confirm failures specifically demonstrate the edits being overwritten (invoke registered input listeners when present so a missing Name listener does not merely cause a test harness error).
2. Add the two flags and conditional assignments in `popup.js` → verify: the focused tests pass, untouched controls still reconcile, the Quality label agrees with its value, and no storage write occurs until change/save.
3. Run `npm test` and `git diff --check` → verify: the complete suite passes, including KAN-323's completed-change and recording controls coverage, and there are no whitespace errors.
4. Check the real popup in an isolated Chrome profile, using temporary test instrumentation to hold its startup tab query until explicitly released → verify: type in Name while it remains focused, release the query, and confirm the value and caret survive; separately hold the Quality slider mid-drag across query completion and confirm its value and label survive. Blur Name/release the slider and verify the final values save. Also verify a popup with no edits still loads stored values. Keep instrumentation outside the tracked extension source.

## Scope and decisions

Preserve edits only in the two controls this ticket identifies. Use input events to detect editing, without saving every keystroke or blocking all form reconciliation. The separate early-save issue in KAN-332 remains outside this change. No background, markup, capture, or recording changes are required.

## Open questions

None. The ticket and comment establish the required behavior; preserving the edited controls while reconciling untouched controls fits the existing startup and save paths.

## Planning validation

Read the ticket, its comment, affected popup code, and existing test helpers and cases. No implementation edits or tests were run during planning. The checks above are execution steps, not reported results.
