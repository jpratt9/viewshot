# KAN-546: Full page and Region fail on a tab showing Chrome's error page without saying why

Ticket: https://prattsolutions.atlassian.net/browse/KAN-546. It is a To Do Task labelled `bug` and `viewshot`, with no comments. It was blocked by KAN-220, which is Done.

## What the repo does now

As of `28cf14b`:

- **The popup's page checks go by the tab's URL alone.**
  - `CAPTURABLE`, `CHROME_PAGE`, `EXTENSION_OR_DATA` and `WEB_STORE` are URL patterns (`popup.js:22-29`).
  - The click handler refuses pages it can't capture at all (`:118-121`), and every screenshot mode on a file:// page without file access (`:158-161`). It refuses Full page and Region on the Web Store, chrome:// pages, and other extensions' pages and data: URLs in plain words, adding "Visible still works here." (`:162-173`).
  - Chrome's error page keeps the http(s) URL that failed to load, so none of these checks catch it.
- **So Full page and Region are sent, and fail in the worker.**
  - Full page's first page script is `measurePage` (`background.js:403-406`). Chrome refuses it with "Frame with ID 0 is showing error page". The worker answers the popup with that text as it is (`background.js:17`), and the popup shows it in the red box (`popup.js:195`).
  - Region is answered at once (`background.js:11`), and the popup closes (`popup.js:200`). Putting `region.js` on the page (`background.js:753`) then fails, and `captureFailed` (`background.js:241-244`) only logs it and flashes `!` for 3 s.
- **Only a script can tell.** No tab property says that a tab is showing an error page. `chrome.webNavigation.getFrame` could, but the manifest doesn't have that permission (`manifest.json:6`). Tried from the popup, a script on the error page is refused at once; see "Checked while planning".
- **The popup can already run a script on its tab.** `scripting` is in the manifest (`manifest.json:6`), and opening the popup grants activeTab on its tab.
- **Tests:** `npm test` runs 380 tests, and all pass.
  - The refusals on chrome:// pages, other extensions' pages and data: URLs, and the Web Store are tested at `tests/capture-errors.test.js:362`, `:420` and `:453`.
  - `loadPopup` (`tests/capture-errors.test.js:261-322`) has no `chrome.scripting`, and no test has an error page.

## Change

Two files change: `popup.js` and `tests/capture-errors.test.js`. `background.js`, `manifest.json`, `README.md`, `package.json` and the other test files don't change.

1. **`popup.js`:** after the URL checks, Full page and Region try an empty script on the popup's tab (between `:179` and `:180`).
   - If Chrome refuses it because the tab is showing an error page, the popup says why in plain words, as it does for the other pages that refuse scripts, and sends nothing.
   - The try comes after the buttons are greyed out (`:179`), so a second press can't send a second capture while it waits. A Full page that is refused gives them back.
   - A script refused for any other reason is left to the worker, as before.

   ```diff
   @@ -179,2 +179,20 @@
          if (shot) { capturing = true; toggleRec(); showStatus('Capturing…'); }
   +      // Chrome's error page keeps the URL that failed to load, so the checks
   +      // above let it through, but Chrome refuses page scripts there, which
   +      // Full page and Region need. They failed in the worker instead: Full
   +      // page with Chrome's own "Frame with ID 0 is showing error page", and
   +      // Region with only the badge, once the popup had closed (KAN-546). Only
   +      // a script can tell, and Chrome refuses one there at once. A script
   +      // refused for any other reason is left to the worker, as before.
   +      if (btn.dataset.mode !== 'visible') {
   +        try {
   +          await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func: () => {}, injectImmediately: true });
   +        } catch (e) {
   +          if (/showing error page/.test(e.message)) {
   +            if (shot) { capturing = false; toggleRec(); }
   +            showError('Chrome doesn’t let extensions run Full page or Region on a page that failed to load. Visible still works here.');
   +            return; // keep the popup open so the error is visible
   +          }
   +        }
   +      }
          await save();
   ```

