# KAN-213: Overlapping captures corrupt the full-page stitch and can leave fixed headers hidden

Ticket: https://prattsolutions.atlassian.net/browse/KAN-213. It is a To Do Task labelled `bug` and `viewshot`, with no comments. It was blocked by KAN-220, which is Done.

## What the repo does now

As of `16f4d3a`:

- **Nothing makes one capture wait for another.**
  - `runCapture` (`background.js:242-264`) runs straight away when the popup asks (`:11` for Region, `:16-19` for Visible and Full page) and when a shortcut asks (`:107`).
  - A Region's shot runs straight away when `shot-region` comes in (`:37-57`).
  - Only the single `captureVisibleTab` calls wait for each other, through `captureGate` in `captureVisible` (`:179-197`). The ticket's line numbers (`:45-61`, `:194-212`) are from before later changes moved this code.
- **So the ticket's three effects still happen:**
  - **Mismatched slices.** Two Full pages scroll the same page. `captureFullPage` (`:382`) scrolls to each slice, and at the end back to where the page was (`:542`).
  - **Headers left hidden.**
    - The fixed elements' own visibility is kept in one `window.__shotHidden` (`setFixedHidden`, `:641`). The first fixed hide starts it over (`:652`), and the restore drops it (`:670`). The sticky ones' is kept in one `window.__shotSticky` (`markSticky`, `:609-610`).
    - A second capture starting mid-stitch records the `'hidden'` the first one gave them as their own visibility.
    - The first capture's restore then puts that `'hidden'` back and drops both lists. The second capture's restore has nothing left to put back.
  - **Scrollbar reappears.** Both captures use the one scrollbar style, `#__shotHideScrollbar` (`setScrollbarHidden`, `:681`). Each capture's `finally` takes it away: `:260`, and `:55` for a Region's shot.
- **The popup:**
  - The popup that sent a capture greys out its mode buttons until the worker answers (KAN-220: `popup.js:8`, `:178`).
  - A popup opened during a capture doesn't (KAN-545).
  - Neither the popup nor the shortcuts can stop a shortcut from starting a second capture.
- **Tests:** `npm test` runs 372 tests, and all pass.
  - No test runs two captures at once through `runCapture`.
  - The page harness in `tests/fullpage.test.js` throws the worker's message listener away (`:120`).

## Change

Three files change: `background.js` and two test files. `popup.js`, `README.md`, `manifest.json` and `package.json` don't change.

1. **`background.js`:**
   - `runCapture` waits its turn on `runGate`, a promise chain like `captureGate` (`:179-197`) and `recStartGate` (`:869`). Its body is unchanged, one level further in (`:242-264`).
   - A Region's shot waits its turn on the same gate (`:37-57`).

   The diff below ignores the new indentation (`diff -w`):

   ```diff
   @@ -35,7 +35,9 @@
      else if (msg?.type === 'shot-region') {
   -    chrome.storage.session.get('pendingRegion').then(async ({ pendingRegion }) => {
   +    // Its turn like any capture's (runGate, KAN-213): alongside a full page,
   +    // its finally took the scrollbar style away in the middle of the stitch.
   +    const shot = runGate.then(() => chrome.storage.session.get('pendingRegion')).then(async ({ pendingRegion }) => {
          if (!pendingRegion) return;
   @@ -54,7 +56,9 @@
          } finally {
            if (opts.hideScrollbar) await setScrollbarHidden(tab, false).catch(() => {});
          }
   -    }).catch(captureFailed);
   +    });
   +    runGate = shot.catch(() => {});
   +    shot.catch(captureFailed);
      }
   @@ -239,7 +243,20 @@
   -async function runCapture(mode, opts, tabId) {
   +// One capture at a time (KAN-213). captureGate only spaces out the single
   +// captureVisibleTab calls, so a second capture - a shortcut pressed twice, or
   +// a shortcut during the popup's capture - ran alongside the first. Two full
   +// pages scrolled the same page under each other and shot each other's
   +// offsets; the second one recorded the headers the first had hidden as their
   +// own visibility, so they were left hidden; and one capture's finally took
   +// the scrollbar style away while the other was still shooting. Now a capture
   +// waits for the one before it to finish, and so does a Region's shot
   +// (shot-region). Its page scripts and captureVisibleTab calls each have a
   +// deadline (CAPTURE_SCRIPT_TIMEOUT_MS, CAPTURE_TIMEOUT_MS), so a page or a
   +// shot that never answers can't hold the others up for good.
   +let runGate = Promise.resolve();
   +function runCapture(mode, opts, tabId) {
   +  const run = runGate.then(async () => {
      const tab = await getActiveTab(tabId);
      ...
      await saveCapture(png, opts, tab);
   +  });
   +  runGate = run.catch(() => {}); // one capture's failure must not stall the next
   +  return run;
    }
   ```

