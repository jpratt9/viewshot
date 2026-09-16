# KAN-251: One screenshot call that never returns blocks every capture after it

Ticket: https://prattsolutions.atlassian.net/browse/KAN-251 (To Do, no comments, labels `bug` and `viewshot`). It is blocked by KAN-214, which is Done.

## What the repo does now

Line numbers are from the working tree on top of `14b118f`. That tree also holds KAN-222's uncommitted MP4 change, which doesn't move any line cited here.

- **Every shot goes through one gate.**
  - `captureVisible` (`background.js:45-61`) is the only code that calls `chrome.tabs.captureVisibleTab`. It calls it once (`background.js:50`), and a second time after a quota error (`background.js:54`).
  - Each call waits for the one before it: `captureGate` becomes `shot.catch(() => {})` (`background.js:59`).
  - Nothing limits how long a call can take.
  - The callers are Visible (`background.js:79`), each Full page slice (`background.js:183`) and Region (`background.js:295`).
- **The failure path already does what the ticket wants, once a call throws.**
  - `runCapture` removes the scrollbar-hiding style in its `finally` (`background.js:82-84`).
  - `captureFullPage` puts back the fixed and sticky elements and the scroll offset in its `finally` (`background.js:192-195`, added by KAN-214).
  - Both callers of `runCapture` send failures to `captureFailed` (`background.js:11`, `background.js:20`). It logs the error and flashes `!` (`background.js:67-70`).
  - A call that never returns never throws, so none of this runs.
- **Helpers.** `sleep(ms)` is at `background.js:2`. The repo has no timeout helper.
- **Tests**
  - **Fake timers:** four test files run `background.js` with a fake `setTimeout` that calls its callback straight away:
    - `tests/capture-errors.test.js:64`, which also records each delay as a sleep and moves a fake clock forward;
    - `tests/fullpage.test.js:62`;
    - `tests/region-cancel.test.js:54`;
    - `tests/shortcut-format.test.js:44`, whose context has no `clearTimeout`.
  - **Fake captures:** each of those files has a fake `captureVisibleTab` that answers at once (`tests/capture-errors.test.js:38-43`, `tests/fullpage.test.js:83-87`, `tests/region-cancel.test.js:37`, `tests/shortcut-format.test.js:35`). None of them can leave a call unanswered.
  - **The one timing assertion:** "does not delay a capture that already stands alone" (`tests/capture-errors.test.js:93-101`) fails if a delay of 500 ms or more is recorded after the first capture.
  - **Real timers:** `tests/region-dispatch.test.js` uses the real `setTimeout`, but its worker finds no tab, so it never reaches a capture (`tests/region-dispatch.test.js:132`).
  - **Reading consts:** a test reads a `const` from the loaded script with `vm.runInContext` (`tests/defaults.test.js:20`).
  - `npm test` passes 132 tests.

## Change

Five files change.

1. **`background.js`:**
   - Add `CAPTURE_TIMEOUT_MS = 5000` next to `CAPTURE_MIN_GAP_MS` (`background.js:41`).
   - Add `captureWithTimeout(windowId)` after `captureVisible`. It races `chrome.tabs.captureVisibleTab` against `sleep(CAPTURE_TIMEOUT_MS)`, which then throws.
   - `captureVisible` calls `captureWithTimeout` in place of both `chrome.tabs.captureVisibleTab` calls (`background.js:50`, `background.js:54`).

   ```diff
   @@ -39,6 +39,7 @@
    // earlier capture - so every call goes through this gate: one at a time, spaced
    // out, and retried once if it still comes back over quota.
    const CAPTURE_MIN_GAP_MS = 550;
   +const CAPTURE_TIMEOUT_MS = 5000;
    let captureGate = Promise.resolve();
    let lastCaptureAt = 0;

   @@ -47,11 +48,11 @@
        const wait = CAPTURE_MIN_GAP_MS - (Date.now() - lastCaptureAt);
        if (wait > 0) await sleep(wait);
        try {
   -      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
   +      return await captureWithTimeout(windowId);
        } catch (e) {
          if (!/quota/i.test(e?.message || '')) throw e;
          await sleep(CAPTURE_MIN_GAP_MS);
   -      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
   +      return await captureWithTimeout(windowId);
        } finally {
          lastCaptureAt = Date.now();
        }
   @@ -60,6 +61,18 @@
      return shot;
    }

   +// Chrome has been seen never to answer a captureVisibleTab call. Every capture
   +// queued behind it then waited until the worker restarted, with the page left
   +// scrolled and its scrollbar and headers hidden. So a call that takes longer
   +// than CAPTURE_TIMEOUT_MS fails instead: the page is put back, the badge
   +// flashes, and the next capture goes ahead.
   +function captureWithTimeout(windowId) {
   +  return Promise.race([
   +    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
   +    sleep(CAPTURE_TIMEOUT_MS).then(() => { throw new Error(`captureVisibleTab did not answer within ${CAPTURE_TIMEOUT_MS / 1000}s`); }),
   +  ]);
   +}
   +
    // A capture has no UI thread to report into: the popup has closed on Region and
    // never existed for the keyboard shortcuts. So a failure flashes the badge -
    // silence was indistinguishable from a capture that simply did nothing, which
   ```

