# KAN-294: Quitting Chrome or reloading the extension mid-recording leaves the recording marked as running

Ticket: https://prattsolutions.atlassian.net/browse/KAN-294 (To Do, no comments, labels `bug` and `viewshot`). Nothing blocks it.

## What the repo does now

Line numbers are from `3adbcdd`, with a clean working tree. They match the ticket's.

- **The `rec` key**
  - `startRecording` saves it in `chrome.storage.local` (`background.js:390`) and then sets the `REC` badge (`:392`). The comment above it says the key is kept so the file can still be named after a worker restart (`:389`).
  - Only two paths remove it: `stopRecording` (`background.js:467-476`, removed at `:473`) and the `rec-failed` handler (`background.js:15`).
  - `background.js` has no `chrome.runtime.onStartup` or `onInstalled` listener. Its only top-level listeners are `runtime.onMessage` (`:10-16`) and `commands.onCommand` (`:18-21`).
- **What reads the key**
  - **The popup:** it reads `opts` and `rec` with one `chrome.storage.local.get(['opts', 'rec'])` call (`popup.js:53`), and enables Stop whenever `rec` is set (`popup.js:58`). `tests/defaults.test.js:192-194` requires that single call.
  - **`closeOffscreen()`:** it returns early whenever `rec` is set (`background.js:351-353`).
  - **`stopRecording`:** it removes the key, clears the badge, and sends `rec-stop-offscreen` (`background.js:475`). If nothing receives that message, the `rec-stop` handler logs the failure with `console.error` (`background.js:13`).
- **Chrome's docs** (the `runtime` and `storage` reference pages):
  - `runtime.onStartup`: "Fired when a profile that has this extension installed first starts up."
  - `runtime.onInstalled`: "Fired when the extension is first installed, when the extension is updated to a new version, and when Chrome is updated to a new version."
  - Session storage "is cleared if the extension is disabled, reloaded, updated, and when the browser restarts." Local storage isn't.
- **Reproduced in headless Chrome 152.0.7977.83** while planning.
  - **Setup:**
    - The driver from the KAN-249 check, with a fresh profile and a copy of the repo loaded with `Extensions.loadUnpacked`.
    - After a warm-up popup, Record (WebM) was started from a popup on an http page, and that popup was then closed.
    - While recording: Stop was enabled, `rec` was set, the badge showed `REC`, and the offscreen document was open.
  - **How the recording was cut off:**
    - **Reload:** `Extensions.loadUnpacked` on the same folder again, which kept the same id. `chrome.runtime.reload()` from the worker wasn't usable: afterwards the extension had no targets, and `Extensions.triggerAction` never answered.
    - **Quit:** `Browser.close`, then Chrome started again on the same profile, and the folder was loaded again (same id).
  - **After either one:**
    - No recording was saved, and the offscreen document was gone.
    - The badge was empty.
    - `rec` was still set, and a new popup showed Stop enabled.
    - Pressing Stop logged `rec-stop received` and `stopping, will save as kan294-127.0.0.1-….webm`, then the error `[ViewShot] Error: Could not establish connection. Receiving end does not exist.`
    - The key was then put back by hand, since Stop had removed it. With it set, a clipboard copy (PNG, "Copy to clipboard" on) left the offscreen document open.
  - **Disabling and then enabling the extension** from chrome://extensions (`chrome.management.setEnabled`) gave the same result, even with this plan's listeners in place. See the open question.
- **Tests**
  - **`tests/offscreen-lifecycle.test.js`:**
    - Its `load()` (`:12-43`) fakes `chrome.storage.local.get` for `rec`, with no `remove`. Its runtime fake has only `onMessage` and `sendMessage`.
    - "leaves the document alone while a recording is running" (`:76-81`) loads the worker with `rec` set, which is also what a worker restart during a recording looks like.
  - **Other harnesses:** five more files load `background.js` against a runtime fake with no `onStartup` or `onInstalled`:
    - `tests/capture-errors.test.js:38`
    - `tests/fullpage.test.js:94`
    - `tests/region-cancel.test.js:27-33`
    - `tests/region-dispatch.test.js:130`
    - `tests/shortcut-format.test.js:31`

    `tests/defaults.test.js` and `tests/buildName.test.js` use a catch-all proxy instead.
  - **Counts:** `npm test` passes 146 tests, 7 of them in `tests/offscreen-lifecycle.test.js`.

