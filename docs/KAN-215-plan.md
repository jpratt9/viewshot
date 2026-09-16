# KAN-215: Starting a recording while one is running loses the first recording

Ticket: https://prattsolutions.atlassian.net/browse/KAN-215 (To Do, no comments, labels `bug` and `viewshot`). Nothing blocks it.

## What the repo does now

Line numbers are from `5023f13`, with a clean working tree. The ticket's line numbers are older: its `popup.js:49` is now `popup.js:58`, and its `background.js:349-379` is now `background.js:389-419`.

- **Popup**
  - `load()` (`popup.js:47-59`) reads `opts` and `rec` with one `chrome.storage.local.get` call (`:53`). It calls `apply()` (`:56`), which runs `toggleRec()`, and only after that sets Stop from `rec` (`:58`). Nothing else in the popup reads `rec`.
  - `toggleRec()` (`popup.js:81-87`) relabels Visible as Record for WebM, MP4 and GIF, and disables Full page and Region. It never disables Record.
  - **The click handler** (`popup.js:89-151`) returns early only when the button is disabled (`:91`). For a recording format it:
    1. awaits `getMediaStreamId` (`:103`);
    2. awaits `save()` (`:109`);
    3. sends `rec-start` (`:110`);
    4. enables Stop (`:111`).

    A second press during either await goes through the same steps.
  - **Stop** (`popup.js:153`) sends `rec-stop` and disables itself. `popup.html:56` ships Stop disabled.
- **Worker:** `startRecording` (`background.js:389-419`) never reads `rec`:
  - it overwrites the key (`:397`);
  - it sets the `REC` badge (`:398-399`);
  - it sends `rec-start-offscreen` (`:414-417`).

  If the start fails, the `rec-start` handler only logs the error (`background.js:12`).
- **Offscreen document:** `startRecording` (`offscreen.js:31-116`) doesn't check `rec` either, and replaces it at `offscreen.js:46`.
  - The GIF frame timer reads the global `rec` (`offscreen.js:75-93`).
  - `stopRecording` (`offscreen.js:118-145`) only stops the recording held in `rec`.
  - A thrown error goes to `onRecError` (`offscreen.js:175-179`), whose `teardown()` stops whatever recording `rec` holds (`offscreen.js:168-173`).
- **Reproduced in headless Chrome 152.0.7977.83** while planning. The setup is under "Checked while planning".
  - **Recording over a running one:**
    - With a WebM recording running on PageA, a popup opened on PageB showed both Record and Stop enabled.
    - Pressing Record there started a second recording, and `rec` switched to PageB.
    - Stop then saved only `PageB.webm` (1.8 s of video). PageA's recording was never saved.
  - **Two presses of Record in the same task,** in a new popup on PageC:
    - the worker got two `rec-start` messages;
    - the offscreen document logged `[ViewShot] recording failed: AbortError: Invalid state`;
    - Stop saved nothing at all.
- **Tests:** `npm test` passes 148 tests.
  - `tests/capture-errors.test.js` has harnesses for all three files: `loadBg` (`:21-97`), `loadPopup` (`:236-278`) and `loadOffscreen` (`:463-501`).
  - **Its `loadPopup`:**
    - storage always returns `{}` (`:264`);
    - every `document.querySelector` call returns a new element (`:259`), so `toggleRec()` never touches the buttons the tests click;
    - every element starts enabled (`:242`). That includes Stop, which `popup.html` ships disabled.

## Change