2. **`tests/fullpage.test.js`:**
   - The harness keeps the worker's message listener and hands it back as `message` (`:71`, `:120`, `:136`).
   - Two helpers and four tests go at the end.

   ```diff
   @@ -68,6 +68,7 @@
      const sent = []; // what the worker told the popup
   +  let onMessage; // background.js's chrome.runtime.onMessage listener
   @@ -117,7 +118,7 @@
   -      runtime: { onMessage: { addListener() {} }, onStartup: ...
   +      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, onStartup: ...
   @@ -133,7 +134,7 @@
   -  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent };
   +  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, message: (m) => onMessage(m, {}, () => {}) };
   ```

   ```js
   // --- one capture at a time (KAN-213) ---------------------------------------
   // Only the single captureVisibleTab calls went through a gate, so a second
   // capture ran alongside the first: a shortcut pressed twice, or a shortcut
   // during the popup's capture. Two full pages scrolled the same page under each
   // other, the headers the first had hidden stayed hidden, and one capture's
   // finally took the scrollbar style away while the other was still shooting.

   const RUN_OPTS = { format: 'png', quality: 1, filename: 'x', toClipboard: false, hideScrollbar: true };
   const settle = () => new Promise((r) => setImmediate(r));

   // What runCapture needs beyond the stitch: session storage for the Region key,
   // and somewhere to save to.
   function forRunCapture(ctx, session = {}) {
     ctx.chrome.storage.session = {
       get: async (k) => ({ [k]: session[k] }),
       set: async (o) => { Object.assign(session, o); },
       remove: async (k) => { delete session[k]; },
     };
     const saved = [];
     ctx.chrome.downloads = { download: async (o) => { saved.push(o.filename); } };
     return saved;
   }

   // The <style> setScrollbarHidden puts in the page, and whether it was there
   // for each shot.
   function scrollbarStyle(ctx) {
     const byId = new Map();
     Object.assign(ctx.document, {
       getElementById: (id) => byId.get(id) || null,
       createElement: () => { const el = { remove: () => byId.delete(el.id) }; return el; },
       head: { appendChild: (el) => byId.set(el.id, el) },
     });
     const shots = [];
     const capture = ctx.chrome.tabs.captureVisibleTab;
     ctx.chrome.tabs.captureVisibleTab = (...a) => { shots.push(byId.has('__shotHideScrollbar')); return capture(...a); };
     return { shots, inPlace: () => byId.has('__shotHideScrollbar') };
   }

   test('runs a second full page only once the first has finished', async () => {
     const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767) });
     const saved = forRunCapture(ctx);
     await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('fullpage', RUN_OPTS, TAB.id)]);
     assert.deepStrictEqual(captureAt, [0, 767, 1534, 2285, 0, 767, 1534, 2285], 'the two stitches scrolled the page under each other');
     assert.strictEqual(saved.length, 2);
   });

   test('leaves a pinned header shown after two full pages at once', async () => {
     const header = { style: { visibility: '' } };
     const { ctx, shownAt } = load({ de: el(767, 767), body: el(3052, 767), fixed: [header] });
     forRunCapture(ctx);
     await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('fullpage', RUN_OPTS, TAB.id)]);
     assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', '', 'hidden', 'hidden', 'hidden']);
     assert.strictEqual(header.style.visibility, '', 'left the pinned header hidden');
   });

   test('keeps the scrollbar hidden for a whole full page when a visible is asked for during it', async () => {
     const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
     forRunCapture(ctx);
     const bar = scrollbarStyle(ctx);
     await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('visible', RUN_OPTS, TAB.id)]);
     assert.deepStrictEqual(bar.shots, [true, true, true, true, true], 'the scrollbar came back during the stitch');
     assert.strictEqual(bar.inPlace(), false, 'left the scrollbar hidden');
   });

   test('finishes a Region shot before a full page asked for after it starts', async () => {
     const body = el(3052, 767);
     body.scrollTop = 640; // where the user made the selection
     const { ctx, captureAt, message } = load({ de: el(767, 767), body });
     const saved = forRunCapture(ctx, { pendingRegion: { tab: TAB, opts: RUN_OPTS } });
     const bar = scrollbarStyle(ctx);
     await ctx.setScrollbarHidden(TAB, true); // the Region hid it when it started
     message({ type: 'shot-region', rect: { x: 0, y: 0, w: 100, h: 100, dpr: 2 } });
     await ctx.runCapture('fullpage', RUN_OPTS, TAB.id);
     for (let i = 0; i < 5; i++) await settle();
     assert.deepStrictEqual(captureAt, [640, 0, 767, 1534, 2285]);
     assert.deepStrictEqual(bar.shots, [true, true, true, true, true], 'the Region took the scrollbar style away during the stitch');
     assert.strictEqual(saved.length, 2);
     assert.strictEqual(bar.inPlace(), false, 'left the scrollbar hidden');
   });
   ```

