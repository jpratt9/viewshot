# KAN-217: Popup lets captures start on the Web Store and on file:// pages that can't be captured

Ticket: https://prattsolutions.atlassian.net/browse/KAN-217 (To Do, no comments, labels `bug` and `viewshot`). No ticket blocks it.

## What the repo does now

- **The popup's check**
  - `CAPTURABLE` and `uncapturable()` (`popup.js:12-13`) look only at the URL scheme.
  - The click handler runs that check first (`popup.js:83-86`). It applies to every mode, including Record.
  - `load()` (`popup.js:38-50`) reads only the active tab and storage. Nothing in the repo calls `chrome.extension.isAllowedFileSchemeAccess()`.
  - The Web Store appears only in the two error messages (`popup.js:84`, `popup.js:97`). Neither can show on a Web Store page, because that page is https.
- **The worker** checks no URLs.
  - `runCapture` (`background.js:72-93`) runs the chosen mode. Any failure goes to `captureFailed` → `flashBadge('!')` (`background.js:67-70`, `background.js:350-354`).
  - For Region, the popup has already closed itself by then (`popup.js:120`).
- **What Chrome allows**, according to Chromium's source on the main branch:
  - `ChromeExtensionsClient::IsScriptableURL` refuses `executeScript` on `chrome.google.com`, `chromewebstore.google.com` and their subdomains (`IsWebstoreDomain`). The error is "The extensions gallery cannot be scripted."
  - `PermissionsData::CanCaptureVisiblePage` lets an extension that holds activeTab capture the Web Store. The Web Store is on the same list as chrome:// pages. The same function refuses file:// URLs when the extension has no file access.
  - `ActiveTabPermissionGranter::GrantIfRequested` always grants `kTabCaptureForTab`, and that is the only thing `tabCapture.getMediaStreamId` checks. For a file:// tab, it grants access to the page only when file access is on.
  - `Manifest::ShouldAlwaysAllowFileAccess`: an extension loaded unpacked starts with file access on. A Web Store install starts with it off.
- **Reproduced while planning** in headless Chrome 152.0.7977.83:
  - The extension was loaded unpacked, the popup was opened with `Extensions.triggerAction` (which grants activeTab the way a toolbar click does), and each button was clicked there.
  - The extension started with file access on. It was turned off for the file:// row.

  | Page | Visible | Full page | Region | Record (WebM) |
  |---|---|---|---|---|
  | `https://chromewebstore.google.com/` | saved a JPG of the store | nothing saved, `!` badge only | popup closed, nothing saved, `!` badge only | saved a WebM |
  | a file:// page, file access off | nothing saved, `!` badge only | nothing saved, `!` badge only | popup closed, nothing saved, `!` badge only | saved a WebM |

  - On the Web Store, the worker logged "The extensions gallery cannot be scripted." On the file:// page it logged "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
  - So on the Web Store, Full page and Region always fail. On a file:// page with file access off, all three screenshot modes fail. Visible on the Web Store works today, and so does Record on both pages.
- **Tests**
  - `loadPopup(url)` (`tests/capture-errors.test.js:149-190`) runs `popup.js` against a fake browser that has no `chrome.extension`.
  - "lets an ordinary page through untouched" (`tests/capture-errors.test.js:210-217`) clicks Visible on `file:///tmp/a.html` and expects the capture to go through.
  - No test uses a Web Store URL. The other popup test setups (`tests/defaults.test.js`, `tests/region-cancel.test.js`, `tests/region-dispatch.test.js`) only use `https://a.com`.
  - `npm test` passes 118 tests.

## Change

Two files change.

