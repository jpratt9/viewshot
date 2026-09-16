# KAN-241: Popup refuses Visible on chrome:// pages, which Chrome lets it capture

Ticket: https://prattsolutions.atlassian.net/browse/KAN-241 (To Do, no comments, labels `bug` and `viewshot`). It is blocked by KAN-217, which is Done.

## What the repo does now

- **The popup's check**
  - `CAPTURABLE` and `uncapturable()` (`popup.js:12-13`) look only at the URL scheme: http(s), file or ftp.
  - The click handler runs that check first (`popup.js:87-90`), for every mode including Record. A chrome:// page fails it, so every button there shows "Can’t capture this page. Open a normal http(s) page (not chrome://, the Web Store, or a new tab) and try again."
  - The comment above the check (`popup.js:8-10`) says chrome:// pages, extension pages, devtools and the New Tab page refuse both `executeScript` and `captureVisibleTab`.
  - The screenshot branch already refuses by mode on two kinds of page: file:// pages without file access (`popup.js:111-114`), and Full page and Region on the Web Store (`popup.js:115-118`).
  - The Record branch shows its own message when `getMediaStreamId` fails (`popup.js:101`). That message also tells the user to avoid chrome:// pages and the Web Store.
  - `toggleRec()` reads the format with `isRecFmt($('format').value)` (`popup.js:77`). The click handler reads `opts` only after the scheme check (`popup.js:91`).
- **The worker** checks no URLs.
  - `runCapture` (`background.js:72-93`) first calls `cancelRegion` and `setScrollbarHidden`. Both swallow the injection error a chrome:// page gives (`background.js:276`, `background.js:256`), so Visible reaches `captureVisible` (`background.js:45-61`).
  - Full page starts with `executeScript(measurePage)` (`background.js:157-161`). Region starts with `executeScript({ files: ['region.js'] })` (`background.js:290`). On a chrome:// page both throw, and `captureFailed` flashes `!` (`background.js:67-70`).
- **Reproduced while planning** in headless Chrome 152.0.7977.83:
  - The extension was loaded unpacked from a copy of `HEAD`. Each page was opened, and the popup was opened on it with `Extensions.triggerAction`, which grants activeTab the way a toolbar click does.
  - **The popup as it is, on `chrome://version/`:** Visible, Full page, Region and Record all showed the "Can’t capture this page…" message. Nothing was sent or saved.
  - **With the popup open, bypassing its check:** each capture was started by hand, calling the worker's `runCapture` directly for the screenshots. For Record, the stream id was minted in the popup and `rec-start` was sent.

  | Page | Visible | Full page | Record (WebM) |
  |---|---|---|---|
  | `chrome://version/` | saved a 1280×713 PNG of the page | "Cannot access a chrome:// URL", nothing saved | saved a WebM |
  | `chrome://settings/` | saved a 1280×713 PNG of the page | same | saved a WebM |
  | `chrome://extensions/` | saved a 1280×713 PNG of the page | same | saved a WebM |
  | `chrome://newtab/` | saved a 1280×713 PNG of the New Tab page | same | saved a WebM |

  - The worker's `tabs.query` reports the New Tab page as `chrome://newtab/`.
  - Every WebM was VP9 at 800×600, because `getViewport` can't run on these pages (KAN-242). The only messages the worker logged were the existing "blip failed" and "getViewport failed" warnings.
- **Tests**
  - `loadPopup(url)` (`tests/capture-errors.test.js:166-208`) runs `popup.js` against a fake browser.
  - "refuses a chrome:// page with a message rather than a silent no-op" (`tests/capture-errors.test.js:210-217`) presses Visible on `chrome://extensions/`. It expects nothing to be sent and a message that names chrome://.
  - "refuses the extension gallery and devtools too" (`tests/capture-errors.test.js:219-226`) presses only Region, on `chrome-extension://`, `devtools://` and `about:blank`.
  - `npm test` passes 125 tests, 20 of them in `tests/capture-errors.test.js`.
- **The README** doesn't say which pages can be captured, and `tests/readme.test.js` doesn't check it.

## Change

Two files change.

