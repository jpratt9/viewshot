# KAN-371: A Stop that arrives while a GIF start is waiting for its video throws, and the GIF recording runs on

Ticket: https://prattsolutions.atlassian.net/browse/KAN-371 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-364, is Done. It blocks KAN-369, whose fix depends on `saving` coming back to 0.

This is the open question KAN-364's plan left behind (`docs/KAN-364-plan.md`, "Open questions"), filed as its own ticket.

## What the repo does now

Line numbers are from `b9dda90`, with a clean working tree. The ticket's are lower: they were taken from the KAN-364 change before it was committed.

- **A start in the offscreen document** (`offscreen.js:36-139`):
  - refuses a start while it has a `rec` (`:39`), with only a warning;
  - gives each start its own `{ stopped: false }` and points `lastStart` at it (`:52-53`), so a Stop can reach a start still waiting on `getUserMedia` (KAN-364);
  - checks `start.stopped` once `getUserMedia` answers, stopping the tracks and returning without a `rec` (`:68`);
  - sets `rec` (`:69`) and listens for the track ending (`:73-75`);
  - **for GIF, then waits twice more** — the video's metadata (`:81`) and `play()` (`:82`) — before the encoder (`:93`) and the frame timer (`:98-116`, parked on `rec.timer` at `:117`) exist;
  - for WebM and MP4, builds the recorder and starts it with no further await (`:123-136`), so a Stop can never find one of those `rec`s without a `recorder`.
- **A stop in the offscreen document** (`offscreen.js:141-172`):
  - with no `rec`, marks `lastStart` stopped and returns (`:143`);
  - otherwise increments `saving` (`:147`), and for a GIF clears the timer, subscribes to `finished`, renders, stops the tracks and nulls `rec` (`:149-156`).
- **The gap the ticket describes.** A `rec-stop-offscreen` inside a GIF start's two waits finds `rec` set, so it takes the GIF branch and throws at `rec.gif.on` (`:151`), because `rec.gif` isn't there yet:
  - `saving` is left at 1, so the document answers `offscreen-busy` with `true` for good (`:10`) and `closeOffscreen` never closes it (`background.js:390`, `:400`);
  - `rec` stays set and the capture stream keeps running;
  - the start carries on and starts the frame timer, with nothing that can stop it: the worker has removed `rec` and ignores any later `rec-stop` (`background.js:547`), the popup has disabled Stop (`popup.js:193`), and the document refuses the next start (`offscreen.js:39`);
  - at the frame cap the document sends `rec-cap-hit` (`:104-112`); the worker finds no `rec` (`background.js:547`) but still flashes `MAX` (`background.js:23`).
- **`teardown()`** (`offscreen.js:195-200`) already does exactly the cleanup this case needs: clear `rec.timer` if there is one, stop the stream's tracks, null `rec`. `onRecError` uses it (`:202-206`).
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 220 tests.
  - `loadOffscreen` (`:479-523`) runs `offscreen.js` with fakes; its `getUserMedia` answers at once (`:503`).
  - Its `document.createElement` ignores the tag and returns one bare object (`:508`), so a GIF start hangs on `video.onloadedmetadata` forever and no test drives the GIF path through `startRecording`. The one GIF stop test hand-builds a `rec` that already has a `gif` (`:1187-1201`).
  - `busy` (`:1185`) asks the document the worker's `offscreen-busy` question.
- **Not reproduced in Chrome.** As the ticket says, it was found by reading the code and seen with fakes in Node.

## Change

