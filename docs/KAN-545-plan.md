# KAN-545: A popup opened while a capture is running doesn't show it and leaves its buttons enabled

Ticket: https://prattsolutions.atlassian.net/browse/KAN-545. It is a To Do Task labelled `bug` and `viewshot`, with no comments. It was blocked by KAN-220, which is Done.

## What the repo does now

As of `440d75d`:

- **Only the popup that sent a Visible or Full page hears about it.**
  - Its `capturing` flag (`popup.js:8`) is set by its own press (`:179`) and cleared by the worker's answer (`:211`).
  - It shows `capture-progress` only while that flag is set, and only its own capture's (`:262`, KAN-552).
  - The result is the answer to its own `capture` message (`background.js:16-19`), shown at `popup.js:213-214`.
- **A popup doesn't ask what is running when it opens.**
  - `load()` reads only `opts` and `rec` (`popup.js:58-76`).
  - At startup it sends only `rec-check`, un-awaited so the popup never waits on the worker (`:247-253`).
  - The worker's listener has no message that says whether a capture is running (`background.js:10-76`).
- **So a popup opened during a capture it didn't send knows nothing of it.** That is a popup reopened partway through a Full page, or one opened during a shortcut's capture (`background.js:111`).
  - `toggleRec` (`popup.js:106-113`) leaves its three mode buttons enabled.
  - A press there no longer runs on top of the capture. Since KAN-213 it waits its turn on `runGate` (`background.js:246-284`).
- **Captures take turns** (`background.js:257-284`), so any `capture-progress` comes from the one capture that is running.
- **Region's `runCapture` ends once its overlay is up** (`background.js:264-269`). Its shot comes with `shot-region` after the drag (`:37-62`). Opening a popup takes the focus from the page, which cancels the overlay (`region.js:31-35`).
- **Tests:** `npm test` runs 384 tests, and all pass.
  - Four harnesses load `popup.js`, and each answers every message the popup sends:
    - `tests/capture-errors.test.js:305` answers with `reply`, which is `true` by default;
    - `tests/region-cancel.test.js:197`;
    - `tests/region-dispatch.test.js:73`;
    - `tests/defaults.test.js:66`.

    All but the last keep `rec-check` out of `sent`.
  - The worker harness in `tests/shortcut-format.test.js:31` has no `chrome.runtime.sendMessage`.
  - "names the popup that asked for the full page in its progress, and none for a shortcut's" (`tests/fullpage.test.js:1075-1082`) checks every message the worker sends while `runCapture` runs.
  - No test opens a popup during a capture it didn't send.

## Change

Seven files change: `background.js`, `popup.js` and five test files. `popup.html`, `popup.css`, `offscreen.js`, `region.js`, `README.md`, `manifest.json` and `package.json` don't change.

1. **`background.js`:**
   - `shooting` says whether a Visible or Full page is taking its turn. It is set when one's turn starts and cleared when it ends (`:257-284`).
   - A popup asks with `capture-check` as it opens, and is answered with `shooting` (after `:19`).
   - When a Visible or Full page ends, `capture-done` goes out to every popup. It carries `toClipboard`, plus the error text if the capture failed. Like `capture-progress` (`:438`), it isn't waited for, and nothing may be listening.

   ```diff
   @@ -18,4 +18,8 @@ chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        return true;
      }
   +  // A popup asks as it opens. A capture it didn't send - from a popup closed
   +  // since, or a shortcut - is shown there too, with its buttons greyed out
   +  // until that capture has ended (KAN-545).
   +  else if (msg?.type === 'capture-check') sendResponse(shooting);
      else if (msg?.type === 'rec-start') {
   @@ -256,6 +260,14 @@ function captureFailed(e) {
    // shot that never answers can't hold the others up for good.
    let runGate = Promise.resolve();
   +// Whether a Visible or Full page is taking its turn, for a popup that opens
   +// during it (KAN-545). Only the popup that sent a capture hears how it went,
   +// in its answer, so the end of each one also goes out to every popup, for one
   +// opened since. Nothing may be listening, as with its progress. A Region is
   +// neither: its runCapture ends with the overlay up, and its shot waits for the
   +// drag.
   +let shooting = false;
    function runCapture(mode, opts, tabId, popupId) {
      const run = runGate.then(async () => {
   +    if (mode !== 'region') shooting = true;
        const tab = await getActiveTab(tabId);
   @@ -280,4 +292,8 @@ function runCapture(mode, opts, tabId, popupId) {
        await saveCapture(png, opts, tab);
      });
   +  if (mode !== 'region') {
   +    const done = (error) => { shooting = false; chrome.runtime.sendMessage({ type: 'capture-done', toClipboard: opts.toClipboard, error }).catch(() => {}); };
   +    run.then(() => done(), (e) => done(e.message || String(e)));
   +  }
      runGate = run.catch(() => {}); // one capture's failure must not stall the next
      return run;
   ```