1. **`popup.js`:**
   - After `CAPTURABLE` (`popup.js:12`), add `CHROME_PAGE`, which matches the `chrome:` scheme.
   - `uncapturable()` (`popup.js:13`) takes a second argument that says whether the format records. For a screenshot format, a chrome:// page no longer counts as uncapturable.
   - The check at `popup.js:87` passes `isRecFmt($('format').value)` as that argument.
   - In the screenshot branch, right after the Web Store refusal (`popup.js:115-118`), refuse Full page and Region on chrome:// pages in the same way.
   - Rewrite the comment at `popup.js:8-10` so it no longer says chrome:// pages refuse `captureVisibleTab`.
   - Remove "(not chrome://, the Web Store, or a new tab)" from both refusal messages (`popup.js:88`, `popup.js:101`).

   ```diff
   @@ -5,12 +5,16 @@

    const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };

   -// chrome://, extension pages, devtools and the New Tab page refuse both
   -// executeScript and captureVisibleTab, so every mode fails on them - the worker
   -// threw "Cannot access a chrome:// URL" into a console the user never has open.
   +// Pages that aren't http(s), file or ftp are refused before anything is sent:
   +// captures there failed in the worker, which threw into a console the user
   +// never has open ("Cannot access a chrome:// URL"). A Visible screenshot of a
   +// chrome:// page (the New Tab page is one) is let through: Chrome refuses
   +// executeScript there, which Full page and Region need, but activeTab still
   +// lets it capture the page.
    // activeTab is null until load() resolves; the worker's badge covers that gap.
    const CAPTURABLE = /^(https?|file|ftp):/i;
   -const uncapturable = (tab) => !!(tab && tab.url && !CAPTURABLE.test(tab.url));
   +const CHROME_PAGE = /^chrome:/i;
   +const uncapturable = (tab, rec) => !!(tab && tab.url && !CAPTURABLE.test(tab.url) && (rec || !CHROME_PAGE.test(tab.url)));
    // Chrome never lets an extension script the Web Store (all of chrome.google.com
    // and chromewebstore.google.com), so Full page and Region can't run there.
    // Visible still can: Chrome lets activeTab capture the store.
   @@ -84,8 +88,8 @@
    document.querySelectorAll('#modes .mode').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
   -    if (uncapturable(activeTab)) {
   -      showError('Can’t capture this page. Open a normal http(s) page (not chrome://, the Web Store, or a new tab) and try again.');
   +    if (uncapturable(activeTab, isRecFmt($('format').value))) {
   +      showError('Can’t capture this page. Open a normal http(s) page and try again.');
          return; // keep the popup open so the error is visible
        }
        const opts = read();
   @@ -98,7 +102,7 @@
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
          } catch (e) {
            console.error('[ViewShot] getMediaStreamId failed:', e);
   -        showError('Can’t record this tab. Open a normal http(s) page (not chrome://, the Web Store, or a new tab) and try again.');
   +        showError('Can’t record this tab. Open a normal http(s) page and try again.');
            return; // keep the popup open so the error is visible
          }
          await save();
   @@ -116,6 +120,10 @@
            showError('Chrome doesn’t let extensions run Full page or Region on the Web Store. Visible still works here.');
            return; // keep the popup open so the error is visible
          }
   +      if (btn.dataset.mode !== 'visible' && CHROME_PAGE.test(activeTab?.url || '')) {
   +        showError('Chrome doesn’t let extensions run Full page or Region on chrome:// pages. Visible still works here.');
   +        return; // keep the popup open so the error is visible
   +      }
          await save();
          // Wait for the worker to acknowledge before closing anything. window.close()
          // in the same turn as the send tears this frame down while a cold-starting
   ```

