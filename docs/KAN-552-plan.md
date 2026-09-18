# KAN-552: The popup shows another capture's progress as its own while its capture waits

Ticket: https://prattsolutions.atlassian.net/browse/KAN-552. It is a To Do Task labelled `bug` and `viewshot`, with no comments. It was blocked by KAN-213, which is Done.

## What the repo does now

As of `d2ee791`:

- **A Full page's progress doesn't say whose capture it is.**
  - `captureFullPage` sends `{ type: 'capture-progress', screen, screens }` before each screen (`background.js:432-435`).
  - It is given only the tab and the format (`:402`), by `runCapture(mode, opts, tabId)` (`:258`, `:275`). Nothing along the way knows who asked.
  - The popup's `capture` message is `{ type, mode, tabId, opts }` (`popup.js:187`), and the worker passes on only those (`background.js:17`). A shortcut's capture comes from `onCommand` (`:111`).
- **Captures take turns.** Since KAN-213, `runCapture` waits on `runGate` until the capture before it has finished (`background.js:257-259`, `:282`).
- **The popup shows every `capture-progress` it gets while its own capture is unanswered** (`popup.js:242`).
  - `capturing` is set on the press (`:178`) and cleared when the worker answers (`:192`).
  - The time its capture spends waiting on `runGate` falls inside that. So a popup whose capture waits behind a shortcut's Full page shows that Full page's screens as its own. So does one whose capture waits behind a Full page from a popup that has since been closed.
- **The repo already tells messages apart by id.** `offscreen.js:10` gives its document an id with `crypto.randomUUID()`, and a blip's report carries the id of its blip (`background.js:1005`, `:1011`).
- **Tests:** `npm test` runs 378 tests, and all pass.
  - "tells the popup which screen it is shooting, out of how many" (`tests/fullpage.test.js:943-947`) checks the progress message exactly as it is now.
  - "the popup shows which screen Full page is on, and only for its own capture" (`tests/capture-errors.test.js:2283-2296`) checks that a popup that sent nothing ignores progress, and that one shows it during its own capture.
  - No test has a popup whose capture waits behind another.
  - Four harnesses load `popup.js`, and none has `crypto`: `tests/capture-errors.test.js:285`, `tests/region-cancel.test.js:185`, `tests/region-dispatch.test.js:78` and `tests/defaults.test.js:73`. The worker and offscreen harnesses fake `crypto.randomUUID` (`tests/capture-errors.test.js:82`, `:542`).

## Change

Seven files change: `background.js`, `popup.js` and five test files. `popup.html`, `popup.css`, `offscreen.js`, `README.md`, `manifest.json` and `package.json` don't change.

1. **`popup.js`:**
   - The popup gets an id when it opens, with `crypto.randomUUID()`, as the offscreen document does (`offscreen.js:10`). It goes after `capturing` (`:8`).
   - The id goes out with the `capture` message (`:187`).
   - A `capture-progress` is shown only when it carries this popup's id (`:240-242`).

   ```diff
   @@ -8,2 +8,3 @@
    let capturing = false; // a Visible or Full page this popup sent hasn't been answered yet (KAN-220)
   +const popupId = crypto.randomUUID(); // sent with this popup's captures; a Full page's progress carries it back (KAN-552)
    
   @@ -186,3 +187,3 @@
          try {
   -        res = await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, tabId: activeTab?.id, opts });
   +        res = await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, tabId: activeTab?.id, opts, popupId });
          } catch (e) {
   @@ -239,5 +240,6 @@
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
   -  // How far a Full page has got (KAN-220). Only while this popup's own capture
   -  // runs: the worker sends it for a shortcut's capture too.
   -  if (msg?.type === 'capture-progress') { if (capturing) showStatus(`Capturing screen ${msg.screen} of ${msg.screens}…`); return; }
   +  // How far a Full page has got (KAN-220). Only this popup's own capture's: the
   +  // worker sends it for a shortcut's capture too, and for one this popup's is
   +  // waiting behind (KAN-552).
   +  if (msg?.type === 'capture-progress') { if (capturing && msg.popupId === popupId) showStatus(`Capturing screen ${msg.screen} of ${msg.screens}…`); return; }
      if (msg?.type === 'shot-clipboard') {
   ```