2. **`tests/capture-errors.test.js`:**
   - **`loadBg` (`:21-76`):**
     - A new option, `captureHangs(n)`, makes the n-th `captureVisibleTab` call never answer.
     - The fake `setTimeout` (`:64`) holds back the timer whose delay is `CAPTURE_TIMEOUT_MS`. It doesn't run it and doesn't record it as a sleep, so the clock and the recorded sleeps stay as they are now.
     - `expire()` runs the held timers.
     - The value is read from the loaded script with `vm.runInContext`.
   - **A new section** after "a failed capture does not stall the next one" (`:116-121`) adds two tests:
     1. **"gives up on a capture Chrome never answers":**
        - Before the deadline, the capture is still waiting.
        - Once the deadline passes, the capture fails with "did not answer", the scrollbar is shown again, and the badge shows `!`.
     2. **"a capture Chrome never answers does not hold up the next one":** a second capture is waiting behind the unanswered one. Once the deadline passes, it reaches Chrome and finishes.

   ```diff
   @@ -18,10 +18,12 @@

    // background.js against a fake browser. `clock` stands in for Date.now so the
    // rate-limit gate can be driven without real waiting; sleeps advance it.
   -function loadBg({ captureFails = null, scriptFails = false } = {}) {
   +function loadBg({ captureFails = null, captureHangs = null, scriptFails = false } = {}) {
      const shots = [];
      const badges = [];
      const sleeps = [];
   +  const deadlines = [];
   +  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      let now = 100000;

      class FakeCanvas {
   @@ -37,6 +39,7 @@
          query: async () => [TAB],
          captureVisibleTab: async () => {
            shots.push(now);
   +        if (captureHangs && captureHangs(shots.length)) return new Promise(() => {}); // Chrome never answers
            const e = captureFails && captureFails(shots.length);
            if (e) throw new Error(e);
            return PNG;
   @@ -60,8 +63,12 @@
        chrome, console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
        URL, btoa, clearTimeout,
        // Sleeps are the thing under test here, so record them and move the clock
   -    // rather than actually waiting.
   -    setTimeout: (fn, ms) => { sleeps.push(ms || 0); now += ms || 0; fn(); },
   +    // rather than actually waiting. The capture deadline isn't a sleep: it is
   +    // held until the test calls expire().
   +    setTimeout: (fn, ms) => {
   +      if (ms === captureTimeout) { deadlines.push(fn); return; }
   +      sleeps.push(ms || 0); now += ms || 0; fn();
   +    },
        // buildName still needs a real Date; only now() is under our control.
        Date: class extends Date { static now() { return now; } },
        window: {},
   @@ -72,7 +79,12 @@
      };
      vm.createContext(context);
      vm.runInContext(read('background.js'), context);
   -  return { ctx: context, shots, badges, sleeps, tick: (ms) => { now += ms; } };
   +  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
   +  return {
   +    ctx: context, shots, badges, sleeps,
   +    tick: (ms) => { now += ms; },
   +    expire: () => deadlines.splice(0).forEach((fn) => fn()), // the capture deadline passes
   +  };
    }

    const OPTS = { format: 'png', quality: 1, filename: 'x', toClipboard: false, hideScrollbar: true };
   @@ -118,6 +130,40 @@
      await bg.ctx.runCapture('visible', OPTS).catch(() => {});
      await bg.ctx.runCapture('visible', OPTS);
      assert.strictEqual(bg.shots.length, 2, 'the gate stayed shut on the rejected promise');
   +});
   +
   +// --- a capture Chrome never answers -----------------------------------------
   +// Chrome was seen never to return from a captureVisibleTab call. The gate
   +// waited on that call for good, so the capture never finished and neither did
   +// any capture after it: nothing saved, no badge, and the page left with its
   +// scrollbar hidden.
   +
   +test('gives up on a capture Chrome never answers', async () => {
   +  const bg = loadBg({ captureHangs: (n) => n === 1 });
   +  const hidden = [];
   +  const setScrollbarHidden = bg.ctx.setScrollbarHidden;
   +  bg.ctx.setScrollbarHidden = (tab, hide) => { hidden.push(hide); return setScrollbarHidden(tab, hide); };
   +  let failure;
   +  bg.ctx.runCapture('visible', OPTS).catch((e) => { failure = e; bg.ctx.captureFailed(e); });
   +  await settle();
   +  assert.strictEqual(failure, undefined, 'gave up before the deadline');
   +  bg.expire();
   +  await settle();
   +  assert.match(String(failure), /did not answer/, 'still waiting on a call Chrome will never answer');
   +  assert.deepStrictEqual(hidden, [true, false], 'the scrollbar was left hidden');
   +  assert.deepStrictEqual(bg.badges, ['!']);
   +});
   +
   +test('a capture Chrome never answers does not hold up the next one', async () => {
   +  const bg = loadBg({ captureHangs: (n) => n === 1 });
   +  bg.ctx.runCapture('visible', OPTS).catch(() => {});
   +  let next;
   +  bg.ctx.runCapture('visible', OPTS).then(() => { next = 'saved'; }, (e) => { next = e; });
   +  await settle();
   +  bg.expire();
   +  await settle();
   +  assert.strictEqual(bg.shots.length, 2, 'the next capture never reached Chrome');
   +  assert.strictEqual(next, 'saved');
    });

    // --- "Cannot access a chrome:// URL" ---------------------------------------
   ```

