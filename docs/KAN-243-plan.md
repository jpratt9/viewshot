# KAN-243: Recording a page that refuses scripts puts a "blip failed" error in chrome://extensions

Ticket: https://prattsolutions.atlassian.net/browse/KAN-243 (To Do, no comments, labels `bug` and `viewshot`). No ticket blocks it.

## What the repo does now

- **The blip**
  - `startRecording` (`background.js:356-386`) first plays the blip (`background.js:372`). Then it sizes the recording with `getViewport` (`background.js:380`) and tells the offscreen document to start.
  - `blipRecordingIndicator` (`background.js:417-437`) runs a script in the tab.
  - When the page refuses that script, the catch (`background.js:430-435`) logs `console.error('[ViewShot] blip failed:', e)` (`background.js:433`) and returns without the 700 ms wait. The comment above it (`background.js:431-432`) says these pages are expected.
- **Other scripts that run only for looks fail more quietly**
  - `getViewport` (`background.js:393-408`) runs right after the blip, on the same page. When it fails, it logs `console.warn('[ViewShot] getViewport failed:', e)` (`background.js:405`) and returns `null`. The ticket found that chrome://extensions didn't list this warning.
  - `setScrollbarHidden` (`background.js:247`) and `cancelRegion` (`background.js:267`) catch the error and log nothing. They run only for screenshots.
- **Why chrome://extensions lists the error but not the warning.** Chromium's `ServiceWorkerTaskQueue::OnReportConsoleMessageSync` (`extensions/browser/service_worker/service_worker_task_queue.cc:1233-1236` on main, as of 2026-09-16) skips every console message from an extension's service worker below error level. Only `kError` messages become the `RuntimeError`s that chrome://extensions lists.
- **Tests**
  - Nothing under `tests/` mentions the blip, and no test calls the worker's `startRecording`.
  - `loadBg` (`tests/capture-errors.test.js:21-76`) runs `background.js` against a fake browser:
    - `scriptFails: true` makes every `executeScript` call throw (`tests/capture-errors.test.js:47`);
    - its `console.error` and `console.warn` do nothing (`tests/capture-errors.test.js:60`);
    - its fake `chrome` has no `offscreen`.
  - `npm test` passes 122 tests.

## Change

Two files change.

1. **`background.js`:** in `blipRecordingIndicator`'s catch, log the failure with `console.warn` instead of `console.error`. Add two comment lines that say why.

   ```diff
   @@ -430,7 +430,9 @@
      } catch (e) {
        // chrome:// URLs and similar refuse executeScript — skip the wait so we
        // don't delay the recording start for nothing.
   -    console.error('[ViewShot] blip failed:', e);
   +    // Expected on those pages, so only a warning: chrome://extensions lists
   +    // every console.error from the worker as an extension error.
   +    console.warn('[ViewShot] blip failed:', e);
        return;
      }
      await new Promise((r) => setTimeout(r, BLIP_ANIM_MS + 50));
   ```

2. **`tests/capture-errors.test.js`:** add a section with one test after the "Cannot access a chrome:// URL" tests (`tests/capture-errors.test.js:145`). The test:
   - loads the worker with `scriptFails: true`, like the existing tests for pages that refuse scripts;
   - replaces `console.error` and `console.warn` on the loaded context with functions that record what they're given;
   - adds a `chrome.offscreen.hasDocument` that returns `true`, so `ensureOffscreen` returns at once (`background.js:297-299`);
   - calls `startRecording` with the WebM format;
   - expects no error to be logged, and expects a "blip failed" warning. The warning shows that the blip code really ran.

   ```diff
   @@ -144,6 +144,23 @@
      assert.deepStrictEqual(bg.badges, ['!']);
    });

   +// --- "blip failed" ---------------------------------------------------------
   +// Starting a recording on a page that refuses scripts (the Web Store, or a
   +// file:// page without file access) skips the edge-glow blip on purpose. The
   +// skip was logged with console.error, and chrome://extensions lists every
   +// console.error from the worker as an extension error.
   +
   +test('recording a page that refuses scripts logs a warning, not an error', async () => {
   +  const bg = loadBg({ scriptFails: true });
   +  const logged = { error: [], warn: [] };
   +  bg.ctx.console.error = (...a) => logged.error.push(a.join(' '));
   +  bg.ctx.console.warn = (...a) => logged.warn.push(a.join(' '));
   +  bg.ctx.chrome.offscreen = { hasDocument: async () => true }; // already open
   +  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' });
   +  assert.deepStrictEqual(logged.error, [], 'chrome://extensions lists these as extension errors');
   +  assert.ok(logged.warn.some((m) => m.includes('blip failed')), 'the skipped blip left no trace in the console');
   +});
   +
    // --- the popup says which page it was --------------------------------------

    function loadPopup(url, { fileAccess = true } = {}) {
   ```

