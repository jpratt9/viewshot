# KAN-364: A Stop that arrives while the offscreen document is still starting the recorder is dropped, and the recording runs on

Ticket: https://prattsolutions.atlassian.net/browse/KAN-364 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-211, is Done.

## What the repo does now

Line numbers are from `e9c78e2`, with a clean working tree. They match the ticket's, which were taken from the KAN-350 and KAN-211 changes before they were committed.

- **The worker's side of a start** (`background.js:446-484`):
  - Starts run one at a time, through `recStartGate` (`:12-21`, declared at `:444`).
  - A start writes `rec` (`:458`), then waits on the page twice: the blip (`:466`) and the viewport read (`:474`).
  - It reads `rec` one last time (`:478`), then sends `rec-start-offscreen` (`:479-482`). That read only catches a Stop that lands before it.
- **The worker's Stop** (`background.js:541-550`) removes `rec`, clears the badge and sends `rec-stop-offscreen` (`:547-549`). A later `rec-stop` finds no `rec` and returns (`:544`).
- **The offscreen document's start** (`offscreen.js:35-123`):
  - refuses a start while it has a `rec` (`:38`), with only a warning;
  - waits on `getUserMedia` (`:51`), and sets `rec` only once it answers (`:53`);
  - for WebM and MP4, then starts the recorder without waiting again (`:107-121`);
  - for GIF, waits twice more, for the video's metadata and `play()` (`:65-66`), before the encoder and frame timer exist (`:77-101`).
- **The offscreen document's stop** (`offscreen.js:125-155`) returns when there is no `rec` (`:126`).
  - So a `rec-stop-offscreen` that arrives while `getUserMedia` is pending does nothing, and the recorder then starts.
  - Nothing can stop that recorder:
    - the popup disables Stop once `rec` is gone (`popup.js:190-195`);
    - the worker ignores any later `rec-stop` (`background.js:544`);
    - the document refuses later starts (`offscreen.js:38`).
- **The worker already handles the same Stop one step earlier** (KAN-350).
  - A start that finds `rec` gone at `background.js:478` logs "stopped before the recorder started; not starting it" and returns, so nothing is recorded.
  - The test "a start stopped while it waits on the page records nothing, and the next start goes ahead" (`tests/capture-errors.test.js:1151`) covers it.
- **Tests** (`tests/capture-errors.test.js`):
  - `npm test` passes 213 tests.
  - `loadOffscreen` (`:479-523`) runs `offscreen.js` with fakes. Its `getUserMedia` answers at once (`:503`).
  - The offscreen tests call `startRecording` and `stopRecording` straight off the context, standing in for the worker's messages (for example `:567`).
  - No test sends a Stop while `getUserMedia` is pending.
- **Not reproduced in Chrome.** As the ticket says, it was found by reading the code.

## Change