1. **`popup.js`:**
   - After `uncapturable` (`popup.js:13`), add `WEB_STORE`. It matches http(s) URLs on `chrome.google.com`, `chromewebstore.google.com` and their subdomains, which are the hosts Chrome refuses to script.
   - In the screenshot branch of the click handler, just before `await save()` (`popup.js:103-104`), add two checks. Each shows an inline error and returns, as the `uncapturable` check does:
     - **On a file:// page,** ask `chrome.extension.isAllowedFileSchemeAccess()`. If file access is off, refuse every screenshot mode, with a message that says where to turn it on.
     - **On the Web Store,** refuse Full page and Region.
   - The recording branch and `load()` stay as they are.

   ```diff
   @@ -11,6 +11,10 @@
    // activeTab is null until load() resolves; the worker's badge covers that gap.
    const CAPTURABLE = /^(https?|file|ftp):/i;
    const uncapturable = (tab) => !!(tab && tab.url && !CAPTURABLE.test(tab.url));
   +// Chrome never lets an extension script the Web Store (all of chrome.google.com
   +// and chromewebstore.google.com), so Full page and Region can't run there.
   +// Visible still can: Chrome lets activeTab capture the store.
   +const WEB_STORE = /^https?:\/\/([\w-]+\.)*(chromewebstore|chrome)\.google\.com([:/?#]|$)/i;

    function apply(o) {
      $('format').value = o.format;
   @@ -101,6 +105,17 @@
          chrome.runtime.sendMessage({ type: 'rec-start', streamId, opts });
          $('stopBtn').disabled = false; // popup stays open, so reflect the live recording
        } else {
   +      // Until "Allow access to file URLs" is on, Chrome refuses both
   +      // executeScript and captureVisibleTab on file:// pages. Recording needs
   +      // neither, so only the screenshot modes stop here.
   +      if (/^file:/i.test(activeTab?.url || '') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
   +        showError('Can’t capture this file. In chrome://extensions, open ViewShot’s Details, turn on “Allow access to file URLs”, and try again.');
   +        return; // keep the popup open so the error is visible
   +      }
   +      if (btn.dataset.mode !== 'visible' && WEB_STORE.test(activeTab?.url || '')) {
   +        showError('Chrome doesn’t let extensions run Full page or Region on the Web Store. Visible still works here.');
   +        return; // keep the popup open so the error is visible
   +      }
          await save();
          // Wait for the worker to acknowledge before closing anything. window.close()
          // in the same turn as the send tears this frame down while a cold-starting
   ```

