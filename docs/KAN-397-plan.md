# KAN-397: A GIF start whose video never loads keeps the document marked as recording for good

Ticket: https://prattsolutions.atlassian.net/browse/KAN-397 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-371, is Done.

## What the repo does now

Line numbers are from `0b3f058`, with a clean working tree. They match the ticket's.

- **The GIF start** (`offscreen.js:36-145`):
  - `rec` is set at `:69`, straight after getUserMedia answers and the `start.stopped` check at `:68`.
  - The GIF branch then creates a `<video>` on the capture stream (`:78-80`) and waits twice: for the metadata (`:81`) and for `play()` (`:82`). **Neither wait has a deadline.**
  - `:88` is KAN-371's check: a Stop that landed during those waits is handed its cleanup here, `teardown()` (`:206-211`).
  - The encoder is only built after that (`:90-99`), so until then `rec` is `{ stream, format }` with no `gif` in it.
- **What a video that never answers leaves behind** (all four of the ticket's bullets, confirmed by reading):
  - `startRecording` refuses every later start while `rec` is set (`:39`).
  - `offscreen-busy` answers `!!rec || saving > 0` (`:10`), so `closeOffscreen` returns early for good (`background.js:395`, `:403`).
  - The capture stream keeps running: nothing stops its tracks.
  - `stopRecording` (`:147`) can only mark the start stopped for a GIF `rec` with no encoder (`:155`), which is KAN-371's path — and that start is parked in a wait that never returns, so even that goes nowhere.
- **The failure path that already exists:** `startRecording` is called with `.catch(onRecError)` (`:15`). `onRecError` (`:213-217`) logs "recording failed", calls `teardown()` and sends `rec-failed`, which the worker turns into removing `rec` and flashing `!` (`background.js:439-441`).
- **Deadlines elsewhere:** the worker races every page call against `sleep(SCRIPT_TIMEOUT_MS)`, 2 s (`background.js:108-115`), and captures against `CAPTURE_TIMEOUT_MS` (`:65`, `:92-97`). `offscreen.js` has no deadline of its own: `grep -n "setTimeout\|Promise.race" offscreen.js` returns only the 60 s URL revoke at `:200`.
- **Tests** (`tests/capture-errors.test.js`): `npm test` passes 226.
  - `loadOffscreen` (`:479-533`) gives a fake `<video>` whose `onloadedmetadata` the test fires by hand (`:511-514`), and a `setTimeout` that **holds** every timer until the test calls `runTimers()` (`:528-529`).
  - `:1355-1380` covers a Stop landing in those waits (KAN-371). **Nothing covers a video that never answers at all.**
  - `busy(o)` (`:1192`) asks the document the `offscreen-busy` question directly.
- **How long the waits really take.** Measured while planning, in headless Chrome 152.0.7977.83 with a probe logging `Date.now()` around both waits: **2 ms** for a GIF start on an idle page, **80 ms** for one whose page had just held its main thread busy for 1.8 s. Both waits finish in the same millisecond as each other.

## Change

Two files change: `offscreen.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`offscreen.js`:** one deadline over both video waits. A start still live when it passes throws, so the existing `onRecError` path tears it down and reports it; a start the user has already stopped falls through to KAN-371's check, which is its cleanup.

   ```diff
   @@ -29,6 +29,11 @@
    const GIF_FPS = 10;
    const GIF_MAX_WIDTH = 720;
    const GIF_MAX_FRAMES = 600; // ~60s cap so addFrame copies don't exhaust memory
   +// A video fed by a live capture stream is ready in a few ms: 2 ms on an idle
   +// page, 80 ms right after a busy one. One that never answers used to hold this
   +// document for good, so the wait gives up after the same 2 s the worker allows
   +// its own page calls (SCRIPT_TIMEOUT_MS).
   +const VIDEO_TIMEOUT_MS = 2000;
    let rec = null; // { stream, format, recorder?, chunks?, gif?, timer?, frames? }
    let saving = 0; // recordings stopped but not saved yet (see stopRecording)
    let lastStart = null; // { stopped }, so a Stop can reach a start still waiting on getUserMedia
   @@ -78,8 +83,22 @@ async function startRecording(streamId, format, width, height) {
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
   -    await new Promise((res) => { video.onloadedmetadata = res; });
   -    await video.play();
   +    // One deadline covers both waits, since nothing sits between them. Without
   +    // it, a video that never answered left `rec` set with no encoder in it: the
   +    // document refused every later start, answered offscreen-busy with true so
   +    // the worker could never close it, and kept the capture stream running.
   +    try {
   +      await Promise.race([
   +        (async () => { await new Promise((res) => { video.onloadedmetadata = res; }); await video.play(); })(),
   +        new Promise((_, rej) => setTimeout(() => rej(new Error(`the video did not start within ${VIDEO_TIMEOUT_MS / 1000}s`)), VIDEO_TIMEOUT_MS)),
   +      ]);
   +    } catch (e) {
   +      // A start the user has already stopped has nothing to report: rec-failed
   +      // would flash ! right after their own Stop. The check below is its
   +      // cleanup either way.
   +      if (!start.stopped) throw e; // onRecError tears this start down and reports it
   +      console.warn('[ViewShot] the video never started for a start that was already stopped:', e);
   +    }
        // A Stop can land in those two waits as well. `rec` is set by now, so
        // stopRecording marks this start stopped and leaves the cleanup here:
        // nothing has been captured, and the worker has already removed `rec` and
   ```

2. **`tests/capture-errors.test.js`:** a new section at the end with two tests, both driving the document through `rec-start-offscreen` as the worker does, with the fake video's `onloadedmetadata` never fired and the held deadline released by `runTimers()`.
   - **"a GIF start whose video never loads gives up, reports it, and lets the next one run":** the document is busy while the start waits, and once the deadline passes it is not busy, `rec-failed` has gone out, and a following WebM start builds its recorder.
   - **"a GIF start stopped while its video hangs reports nothing":** the user's Stop lands first, then the deadline. The document ends up not busy, and nothing is sent — no `!` over the user's own Stop.

   ```diff
   @@ -1461,3 +1461,38 @@ test('a blip the page answers in time leaves the start nothing to hold for', asy
      assert.strictEqual(held, 0, 'the start was told to hold on for a glow that had already gone');
    });
   +
   +// --- a GIF start whose video never loads ------------------------------------
   +// A GIF start sets `rec` and then waits for its video's metadata and play().
   +// Neither wait had a deadline, so a video that never answered left `rec` set
   +// with no encoder in it: the document refused every later start, answered
   +// offscreen-busy with true so the worker could never close it, and kept the
   +// capture stream running.
   +
   +const GIF_START = { type: 'rec-start-offscreen', streamId: 'sid', format: 'gif', width: 100, height: 100 };
   +
   +test('a GIF start whose video never loads gives up, reports it, and lets the next one run', async () => {
   +  const o = loadOffscreen();
   +  o.message(GIF_START);
   +  await settle();
   +  assert.strictEqual(busy(o), true, 'the start never got as far as its video');
   +  o.runTimers(); // the video's deadline passes
   +  await settle();
   +  assert.strictEqual(busy(o), false, 'the document was left marked as recording with no encoder in it');
   +  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed'], 'the start that gave up was never reported');
   +  o.message({ ...GIF_START, format: 'webm' });
   +  await settle();
   +  assert.strictEqual(o.recorders.length, 1, 'the document refused the next start');
   +});
   +
   +test('a GIF start stopped while its video hangs reports nothing', async () => {
   +  const o = loadOffscreen();
   +  o.message(GIF_START);
   +  await settle();
   +  o.ctx.stopRecording('out.gif'); // the user's Stop, with no encoder to stop
   +  o.runTimers(); // the deadline passes after it
   +  await settle();
   +  assert.strictEqual(busy(o), false, 'the stopped start left the document marked as recording');
   +  assert.deepStrictEqual(o.sent, [], 'the stopped start flashed a failure over the user\'s own Stop');
   +});
   ```

Choices:

- **One deadline over both waits,** not one each. Nothing sits between them, which is the same reason KAN-371 put a single `start.stopped` check after both (`:88`), and the measurement above shows they finish together.
- **2 s, and a constant of its own.** The ticket names no number. Measured 2 ms idle and 80 ms after a busy page, so 2 s is ~25× the worst seen, and it is the figure the worker already uses for its own page calls (`SCRIPT_TIMEOUT_MS`). `VIDEO_TIMEOUT_MS` sits with the other GIF constants rather than being shared with the worker's: the two files have no imports between them (classic scripts, no modules), and `DEFAULTS` is already duplicated the same way.
- **A start still live throws, and the existing failure path does the rest.** `onRecError` (`:213`) already tears down and sends `rec-failed`. Tearing down quietly instead would leave the worker with `rec` in storage, the REC badge up and Stop enabled — the state the ticket's fourth bullet names. This is one line more than the ticket's "clean up like a stopped start does", and it is what ends that bullet.
- **A start the user already stopped reports nothing.** `83951e3` stopped `!` being flashed for a start that was already stopped, and KAN-398 did the same for `MAX`. The catch re-throws only when `start.stopped` is false, so a stopped start falls through to `:88` — which was already going to tear it down.
- **The timer is not cleared when the video wins.** `Promise.race` has handlers on both, so the late rejection is handled and never surfaces; `scriptWithTimeout` and `captureWithTimeout` leave theirs the same way.
- **Only the GIF path changes.** The WebM/MP4 branch builds and starts its recorder with no await after `rec` is set (`:100-143`), so it has no window to be parked in.
- **The tests drive `rec-start-offscreen`,** not `startRecording` directly, so the `.catch(onRecError)` at `:15` is part of what's under test — that catch is what turns the throw into cleanup.
- **No README, manifest or version change.**

Checked while planning, on a copy of the tree outside this folder, with Node 24.9.0:

- **As it is now:** `npm test` passes 226.
- **Test change only:** 228 tests run, 226 pass, and both new tests fail — "the document was left marked as recording with no encoder in it" and "the stopped start left the document marked as recording".
- **Both changes:** all 228 pass.
- **Both changes, with one piece left out** (each time, only the named test fails):

  | Piece | Failing test | Message |
  |---|---|---|
  | The whole `Promise.race` deadline | both new tests | as above |
  | The `if (!start.stopped)` guard (always throw) | "a GIF start stopped while its video hangs reports nothing" | "the stopped start flashed a failure over the user's own Stop" |
  | The re-throw (catch swallows everything) | "a GIF start whose video never loads gives up, reports it, and lets the next one run" | "the document was left marked as recording with no encoder in it" |

- **Measured in Chrome while planning** (the probe described above), not the fix itself. Step 3 covers the fix.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 228 tests, 226 pass, and exactly the two new tests fail with the messages above.
2. Make the `offscreen.js` change above.
   → verify: `npm test` passes all 228.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA), Format set to GIF.
   - **Setup:** the setup from step 3 of `docs/KAN-387-plan.md`: headless Chrome over a CDP pipe with `Extensions.loadUnpacked`; PageA opened with `Target.createTarget({ url, forTab: true })`; popups opened with `Extensions.triggerAction({ id, targetId })` after one warm-up; buttons pressed with `Runtime.evaluate` and `userGesture: true`; the worker's and the offscreen document's console traces collected over their own sessions; downloads sent to a temp dir with `Browser.setDownloadBehavior`.
   - **A video that never starts:** record once so the offscreen document exists and stays open (KAN-369), attach to its `offscreen.html` target, and there keep the original `HTMLMediaElement.prototype.play` before replacing it with `function () { return new Promise(() => {}); }` — the ticket's own repro.

   → verify each case:
   - **The ticket's case:**
     1. Press Record on PageA with Format GIF. The worker logs `rec-start-offscreen sent`.
     2. About 2 s later the document logs "recording failed: Error: the video did not start within 2s" and sends `rec-failed`; the badge shows `!` and is empty 3 s after that; `rec` is gone from storage and the popup's Record is back.
     3. In the document, `rec` is `null` and the stream's video track's `readyState` is `'ended'`.
     4. `offscreen-busy` answers false: a clipboard capture closes the document.
     5. A second Record press, with `play` still stubbed, fails the same way rather than being refused for a recording that is already running.
   - **The same case on the code as it is now** (a copy from `git archive HEAD`, loaded unpacked), for comparison: nothing is logged after `rec-start-offscreen`, the badge stays on `REC`, the document's `rec` stays set with no `gif`, and a second Record press logs "a recording is already running; not starting another" and saves no file.
   - **With the original `play` put back:** Record then Stop on PageA saves one `PageA-….gif`, and a WebM recording still saves too.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

- **Is 2 s enough on every machine?** Measured 2 ms and 80 ms in headless Chrome 152 on this Mac, with the recorded tab in the foreground. A start that legitimately took longer than 2 s would now fail with `!` where today it would eventually record. The recorded tab is always the active one at the moment Record is pressed (the popup mints the stream id for it), but nothing stops the user switching away immediately afterwards, and that case wasn't measured. If that's a worry the constant can go up without any other change — `VIDEO_TIMEOUT_MS` is read in one place.
