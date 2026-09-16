# KAN-252: Popup refuses Record on chrome:// pages, which Chrome lets it record

Ticket: https://prattsolutions.atlassian.net/browse/KAN-252 (To Do, no comments, labels `bug` and `viewshot`). It is blocked by KAN-241, which is Done. When KAN-241 was closed, the note settling its plan's open question said Record should be allowed on chrome:// pages, and that the work belongs to this ticket.

## What the repo does now

- **The popup's check**, as of `52821dc`:
  - `CAPTURABLE` (`popup.js:15`) matches http(s), file and ftp. `CHROME_PAGE` (`popup.js:16`) matches `chrome:`.
  - `uncapturable(tab, rec)` (`popup.js:17`) counts a chrome:// page as capturable only when `rec` is false.
  - The click handler passes `isRecFmt($('format').value)` as `rec` (`popup.js:91`). So with WebM or GIF selected, a chrome:// page gets "Can’t capture this page. Open a normal http(s) page and try again." (`popup.js:92`), and `getMediaStreamId` (`popup.js:102`) is never called.
  - The screenshot branch refuses Full page and Region on chrome:// pages (`popup.js:123-126`), right after the Web Store check (`popup.js:119-122`). Record never reaches that branch.
  - `CHROME_PAGE` is used in two places: `uncapturable()` and that Full page/Region check.
  - The comment at `popup.js:8-13` says only a Visible screenshot of a chrome:// page is let through.
- **The worker needs nothing from the page to record.**
  - `startRecording` (`background.js:365-395`) calls `blipRecordingIndicator` (`background.js:426-448`) and `getViewport` (`background.js:402-417`).
  - On a page that refuses scripts, both log a warning and carry on.
- **The repo already allows Record where screenshots can't go.**
  - The file:// check says "Recording needs neither, so only the screenshot modes stop here" (`popup.js:112-114`), and KAN-217 kept Record on the Web Store.
  - Those recordings aren't sized to the tab. That is KAN-242.
- **Seen in headless Chrome 152.0.7977.83**, while planning and checking KAN-241:
  - **The popup as it is now:** pressing Record on `chrome://version/`, `chrome://settings/` and `chrome://newtab/` showed the refusal above, and nothing was saved.
  - **With the check bypassed:** the stream id was minted in the popup, and `rec-start` and `rec-stop` were sent by hand. Each of `chrome://version/`, `chrome://settings/`, `chrome://extensions/` and `chrome://newtab/` saved a VP9 WebM at 800×600.
- **Tests**
  - "still refuses Record on chrome:// pages" (`tests/capture-errors.test.js:260-269`) expects the refusal.
  - The banner of the "chrome:// pages" section (`tests/capture-errors.test.js:231-234`) says Chrome lets `captureVisibleTab` through there. It says nothing about `tabCapture`.
  - The comment in the refusal-message test (`tests/capture-errors.test.js:272`) says "Visible works on both, and Record works on the Web Store."
  - "still records on the Web Store, and on a file:// page without file access" (`tests/capture-errors.test.js:335`) is the existing Record test to copy.
  - `npm test` passes 128 tests, 23 of them in `tests/capture-errors.test.js`.

## Change

Two files change.