Two files change: `offscreen.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`offscreen.js`**
   - **New `lastStart`**, declared after `saving` (`:33`). It holds the last start's `{ stopped }` object.
   - **`startRecording`** gives each start its own `{ stopped: false }` and points `lastStart` at it, just before `getUserMedia` (`:51`). If the start was stopped by the time `getUserMedia` answers, it:
     - stops the stream's tracks;
     - logs a warning;
     - returns without setting `rec` (`:53`) or starting a recorder.
   - **`stopRecording`**, when it finds no `rec` (`:126`), marks `lastStart` stopped before it returns.

   ```diff
   @@ -31,6 +31,7 @@ const GIF_MAX_WIDTH = 720;
    const GIF_MAX_FRAMES = 600; // ~60s cap so addFrame copies don't exhaust memory
    let rec = null; // { stream, format, recorder?, chunks?, gif?, timer?, frames? }
    let saving = 0; // recordings stopped but not saved yet (see stopRecording)
   +let lastStart = null; // { stopped }, so a Stop can reach a start still waiting on getUserMedia
    
    async function startRecording(streamId, format, width, height) {
      // One recording at a time: replacing `rec` would leave the one already
   @@ -48,8 +49,15 @@ async function startRecording(streamId, format, width, height) {
        Object.assign(mandatory, { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height });
      }
      log('requesting getUserMedia for streamId', streamId, 'mandatory=', mandatory);
   +  const start = { stopped: false };
   +  lastStart = start;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory } });
      log('got MediaStream, video tracks:', stream.getVideoTracks().length);
   +  // The worker reads `rec` for the last time before it sends rec-start-offscreen,
   +  // so its Stop can still arrive while getUserMedia is answering. The worker has
   +  // removed `rec` and cleared the badge by then, and ignores any later rec-stop:
   +  // a recorder started now would run on with nothing that can stop it.
   +  if (start.stopped) { stream.getTracks().forEach((t) => t.stop()); console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
      rec = { stream, format };
      // Chrome's own "Stop sharing" bar (and closing the captured tab) ends the
      // track without telling us. Route it through the normal stop path so the
   @@ -123,7 +131,8 @@ async function startRecording(streamId, format, width, height) {
    }
    
    function stopRecording(filename) {
   -  if (!rec) return;
   +  // No recording yet, but its start may still be waiting on getUserMedia.
   +  if (!rec) { if (lastStart) lastStart.stopped = true; return; }
      const { stream, format } = rec;
      // Saved only later: a GIF is encoded first, a video waits for its final
      // flush, and download() still needs the file's URL for a minute after that.
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end (after `:1215`) with one test, "a start stopped while it waits on getUserMedia records nothing, and the next start goes ahead":
   - `getUserMedia` holds its answer until the test releases it.
   - The test starts a WebM recording, stops it, then lets `getUserMedia` answer.
   - No recorder is started, and the stream's track is stopped.
   - A second start then records, and its Stop saves `out2.webm`.

   ```diff
   @@ -1213,3 +1213,33 @@ test('a WebM keeps its document busy from its stop until the download is done wi
      o.runTimers();
      assert.strictEqual(busy(o), false, 'the document stayed busy after its file was saved');
    });
   +
   +// --- a Stop while getUserMedia is still answering ---------------------------
   +// The worker reads `rec` for the last time before it sends rec-start-offscreen,
   +// so a Stop pressed after that could reach the offscreen document before its
   +// start had a `rec`. The document ignored that Stop, and the recorder then
   +// started with nothing that could stop it.
   +
   +test('a start stopped while it waits on getUserMedia records nothing, and the next start goes ahead', async () => {
   +  const o = loadOffscreen();
   +  const { mediaDevices } = o.ctx.navigator;
   +  const getUserMedia = mediaDevices.getUserMedia; // answers at once
   +  let answer;
   +  let stoppedTracks = 0;
   +  const track = { stop() { stoppedTracks++; }, addEventListener() {} };
   +  mediaDevices.getUserMedia = () => new Promise((res) => { answer = () => res({ getVideoTracks: () => [track], getTracks: () => [track] }); });
   +  const start = o.ctx.startRecording('sid', 'webm', 100, 100);
   +  o.ctx.stopRecording('out.webm'); // the worker's rec-stop-offscreen
   +  answer();
   +  await start;
   +  assert.strictEqual(o.recorders.length, 0, 'the stopped start went on to record');
   +  assert.strictEqual(stoppedTracks, 1, 'the stopped start left the tab being captured');
   +  mediaDevices.getUserMedia = getUserMedia;
   +  await o.ctx.startRecording('sid2', 'webm', 100, 100);
   +  assert.strictEqual(o.recorders.length, 1, 'the next start was refused');
   +  o.recorders[0].flush({ size: 10 });
   +  o.ctx.stopRecording('out2.webm');
   +  o.recorders[0].finish();
   +  await settle();
   +  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out2.webm'], 'the next recording was never saved');
   +});
   ```

Choices:

- **The stopped start records and saves nothing.**
  - That's what the worker already does with a Stop that lands before its last `rec` read (`background.js:475-478`). The warning uses the same words.
  - The worker has already removed `rec` and cleared the badge, so it isn't told anything more.
- **Each start gets its own object, not one shared boolean.** A second start could begin before the first start's `getUserMedia` answered. If every start reset a shared boolean, that second start would clear the first start's Stop, and the stopped first start would record.
- **The tracks are stopped right there,** as `stopRecording` does (`offscreen.js:138`, `:149`).
  - A capture stream keeps working until it is stopped, as `teardown`'s comment says (`:175-177`).
  - `teardown()` itself (`:178-183`) only releases what `rec` holds, and this start never set `rec`.
- **The check covers every format.** It comes before the GIF path splits from the WebM/MP4 path (`:61`), so one WebM test covers it.
- **Only the `getUserMedia` wait is covered,** as the ticket describes. A GIF start's later wait is an open question.
- **Only the offscreen document changes.** The worker, popup, README, manifest and version stay as they are.

Checked while planning, on a copy of the repo outside this folder (from `git archive HEAD`), with Node 24.9.0:

- **As it is now:** `npm test` passes 213 tests.
- **Test change only:** 214 tests run. 213 pass, and the new test fails with "the stopped start went on to record".
- **Both changes:** all 214 tests pass.
- **Both changes, with one piece left out** (each time, only the new test fails):

  | Piece left out | The new test fails with |
  |---|---|
  | The `start.stopped` check in `startRecording` | "the stopped start went on to record" |
  | Marking `lastStart` stopped in `stopRecording` | "the stopped start went on to record" |
  | Stopping the stream's tracks | "the stopped start left the tab being captured" |

- **A GIF start stopped during its video wait,** run with fakes in a throwaway Node script. The result is the same as it is now and with the change:
  - `stopRecording` throws "Cannot read properties of undefined (reading 'on')" and leaves `saving` at 1;
  - `rec` stays set, and the frame timer starts.

  See the open question.
- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 214 tests. 213 pass, and the new test fails with "the stopped start went on to record". No other test fails.
2. Make the `offscreen.js` change above.
   → verify: `npm test` passes all 214 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA).
   - **Setup:** the headless setup from step 3 of `docs/KAN-350-plan.md`:
     - `Extensions.loadUnpacked`;
     - popups opened with `Extensions.triggerAction`;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - a trace of the badge and `rec` kept in the worker;
     - Format set to WebM, and Name set to `{title}-{time}`.
   - **Holding back `getUserMedia`'s answer:**
     - Attach to the offscreen document's target (`offscreen.html`). The document has to be open already. It stays open after a recording (KAN-369), so record once first.
     - In the document, wrap `navigator.mediaDevices.getUserMedia`:
       - the wrapper calls the real one straight away, so the stream id is still used in time;
       - it keeps the stream in `self.__held`, and doesn't answer until `__release()` is called.
     - Keep the original, to put it back later.

   → verify each case:
   - **A normal Record press, before wrapping:** Stop is enabled within about a second. Stop saves `PageA-….webm` and clears the badge, and the offscreen document stays open.
   - **The ticket's case:**
     1. With the wrapper in place, press Record on PageA. Wait for the worker to log `rec-start-offscreen sent`.
     2. Press Stop. The trace shows `rec` removed and the badge cleared.
     3. Call `__release()` in the document.
     4. The document logs "stopped before the recorder started; not starting it".
     5. Its `rec` is `null`, and `__held.getVideoTracks()[0].readyState` is `'ended'`.
     6. No new file is saved.
   - **The same case with Format set to GIF:** the same result.
   - **The same case on the code as it is now,** for comparison: after `__release()`, the document's `rec.recorder.state` is `'recording'`, while the badge is empty and Stop is disabled.
   - **Then with the original `getUserMedia` put back:**
     1. Record on PageA shows REC and enables Stop.
     2. Stop saves one `PageA-….webm`.
     3. `ffprobe` reads it as VP9 video with frames in it.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **A stopped start whose `getUserMedia` fails still flashes `!`.**
  - The error goes to `onRecError` (`offscreen.js:185-189`), which sends `rec-failed`.
  - The worker's `recFailed` (`background.js:436-438`) then flashes `!` right after the user's own Stop.
  - This is from reading the code. The change leaves it as it is.

## Open questions

- **Should a GIF start's later wait be covered too?** The ticket describes the wait on `getUserMedia`, and this plan covers only that.
  - **The gap:** a GIF start waits again, for the video's metadata and `play()` (`offscreen.js:65-66`). By then it has set `rec` (`:53`), but its encoder and frame timer don't exist yet (`:77-101`).
  - **What a Stop in that wait does:**
    - It isn't dropped. It throws at `rec.gif.on` (`:134`) and leaves `saving` at 1.
    - The GIF recording starts anyway.
    - This was seen in the Node script above, not in Chrome.
  - **If it's in:**
    - `stopRecording` would also mark `lastStart` stopped for a GIF `rec` that has no `gif` yet.
    - `startRecording` would check `start.stopped` again after `video.play()`, and clear `rec` as well as stopping the tracks.
    - One more test would cover a GIF stopped during that wait. It would need a fake `<video>` that loads its metadata, which `loadOffscreen`'s doesn't.