2. **`popup.js`:**
   - A `watching` flag goes beside `capturing` (`:8`). `toggleRec` greys out all three mode buttons while it is set (`:103-113`).
   - The popup sends `capture-check` as it opens. It goes beside `rec-check`, un-awaited like it (`:253`).
   - If the answer says a capture is running, and this popup hasn't sent one of its own meanwhile, the popup sets `watching`, greys out its buttons and shows "Capturing…".
   - While `watching` is set, the popup shows every `capture-progress` (`:262`).
   - `capture-done` clears `watching` and gives the buttons back. It shows "Saved.", "Copied to the clipboard." or the error text, as the popup that sent the capture does (`:213-214`).

   ```diff
   @@ -7,4 +7,5 @@ const edited = new Set(); // input can precede change while startup is pending
    let ready = false;
    let capturing = false; // a Visible or Full page this popup sent hasn't been answered yet (KAN-220)
   +let watching = false; // one it didn't send was running as it opened, and hasn't ended (KAN-545)
    const popupId = crypto.randomUUID(); // sent with this popup's captures; a Full page's progress carries it back (KAN-552)
   @@ -103,5 +104,6 @@
    // Record is greyed out too while a recording runs (Stop enabled): a second
    // start would record over that one, and it would be lost. All three are
   -// greyed out while a capture this popup sent is running (KAN-220).
   +// greyed out while a capture this popup sent is running (KAN-220), and while
   +// one it found running as it opened is (KAN-545).
    function toggleRec() {
   @@ -109,6 +111,6 @@ function toggleRec() {
   -  vis.disabled = !ready || capturing || rec && !$('stopBtn').disabled;
   -  document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = !ready || capturing || rec; });
   +  vis.disabled = !ready || capturing || watching || rec && !$('stopBtn').disabled;
   +  document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = !ready || capturing || watching || rec; });
    }
   @@ -252,4 +254,9 @@ paintFromCache(); // synchronous: correct UI in the first frame
    chrome.runtime.sendMessage({ type: 'rec-check' }).catch(() => { /* a worker that can't answer has no recording in it either */ });
   +// A Visible or Full page this popup didn't send may be running: the popup that
   +// sent it was closed, or a shortcut started it. This popup shows it too, and
   +// keeps its buttons greyed out until it ends (KAN-545). A press that got in
   +// before the answer has a capture of its own to show.
   +chrome.runtime.sendMessage({ type: 'capture-check' }).then((running) => { if (running && !capturing) { watching = true; toggleRec(); showStatus('Capturing…'); } }).catch(() => { /* a worker that can't answer has no capture running in it either */ });
    const startup = load().catch(() => {
   @@ -259,6 +266,11 @@ chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // How far a Full page has got (KAN-220). Only this popup's own capture's: the
      // worker sends it for a shortcut's capture too, and for one this popup's is
   -  // waiting behind (KAN-552).
   -  if (msg?.type === 'capture-progress') { if (capturing && msg.popupId === popupId) showStatus(`Capturing screen ${msg.screen} of ${msg.screens}…`); return; }
   +  // waiting behind (KAN-552). A popup that found a capture running as it
   +  // opened shows that one's, the only capture running (KAN-545).
   +  if (msg?.type === 'capture-progress') { if (capturing ? msg.popupId === popupId : watching) showStatus(`Capturing screen ${msg.screen} of ${msg.screens}…`); return; }
   +  // How the capture this popup found running as it opened ended (KAN-545). A
   +  // capture this popup sent is answered instead, and one that ends while this
   +  // popup's waits its turn isn't its own.
   +  if (msg?.type === 'capture-done') { if (watching) { watching = false; toggleRec(); if (msg.error) showError(msg.error); else showStatus(msg.toClipboard ? 'Copied to the clipboard.' : 'Saved.'); } return; }
      if (msg?.type === 'shot-clipboard') {
   ```