1. **`popup.js`:**
   - Add `chrome` to `CAPTURABLE` (`popup.js:15`), as the ticket suggests.
   - `uncapturable()` (`popup.js:17`) goes back to taking one argument. Its call at `popup.js:91` goes back to `uncapturable(activeTab)`. Both return to how they were before KAN-241.
   - `CHROME_PAGE` (`popup.js:16`) stays, because the Full page/Region refusal (`popup.js:123-126`) still uses it.
   - Rewrite the comment at `popup.js:8-13` so it says Visible and Record go through on chrome:// pages.
   - Both refusal messages stay as they are.

   ```diff
   @@ -5,16 +5,16 @@

    const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };

   -// Pages that aren't http(s), file or ftp are refused before anything is sent:
   -// captures there failed in the worker, which threw into a console the user
   -// never has open ("Cannot access a chrome:// URL"). A Visible screenshot of a
   -// chrome:// page (the New Tab page is one) is let through: Chrome refuses
   -// executeScript there, which Full page and Region need, but activeTab still
   -// lets it capture the page.
   +// Pages that aren't http(s), file, ftp or chrome:// are refused before anything
   +// is sent: captures there failed in the worker, which threw into a console the
   +// user never has open. chrome:// pages (the New Tab page is one) refuse
   +// executeScript ("Cannot access a chrome:// URL"), which Full page and Region
   +// need, but activeTab still lets Chrome capture and record them, so Visible
   +// and Record go through.
    // activeTab is null until load() resolves; the worker's badge covers that gap.
   -const CAPTURABLE = /^(https?|file|ftp):/i;
   +const CAPTURABLE = /^(https?|file|ftp|chrome):/i;
    const CHROME_PAGE = /^chrome:/i;
   -const uncapturable = (tab, rec) => !!(tab && tab.url && !CAPTURABLE.test(tab.url) && (rec || !CHROME_PAGE.test(tab.url)));
   +const uncapturable = (tab) => !!(tab && tab.url && !CAPTURABLE.test(tab.url));
    // Chrome never lets an extension script the Web Store (all of chrome.google.com
    // and chromewebstore.google.com), so Full page and Region can't run there.
    // Visible still can: Chrome lets activeTab capture the store.
   @@ -88,7 +88,7 @@
    document.querySelectorAll('#modes .mode').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
   -    if (uncapturable(activeTab, isRecFmt($('format').value))) {
   +    if (uncapturable(activeTab)) {
          showError('Can’t capture this page. Open a normal http(s) page and try again.');
          return; // keep the popup open so the error is visible
        }
   ```

2. **`tests/capture-errors.test.js`:**
   - **Replace** "still refuses Record on chrome:// pages" with "records on chrome:// pages". The new test starts a WebM and a GIF recording on each chrome:// page and expects a `rec-start` each time, the same way the Web Store Record test does.
   - **Section banner** (`:231-234`): say Chrome lets `tabCapture` through as well, and that the popup still refused Record after KAN-241.
   - **Comment in the refusal-message test** (`:272`): change it to "Visible and Record work on both."

   ```diff
   @@ -230,8 +230,9 @@

    // --- chrome:// pages ---------------------------------------------------------
    // Chrome refuses executeScript on chrome:// pages, but once the popup has
   -// granted activeTab it lets captureVisibleTab through. The popup refused every
   -// mode there, so the one capture Chrome allows never reached the worker.
   +// granted activeTab it lets captureVisibleTab and tabCapture through. The popup
   +// refused every mode there, and then still refused Record, so captures Chrome
   +// allows never reached the worker.

    const CHROME_URLS = ['chrome://extensions/', 'chrome://version/', 'chrome://newtab/'];

   @@ -257,19 +258,20 @@
      }
    });

   -test('still refuses Record on chrome:// pages', async () => {
   +test('records on chrome:// pages', async () => {
      for (const url of CHROME_URLS) {
   -    const p = loadPopup(url);
   -    await p.ready();
   -    p.els.format.value = 'webm'; // turns Visible into Record
   -    await p.click('visible');
   -    assert.deepStrictEqual(p.sent, [], `recording ${url} was sent to the worker`);
   -    assert.strictEqual(p.els.err.hidden, false);
   +    for (const format of ['webm', 'gif']) {
   +      const p = loadPopup(url);
   +      await p.ready();
   +      p.els.format.value = format; // turns Visible into Record
   +      await p.click('visible');
   +      assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], `recording ${url} as ${format} was blocked`);
   +    }
      }
    });

    test('the refusal messages no longer steer the user away from chrome:// pages or the Web Store', async () => {
   -  // Visible works on both, and Record works on the Web Store.
   +  // Visible and Record work on both.
      const page = loadPopup('chrome-extension://abc/page.html');
      await page.ready();
      await page.click('visible');
   ```