3. **`tests/capture-errors.test.js`:** one test at the end.

   ```js
   // --- one capture at a time (KAN-213) ---------------------------------------
   // A capture waits for the one before it to finish. One that fails must still
   // let the next one through.

   test('a capture that fails does not hold up the one waiting behind it', async () => {
     const bg = loadBg();
     const first = bg.ctx.runCapture('visible', OPTS, 99); // that tab has closed
     const second = bg.ctx.runCapture('visible', OPTS, TAB.id);
     await assert.rejects(first, /No tab with id: 99/);
     await second;
     assert.strictEqual(bg.shots.length, 1, 'the second capture never ran');
   });
   ```

Choices:

- **Queue, not ignore.** The ticket allows either.
  - The repo's gates queue: `captureGate` (`:179-197`) and `recStartGate` (`:869`).
  - A second press is never lost. Two presses give two images.
  - Each page script and each `captureVisibleTab` call already has a deadline, so a capture that never answers can't hold the queue for good.
- **The gate is inside `runCapture`,** so the popup, the shortcuts and the tests all go through it. None of the three places that call it change.
- **A Region's shot takes a turn too.** Its overlay is put up inside `runCapture`. Its shot comes later, with `shot-region`. Run alongside a Full page, its `finally` took the scrollbar style away mid-stitch, which is what the Region test checks.
- **Region timing:**
  - A Region asked for during a capture puts its overlay up once that capture has finished.
  - A capture asked for while a Region's overlay is up still takes the overlay down first (`cancelRegion`, `:715`), as before.
- **Nothing more for the popup's buttons.**
  - The popup that sent a capture already greys them out (KAN-220).
  - With the queue, a press in any other popup now waits its turn instead of running on top.
  - A popup opened mid-capture showing that capture is KAN-545.
- **A popup's capture waiting behind a shortcut's Full page shows that Full page's screens** ("Capturing screen N of M…") until its own capture has run, then its own result. `capture-progress` doesn't say whose capture it is. This was seen in Chrome (below).
- **Recordings aren't in this queue.** They have their own (`recStartGate`), and a screenshot during a recording still works.
- **No README change, no new files, no version bump.**