2. **`tests/capture-errors.test.js`:**
   - **Remove** "refuses a chrome:// page with a message rather than a silent no-op" (`tests/capture-errors.test.js:210-217`). What it checked, a message rather than a silent no-op, moves into the two tests below.
   - **Extend** "refuses the extension gallery and devtools too" (`tests/capture-errors.test.js:219-226`):
     - Press Visible as well as Region, and check that a message is shown.
     - Pressing Visible on `chrome-extension://` shows that `CHROME_PAGE` needs its colon.
   - **Add three tests** in a new "chrome:// pages" section, after "lets an ordinary page through untouched". Each one runs on `chrome://extensions/`, `chrome://version/` and `chrome://newtab/`:
     1. Visible is sent to the worker as a `capture`.
     2. Full page and Region are refused with the new chrome:// message, and nothing is sent.
     3. Record is still refused with a message, and nothing is sent.

   ```diff
   @@ -207,21 +207,15 @@
      };
    }

   -test('refuses a chrome:// page with a message rather than a silent no-op', async () => {
   -  const p = loadPopup('chrome://extensions/');
   -  await p.ready();
   -  await p.click('visible');
   -  assert.deepStrictEqual(p.sent, [], 'the worker was asked to capture a page it cannot touch');
   -  assert.strictEqual(p.els.err.hidden, false);
   -  assert.match(p.els.err.textContent, /chrome:\/\//);
   -});
   -
    test('refuses the extension gallery and devtools too', async () => {
      for (const url of ['chrome-extension://abc/page.html', 'devtools://devtools/bundled/x.html', 'about:blank']) {
   -    const p = loadPopup(url);
   -    await p.ready();
   -    await p.click('region');
   -    assert.deepStrictEqual(p.sent, [], `${url} was allowed through`);
   +    for (const mode of ['visible', 'region']) {
   +      const p = loadPopup(url);
   +      await p.ready();
   +      await p.click(mode);
   +      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was allowed through`);
   +      assert.strictEqual(p.els.err.hidden, false, `${mode} on ${url} was refused without a message`);
   +    }
      }
    });

   @@ -231,9 +225,49 @@
        await p.ready();
        await p.click('visible');
        assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `${url} was wrongly blocked`);
   +  }
   +});
   +
   +// --- chrome:// pages ---------------------------------------------------------
   +// Chrome refuses executeScript on chrome:// pages, but once the popup has
   +// granted activeTab it lets captureVisibleTab through. The popup refused every
   +// mode there, so the one capture Chrome allows never reached the worker.
   +
   +const CHROME_URLS = ['chrome://extensions/', 'chrome://version/', 'chrome://newtab/'];
   +
   +test('takes a Visible screenshot of chrome:// pages', async () => {
   +  for (const url of CHROME_URLS) {
   +    const p = loadPopup(url);
   +    await p.ready();
   +    await p.click('visible');
   +    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `Visible on ${url} was wrongly blocked`);
      }
    });

   +test('refuses Full page and Region on chrome:// pages with a message rather than a silent no-op', async () => {
   +  for (const url of CHROME_URLS) {
   +    for (const mode of ['fullpage', 'region']) {
   +      const p = loadPopup(url);
   +      await p.ready();
   +      await p.click(mode);
   +      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was sent to the worker`);
   +      assert.strictEqual(p.els.err.hidden, false);
   +      assert.match(p.els.err.textContent, /Full page or Region on chrome:\/\/ pages\. Visible still works/);
   +    }
   +  }
   +});
   +
   +test('still refuses Record on chrome:// pages', async () => {
   +  for (const url of CHROME_URLS) {
   +    const p = loadPopup(url);
   +    await p.ready();
   +    p.els.format.value = 'webm'; // turns Visible into Record
   +    await p.click('visible');
   +    assert.deepStrictEqual(p.sent, [], `recording ${url} was sent to the worker`);
   +    assert.strictEqual(p.els.err.hidden, false);
   +  }
   +});
   +
    // --- pages that pass the scheme check but still can't be captured ---------
    // Chrome never lets an extension script the Web Store, and a file:// page can't
    // be scripted or captured until "Allow access to file URLs" is on. The popup
   ```

Choices:

- **Only Visible, not Record.** The ticket asks about Visible. Record also works on chrome:// pages (see the table), so whether to allow it too is open question 1.
- **Refuse by mode, as KAN-217 did for the Web Store.** The chrome:// check for Full page and Region sits next to the Web Store one and uses the same wording.
- **Match the scheme, not a list of pages.**
  - `/^chrome:/i` matches every chrome:// page, including the New Tab page (`chrome://newtab/`). Visible worked on all four pages tried.
  - The colon keeps `chrome-extension://`, `chrome-untrusted://` and `chrome-search://` pages refused. The extended extension-page test would catch a pattern without the colon.
- **The rule lives in `uncapturable()`, under its comment,** so the call site stays one line.
  - The call site passes the format using the same `isRecFmt($('format').value)` call that `toggleRec()` uses (`popup.js:77`).
  - It reads the field directly because `opts` isn't read until after the check.
- **Both refusal messages drop "(not chrome://, the Web Store, or a new tab)".**
  - After this change, the first message shows only on extension, devtools and about: pages, and for Record on chrome:// pages.
  - The second message shows only when Chrome refuses a stream id on a page the popup let through.
  - That list told the user to avoid pages where things work: Visible works on the Web Store and on chrome:// pages (including the New Tab page), and Record works on the Web Store.
- **The worker and the keyboard shortcuts stay as they are.**
  - The ticket is about the popup.
  - `runCapture` already gets Visible through on chrome:// pages, because `cancelRegion` and `setScrollbarHidden` swallow the refused injection.
- **No README change.** It doesn't describe which pages can be captured.
- **No version bump.** KAN-217 (9a0969b), KAN-243 (88f34a7) and KAN-214 (0758c47) all kept 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **Test changes only:** `tests/capture-errors.test.js` runs 22 tests, and exactly two fail:
    - "takes a Visible screenshot of chrome:// pages", with "Visible on chrome://extensions/ was wrongly blocked".
    - "refuses Full page and Region on chrome:// pages with a message rather than a silent no-op", because the old message doesn't match.
  - The other 20 tests pass, including the extended extension-page test and "still refuses Record on chrome:// pages".
  - **Both changes:** `npm test` passes 127 tests.
- **Chrome 152, changed copy.** The popup's buttons were clicked on `chrome://version/`, `chrome://settings/` and `chrome://newtab/`:
  - **Visible** saved a 1280×713 PNG of each page. No error showed, and the badge stayed clear.
  - **Full page and Region** showed "Chrome doesn’t let extensions run Full page or Region on chrome:// pages. Visible still works here." Nothing was saved, and the badge stayed clear.
  - **Record** showed "Can’t capture this page. Open a normal http(s) page and try again." Nothing was saved.

## Steps

1. Make the `tests/capture-errors.test.js` changes above.
   → verify: `node --test tests/capture-errors.test.js` runs 22 tests and fails only these two: "takes a Visible screenshot of chrome:// pages" and "refuses Full page and Region on chrome:// pages with a message rather than a silent no-op". The other 20 pass.
2. Make the `popup.js` change above.
   → verify: `npm test` passes 127 tests: the 125 existing ones, minus the removed chrome:// test, plus the three new ones.
3. Check the change in Chrome 152, loading the repo unpacked with the headless setup from step 3 of `docs/KAN-217-plan.md`:
   - **Launch:** use the same flags, and load the repo with `Extensions.loadUnpacked`.
   - **Popup:** open each page with `Target.createTarget({ url, forTab: true })`, then call `Target.activateTarget`. Open the popup with `Extensions.triggerAction`. Open and close one warm-up popup first.
   - **Downloads:** set `download.default_directory` in `Default/Preferences`, and don't call `Browser.setDownloadBehavior`. With it, Chrome ignores the file names the extension gives: every screenshot is saved as `download.png`, and each one overwrites the last.

   → verify:
   - **`chrome://version/`, `chrome://settings/` and `chrome://newtab/`:**
     - Visible saves an image of the page, with no error and no badge.
     - Full page and Region show "Chrome doesn’t let extensions run Full page or Region on chrome:// pages. Visible still works here." Nothing is saved, and the badge stays clear.
     - Record shows "Can’t capture this page. Open a normal http(s) page and try again." Nothing is saved.
   - **An http page:** Visible and Full page still save images, and Record still saves a `.webm`.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **Recordings of chrome:// pages come out 800×600.** `getViewport` can't run on these pages, which is KAN-242's bug. It only matters here if Record is allowed on chrome:// pages (open question 1).
- **The popup still refuses other extensions' pages and data: URLs.** The ticket cites Chromium's `CanCaptureVisiblePage`, which lets activeTab capture those as well. Neither was checked, and the ticket is about chrome:// pages.

## Open questions

1. **Should Record be allowed on chrome:// pages in this change too?**
   - The ticket lists this as not checked. It was checked while planning, and it works: all four pages in the table saved a WebM, at 800×600 (see KAN-242).
   - The ticket only asks about Visible, so this plan keeps Record refused.
   - If Record should be allowed:
     - In `popup.js`, add `chrome` to `CAPTURABLE` (`/^(https?|file|ftp|chrome):/i`) instead of adding the `rec` argument. `uncapturable()` and its call site stay as they are now. The Full page and Region refusal stays.
     - The comment above the check would then say a chrome:// page gets Visible and Record.
     - "still refuses Record on chrome:// pages" becomes a test that Record on those pages sends `rec-start`.