Choices:

- **Take the ticket's suggestion.**
  - Putting `chrome` in `CAPTURABLE` lets every mode past the first check on chrome:// pages. The existing chrome:// check then refuses only Full page and Region.
  - That makes the `rec` argument pointless, so it goes.
- **The colon still keeps other extensions' pages out.** `chrome-extension:` doesn't match `/^(https?|file|ftp|chrome):/i`. The existing test "refuses the extension gallery and devtools too" (`tests/capture-errors.test.js:210-220`) still presses Visible there, so it would catch a mistake.
- **Test both WebM and GIF,** because the ticket names both.
- **Keep refusing Full page and Region on chrome:// pages,** as the ticket says.
- **Leave the worker alone.**
  - Recordings of chrome:// pages aren't sized to the tab: WebM comes out 800×600, and GIF comes out 720×540 with black bars.
  - That is KAN-242, and the repo already allows Record on the Web Store and file:// pages with the same limitation.
- **Leave both refusal messages as they are.**
  - "Can’t capture this page…" now shows only on pages that aren't http(s), file, ftp or chrome://.
  - "Can’t record this tab…" shows only when Chrome refuses a stream id.
  - Neither mentions chrome:// or the Web Store.
- **No README change.** The README doesn't list which pages can be captured.
- **No version bump.** KAN-241 (52821dc), KAN-214 (0758c47) and KAN-243 (88f34a7) all kept 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **Test changes only:** `tests/capture-errors.test.js` runs 23 tests. Only "records on chrome:// pages" fails, with "recording chrome://extensions/ as webm was blocked". The other 22 pass.
  - **Both changes:** `npm test` passes 128 tests.
- **Chrome 152, changed copy.** The popup's buttons were clicked on `chrome://version/`, `chrome://settings/`, `chrome://extensions/` and `chrome://newtab/`:
  - **Record, WebM:** saved a VP9 WebM at 800×600. No error showed, and the badge stayed clear.
  - **Record, GIF:** saved a 720×540 GIF with 38–39 frames. The page shows, with black bars above and below it. No error showed, and the badge stayed clear.
  - The worker logged only the existing "blip failed" and "getViewport failed" warnings.
  - **Visible** saved a 1280×713 PNG.
  - **Full page and Region** showed "Chrome doesn’t let extensions run Full page or Region on chrome:// pages. Visible still works here."
- **An http page, same run:** Visible saved a 1280×713 PNG, Full page a 1280×3000 PNG, WebM a VP9 at 1278×712, and GIF a 720×401 GIF.

## Steps

1. Make the `tests/capture-errors.test.js` changes above.
   → verify: `node --test tests/capture-errors.test.js` runs 23 tests and fails only "records on chrome:// pages". The other 22 pass.
2. Make the `popup.js` change above.
   → verify: `npm test` passes 128 tests. The count doesn't change, because one test is replaced by another.
3. Check the change in Chrome 152, with the repo loaded unpacked, using the headless setup from step 3 of `docs/KAN-241-plan.md`. That means `download.default_directory` in `Default/Preferences`, and no `Browser.setDownloadBehavior`.
   → verify:
   - **`chrome://version/`, `chrome://settings/` and `chrome://newtab/`:**
     - Record with WebM selected saves a `.webm`, and Record with GIF selected saves a `.gif`. Neither shows an error or a badge.
     - Visible saves an image.
     - Full page and Region show the chrome:// message and save nothing.
   - **An http page:** Visible, Full page, WebM and GIF all still save.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **Recordings of chrome:// pages are letterboxed.** The WebM is 800×600 for a 1280×713 tab, and the GIF is 720×540 with black bars above and below the page. `getViewport` can't run on these pages, which is KAN-242's bug.

## Open questions

None.

- The ticket names the change.
- The note on KAN-241 settled that Record should be allowed on chrome:// pages, in this ticket.
- The Chrome runs above show that WebM and GIF both record there.