2. **`tests/capture-errors.test.js`:**
   - **Test setup:** `loadPopup` takes `{ fileAccess = true }` and uses it to fake `chrome.extension.isAllowedFileSchemeAccess`. With the default, the existing file:// test still passes unchanged.
   - **Four new tests** go after "lets an ordinary page through untouched":
     1. Full page and Region on both Web Store hosts are refused with a message that names the Web Store, and nothing is sent to the worker.
     2. Visible on the Web Store still starts a capture. So does Full page on hosts that only look like the Web Store: `www.google.com/chrome/`, `notchrome.google.com` and `chromewebstore.google.com.example`.
     3. Visible, Full page and Region on a file:// page with file access off are refused with a message that names the setting, and nothing is sent.
     4. Record still starts on the Web Store, and on a file:// page with file access off.

   ```diff
   @@ -146,7 +146,7 @@

    // --- the popup says which page it was --------------------------------------

   -function loadPopup(url) {
   +function loadPopup(url, { fileAccess = true } = {}) {
      const els = {};
      const sent = [];
      const makeEl = () => {
   @@ -177,6 +177,7 @@
          storage: { local: { get: async () => ({}), set: async () => {} } },
          runtime: { sendMessage: async (m) => { sent.push(m); return true; } },
          tabCapture: { getMediaStreamId: async () => 'sid' },
   +      extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
        },
        localStorage: { getItem: () => null, setItem: () => {} },
      };
   @@ -213,9 +214,66 @@
        await p.ready();
        await p.click('visible');
        assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `${url} was wrongly blocked`);
   +  }
   +});
   +
   +// --- pages that pass the scheme check but still can't be captured ---------
   +// Chrome never lets an extension script the Web Store, and a file:// page can't
   +// be scripted or captured until "Allow access to file URLs" is on. The popup
   +// let both through, so the only sign of the failure was a 3-second badge, and
   +// for Region the popup had already closed by then.
   +
   +const WEB_STORE_URLS = ['https://chromewebstore.google.com/detail/x/abc', 'https://chrome.google.com/webstore/category/extensions'];
   +
   +test('refuses Full page and Region on the Web Store', async () => {
   +  for (const url of WEB_STORE_URLS) {
   +    for (const mode of ['fullpage', 'region']) {
   +      const p = loadPopup(url);
   +      await p.ready();
   +      await p.click(mode);
   +      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was sent to the worker`);
   +      assert.strictEqual(p.els.err.hidden, false);
   +      assert.match(p.els.err.textContent, /Web Store/);
   +    }
   +  }
   +});
   +
   +test('still takes Visible on the Web Store, and Full page on look-alike hosts', async () => {
   +  const cases = [
   +    ...WEB_STORE_URLS.map((url) => [url, 'visible']), // Chrome lets activeTab capture the store
   +    ['https://www.google.com/chrome/', 'fullpage'],
   +    ['https://notchrome.google.com/', 'fullpage'],
   +    ['https://chromewebstore.google.com.example/', 'fullpage'],
   +  ];
   +  for (const [url, mode] of cases) {
   +    const p = loadPopup(url);
   +    await p.ready();
   +    await p.click(mode);
   +    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `${mode} on ${url} was wrongly blocked`);
      }
    });

   +test('refuses every screenshot mode on a file:// page while file access is off', async () => {
   +  for (const mode of ['visible', 'fullpage', 'region']) {
   +    const p = loadPopup('file:///tmp/a.html', { fileAccess: false });
   +    await p.ready();
   +    await p.click(mode);
   +    assert.deepStrictEqual(p.sent, [], `${mode} was sent to the worker`);
   +    assert.strictEqual(p.els.err.hidden, false);
   +    assert.match(p.els.err.textContent, /Allow access to file URLs/);
   +  }
   +});
   +
   +test('still records on the Web Store, and on a file:// page without file access', async () => {
   +  for (const [url, fileAccess] of [[WEB_STORE_URLS[0], true], ['file:///tmp/a.html', false]]) {
   +    const p = loadPopup(url, { fileAccess });
   +    await p.ready();
   +    p.els.format.value = 'webm'; // turns Visible into Record
   +    await p.click('visible');
   +    assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], `recording ${url} was blocked`);
   +  }
   +});
   +
    // --- "Cannot read properties of null (reading 'chunks')" --------------------
    // MediaRecorder.stop() flushes one last dataavailable on a later task, by which
    // time stopRecording has already nulled `rec`. The handler read rec.chunks, so
   ```

Choices:

- **Refuse by mode, not by page.** Adding both pages to `uncapturable()` would be a smaller change. But it would also block Visible on the Web Store and Record on both pages, which work today (see the table).
- **Ask about file access when a button is clicked, and only on file:// pages.**
  - `load()` stays as it is, so opening the popup costs no extra call. Its comment (`popup.js:39-41`) is about removing exactly those calls.
  - The other popup test setups need no fake for the new call.
  - Record never reaches this check, so no extra wait is added between the click and `getMediaStreamId`.
- **The host match follows Chrome's own rule** (`IsWebstoreDomain`: either host or any subdomain), not just `/webstore` paths. That's where `executeScript` is refused.
- **The worker and the keyboard shortcuts stay as they are.** The ticket is about the popup. A shortcut pressed on these pages still fails with only the `!` badge.
- **The existing message at `popup.js:84` keeps naming the Web Store.** It only appears on pages that aren't http(s), file or ftp, and after this change the Web Store gets its own message.
- **No version bump.** KAN-207 (103aaee), KAN-212 (02df5f2) and KAN-208 (8f60bae) also changed code that ships, and all three kept 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - With only the test changes, tests 1 and 3 fail. The failures read "fullpage on https://chromewebstore.google.com/detail/x/abc was sent to the worker" and "visible was sent to the worker". Tests 2 and 4 pass, and so do the 15 tests already in the file.
  - With both changes, `npm test` passes 122 tests.
- **Chrome 152, changed copy** (same setup as the table above):
  - **Web Store:** Full page and Region showed the new message, sent nothing, and no badge appeared. Visible saved a JPG of the store, and Record saved a WebM.
  - **file:// page, file access off:** all three screenshot modes showed the new message, and no badge appeared. Record saved a WebM, which `ffprobe` reads as VP9.
  - **file:// page, file access back on:** Visible saved a 1280×713 PNG, and Full page saved a 1280×3000 PNG of the whole test page.

## Steps

1. Make the `tests/capture-errors.test.js` changes above.
   → verify: `node --test tests/capture-errors.test.js` fails only "refuses Full page and Region on the Web Store" and "refuses every screenshot mode on a file:// page while file access is off". The other 17 tests pass.
2. Make the `popup.js` change above.
   → verify: `npm test` passes 122 tests (the 118 existing ones plus the 4 new ones).
3. Check the change in Chrome 152. Use the same headless setup as the earlier plans, with the repo loaded unpacked:
   - **Launch:**
     - Start Chrome with `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging`, a temporary `--user-data-dir`, and `download.default_directory` set in its `Default/Preferences`.
     - Load the repo with `Extensions.loadUnpacked`.
   - **Opening the popup:**
     - Open each page with `Target.createTarget({ url, forTab: true })`, because `Extensions.triggerAction` only accepts a tab target. Then call `Target.activateTarget` on the page.
     - `Extensions.triggerAction({ id, targetId })` opens the popup and grants activeTab. Attach to the popup, set the Name field to `{title}-{domain}-{time}` so each saved file shows which page it came from, and click the buttons with `Runtime.evaluate`.
   - **Headless quirk:** while the first popup after the extension loads (or reloads) is open, the worker's `tabs.query({ active: true, currentWindow: true })` finds no tab, so that capture silently does nothing. Open and close one popup on any page first.
   - **Turning file access off:**
     - On `chrome://extensions`, first run `chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`. Without it, changing file access reloads the extension and Chrome then disables it (`unsupportedDeveloperExtension`).
     - Then run `chrome.developerPrivate.updateExtensionConfiguration({ extensionId, fileAccess: false })`.

   → verify:
   - **Web Store** (`https://chromewebstore.google.com/`):
     - Full page and Region show "Chrome doesn’t let extensions run Full page or Region on the Web Store. Visible still works here." Nothing is saved, and the badge stays clear.
     - Visible saves an image of the store, and Record saves a `.webm`.
   - **file:// page, file access off:**
     - Visible, Full page and Region show the "Allow access to file URLs" message. Nothing is saved, and the badge stays clear.
     - Record saves a `.webm`.
   - **file:// page, file access back on:** Visible and Full page save PNGs.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **The comment at `popup.js:8-10` is wrong about chrome:// pages.**
  - It says chrome:// pages refuse `captureVisibleTab`. But in Chrome 152, once the popup had granted activeTab, the worker's Visible capture saved real screenshots of `chrome://version` and `chrome://settings`. Chromium lists chrome:// pages next to the Web Store in `CanCaptureVisiblePage`.
  - So the popup also refuses Visible on pages that Chrome would let it capture. That would be a separate ticket.
- **Recording on pages the extension can't script has a smaller video and a logged error.**
  - Recording works there, but `getViewport` fails, so the video size isn't matched to the tab. The file:// recording came out 800×600 for a 1280×713 viewport.
  - `blipRecordingIndicator` also logs "blip failed" as an error.
  - The code already behaves this way, and this ticket doesn't change it.

## Open questions

None. The ticket names both pages and why they fail, and the Chrome runs above settle which modes each page should refuse.