2. **`background.js`:** the popup's id goes from the `capture` message (`:17`) through `runCapture` (`:258`, `:275`) and `captureFullPage` (`:402`) into each `capture-progress` (`:432-435`). A shortcut's capture has none.

   ```diff
   @@ -16,3 +16,3 @@
      else if (msg?.type === 'capture') {
   -    runCapture(msg.mode, msg.opts, msg.tabId).then(() => sendResponse(true), (e) => { captureFailed(e); sendResponse({ error: e.message || String(e) }); });
   +    runCapture(msg.mode, msg.opts, msg.tabId, msg.popupId).then(() => sendResponse(true), (e) => { captureFailed(e); sendResponse({ error: e.message || String(e) }); });
        return true;
   @@ -257,3 +257,3 @@
    let runGate = Promise.resolve();
   -function runCapture(mode, opts, tabId) {
   +function runCapture(mode, opts, tabId, popupId) {
      const run = runGate.then(async () => {
   @@ -274,3 +274,3 @@
          if (mode === 'visible') png = await captureVisible(tab.windowId);
   -      else if (mode === 'fullpage') png = await captureFullPage(tab, opts.toClipboard ? 'png' : opts.format);
   +      else if (mode === 'fullpage') png = await captureFullPage(tab, opts.toClipboard ? 'png' : opts.format, popupId);
        } finally {
   @@ -401,3 +401,3 @@
    const MAX_AREA = 268435456;
   -async function captureFullPage(tab, format) {
   +async function captureFullPage(tab, format, popupId) {
      const [{ result: m }] = await scriptWithTimeout({
   @@ -434,3 +434,6 @@
          // a shortcut's capture has no popup, and a popup can close mid-stitch.
   -      chrome.runtime.sendMessage({ type: 'capture-progress', screen: i + 1, screens: Math.max(i + 1, Math.ceil(m.total / m.vh)) }).catch(() => {});
   +      // popupId says which popup asked for this capture (none for a
   +      // shortcut's), so a popup whose capture waits its turn behind this one
   +      // doesn't show these screens as its own (KAN-552).
   +      chrome.runtime.sendMessage({ type: 'capture-progress', popupId, screen: i + 1, screens: Math.max(i + 1, Math.ceil(m.total / m.vh)) }).catch(() => {});
          // The sticky elements that stick to the page, listed on the first slice
   ```

3. **`tests/fullpage.test.js`:**
   - "tells the popup which screen it is shooting, out of how many" passes an id and expects it in each message (`:945-946`).
   - One test goes at the end: a shortcut's Full page, with a popup's Full page waiting its turn behind it. The popup's comes in as its `capture` message, so the worker's listener is covered too.

   ```diff
   @@ -944,4 +944,4 @@
      const { ctx, sent } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   -  await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(sent, [1, 2, 3, 4].map((screen) => ({ type: 'capture-progress', screen, screens: 4 })));
   +  await ctx.captureFullPage(TAB, 'png', 'popup-1');
   +  assert.deepStrictEqual(sent, [1, 2, 3, 4].map((screen) => ({ type: 'capture-progress', popupId: 'popup-1', screen, screens: 4 })));
    });
   ```

   ```js
   // --- whose capture the progress is from (KAN-552) ---------------------------
   // A capture waits for the one before it to finish (KAN-213), and a Full page's
   // progress didn't say whose capture it was: a popup whose capture waited
   // behind a shortcut's Full page showed that Full page's screens as its own.

   test('names the popup that asked for the full page in its progress, and none for a shortcut\'s', async () => {
     const { ctx, sent, message } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
     forRunCapture(ctx);
     ctx.runCapture('fullpage', RUN_OPTS, TAB.id); // as a shortcut starts it
     message({ type: 'capture', mode: 'fullpage', opts: RUN_OPTS, tabId: TAB.id, popupId: 'popup-1' }); // waits its turn behind it
     await vm.runInContext('runGate', ctx); // both have finished
     assert.deepStrictEqual(sent.map((m) => m.popupId), [undefined, undefined, undefined, undefined, 'popup-1', 'popup-1', 'popup-1', 'popup-1']);
   });
   ```