2. **`tests/capture-errors.test.js`:**
   - `loadPopup` gets a `chrome.scripting.executeScript` that records the tab each script was for. Given `scriptError`, it fails with that message (`:261`, `:265`, `:306`, `:315`).
   - Three tests go at the end.

   ```diff
   @@ -260,3 +260,3 @@
    
   -function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true } = {}) {
   +function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true, scriptError } = {}) {
      const els = {};
   @@ -265,2 +265,3 @@
      const streams = [];
   +  const scripts = []; // the tab each script the popup tried was for
      let onStored; // popup.js's chrome.storage.local.onChanged listener
   @@ -306,2 +307,5 @@
          extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
   +      // A script on the page: Chrome refuses one with `scriptError`, as its
   +      // error page does (KAN-546).
   +      scripting: { executeScript: async (o) => { scripts.push(o.target.tabId); if (scriptError) throw new Error(scriptError); return [{}]; } },
        },
   @@ -314,3 +318,3 @@
      return {
   -    ctx: context, els, sent, btn, writes, streams,
   +    ctx: context, els, sent, btn, writes, streams, scripts,
        ready: settle, // let load() resolve so activeTab is populated
   ```

   ```js
   // --- Chrome's error page (KAN-546) ------------------------------------------
   // A page that fails to load shows Chrome's error page, but the tab keeps the
   // URL that failed, so the popup's URL checks let Full page and Region through.
   // Chrome refuses page scripts there: Full page showed Chrome's own "Frame with
   // ID 0 is showing error page", and Region closed the popup and only flashed
   // the badge.

   const ERROR_PAGE = 'Frame with ID 0 is showing error page';

   test('refuses Full page and Region on Chrome\'s error page with a message', async () => {
     for (const mode of ['fullpage', 'region']) {
       const p = loadPopup('http://127.0.0.1:9/', { scriptError: ERROR_PAGE });
       await p.ready();
       await p.click(mode);
       assert.deepStrictEqual(p.scripts, [1], `${mode} didn't try a script on the popup's tab`);
       assert.deepStrictEqual(p.sent, [], `${mode} was sent to the worker`);
       assert.strictEqual(p.els.err.hidden, false);
       assert.match(p.els.err.textContent, /Full page or Region on a page that failed to load\. Visible still works/);
       assert.strictEqual(p.els.status.hidden, true, 'still said it was capturing');
       assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false], 'left greyed out for a capture that was never sent');
     }
   });

   test('still takes Visible on Chrome\'s error page, without trying a script', async () => {
     const p = loadPopup('http://127.0.0.1:9/', { scriptError: ERROR_PAGE });
     await p.ready();
     await p.click('visible');
     assert.deepStrictEqual(p.scripts, []);
     assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], 'Visible on the error page was wrongly blocked');
   });

   test('leaves Full page and Region to the worker when the script runs, or is refused for another reason', async () => {
     for (const scriptError of [undefined, 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.']) {
       for (const mode of ['fullpage', 'region']) {
         const p = loadPopup('https://a.com/x', { scriptError });
         await p.ready();
         await p.click(mode);
         assert.deepStrictEqual(p.sent.map((m) => [m.type, m.mode]), [['capture', mode]], `${mode} was wrongly blocked (${scriptError || 'the script ran'})`);
         assert.ok(!p.els.err || p.els.err.hidden, `${mode} showed an error of its own`);
       }
     }
   });
   ```

Choices:

- **The popup catches the error page before it sends anything,** as it does the Web Store, chrome:// pages, and other extensions' pages and data: URLs (`popup.js:162-173`). That covers Region, whose popup is gone by the time the worker finds out. The worker doesn't change.
- **The check is an empty script, tried with `chrome.scripting.executeScript`.**
  - No tab property says that a tab is showing an error page, and `chrome.webNavigation.getFrame` would need a new permission.
  - Chrome refuses the script on an error page at once. On an ordinary page it runs it in a few ms (see "Checked while planning").
  - `injectImmediately` has Chrome run it as soon as it can, rather than when the page has finished loading.
- **Only a refusal saying "showing error page" is caught.**
  - Any other failure goes to the worker as before, and the worker says what it was.
  - The popup harnesses in `tests/region-cancel.test.js` and `tests/region-dispatch.test.js` have no `chrome.scripting`. The TypeError there is such a failure, so their tests run as before.
- **The try comes after the buttons are greyed out.**
  - For Full page, the buttons are greyed out and "Capturing…" shows before the first await, as KAN-220 set up. A Full page that is refused gives the buttons back.
  - Region isn't greyed out, now or before.