Four files change: `popup.js`, `background.js`, `offscreen.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy (see "Checked while planning").

1. **`popup.js`:**
   - **`load()`** (`:55-58`): set Stop before `apply()`, so that `toggleRec()` can tell whether a recording is running.
   - **`toggleRec()`** (`:81-87`): when a recording format is selected, disable Record while Stop is enabled.
   - **The click handler** (`:97-108`): disable Record before the first await. If `getMediaStreamId` fails, call `toggleRec()` to enable Record again.
   - **Stop** (`:153`): call `toggleRec()` after Stop disables itself, so Record is enabled again.

   ```diff
   @@ -53,9 +53,10 @@
        chrome.storage.local.get(['opts', 'rec']),
      ]);
      [activeTab] = tabs;
   -  apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
      // The Stop button stays greyed out unless a recording is actually running.
   +  // Set before apply(), whose toggleRec() greys Record out from it.
      $('stopBtn').disabled = !stored.rec;
   +  apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
    }
    
    function read() {
   @@ -78,11 +79,14 @@
    
    // Recording captures the whole visible tab, so full-page/region don't apply —
    // disable them and relabel the "Visible" button as "Record" for video formats.
   +// Record is greyed out too while a recording runs (Stop enabled): a second
   +// start would record over that one, and it would be lost.
    function toggleRec() {
      const rec = isRecFmt($('format').value);
      const vis = document.querySelector('.mode[data-mode="visible"]');
      vis.querySelector('.lbl').textContent = rec ? 'Record' : 'Visible';
      vis.querySelector('.ico').textContent = rec ? '●' : '▢';
   +  vis.disabled = rec && !$('stopBtn').disabled;
      document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = rec; });
    }
    
   @@ -95,6 +99,9 @@
        }
        const opts = read();
        if (isRecFmt(opts.format)) {
   +      // Greyed out before the first await: a second press while this one waits
   +      // would start a second recording over it.
   +      btn.disabled = true;
          // Mint the capture stream id HERE, while the click's user gesture is still
          // live — getMediaStreamId rejects without it, and the background worker
          // (a plain message handler) has no gesture to offer.
   @@ -104,6 +111,7 @@
          } catch (e) {
            console.error('[ViewShot] getMediaStreamId failed:', e);
            showError('Can’t record this tab. Open a normal http(s) page and try again.');
   +        toggleRec(); // nothing is recording, so Record comes back
            return; // keep the popup open so the error is visible
          }
          await save();
   @@ -150,7 +158,7 @@
      });
    });
    
   -$('stopBtn').addEventListener('click', () => { if ($('stopBtn').disabled) return; chrome.runtime.sendMessage({ type: 'rec-stop' }); $('stopBtn').disabled = true; });
   +$('stopBtn').addEventListener('click', () => { if ($('stopBtn').disabled) return; chrome.runtime.sendMessage({ type: 'rec-stop' }); $('stopBtn').disabled = true; toggleRec(); });
    
    $('format').addEventListener('change', () => { toggleQuality(); toggleRec(); save(); });
    $('quality').addEventListener('input', () => { $('qualityVal').textContent = Math.round($('quality').value * 100) + '%'; });
   ```

2. **`background.js`:** at the top of `startRecording` (after `:390`), if `rec` is set, log a warning and return before anything is written or sent.

   ```diff
   @@ -388,6 +388,10 @@
    
    async function startRecording(streamId, opts, tabId) {
      log('rec-start received, opts=', opts, 'streamId=', streamId);
   +  // One recording at a time. Starting another would overwrite `rec`, and the
   +  // offscreen document would lose the recording already running.
   +  const { rec } = await chrome.storage.local.get('rec');
   +  if (rec) { console.warn('[ViewShot] a recording is already running; not starting another'); return; }
      // The stream id is minted in the popup (under its user gesture); we just wire
      // it to the offscreen recorder, which is the only context with media APIs.
      const tab = await getActiveTab(tabId); // the tab the popup minted the stream id for
   ```

3. **`offscreen.js`:** at the top of `startRecording` (after `:31`), if `rec` is set, log a warning and return before `getUserMedia` is called.

   ```diff
   @@ -29,6 +29,9 @@
    let rec = null; // { stream, format, recorder?, chunks?, gif?, timer?, frames? }
    
    async function startRecording(streamId, format, width, height) {
   +  // One recording at a time: replacing `rec` would leave the one already
   +  // running with nothing that can stop or save it.
   +  if (rec) { console.warn('[ViewShot] a recording is already running; not starting another'); return; }
      // tabCapture ids are redeemed only through this legacy constraints form.
      // Pin min/max width+height to the actual tab dims so Chrome's tabCapture
      // pipeline doesn't letterbox the output (default behavior is to scale to a
   ```

4. **`tests/capture-errors.test.js`:**
   - **`loadPopup()`** (`:236-278`):
     - A `store` option, which storage returns as `opts` and `rec`.
     - Stop starts disabled, as it does in `popup.html`.
     - `querySelector` returns the mode button that the test clicks.
     - It also returns `btn(mode)` and `stop()`.
   - **A new section at the end** (after `:700`) with eight tests:
     - **Popup:**
       - "Record is greyed out while a recording is running"
       - "Visible still takes a screenshot while a recording is running"
       - "Record stays greyed out once it has started a recording, until Stop"
       - "pressing Record twice in quick succession starts one recording"
       - "Record comes back when the tab can't be recorded"
     - **Worker:** "the worker won't start a recording over one that is running"
     - **Offscreen document:**
       - "a second start leaves a running WebM recording to be saved"
       - "a second start leaves a running GIF recording in place"

   ```diff
   @@ -233,7 +233,7 @@
    
    // --- the popup says which page it was --------------------------------------
    
   -function loadPopup(url, { fileAccess = true, streamIdFails = false } = {}) {
   +function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {} } = {}) {
      const els = {};
      const sent = [];
      const makeEl = () => {
   @@ -251,17 +251,20 @@
        el.dataset.mode = m;
        return el;
      });
   +  els.stopBtn = makeEl();
   +  els.stopBtn.disabled = true; // as popup.html has it
      const context = {
        console: { ...console, error: () => {} }, Math, parseFloat, JSON,
        window: { close: () => {} },
        document: {
          getElementById: (id) => (els[id] = els[id] || makeEl()),
   -      querySelector: () => makeEl(),
   +      // toggleRec() asks for the Visible/Record button: hand back the one the test clicks.
   +      querySelector: (sel) => modes.find((b) => sel.includes(`"${b.dataset.mode}"`)) || makeEl(),
          querySelectorAll: (sel) => (sel.includes('#modes') ? modes : []),
        },
        chrome: {
          tabs: { query: async () => [{ id: 1, url, title: 'T' }], create: () => {} },
   -      storage: { local: { get: async () => ({}), set: async () => {} } },
   +      storage: { local: { get: async () => store, set: async () => {} } }, // `opts` and `rec`
          runtime: { sendMessage: async (m) => { sent.push(m); return true; } },
          tabCapture: { getMediaStreamId: async () => { if (streamIdFails) throw new Error('stream id refused'); return 'sid'; } },
          extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
   @@ -270,10 +273,12 @@
      };
      vm.createContext(context);
      vm.runInContext(read('popup.js'), context);
   +  const btn = (mode) => modes.find((b) => b.dataset.mode === mode);
      return {
   -    els, sent,
   +    els, sent, btn,
        ready: settle, // let load() resolve so activeTab is populated
   -    click: (mode) => modes.find((b) => b.dataset.mode === mode).listeners.click[0](),
   +    click: (mode) => btn(mode).listeners.click[0](),
   +    stop: () => els.stopBtn.listeners.click[0](),
      };
    }
    
   @@ -698,3 +703,91 @@
      assert.strictEqual(stored.length, 0, 'marked as recording with nothing recording');
      assert.deepStrictEqual(bg.badges, [], 'REC went up for a recording that never started');
    });
   +
   +// --- a second recording started over the first ------------------------------
   +// Record stayed enabled while a recording ran, and nothing further along
   +// checked either: the worker overwrote `rec`, and the offscreen document
   +// replaced its own `rec`, leaving the recording already running with nothing
   +// that could stop or save it. Stop then saved only the second recording.
   +
   +const RUNNING = { url: 'https://b.com', title: 'B', format: 'webm', filename: 'y' };
   +
   +test('Record is greyed out while a recording is running', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
   +  await p.ready();
   +  assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over a running recording');
   +  await p.click('visible');
   +  assert.deepStrictEqual(p.sent, [], 'a second recording was started');
   +});
   +
   +test('Visible still takes a screenshot while a recording is running', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'png' }, rec: RUNNING } });
   +  await p.ready();
   +  await p.click('visible');
   +  assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture']);
   +});
   +
   +test('Record stays greyed out once it has started a recording, until Stop', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
   +  await p.ready();
   +  await p.click('visible');
   +  assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over the recording it started');
   +  await p.click('visible');
   +  p.stop();
   +  assert.strictEqual(p.btn('visible').disabled, false, 'Stop left Record greyed out');
   +  await p.click('visible');
   +  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start', 'rec-stop', 'rec-start']);
   +});
   +
   +test('pressing Record twice in quick succession starts one recording', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
   +  await p.ready();
   +  await Promise.all([p.click('visible'), p.click('visible')]);
   +  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], 'the second press started another recording');
   +});
   +
   +test('Record comes back when the tab can\'t be recorded', async () => {
   +  const p = loadPopup('https://a.com/x', { streamIdFails: true, store: { opts: { format: 'webm' } } });
   +  await p.ready();
   +  await p.click('visible');
   +  assert.strictEqual(p.els.err.hidden, false);
   +  assert.strictEqual(p.btn('visible').disabled, false, 'a start that failed left Record greyed out');
   +});
   +
   +test('the worker won\'t start a recording over one that is running', async () => {
   +  const bg = loadBg();
   +  const { chrome } = bg.ctx;
   +  const stored = [];
   +  const sent = [];
   +  chrome.offscreen = { hasDocument: async () => true }; // open, and recording
   +  chrome.storage.local.get = async () => ({ rec: RUNNING });
   +  chrome.storage.local.set = async (o) => { stored.push(o); };
   +  chrome.runtime.sendMessage = async (m) => { sent.push(m); };
   +  bg.message({ type: 'rec-start', streamId: 'sid2', opts: { ...OPTS, format: 'gif' }, tabId: TAB.id });
   +  await settle();
   +  assert.deepStrictEqual(stored, [], 'the running recording\'s `rec` was overwritten');
   +  assert.deepStrictEqual(sent, [], 'the offscreen document was told to start another recording');
   +});
   +
   +test('a second start leaves a running WebM recording to be saved', async () => {
   +  const o = loadOffscreen();
   +  await o.ctx.startRecording('sid', 'webm', 100, 100);
   +  const first = o.recorders[0];
   +  first.flush({ size: 10 });
   +  await o.ctx.startRecording('sid2', 'webm', 100, 100);
   +  assert.strictEqual(o.recorders.length, 1, 'a second recorder was started over the first');
   +  o.ctx.stopRecording('out.webm');
   +  first.finish();
   +  await settle();
   +  assert.strictEqual(o.downloads.length, 1, 'the first recording was never saved');
   +  assert.strictEqual(o.downloads[0][0].parts.length, 1);
   +});
   +
   +test('a second start leaves a running GIF recording in place', async () => {
   +  const o = loadOffscreen();
   +  vm.runInContext("rec = { format: 'gif', gif: {}, frames: 5 }", o.ctx); // what its frame timer reads
   +  const running = vm.runInContext('rec', o.ctx);
   +  await o.ctx.startRecording('sid2', 'webm', 100, 100);
   +  assert.strictEqual(vm.runInContext('rec', o.ctx), running, 'the GIF\'s frame timer now reads the new recording');
   +  assert.strictEqual(o.recorders.length, 0, 'a second recording was started');
   +});
   ```

Choices:

- **Record is disabled while a recording runs.** It doesn't stop the running recording and start a new one. The ticket names the enabled Record button as the fault, and Full page and Region are already disabled the same way for recording formats.
- **The popup uses Stop's state to mean "a recording is running".** `load()` already sets Stop from `rec`, and from then on Record and Stop change together. This needs no new variable.
- **Record is disabled as the click starts, not after `rec-start` is sent.**
  - Disabling it later leaves both awaits open to a second press. With the change in that form, "pressing Record twice in quick succession starts one recording" fails.
  - In Chrome, the unchanged copy lost the recording entirely on a double press.
  - If `getMediaStreamId` fails, `toggleRec()` enables Record again.
- **The worker and the offscreen document check as well.**
  - **Why the worker checks:** the popup reads `rec` only when it opens, so a popup opened just before the key is written still shows Record enabled. The worker's check covers anything that gets past the popup.
  - **Why the offscreen document checks:** it holds the recording itself, so its check protects that recording whatever message arrives.
  - **Both log a warning and return:**
    - `stopRecording` already handles a stop with nothing recording the same way (`background.js:477`).
    - chrome://extensions lists every `console.error` from the worker as an extension error.
    - Flashing `!` would clear the badge 3 s later, so `REC` would vanish while the first recording is still running (KAN-216).
  - **The offscreen check returns rather than throwing.** A throw goes to `onRecError`, and its `teardown()` would stop the recording this check is protecting.
- **Screenshots still work during a recording.** Only Record is disabled. With a still format selected, the button reads Visible and stays enabled.
- **The popup doesn't watch `rec` while it's open.** A recording can end on its own: the tab closes, the user clicks Chrome's "Stop sharing", the GIF reaches its frame cap, or the recording fails. Record then stays disabled, and Stop stays enabled, until the popup is reopened or Stop is pressed. Stop already behaves that way today.
- **The tests go in `tests/capture-errors.test.js`.** It already has harnesses for all three files, and the other recording tests (tab closed, MP4, the tab id) are there too.
- **`loadPopup()` starts Stop disabled, as `popup.html` does.** Without that, the harness can't catch a `load()` that sets Stop after `apply()` (see variant 5 below).
- **No README, manifest or version change.**
  - The README already says `storage` remembers "whether a recording is running" (`README.md:24`).
  - Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **As it is now:** `npm test` passes 148 tests.
  - **Test changes only:** 156 tests run. 150 pass, and exactly six of the new ones fail, each with its own message (listed in step 1).
  - **Both changes:** 156 tests pass.
  - **Both changes, with one piece left out:**
    1. **Record disabled only after `rec-start` is sent** (`toggleRec()` after `:111`), instead of as the click starts: only "pressing Record twice in quick succession starts one recording" fails.
    2. **No `toggleRec()` after a failed `getMediaStreamId`:** only "Record comes back when the tab can't be recorded" fails.
    3. **No check in `offscreen.js`:** only the two offscreen tests fail.
    4. **No check in `background.js`:** only "the worker won't start a recording over one that is running" fails.
    5. **Stop still set after `apply()`:** only "Record is greyed out while a recording is running" fails.
- **Headless Chrome 152.0.7977.83,** comparing a copy with only the test changes ("unchanged") against a copy with both changes ("changed"):
  - **Setup:**
    - The headless setup from step 3 of `docs/KAN-217-plan.md`:
      - `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging`;
      - a temporary profile with `download.default_directory` set;
      - `Extensions.loadUnpacked`, `Target.createTarget({ url, forTab: true })` and `Extensions.triggerAction`;
      - one warm-up popup.
    - **Pages:** three local http pages, PageA, PageB and PageC, each with a counter that changes every 50 ms.
    - **Popup settings:** format WebM, Name `{title}`.
    - **Clicks:** buttons were clicked with `Runtime.evaluate` and `userGesture: true`.
    - **Logs:** console output from the worker and the offscreen document was collected over CDP.
  - **Results:**

    | Step | Unchanged | Changed |
    |---|---|---|
    | Record on PageA, then open a popup on PageB | Record enabled, Stop enabled | Record disabled, Stop enabled |
    | Press Record on PageB | The worker gets `rec-start`, and `rec` switches to PageB | Nothing is sent, and `rec` stays on PageA |
    | From that popup, mint a new stream id for PageB and send `rec-start` directly | Not run | The worker logs "a recording is already running; not starting another". `rec` and the `REC` badge don't change |
    | From that popup, send `rec-start-offscreen` directly | Not run | The offscreen document logs the same warning, and `getUserMedia` isn't called again |
    | Stop on PageB | Saves `PageB.webm` (1.8 s of video). PageA's recording is lost | Saves `PageA.webm` (6.6 s, the whole run). Record is enabled again |
    | Record on PageB again, select PNG and press Visible, select WebM again, then Stop | Record stays enabled while recording | Record is disabled while recording. With PNG selected, Visible is enabled and saves `PageB-shot.png`. With WebM selected again, Record is disabled again. Stop saves `PageB.webm` |
    | In a new popup on PageC, press Record twice in the same task, then Stop | The worker gets two `rec-start` messages. The offscreen document logs `recording failed: AbortError: Invalid state`, and nothing is saved | The worker gets one `rec-start`, and Stop saves `PageC.webm` |
    | Record on PageC again straight after that Stop, then Stop. The same again 5 s later | Both recordings start and are saved | Both recordings start and are saved (`PageC (1).webm`, `PageC (2).webm`) |

  - In the changed copy, neither the worker nor the offscreen document logged an error.
  - **Not checked in Chrome:**
    - Record being enabled again after `getMediaStreamId` fails. The unit test covers it.
    - A GIF as the recording that is already running. The offscreen unit test covers a GIF held in `rec`.
    - A non-headless window.

## Steps

1. Make the `tests/capture-errors.test.js` changes above.
   → verify: `npm test` runs 156 tests. 150 pass, and only these six new tests fail:
   - "Record is greyed out while a recording is running", with "Record was left enabled over a running recording"
   - "Record stays greyed out once it has started a recording, until Stop", with "Record was left enabled over the recording it started"
   - "pressing Record twice in quick succession starts one recording", with "the second press started another recording"
   - "the worker won't start a recording over one that is running", with "the running recording's \`rec\` was overwritten"
   - "a second start leaves a running WebM recording to be saved", with "a second recorder was started over the first"
   - "a second start leaves a running GIF recording in place", with "the GIF's frame timer now reads the new recording"
2. Make the `popup.js`, `background.js` and `offscreen.js` changes above.
   → verify: `npm test` passes 156 tests: the 148 existing ones plus the eight new ones.
3. Check the change in Chrome 152, with the repo loaded unpacked.
   - **Setup:** the headless setup under "Checked while planning", with three http pages. Use format WebM and Name `{title}`.

   → verify:
   - **Popup during a recording:** with a recording running on one page, a popup on another page shows Record disabled and Stop enabled. Pressing Record there sends nothing.
   - **Stop:** Stop saves the first page's recording, and Record is enabled again in that popup.
   - **Worker check:** a `rec-start` sent directly from the popup during a recording makes the worker log "[ViewShot] a recording is already running; not starting another", and `rec` doesn't change.
   - **Offscreen check:** a `rec-start-offscreen` sent the same way makes the offscreen document log that warning, and `getUserMedia` isn't called again.
   - **Screenshots during a recording:** with PNG selected, Visible saves a screenshot.
   - **Double press:** pressing Record twice in the same task starts one recording, and Stop saves it.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `background.js`, `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **The popup doesn't find out when a recording ends on its own.** Record and Stop keep their state until the popup is reopened or Stop is pressed (see Choices).
- **"Cannot capture a tab with an active stream."**
  - **When it happened:** once, in the unchanged copy. Record was pressed on PageB straight after Stop had saved PageB's recording, and `getMediaStreamId` failed with this error.
  - **When it didn't:**
    - a second run of the unchanged copy;
    - the changed copy, which recorded the same tab again both straight after Stop and 5 s later.

## Open questions

1. **Is it OK that a stale `rec` now keeps Record disabled until Stop is pressed?**
   - **When `rec` goes stale:** the extension is disabled and re-enabled during a recording (KAN-297). The key stays set with nothing recording.
   - **Before this change:** Stop was enabled, and Record still worked. Starting a recording overwrote the stale key.
   - **With this change:**
     - Record stays disabled until Stop is pressed.
     - Pressing Stop removes the key, and the worker logs KAN-297's "Could not establish connection" error (`background.js:13`). Record is then enabled again.
     - This comes from reading the code. It wasn't checked in Chrome.
   - **Keeping Record usable** in that state would take KAN-297's fix, such as checking that the offscreen document exists before trusting `rec`. The steps above don't do that.
