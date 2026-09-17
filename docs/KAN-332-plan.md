# KAN-332: Changing a setting before the popup has loaded can reset the other saved settings to defaults

Ticket: https://prattsolutions.atlassian.net/browse/KAN-332

## Scope and evidence

Read the ticket and its one comment. It is To Do with labels `bug` and `viewshot`. The comment confirms KAN-323 shipped and this remaining settings-loss case belongs to KAN-332.

Current code still has the bug: `paintFromCache()` (`popup.js:47`) displays defaults when the mirror is absent, change listeners (`popup.js:186`) call `save()` immediately, and `save()` (`popup.js:84`) replaces the whole stored options object. `load()` (`popup.js:53`) waits for both storage and the tab query; its `optsSaved` branch prevents reconciliation after that premature write. The existing filename/quality input flags protect unfinished edits but do not protect untouched stored values.

## Proposed change

Keep the form editable during startup. Track which controls were actually edited, reconcile untouched controls from Chrome storage, and defer saves until that reconciliation completes. Reuse `load()`, `apply()`, `read()`, `save()`, and the current test harnesses. No new module or dependency is needed.

### Files to change

- `popup.js:6`: replace the all-or-nothing `optsSaved` flag and the two input flags with a small set of edited setting IDs used during startup, plus a readiness flag. This is local popup state only.
- `popup.js:28`: make `apply()` preserve the edited controls individually, including format and both checkboxes. Preserve the current quality label updates and raw filename input, including an empty name. Continue applying authoritative values to untouched controls.
- `popup.js:53`: always reconcile settings after the existing single `get(['opts', 'rec'])` and tab query. Preserve the independent `recChanged` behavior. Mark startup ready only after reconciliation, then update mode-button state.
- `popup.js:84` and `popup.js:195`: retain the promise from the one startup `load()` call. If startup is pending, `save()` waits for it before calling `read()` or writing either storage location. Once ready, keep the current immediate save/mirror behavior. A failed initialization must not fall back to saving default-filled controls; report it through the existing error display and leave capture unavailable.
- `popup.js:186`: each change listener marks its own setting as edited synchronously before invoking `save()`. Filename and quality input listeners mark their controls without initiating a save, as today. Return the save promise from change callbacks so tests can await completion. Do not infer edits by comparing values against defaults: explicitly selecting a default is still an edit.
- `popup.js:97` and `popup.js:106`: keep the three capture/record mode buttons disabled until startup is ready, and guard their handlers too. These handlers also save the whole form and currently snapshot options before saving (`popup.js:113`); preventing a startup click avoids dispatching cached/default options. Preserve all existing format and recording restrictions when enabling buttons. Do not insert an await before `getMediaStreamId()` in an enabled recording click, so the existing user-gesture flow remains intact. Stop continues to follow recording state independently.
- `tests/defaults.test.js:39` and `tests/defaults.test.js:222`: extend the existing popup harness only as needed to hold storage and tab-query promises independently and observe writes. Add startup preservation cases alongside the existing KAN-323 and unfinished-input tests.
- `tests/capture-errors.test.js:237` and `tests/capture-errors.test.js:844`: extend the existing popup harness for delayed startup and add checks for mode availability and dispatched options. Keep the recording-state race tests.

## Implementation and verification steps

1. Add a regression using the ticket's saved PNG settings, no localStorage mirror, and a delayed tab query. Change Format to WebP before startup finishes. Assert there are no premature writes, then release startup and check the form, Chrome storage, and mirror retain quality `0.5`, name `{title}-custom`, and `hideScrollbar: false`, with only format changed. → verify: the preservation assertion fails against the current implementation.
2. Implement per-control startup edit tracking, reconciliation, and deferred saving in the existing popup functions. Coalesce naturally by reading the reconciled current form when pending saves resume; do not replay whole stale form snapshots. Preserve default merging and filename migration. → verify: the regression passes; repeat with storage delayed, a stale cache, multiple early changes, and each of the five settings changed individually. All untouched stored values must survive, and a deliberately selected default value must persist.
3. Protect mode-button save paths until startup finishes and handle initialization rejection without saving. → verify: early screenshot/record clicks issue no storage writes, capture messages, or stream-ID requests; buttons become usable under their existing restrictions after reconciliation; a subsequent capture receives the reconciled options. A rejected initialization displays an error and leaves saved options unchanged.
4. Exercise existing editing and recording behavior. Include an unfinished filename or quality edit during reconciliation without a change event; no save should occur until a change or explicit capture requests it. Include several early change events and a further edit after startup so no deferred write restores an older value. → verify: `node --test tests/defaults.test.js tests/capture-errors.test.js` passes, including existing first-paint, single-storage-read, filename migration, KAN-323, unfinished-input, and recording-state race cases.
5. Run the repository suite and a browser reproduction with the popup tab query delayed by three seconds in a temporary extension copy. Seed the ticket's saved options and clear only the popup mirror; switch Format during the delay, then inspect storage and reopen the popup. → verify: `npm test` passes; the reopened popup retains every untouched saved setting and the new format. Capture/record buttons are unavailable only during startup, and a normal recording click still starts successfully.

## Open questions

None that block this plan. The ticket specifies preservation of saved settings; retaining early editing also preserves the behavior already covered by KAN-323 and the unfinished-input tests.

## Planning status

The plan was approved through `/execute docs/KAN-332-plan.md` and implemented.

- Added per-control startup edit tracking, deferred saves, capture readiness checks, and initialization-error handling in `popup.js`.
- Added regression coverage in `tests/defaults.test.js` and `tests/capture-errors.test.js`. Updated existing region tests in `tests/region-cancel.test.js` and `tests/region-dispatch.test.js` to wait for startup before clicking; their existing capture/acknowledgement assertions remain intact.
- The new preservation tests failed against the original code. After implementation, `npm test` passed all 195 tests; `git diff --check` passed.
- In isolated headless Chrome 151.0.7922.34, a temporary extension copy delayed the tab query by three seconds. With the ticket's saved settings and an empty mirror, an early WebP selection left storage unchanged during loading, then persisted only the intended change. The mirror and reopened popup both retained all settings. Capture buttons were disabled during startup.
- Browser recording verification remains incomplete: after startup enabled Record, the headless invocation reached the existing tab-capture failure path and displayed “Can’t record this tab.” No recording was established in that harness. Unit tests verify the stream-ID request occurs synchronously before the first await, that recording is unavailable during startup, and that reconciled options are dispatched afterward. No unrelated recording changes were made.
- Browser harness: `/tmp/viewshot-332-browser.cjs`; suite output: `/tmp/viewshot-332-tests.log`. No commit, push, or Jira transition was performed.
