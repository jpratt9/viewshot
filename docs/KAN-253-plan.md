# KAN-253: Popup refuses other extensions' pages and data: URLs, which Chromium's source says activeTab can capture

Ticket: https://prattsolutions.atlassian.net/browse/KAN-253 (To Do, no comments, labels `bug` and `viewshot`). It is blocked by KAN-241, which is Done.

## What the repo does now

Line numbers are from the working tree on top of `14b118f`. That tree also holds the uncommitted changes for KAN-222 and KAN-251 (see the open question):
- They don't move any `popup.js` line the ticket cites.
- They move the popup tests in `tests/capture-errors.test.js` down 46 lines. For example, the ticket's `:210-220` is now `:256-266`.

- **The popup's check**
  - `CAPTURABLE` (`popup.js:15`) is the list of URL schemes the popup accepts: http(s), file, ftp and chrome. `chrome-extension:` and `data:` aren't on it.
  - So on those pages `uncapturable()` (`popup.js:17`) is true. Every button then shows "Can’t capture this page. Open a normal http(s) page and try again." and sends nothing (`popup.js:91-94`).
  - Past that check, screenshots can still be refused for certain pages:
    - Full page and Region are refused on the Web Store (`popup.js:119-122`).
    - Full page and Region are refused on chrome:// pages (`CHROME_PAGE`, `popup.js:16`, checked at `popup.js:123-126`).
    - Each has its own message. Record never reaches these checks.
  - The comment above the check (`popup.js:8-14`) says which pages get through, and why.
- **The worker doesn't check URLs.**
  - **Visible:** `runCapture` (`background.js:85-106`) first calls `cancelRegion` and `setScrollbarHidden`. Both carry on when a page won't run their scripts (`background.js:289`, `background.js:269`).
  - **Full page and Region:** both start by running a script in the page (`background.js:171-174`, `background.js:303`). On a page that won't run scripts, they fail and `captureFailed` shows `!` (`background.js:80-83`).
  - **Record:** `blipRecordingIndicator` and `getViewport` log a warning and carry on (`background.js:457`, `background.js:427`).
- **Seen in headless Chrome 152.0.7977.83** while planning.
  - **Setup:**
    - A copy of the working tree was loaded unpacked.
    - A second extension, with only a manifest and a `page.html`, provided the "other extension's page".
    - The popup was opened on each page with `Extensions.triggerAction`, which grants activeTab.
  - **The popup as it is now:** on the other extension's `page.html` and on a `data:text/html,…` page, every button showed "Can’t capture this page…" and nothing was saved. This covered Visible, Full page, Region, and Record with WebM and with GIF.
  - **The tab's URL:** on both pages, the popup and the worker could read it.
  - **Past the popup's check:**
    - Screenshots were run by calling the worker's `runCapture` directly.
    - For Record, the stream id was created in the popup and `rec-start` was sent by hand.

  | Page | Visible | Full page and Region | Record |
  |---|---|---|---|
  | the other extension's `page.html` | saved a 1280×713 PNG of the page | failed with "Cannot access a chrome-extension:// URL of different extension"; nothing saved | saved a WebM (VP9, 800×600) and a GIF (720×540) |
  | `data:text/html,…` | saved a 1280×713 PNG of the page | failed with "Cannot access contents of the page. Extension manifest must request permission to access the respective host."; nothing saved | saved a WebM (VP9, 800×600) and a GIF (720×540) |
  | an http page, for comparison | saved a 1280×713 PNG | Full page saved a 1280×3000 PNG; Region waited for a drag | saved a WebM (VP9, 1278×712) and a GIF (720×401) |

  - On the two pages, the worker logged only the existing "blip failed" and "getViewport failed" warnings.
- **Tests**
  - **"refuses other extensions' pages, devtools and about:blank"** (`tests/capture-errors.test.js:256-266`):
    - It presses Visible and Region on `chrome-extension://abc/page.html`, `devtools://devtools/bundled/x.html` and `about:blank`.
    - It expects each press to be refused, with a message.
  - **"the refusal messages no longer steer the user away from chrome:// pages or the Web Store"** (`tests/capture-errors.test.js:319-334`) presses Visible on `chrome-extension://abc/page.html` to get the "Can’t capture this page…" message.
  - **The chrome:// section** (`tests/capture-errors.test.js:277-317`) has the three tests to copy:
    - Visible goes through.
    - Full page and Region are refused with the chrome:// message.
    - Record goes through, with WebM and with GIF.
  - **data: URLs:** no test uses one.
  - **Counts:** `npm test` passes 134 tests, 28 of them in `tests/capture-errors.test.js`.
