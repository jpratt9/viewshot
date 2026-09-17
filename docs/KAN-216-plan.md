# KAN-216: REC badge can get stuck on, or disappear during a recording

Ticket: https://prattsolutions.atlassian.net/browse/KAN-216 (To Do, Task, labels `bug` and `viewshot`, no comments, no blocker links).

## What the repo does now

Line numbers are from `db00599`, with a clean working tree. The ticket's line numbers are older. For example, its `background.js:349-379` is now `:389-423`, `:306-309` is `:346-349`, `:343-347` is `:383-387`, and `popup.js:101-102` is `:130-131`.

- **A start marks the recording as running before the offscreen document has it.**
  - `startRecording` (`background.js:389-423`) returns early if `rec` is set (`:393-394`). Otherwise it looks up the tab (`:397`), runs `ensureOffscreen()` (`:398`), writes `rec` (`:401`) and shows `REC` (`:402-403`). Only after the blip and the viewport read does it send `rec-start-offscreen` (`:418-421`).
  - `ensureOffscreen()` (`background.js:329-351`) pings a new document up to 40 times, 25 ms apart (`:346-349`). It then logs "offscreen document ready" (`:350`) whether or not the document ever answered.
  - The `rec-start` handler (`background.js:12`) only logs a rejected start. Nothing removes `rec` or clears `REC`.
  - While `rec` is set, `closeOffscreen()` (`background.js:358-366`) returns early (`:360`), so a clipboard copy leaves the document open.
  - Failures inside the offscreen document are already handled. `onRecError` (`offscreen.js:178-182`) sends `rec-failed`, and the worker removes `rec` and flashes `!` (`background.js:15`). A document that never gets `rec-start-offscreen` sends nothing.
  - A start whose tab has closed already fails before it writes anything (`3adbcdd`, tested at `tests/capture-errors.test.js:705-714`). Nothing reports that failure.
- **The popup enables Stop before it knows the start worked.**
  - Record's click handler (`popup.js:113-131`) runs these steps in order:
    1. greys Record out (`:116`);
    2. mints the stream id (`:122`);
    3. saves (`:129`);
    4. sends `rec-start` without waiting for an answer (`:130`);
    5. enables Stop (`:131`).
  - The storage listener (`popup.js:178-183`, from `4728bb0`) already sets Stop from every change to `rec` and runs `toggleRec()` (`popup.js:96-103`). A start that writes `rec` therefore enables Stop there as well.
  - A start that fails before it writes `rec` changes nothing in storage. Stop stays enabled and Record stays greyed out until Stop is pressed or the popup is reopened.
- **A flash blanks the badge.**
  - `flashBadge` (`background.js:383-387`) sets its text, then sets the badge to empty 3 s later (`:386`).
  - `captureFailed` (`background.js:91-94`) flashes `!` for any failed screenshot, including one taken during a recording. `REC` is then gone while the recording keeps going.
- **Tests:** `npm test` passes 195 tests.
  - `loadBg` (`tests/capture-errors.test.js:21-97`) records every non-empty badge text in `badges` (`:64`). Its `message()` (`:92`) passes a `sendResponse` that discards the answer.
  - `loadPopup` (`tests/capture-errors.test.js:236-292`) answers every message with `true` (`:276`).
  - `load()` in `tests/offscreen-lifecycle.test.js:12-57` answers every ping with `pong`.

## Change

