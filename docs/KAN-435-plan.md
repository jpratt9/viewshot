# KAN-435: A leftover recording survives any read taken while a new offscreen document is still loading

Ticket: https://prattsolutions.atlassian.net/browse/KAN-435

Read the ticket and its comments (none). Status at planning: To Do; labels: bug, viewshot. Implementation and verification results are recorded below.

## Current behavior

- `background.js:59`: `getRec()` clears the stored recording and badge when no offscreen document exists. When a document exists but cannot answer `offscreen-id`, it deliberately preserves the recording (`background.js:70`).
- `background.js:467`: `ensureOffscreen()` creates a document without checking the leftover recording first. Once creation makes `hasDocument()` true, the readiness loop can run while identity requests still fail. Reads during that interval retain the old recording.
- `background.js:525`: clipboard copies take this path without first calling `getRec()`. Their eventual cleanup checks the recording, but that is too late for the loading window.
- `background.js:567`: recording starts await `ensureOffscreen()` before writing their new recording state at `background.js:575`.
- `popup.js:189`: the popup already follows removal of `rec` through its storage listener, so clearing storage updates Record and Stop without a popup change.

## Files to change

- `background.js:466`: keep the existing `offscreenCreating` promise as the gate for the complete initialization sequence: stale-state cleanup, document creation, and the existing readiness polling. Check for this pending promise before returning on `hasDocument()`, and check it again after the asynchronous existence lookup before claiming creation. Clear it in the owning operation's `finally`, including failures.
- `background.js:472`: inside that shared operation, call and await the existing `getRec()` before `createDocument()`. With no document yet, it removes a leftover key and clears the badge using the existing behavior. Finish that cleanup before creating the replacement, so the loading window starts with no stale recording. Do not interpret a failed identity request as evidence that a live recording is gone.
- `tests/offscreen-lifecycle.test.js:239`: extend the existing lifecycle tests with controlled creation/readiness promises and checks during the loading window. Reuse the existing mock and override its methods locally where possible.

Sharing the full initialization promise is needed because cleanup introduces awaits before creation. A second caller must neither create another document during cleanup nor start a recording in the replacement before the cleanup has finished. Keep the existing poll count, delay, error, and existing-document reuse behavior.

## Steps and verification

1. Add a regression that seeds recording A, removes its document, then starts `ensureOffscreen()` as a clipboard copy would. Hold the replacement's first ping pending and make identity requests reject. While initialization remains pending, inspect storage, the badge, and `getRec()`; also issue `rec-check` through the existing message harness. Release the ping and finish the operation. → verify: the current implementation fails because A survives during loading; the required result is an empty recording key, a cleared badge, and a completed `rec-check` with no stale state before readiness resolves. Parameterize the stale key with and without `docId`, since confirmed document absence invalidates both.

2. Update `ensureOffscreen()` using the existing `getRec()` cleanup and shared initialization promise described above. → verify: `node --test tests/offscreen-lifecycle.test.js` passes the loading-window regression, including an assertion that cleanup has finished when `createDocument()` is invoked. Existing tests still preserve a live recording whose document cannot answer its identity request.

3. Add focused concurrency and failure coverage. Start two callers while cleanup is paused and another after creation while readiness is paused; assert one creation and no caller completing before readiness. Cover a rejected creation and an exhausted readiness loop followed by a fresh successful attempt after the failed document is gone. Also retain the live-document and no-recording cases. → verify: all callers share initialization, the gate resets after failures, live state is preserved, and a subsequent new recording is not erased by a late initialization waiter.

4. Run the repository suite with `npm test`. → verify: the lifecycle changes also preserve recording startup, clipboard cleanup, and popup storage-update behavior covered by the existing tests. Investigate failures before changing unrelated expectations.

5. Verify the observable loading window in an unpacked Chrome extension using a disposable profile: start a recording, close its offscreen target while keeping the worker awake, then initiate replacement creation from the worker without opening the popup first. Temporarily defer the worker's readiness response in the test session so the window can be inspected, and make identity requests unavailable during it. → verify: while initialization is still pending, storage has no old `rec`, the badge is blank, and the popup shows Stop disabled. Release readiness and confirm a fresh recording can start and stop. Repeat with the original document alive to confirm a clipboard operation preserves its recording. This is controlled timing verification; do not report it as a natural reproduction of the ticket's unobserved race.

## Open questions

None that change the implementation scope. The ticket reports a code-derived race rather than a browser reproduction; the deterministic regression establishes that specific interval. No changes to offscreen identity, recording persistence, clipboard implementation, or popup source are required.

## Execution results

- Implemented cleanup before creation and shared initialization through readiness in `background.js`. Existing `getRec()` identity-failure behavior is unchanged.
- Both loading-window regressions failed on the original code (recordings with and without `docId`) and pass with the fix. Added concurrency and successful retry coverage for creation and readiness failures.
- `npm test`: 264 passed, zero failures. `git diff --check`: clean.
- Verified in headless Chrome 153.0.8010.48 with a disposable profile, the repo loaded unpacked, and a CDP session keeping the worker awake. Started a real recording, closed its offscreen target, then deferred replacement readiness and rejected identity messages in the worker test session.
- During that controlled loading window: storage was empty, the badge was blank, `getRec()` returned no recording, initialization was still pending, and the popup had Stop disabled and Record enabled.
- Restored normal messaging and released readiness. A fresh recording used a different document identity and saved `kan435-190921.webm` in `/tmp/kan435-downloads-yNplHe`. A clipboard operation during that recording preserved its identity and offscreen document.
- Browser driver: `/tmp/kan435-browser.js`. The timing was deliberately controlled; this does not claim a natural reproduction. No Jira status change, commit, or push performed.