3. **`tests/capture-errors.test.js`:**
   - `loadPopup` answers `capture-check` with a new `running` option, `false` by default, and keeps it out of `sent`, like `rec-check` (`:261`, `:303-305`). `running` can be a promise, so a test can hold the answer back.
   - Seven tests go at the end: three for the worker and four for the popup.

   ```diff
   @@ -260,3 +260,3 @@
   -function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true, scriptError } = {}) {
   +function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true, scriptError, running = false } = {}) {
   @@ -303,4 +303,5 @@
          // the worker's answer. The popup's startup rec-check is the worker's
   -      // business, not this file's, so it is left out of `sent`.
   -      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, sendMessage: async (m) => { if (m.type !== 'rec-check') sent.push(m); if (reply instanceof Error) throw reply; return reply; } },
   +      // business, not this file's, so it is left out of `sent`. So is its
   +      // capture-check, which the worker answers with `running` (KAN-545).
   +      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, sendMessage: async (m) => { if (m.type === 'capture-check') return running; if (m.type !== 'rec-check') sent.push(m); if (reply instanceof Error) throw reply; return reply; } },
   ```

   ```js
   // --- a popup opened while a capture runs (KAN-545) --------------------------
   // Only the popup that sent a Visible or Full page heard how it went. A popup
   // opened during one - after the popup that sent it was closed, or during a
   // shortcut's - showed nothing of it and left its buttons live.

   // The worker's answer to the capture-check a popup sends as it opens.
   const checkCapture = (bg) => { let answer; bg.message({ type: 'capture-check' }, (a) => { answer = a; }); return answer; };

   test('tells a popup that opens whether a Visible or Full page is running', async () => {
     const bg = loadBg({ captureHangs: () => true }); // the shot waits for its deadline
     assert.strictEqual(checkCapture(bg), false, 'nothing is running yet');
     const run = bg.ctx.runCapture('visible', OPTS, TAB.id); // as a shortcut starts it
     await settle();
     assert.strictEqual(checkCapture(bg), true, 'a popup opened now would leave its buttons live');
     bg.expire();
     await assert.rejects(run, /did not answer/);
     assert.strictEqual(checkCapture(bg), false, 'still running once it had ended');
   });

   test('tells every popup how a Visible or Full page ended', async () => {
     const bg = loadBg({ captureFails: (n) => n === 3 && 'Tabs cannot be edited right now' });
     const sent = [];
     // An open popup answers the worker's clipboard write.
     bg.ctx.chrome.runtime.sendMessage = async (m) => { sent.push(JSON.parse(JSON.stringify(m))); return m.type === 'shot-clipboard' ? 'done' : undefined; }; // copy out of the vm realm
     await bg.ctx.runCapture('visible', OPTS, TAB.id);
     await bg.ctx.runCapture('visible', { ...OPTS, toClipboard: true }, TAB.id);
     await assert.rejects(bg.ctx.runCapture('visible', OPTS, TAB.id));
     assert.deepStrictEqual(sent.filter((m) => m.type === 'capture-done'), [
       { type: 'capture-done', toClipboard: false },
       { type: 'capture-done', toClipboard: true },
       { type: 'capture-done', toClipboard: false, error: 'Tabs cannot be edited right now' },
     ]);
   });

   test('says nothing of a Region, whose shot waits for the drag', async () => {
     const bg = loadBg();
     const sent = [];
     bg.ctx.chrome.runtime.sendMessage = async (m) => { sent.push(m.type); };
     await bg.ctx.runCapture('region', OPTS, TAB.id); // its overlay is up
     assert.strictEqual(checkCapture(bg), false, 'a popup opened now would wait on a shot that comes only after the drag');
     assert.deepStrictEqual(sent, [], 'said the Region had ended before its shot was taken');
   });

   test('a popup opened during a capture it didn\'t send shows it, with its buttons greyed out', async () => {
     for (const popupId of ['popup-0', undefined]) { // from a popup closed since, and from a shortcut
       const p = loadPopup('https://a.com/x', { running: true });
       await p.ready();
       assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [true, true, true], 'a press would start another capture');
       assert.strictEqual(p.els.status.textContent, 'Capturing…');
       p.message({ type: 'capture-progress', popupId, screen: 3, screens: 12 });
       assert.strictEqual(p.els.status.textContent, 'Capturing screen 3 of 12…');
       p.message({ type: 'capture-done', toClipboard: false });
       assert.strictEqual(p.els.status.textContent, 'Saved.');
       assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
     }
   });

   test('a popup opened during a capture says it was copied, or shows its error', async () => {
     const p = loadPopup('https://a.com/x', { running: true });
     await p.ready();
     p.message({ type: 'capture-done', toClipboard: true });
     assert.strictEqual(p.els.status.textContent, 'Copied to the clipboard.');
     const q = loadPopup('https://a.com/x', { running: true });
     await q.ready();
     q.message({ type: 'capture-done', toClipboard: false, error: 'Full page stopped: another tab is now showing' });
     assert.strictEqual(q.els.err.hidden, false);
     assert.strictEqual(q.els.err.textContent, 'Full page stopped: another tab is now showing');
     assert.strictEqual(q.els.status.hidden, true, 'still said it was capturing');
     assert.deepStrictEqual(MODES.map((m) => q.btn(m).disabled), [false, false, false]);
   });

   test('a popup whose own capture waits its turn shows no other capture\'s end', async () => {
     let answer;
     const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
     await p.ready();
     const done = p.click('fullpage');
     await settle();
     p.message({ type: 'capture-done', toClipboard: false, error: 'Tabs cannot be edited right now' }); // the shortcut's capture this one waits behind
     assert.strictEqual(p.els.status.textContent, 'Capturing…', 'showed another capture\'s end as its own');
     assert.strictEqual(p.els.err.hidden, true, 'showed another capture\'s error as its own');
     answer(true);
     await done;
     assert.strictEqual(p.els.status.textContent, 'Saved.');
   });

   test('a press before the popup hears what is running goes by its own capture', async () => {
     let check, answer;
     const p = loadPopup('https://a.com/x', { running: new Promise((r) => { check = r; }), reply: new Promise((r) => { answer = r; }) });
     await p.ready();
     const done = p.click('visible');
     await settle();
     check(true); // a shortcut's capture was running, and this popup's waits behind it
     await settle();
     p.message({ type: 'capture-done', toClipboard: false }); // that capture's end
     assert.strictEqual(p.els.status.textContent, 'Capturing…', 'showed another capture\'s end as its own');
     answer(true);
     await done;
     assert.strictEqual(p.els.status.textContent, 'Saved.');
   });
   ```