Two files change: `offscreen.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`offscreen.js`**
   - **`startRecording`** checks `start.stopped` once more after the GIF's two waits (`:82`), and hands the cleanup to `teardown()`.
   - **`stopRecording`** returns a GIF `rec` that has no encoder to that check, the same way it already does when there is no `rec` at all (`:143`), and leaves `saving` alone.

   ```diff
   @@ -80,6 +80,12 @@ async function startRecording(streamId, format, width, height) {
        video.muted = true;
        await new Promise((res) => { video.onloadedmetadata = res; });
        await video.play();
   +    // A Stop can land in those two waits as well. `rec` is set by now, so
   +    // stopRecording marks this start stopped and leaves the cleanup here:
   +    // nothing has been captured, and the worker has already removed `rec` and
   +    // cleared the badge, so a frame timer started now would tick on with
   +    // nothing that can stop it.
   +    if (start.stopped) { teardown(); console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
    
        const scale = Math.min(1, GIF_MAX_WIDTH / video.videoWidth);
        const w = Math.round(video.videoWidth * scale);
   @@ -142,6 +148,11 @@ function stopRecording(filename) {
      // No recording yet, but its start may still be waiting on getUserMedia.
      if (!rec) { if (lastStart) lastStart.stopped = true; return; }
      const { stream, format } = rec;
   +  // A GIF start sets `rec` before it waits for its video, so the encoder may
   +  // not be there yet: rec.gif.on threw, and the start recorded on. Nothing has
   +  // been captured, so hand this Stop to the start the same way, and leave
   +  // `saving` alone: no file is on its way.
   +  if (format === 'gif' && !rec.gif) { if (lastStart) lastStart.stopped = true; return; }
      // Saved only later: a GIF is encoded first, a video waits for its final
      // flush, and download() still needs the file's URL for a minute after that.
      saving++;
   ```

2. **`tests/capture-errors.test.js`**
   - **`loadOffscreen`** gets a `<video>` and a `<canvas>` a GIF start can actually get through, and hands the test the videos it created. Without this the GIF path can't be driven through `startRecording` at all.
   - **One new test** at the end of the file: a GIF start stopped while it waits for its video. It counts track stops with its own `getUserMedia`, the way the KAN-364 test does (`:1223-1245`).

   ```diff
   @@ -479,6 +479,7 @@ function loadOffscreen() {
    function loadOffscreen() {
      const recorders = [];
      const downloads = [];
   +  const videos = []; // the <video> a GIF start waits on
      class FakeRecorder {
   @@ -505,7 +506,14 @@ function loadOffscreen() {
        document: {
   -      createElement: () => ({ style: {}, click() {}, remove() {}, appendChild() {} }),
   +      createElement: (tag) => {
   +        const el = { style: {}, click() {}, remove() {}, appendChild() {} };
   +        // A GIF start waits for this video's metadata and play() before it
   +        // has an encoder; the test releases both.
   +        if (tag === 'video') { Object.assign(el, { play: async () => {}, videoWidth: 100, videoHeight: 100 }); videos.push(el); }
   +        if (tag === 'canvas') el.getContext = () => ({ drawImage() {} }); // gif.js draws each frame through it
   +        return el;
   +      },
          body: { appendChild() {} },
        },
   @@ -516,7 +524,7 @@ function loadOffscreen() {
      return {
   -    ctx: context, recorders, downloads, sent, endTrack: () => trackListeners.ended(),
   +    ctx: context, recorders, downloads, videos, sent, endTrack: () => trackListeners.ended(),
        message: (msg, respond = () => {}) => onMessage(msg, {}, respond),
   @@ -1343,4 +1351,36 @@ test('a start waits for the blip's glow to finish', async () => {
    });
   +
   +// --- a Stop while a GIF start is waiting for its video ----------------------
   +// A GIF start sets `rec` when getUserMedia answers, then waits for its video's
   +// metadata and play(). A Stop in that window found `rec` set and threw at
   +// rec.gif.on, leaving `rec` set, the stream running, `saving` stuck above zero
   +// and the frame timer going.
   +
   +test('a GIF start stopped while it waits for its video records nothing, and the next start goes ahead', async () => {
   +  const o = loadOffscreen();
   +  const { mediaDevices } = o.ctx.navigator;
   +  const getUserMedia = mediaDevices.getUserMedia; // the shared track, whose stop() is a no-op
   +  let stoppedTracks = 0;
   +  const track = { stop() { stoppedTracks++; }, addEventListener() {} };
   +  mediaDevices.getUserMedia = async () => ({ getVideoTracks: () => [track], getTracks: () => [track] });
   +  const start = o.ctx.startRecording('sid', 'gif', 100, 100);
   +  await settle(); // getUserMedia answers, so the start has a `rec` and is waiting on the video
   +  assert.doesNotThrow(() => o.ctx.stopRecording('out.gif'), 'the stop threw on a rec with no encoder');
   +  o.videos[0].onloadedmetadata(); // the video the start is waiting on
   +  await start;
   +  assert.strictEqual(vm.runInContext('rec', o.ctx), null, 'the stopped start went on to record');
   +  assert.strictEqual(stoppedTracks, 1, 'the stopped start left the tab being captured');
   +  assert.strictEqual(busy(o), false, 'the document stayed busy after a start that saved nothing');
   +  assert.deepStrictEqual(o.downloads, [], 'the stopped start saved a file');
   +  mediaDevices.getUserMedia = getUserMedia;
   +  await o.ctx.startRecording('sid2', 'webm', 100, 100);
   +  assert.strictEqual(o.recorders.length, 1, 'the next start was refused');
   +  o.recorders[0].flush({ size: 10 });
   +  o.ctx.stopRecording('out2.webm');
   +  o.recorders[0].finish();
   +  await settle();
   +  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out2.webm'], 'the next recording was never saved');
    });
   ```

Choices:

- **The stopped start records and saves nothing,** and the worker isn't told anything more. That's what a start stopped during `getUserMedia` already does (`offscreen.js:68`), and what the worker does with a Stop that lands before its last `rec` read (`background.js:478`). The warning uses the same words. There are no frames yet, so there is nothing a file could hold.
- **`stopRecording` leaves `saving` alone** in this case, instead of incrementing and decrementing it. Nothing is on its way to `download`, which is the only place `saving` comes back down (`offscreen.js:189`).
- **The cleanup happens in the start, not in the stop.** The start owns `rec` until it either has a recorder or returns, and it is the one that knows when its waits are over. A stop that cleaned up itself would race the start into `new GIF(...)` and `setInterval`.
- **`teardown()` is reused** rather than repeating its three lines. It is already the "release everything this document holds" path, it no-ops when there is no `rec`, and at this point there is no timer for it to clear.
- **The guard is scoped to GIF** (`format === 'gif' && !rec.gif`). Only the GIF path awaits after it sets `rec`; the WebM and MP4 path builds and starts its recorder synchronously (`offscreen.js:123-136`). A wider guard would be covering a case that doesn't exist.
- **One check covers both waits.** The metadata wait and `play()` (`:81-82`) are back to back with nothing between them, so a single check after `play()` catches a Stop from either.
- **Only the offscreen document changes.** The worker, popup, README, manifest and version stay as they are.

Checked while planning, on a copy of the repo outside this folder (from `git archive HEAD`), with Node 24.9.0:

- **As it is now:** `npm test` passes 220 tests.
- **Test change only:** 221 tests run. 220 pass, and the new test fails with "Got unwanted exception: the stop threw on a rec with no encoder" — the ticket's `Cannot read properties of undefined (reading 'on')`.
- **Both changes:** all 221 tests pass.
- **Both changes, with one piece left out** (each time, only the new test fails):

  | Piece left out | The new test fails with |
  |---|---|
  | The `start.stopped` check after the GIF's waits | "the stopped start went on to record" |
  | The no-encoder guard in `stopRecording` | "the stop threw on a rec with no encoder" |
  | `teardown()`, nulling `rec` without stopping the tracks | "the stopped start left the tab being captured" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 221 tests. 220 pass, and the new test fails with "the stop threw on a rec with no encoder". No other test fails.
2. Make the `offscreen.js` change above.
   → verify: `npm test` passes all 221 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA).
   - **Setup:** the headless setup from step 3 of `docs/KAN-364-plan.md`:
     - `Extensions.loadUnpacked`;
     - popups opened with `Extensions.triggerAction`;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - a trace of the badge and `rec` kept in the worker;
     - Format set to GIF, and Name set to `{title}-{time}`.
   - **Holding the start in its video wait:**
     - Attach to the offscreen document's target (`offscreen.html`). It has to be open already; it stays open after a recording (KAN-369), so record once first.
     - In the document, wrap `HTMLMediaElement.prototype.play` so it keeps its promise pending until `self.__release()` is called. `startRecording` awaits it (`offscreen.js:82`) after the metadata wait, which puts the start inside the window this ticket is about.
     - Keep the original, to put it back later.

   → verify each case:
   - **A normal Record press, before wrapping:** Stop is enabled within about a second, and Stop saves `PageA-….gif`.
   - **The ticket's case:**
     1. With the wrapper in place, press Record on PageA. Wait for the worker to log `rec-start-offscreen sent`.
     2. Press Stop. The trace shows `rec` removed and the badge cleared, and the document logs nothing thrown.
     3. Call `__release()` in the document.
     4. The document logs "stopped before the recorder started; not starting it".
     5. Its `rec` is `null`, `saving` is 0, and the captured track's `readyState` is `'ended'`.
     6. No file is saved, and no `!` or `MAX` badge appears.
     7. A clipboard capture (Copy to clipboard on, Visible) closes the offscreen document, which means `offscreen-busy` answered `false`.
   - **The same case on the code as it is now,** for comparison: the Stop throws `Cannot read properties of undefined (reading 'on')`, the document's `rec` is still set with `frames` climbing, `saving` is 1, and the next Record press is refused.
   - **Then with the original `play` put back:**
     1. Record on PageA shows REC and enables Stop.
     2. Stop saves one `PageA-….gif`.
     3. `ffprobe` reads it as a GIF with frames in it.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Checked in Chrome (step 3)

Done with the setup above, in Chrome 152.0.7977.83, the repo loaded unpacked, PageA served over http, Format GIF and Name `{title}-{time}`. `HTMLMediaElement.prototype.play` was wrapped in the offscreen document to hold the start in its second wait. The same run was made against a pristine `b9dda90` copy for comparison.

**The ticket's case reproduces in Chrome** — the ticket had it only from reading the code and from fakes in Node.

| | `b9dda90` | with the change |
|---|---|---|
| The Stop | `Uncaught TypeError: Cannot read properties of undefined (reading 'on')`, logged by the worker | nothing thrown |
| The document's `rec` after the start was released | still set, `gif` built, `frames` climbing 7 → 600 (the cap) | `null` |
| The captured track | `live` | `ended` |
| `saving` | 2, and stuck at 1 once the first download's minute was up | 1 throughout (that first download), back to 0 with it |
| The frame cap | `rec-cap-hit` reached the worker, which logged "stop with no active recording" | never reached |
| A later clipboard copy | left the document open | closed it |
| The start's own log | nothing | "stopped before the recorder started; not starting it" |

In both runs the Stop removed `rec` and cleared the badge, no file was saved for the stopped start, and only `REC` and an empty badge were ever set — no `!`.

With the original `play` put back, Record showed REC and enabled Stop, and Stop saved one `PageA-151418.gif`; `ffprobe` read it as `gif, 720x447, 7 frames`.

## Noticed while planning, not changed

- **A GIF start whose video never loads keeps `rec` forever.** If the metadata or `play()` wait never answers, `rec` stays set with no encoder, the document refuses every later start (`offscreen.js:39`) and the worker never closes it (`background.js:400`). Neither wait has a deadline. This change ends that state for a Stop, not for a video that goes quiet; the ticket doesn't ask for a deadline.
- **`lastStart` keeps pointing at a start that has already finished.** A later Stop with no `rec` sets `stopped` on a dead object (`offscreen.js:143`). Harmless, and it predates this change (KAN-364).

## Open questions

None. The ticket names the window, what goes wrong in it, and each thing left behind; the fix shape follows KAN-364's, which is already in the repo.
