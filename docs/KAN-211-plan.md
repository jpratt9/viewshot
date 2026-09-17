# KAN-211: A capture during GIF encoding closes the offscreen document and loses the GIF

Ticket: https://prattsolutions.atlassian.net/browse/KAN-211 (To Do, Task, labels `bug` and `viewshot`, no comments). It has no blockers.

## What the repo does now

Line numbers are from the working tree: `425efa0` plus KAN-350's uncommitted change to `background.js` and `tests/capture-errors.test.js`. `offscreen.js` and `tests/offscreen-lifecycle.test.js` are as committed. The ticket's line numbers are from an older revision.

- **The worker forgets a recording before the offscreen document hears about the Stop.**
  - `stopRecording` (`background.js:534-543`) removes `rec` (`:540`) and clears the badge (`:541`). Only then does it send `rec-stop-offscreen` (`:542`).
  - A GIF that reaches its frame cap goes the same way (`rec-cap-hit`, `:23`).
- **The offscreen document saves the recording after that.** Its `stopRecording` is at `offscreen.js:121-148`.
  - **GIF (`:125-132`):**
    - It starts `gif.render()` (`:128`) and sets `rec = null` straight away (`:132`).
    - The file is only downloaded when gif.js fires `finished` (`:127`).
    - gif.js 0.2.0 fires `start`, `progress`, `finished` and `abort`. It has no error event.
  - **WebM and MP4 (`:133-147`):** it sets `rec = null` (`:146`), and downloads the file once the recorder's `stop` has fired (`:140-143`).
  - **`download` (`offscreen.js:159-166`):** it clicks an `<a download>` on a blob URL the document owns, and revokes the URL a minute later (`:165`).
- **`closeOffscreen` (`background.js:390-398`) only looks at `rec`.**
  - It returns while `rec` is set (`:391-392`). Otherwise it closes whatever document there is (`:394`).
  - It has no way to ask the document whether a recording is still being saved. The document's listener (`offscreen.js:6-14`) answers only `offscreen-ping` (`:7`) and `shot-clipboard` (`:11`).
- **`copyImage` (`background.js:401-411`) is the only caller.** It calls `closeOffscreen` in a `finally` (`:408-410`).
  - `runCapture` calls `copyImage` whenever "Copy to clipboard" is on (`:137-138`).
  - That covers the popup and the shortcuts. The shortcuts use the stored settings (`:27-30`, `:39-44`).
  - The clipboard write itself fails in the offscreen document (KAN-206). The document still answers, though, so `closeOffscreen` still runs.
- **Why the document is left open after a recording:**
  - Commit b7e90a7 says recordings download from a blob URL the document owns, so closing it mid-download could lose the file.
  - It names saving recordings through `chrome.downloads` as the follow-up.
- **Tests:**
  - `npm test` passes 210 tests.
  - **In `tests/offscreen-lifecycle.test.js`:**
    - The fake `sendMessage` in `load()` (`:21-24`) answers `'pong'` to a ping and `'done'` to anything else.
    - Only one test keeps the document open, "leaves the document alone while a recording is running" (`:98-103`), and it does so by setting `rec`.
  - **`loadOffscreen` in `tests/capture-errors.test.js` (`:479-517`):**
    - drops the document's message listener (`:499`);
    - never runs a timer (`:509`);
    - swaps `download` for a fake that only keeps the Blob (`:514-515`).
  - No test stops a GIF.
- **Not reproduced in Chrome.** The ticket doesn't say it was, and it wasn't reproduced while planning.

## Change