4. **`tests/region-cancel.test.js` and `tests/region-dispatch.test.js`:** their popup harnesses keep `capture-check` out of `sent`. The region-dispatch harness answers it with `false`, not with the click's `ack`, which its tests settle by hand (`:197`, `:71-73`).

   ```diff
   --- tests/region-cancel.test.js
   @@ -195,4 +195,4 @@ function loadPopup() {
   -      // The popup's startup rec-check is the worker's business, not this file's.
   -      runtime: { onMessage: { addListener: () => {} }, sendMessage: async (m) => { if (m.type !== 'rec-check') sent.push(m); } },
   +      // The popup's startup rec-check and capture-check are the worker's business, not this file's.
   +      runtime: { onMessage: { addListener: () => {} }, sendMessage: async (m) => { if (m.type !== 'rec-check' && m.type !== 'capture-check') sent.push(m); } },
   --- tests/region-dispatch.test.js
   @@ -71,4 +71,5 @@ function loadPopup(store = { opts: { format: 'jpg' } }) {
        // The popup's startup rec-check only has to reach the worker, so it is
   -    // counted rather than left in `sent` with the messages a click sends.
   -    runtime: { onMessage: { addListener: () => {} }, sendMessage: (msg) => { if (msg.type === 'rec-check') checks++; else sent.push(msg); return ack; } },
   +    // counted rather than left in `sent` with the messages a click sends. Its
   +    // capture-check finds no capture running (KAN-545).
   +    runtime: { onMessage: { addListener: () => {} }, sendMessage: (msg) => { if (msg.type === 'capture-check') return Promise.resolve(false); if (msg.type === 'rec-check') checks++; else sent.push(msg); return ack; } },
   ```

