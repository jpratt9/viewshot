# KAN-561: A popup doesn't show a capture that starts while it is open, and leaves its buttons enabled

Ticket: https://prattsolutions.atlassian.net/browse/KAN-561. It is a To Do Task labelled `bug` and `viewshot`, with no comments. It was blocked by KAN-545, which is Done.

## What the repo does now

As of `3d5920e`:

- **A popup finds out about a capture it didn't send only once, as it opens.**
  - It sends `capture-check` at startup (`popup.js:256-260`), and the worker answers with `shooting` (`background.js:23`).
  - If a capture is running and the popup hasn't sent one of its own, it sets `watching`, greys out its buttons and shows "Capturing…" (`popup.js:260`). No other code sets `watching`.
  - `capture-done` clears `watching`, gives the buttons back and shows "Saved.", "Copied to the clipboard." or the error text (`popup.js:274`).
- **The worker says nothing when a capture's turn starts.** `runCapture` sets `shooting` when a Visible or Full page's turn starts (`background.js:271`), and sends no message then. What it does send:
  - `capture-progress` for each Full page screen (`:454`);
  - `capture-done` when a capture ends (`:294-297`);
  - the answer to `capture-check`, only when a popup asks (`:23`).
- **So a capture whose turn starts while the popup is open isn't shown.**
  - **One queued behind the capture the popup is showing.** Captures take turns (`runGate`, `background.js:261-300`, KAN-213). When the first ends, the popup shows "Saved." and gives its buttons back while the second runs. It drops the second one's `capture-progress` (`popup.js:270`) and its `capture-done` (`:274`), because it isn't `watching` any more.
  - **One a shortcut starts after the popup opened.** The popup stays as it was, with no status box and its buttons enabled.
- **The order of the worker's messages.** Each Visible or Full page's `capture-done` goes out from a reaction on its `run` that is registered before `runGate = run.catch(...)` (`background.js:294-298`). So the next capture's turn, and anything sent when it starts, comes after it.
- **Tests:** `npm test` runs 393 tests, and all pass.
  - "says nothing of a Region, whose shot waits for the drag" (`tests/capture-errors.test.js:2425`) checks that a Region sends no message at all.
  - "drops a capture's end quietly when no popup is open to hear it" (`:2491`) has Chrome reject every message the worker sends.
  - "a press before the popup hears what is running goes by its own capture" (`:2476`) covers the `!capturing` guard on the `capture-check` answer.
  - No test has a capture start while a popup is open.

## Change

Three files change: `background.js`, `popup.js` and `tests/capture-errors.test.js`. `popup.html`, `popup.css`, `offscreen.js`, `region.js`, `README.md`, `manifest.json`, `package.json` and the other test files don't change.

1. **`background.js`:** when a Visible or Full page's turn starts, the worker sends `capture-start` to every popup, in the same place it sets `shooting` (`:271`). Like `capture-done`, it isn't waited for, and nothing may be listening. The comment above `shooting` says so (`:262-267`).

   ```diff
   @@ -263,11 +263,11 @@ let runGate = Promise.resolve();
    // during it (KAN-545). Only the popup that sent a capture hears how it went,
    // in its answer, so the end of each one also goes out to every popup, for one
   -// opened since. Nothing may be listening, as with its progress. A Region is
   -// neither: its runCapture ends with the overlay up, and its shot waits for the
   -// drag.
   +// opened since. So does its start, for one that is already open (KAN-561).
   +// Nothing may be listening, as with its progress. A Region is neither: its
   +// runCapture ends with the overlay up, and its shot waits for the drag.
    let shooting = false;
    function runCapture(mode, opts, tabId, popupId) {
      const run = runGate.then(async () => {
   -    if (mode !== 'region') shooting = true;
   +    if (mode !== 'region') { shooting = true; chrome.runtime.sendMessage({ type: 'capture-start' }).catch(() => {}); }
        const tab = await getActiveTab(tabId);
   ```

