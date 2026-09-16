# KAN-249: Screenshots silently do nothing when the worker's active-tab lookup comes back empty

Ticket: https://prattsolutions.atlassian.net/browse/KAN-249 (To Do, no comments, labels `bug` and `viewshot`). Nothing blocks it.

## What the repo does now

Line numbers are from `cfcc91f`, with a clean working tree. The ticket's line numbers come from an older tree, so they don't match these.

- **The popup finds the tab, but doesn't send it.**
  - `load()` looks up the tab and keeps it in `activeTab` (`popup.js:51-55`). The popup uses it for its page checks and to mint the stream id (`popup.js:103`).
  - `rec-start` carries only `streamId` and `opts` (`popup.js:110`).
  - `capture` carries only `mode` and `opts` (`popup.js:139`).
  - `activeTab` is `null` until `load()` resolves. The comment at `popup.js:14` says the worker's badge covers that gap.
- **The worker looks the tab up again.**
  - The message handler passes on only those fields (`background.js:11-12`).
  - The shortcut handler takes only the command name (`background.js:18-21`). Chrome's `commands` reference gives the callback as `(command: string, tab?: tabs.Tab) => void`, so Chrome does pass the tab, as an optional argument.
  - `getActiveTab` (`background.js:30-33`) runs `chrome.tabs.query({ active: true, currentWindow: true })`. Both `runCapture` (`background.js:86`) and `startRecording` (`background.js:382`) call it.
- **When that lookup comes back empty:**
  - **Screenshots:** `runCapture` stops at `if (!tab) return;` (`background.js:87`). `!` only flashes when `runCapture` throws (`captureFailed`, `background.js:80-83`, called from `:11` and `:20`), so nothing is saved and nothing is shown.
  - **Recordings:** `startRecording` carries on without the tab:
    - it saves `tab?.url` and `tab?.title`, so `{domain}` and `{title}` come out empty (`background.js:386`);
    - it skips the blip (`background.js:394`);
    - `getViewport(tab?.id)` returns `null` (`background.js:402`, `:416`), so `rec-start-offscreen` goes out without a size.