- **The README** doesn't list which pages can be captured, and `tests/readme.test.js` doesn't check for such a list.

## Change

Two files change.

1. **`popup.js`:**
   - **The accepted schemes:** add `chrome-extension` and `data` to `CAPTURABLE` (`popup.js:15`).
   - **A new pattern:** after `CHROME_PAGE` (`popup.js:16`), add `EXTENSION_OR_DATA`, which matches `chrome-extension:` and `data:`.
   - **A new refusal:** after the chrome:// check (`popup.js:123-126`), refuse Full page and Region on those pages the same way, with their own message.
   - **The comment:** rewrite `popup.js:8-13` so it names the two new kinds of page.
   - **What stays:** the chrome:// check and its message stay as they are.

   ```diff
   @@ -5,15 +5,16 @@

    const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };

   -// Pages that aren't http(s), file, ftp or chrome:// are refused before anything
   -// is sent: captures there failed in the worker, which threw into a console the
   -// user never has open. chrome:// pages (the New Tab page is one) refuse
   -// executeScript ("Cannot access a chrome:// URL"), which Full page and Region
   -// need, but activeTab still lets Chrome capture and record them, so Visible
   -// and Record go through.
   +// Pages that aren't http(s), file, ftp, chrome://, another extension's page or
   +// a data: URL are refused before anything is sent: captures there failed in the
   +// worker, which threw into a console the user never has open. chrome:// pages
   +// (the New Tab page is one), other extensions' pages and data: URLs all refuse
   +// executeScript, which Full page and Region need, but activeTab still lets
   +// Chrome capture and record them, so Visible and Record go through.
    // activeTab is null until load() resolves; the worker's badge covers that gap.
   -const CAPTURABLE = /^(https?|file|ftp|chrome):/i;
   +const CAPTURABLE = /^(https?|file|ftp|chrome|chrome-extension|data):/i;
    const CHROME_PAGE = /^chrome:/i;
   +const EXTENSION_OR_DATA = /^(chrome-extension|data):/i;
    const uncapturable = (tab) => !!(tab && tab.url && !CAPTURABLE.test(tab.url));
    // Chrome never lets an extension script the Web Store (all of chrome.google.com
    // and chromewebstore.google.com), so Full page and Region can't run there.
   @@ -124,6 +125,10 @@
            showError('Chrome doesn’t let extensions run Full page or Region on chrome:// pages. Visible still works here.');
            return; // keep the popup open so the error is visible
          }
   +      if (btn.dataset.mode !== 'visible' && EXTENSION_OR_DATA.test(activeTab?.url || '')) {
   +        showError('Chrome doesn’t let extensions run Full page or Region on other extensions’ pages or data: URLs. Visible still works here.');
   +        return; // keep the popup open so the error is visible
   +      }
          await save();
          // Wait for the worker to acknowledge before closing anything. window.close()
          // in the same turn as the send tears this frame down while a cold-starting
   ```