3. **`tests/fullpage.test.js`, `tests/region-cancel.test.js` and `tests/shortcut-format.test.js`:**
   - Each fake `setTimeout` still runs sleeps straight away, but it never runs the capture deadline.
   - Without this, the deadline fires at once and beats the fake capture, so every capture in these files fails.

   ```diff
   --- tests/fullpage.test.js
   @@ -56,10 +56,12 @@
      // look right even though every slice was the same unmoved viewport.
      const captureAt = [];
      const scriptCalls = [];
   +  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      const context = {
        console,
        URL, btoa, Date, clearTimeout,
   -    setTimeout: (fn) => fn(),      // collapse the settle sleeps so tests stay fast
   +    // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
   +    setTimeout: (fn, ms) => { if (ms !== captureTimeout) fn(); },
        document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
        getComputedStyle: (e) => ({ position: fixed.includes(e) ? 'fixed' : 'static' }),
        window: {
   @@ -97,6 +99,7 @@
      };
      vm.createContext(context);
      vm.runInContext(CODE, context);
   +  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      return { ctx: context, canvases, scriptCalls, captureAt };
    }

   --- tests/region-cancel.test.js
   @@ -49,9 +49,11 @@
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      };

   +  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      const context = {
        chrome, console, URL, btoa, Date, clearTimeout,
   -    setTimeout: (fn) => fn(), // collapse the settle sleeps
   +    // Collapse the settle sleeps. The capture deadline never passes.
   +    setTimeout: (fn, ms) => { if (ms !== captureTimeout) fn(); },
        window: {}, // the page the cancel injection runs against
        document: { getElementById: () => null, head: null, documentElement: { appendChild() {} }, createElement: () => ({ style: {} }) },
        OffscreenCanvas: FakeCanvas,
   @@ -60,6 +62,7 @@
      };
      vm.createContext(context);
      vm.runInContext(read('background.js'), context);
   +  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);

      const baseline = listeners.length; // background.js's own top-level listener
      return {

   --- tests/shortcut-format.test.js
   @@ -39,15 +39,18 @@
        storage: { local: { get: async () => ({ opts: { format, filename: 'shot' } }) } },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      };
   +  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
      const context = {
        chrome, console: { ...console, error: () => {} }, URL, btoa, Date,
   -    setTimeout: (fn) => fn(), // nothing on this path needs a real wait
   +    // Nothing on this path needs a real wait, and the capture deadline never passes.
   +    setTimeout: (fn, ms) => { if (ms !== captureTimeout) fn(); },
        OffscreenCanvas: FakeCanvas,
        createImageBitmap: async () => ({ width: 100, height: 100 }),
        fetch: async () => ({ blob: async () => ({}) }),
      };
      vm.createContext(context);
      vm.runInContext(read('background.js'), context);
   +  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
      await onCommand(command);
      await settle(); // the listener doesn't return the capture, so let it finish
      return downloads;
   ```

Choices:

- **5 seconds.** The ticket doesn't give a number.
  - A normal call answers well inside a second. KAN-220 puts a Full page capture at about 1 s per screen, and that includes the 500 ms settle before each shot (`background.js:182`).
  - In the ticket, nothing had been saved after 15 s and after 30 s. KAN-209 says Chrome stops an idle service worker after 30 s, and the gate, which only exists in the worker's memory, goes with it. 5 s is well under both.
  - It is one constant, so it's easy to change if Chrome shows it's too short.
- **Time each call to Chrome, not the whole capture.**
  - Waiting in the gate, the 550 ms gap and the wait before a quota retry don't count toward the limit.
  - A Full page stitch has no overall limit. Each of its slices gets its own.