- **The message follows the other refusals:** "Chrome doesn’t let extensions run Full page or Region on a page that failed to load. Visible still works here." Visible does work there: in Chrome it saved the error page (below).
- **No deadline on the try.**
  - Chrome answers it at once, on an error page and on an ordinary one.
  - A page too busy to run it couldn't run the capture's own scripts either. Before, the worker's 30 s deadline (`CAPTURE_SCRIPT_TIMEOUT_MS`) ended such a Full page with an error. Now the popup waits for the page, and can be closed.
  - Nothing else waits behind it: the try isn't in the worker's queue (KAN-213).
- **Shortcuts are unchanged.** A shortcut's Full page or Region on an error page still only flashes the badge, as every shortcut capture that fails does.
- **No README change, no new files, no version bump.**

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 380 tests.
  - **Test changes only:** 383 tests. 382 pass, and only "refuses Full page and Region on Chrome's error page with a message" fails: the popup tried no script and sent the capture. The other two new tests pass already.
  - **Every change:** `npm test` passes all 383 tests.
  - **Each part of the change is needed:**
    - With the script tried for Visible too, "still takes Visible on Chrome's error page, without trying a script" fails.
    - With every failed script refused, 5 tests fail:
      - "leaves Full page and Region to the worker when the script runs, or is refused for another reason";
      - "Region keeps the popup open until the worker acknowledges the message", "Region closes the popup only after the answer arrives" and "a refused message leaves the popup open and says so" in `tests/region-dispatch.test.js`;
      - "Region closes the popup so the page can be dragged on" in `tests/region-cancel.test.js`.
    - With the buttons not given back, or the script tried on another tab, the refusal test fails.
- **Headed Chrome 153.0.8010.48**, with `/tmp/vs387-chrome/run-546.js`, written for this plan from `run-220b.js`:
  - The error page is a tab opened at `http://127.0.0.1:9/` (connection refused). The ordinary page is local and 4000 px tall.
  - **A script tried from the popup:** refused on the error page with "Frame with ID 0 is showing error page" in 0 to 1 ms. Run on the ordinary page in 1 to 6 ms.
  - **Before, the repo as it is:**
    - **Full page on the error page:** the red box said "Frame with ID 0 is showing error page".
    - **Region on the error page:** the popup closed, and the badge showed `!`.
    - **Visible on the error page:** "Saved.", and the image was downloaded.
    - The worker logged "Frame with ID 0 is showing error page" twice.
  - **After, with the change:**
    - **Full page on the error page:** the red box said "Chrome doesn’t let extensions run Full page or Region on a page that failed to load. Visible still works here.", and the buttons were back.
    - **Region on the error page:** the popup stayed open with the same message, and there was no badge.
    - **Visible on the error page:** "Saved.", and the image was downloaded.
    - **The ordinary page, as before:** Full page said "Saved.". Region closed the popup and put the overlay up, and Escape took it down.
    - No console had an exception or an error.

## Steps

1. Make the test changes above in `tests/capture-errors.test.js`.
   → verify: `npm test` runs 383 tests. 382 pass, and only "refuses Full page and Region on Chrome's error page with a message" fails.
2. Make the `popup.js` change above.
   → verify: `npm test` passes all 383 tests.
3. Check the change in headed Chrome: `node /tmp/vs387-chrome/run-546.js --ext /Users/john/dev/viewshot --headful`.
   → verify:
   - **Full page on the error page:** the red box says "Chrome doesn’t let extensions run Full page or Region on a page that failed to load. Visible still works here.", and the buttons are `000`.
   - **Region on the error page:** the popup stays open with the same message, and the badge is empty.
   - **Visible on the error page:** "Saved.".
   - **The ordinary page:** Full page says "Saved.", and Region closes the popup with the overlay up.
   - No console has an exception or an error.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None. The ticket says what goes wrong and points to how the popup already handles the other pages that refuse scripts. This plan does the same for the error page.

## Added when shipping

- **One more test** in `tests/capture-errors.test.js`, after the three in "Change": "tries the script without waiting for the page to finish loading".
  - It checks that the popup asks for `injectImmediately`. "Choices" describes why, but no test in "Change" checked it.
  - It fails when `injectImmediately` is taken out.
- **Step 3, run on this folder:** the same results as in "Checked while planning".
  - Full page on the error page showed "Chrome doesn’t let extensions run Full page or Region on a page that failed to load. Visible still works here.", with the buttons back.
  - Region on the error page left the popup open with the same message, and no badge.
  - Visible on the error page said "Saved.".
  - On the ordinary page, Full page said "Saved.", and Region closed the popup with the overlay up.
  - No console had an exception or an error.
- `npm test` passes all 384.
