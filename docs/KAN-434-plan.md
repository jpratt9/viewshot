# KAN-434: A recorder that fails mid-recording leaves the recording marked as running

Ticket: https://prattsolutions.atlassian.net/browse/KAN-434

Read the ticket and its comments (none). The current code still lacks a MediaRecorder error listener.

## Files and scope

- `offscreen.js:162`: register `onerror` alongside the existing data and stop listeners, before calling `start(1000)`. Capture the recorder in a local variable and handle its error only while `rec?.recorder` is that recorder. Pass `event.error || event` to the existing `onRecError` function (`offscreen.js:242`). This reuses `teardown` (`offscreen.js:235`) to stop tracks and clear the offscreen recording, then sends `rec-failed`. The identity check prevents a late event from an old recorder from tearing down a newer recording.
- `tests/capture-errors.test.js:485`: extend the existing offscreen test harness only as needed to inject recorder errors and observe track stops. Add regressions for WebM and MP4, subsequent recording starts, and late events from an old recorder.
- Reuse unchanged: the worker's `rec-failed` dispatch (`background.js:27`) and `recFailed` (`background.js:548`), which removes stored `rec` and flashes `!`. Existing tests at `tests/capture-errors.test.js:1024` already check this worker path.

## Implementation and verification

1. Add a regression that starts a recording, makes the fake recorder inactive, and delivers an error followed by its final data and stop callbacks. Exercise both WebM and MP4. → verify: before the fix the failure is not reported; after the fix exactly one `rec-failed` is sent, the underlying error is logged, tracks stop, `offscreen-busy` becomes false, and no automatic download occurs.
2. Add the guarded recorder error listener, reusing `onRecError` without changing normal stop or save behavior. → verify: the regression passes and a new recording can start after the failure.
3. Cover an old recorder's error after normal Stop and after a replacement recording starts. → verify: it does not emit `rec-failed`, clear the replacement recording, or stop its tracks. Keep the existing final-flush and tab-close tests passing.
4. Run `node --test tests/capture-errors.test.js`, then `npm test`. → verify: recorder failures, worker cleanup, popup storage updates, and existing capture behavior all pass. These are simulated error events; do not claim reproduction of a real browser encoder failure.

## Open questions

None needed for this scope. The ticket explicitly requests the existing failure path, which discards the failed recording rather than recovering its partial chunks. Recovery and errors after a recording has already entered the normal save path are outside this ticket.

Plan only. Implementation awaits approval.