2. **`popup.js`:**
   - What the popup does with a `capture-check` answer that says a capture is running moves into `watch` (`:260`). That is: set `watching`, grey out the buttons, show "Capturing…", unless the popup has a capture of its own pending.
   - `capture-start` calls `watch` too. It goes first in the listener, before `capture-progress` (`:268`).
   - The comments on `watching` (`:9`), `toggleRec` (`:106-107`), `capture-progress` and `capture-done` (`:267-273`) now say the popup may be watching a capture that started after it opened, not only one it found running.

   ```diff
   @@ -7,5 +7,5 @@ const edited = new Set(); // input can precede change while startup is pending
    let capturing = false; // a Visible or Full page this popup sent hasn't been answered yet (KAN-220)
   -let watching = false; // one it didn't send was running as it opened, and hasn't ended (KAN-545)
   +let watching = false; // one it didn't send is running: found as it opened (KAN-545), or started since (KAN-561)
   @@ -105,5 +105,5 @@
    // start would record over that one, and it would be lost. All three are
    // greyed out while a capture this popup sent is running (KAN-220), and while
   -// one it found running as it opened is (KAN-545).
   +// one it didn't send is (KAN-545, KAN-561).
   @@ -254,9 +254,11 @@ paintFromCache(); // synchronous: correct UI in the first frame
    chrome.runtime.sendMessage({ type: 'rec-check' }).catch(() => { /* a worker that can't answer has no recording in it either */ });
   +// Shows a Visible or Full page this popup didn't send, and keeps its buttons
   +// greyed out until it ends. A popup whose own capture hasn't been answered - a
   +// press that got in first, or one waiting its turn - shows that one instead.
   +const watch = () => { if (!capturing) { watching = true; toggleRec(); showStatus('Capturing…'); } };
    // A Visible or Full page this popup didn't send may be running: the popup that
   -// sent it was closed, or a shortcut started it. This popup shows it too, and
   -// keeps its buttons greyed out until it ends (KAN-545). A press that got in
   -// before the answer has a capture of its own to show.
   -chrome.runtime.sendMessage({ type: 'capture-check' }).then((running) => { if (running && !capturing) { watching = true; toggleRec(); showStatus('Capturing…'); } }).catch(() => { /* a worker that can't answer has no capture running in it either */ });
   +// sent it was closed, or a shortcut started it (KAN-545).
   +chrome.runtime.sendMessage({ type: 'capture-check' }).then((running) => { if (running) watch(); }).catch(() => { /* a worker that can't answer has no capture running in it either */ });
   @@ -264,12 +266,15 @@ const startup = load().catch(() => {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
   +  // A Visible or Full page that starts while this popup is open: one queued
   +  // behind the capture it was showing, or a shortcut's (KAN-561).
   +  if (msg?.type === 'capture-start') { watch(); return; }
      // How far a Full page has got (KAN-220). Only this popup's own capture's: the
      // worker sends it for a shortcut's capture too, and for one this popup's is
   -  // waiting behind (KAN-552). A popup that found a capture running as it
   -  // opened shows that one's, the only capture running (KAN-545).
   +  // waiting behind (KAN-552). A popup watching a capture it didn't send shows
   +  // that one's, the only capture running (KAN-545).
      if (msg?.type === 'capture-progress') { ... unchanged ... }
   -  // How the capture this popup found running as it opened ended (KAN-545). A
   -  // capture this popup sent is answered instead, and one that ends while this
   -  // popup's waits its turn isn't its own.
   +  // How the capture this popup is watching ended (KAN-545). A capture this
   +  // popup sent is answered instead, and one that ends while this popup's waits
   +  // its turn isn't its own.
      if (msg?.type === 'capture-done') { ... unchanged ... }
   ```