- **Seen in headless Chrome 152.0.7977.83** while planning.
  - **Setup:**
    - The driver from the KAN-222 check, changed to open the first popup after `Extensions.loadUnpacked`, with no warm-up popup.
    - Each run used a fresh profile and one http tab.
    - Name was set to `kan249-<mode>-{domain}-{time}`.
  - **The worker's lookup:** with that popup open, `chrome.tabs.query({ active: true, currentWindow: true })` in the worker returned `[]`. `chrome.tabs.get(<the popup's tab id>)` returned the tab, with its URL.
  - **Visible:** nothing was saved, the badge stayed clear, and the worker logged nothing.
  - **Record (WebM):** the worker logged `rec-start-offscreen sent, dims= null` and saved `kan249-webm--172608.webm`, with no domain in the name. `ffprobe` reads it as VP9 at 800×600.
- **Tests**
  - **An empty lookup:** `tests/region-dispatch.test.js` is the only test file that fakes one (`:132-134`).
    - Its "still runs the capture after acknowledging it" (`:154-160`) relies on `runCapture` stopping right after the query, and checks that the query ran.
    - That harness hands `background.js` the real `setTimeout` (`:139`).
  - **Tab ids:** no test sends one, or calls the shortcut handler with a tab.
  - **Counts:** `npm test` passes 139 tests, 33 of them in `tests/capture-errors.test.js`.

## Change

Four files change. The diffs below were applied and tested on a copy (see "Checked while planning").

1. **`background.js`:**
   - **Pass the tab id on:** the message handler hands `msg.tabId` to `runCapture` and `startRecording` (`:11-12`). The shortcut handler takes Chrome's `tab` and hands `tab?.id` to `runCapture` (`:18-21`).
   - **Look the tab up by id:** `getActiveTab(tabId)` (`:30-33`) returns `chrome.tabs.get(tabId)` when it has an id, and runs the query only when it doesn't. A comment says why.
   - **Fail visibly:** `runCapture(mode, opts, tabId)` (`:85-87`) throws when there's still no tab, so `captureFailed` flashes `!`.
   - **Recordings:** `startRecording(streamId, opts, tabId)` (`:378`) looks the tab up by id (`:382`). The comment on that line said the tab was "for the filename only". The blip and `getViewport` use it too, so the comment now says which tab it is.

   ```diff
   @@ -8,16 +8,16 @@
    // warm worker wins that race, which is why it only failed sometimes: the
    // "press Region twice" bug. The popup awaits this ack before window.close().
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
   -  if (msg?.type === 'capture') { sendResponse(true); runCapture(msg.mode, msg.opts).catch(captureFailed); }
   -  else if (msg?.type === 'rec-start') startRecording(msg.streamId, msg.opts).catch((e) => console.error('[ViewShot]', e));
   +  if (msg?.type === 'capture') { sendResponse(true); runCapture(msg.mode, msg.opts, msg.tabId).catch(captureFailed); }
   +  else if (msg?.type === 'rec-start') startRecording(msg.streamId, msg.opts, msg.tabId).catch((e) => console.error('[ViewShot]', e));
      else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
      else if (msg?.type === 'rec-cap-hit') stopRecording().then(() => flashBadge('MAX')).catch((e) => console.error('[ViewShot]', e));
      else if (msg?.type === 'rec-failed') chrome.storage.local.remove('rec').then(() => flashBadge('!'));
    });
    
   -chrome.commands.onCommand.addListener(async (cmd) => {
   +chrome.commands.onCommand.addListener(async (cmd, tab) => {
      const map = { 'capture-visible': 'visible', 'capture-fullpage': 'fullpage', 'capture-region': 'region' };
   -  if (map[cmd]) runCapture(map[cmd], await getOpts()).catch(captureFailed);
   +  if (map[cmd]) runCapture(map[cmd], await getOpts(), tab?.id).catch(captureFailed);
    });
    
    async function getOpts() {
   @@ -27,7 +27,11 @@
      return o;
    }
    
   -async function getActiveTab() {
   +// The popup and the shortcuts say which tab they mean. Asking Chrome for the
   +// active tab is only the fallback: from the worker, that query has come back
   +// empty (headless Chrome, while the first popup after a load was open).
   +async function getActiveTab(tabId) {
   +  if (tabId) return chrome.tabs.get(tabId);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    }
   @@ -82,9 +86,9 @@
      flashBadge('!').catch(() => {});
    }
    
   -async function runCapture(mode, opts) {
   -  const tab = await getActiveTab();
   -  if (!tab) return;
   +async function runCapture(mode, opts, tabId) {
   +  const tab = await getActiveTab(tabId);
   +  if (!tab) throw new Error('No tab to capture'); // flash the badge rather than do nothing
      await cancelRegion(tab); // an abandoned overlay would otherwise dim this shot
      let png;
      if (opts.hideScrollbar) { await setScrollbarHidden(tab, true); await sleep(50); /* let the bar repaint out */ }
   @@ -375,11 +379,11 @@
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
    }
    
   -async function startRecording(streamId, opts) {
   +async function startRecording(streamId, opts, tabId) {
      log('rec-start received, opts=', opts, 'streamId=', streamId);
      // The stream id is minted in the popup (under its user gesture); we just wire
      // it to the offscreen recorder, which is the only context with media APIs.
   -  const tab = await getActiveTab(); // for the filename only
   +  const tab = await getActiveTab(tabId); // the tab the popup minted the stream id for
      await ensureOffscreen();
      log('offscreen ready, sending rec-start-offscreen, format=', opts.format);
      // Persist enough to name the file at stop time, surviving a worker restart.
   ```

2. **`popup.js`:** `rec-start` (`:110`) and `capture` (`:139`) now carry `tabId`.
   - At `:110`, `activeTab` can't be `null`: `getMediaStreamId` at `:103` would already have thrown into its `catch`.
   - At `:139` it can be, when the click lands before `load()` resolves. So it sends `activeTab?.id`, and the worker falls back to its own lookup.

   ```diff
   @@ -107,7 +107,7 @@
            return; // keep the popup open so the error is visible
          }
          await save();
   -      chrome.runtime.sendMessage({ type: 'rec-start', streamId, opts });
   +      chrome.runtime.sendMessage({ type: 'rec-start', streamId, tabId: activeTab.id, opts });
          $('stopBtn').disabled = false; // popup stays open, so reflect the live recording
        } else {
          // Until "Allow access to file URLs" is on, Chrome refuses both
   @@ -136,7 +136,7 @@
          // nothing at all, and pressing Region again worked only because the second
          // press met a worker that was already awake.
          try {
   -        await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, opts });
   +        await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, tabId: activeTab?.id, opts });
          } catch (e) {
            console.error('[ViewShot] capture message failed:', e);
            showError('Couldn’t reach the extension worker. Try again.');
   ```

3. **`tests/capture-errors.test.js`:**
   - **`loadBg`** (`:21-88`):
     - A `noActiveTab` option makes `tabs.query` return `[]`.
     - A `tabs.get` fake returns `TAB` for its id. Any other id is rejected the way Chrome rejects it ("No tab with id: …").
     - It keeps `background.js`'s own message listener and its shortcut listener, and returns `message(msg)` and `command(cmd, tab)` to call them.
   - **A new section** at the end of the file, with five tests:
     1. **"the popup says which tab a screenshot or recording is for":** Visible with PNG sends `capture`, and Record with WebM sends `rec-start`. Each carries the popup's tab id.
     2. **"a screenshot uses the tab it was sent for, even when the worker finds no active tab":** a `capture` message with a `tabId` takes the shot, with no badge.
     3. **"a shortcut uses the tab Chrome hands it, even when the worker finds no active tab":** `capture-visible` with a tab takes the shot, with no badge.
     4. **"a screenshot with no tab to take flashes the badge instead of doing nothing":** a `capture` message with no `tabId`, plus an empty lookup, takes no shot and flashes `!`.
     5. **"a recording uses the tab it was sent for, even when the worker finds no active tab":** for a `rec-start` with a `tabId`:
        - the blip and `getViewport` both run in that tab;
        - `rec` is saved with the tab's URL and title;
        - `rec-start-offscreen` carries the tab's 1280×713.

   ```diff
   @@ -18,13 +18,14 @@
    
    // background.js against a fake browser. `clock` stands in for Date.now so the
    // rate-limit gate can be driven without real waiting; sleeps advance it.
   -function loadBg({ captureFails = null, captureHangs = null, scriptFails = false } = {}) {
   +function loadBg({ captureFails = null, captureHangs = null, scriptFails = false, noActiveTab = false } = {}) {
      const shots = [];
      const badges = [];
      const sleeps = [];
      const deadlines = [];
      let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      let now = 100000;
   +  let onMessage, onCommand;
    
      class FakeCanvas {
        constructor(w, h) { this.width = w; this.height = h; }
   @@ -33,10 +34,12 @@
      }
    
      const chrome = {
   -    runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => {} },
   -    commands: { onCommand: { addListener() {} } },
   +    // The first message listener is background.js's own; Region adds more later.
   +    runtime: { onMessage: { addListener: (fn) => { onMessage = onMessage || fn; }, removeListener() {} }, sendMessage: async () => {} },
   +    commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
        tabs: {
   -      query: async () => [TAB],
   +      query: async () => (noActiveTab ? [] : [TAB]),
   +      get: async (id) => { if (id !== TAB.id) throw new Error(`No tab with id: ${id}.`); return TAB; },
          captureVisibleTab: async () => {
            shots.push(now);
            if (captureHangs && captureHangs(shots.length)) return new Promise(() => {}); // Chrome never answers
   @@ -82,6 +85,8 @@
      captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      return {
        ctx: context, shots, badges, sleeps,
   +    message: (msg) => onMessage(msg, {}, () => {}),
   +    command: (cmd, tab) => onCommand(cmd, tab),
        tick: (ms) => { now += ms; },
        expire: () => deadlines.splice(0).forEach((fn) => fn()), // the capture deadline passes
      };
   @@ -605,3 +610,65 @@
      await settle();
      assert.strictEqual(o.downloads[0][0].type, 'video/webm');
    });
   +
   +// --- the worker's own active-tab lookup coming back empty ------------------
   +// The popup and the shortcuts knew which tab they meant but never said, so the
   +// worker asked Chrome for the active tab all over again. In headless Chrome
   +// that lookup came back empty while the first popup after a (re)load was open.
   +// A screenshot then did nothing at all, with no badge, and a recording started
   +// without its tab: no blip, not sized to the tab, and no {domain} or {title}
   +// for its name.
   +
   +test('the popup says which tab a screenshot or recording is for', async () => {
   +  for (const [format, type] of [['png', 'capture'], ['webm', 'rec-start']]) {
   +    const p = loadPopup('https://a.com/x');
   +    await p.ready();
   +    p.els.format.value = format; // webm turns Visible into Record
   +    await p.click('visible');
   +    assert.deepStrictEqual(p.sent.map((m) => [m.type, m.tabId]), [[type, 1]], `${type} did not name the popup's tab`);
   +  }
   +});
   +
   +test('a screenshot uses the tab it was sent for, even when the worker finds no active tab', async () => {
   +  const bg = loadBg({ noActiveTab: true });
   +  bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id });
   +  await settle();
   +  assert.strictEqual(bg.shots.length, 1, 'the screenshot was never taken');
   +  assert.deepStrictEqual(bg.badges, []);
   +});
   +
   +test('a shortcut uses the tab Chrome hands it, even when the worker finds no active tab', async () => {
   +  const bg = loadBg({ noActiveTab: true });
   +  await bg.command('capture-visible', TAB);
   +  await settle();
   +  assert.strictEqual(bg.shots.length, 1, 'the shortcut did nothing');
   +  assert.deepStrictEqual(bg.badges, []);
   +});
   +
   +test('a screenshot with no tab to take flashes the badge instead of doing nothing', async () => {
   +  const bg = loadBg({ noActiveTab: true });
   +  bg.message({ type: 'capture', mode: 'visible', opts: OPTS }); // sent before the popup had found its tab
   +  await settle();
   +  assert.strictEqual(bg.shots.length, 0);
   +  assert.deepStrictEqual(bg.badges, ['!'], 'nothing was saved, and nothing said so');
   +});
   +
   +test('a recording uses the tab it was sent for, even when the worker finds no active tab', async () => {
   +  const bg = loadBg({ noActiveTab: true });
   +  const { chrome } = bg.ctx;
   +  const targets = [];
   +  const stored = [];
   +  const sent = [];
   +  chrome.offscreen = { hasDocument: async () => true }; // already open
   +  const run = chrome.scripting.executeScript;
   +  chrome.scripting.executeScript = (o) => { targets.push(o.target.tabId); return run(o); };
   +  chrome.storage.local.set = async (o) => { stored.push({ ...o.rec }); };
   +  chrome.runtime.sendMessage = async (m) => { sent.push({ ...m }); };
   +  Object.assign(bg.ctx.window, { innerWidth: 1280, innerHeight: 713, devicePixelRatio: 1 });
   +  bg.message({ type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: TAB.id });
   +  await settle();
   +  assert.deepStrictEqual(targets, [TAB.id, TAB.id], 'the blip and the viewport read were skipped');
   +  assert.deepStrictEqual(stored, [{ url: TAB.url, title: TAB.title, format: 'webm', filename: 'x' }], 'no {domain} or {title} to name the file with');
   +  const start = sent.find((m) => m.type === 'rec-start-offscreen');
   +  assert.deepStrictEqual([start.width, start.height], [1280, 713], 'the recording was not sized to the tab');
   +});
   ```

4. **`tests/region-dispatch.test.js`** (`:132-139`):
   - **The comment** now says `runCapture` gives up right after the query, rather than returns.
   - **The timer:**
     - Giving up now flashes `!`, and `flashBadge` starts a real 3-second timer to clear it (`background.js:375`).
     - With the real `setTimeout`, that timer kept this file running for 3.1 s instead of 0.09 s.
     - The harness now calls `unref()` on its timers, so they don't hold the run open.

   ```diff
   @@ -129,14 +129,16 @@
      const chrome = {
        runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
        commands: { onCommand: { addListener() {} } },
   -    // No active tab, so runCapture returns straight after this call - enough to
   +    // No active tab, so runCapture gives up straight after this call - enough to
        // show it ran without dragging the whole capture pipeline in.
        tabs: { query: async (q) => { queries.push({ ...q }); return []; } }, // copy out of the vm realm
        storage: deep(), scripting: deep(), downloads: deep(), action: deep(), offscreen: deep(),
      };
      const context = {
        chrome, console: { ...console, error: () => {}, log: () => {}, warn: () => {} },
   -    URL, btoa, setTimeout, clearTimeout, Date,
   +    URL, btoa, clearTimeout, Date,
   +    // Giving up flashes the badge, and its 3-second reset mustn't hold the test run open.
   +    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
      };
      vm.createContext(context);
      vm.runInContext(read('background.js'), context);
   ```

Choices:

- **Say which tab, rather than change the query.**
  - The popup runs the same query and gets the tab. The worker, which has no window of its own, gets `[]`.
  - In that state, `chrome.tabs.get` with the popup's tab id found the tab.
- **Keep the query as the fallback.**
  - It still runs when a click lands before the popup's `load()` has found the tab, and when Chrome gives a shortcut no tab (`tab` is optional).
  - The comment at `popup.js:14` already leaves that gap to the worker's badge. With the throw, the badge now actually shows.
- **Send the id, not the tab.** The worker reads the tab fresh with `chrome.tabs.get`, and gets the same window, URL and title the query returned.
- **Reuse `captureFailed`.**
  - Both callers of `runCapture` already pass a throw to it. It logs the error and flashes `!`, the same as for any other failed capture.
  - That log is a `console.error`, so chrome://extensions lists it, as it does the other capture failures.
- **No new failure path for recordings.**
  - From the popup, `rec-start` now always has a tab id.
  - If that tab closes before the worker looks it up, `chrome.tabs.get` rejects before anything is set up. The handler logs that like any other failed start (see "Noticed while planning").
- **Tests go in `tests/capture-errors.test.js`.** Its `loadBg` and `loadPopup` harnesses already fake the worker and the popup. The only additions are access to the two listeners and the empty-lookup and `tabs.get` fakes.
- **No README, manifest or version change.**
  - The README's `activeTab` line ("capture the tab you clicked the icon or pressed a shortcut on") already describes this.
  - Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **As it is now:** `npm test` passes 139 tests.
  - **Test changes only:** `npm test` runs 144 tests. 139 pass, and exactly the five new ones fail:
    - "the popup says which tab a screenshot or recording is for": "capture did not name the popup's tab". The `tabId` was `undefined`.
    - "a screenshot uses the tab it was sent for, even when the worker finds no active tab": "the screenshot was never taken".
    - "a shortcut uses the tab Chrome hands it, even when the worker finds no active tab": "the shortcut did nothing".
    - "a screenshot with no tab to take flashes the badge instead of doing nothing": "nothing was saved, and nothing said so".
    - "a recording uses the tab it was sent for, even when the worker finds no active tab": "the blip and the viewport read were skipped".
  - **Both changes:** `npm test` passes 144 tests. `node --test tests/region-dispatch.test.js` takes 0.09 s; without the `unref()`, it took 3.11 s.
- **Chrome 152, changed copy,** with the same setup as above:
  - **The worker's own query** still returned `[]` in every run, so the tab id sent with the message is what found the tab.
  - **Visible:** saved `kan249-visible-127.0.0.1-172611.png` at 1280×713, with no error and no badge.
  - **Record (WebM):** the worker logged `rec-start-offscreen sent, dims= {height:713,width:1280}` and saved `kan249-webm-127.0.0.1-172618.webm`. `ffprobe` reads it as VP9 at 1278×712.
  - **The new worker with the old popup** (so no `tabId` was sent), which shows the fallback failing: Visible saved nothing, the badge showed `!`, and the worker logged `Error: No tab to capture`.
- **Not checked in Chrome:**
  - **The keyboard shortcuts.** The setup opens the popup with `Extensions.triggerAction`, and doesn't press extension shortcuts. The unit test covers that path.
  - **A normal (non-headless) window.** The ticket notes the same gap.

## Steps

1. Make the two test-file changes above.
   → verify: `npm test` runs 144 tests. 139 pass, and only these five new tests in `tests/capture-errors.test.js` fail:
   - "the popup says which tab a screenshot or recording is for"
   - "a screenshot uses the tab it was sent for, even when the worker finds no active tab"
   - "a shortcut uses the tab Chrome hands it, even when the worker finds no active tab"
   - "a screenshot with no tab to take flashes the badge instead of doing nothing"
   - "a recording uses the tab it was sent for, even when the worker finds no active tab"
2. Make the `background.js` and `popup.js` changes above.
   → verify: `npm test` passes 144 tests, which is the 139 existing ones plus the five new ones. `node --test tests/region-dispatch.test.js` finishes in well under a second.
3. Check the change in Chrome 152, with the repo loaded unpacked.
   - **Setup:** use the headless setup from step 3 of `docs/KAN-241-plan.md`:
     - set `download.default_directory` in `Default/Preferences`;
     - don't call `Browser.setDownloadBehavior`.
   - **What's different this time:**
     - **No warm-up popup.** The first popup after `Extensions.loadUnpacked` is the case under test, so start each run with a fresh profile.
     - **Name:** set it to `kan249-{domain}-{time}`, so a missing tab shows up as an empty domain.

   → verify, on an http page, from the first popup after the load:
   - **It's really the failing case:** with that popup open, `chrome.tabs.query({ active: true, currentWindow: true })` in the worker returns `[]`.
   - **Visible** saves a PNG whose name includes the page's host, with no error and no badge.
   - **Record (WebM), then Stop:**
     - the worker logs `rec-start-offscreen sent` with the tab's size, not `null`;
     - the saved `.webm` has the host in its name;
     - `ffprobe` reads it at the tab's size (1278×712 for a 1280×713 viewport), not 800×600.
   - **After a warm-up popup:** Visible, Full page, WebM and GIF all still save.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `popup.js`, `tests/capture-errors.test.js`, `tests/region-dispatch.test.js` and this plan.

## Noticed while planning, not changed

- **A recording that fails to start still leaves Stop enabled.**
  - If the tab closes between the click and the worker's lookup, `chrome.tabs.get` rejects. `startRecording` then fails before it sets anything up, and the handler only logs the error (`background.js:12`).
  - The popup has already enabled Stop by then (`popup.js:111`). That's KAN-216.

## Open questions

None. The ticket names what's missing: the tab in both messages and in the shortcut handler, and the silent return. In headless Chrome 152, the tab id finds the tab in exactly the state where the worker's query comes back empty.
