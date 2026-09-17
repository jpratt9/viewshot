# KAN-219: Keyboard shortcut to start and stop recording

Ticket: https://prattsolutions.atlassian.net/browse/KAN-219

## Scope and current behavior

Read the ticket and its comments (none). Add one command that starts recording in the selected recording format, or stops the existing recording. This is a plan only; implementation awaits approval.

`manifest.json:14` declares three screenshot commands. `background.js:38` dispatches only those commands. The popup obtains a stream ID at `popup.js:122`, then sends `rec-start`. The worker serializes popup starts through `recStartGate` at `background.js:12`, calls `startRecording` at `background.js:560`, and stops through `stopRecording` at `background.js:675`. `getRec` at `background.js:58` checks persisted recording state against the offscreen document. Reuse these paths.

Chrome documents service-worker stream IDs consumable by an offscreen document from Chrome 116 onward: [screen capture guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture). Keyboard commands grant activeTab access: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab). At most four suggested shortcuts are allowed: [Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands). These establish the intended API path; a real keyboard invocation must still verify it during implementation, including after a worker restart.

## Files to change

- `manifest.json:14`: add `toggle-recording`, with proposed default `Alt+Shift+S` and description “Start or stop recording.” This uses the fourth suggested shortcut; no new permissions.
- `background.js:38`: add a recording-command branch before the screenshot dispatch. Check actual recording state first; if running, call `stopRecording` regardless of selected format or currently active tab. Otherwise read `getOpts`, obtain a stream ID for the command's tab using `chrome.tabCapture.getMediaStreamId({ targetTabId })`, and reuse `startRecording`.
- `background.js:12` and `background.js:558`: integrate command starts with the existing start gate so popup/keyboard starts cannot overlap. Keep the stream-ID request on the command event's user-invoked path, before slow recording setup. Recheck recording state when a start reaches the gate. Preserve Stop during startup; do not queue Stop behind the whole startup animation. Handle command errors without clearing another recording's state. Update the popup-only stream-ID comment at `background.js:565`.
- `tests/shortcut-format.test.js:1`: extend the existing VM command-test pattern with recording command cases and Chrome API mocks. Add focused manifest coverage in `tests/manifest.test.js:1` for the new command and suggested-key limit.
- `README.md:12`: document the shortcut and the agreed behavior when an image format is selected.

No recorder or popup implementation changes are expected; `offscreen.js:51` already accepts stream IDs, and the popup already follows recording state in storage.

## Implementation steps and verification

1. Resolve the format questions below, then register the fourth command. → verify: manifest parses, has at most four suggested shortcuts, and Chrome shows the command in `chrome://extensions/shortcuts`.
2. Implement the command branch using the existing state, options, start gate, and stop functions. Retain the command's tab ID across awaits. Catch rejected stream requests and report them with the existing error badge; do not leave an unhandled rejection or false REC state. → verify: mocked commands start with the selected format and target tab, stop without requesting a new stream, recover from stale stored state, and follow the agreed image-format policy.
3. Cover interleavings that could lose recordings. A repeated command after recording state is established must stop it, including during startup. A shortcut and popup start arriving together must not create two recorders; an early repeated command before state is established must not leave an unintended recording queued. → verify: controlled promises in the VM tests exercise these cases, plus stream acquisition failure and subsequent successful use.
4. Verify in Chrome 116+ with the unpacked extension and actual keyboard input, not a console invocation of the handler. Select WebM, close the popup, start and stop with the shortcut, and inspect the playable saved file; repeat for GIF and MP4 if included. Repeat after the worker has stopped, stop from another active tab, and mix popup and shortcut controls. → verify: correct format, one saved recording, REC cleared on stop, and no user-gesture or stream-consumption errors. Mocks cannot establish Chrome gesture behavior.
5. Update the README and run `npm test`. → verify: recording-command tests and existing screenshot-shortcut/lifecycle tests pass; all three screenshot shortcuts retain their current behavior. Record any pre-existing failures separately without expanding this ticket.

## Open questions

- When PNG/JPG/WebP is selected and nothing is recording, should the shortcut refuse to start and flash the existing error badge, or default to WebM? The repo stores a single `opts.format`, not a separate last-used recording format. This affects the command branch, tests, and documentation; do not silently choose a fallback or add a new preference.
- Should the command support selected MP4 as well? The ticket names WebM/GIF, but `popup.js:3` and `popup.html:24` now include MP4. Supporting it can reuse the existing recorder; the decision changes the accepted-format check and verification cases.

## Implementation and verification

Implemented after `/execute`. Proceeded with the stated assumptions: require a selected recording format (image formats flash `!` without changing settings), and include the existing MP4 format alongside WebM/GIF. Added `Alt+Shift+S`, retained popup start queue behavior, and prevented repeated commands or a popup start from queueing behind a command start. Stop can still interrupt startup once recording state exists.

- Baseline: 264 tests passed. Shipping verification: all 276 tests passed, including command setup failure/retry and preservation of a live recording when state lookup fails; `node --check background.js` and `git diff --check` passed.
- Chrome 153.0.8010.48, isolated profile, unpacked repo: registered `⌥⇧S`; CDP keyboard events dispatched to the page triggered the real command listener (no direct handler invocation).
- Keyboard start/stop saved WebM (VP9, 1278×712), MP4 (H.264, 1278×712), and GIF (720×401). ffprobe identified all formats and ffmpeg decoded all three without errors.
- Explicitly stopped the service worker, confirmed its target disappeared, then started recording with the shortcut. Stopping from another tab cleared state and saved the WebM.
- Popup start → keyboard stop and keyboard start → popup stop both saved WebM files and cleared recording state.
- Browser scripts/logs are temporary verification artifacts under `/tmp/vs219-*`. Native macOS event posting was unavailable (`CGPreflightPostEventAccess` returned false); browser keyboard events were used instead.