3. **`tests/capture-errors.test.js`:** four tests go at the end: one for the worker and three for the popup.

   ```js
   // --- a capture that starts while a popup is open (KAN-561) ------------------
   // A popup heard of a capture it didn't send only as it opened. One whose turn
   // started while the popup was open - queued behind the capture it was showing,
   // or a shortcut's - showed nothing, and the popup's buttons were live.

   test('tells every popup when a Visible or Full page starts, after the one before it has ended', async () => {
     const bg = loadBg();
     const sent = [];
     bg.ctx.chrome.runtime.sendMessage = async (m) => { sent.push(m.type); };
     const first = bg.ctx.runCapture('visible', OPTS, TAB.id); // a shortcut pressed twice
     await bg.ctx.runCapture('visible', OPTS, TAB.id);
     await first;
     assert.deepStrictEqual(sent.filter((t) => t === 'capture-start' || t === 'capture-done'), ['capture-start', 'capture-done', 'capture-start', 'capture-done'],
       'a popup showing the first would hear the second start before the first ended');
   });

   test('a popup shows a capture that starts while it is open, with its buttons greyed out', async () => {
     const p = loadPopup('https://a.com/x'); // nothing running as it opens
     await p.ready();
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
     p.message({ type: 'capture-start' }); // a shortcut's
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [true, true, true], 'a press would start another capture');
     assert.strictEqual(p.els.status.textContent, 'Capturing…');
     p.message({ type: 'capture-progress', screen: 1, screens: 3 });
     assert.strictEqual(p.els.status.textContent, 'Capturing screen 1 of 3…');
     p.message({ type: 'capture-done', toClipboard: false });
     assert.strictEqual(p.els.status.textContent, 'Saved.');
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
   });

   test('a popup showing a capture goes on to the one queued behind it', async () => {
     const p = loadPopup('https://a.com/x', { running: true });
     await p.ready();
     p.message({ type: 'capture-done', toClipboard: false }); // the first ends
     p.message({ type: 'capture-start' }); // and the one queued behind it starts
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [true, true, true], 'gave its buttons back while the second ran');
     assert.strictEqual(p.els.status.textContent, 'Capturing…');
     p.message({ type: 'capture-progress', screen: 2, screens: 4 });
     assert.strictEqual(p.els.status.textContent, 'Capturing screen 2 of 4…');
     p.message({ type: 'capture-done', toClipboard: false, error: 'Tabs cannot be edited right now' });
     assert.strictEqual(p.els.err.textContent, 'Tabs cannot be edited right now');
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
   });

   test('a popup whose own capture waits its turn shows no other capture that starts meanwhile', async () => {
     let answer;
     const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
     await p.ready();
     const done = p.click('visible');
     await settle();
     p.message({ type: 'capture-start' }); // a capture ahead of this one in the queue starts
     p.message({ type: 'capture-done', toClipboard: false, error: 'Tabs cannot be edited right now' }); // and ends
     assert.strictEqual(p.els.status.textContent, 'Capturing…', 'showed another capture\'s end as its own');
     assert.strictEqual(p.els.err.hidden, true, 'showed another capture\'s error as its own');
     answer(true);
     await done;
     assert.strictEqual(p.els.status.textContent, 'Saved.');
     assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
   });
   ```

   No harness changes. Every worker harness that runs a Visible or Full page already has a `sendMessage`, which KAN-545 needed for `capture-done`. The `tests/fullpage.test.js` test that goes through `runCapture` reads only the progress messages.

Choices:

- **The worker says when a capture starts, as it already says when one ends.**
  - `capture-start` goes out where `shooting` is set, so a popup hears of every Visible or Full page whose turn starts while it is open.
  - The popup still asks with `capture-check` as it opens, for a capture that was already running then (KAN-545).
- **It is sent when the capture's turn starts, not when the capture is asked for.**
  - A capture waiting behind another isn't running yet, and the popup keeps showing the one that is.
  - The previous capture's `capture-done` goes out before the next one's turn starts (see "What the repo does now"). So a popup showing the first capture gets its end before the second's start, and it shows "Saved." and then "Capturing…".
  - Sent when the capture is asked for, the second one's start comes before the first one's end, and the worker test fails.