4. **`tests/capture-errors.test.js`:**
   - `loadPopup` gives the popup a fixed id, `'popup-1'`, the way `loadOffscreen` gives its document `'doc-1'` (`:308`).
   - "the popup shows which screen Full page is on, and only for its own capture" sends its own progress with that id (`:2291`).
   - One test goes at the end: the popup's capture waiting behind a shortcut's Full page and behind one from a popup that has since closed.

   ```diff
   @@ -308,2 +308,3 @@
        localStorage: { getItem: () => null, setItem: () => {} },
   +    crypto: { randomUUID: () => 'popup-1' }, // the id this popup's captures carry (KAN-552)
      };
   @@ -2290,3 +2291,3 @@
      await settle();
   -  p.message({ type: 'capture-progress', screen: 2, screens: 3 });
   +  p.message({ type: 'capture-progress', popupId: 'popup-1', screen: 2, screens: 3 });
      assert.strictEqual(p.els.status.textContent, 'Capturing screen 2 of 3…');
   ```

   ```js
   // --- whose capture the progress is from (KAN-552) ---------------------------
   // A capture waits for the one before it to finish (KAN-213), and a Full page's
   // progress didn't say whose capture it was: a popup whose capture waited
   // behind a shortcut's Full page showed that Full page's screens as its own.

   test('the popup shows no other capture\'s screens while its own waits its turn', async () => {
     let answer;
     const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
     await p.ready();
     const done = p.click('fullpage');
     await settle();
     assert.strictEqual(p.sent[0].popupId, 'popup-1', 'the worker can\'t say which screens are this popup\'s');
     p.message({ type: 'capture-progress', screen: 3, screens: 6 }); // a shortcut's Full page, which this one waits behind
     p.message({ type: 'capture-progress', popupId: 'popup-0', screen: 4, screens: 6 }); // one from a popup that has since closed
     assert.strictEqual(p.els.status.textContent, 'Capturing…', 'showed another capture\'s screens as its own');
     p.message({ type: 'capture-progress', popupId: 'popup-1', screen: 1, screens: 2 }); // its own, once its turn comes
     assert.strictEqual(p.els.status.textContent, 'Capturing screen 1 of 2…');
     answer(true);
     await done;
     assert.strictEqual(p.els.status.textContent, 'Saved.');
   });
   ```

5. **`tests/region-cancel.test.js`, `tests/region-dispatch.test.js` and `tests/defaults.test.js`:** their popup harnesses pass in Node's own `crypto`, the way they pass in `Math` and `JSON`. Without it, `popup.js` throws as it loads.

   ```diff
   --- tests/region-cancel.test.js
   @@ -185,3 +185,3 @@
      const context = {
   -    console, Math, parseFloat, JSON,
   +    console, Math, parseFloat, JSON, crypto,
        window: { close: () => { closed++; } },
   --- tests/region-dispatch.test.js
   @@ -78,3 +78,3 @@
      const context = {
   -    document, chrome, console: { ...console, error: () => {} }, Math, parseFloat, JSON, localStorage,
   +    document, chrome, console: { ...console, error: () => {} }, Math, parseFloat, JSON, localStorage, crypto,
        window: { close: () => { closed = true; } },
   --- tests/defaults.test.js
   @@ -72,3 +72,3 @@
      };
   -  const context = { document, chrome, console, Math, parseFloat, JSON, localStorage };
   +  const context = { document, chrome, console, Math, parseFloat, JSON, localStorage, crypto };
      vm.createContext(context);
   ```

Choices:

- **One id per popup, not one per capture.**
  - A popup has one capture going at a time. Its buttons are greyed out from the press until the worker answers (KAN-220), and every progress message of that capture is sent before the answer.
  - So while `capturing` is set, the popup's id names that one capture. It is made once, as the popup loads, like the offscreen document's (`offscreen.js:10`).
- **The id rides the messages that are already there.** There is no new message and no new state in the worker. `runCapture` and `captureFullPage` get it as one more parameter.
- **A shortcut's capture has no popup, so its progress has no `popupId`,** and no popup shows it. A Full page from a popup that has since closed carries that popup's id, which no open popup has.
- **Region is left as it is.** It shows no progress, and its popup closes. Its `capture` message carries the id too, because it is the same send, but the Region branch (`background.js:11`) doesn't pass it on.
- **While its capture waits, the popup keeps showing "Capturing…",** then its own screens once its turn comes. The ticket asks only that it stop showing the other capture's screens.
- **A popup opened mid-capture still shows nothing of that capture.** That is KAN-545.
- **No README change, no new files, no version bump.**

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 378 tests.
  - **Test changes only:** 380 tests. 377 pass and 3 fail:
    - "tells the popup which screen it is shooting, out of how many": the messages have no `popupId`.
    - "names the popup that asked for the full page in its progress, and none for a shortcut's": the two Full pages ran one after the other, and none of their 8 messages has a `popupId`.
    - "the popup shows no other capture's screens while its own waits its turn": the popup's `capture` message has no `popupId`.
  - **Test changes plus `background.js`:** 379 pass, and only the popup test fails.
  - **Every change:** `npm test` passes all 380 tests.
  - **Each part of the change is needed:**
    - With the popup sending its id but not checking it, the popup test fails. The status box says "Capturing screen 4 of 6…", from the closed popup's capture.
    - With the popup checking its id but not sending it, the popup test fails.
    - With the listener not passing `msg.popupId` to `runCapture`, or `runCapture` not passing it to `captureFullPage`, the new `tests/fullpage.test.js` test fails.
    - Without `crypto` in the region-cancel, region-dispatch and defaults harnesses, 52 tests fail with "ReferenceError: crypto is not defined".