5. **`tests/shortcut-format.test.js`:** the `pressShortcut` harness gets a `sendMessage`, because every Visible now ends with `capture-done` (`:31`). KAN-220 did the same for `tests/inner-scroller.test.js` when Full page started sending progress.

   ```diff
   @@ -30,3 +30,3 @@ async function pressShortcut(command, format) {
      const chrome = {
   -    runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
   +    runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => {} },
   ```

6. **`tests/fullpage.test.js`:** "names the popup that asked for the full page in its progress, and none for a shortcut's" reads only the progress, because each of its two Full pages now also ends with `capture-done` (`:1081`).

   ```diff
   @@ -1080,3 +1080,3 @@
      await vm.runInContext('runGate', ctx); // both have finished
   -  assert.deepStrictEqual(sent.map((m) => m.popupId), [undefined, undefined, undefined, undefined, 'popup-1', 'popup-1', 'popup-1', 'popup-1']);
   +  assert.deepStrictEqual(sent.filter((m) => m.type === 'capture-progress').map((m) => m.popupId), [undefined, undefined, undefined, undefined, 'popup-1', 'popup-1', 'popup-1', 'popup-1']);
    });
   ```

Choices:

- **The popup asks the worker, which keeps the answer in memory.**
  - The capture runs in the worker, so a worker that stops can't leave `shooting` set behind it.
  - A stored key could be left behind, as `rec` can (`getRec`, `background.js:121-147`), and it would grey out every popup's buttons until Chrome restarted or the extension was reloaded.
- **The answer isn't waited for in `load()`.**
  - The popup doesn't wait on the worker before it enables its buttons (`popup.js:247-253`), and a worker that is asleep takes longer to answer than storage does.
  - A press that gets in before the answer sends a capture of its own, which waits its turn (KAN-213). The answer is then ignored, and the popup shows only its own capture.
- **The end is a broadcast, like the progress.**
  - The popup that sent the capture still goes by its own answer (KAN-220), and ignores `capture-done`.
  - So does a popup whose own capture is waiting behind the capture that ended.
- **A watching popup shows every `capture-progress`.**
  - Captures run one at a time (KAN-213), so every one it gets is from the capture it found running. A closed popup's id and a shortcut's missing one don't matter here.
  - It shows "Capturing…" until the next screen, which is under a second away on a Full page. The worker doesn't keep the count.
- **Region isn't counted.**
  - Its `runCapture` ends with the overlay up, and its shot waits for the drag.
  - Opening a popup takes the focus from the page, which cancels the overlay anyway (`region.js:31-35`).
- **Any tab.** `capture-check` doesn't ask which tab the capture is on. Captures take turns across all tabs (KAN-213), so a press in a popup on any tab would wait behind it.
- **The words are the ones the sending popup shows** (`popup.js:213-214`).
  - "Saved." or "Copied to the clipboard." goes by the capture's own `toClipboard`, which the worker sends. The watching popup's setting may have changed since.
  - The error text is the worker's, as the sending popup gets it (`background.js:17`).
