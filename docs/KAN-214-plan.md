# KAN-214: Full page leaves the page broken if a capture fails mid-stitch, and can stitch in another tab

Ticket: https://prattsolutions.atlassian.net/browse/KAN-214 (To Do, no comments, labels `bug` and `viewshot`). No ticket blocks it. The ticket's line numbers are out of date; the ones below are from `main` at `88f34a7`.

## What the repo does now

- **The stitch**
  - `captureFullPage` (`background.js:157-197`) first measures the page (`background.js:158-161`). That step changes nothing on the page.
  - The slice loop (`background.js:170-183`) then works through the page. For each slice it:
    - scrolls the tab with `scrollPageTo` (`background.js:171`), which targets the tab by id (`background.js:151`);
    - from the second slice on, hides fixed/sticky elements (`background.js:178`);
    - takes the shot with `captureVisible(tab.windowId)` (`background.js:180`) and draws it into the canvas.
  - The page is put back only after the loop: fixed/sticky elements are shown again (`background.js:185`) and the scroll offset is restored (`background.js:186`). There's no `try/finally`, so if a slice throws, neither step runs.
- **Where errors go**
  - The only `finally` on this path is in `runCapture` (`background.js:82-83`), and it only removes the scrollbar-hiding style.
  - Both callers of `runCapture` send failures to `captureFailed` (`background.js:11`, `background.js:20`). It logs the error and flashes the `!` badge for 3 seconds (`background.js:67-70`, `background.js:350-354`).
- **Which tab gets captured**
  - `captureVisible` (`background.js:45-61`) calls `chrome.tabs.captureVisibleTab(windowId)` (`background.js:50`, `background.js:54`). That shoots whichever tab is showing in the window.
  - Nothing in `background.js` checks the tab: there's no `chrome.tabs.get` call and no check of the tab's `active` state.
  - So if the user switches tabs mid-stitch, scrolling keeps going in the original tab while the other tab's screens are drawn into the image.
- **Tests**
  - `load()` (`tests/fullpage.test.js:42-96`) runs `background.js` against a fake page. Its fake `chrome.tabs` has only `captureVisibleTab` (`tests/fullpage.test.js:82-85`), and that call never fails.
  - The fake page has no fixed elements (`querySelectorAll: () => []`, `tests/fullpage.test.js:63`) and no `getComputedStyle`. The code that hides fixed elements calls `getComputedStyle` (`background.js:208`), but only for elements the page actually returns.
  - None of the 18 tests in the file makes a slice fail or switches tabs.
  - The only other test that starts a full-page capture, "clears it before a full page stitch too" (`tests/region-cancel.test.js:85-89`), stops inside `measurePage`, before the loop.
  - `npm test` passes 123 tests.

## Change

Two files change.

1. **`background.js`:** in `captureFullPage`:
   - Wrap the slice loop in `try`, and move the two restore lines into its `finally`.
   - After each shot, check with `chrome.tabs.get` that the tab is still active and still in the same window. If it isn't, throw before the slice is drawn.

   Most of this diff only re-indents the loop. `git diff -w` shows 10 lines added and 1 removed.

   ```diff
   @@ -167,24 +167,33 @@ async function captureFullPage(tab) {
      )];

      let hid = false, landed = 0;
   -  for (let i = 0; i < positions.length; i++) {
   -    const actual = await scrollPageTo(tab, positions[i]);
   -    // The page refused to advance (unscrollable, or a scroller we can't drive).
   -    // Stop rather than stack the same viewport down the canvas.
   -    if (i > 0 && actual <= landed) break;
   -    landed = actual;
   -    // Keep fixed/sticky elements (pinned headers, banners) on the FIRST slice
   -    // only; hide them on later slices so they aren't stitched in repeatedly.
   -    if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
   -    await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   -    const url = await captureVisible(tab.windowId);
   -    const bmp = await createImageBitmap(await (await fetch(url)).blob());
   -    ctx.drawImage(bmp, 0, Math.round(actual * m.dpr)); // where it really is, not where we asked
   +  // finally: a slice that throws part-way must still put the page back, not
   +  // leave it scrolled to where the stitch stopped with its headers hidden.
   +  try {
   +    for (let i = 0; i < positions.length; i++) {
   +      const actual = await scrollPageTo(tab, positions[i]);
   +      // The page refused to advance (unscrollable, or a scroller we can't drive).
   +      // Stop rather than stack the same viewport down the canvas.
   +      if (i > 0 && actual <= landed) break;
   +      landed = actual;
   +      // Keep fixed/sticky elements (pinned headers, banners) on the FIRST slice
   +      // only; hide them on later slices so they aren't stitched in repeatedly.
   +      if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
   +      await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   +      const url = await captureVisible(tab.windowId);
   +      // captureVisibleTab shoots whichever tab is showing in the window. If the
   +      // user switched tabs (or moved this one out) mid-stitch, this slice is
   +      // another tab: stop rather than stitch it in.
   +      const now = await chrome.tabs.get(tab.id);
   +      if (!now.active || now.windowId !== tab.windowId) throw new Error('Full page stopped: another tab is now showing');
   +      const bmp = await createImageBitmap(await (await fetch(url)).blob());
   +      ctx.drawImage(bmp, 0, Math.round(actual * m.dpr)); // where it really is, not where we asked
   +    }
   +  } finally {
   +    if (hid) await setFixedHidden(tab, false); // restore
   +    await scrollPageTo(tab, m.prevY);
      }

   -  if (hid) await setFixedHidden(tab, false); // restore
   -  await scrollPageTo(tab, m.prevY);
   -
      // Trim to what was actually stitched, so an early stop yields a short correct
      // image instead of a tall one padded with blank space.
      const filled = Math.min(canvas.height, Math.round((landed + m.vh) * m.dpr));
   ```