- **Headed Chrome 153.0.8010.48**, with `/tmp/vs387-chrome/run-552.js`, written for this plan from `run-213.js`:
  - The page is local, 4000 px tall, with a 60 px fixed header. The viewport is 713 px at dpr 2, so a Full page is 6 screens.
  - The shortcut's Full page is started in the worker with `runCapture`, the way `onCommand` starts it. A popup is opened 300 ms later, and one of its buttons is pressed.
  - Times are from the press. The buttons are listed as Visible, Full page, Region (1 = greyed out).
  - **Before, the repo as it is:**
    - **The popup's Visible during a shortcut's Full page:** "Capturing…" at 3 ms, then "Capturing screen 3 of 6…" through "6 of 6…" from the shortcut's stitch (294 to 2097 ms), then "Saved." at 3299 ms. This is what the ticket describes.
    - **The popup's Full page during a shortcut's Full page:** the shortcut's "3 of 6…" through "6 of 6…" (273 to 2060 ms), then its own "1 of 6…" through "6 of 6…" (2942 to 5910 ms), then "Saved." at 7540 ms.
    - **The popup's Full page alone:** "1 of 6…" through "6 of 6…" (66 to 2966 ms), then "Saved." at 3835 ms.
  - **After, with the change:**
    - **Visible during a shortcut's Full page:** "Capturing…" at 2 ms, then "Saved." at 3311 ms, with nothing in between.
    - **Full page during a shortcut's Full page:** "Capturing…" at 1 ms, then only its own "1 of 6…" through "6 of 6…" (3010 to 6025 ms), then "Saved." at 7615 ms.
    - **Full page alone:** the same as before, "1 of 6…" through "6 of 6…" (72 to 3064 ms), then "Saved." at 3887 ms.
  - In every run, before and after:
    - The buttons were `111` until "Saved." and `000` after.
    - The shortcut's Full page (2560×8000) was saved before the popup's image.
    - No console had an exception or an error.

## Steps

1. Make the test changes above in `tests/fullpage.test.js`, `tests/capture-errors.test.js`, `tests/region-cancel.test.js`, `tests/region-dispatch.test.js` and `tests/defaults.test.js`.
   → verify: `npm test` runs 380 tests. 377 pass, and only these 3 fail:
   - "tells the popup which screen it is shooting, out of how many"
   - "names the popup that asked for the full page in its progress, and none for a shortcut's"
   - "the popup shows no other capture's screens while its own waits its turn"
2. Make the `background.js` change above.
   → verify: `npm test` runs 380 tests. 379 pass, and only "the popup shows no other capture's screens while its own waits its turn" fails.
3. Make the `popup.js` change above.
   → verify: `npm test` passes all 380 tests.
4. Check the change in headed Chrome: `node /tmp/vs387-chrome/run-552.js --ext /Users/john/dev/viewshot --headful`.
   → verify:
   - **Visible during a shortcut's Full page:** the popup shows "Capturing…", then "Saved.", and no "Capturing screen N of 6…".
   - **Full page during a shortcut's Full page:** "Capturing…", then only its own "1 of 6…" through "6 of 6…", then "Saved.".
   - **Full page alone:** "1 of 6…" through "6 of 6…", then "Saved.".
   - The buttons are `111` until "Saved." and `000` after, the shortcut's Full page is saved first, and no console has an exception.
5. Check that nothing else changed.
   → verify: `git status --short` lists only the seven files above and this plan.

## Open questions

None. The ticket says what is wrong, and it leaves nothing open that would change this plan.

## Added when shipping

- **No tests beyond those in "Change".** Taking out any one part of the change makes one of them fail (see "Each part of the change is needed").
- **Step 4, run on this folder:** the same results as in "Checked while planning".
  - Visible during a shortcut's Full page showed "Capturing…", then "Saved." at 3311 ms, and none of the shortcut's screens.
  - Full page during a shortcut's Full page showed only its own "1 of 6…" through "6 of 6…" (2950 to 5956 ms), then "Saved." at 7342 ms.
  - Full page alone showed "1 of 6…" through "6 of 6…" (69 to 3027 ms), then "Saved." at 3905 ms.
  - The buttons were `111` until "Saved." and `000` after, the shortcut's Full page was saved first, and no console had an exception.
- **Not fixed here:** a popup opened mid-capture still shows nothing of that capture (KAN-545).
- `npm test` passes all 380.