- **No README change, no new files, no version bump.**

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 384 tests.
  - **Test changes only:** 391 tests. 386 pass and 5 fail:
    - "tells a popup that opens whether a Visible or Full page is running", "tells every popup how a Visible or Full page ended" and "says nothing of a Region, whose shot waits for the drag": the worker doesn't answer `capture-check` or send `capture-done`;
    - "a popup opened during a capture it didn't send shows it, with its buttons greyed out" and "a popup opened during a capture says it was copied, or shows its error": the popup doesn't send `capture-check`.

    "a popup whose own capture waits its turn shows no other capture's end" and "a press before the popup hears what is running goes by its own capture" pass already, because no popup takes `capture-done` yet. They fail when the guards they cover are taken out (below).
  - **Test changes plus `background.js`:** 389 pass, and only the two "a popup opened during a capture …" tests fail.
  - **Every change:** `npm test` passes all 391 tests.
  - **Each part of the change is needed:**
    - With `shooting` set for a Region too, "says nothing of a Region, whose shot waits for the drag" fails.
    - With `capture-done` sent for a Region too, that test fails, and so does "still runs the capture after acknowledging it" in `tests/region-dispatch.test.js`, whose worker harness has no `sendMessage`.
    - With `capture-done` leaving `shooting` set, "tells a popup that opens whether a Visible or Full page is running" fails.
    - With no `toClipboard` or no error text in `capture-done`, "tells every popup how a Visible or Full page ended" fails.
    - With no `capture-check` branch in the worker, the first test and the Region test fail.
    - With `toggleRec` not reading `watching`, or a watching popup not shown the progress, "a popup opened during a capture it didn't send shows it, with its buttons greyed out" fails. With `capture-done` not calling `toggleRec`, that test and "a popup opened during a capture says it was copied, or shows its error" fail.
    - With the answer taken over a press that got in first, "a press before the popup hears what is running goes by its own capture" fails.
    - With `capture-done` taken by a popup that isn't watching, "a popup whose own capture waits its turn shows no other capture's end" and the press test fail.
    - **The harness changes:**
      - With `capture-check` left in `sent` in `tests/region-cancel.test.js`, "Region closes the popup so the page can be dragged on" fails.
      - With it left in `sent` in `tests/region-dispatch.test.js`, "Region keeps the popup open until the worker acknowledges the message" fails.
      - With `loadPopup` answering it with `reply`, 35 tests in `tests/capture-errors.test.js` fail.
      - Without the `sendMessage` in `pressShortcut`, its 4 tests fail.
      - With the KAN-552 test in `tests/fullpage.test.js` reading every message, it fails.
- **Headed Chrome 153.0.8010.48**, with `/tmp/vs387-chrome/run-545.js`, written for this plan from `run-220b.js` and `run-552.js`:
  - The page is local and 8000 px tall. The viewport is 713 px at dpr 2, so a Full page is 12 screens and a 2560×16000 image.
  - Four cases:
    - **Nothing running:** a popup is opened, with no capture running.
    - **Own Full page:** a popup presses Full page.
    - **Reopened:** a popup presses Full page and is closed 1.5 s later. A second popup is then opened on the same tab. This is the ticket's case.
    - **Shortcut:** a shortcut's Full page is started in the worker with `runCapture`, the way `onCommand` starts it. A popup is opened 1.5 s later.
  - Each popup's log starts with its status box and buttons as first seen, then every change, timed from when that popup opened. The buttons are listed as Visible, Full page, Region (1 = greyed out).
  - **Before, the repo as it is:**
    - **Nothing running:** no status box, buttons `000`.
    - **Own Full page:** "Capturing…", then "Capturing screen 1 of 12…" through "12 of 12…", then "Saved." at 7940 ms. The buttons were `111` until "Saved." and `000` after.
    - **Reopened:** the first popup said "Capturing screen 3 of 12…" at 1258 ms, with buttons `111`. The second popup had no status box and buttons `000`, and was the same 10 s after the image had been saved. This is what the ticket describes.
    - **Shortcut:** no status box and buttons `000`, from the popup opening until 10 s after the image had been saved.
  - **After, with the change:**
    - **Nothing running:** the same, no status box and buttons `000`.
    - **Own Full page:** the same as before. "Capturing…" at 57 ms, "1 of 12…" through "12 of 12…" (124 to 6734 ms), then "Saved." at 7898 ms. The buttons were `111` until "Saved." and `000` after.
    - **Reopened:** the first popup said "Capturing screen 3 of 12…" at 1278 ms. The second popup showed "Capturing…" with buttons `111` when first seen, at 54 ms. It then showed "5 of 12…" through "12 of 12…" (147 to 4284 ms), then "Saved." with buttons `000` at 5936 ms.
    - **Shortcut:** first seen at 49 ms with "Capturing screen 4 of 12…" and buttons `111`, since the answer and that screen had both come in by then. Then "5 of 12…" through "12 of 12…" (654 to 4872 ms), then "Saved." with buttons `000` at 6012 ms.
  - In every run, before and after:
    - Each Full page was saved at 2560×16000.
    - No console had an exception or an error.

