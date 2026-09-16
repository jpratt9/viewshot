# KAN-208: WebM recording is lost when the recorded tab is closed

Ticket: https://prattsolutions.atlassian.net/browse/KAN-208 (To Do, no comments, labels `bug` and `viewshot`). No ticket blocks it.

## What the repo does now

- **The tab-close path:**
  - `offscreen.js:47-52` gives each video track an `ended` listener that sends `rec-stop`. Its comment says closing the captured tab should still write the file.
  - The worker handles `rec-stop` (`background.js:13`) with `stopRecording` (`background.js:439-448`). That reads `rec` from storage, builds the file name, removes `rec`, clears the badge and sends `rec-stop-offscreen`.
  - The offscreen document passes that message to `stopRecording(filename)` (`offscreen.js:13`).
- **The WebM recorder:**
  - `startRecording` creates the `MediaRecorder`, sets only `ondataavailable`, then calls `start(1000)` (`offscreen.js:100-109`).
  - The WebM branch of `stopRecording` (`offscreen.js:126-139`) first sets `recorder.onstop`, which saves through `download()` and stops the tracks. Then it calls `recorder.stop()`.
  - When the track ends, the recorder stops by itself (a final `dataavailable`, then `stop`) before `rec-stop-offscreen` arrives. The `onstop` set after that never runs, so nothing is saved.
  - The GIF branch (`offscreen.js:118-125`) renders when `rec-stop-offscreen` arrives, so it isn't affected.
  - `teardown()` (`offscreen.js:159-164`) is the error path. It stops the tracks and clears `rec` without saving anything.
- **Reproduced while planning** in headless Chrome 152.0.7977.83, with the repo loaded unpacked, recording a page with a CSS animation:
  - Pressing Stop after 2.5s saved a 101,636-byte WebM.
  - Closing the recorded tab after 2.5s saved nothing within 20s. The worker still logged `rec-stop received` and `stopping, will save as shot-2026-09-16-071939.webm`, and it cleared `rec` and the badge.
- **Tests:**
  - `loadOffscreen()` (`tests/capture-errors.test.js:224-260`) runs `offscreen.js` against three fakes:
    - a fake `MediaRecorder`, whose `finish()` calls `this.onstop()` (`:233`);
    - a fake track, whose `addEventListener` does nothing (`:237`);
    - a fake `sendMessage` that records nothing (`:242`).
  - Its two tests (`:262-273`, `:275-283`) cover a recording ended with an explicit stop. They check `downloads` straight after `r.finish()`, without waiting.
  - No test ends the track.
  - `npm test` passes 116 tests.

## Change

Two files change.

1. **`offscreen.js`:**
   - In `startRecording`, right after `ondataavailable` is set (`offscreen.js:105`), create `rec.stopped`, a promise that resolves on the recorder's `stop` event. It is set up when recording starts, so it also catches a `stop` that fires before `stopRecording` runs.
   - In `stopRecording` (`offscreen.js:132-137`), stop setting `onstop`. Instead, save once `stopped` resolves, and call `recorder.stop()` only if the recorder isn't already `inactive`.

   ```diff
   @@ -103,6 +103,10 @@
        log('starting MediaRecorder, mime=', mime);
        rec.recorder = new MediaRecorder(stream, { mimeType: mime });
        rec.recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
   +    // Closing the captured tab ends the track, and the recorder stops by itself
   +    // - final flush, then `stop` - before rec-stop has been to the worker and
   +    // back. An onstop set in stopRecording() by then never runs, so listen now.
   +    rec.stopped = new Promise((res) => { rec.recorder.onstop = res; });
        // Timeslice → periodic dataavailable. Survives an offscreen-doc eviction
        // mid-recording (MV3 may tear it down); without this, a crash loses
        // everything because the only flush is at stop().
   @@ -128,13 +132,14 @@
        // and THEN fires `onstop` on a later task. We must (a) capture
        // `chunks` + `recorder` into locals so the closure doesn't deref a
        // nulled `rec`, and (b) keep the stream alive until that final flush
   -    // completes — track-stopping happens inside onstop too.
   -    const { recorder, chunks } = rec;
   -    recorder.onstop = () => {
   +    // completes — track-stopping waits for `stop` too.
   +    const { recorder, chunks, stopped } = rec;
   +    stopped.then(() => {
          download(new Blob(chunks, { type: 'video/webm' }), filename);
          stream.getTracks().forEach((t) => t.stop());
   -    };
   -    recorder.stop();
   +    });
   +    // Already inactive if the track ended first: there is nothing left to stop.
   +    if (recorder.state !== 'inactive') recorder.stop();
        rec = null;
      }
    }
   ```