## Change

Seven files change: two new listeners in `background.js`, and six test files. The diffs below were applied and tested on a copy (see "Checked while planning").

1. **`background.js`:** after the shortcut listener (`:21`), remove `rec` on `runtime.onStartup` and on `runtime.onInstalled`, with a comment saying why.

   ```diff
   @@ -20,6 +20,13 @@
      if (map[cmd]) runCapture(map[cmd], await getOpts(), tab?.id).catch(captureFailed);
    });
    
   +// `rec` is kept in chrome.storage.local so a recording outlives a worker
   +// restart. The recording itself lives in the offscreen document, which is gone
   +// once Chrome restarts or the extension is installed, updated or reloaded, so
   +// after either of those nothing is recording, whatever the key says.
   +chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('rec'));
   +chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('rec'));
   +
    async function getOpts() {
      const { opts } = await chrome.storage.local.get('opts');
      const o = { ...DEFAULTS, ...(opts || {}) };
   ```

2. **`tests/offscreen-lifecycle.test.js`:**
   - **`load()`** (`:12-43`):
     - The runtime fake keeps the `onStartup` and `onInstalled` listeners.
     - `chrome.storage.local` gets a `remove` that clears `rec`.
     - `fire(event, ...args)` calls one of those listeners and waits for it. If nothing listens for the event, it fails with "nothing listens for runtime.<event>".
   - **A new section** after "leaves the document alone while a recording is running" (`:81`), with one test per event:
     - "Chrome starting again forgets a recording that couldn't survive it"
     - "the extension being installed, updated or reloaded forgets a recording that couldn't survive it"

     Each test loads the worker with `rec` set, fires the event, and takes a clipboard copy. It then expects the offscreen document to have been closed.

   ```diff
   @@ -11,10 +11,13 @@
    // the action popup, so it must not outlive the work it was created for.
    function load({ hasDoc = false, rec = null, createRejects = false } = {}) {
      const calls = { create: 0, close: 0, sent: [] };
   +  const on = {}; // background.js's runtime.onStartup / onInstalled listeners
      let docExists = hasDoc;
      const chrome = {
        runtime: {
          onMessage: { addListener() {}, removeListener() {} },
   +      onStartup: { addListener: (fn) => { on.onStartup = fn; } },
   +      onInstalled: { addListener: (fn) => { on.onInstalled = fn; } },
          sendMessage: async (m) => {
            calls.sent.push(m);
            return m.type === 'offscreen-ping' ? 'pong' : 'done';
   @@ -30,7 +33,12 @@
          },
          closeDocument: async () => { calls.close++; docExists = false; },
        },
   -    storage: { local: { get: async (k) => (k === 'rec' && rec ? { rec } : {}) } },
   +    storage: {
   +      local: {
   +        get: async (k) => (k === 'rec' && rec ? { rec } : {}),
   +        remove: async (k) => { if (k === 'rec') rec = null; },
   +      },
   +    },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      };
      const context = {
   @@ -39,7 +47,13 @@
      };
      vm.createContext(context);
      vm.runInContext(CODE, context);
   -  return { ctx: context, calls, docLives: () => docExists };
   +  return {
   +    ctx: context, calls, docLives: () => docExists,
   +    fire: async (event, ...args) => {
   +      assert.ok(on[event], `nothing listens for runtime.${event}`);
   +      await on[event](...args);
   +    },
   +  };
    }
    
    const PNG = 'data:image/png;base64,AAAA';
   @@ -80,6 +94,26 @@
      assert.strictEqual(docLives(), true);
    });
    
   +// --- unless the browser or the extension ended it -----------------------------
   +// `rec` is kept in chrome.storage.local so a recording outlives a worker
   +// restart. It also outlived Chrome quitting and the extension reloading, which
   +// the recording itself doesn't, and nothing cleared it: the popup kept Stop
   +// enabled, and this document was never closed after a clipboard copy again.
   +
   +const ENDINGS = [
   +  ['onStartup', 'Chrome starting again', []],
   +  ['onInstalled', 'the extension being installed, updated or reloaded', [{ reason: 'update' }]],
   +];
   +
   +for (const [event, what, args] of ENDINGS) {
   +  test(`${what} forgets a recording that couldn't survive it`, async () => {
   +    const { ctx, calls, fire } = load({ rec: { format: 'webm', filename: 'x' } });
   +    await fire(event, ...args);
   +    await ctx.copyImage(PNG);
   +    assert.strictEqual(calls.close, 1, 'the leftover recording still kept the document open');
   +  });
   +}
   +
    test('closeOffscreen is a no-op when no document exists', async () => {
      const { calls, ctx } = load({ hasDoc: false });
      await ctx.closeOffscreen();
   ```

3. **The other five harnesses** that load `background.js` get `onStartup: { addListener() {} }, onInstalled: { addListener() {} }` in their runtime fake. Without them, `background.js` throws "Cannot read properties of undefined (reading 'addListener')" as soon as it loads.
   - `tests/capture-errors.test.js`:

     ```diff
     @@ -35,7 +35,11 @@
      
        const chrome = {
          // The first message listener is background.js's own; Region adds more later.
     -    runtime: { onMessage: { addListener: (fn) => { onMessage = onMessage || fn; }, removeListener() {} }, sendMessage: async () => {} },
     +    runtime: {
     +      onMessage: { addListener: (fn) => { onMessage = onMessage || fn; }, removeListener() {} },
     +      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
     +      sendMessage: async () => {},
     +    },
          commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
          tabs: {
            query: async () => (noActiveTab ? [] : [TAB]),
     ```

   - `tests/fullpage.test.js`:

     ```diff
     @@ -91,7 +91,7 @@
              // window 9: `leave` says whether it was switched away from or moved.
              get: async (id) => ({ id, windowId: 9, active: true, ...(leaveAt && captureAt.length >= leaveAt ? leave : {}) }),
            },
     -      runtime: { onMessage: { addListener() {} } },
     +      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
            commands: { onCommand: { addListener() {} } },
            action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
            storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
     ```

   - `tests/region-cancel.test.js`:

     ```diff
     @@ -29,6 +29,7 @@
              addListener: (fn) => listeners.push(fn),
              removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
            },
     +      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
            sendMessage: async () => {},
          },
          commands: { onCommand: { addListener() {} } },
     ```

   - `tests/region-dispatch.test.js`:

     ```diff
     @@ -127,7 +127,7 @@
        const queries = [];
        const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => undefined });
        const chrome = {
     -    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
     +    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
          commands: { onCommand: { addListener() {} } },
          // No active tab, so runCapture gives up straight after this call - enough to
          // show it ran without dragging the whole capture pipeline in.
     ```

   - `tests/shortcut-format.test.js`:

     ```diff
     @@ -28,7 +28,7 @@
          async convertToBlob({ type }) { return { type, arrayBuffer: async () => new Uint8Array([1]).buffer }; }
        }
        const chrome = {
     -    runtime: { onMessage: { addListener() {} } },
     +    runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
          commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
          tabs: {
            query: async () => [{ id: 7, windowId: 1, url: 'https://a.com', title: 'T' }],
     ```

Choices:

- **Clear the key where the ticket says nothing does.** Both events mean the offscreen document, and the recording in it, is gone:
  - `onStartup` only fires as a profile starts.
  - `onInstalled` fires on install, on update, and on a Chrome update, which restarts Chrome. Reloading an unpacked extension counts as an update: in the check below, it fired with reason `update`.
- **Keep `rec` in `chrome.storage.local`.**
  - Session storage would have the right lifetime, and would also cover disabling the extension.
  - But the popup reads `opts` and `rec` with one call to local storage, and `tests/defaults.test.js:192-194` requires that.
  - Moving `rec` would add a second call there, and would change every place that reads or writes it (`background.js:15`, `:352`, `:390`, `:469`, `:473`, `popup.js:53`).
- **A worker restart still keeps the recording.** Neither event fires when only the worker restarts, and "leaves the document alone while a recording is running" still passes.
- **Only the key changes.**
  - The badge was already empty after the reload and after the restart, so this change doesn't touch it.
  - A recording whose document is gone can't be saved anyway (see "Noticed while planning").
- **No changes to the popup or `stopRecording`.** Once the key is cleared, the popup disables Stop and `closeOffscreen()` closes the document again, as the check below shows. `stopRecording` is then no longer reachable for a recording that isn't there.
- **The tests go in `tests/offscreen-lifecycle.test.js`.** That file is about when the offscreen document closes, and the tests check the ticket's own symptom: the document closing after a clipboard copy.
- **Cost:** Chrome now starts the worker when the browser starts, to deliver `onStartup`. The listener only removes one key.
- **No README, manifest or version change.**
  - Neither event needs a permission.
  - Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **As it is now:** `npm test` passes 146 tests.
  - **Test changes only:** `npm test` runs 148 tests. 146 pass, and exactly the two new ones fail, with "nothing listens for runtime.onStartup" and "nothing listens for runtime.onInstalled".
  - **Code change without the harness changes:** 61 of the 146 tests fail with "Cannot read properties of undefined (reading 'addListener')".
  - **Both changes:** `npm test` passes 148 tests.
- **Chrome 152, changed copy,** with the same setup as above:
  - **Reload:** afterwards, `rec` was gone, a new popup showed Stop disabled, and the clipboard copy's offscreen document was closed. A copy that also recorded which event fired showed `onInstalled` with reason `update`.
  - **Quit, then load the folder again:** the same result.
- **Chrome for Testing 151.0.7922.71,** loading the extension with `--load-extension`. Chrome 152 didn't load the extension from that flag.
  - **Setup:** `rec` was written by hand, then `Browser.close`, then Chrome was started again on the same profile.
  - **Result:** the unchanged copy still had `rec`, and the changed copy didn't.
  - **Which event fired:** the event-recording copy got `onInstalled` with reason `install` at the second launch, and no `onStartup`. An extension loaded from the command line is installed again at every launch.
- **Not checked in Chrome: `onStartup`.**
  - Every headless setup above installs the extension again at launch, so Chrome sends `onInstalled` instead.
  - `onStartup` is what a normally installed copy gets when Chrome starts. The unit test covers that listener.

## Steps

1. Make the six test-file changes above.
   → verify: `npm test` runs 148 tests. 146 pass, and only these two new tests in `tests/offscreen-lifecycle.test.js` fail:
   - "Chrome starting again forgets a recording that couldn't survive it", with "nothing listens for runtime.onStartup"
   - "the extension being installed, updated or reloaded forgets a recording that couldn't survive it", with "nothing listens for runtime.onInstalled"
2. Make the `background.js` change above.
   → verify: `npm test` passes 148 tests, which is the 146 existing ones plus the two new ones.
3. Check the change in Chrome 152, with the repo loaded unpacked.
   - **Setup:** use the headless setup from step 3 of `docs/KAN-241-plan.md`:
     - set `download.default_directory` in `Default/Preferences`;
     - don't call `Browser.setDownloadBehavior`;
     - open and close one warm-up popup first.
   - **Before each case:** start a WebM recording from a popup on an http page, then close that popup.

   → verify:
   - **Reload** (`Extensions.loadUnpacked` on the repo folder again):
     - `rec` is gone;
     - a new popup shows Stop disabled;
     - with "Copy to clipboard" on, Visible leaves no offscreen document open.
   - **Quit** (`Browser.close`), start Chrome again on the same profile, and load the folder again: the same results.
   - **Recording still works after the reload:** Record, then Stop, saves a `.webm`, and the badge shows `REC` while it records.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, the six test files and this plan.

## Noticed while planning, not changed

- **A recording cut off this way is lost.**
  - No file was saved after the reload or the quit.
  - The comment at `offscreen.js:110-112` says the 1 s timeslice lets a recording survive the offscreen document being torn down. But the chunks are kept in that document (`offscreen.js:100-101`), so they go with it.
- **`chrome.runtime.reload()` doesn't bring back an extension loaded over CDP** in headless Chrome 152. Checks should reload with `Extensions.loadUnpacked` instead.

## Open questions

1. **Should disabling and re-enabling the extension be covered too?**
   - **The ticket's scope:** it names Chrome quitting or crashing, and the extension being reloaded or updated. Disabling the extension during a recording also ends the recording, but Chrome sends neither event when the extension is enabled again.
   - **Checked in Chrome 152, with this plan's listeners:** after `chrome.management.setEnabled(id, false)` and then `true`:
     - `rec` was still set, and Stop was enabled;
     - pressing Stop logged the same error;
     - a clipboard copy's offscreen document stayed open.
   - **What covering it would take:** a different change. For example, the worker could check that an offscreen document exists before trusting `rec`. Or `rec` could move to session storage, which the popup's single storage call rules out as things stand.
   - **The steps above don't cover it.**