2. **`tests/capture-errors.test.js`:**
   - **"refuses other extensions' pages, devtools and about:blank"** (`:256-266`):
     - Replace `chrome-extension://abc/page.html` with `chrome-untrusted://print/`.
     - Rename the test to "refuses devtools, chrome-untrusted:// and about:blank pages".
   - **The refusal-message test** (`:321`): press Visible on `devtools://devtools/bundled/x.html` instead of `chrome-extension://abc/page.html`.
   - **A new section** after the refusal-message test (`:334`) covers other extensions' pages and data: URLs. It has three tests, copied from the chrome:// section. Each runs on `chrome-extension://abc/page.html` and `data:text/html,<p>x</p>`:
     1. Visible is sent to the worker as a `capture`.
     2. Full page and Region are refused with the new message, and nothing is sent.
     3. Record with WebM and with GIF each send a `rec-start`.

   ```diff
   @@ -253,8 +253,8 @@
      };
    }

   -test('refuses other extensions\' pages, devtools and about:blank', async () => {
   -  for (const url of ['chrome-extension://abc/page.html', 'devtools://devtools/bundled/x.html', 'about:blank']) {
   +test('refuses devtools, chrome-untrusted:// and about:blank pages', async () => {
   +  for (const url of ['devtools://devtools/bundled/x.html', 'chrome-untrusted://print/', 'about:blank']) {
        for (const mode of ['visible', 'region']) {
          const p = loadPopup(url);
          await p.ready();
   @@ -318,7 +318,7 @@

    test('the refusal messages no longer steer the user away from chrome:// pages or the Web Store', async () => {
      // Visible and Record work on both.
   -  const page = loadPopup('chrome-extension://abc/page.html');
   +  const page = loadPopup('devtools://devtools/bundled/x.html');
      await page.ready();
      await page.click('visible');
      assert.strictEqual(page.els.err.hidden, false);
   @@ -333,6 +333,47 @@
      assert.doesNotMatch(rec.els.err.textContent, /chrome:\/\/|Web Store/);
    });

   +// --- other extensions' pages and data: URLs ----------------------------------
   +// Chrome refuses executeScript on these too, and once the popup has granted
   +// activeTab it lets captureVisibleTab and tabCapture through, as on chrome://
   +// pages. The popup still refused every mode there.
   +
   +const EXTENSION_AND_DATA_URLS = ['chrome-extension://abc/page.html', 'data:text/html,<p>x</p>'];
   +
   +test('takes a Visible screenshot of other extensions\' pages and data: URLs', async () => {
   +  for (const url of EXTENSION_AND_DATA_URLS) {
   +    const p = loadPopup(url);
   +    await p.ready();
   +    await p.click('visible');
   +    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `Visible on ${url} was wrongly blocked`);
   +  }
   +});
   +
   +test('refuses Full page and Region on other extensions\' pages and data: URLs with a message', async () => {
   +  for (const url of EXTENSION_AND_DATA_URLS) {
   +    for (const mode of ['fullpage', 'region']) {
   +      const p = loadPopup(url);
   +      await p.ready();
   +      await p.click(mode);
   +      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was sent to the worker`);
   +      assert.strictEqual(p.els.err.hidden, false);
   +      assert.match(p.els.err.textContent, /Full page or Region on other extensions’ pages or data: URLs\. Visible still works/);
   +    }
   +  }
   +});
   +
   +test('records on other extensions\' pages and data: URLs', async () => {
   +  for (const url of EXTENSION_AND_DATA_URLS) {
   +    for (const format of ['webm', 'gif']) {
   +      const p = loadPopup(url);
   +      await p.ready();
   +      p.els.format.value = format; // turns Visible into Record
   +      await p.click('visible');
   +      assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], `recording ${url} as ${format} was blocked`);
   +    }
   +  }
   +});
   +
    // --- pages that pass the scheme check but still can't be captured ---------
    // Chrome never lets an extension script the Web Store, and a file:// page can't
    // be scripted or captured until "Allow access to file URLs" is on. The popup
   ```

Choices:

- **Do what KAN-241 and KAN-252 did for chrome:// pages.**
  - Adding both schemes to `CAPTURABLE` lets Visible and Record through.
  - Full page and Region get their own refusal, next to the Web Store and chrome:// ones.
- **One refusal for both kinds of page.**
  - The ticket groups them, and Full page and Region fail on both for the same reason: Chrome won't let the extension run scripts there.
  - One pattern and one message cover both, and the message names both.
  - The chrome:// check and its message don't change, so neither does their test.
- **Refuse Full page and Region in the popup.**
  - Otherwise, both modes would reach the worker, fail, and only show `!`. Region would also close the popup first.
  - The banner at `tests/capture-errors.test.js:336-340` describes exactly that as the bug KAN-217 fixed.
- **Match the scheme, not a list of pages.**
  - `chrome-extension:` covers every extension's pages, including ViewShot's own. Those never show in a tab in normal use, and they weren't checked.
  - `data:` covers every data: URL. Only a `text/html` one was checked.
  - The pattern still ends in a colon, so `chrome-untrusted://` and `chrome-search://` pages stay refused.
- **Keep a test that fails if the colon is dropped.**
  - Until now, pressing Visible on `chrome-extension://abc/page.html` was what failed if a scheme pattern lost its colon (KAN-241, KAN-252). Visible now goes through there.
  - So the test uses `chrome-untrusted://print/` instead, and is renamed after the pages it covers, as KAN-257 did.
  - Checked on a copy: with the colon removed from `CAPTURABLE`, the renamed test fails.
- **The refusal-message test needs a page that still gets "Can’t capture this page…".** It now uses the `devtools://` URL from the test above.
- **Test WebM and GIF,** as the chrome:// Record test does.
- **Leave the worker, the keyboard shortcuts and the manifest alone.**
  - activeTab is enough, as the table shows.
  - Recordings of these pages aren't sized to the tab. That is KAN-242.