2. **`tests/capture-errors.test.js`:**
   - **Harness changes in `loadOffscreen`:**
     - `finish()` calls `onstop` only if it is set (`:233`). A real recorder fires `stop` either way. Without this, the new test would crash inside the fake instead of failing its assertion against the old code.
     - The fake track keeps its `ended` listener (`:237`), and `sendMessage` records what it sends (`:242`).
     - `loadOffscreen` also returns `sent` and an `endTrack()` helper (`:259`).
   - **The two existing tests** now `await settle()` after `r.finish()` (`:270`, `:281`). The save now runs when the `stopped` promise resolves, which is a microtask later.
   - **New test, "a recording whose tab was closed is still saved":**
     1. It ends the track and expects a `rec-stop` message.
     2. It lets the recorder stop itself with a final flush.
     3. It calls `stopRecording('out.webm')`, as the worker's reply would.
     4. It expects one download, named `out.webm`, that holds both chunks.

   ```diff
   @@ -230,16 +230,18 @@
        // Mirrors the real ordering: a final dataavailable, then onstop, both async.
        stop() { this.state = 'inactive'; }
        flush(blob) { this.ondataavailable({ data: blob }); }
   -    finish() { this.onstop(); }
   +    finish() { this.onstop?.(); } // `stop` fires whether or not anyone listens
      }
      FakeRecorder.isTypeSupported = () => true;

   -  const track = { stop() {}, addEventListener() {} };
   +  const sent = [];
   +  const trackListeners = {};
   +  const track = { stop() {}, addEventListener: (type, fn) => { trackListeners[type] = fn; } };
      const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
      const context = {
        console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
        chrome: {
   -      runtime: { onMessage: { addListener() {} }, sendMessage: async () => {}, getURL: (p) => p },
   +      runtime: { onMessage: { addListener() {} }, sendMessage: async (m) => { sent.push(m); }, getURL: (p) => p },
        },
        navigator: { mediaDevices: { getUserMedia: async () => stream } },
        MediaRecorder: FakeRecorder,
   @@ -256,7 +258,7 @@
      vm.runInContext(read('offscreen.js'), context);
      // download() writes through an <a>, so swap it out and keep the Blob instead.
      vm.runInContext('download = (blob, name) => { __downloads.push([blob, name]); };', Object.assign(context, { __downloads: downloads }));
   -  return { ctx: context, recorders, downloads };
   +  return { ctx: context, recorders, downloads, sent, endTrack: () => trackListeners.ended() };
    }

    test('the final flush after stop() still lands in the recording', async () => {
   @@ -268,6 +270,7 @@
      // `rec` is null now; this is the flush MediaRecorder still owed us.
      assert.doesNotThrow(() => r.flush({ size: 7 }), 'the handler dereferenced a nulled rec');
      r.finish();
   +  await settle(); // the save waits on the recorder's `stop`
      assert.strictEqual(o.downloads.length, 1);
      assert.strictEqual(o.downloads[0][0].parts.length, 2, 'the last chunk never reached the file');
    });
   @@ -279,5 +282,30 @@
      r.flush({ size: 0 });
      o.ctx.stopRecording('out.webm');
      r.finish();
   +  await settle();
      assert.strictEqual(o.downloads[0][0].parts.length, 0);
   +});
   +
   +// --- a WebM recording lost when its tab closed -----------------------------
   +// Closing the recorded tab ends the track, and MediaRecorder stops by itself -
   +// final flush, then `stop` - before rec-stop has been to the worker and back.
   +// stopRecording() only set onstop after that, so it never ran and no file was
   +// written.
   +
   +test('a recording whose tab was closed is still saved', async () => {
   +  const o = loadOffscreen();
   +  await o.ctx.startRecording('sid', 'webm', 100, 100);
   +  const r = o.recorders[0];
   +  r.flush({ size: 10 });
   +  o.endTrack();
   +  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-stop'], 'the ended track did not ask the worker to stop');
   +  // The recorder winds itself down before the worker's answer arrives.
   +  r.state = 'inactive';
   +  r.flush({ size: 7 });
   +  r.finish();
   +  o.ctx.stopRecording('out.webm'); // the worker's rec-stop-offscreen
   +  await settle();
   +  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
   +  assert.strictEqual(o.downloads[0][1], 'out.webm');
   +  assert.strictEqual(o.downloads[0][0].parts.length, 2, 'the saved recording is missing chunks');
    });
   ```

Choices:

- **A promise for `stop`, not a flag.** One save path covers all three cases:
  - Stop was pressed while the recorder was still recording.
  - The track ended and `stop` has already fired.
  - The track ended and `stop` hasn't fired yet.
- **`recorder.onstop`, not `addEventListener`.** This matches how the file sets `ondataavailable`, and the fake recorder calls `onstop`.
- **Checking `recorder.state`.** According to the ticket, Chrome 152 ignores `stop()` on an inactive recorder. The check handles that case explicitly instead of relying on it.
- **The worker stays as it is.** It already turns `rec-stop` into `rec-stop-offscreen` with the file name, and it clears `rec` and the badge, as the reproduction showed.
- **The GIF branch and `teardown()` stay as they are.** On the error path, the promise may resolve with nothing waiting on it, so nothing is saved, the same as now.
- **No version bump.** KAN-207 (103aaee) and KAN-212 (02df5f2) also changed code that ships, and both kept 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - With only the test changes, the new test fails with "the recording was never saved", and the two existing tests still pass.
  - With both changes, 117 tests pass.
- **Chrome 152, patched copy:**
  - Closing the recorded tab saved a 99,757-byte WebM. `ffprobe` reads 55 VP9 frames at 1278×712 from it.
  - Pressing Stop still saved a WebM (94,812 bytes, 53 frames).
  - A GIF recording ended with Stop still saved a GIF (48,967 bytes).
  - After each run, `rec` was gone from storage and the badge was clear.

## Steps

1. Make the `tests/capture-errors.test.js` changes above: the harness, the two awaits and the new test.
   → verify: `node --test tests/capture-errors.test.js` fails only the new test, with "the recording was never saved". The other 13 tests pass.
2. Make the `offscreen.js` change above.
   → verify: `npm test` passes 117 tests (116 existing plus the new one).
3. Check the tab-close path in Chrome 152:
   1. Load the repo unpacked (headless Chrome, as earlier changes did).
   2. From the popup, record WebM on an ordinary page for a few seconds.
   3. Close that tab.

   → verify:
   - A `.webm` is saved within a few seconds, and `ffprobe` reads video frames from it.
   - `rec` is gone from `chrome.storage.local`.
   - The badge is clear.
4. In the same browser, check that nothing else broke.
   → verify:
   - A WebM recording ended with Stop still saves a `.webm`.
   - A GIF recording ended with Stop still saves a `.gif`.
5. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None. The ticket names the cause, the fix direction and the missing test, and the worker side already does its part.