## Steps

1. Make the test changes above in `tests/capture-errors.test.js`, `tests/region-cancel.test.js`, `tests/region-dispatch.test.js`, `tests/shortcut-format.test.js` and `tests/fullpage.test.js`.
   → verify: `npm test` runs 391 tests. 386 pass, and only these 5 fail:
   - "tells a popup that opens whether a Visible or Full page is running"
   - "tells every popup how a Visible or Full page ended"
   - "says nothing of a Region, whose shot waits for the drag"
   - "a popup opened during a capture it didn't send shows it, with its buttons greyed out"
   - "a popup opened during a capture says it was copied, or shows its error"
2. Make the `background.js` change above.
   → verify: `npm test` runs 391 tests. 389 pass, and only the two "a popup opened during a capture …" tests fail.
3. Make the `popup.js` change above.
   → verify: `npm test` passes all 391 tests.
4. Check the change in headed Chrome: `node /tmp/vs387-chrome/run-545.js --ext /Users/john/dev/viewshot --headful`.
   → verify:
   - **Nothing running:** no status box, buttons `000`.
   - **Own Full page:** "Capturing…", "Capturing screen 1 of 12…" through "12 of 12…", then "Saved.". The buttons are `111` until "Saved." and `000` after.
   - **Reopened:** the second popup is greyed out (`111`) from when it is first seen, with "Capturing…" or a screen. It shows the screens up to "12 of 12…", then "Saved." with `000`.
   - **Shortcut:** the same as the reopened popup.
   - Each image is 2560×16000, and no console has an exception or an error.
5. Check that nothing else changed.
   → verify: `git status --short` lists only the seven files above and this plan.

## Open questions

None. The ticket says what a popup opened mid-capture fails to show, and that its buttons stay enabled. This plan shows that capture and greys the buttons out until it ends.

## Noticed while planning, not changed

- **A capture that starts while a popup is open isn't shown in it.** That is one queued behind the capture the popup is showing, or one from a shortcut pressed while the popup is open.
  - The popup gives its buttons back when the capture it found running ends.
  - A press then waits its turn (KAN-213) and shows only its own screens (KAN-552).
  - The ticket covers a popup opened while a capture is running.
- **`run-552.js` no longer runs as written.** It opens its popups 300 ms into a shortcut's Full page and presses a button. With this change those buttons are greyed out by then, so the press does nothing, and the script waits 30 s for a second image that never comes.

## Added when shipping

- **Two more tests** in `tests/capture-errors.test.js`, for code no test in "Change" covered:
  - "drops a capture's end quietly when no popup is open to hear it".
    - A shortcut's capture usually has no popup open to hear its `capture-done`, and Chrome rejects the send.
    - It fails when the send's `.catch` is taken out.
  - "a popup that can't ask the worker what is running is left as it was". It fails when the `.catch` on the popup's `capture-check` is taken out.
- **Step 4, run on this folder:** the same results as in "Checked while planning".
  - Nothing running: no status box, buttons `000`.
  - Own Full page: "Saved." at 7933 ms, with the buttons `111` until then and `000` after.
  - Reopened: the second popup showed "Capturing…" with `111` at 54 ms. It then showed "5 of 12…" through "12 of 12…", then "Saved." with `000` at 5942 ms.
  - Shortcut: "Capturing screen 4 of 12…" with `111` at 47 ms, then screens through "12 of 12…", then "Saved." with `000` at 6002 ms.
  - Each image was 2560×16000, and no console had an exception or an error.
- **Not fixed here:** a capture that starts while a popup is open isn't shown in it (KAN-561).
- `npm test` passes all 393.