- **`capture-start` carries nothing.**
  - A popup with its own capture pending ignores it, whoever's it is. The popup goes by its own answer (KAN-220), and a capture that starts while its own waits its turn isn't its own (KAN-552).
  - The `capturing` check KAN-545 put on the `capture-check` answer moves into `watch`, so it covers both messages.
- **One `watch` for both.** A `capture-check` answer that says a capture is running and a `capture-start` lead to the same thing, so the three statements KAN-545 put on the `capture-check` line are shared rather than copied.
- **Region still isn't counted**, as in KAN-545. Its `runCapture` sends no `capture-start`, because its shot waits for the drag. "says nothing of a Region, whose shot waits for the drag" still checks this, unchanged.
- **Between two queued captures the buttons come back for an instant.**
  - When the first capture ends, the popup gives its buttons back and says "Saved.". It greys them out again as soon as the next one's `capture-start` arrives. In Chrome both happened in the same millisecond.
  - A press that gets in between sends a capture of its own. It waits its turn (KAN-213), and the popup shows only that one (KAN-552).
- **No README change, no new files, no version bump.**

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 393 tests.
  - **Test changes only:** 397 tests. 394 pass and 3 fail:
    - "tells every popup when a Visible or Full page starts, after the one before it has ended": the worker sends no `capture-start`;
    - "a popup shows a capture that starts while it is open, with its buttons greyed out" and "a popup showing a capture goes on to the one queued behind it": the popup ignores `capture-start`.

    "a popup whose own capture waits its turn shows no other capture that starts meanwhile" passes already, because no popup takes `capture-start` yet. It fails when the check it covers is taken out (below).
  - **Test changes plus `background.js`:** 395 pass, and only the two popup tests that ignore `capture-start` fail.
  - **Every change:** `npm test` passes all 397 tests.
  - **Each part of the change is needed:**
    - With no `capture-start` from the worker, or with it sent when a capture is asked for rather than when its turn starts, the worker test fails.
    - With `capture-start` sent for a Region too, "says nothing of a Region, whose shot waits for the drag" fails. So does "still runs the capture after acknowledging it" in `tests/region-dispatch.test.js`, whose worker harness has no `sendMessage`.
    - With `capture-start` sent without its `.catch`, "drops a capture's end quietly when no popup is open to hear it" fails.
    - With the popup ignoring `capture-start`, or `watch` not calling `toggleRec`, the two popup tests fail.
    - With `watch` not checking `capturing`, "a popup whose own capture waits its turn shows no other capture that starts meanwhile" fails. So does KAN-545's "a press before the popup hears what is running goes by its own capture".
- **Headed Chrome 153.0.8010.48**, with `/tmp/vs387-chrome/run-561.js`, written for this plan from `run-545.js`:
  - The page is local and 8000 px tall. The viewport is 713 px at dpr 2, so a Full page is 12 screens and a 2560×16000 image.
  - Four cases:
    - **Nothing running:** a popup is opened, with no capture running.
    - **Own Full page:** a popup presses Full page.
    - **Started while open:** a popup is opened with nothing running. A shortcut's Full page is started in the worker with `runCapture` 1 s later, the way `onCommand` starts it.
    - **Queued:** two shortcut Full pages are started back to back, so the second waits its turn. A popup is opened 1.5 s into the first. This is the ticket's case.
  - Each popup's log starts with its status box and buttons as first seen, then every change, timed from when that popup opened. The buttons are listed as Visible, Full page, Region (1 = greyed out).
  - **Before, the repo as it is:**
    - **Nothing running:** no status box, buttons `000`.
    - **Own Full page:** "Capturing…", then "Capturing screen 1 of 12…" through "12 of 12…", then "Saved." at 7846 ms. The buttons were `111` until "Saved." and `000` after.
    - **Started while open:** no status box and buttons `000`, from the popup opening until 10 s after the image had been saved.
    - **Queued:**
      - When first seen, at 47 ms, the popup showed "Capturing…" with buttons `111`.
      - It then showed the first capture's "5 of 12…" through "12 of 12…", then "Saved." with `000` at 5710 ms.
      - Nothing changed after that, while the second capture ran and was saved. This is what the ticket describes.
  - **After, with the change:**
    - **Nothing running:** the same, no status box and buttons `000`.
    - **Own Full page:** the same as before, with "Saved." at 7766 ms.
    - **Started while open:**
      - `000` when first seen.
      - "Capturing…" with `111` at 1052 ms, as the capture started.
      - "1 of 12…" through "12 of 12…" (1112 to 7662 ms).
      - "Saved." with `000` at 8835 ms.
    - **Queued:**
      - "Capturing screen 4 of 12…" with `111` when first seen, at 54 ms.
      - The first capture's screens up to "12 of 12…" (4858 ms).
      - "Saved." with `000` at 5978 ms, then "Capturing…" with `111` in the same millisecond, as the second capture started.
      - The second capture's "1 of 12…" through "12 of 12…" (6070 to 12657 ms).
      - "Saved." with `000` at 14432 ms.
  - In every run, before and after:
    - Each Full page was saved at 2560×16000.
    - No console had an exception or an error.