2. **`tests/fullpage.test.js`:**
   - **Test setup:** `load()` takes four new options, whose defaults leave the 18 existing tests unchanged:
     - `fixed`: the elements the fake page returns as `position: fixed`, with a matching `getComputedStyle`;
     - `failAt`: the number of the shot that throws;
     - `leaveAt` and `leave`: the fake `chrome.tabs.get` reports the tab as switched away from, or moved to another window, from that shot on.
   - **Two new tests**, in a new section at the end of the file:
     1. A page scrolled to 640, with a fixed header, whose third shot throws. The capture rejects with that error, and the page is back at 640 with its header shown again.
     2. For both a tab switch and a move to another window, from the second shot on: the capture rejects, only the first slice is drawn, and the page is back at 640.

   ```diff
   @@ -39,7 +39,7 @@ function smoothEl(scrollHeight, clientHeight) {

    // background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
    // the capture are all mocked — nothing real is touched.
   -function load({ de, body, iw = 1512, ih = 767, dpr = 2 }) {
   +function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0, leaveAt = 0, leave = {} }) {
      const canvases = [];
      class FakeCanvas {
        constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
   @@ -60,7 +60,8 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2 }) {
        console,
        URL, btoa, Date, clearTimeout,
        setTimeout: (fn) => fn(),      // collapse the settle sleeps so tests stay fast
   -    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => [] },
   +    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
   +    getComputedStyle: (e) => ({ position: fixed.includes(e) ? 'fixed' : 'static' }),
        window: {
          innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr,
          // Faithful to the browser: window.scrollTo drives the document scroller.
   @@ -81,8 +82,12 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2 }) {
          tabs: {
            captureVisibleTab: async () => {
              captureAt.push(Math.max(de ? de.scrollTop : 0, body ? body.scrollTop : 0));
   +          if (captureAt.length === failAt) throw new Error('capture failed');
              return 'data:image/png;base64,AAAA';
            },
   +        // From capture `leaveAt` on, the tab is no longer the one showing in
   +        // window 9: `leave` says whether it was switched away from or moved.
   +        get: async (id) => ({ id, windowId: 9, active: true, ...(leaveAt && captureAt.length >= leaveAt ? leave : {}) }),
          },
          runtime: { onMessage: { addListener() {} } },
          commands: { onCommand: { addListener() {} } },
   @@ -229,3 +234,31 @@ test('stitches every screen of a smooth-scrolling page', async () => {
      await ctx.captureFullPage(TAB);
      assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200], 'stopped before the end of the page');
    });
   +
   +// --- a stitch that stops part-way ------------------------------------------
   +// The page was only put back after the last slice, so a slice that threw left
   +// it scrolled to wherever the stitch stopped, with its pinned headers hidden.
   +// And each slice is a shot of whichever tab is showing in the window, so a
   +// switch mid-stitch put the other tab into the image.
   +
   +test('puts the page back when a slice fails part-way', async () => {
   +  const body = el(3052, 767);
   +  body.scrollTop = 640;
   +  const header = { style: { visibility: '' } };
   +  const { ctx } = load({ de: el(767, 767), body, fixed: [header], failAt: 3 });
   +  await assert.rejects(() => ctx.captureFullPage(TAB), /capture failed/);
   +  assert.strictEqual(body.scrollTop, 640, 'left scrolled to where the stitch stopped');
   +  assert.strictEqual(header.style.visibility, '', 'left the pinned header hidden');
   +});
   +
   +test('stops rather than stitch in a tab the user switched to', async () => {
   +  // Switched to another tab, or dragged this one out to another window.
   +  for (const leave of [{ active: false }, { windowId: 4 }]) {
   +    const body = el(3052, 767);
   +    body.scrollTop = 640;
   +    const { ctx, canvases } = load({ de: el(767, 767), body, leaveAt: 2, leave });
   +    await assert.rejects(() => ctx.captureFullPage(TAB), /another tab is now showing/);
   +    assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0], `stitched in the other tab after ${JSON.stringify(leave)}`);
   +    assert.strictEqual(body.scrollTop, 640, 'the stopped stitch left the page scrolled');
   +  }
   +});
   ```