Four files change: `background.js`, `popup.js`, `tests/capture-errors.test.js` and `tests/offscreen-lifecycle.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

1. **`background.js`**
   - **`rec-start` handler (`:12`):**
     - When `startRecording` settles, it answers the popup: `true` if the start resolved, `false` if it rejected.
     - On a rejection, it also logs the error and runs `recFailed()`.
     - It returns `true` so it can answer after the start has finished.
   - **`rec-failed` handler (`:15`):** its body moves into a new `recFailed()` function, so both kinds of failed start clean up the same way.
   - **`ensureOffscreen()` (`:346-350`):** it returns as soon as the document answers. If the document never answers, it throws `The offscreen document never answered`, and the start fails before it writes `rec` or shows `REC`.
   - **`copyImage()` (`:369-378`):** `await ensureOffscreen()` moves inside the `try`. The `finally` then still closes a new document that never answered, as it does today when the clipboard write fails.
   - **`flashBadge()` (`:386`):** after 3 s, the badge shows `REC` if `rec` is set, and is blank otherwise.

   ```diff
   @@ -9,10 +9,17 @@ const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // "press Region twice" bug. The popup awaits this ack before window.close().
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'capture') { sendResponse(true); runCapture(msg.mode, msg.opts, msg.tabId).catch(captureFailed); }
   -  else if (msg?.type === 'rec-start') startRecording(msg.streamId, msg.opts, msg.tabId).catch((e) => console.error('[ViewShot]', e));
   +  else if (msg?.type === 'rec-start') {
   +    // Answered once the start has worked or failed: the popup enables Stop
   +    // from `rec`, and a start that fails before `rec` is written leaves
   +    // nothing there for it to see.
   +    startRecording(msg.streamId, msg.opts, msg.tabId)
   +      .then(() => sendResponse(true), (e) => { console.error('[ViewShot]', e); sendResponse(false); return recFailed(); });
   +    return true;
   +  }
      else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
      else if (msg?.type === 'rec-cap-hit') stopRecording().then(() => flashBadge('MAX')).catch((e) => console.error('[ViewShot]', e));
   -  else if (msg?.type === 'rec-failed') chrome.storage.local.remove('rec').then(() => flashBadge('!'));
   +  else if (msg?.type === 'rec-failed') recFailed();
    });
    
    chrome.commands.onCommand.addListener(async (cmd, tab) => {
   @@ -342,12 +349,18 @@ async function ensureOffscreen() {
      try { await offscreenCreating; } finally { offscreenCreating = null; }
      // createDocument can resolve just before the page's message listener is live,
      // so the first rec-start would be dropped. Ping until it answers (the cause
   -  // of the "press record twice to start" bug).
   +  // of the "press record twice to start" bug). One that never answers is a
   +  // failure, not a document to carry on with.
      for (let i = 0; i < 40; i++) {
   -    try { if ((await chrome.runtime.sendMessage({ type: 'offscreen-ping' })) === 'pong') break; } catch {}
   +    try {
   +      if ((await chrome.runtime.sendMessage({ type: 'offscreen-ping' })) === 'pong') {
   +        console.log('[ViewShot] offscreen document ready');
   +        return;
   +      }
   +    } catch {}
        await sleep(25);
      }
   -  console.log('[ViewShot] offscreen document ready');
   +  throw new Error('The offscreen document never answered');
    }
    
    // An offscreen document shares its renderer process — and therefore its Blink
   @@ -367,10 +380,11 @@ async function closeOffscreen() {
    
    // ---- clipboard via the offscreen document ----
    async function copyImage(pngDataUrl) {
   -  await ensureOffscreen();
      // The offscreen listener answers only after the clipboard write resolves, so
      // awaiting here means it is safe to tear the document down straight after.
   +  // A new document that never answered is closed too.
      try {
   +    await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: 'shot-clipboard', dataUrl: pngDataUrl });
      } finally {
        await closeOffscreen();
   @@ -383,7 +397,18 @@ const log = (...a) => console.log('[ViewShot]', ...a);
    async function flashBadge(text) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
      await chrome.action.setBadgeText({ text });
   -  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
   +  // Back to REC, not blank, while a recording is still running: a screenshot
   +  // can fail in the middle of one.
   +  setTimeout(async () => {
   +    const { rec } = await chrome.storage.local.get('rec');
   +    await chrome.action.setBadgeText({ text: rec ? 'REC' : '' });
   +  }, 3000);
   +}
   +
   +// A start that failed, here or in the offscreen document: nothing is
   +// recording, so drop `rec` (an open popup follows it) and flash ! over REC.
   +function recFailed() {
   +  return chrome.storage.local.remove('rec').then(() => flashBadge('!'));
    }
    
    async function startRecording(streamId, opts, tabId) {
   ```

2. **`popup.js` (`:130-131`):**
   - The popup waits for the worker's answer instead of enabling Stop itself. Enabling Stop is left to the storage listener (`:178-183`).
   - If the answer isn't `true`, or the message can't be sent, the popup shows an error and runs `toggleRec()`, so Record comes back.

   ```diff
   @@ -127,8 +127,20 @@ document.querySelectorAll('#modes .mode').forEach((btn) => {
            return; // keep the popup open so the error is visible
          }
          await save();
   -      chrome.runtime.sendMessage({ type: 'rec-start', streamId, tabId: activeTab.id, opts });
   -      $('stopBtn').disabled = false; // popup stays open, so reflect the live recording
   +      // Stop is left to the storage listener below, which enables it once the
   +      // worker has marked the recording as running. A start that fails before
   +      // then changes nothing in storage, so the worker's answer is what brings
   +      // Record back.
   +      let started = false;
   +      try {
   +        started = await chrome.runtime.sendMessage({ type: 'rec-start', streamId, tabId: activeTab.id, opts });
   +      } catch (e) {
   +        console.error('[ViewShot] rec-start message failed:', e);
   +      }
   +      if (!started) {
   +        showError('Couldn’t start the recording. Try again.');
   +        toggleRec(); // nothing is recording, so Record comes back
   +      }
        } else {
          // Until "Allow access to file URLs" is on, Chrome refuses both
          // executeScript and captureVisibleTab on file:// pages. Recording needs
   ```

3. **`tests/capture-errors.test.js`**
   - **`loadBg()` (`:92`):** `message(msg, respond)` passes the listener's answer to `respond`.
   - **`loadPopup()` (`:236`, `:276`):** a new `reply` option (default `true`) sets the worker's answer. If `reply` is an `Error`, the fake throws it instead.
   - **"a recording whose tab has since closed sets nothing up" (`:713`):** the start still sets nothing up, but it now flashes `!`. The expected badge list changes from `[]` to `['!']`.
   - **"Record stays greyed out once it has started a recording, until Stop" (`:742`):** after the press, the test marks the recording as running through the storage listener, as the worker would. Otherwise Stop stays disabled and the test can't press it.
   - **A new section at the end (after `:926`)** with eight tests:
     - "a start whose new offscreen document never answers sets nothing up, and says so"
     - "a start the offscreen document never gets is undone"
     - "a start that works tells the popup so"
     - "a failed screenshot's ! gives way to REC while a recording runs"
     - "a failed screenshot's ! gives way to a blank badge with nothing recording"
     - "Record leaves Stop to the worker marking the recording as running"
     - "Record comes back when the worker says the start failed"
     - "Record comes back when the worker can't be reached"

   ```diff
   @@ -89,7 +89,7 @@ function loadBg({ captureFails = null, captureHangs = null, scriptFails = false,
      captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      return {
        ctx: context, shots, badges, sleeps,
   -    message: (msg) => onMessage(msg, {}, () => {}),
   +    message: (msg, respond = () => {}) => onMessage(msg, {}, respond), // respond gets the listener's answer
        command: (cmd, tab) => onCommand(cmd, tab),
        tick: (ms) => { now += ms; },
        expire: () => deadlines.splice(0).forEach((fn) => fn()), // the capture deadline passes
   @@ -233,7 +233,7 @@ test('recording a page that refuses scripts logs a warning, not an error', async
    
    // --- the popup says which page it was --------------------------------------
    
   -function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false } = {}) {
   +function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true } = {}) {
      const els = {};
      const sent = [];
      const writes = [];
   @@ -273,7 +273,7 @@ function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {},
              onChanged: { addListener: (fn) => { onStored = fn; } },
            },
          },
   -      runtime: { sendMessage: async (m) => { sent.push(m); return true; } },
   +      runtime: { sendMessage: async (m) => { sent.push(m); if (reply instanceof Error) throw reply; return reply; } }, // the worker's answer
          tabCapture: { getMediaStreamId: async () => { streams.push('requested'); if (streamIdFails) throw new Error('stream id refused'); return 'sid'; } },
          extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
        },
   @@ -710,7 +710,7 @@ test('a recording whose tab has since closed sets nothing up', async () => {
      bg.message({ type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: 99 });
      await settle();
      assert.strictEqual(stored.length, 0, 'marked as recording with nothing recording');
   -  assert.deepStrictEqual(bg.badges, [], 'REC went up for a recording that never started');
   +  assert.deepStrictEqual(bg.badges, ['!'], 'REC went up, or the failed start went unnoticed');
    });
    
    // --- a second recording started over the first ------------------------------
   @@ -740,6 +740,7 @@ test('Record stays greyed out once it has started a recording, until Stop', asyn
      const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
      await p.ready();
      await p.click('visible');
   +  p.stored({ rec: { newValue: RUNNING } }); // the worker marks it as running
      assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over the recording it started');
      await p.click('visible');
      p.stop();
   @@ -924,3 +925,94 @@ test('failed initialization reports an error and cannot save fallback options',
      assert.strictEqual(p.sent.length, 0);
      assert.strictEqual(p.streams.length, 0);
    });
   +
   +// --- REC stuck on, or wiped during a recording ------------------------------
   +// startRecording marks the recording as running and puts REC up before it
   +// tells the offscreen document to start. When that document never answered its
   +// ping, or never got the message, nothing undid either: REC stayed on, an open
   +// popup kept Stop enabled, and closeOffscreen() wouldn't close the document.
   +// The popup enabled Stop without hearing whether the start worked. And the !
   +// of a screenshot that failed mid-recording blanked the badge 3 s later,
   +// wiping REC while the recording ran on.
   +
   +const WEBM_START = { type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: TAB.id };
   +const UNREACHABLE = 'Could not establish connection. Receiving end does not exist.';
   +
   +test('a start whose new offscreen document never answers sets nothing up, and says so', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  const stored = [];
   +  const sent = [];
   +  let reply;
   +  chrome.offscreen = { hasDocument: async () => false, createDocument: async () => {} };
   +  chrome.storage.local.set = async (o) => { stored.push(o); };
   +  chrome.runtime.sendMessage = async (m) => { sent.push(m.type); throw new Error(UNREACHABLE); };
   +  bg.message(WEBM_START, (r) => { reply = r; });
   +  await settle();
   +  assert.deepStrictEqual(stored, [], 'marked as recording with nothing recording');
   +  assert.ok(!sent.includes('rec-start-offscreen'), 'started a recording in a document that never answered');
   +  assert.deepStrictEqual(bg.badges, ['!'], 'REC went up, or the failed start went unnoticed');
   +  assert.strictEqual(reply, false, 'the popup was told the recording started');
   +});
   +
   +test('a start the offscreen document never gets is undone', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  const storage = [];
   +  let reply;
   +  chrome.offscreen = { hasDocument: async () => true }; // open, but not listening
   +  chrome.storage.local.set = async (o) => { storage.push(['set', ...Object.keys(o)]); };
   +  chrome.storage.local.remove = async (k) => { storage.push(['remove', k]); };
   +  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') throw new Error(UNREACHABLE); };
   +  bg.message(WEBM_START, (r) => { reply = r; });
   +  await settle();
   +  assert.deepStrictEqual(storage, [['set', 'rec'], ['remove', 'rec']], 'still marked as recording with nothing recording');
   +  assert.deepStrictEqual(bg.badges, ['REC', '!'], 'REC stayed up, or the failed start went unnoticed');
   +  assert.strictEqual(reply, false, 'the popup was told the recording started');
   +});
   +
   +test('a start that works tells the popup so', async () => {
   +  const bg = loadBg();
   +  let reply;
   +  bg.ctx.chrome.offscreen = { hasDocument: async () => true };
   +  bg.message(WEBM_START, (r) => { reply = r; });
   +  await settle();
   +  assert.strictEqual(reply, true);
   +  assert.deepStrictEqual(bg.badges, ['REC']);
   +});
   +
   +for (const [rec, after] of [[RUNNING, 'REC'], [undefined, '']]) {
   +  test(`a failed screenshot's ! gives way to ${rec ? 'REC while a recording runs' : 'a blank badge with nothing recording'}`, async () => {
   +    const bg = loadBg({ captureFails: () => 'Cannot access contents of the page' });
   +    const { chrome } = bg.ctx;
   +    const texts = [];
   +    chrome.storage.local.get = async () => ({ rec });
   +    chrome.action.setBadgeText = async ({ text }) => { texts.push(text); };
   +    await bg.ctx.runCapture('visible', OPTS).catch(bg.ctx.captureFailed);
   +    await settle();
   +    assert.deepStrictEqual(texts, ['!', after]);
   +  });
   +}
   +
   +test('Record leaves Stop to the worker marking the recording as running', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
   +  await p.ready();
   +  await p.click('visible');
   +  assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop was enabled before the recording was marked as running');
   +  assert.strictEqual(p.btn('visible').disabled, true, 'Record came back while the start was under way');
   +  p.stored({ rec: { newValue: RUNNING } });
   +  assert.strictEqual(p.els.stopBtn.disabled, false);
   +});
   +
   +for (const [what, reply] of [['says the start failed', false], ['can\'t be reached', new Error(UNREACHABLE)]]) {
   +  test(`Record comes back when the worker ${what}`, async () => {
   +    const p = loadPopup('https://a.com/x', { reply, store: { opts: { format: 'webm' } } });
   +    await p.ready();
   +    await p.click('visible');
   +    assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop was enabled for a recording that never started');
   +    assert.strictEqual(p.btn('visible').disabled, false, 'a start that failed left Record greyed out');
   +    assert.strictEqual(p.els.err.hidden, false, 'the failed start went unnoticed');
   +    await p.click('visible');
   +    assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start', 'rec-start']);
   +  });
   +}
   ```

4. **`tests/offscreen-lifecycle.test.js` (after `:78`):** one new test, "closes a new document that never answers, and fails the copy".

   ```diff
   @@ -77,6 +77,14 @@ test('still closes the document when the clipboard write rejects', async () => {
      assert.strictEqual(calls.close, 1, 'a failed write must not leak the document');
    });
    
   +test('closes a new document that never answers, and fails the copy', async () => {
   +  const { ctx, calls, docLives } = load();
   +  ctx.chrome.runtime.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
   +  await assert.rejects(() => ctx.copyImage(PNG), /offscreen document never answered/);
   +  assert.strictEqual(calls.close, 1, 'a document that never answered was left open');
   +  assert.strictEqual(docLives(), false);
   +});
   +
    test('waits for the clipboard write to be acknowledged before closing', async () => {
      const { ctx, calls } = load();
      await ctx.copyImage(PNG);
   ```

Choices:

- **The popup learns about a failed start from the worker's answer, not from storage.**
  - A start that fails before `rec` is written changes nothing in storage, so the storage listener never runs.
  - The screenshot path already works this way: the popup waits for the worker's answer (`popup.js:158-164`), and the worker answers `capture` (`background.js:11`).
- **Only the storage listener enables Stop.**
  - The worker writes `rec` before it answers, so the listener enables Stop first.
  - If the popup also enabled Stop on a `true` answer, a recording could end between the two (for example with `rec-failed` from the offscreen document). Stop would then come back on with nothing recording.
  - While the start is running (up to about a second, mostly the blip), Record stays greyed out. Stop is enabled as soon as `rec` is written.
- **The `rec-start` handler cleans up a failed start the same way `rec-failed` does.**
  - Removing `rec` also disables Stop in an open popup, through its listener, and lets `closeOffscreen()` close the document again.
  - `flashBadge('!')` replaces `REC`. Because `rec` is gone, the badge is blank when the flash ends.
  - The cleanup runs for every rejected start, including one that failed before `rec` was written. Removing a key that isn't there does nothing.
- **A document that never answers counts as a failed start.** Today the start carries on anyway: it writes `rec`, shows `REC` and plays the blip, and only the later send fails.
- **`copyImage()` still closes a document it can't use.** Today, a document that never answered is closed after the clipboard write fails. Moving `ensureOffscreen()` into the `try` keeps that.
- **`flashBadge()` reads `rec` when the flash ends, not when it starts.** A recording that starts or stops during those 3 s is then shown correctly.
- **The popup shows "Couldn’t start the recording. Try again."** The popup is open, and its other failures (a refused stream id, a worker it can't reach) show a message too.
- **No README, manifest or version change.** Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **As it is now:** `npm test` passes 195 tests.
- **Test changes only:** 204 tests run. 195 pass, and these 9 fail:

  | Test | Failure |
  |---|---|
  | "a recording whose tab has since closed sets nothing up" | "REC went up, or the failed start went unnoticed" |
  | "a start whose new offscreen document never answers sets nothing up, and says so" | "marked as recording with nothing recording" |
  | "a start the offscreen document never gets is undone" | "still marked as recording with nothing recording" |
  | "a start that works tells the popup so" | the answer is `undefined` |
  | "a failed screenshot's ! gives way to REC while a recording runs" | the badge texts are `['!', '']`, not `['!', 'REC']` |
  | "Record leaves Stop to the worker marking the recording as running" | "Stop was enabled before the recording was marked as running" |
  | "Record comes back when the worker says the start failed" | "Stop was enabled for a recording that never started" |
  | "Record comes back when the worker can't be reached" | the same message. Node also reports the popup's unhandled rejection |
  | "closes a new document that never answers, and fails the copy" | the copy fails with "Could not establish connection. Receiving end does not exist." instead of "The offscreen document never answered" |

- **All changes:** 204 tests pass.
- **All changes, with one piece put back as it is now:**

  | Piece put back | Tests that fail |
  |---|---|
  | The `rec-start` handler (`background.js:12`) | "a recording whose tab has since closed sets nothing up", "a start that works tells the popup so", "a start the offscreen document never gets is undone", "a start whose new offscreen document never answers sets nothing up, and says so" |
  | `ensureOffscreen()` carrying on after 40 unanswered pings | "a start whose new offscreen document never answers sets nothing up, and says so", "closes a new document that never answers, and fails the copy" |
  | `ensureOffscreen()` before `copyImage()`'s `try` | "closes a new document that never answers, and fails the copy" |
  | `flashBadge()` always blanking the badge | "a failed screenshot's ! gives way to REC while a recording runs" |
  | `popup.js` enabling Stop without waiting | "Record leaves Stop to the worker marking the recording as running", and both "Record comes back when the worker …" tests |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the two test-file changes above.
   → verify: `npm test` runs 204 tests. 195 pass, and the 9 tests listed under "Test changes only" fail with those messages. No other test fails.
2. Make the `background.js` and `popup.js` changes above.
   → verify: `npm test` passes all 204 tests: the 195 existing ones (two of them updated) and the 9 new ones.
3. Check the change in Chrome 152 with the repo loaded unpacked, on an http page.
   - **Setup:** the headless setup under "Checked while planning" in `docs/KAN-308-plan.md`. Buttons are pressed with `Runtime.evaluate` and `userGesture: true`, and a `MutationObserver` in the popup page records each change to Stop's `disabled` attribute.

   → verify each case:
   - **A screenshot fails during a recording:**
     1. Start a WebM recording from the popup.
     2. From the popup page, send `{ type: 'capture', mode: 'visible', tabId: 999999, opts }`. No tab has that id, so the screenshot fails.
     3. The badge shows `!`. 3 s later, `chrome.action.getBadgeText({})` in the worker returns `REC`.
     4. Press Stop. The recording is still saved, and the badge is then blank.
   - **A start fails before `rec` is written:**
     1. In the popup page, wrap `chrome.runtime.sendMessage` so that `rec-start` carries `tabId: 999999`.
     2. Press Record.
     3. The popup shows "Couldn’t start the recording. Try again.", Record is enabled, and Stop stayed disabled throughout.
     4. The badge shows `!` and is blank 3 s later. `rec` is not in storage.
   - **The offscreen document never gets the start:**
     1. In the worker, wrap `chrome.runtime.sendMessage` so that `rec-start-offscreen` rejects.
     2. Press Record.
     3. `rec` is written and then removed. The badge shows `REC`, then `!`, then nothing.
     4. In the popup, Stop is enabled and then disabled (two changes), Record comes back, and the error shows.
     5. Switch Format to PNG, turn "Copy to clipboard" on, and press Visible. Afterwards `chrome.offscreen.hasDocument()` returns `false`.
   - **A normal recording:** Record enables Stop within about a second. Stop saves the file and clears the badge. KAN-308's three cases (step 3 of `docs/KAN-308-plan.md`) give the same results as in that plan.

   A new document that never answers its ping isn't reproduced in Chrome. Only the unit tests cover that case.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `popup.js`, `tests/capture-errors.test.js`, `tests/offscreen-lifecycle.test.js` and this plan.

## Noticed while planning, not changed

- **Two starts at once could remove each other's `rec`.**
  - `startRecording` checks `rec` (`background.js:393`) and writes it (`:401`) with several awaits in between.
  - Suppose two popups press Record inside that gap, the first start writes `rec`, and the second start then fails. The second start's cleanup removes the `rec` that the first one wrote, and Stop can no longer end the first recording.
  - This needs two popups to start recordings almost at once.
- **A leftover `rec` now also brings `REC` back.**
  - After the extension is disabled and re-enabled during a recording (KAN-297), `rec` stays set with nothing recording.
  - A failed screenshot's flash then ends on `REC` instead of a blank badge.
  - KAN-297 covers removing the leftover key.

## Open questions

None.

- The ticket names both problems:
  - A failed start leaves `rec`, `REC` and an enabled Stop behind. The ticket names the two places where the failure goes unnoticed (`ensureOffscreen`'s silent give-up and the `rec-start` handler), and the popup enabling Stop without waiting.
  - A flash wipes `REC` during a recording.
- The ticket doesn't say what the popup should show for a failed start. The plan does what the popup already does for its other failures: it shows a message and brings Record back. Dropping the message would remove one line from `popup.js` and one assertion from the tests.