- **Use `sleep` for the deadline, and don't clear it.**
  - When Chrome answers first, the timer still runs out later. It then rejects a promise whose race is already over, which does nothing.
  - The repo already leaves timers to run out like this (`background.js:362`, `offscreen.js:162`).
  - It also means `tests/shortcut-format.test.js`, whose context has no `clearTimeout`, doesn't need one added.
- **Don't retry a call that timed out.**
  - Only quota errors are retried now (`background.js:52`).
  - A timeout takes the same path as any other failure: the page is put back and the badge shows `!`.
  - `captureFailed` logs the timeout with `console.error`, so chrome://extensions lists it, like any other failed capture. It is a real failure, not one of the expected refusals that the repo logs with `console.warn`.
- **Ignore an answer that comes after the deadline.**
- **Leave `runCapture`, `captureFullPage`, `captureRegion` and `captureFailed` alone.** Once the call throws, their existing failure handling does what the ticket asks.
- **Change the fake timers in four test files.**
  - The deadline is a `setTimeout`, and those four files fire every `setTimeout` at once, so the deadline would beat every fake capture.
  - Each file now skips the timer whose delay is `CAPTURE_TIMEOUT_MS` and fires the rest as before.
  - Reading the value from `background.js` keeps the tests right if the value changes.
- **No README change and no version bump.**
  - The README says nothing about how long a capture takes.
  - KAN-214 (`0758c47`), KAN-241 (`52821dc`) and KAN-252 (`e226216`) all kept 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **The copy as it is now:** `npm test` passes 132 tests.
- **The `background.js` change on its own:** 24 tests fail, because the deadline fired at once in each case:
  - 5 in `tests/capture-errors.test.js`;
  - 11 in `tests/fullpage.test.js`;
  - 4 in `tests/region-cancel.test.js`;
  - 4 in `tests/shortcut-format.test.js`.
- **Step 1 (the constant plus the test changes):** `npm test` runs 134 tests, and only the 2 new ones fail:
  - "gives up on a capture Chrome never answers" fails with "still waiting on a call Chrome will never answer".
  - "a capture Chrome never answers does not hold up the next one" fails with "the next capture never reached Chrome".
- **Step 2 (all changes):** `npm test` passes 134 tests.
- **Chrome wasn't run while planning.** The unanswered call can't be caused on purpose: the ticket saw it once, and it didn't happen when each capture ran in its own browser.

## Steps

1. Add `const CAPTURE_TIMEOUT_MS = 5000;` to `background.js` (`:41`), and make the test changes above in all four files.
   → verify: `npm test` runs 134 tests. Only "gives up on a capture Chrome never answers" and "a capture Chrome never answers does not hold up the next one" fail. The other 132 pass.
2. Add `captureWithTimeout` to `background.js`, and use it for both calls in `captureVisible`.
   → verify: `npm test` passes 134 tests.
3. Check the change in Chrome 152, with the repo loaded unpacked. Use the headless setup from step 3 of `docs/KAN-217-plan.md`, with downloads set up as in step 3 of `docs/KAN-241-plan.md`: `download.default_directory` in `Default/Preferences`, and no `Browser.setDownloadBehavior`. Turn on file access.
   → verify:
   - **An http page, and a 6000 px tall file:// page:**
     - Visible, Full page and Region each save an image. No error shows, and the badge stays clear.
     - Full page of the tall page saves a 1280×6000 PNG, in about as long as it took before the change.
   - **The ticket's three Full page captures, in one browser,** each on a fresh copy of the tall page scrolled to 500:
     - The capture that switches to a tab the extension can capture shows `!`.
     - The capture that switches to a tab it can't capture shows `!`.
     - The capture with no switch saves the page.
     - After each one, the page is back at 500 with its fixed header showing, and the next capture runs.
     - If Chrome leaves a call unanswered, the worker logs "captureVisibleTab did not answer within 5s", and `!` shows about 5 s after that slice was taken.
4. Check that nothing else changed.
   → verify: `git status --short` lists this plan and the five files above, plus the files KAN-222's uncommitted change already lists. See the open question.

## Noticed while planning, not changed

- **A later call might go unanswered too.** If Chrome holds later calls behind the one it never answered, each later capture now fails after 5 s instead of waiting for good. The ticket doesn't say whether that happens.

## Open questions

- **Commit KAN-222 first?**
  - KAN-222's MP4 change is still uncommitted, although the ticket is Done in Jira.
  - It changes `background.js`, `tests/capture-errors.test.js` and `tests/shortcut-format.test.js`, which this plan also changes.
  - The steps work either way. But if KAN-222 isn't committed first, the diff for this ticket will be mixed in with it, and step 4 can't show this change on its own.