Four files change: `offscreen.js`, `background.js`, `tests/offscreen-lifecycle.test.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`offscreen.js`**
   - **New `saving` count**, next to `rec` (`:29`). It counts recordings that have been stopped but not saved yet.
   - **`stopRecording` (`:121-123`)** adds one to it on every stop, GIF or video.
   - **`download` (`:165`)** takes one off when it revokes the file's URL, a minute after the download starts.
   - **New `offscreen-busy` message** in the listener (after `:7`). It answers `true` while a recording is running (`rec`) or hasn't been saved yet (`saving > 0`).

   ```diff
   @@ -5,6 +5,9 @@ log('offscreen loaded, GIF available =', typeof GIF !== 'undefined');
    
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'offscreen-ping') { sendResponse('pong'); return; }
   +  // Asked before the worker closes this document: a recording that is running,
   +  // or stopped but not saved yet, lives only in here.
   +  if (msg?.type === 'offscreen-busy') { sendResponse(!!rec || saving > 0); return; }
      // Answered so the worker can close this document once the write is done —
      // an offscreen document shares its renderer main thread with the popup, and
      // Chrome won't paint the popup until that thread lets its onload finish.
   @@ -27,6 +30,7 @@ const GIF_FPS = 10;
    const GIF_MAX_WIDTH = 720;
    const GIF_MAX_FRAMES = 600; // ~60s cap so addFrame copies don't exhaust memory
    let rec = null; // { stream, format, recorder?, chunks?, gif?, timer?, frames? }
   +let saving = 0; // recordings stopped but not saved yet (see stopRecording)
    
    async function startRecording(streamId, format, width, height) {
      // One recording at a time: replacing `rec` would leave the one already
   @@ -121,6 +125,9 @@ async function startRecording(streamId, format, width, height) {
    function stopRecording(filename) {
      if (!rec) return;
      const { stream, format } = rec;
   +  // Saved only later: a GIF is encoded first, a video waits for its final
   +  // flush, and download() still needs the file's URL for a minute after that.
   +  saving++;
    
      if (format === 'gif') {
        if (rec.timer) clearInterval(rec.timer);
   @@ -162,7 +169,7 @@ function download(blob, filename) {
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
   -  setTimeout(() => URL.revokeObjectURL(url), 60000);
   +  setTimeout(() => { URL.revokeObjectURL(url); saving--; }, 60000);
    }
    
    // Release everything this document holds. The frame timer and the capture
   ```

2. **`background.js`:** `closeOffscreen` (`:394`) sends `offscreen-busy` to the document before closing it.
   - If the answer is `true`, the document stays open.
   - Any other answer, or a message that fails, closes it as before.

   ```diff
   @@ -391,7 +391,14 @@ async function closeOffscreen() {
      const { rec } = await chrome.storage.local.get('rec');
      if (rec) return; // a recording lives in there; closing would kill it
      try {
   -    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
   +    if (!(await chrome.offscreen.hasDocument())) return;
   +    // `rec` is removed before the document hears about the Stop, and the
   +    // recording is only saved after that: a GIF is encoded first, which can take
   +    // a while, and the file then downloads from a URL the document owns. Closing
   +    // the document in between lost the recording, so ask it first. One that
   +    // can't answer has no recording in it.
   +    if ((await chrome.runtime.sendMessage({ type: 'offscreen-busy' }).catch(() => false)) === true) return;
   +    await chrome.offscreen.closeDocument();
      } catch (e) {
        console.warn('[ViewShot] closeDocument failed:', e);
      }
   ```

3. **`tests/offscreen-lifecycle.test.js`:** a new test after `:103`, "leaves the document alone while a stopped recording is still being saved in it".
   - The test starts with `rec` gone and the document still there, as after a Stop.
   - While the document answers `offscreen-busy` with `true`, a copy leaves it open. Once it answers `false`, the next copy closes it.

   ```diff
   @@ -102,6 +102,26 @@ test('leaves the document alone while a recording is running', async () => {
      assert.strictEqual(docLives(), true);
    });
    
   +// A stopped recording is still saved in there: `rec` is removed before the
   +// document hears about the Stop, a GIF is encoded, and the file downloads from
   +// a URL the document owns. A clipboard copy in that window closed the document,
   +// and the recording was never saved.
   +test('leaves the document alone while a stopped recording is still being saved in it', async () => {
   +  const { ctx, calls, docLives } = load({ hasDoc: true }); // Stop has removed `rec`
   +  let saving = true;
   +  ctx.chrome.runtime.sendMessage = async (m) => {
   +    calls.sent.push(m);
   +    if (m.type === 'offscreen-busy') return saving;
   +    return m.type === 'offscreen-ping' ? 'pong' : 'done';
   +  };
   +  await ctx.copyImage(PNG);
   +  assert.strictEqual(calls.close, 0, 'closing mid-encode would lose the GIF');
   +  assert.strictEqual(docLives(), true);
   +  saving = false; // saved, and the download is done with the file
   +  await ctx.copyImage(PNG);
   +  assert.strictEqual(calls.close, 1, 'the document outlived the recording it was saving');
   +});
   +
    // --- unless the browser or the extension ended it -----------------------------
    // `rec` is kept in chrome.storage.local so a recording outlives a worker
    // restart. It also outlived Chrome quitting and the extension reloading, which
   ```

4. **`tests/capture-errors.test.js`**
   - **`loadOffscreen` (`:479-517`):**
     - It keeps the document's message listener and returns `message()`, as `loadBg` does (`:94`).
     - It holds timers, and returns `runTimers()` to run them.
     - It lets the real `download` run behind the fake, so the URL revoke becomes a timer the test can run.
   - **A new section at the end (after `:1170`), with two tests:**
     - **"a GIF keeps its document busy from its stop until the download is done with the file":**
       - The document answers `true` while the GIF is recording, after its stop, and after gif.js finishes and the download starts.
       - It answers `false` once the URL is revoked.
     - **"a WebM keeps its document busy from its stop until the download is done with the file":**
       - The document answers `true` while recording, after the stop, and after the final flush and the download.
       - It answers `false` once the URL is revoked.

   ```diff
   @@ -490,13 +490,15 @@ function loadOffscreen() {
      FakeRecorder.isTypeSupported = () => true;
    
      const sent = [];
   +  const timers = []; // download()'s URL revoke, a minute on
   +  let onMessage;
      const trackListeners = {};
      const track = { stop() {}, addEventListener: (type, fn) => { trackListeners[type] = fn; } };
      const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
      const context = {
        console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
        chrome: {
   -      runtime: { onMessage: { addListener() {} }, sendMessage: async (m) => { sent.push(m); }, getURL: (p) => p },
   +      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, sendMessage: async (m) => { sent.push(m); }, getURL: (p) => p },
        },
        navigator: { mediaDevices: { getUserMedia: async () => stream } },
        MediaRecorder: FakeRecorder,
   @@ -506,14 +508,18 @@ function loadOffscreen() {
          createElement: () => ({ style: {}, click() {}, remove() {}, appendChild() {} }),
          body: { appendChild() {} },
        },
   -    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0,
   +    setTimeout: (fn) => { timers.push(fn); return 0; }, clearInterval: () => {}, setInterval: () => 0,
        GIF: class {},
      };
      vm.createContext(context);
      vm.runInContext(read('offscreen.js'), context);
   -  // download() writes through an <a>, so swap it out and keep the Blob instead.
   -  vm.runInContext('download = (blob, name) => { __downloads.push([blob, name]); };', Object.assign(context, { __downloads: downloads }));
   -  return { ctx: context, recorders, downloads, sent, endTrack: () => trackListeners.ended() };
   +  // download() writes through an <a>, so keep each Blob on its way through.
   +  vm.runInContext('download = ((real) => (blob, name) => { __downloads.push([blob, name]); real(blob, name); })(download);', Object.assign(context, { __downloads: downloads }));
   +  return {
   +    ctx: context, recorders, downloads, sent, endTrack: () => trackListeners.ended(),
   +    message: (msg, respond = () => {}) => onMessage(msg, {}, respond),
   +    runTimers: () => timers.splice(0).forEach((fn) => fn()),
   +  };
    }
    
    test('the final flush after stop() still lands in the recording', async () => {
   @@ -1168,3 +1174,42 @@ test('a start stopped while it waits on the page records nothing, and the next s
      assert.deepStrictEqual(started, ['sid2'], 'the stopped start went on to record');
      assert.strictEqual(store.rec?.url, TAB.url, 'the next recording was left without its rec');
    });
   +
   +// --- a capture while a stopped recording is still being saved ---------------
   +// The worker removes `rec` before the offscreen document hears about the Stop,
   +// and the recording is saved in the document after that: a GIF is encoded
   +// first, and the file then downloads from a URL the document owns. A clipboard
   +// copy in that window closed the document, and the recording was never saved.
   +// The worker now asks the document before it closes it.
   +
   +const busy = (o) => { let answer; o.message({ type: 'offscreen-busy' }, (a) => { answer = a; }); return answer; };
   +
   +test('a GIF keeps its document busy from its stop until the download is done with the file', async () => {
   +  const o = loadOffscreen();
   +  const gif = { on: (event, fn) => { gif[event] = fn; }, render() {} };
   +  vm.runInContext("rec = { format: 'gif', gif: __gif, stream: { getTracks: () => [] } }", Object.assign(o.ctx, { __gif: gif }));
   +  assert.strictEqual(busy(o), true, 'the worker could close the document before the stop arrived');
   +  o.ctx.stopRecording('out.gif');
   +  assert.strictEqual(busy(o), true, 'the worker could close the document mid-encode');
   +  gif.finished({ size: 10 }); // gif.js has finished encoding
   +  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out.gif']);
   +  assert.strictEqual(busy(o), true, 'the worker could close the document while the download still needs the file');
   +  o.runTimers();
   +  assert.strictEqual(busy(o), false, 'the document stayed busy after its file was saved');
   +});
   +
   +test('a WebM keeps its document busy from its stop until the download is done with the file', async () => {
   +  const o = loadOffscreen();
   +  await o.ctx.startRecording('sid', 'webm', 100, 100);
   +  const r = o.recorders[0];
   +  r.flush({ size: 10 });
   +  assert.strictEqual(busy(o), true, 'the worker could close the document before the stop arrived');
   +  o.ctx.stopRecording('out.webm');
   +  assert.strictEqual(busy(o), true, 'the worker could close the document before the final flush');
   +  r.finish();
   +  await settle();
   +  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out.webm']);
   +  assert.strictEqual(busy(o), true, 'the worker could close the document while the download still needs the file');
   +  o.runTimers();
   +  assert.strictEqual(busy(o), false, 'the document stayed busy after its file was saved');
   +});
   ```

Choices:

- **The worker asks the document, rather than keeping a second flag in storage.**
  - Only the document knows whether a recording is still being saved in it.
  - A flag in storage could outlive the document, the way `rec` did (KAN-294, KAN-297). The document would also need a new message to clear it.
- **The document stays busy until the file's URL is revoked, not just until the GIF is encoded.**
  - Closing the document revokes its URLs. Commit b7e90a7 left the document open because closing it mid-download could lose the file.
  - The minute is the delay `download` already uses (`offscreen.js:165`), so no new timing is guessed.
- **WebM and MP4 saves are counted too.**
  - They go through the same `stopRecording` and `download`, and the count only gets back to 0 if every stop is counted.
  - A copy made straight after a video's Stop could close the document before the final flush, just as with a GIF.
- **A running recording answers `true` as well.** The worker removes `rec` (`background.js:540`) before it sends `rec-stop-offscreen` (`:542`). A copy can ask in between, before the document has counted the stop.
- **Only an answer of `true` keeps the document.**
  - A document that can't be reached has no recording in it. One example is a new document that never answered the ping. A copy already closes that one ("closes a new document that never answers, and fails the copy", `tests/offscreen-lifecycle.test.js:80-86`).
  - The existing fakes answer `'done'` to every other message (`:23`).
  - `ensureOffscreen` likewise accepts only `'pong'` (`background.js:375`).
- **A save that never finishes keeps the document open for good.**
  - gif.js has no error event, so an encode that fails never brings the count back down.
  - Copies then leave that document open until Chrome or the extension restarts.
  - After a recording today, the document also stays open until a copy closes it.
- **Saving through `chrome.downloads` isn't part of this change.** The document would still have to stay open while a GIF encodes, so this check would still be needed. See "Open questions".
- **No README, manifest or version change.**

Checked while planning, on copies of the repo in `/tmp`. Each copy includes KAN-350's uncommitted change, as the working tree does:

- **As it is now:** `npm test` passes 210 tests.
- **Test changes only:** 213 tests run. 210 pass, and these 3 fail:

  | Test | Failure |
  |---|---|
  | "a GIF keeps its document busy from its stop until the download is done with the file" | "the worker could close the document before the stop arrived". The document doesn't answer `offscreen-busy` |
  | "a WebM keeps its document busy from its stop until the download is done with the file" | "the worker could close the document before the stop arrived" |
  | "leaves the document alone while a stopped recording is still being saved in it" | "closing mid-encode would lose the GIF" |

- **All the changes:** 213 tests pass.
- **All the changes, with one piece put back:**

  | Piece put back | Tests that fail |
  |---|---|
  | No `.catch(() => false)` on the `offscreen-busy` message | "still closes the document when the clipboard write rejects" and "closes a new document that never answers, and fails the copy". The failed message lands in the outer `catch`, which skips the close |
  | Any truthy answer keeps the document, not only `true` | "closes the offscreen document after a clipboard copy", "waits for the clipboard write to be acknowledged before closing", and both "… forgets a recording that couldn't survive it" tests. The fakes' `'done'` keeps the document open |
  | The answer leaves out `rec` (`saving > 0` only) | both new offscreen tests, with "the worker could close the document before the stop arrived" |
  | `saving--` straight after the download's click, instead of when the URL is revoked | both new offscreen tests, with "the worker could close the document while the download still needs the file" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/offscreen-lifecycle.test.js` and `tests/capture-errors.test.js` changes above.
   → verify: `npm test` runs 213 tests. 210 pass, and the 3 tests under "Test changes only" fail with those messages. No other test fails.
2. Make the `offscreen.js` and `background.js` changes above.
   → verify: `npm test` passes all 213 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA).
   - **Setup:** the headless setup from step 3 of `docs/KAN-345-plan.md`:
     - `Extensions.loadUnpacked`;
     - popups opened with `Extensions.triggerAction`;
     - buttons pressed, and stream ids minted, with `Runtime.evaluate` and `userGesture: true`;
     - Name set to `{title}-{time}`.
   - **Trace in the worker:**
     - wrap `chrome.runtime.sendMessage` so it logs each `offscreen-busy` answer;
     - log `chrome.offscreen.hasDocument()` after each capture.
   - **A clipboard capture:** in a popup on PageA, set Format to PNG, tick "Copy to clipboard", and press Visible.

   → verify each case:
   - **The ticket's case:**
     1. Record a GIF on PageA for about 20 s, press Stop, and run a clipboard capture straight away.
     2. The trace shows `offscreen-busy` answered `true` before the offscreen document logs `downloading PageA-….gif`.
     3. `hasDocument()` is `true` after the capture.
     4. The `.gif` is saved, and `ffprobe` reads it as a GIF of about 200 frames.
   - **The same case on the code as it is now,** for comparison: `hasDocument()` is `false` after the capture, and no `.gif` is saved.
   - **Within a minute of that download:** another clipboard capture gets `true`, and the document stays open.
   - **More than a minute after it:** a clipboard capture gets `false`, and `hasDocument()` is `false` afterwards.
   - **WebM:**
     1. Record for about 3 s, press Stop, and run a clipboard capture straight away.
     2. The capture gets `true`.
     3. A `.webm` is saved, and `ffprobe` reads it as VP9 video with frames in it.
   - **No recording since the extension loaded:** a clipboard capture creates the document, gets `false`, and closes the document, as before.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `offscreen.js`, `background.js`, `tests/offscreen-lifecycle.test.js`, `tests/capture-errors.test.js` and this plan. `docs/KAN-350-plan.md` may also be listed if KAN-350 still isn't committed.

## Noticed while planning, not changed

- **Nothing closes the document once a recording is saved.** Since commit b7e90a7, it stays open after every recording until a clipboard copy closes it. With this change, a copy made within a minute of the download also leaves it open.

## Open questions

- **Should KAN-350 be committed first?** Its change is still uncommitted in `background.js` and `tests/capture-errors.test.js`, and this change edits both files. The line numbers and test counts above include it.
- **Is saving recordings through `chrome.downloads` part of this ticket?** The ticket lists it as a related follow-up, and this plan leaves it out. If it's in:
  - the worker would download each recording from a URL the document hands it;
  - the document could be closed once Chrome reports the download complete, instead of staying busy for a minute and then open until the next copy;
  - the `offscreen-busy` check would still be needed while a GIF encodes.

  None of this was checked while planning.