Checked while planning, on a copy of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 372 tests.
  - **Test changes only:** 377 tests. 373 pass and 4 fail:
    - "runs a second full page only once the first has finished";
    - "leaves a pinned header shown after two full pages at once";
    - "keeps the scrollbar hidden for a whole full page when a visible is asked for during it";
    - "finishes a Region shot before a full page asked for after it starts".

    The unchanged code takes the two stitches' shots alternately (0, 0, 767, 767, …), leaves the header `'hidden'`, and loses the scrollbar style after the first shot. "a capture that fails does not hold up the one waiting behind it" already passes.
  - **Every change:** `npm test` passes all 377 tests.
  - **Each part of the change is needed:**
    - With `runCapture` not gated, those 4 fail.
    - With the Region's shot not gated, only the Region test fails.
    - With a failed capture left in the gate (no `.catch`), the new capture-errors test fails, and so do three existing ones.
- **Headed Chrome 153.0.8010.48**, with `/tmp/vs387-chrome/run-213.js`:
  - The page is local, 4000 px tall, with a 60 px fixed header. The viewport is 713 px at dpr 2.
  - The popup is opened once first, to grant activeTab as a shortcut press does. The captures are then started in the worker with `runCapture`, the way the shortcuts start them.
  - Each image is hashed (SHA-256 of the PNG) as it goes to be saved.
  - **Before, the repo as it is:**
    - **One Full page alone:** 2560×8000, `25c20ad0`.
    - **Two Full pages at once:** the second image is different (`8e18f6e8`), and the header is left hidden: its computed visibility is `hidden`, and its inline style says `'hidden'`.
    - **A Full page and a Visible at once:** the Visible's restore took the scrollbar style away before the stitch's first scroll (`bar+ bar- y713 …`), and the Full page image is different (`a8f90363`).
  - **After, with the change:**
    - **Two Full pages at once:** one ran after the other (`bar+ y713 … y0 bar- bar+ y713 … y0 bar-`). Both images are `25c20ad0`, and the header is visible.
    - **A Full page and a Visible at once:** the Visible ran after the stitch, and the style was in place for the whole stitch. The Full page image is `25c20ad0`.
    - **A shortcut's Full page, with the popup's Visible pressed 300 ms in:**
      - The popup showed "Capturing…", then "Capturing screen 3 of 6…" through "6 of 6…" from the shortcut's stitch, then "Saved." at 3246 ms with its buttons back.
      - The Full page (`25c20ad0`) was saved first, then the Visible.
    - No exception in any console.

## Steps

1. Make the test changes above in `tests/fullpage.test.js` and `tests/capture-errors.test.js`.
   → verify: `npm test` runs 377 tests. 373 pass, and only the four `tests/fullpage.test.js` tests listed above fail. "a capture that fails does not hold up the one waiting behind it" passes already.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 377 tests.
3. Check the change in headed Chrome: `node /tmp/vs387-chrome/run-213.js --ext /Users/john/dev/viewshot --headful`.
   → verify:
   - **Two Full pages at once:** one after the other in the page's log, both images the same as the one taken alone, and the header visible after them.
   - **A Full page and a Visible at once:** the scrollbar style is in place for the whole stitch, and the Full page image is the same as the one taken alone.
   - **The popup's Visible during a shortcut's Full page:** it is saved after the Full page, and the popup ends on "Saved." with its buttons back.
   - No exception in any console.
4. Check that nothing else changed.
   → verify: `git status --short` lists only the three files above and this plan.

## Open questions

None. The ticket leaves the choice between queueing and ignoring to the implementer, and this plan queues, for the reasons under "Choices".

## Added when shipping

- **One more test** in `tests/fullpage.test.js`, before "finishes a Region shot before a full page asked for after it starts": "puts a Region's overlay up only once a full page asked for before it has finished".
  - It covers the Region branch of `runCapture` behind the gate. "Choices" describes that behaviour, but no test in "Change" checked it.
  - It fails when `runCapture` isn't gated.
- **Step 3, run on this folder:** the same results as in "Checked while planning".
  - Two Full pages ran one after the other. Both images were `25c20ad0`, and the header was visible after them.
  - A Full page and a Visible at once kept the scrollbar style for the whole stitch. The Full page image was `25c20ad0`.
  - The popup's Visible, pressed during a shortcut's Full page, was saved after it, with "Saved." at 3313 ms.
- **Not fixed here:** a popup waiting its turn shows the other capture's progress as its own (KAN-552).
- `npm test` passes all 378.