- **No README change.** The README doesn't list which pages can be captured.
- **No version bump.** KAN-241 (`52821dc`), KAN-252 (`e226216`) and KAN-257 (`14b118f`) all kept 0.3.2.

Checked while planning, on copies of the working tree outside this folder:

- **Unit tests:**
  - **As it is now:** `tests/capture-errors.test.js` passes 28 tests.
  - **Test changes only:** it runs 31 tests, and exactly these three fail:
    - "takes a Visible screenshot of other extensions' pages and data: URLs", with "Visible on chrome-extension://abc/page.html was wrongly blocked".
    - "refuses Full page and Region on other extensions' pages and data: URLs with a message", because "Can’t capture this page…" doesn't match the new message.
    - "records on other extensions' pages and data: URLs", with "recording chrome-extension://abc/page.html as webm was blocked".
  - **Both changes:** `tests/capture-errors.test.js` passes 31 tests, and `npm test` passes 137.
- **Chrome 152, changed copy.** Same setup as the table above, this time clicking the popup's buttons:
  - **The other extension's page and the data: page:**
    - Visible saved a 1280×713 PNG of the page. No error showed, and the badge stayed clear.
    - Record saved a VP9 WebM at 800×600 and a 720×540 GIF. No error showed, and the badge stayed clear.
    - Full page and Region showed "Chrome doesn’t let extensions run Full page or Region on other extensions’ pages or data: URLs. Visible still works here." Nothing was saved, and the badge stayed clear.
  - **An http page:** Visible saved a 1280×713 PNG, Full page a 1280×3000 PNG, WebM a VP9 at 1278×712, and GIF a 720×401 GIF.

## Steps

1. Make the `tests/capture-errors.test.js` changes above.
   → verify: `node --test tests/capture-errors.test.js` runs 31 tests. The other 28 pass, and only the three new ones fail:
   - "takes a Visible screenshot of other extensions' pages and data: URLs"
   - "refuses Full page and Region on other extensions' pages and data: URLs with a message"
   - "records on other extensions' pages and data: URLs"
2. Make the `popup.js` change above.
   → verify: `npm test` passes 137 tests, which is the 134 existing ones plus the three new ones.
3. Check the change in Chrome 152, with the repo loaded unpacked.
   - **Setup:** use the headless setup from step 3 of `docs/KAN-241-plan.md`:
     - set `download.default_directory` in `Default/Preferences`;
     - don't call `Browser.setDownloadBehavior`;
     - open and close one warm-up popup first.
   - **The other extension:** also load a second unpacked extension that has only a manifest and a `page.html`, and open `chrome-extension://<its id>/page.html`.
   - **The data: page:** open it with `Target.createTarget({ url: 'data:text/html,…', forTab: true })`.

   → verify:
   - **The other extension's page and the data: page:**
     - Visible saves an image of the page, with no error and no badge.
     - Record saves a `.webm` with WebM selected and a `.gif` with GIF selected. Neither shows an error or a badge.
     - Full page and Region show "Chrome doesn’t let extensions run Full page or Region on other extensions’ pages or data: URLs. Visible still works here." Nothing is saved, and the badge stays clear.
   - **An http page:** Visible, Full page, WebM and GIF all still save.
4. Check that nothing else changed.
   → verify: this depends on the open question.
   - **If KAN-222 and KAN-251 are committed first:** `git status --short` lists only `popup.js`, `tests/capture-errors.test.js` and this plan.
   - **If not:** it also lists the files and plans they already change, and `git diff` shows their changes mixed with these.

## Noticed while planning, not changed

- **Recordings of these pages are letterboxed.**
  - For a 1280×713 tab, the WebM is 800×600 and the GIF is 720×540, because `getViewport` can't run there.
  - That is KAN-242, and chrome:// pages already behave the same way.
- **Visible screenshots of these pages show the page's scrollbar.**
  - "Hide scrollbar before capturing" is on by default. But `setScrollbarHidden` can't run on these pages and carries on without hiding it (`background.js:246-270`). Both 1280×713 PNGs show the scrollbar.
  - The comment there (`background.js:247-249`) says such pages have no scrollbar to hide. That isn't true of a tall data: page or extension page.

## Open questions

1. **Commit KAN-222 and KAN-251 first?**
   - Both are Done in Jira, but their changes are still uncommitted.
   - KAN-222 changes `popup.js` (`:3`). Both change `tests/capture-errors.test.js`. This plan changes both files too.
   - The steps work either way. But if they aren't committed first, this ticket's diff is mixed in with theirs, and step 4 can't show this change on its own.