## Steps

1. Make the test changes above in `tests/capture-errors.test.js`.
   → verify: `npm test` runs 397 tests. 394 pass, and only these 3 fail:
   - "tells every popup when a Visible or Full page starts, after the one before it has ended"
   - "a popup shows a capture that starts while it is open, with its buttons greyed out"
   - "a popup showing a capture goes on to the one queued behind it"
2. Make the `background.js` change above.
   → verify: `npm test` runs 397 tests. 395 pass, and only the two popup tests from step 1 fail.
3. Make the `popup.js` change above.
   → verify: `npm test` passes all 397 tests.
4. Check the change in headed Chrome: `node /tmp/vs387-chrome/run-561.js --ext /Users/john/dev/viewshot --headful`.
   → verify:
   - **Nothing running:** no status box, buttons `000`.
   - **Own Full page:** "Capturing…", "Capturing screen 1 of 12…" through "12 of 12…", then "Saved.". The buttons are `111` until "Saved." and `000` after.
   - **Started while open:** `000` until the capture starts, then "Capturing…" with `111`, its screens up to "12 of 12…", then "Saved." with `000`.
   - **Queued:** the first capture's screens and its "Saved.", then at once "Capturing…" with `111`. Then the second capture's "1 of 12…" through "12 of 12…", then "Saved." with `000`.
   - Each image is 2560×16000, and no console has an exception or an error.
5. Check that nothing else changed.
   → verify: `git status --short` lists only the three files above and this plan.

## Open questions

None. The ticket asks that a Visible or Full page whose turn starts while the popup is open be shown there, with the buttons greyed out, as KAN-545 does for one already running when the popup opens. This plan does that with one more message, `capture-start`, alongside the ones KAN-545 added.

## Added when shipping

- **No tests beyond those in "Change".** Taking out any one part of the change makes one of them fail (see "Each part of the change is needed"). That includes the `.catch` on the `capture-start` send, which "drops a capture's end quietly when no popup is open to hear it" covers.
- **Step 4, run on this folder:** the same results as in "Checked while planning".
  - Nothing running: no status box, buttons `000`.
  - Own Full page: "Saved." at 7882 ms, with the buttons `111` until then and `000` after.
  - Started while open: `000` until the capture started. Then "Capturing…" with `111` at 1053 ms, "1 of 12…" through "12 of 12…", then "Saved." with `000` at 8784 ms.
  - Queued:
    - The first capture's screens up to "12 of 12…", then "Saved." with `000` at 5990 ms.
    - "Capturing…" with `111` in the same millisecond.
    - The second capture's "1 of 12…" through "12 of 12…", then "Saved." with `000` at 14425 ms.
  - Each image was 2560×16000, and no console had an exception or an error.
- `npm test` passes all 397.