Choices:

- **A warning, not silence.**
  - This matches `getViewport`, which fails on the same pages in the same step and logs a warning.
  - The worker console still shows why the blip was skipped, and chrome://extensions doesn't collect warnings (see above).
  - A silent catch like `setScrollbarHidden`'s would also fix the ticket. In that case, the test's second assertion goes.
- **The test covers `startRecording`, not just `blipRecordingIndicator`.** The ticket reports an error logged while a recording starts. So the test checks everything the start logs on such a page, including `getViewport`'s warning.
- **`loadBg` stays as it is.** The test replaces the two console functions and adds `chrome.offscreen` after loading. That works because the worker looks both up only when it calls them. No other test changes.
- **Nothing else changes.**
  - `getViewport` and the rest of `startRecording` stay as they are.
  - KAN-242 covers the recording size on these pages.
  - The comment at `background.js:431-432` stays.
- **No version bump.** KAN-207 (103aaee), KAN-212 (02df5f2), KAN-208 (8f60bae) and KAN-217 (9a0969b) all changed code that ships, and none of them changed the version from 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **Only the test change:** `node --test tests/capture-errors.test.js` ran 20 tests. 19 passed, and the new one failed with `actual: [ '[ViewShot] blip failed: Error: Cannot access a chrome:// URL' ]`.
- **Both changes:** `npm test` passed 123 tests.
- **Chrome:** not tried while planning. Step 3 does that.

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `node --test tests/capture-errors.test.js` runs 20 tests. Only "recording a page that refuses scripts logs a warning, not an error" fails, and its output shows `actual: [ '[ViewShot] blip failed: Error: Cannot access a chrome:// URL' ]`.
2. Make the `background.js` change above.
   → verify: `npm test` passes 123 tests (the 122 existing ones plus the new one).
3. Check the change in Chrome 152. Use the headless setup from step 3 of `docs/KAN-217-plan.md`:
   - load the repo unpacked;
   - open the popup with `Extensions.triggerAction`;
   - turn developer mode on with `developerPrivate.updateProfileConfiguration`. chrome://extensions only collects errors in developer mode;
   - turn file access off with `developerPrivate.updateExtensionConfiguration`.

   Attach to the worker (the `service_worker` target whose URL ends in `/background.js`) and enable `Runtime` there.

   → verify:
   - **Both recordings save:** start and stop a WebM recording on `https://chromewebstore.google.com/`, then one on a file:// page with file access off. Each saves a `.webm`.
   - **No errors listed:** on `chrome://extensions`, `chrome.developerPrivate.getExtensionInfo(extensionId)` returns an empty `runtimeErrors` for ViewShot. Before this change, the Web Store recording alone left `[ViewShot] blip failed: Error: The extensions gallery cannot be scripted.` there.
   - **The warning is still logged:** for each recording, the worker's `Runtime.consoleAPICalled` reports `[ViewShot] blip failed:` with `type: 'warning'`.
   - **Normal pages are unchanged:** a WebM recording on an ordinary https page saves a `.webm` and logs no "blip failed" message at all.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None. The ticket names the line. The comment above that line says the failure is expected, and Chromium's source shows that logging it as a warning keeps it out of chrome://extensions.