Choices:

- **`try` wraps only the loop.** Measuring the page changes nothing, and nothing after the loop touches the page.
- **The `finally` doesn't swallow its own errors.**
  - If the tab has closed or navigated away, putting the page back fails too. That error then replaces the slice's error, and it still ends in `captureFailed` and the `!` badge.
  - A restore that fails after a complete stitch still fails the capture, as it does today.
- **Check after each shot, not before.** `captureVisible` can wait at its rate-limit gate. A check made before the shot would miss a switch that happens during that wait. A check made after it catches any shot taken once the user has switched away.
- **The check covers the window too.** A tab dragged into another window is still `active` there, but `captureVisibleTab(tab.windowId)` would shoot whatever tab is left in the old window.
- **On a switch, stop and save nothing.** This uses the existing failure path: the error goes to `captureFailed` (logged, with the `!` badge), the same as any other failed capture, and the `finally` puts the page back. The alternatives, and why not:
  - **Wait for the tab to come back:** the page would stay scrolled, with its headers hidden, for as long as the user stays away.
  - **Switch back to the tab:** that would undo the user's own switch.
  - **Save the slices taken so far:** the image would stop part-way down with nothing to say so. The existing trim (`background.js:188-195`) is for pages that stop scrolling by themselves.
- **No new permission.** Reading a tab's `active` state and `windowId` with `chrome.tabs.get` needs none, so `manifest.json` and the README's permission list stay as they are.
- **Nothing else changes.** These stay separate tickets:
  - overlapping captures (KAN-213);
  - sticky elements further down the page (KAN-218);
  - showing the error in the popup (KAN-220).
- **No version bump.** KAN-208, KAN-217 and KAN-243 all changed code that ships and kept 0.3.2.

Checked while planning, on a copy of the repo outside this folder:

- **Only the test changes:** `node --test tests/fullpage.test.js` ran 20 tests. 18 passed, and both new ones failed:
  - "puts the page back when a slice fails part-way": `actual: 1534, expected: 640`;
  - "stops rather than stitch in a tab the user switched to": `Missing expected rejection.`
- **Both changes:** `npm test` passed 125 tests.
- **Chrome:** not tried while planning. Step 3 does that.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `node --test tests/fullpage.test.js` runs 20 tests. Only the two new tests fail, with the messages above.
2. Make the `background.js` change above.
   → verify:
   - `npm test` passes 125 tests (the 123 existing ones plus the 2 new ones).
   - `git diff -w --stat background.js` shows 10 lines added and 1 removed.
3. Check the change in Chrome 152. Use the headless setup from step 3 of `docs/KAN-217-plan.md`, with the repo loaded unpacked:
   - Wait until a tab's `location.href` is the page itself, not the initial `about:blank`, before calling `Extensions.triggerAction`. A grant made earlier is cleared when the page loads.
   - **Pages:**
     - a file:// page 6000 px tall with a `position: fixed` header, scrolled to 500 before each capture. An extension loaded unpacked starts with file access on.
     - a second tab on `https://example.com/`.
   - **In the popup,** set Format to PNG.
   - **Worker:** attach to it (the `service_worker` target whose URL ends in `/background.js`) and enable `Runtime`.

   → verify:
   - **Switching tabs mid-stitch:** click Full page on the tall page, and about 1.2 s later activate the example.com tab with `Target.activateTarget`.
     - No PNG is saved.
     - Within 3 s, the worker logs `Full page stopped: another tab is now showing` as an error, and `chrome.action.getBadgeText({})` in the worker returns `!`.
     - Back on the tall page, `document.scrollingElement.scrollTop` is 500, and the header's inline `visibility` is empty again.
   - **The same switch with the previous `background.js`** from `88f34a7` still saves a PNG and logs no error.
   - **No switch:** Full page on the tall page saves one PNG, 6000 CSS px tall times the device pixel ratio. The page is left at 500 with its header shown.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and this plan.

## Open questions

None. The ticket names both faults and the code behind them. The repo already reports a failed capture with the `!` badge, which settles what a stopped stitch should do.
