# KAN-592: Full page stitch misplaces a slice when the page scrolls itself while that slice settles

Ticket: https://prattsolutions.atlassian.net/browse/KAN-592 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-576, is Done.

## What the repo does now

Line numbers are from `c3ee966`, with a clean working tree.

- **Each slice is drawn where its scroll left the page.**
  - `scrollAndReport` reads the offset straight after the scroll (`background.js:416`).
  - The loop takes that as `reached` (`:493-494`) and draws the slice at `actual = reached - moved` (`:496`). The draws that use it are at `:602` and `:614`.
- **The shot comes later, and nothing reads the offset again.**
  - The slice settles for 500 ms (`:520`), and the fixed and sticky passes run again (`:524-527`).
  - Then the frame check (`:536`) asks the page for a frame, and the slice is shot (`:537`).
  - `reportFrame` (`:429-434`) answers only `true` or `false`, and `pageIsDrawing` (`:436-441`) passes on only that.
- **A slice is shot again only for fixed and sticky elements.**
  - The shot loop (`:519-557`) can shoot a slice twice, but only when the passes after the shot find a fixed or sticky element that turned up after the last hide (`reshot`, `:550-556`; KAN-525, KAN-526).
  - The first slice is never shot again for that reason (`i === 0`).
- **The result for a page that scrolls itself while the slice settles:**
  - it is shot where it scrolled to, and drawn where the scroll left it;
  - the rows between the two offsets are left out;
  - the rows past them are drawn twice: at the bottom of that slice and in the next.
- **Tests:** `npm test` passes 414.
  - The settle-time tests either move content above the screen (`anchoredPage`, `tests/fullpage.test.js:338-351`) or put in and pin fixed and sticky elements (`:668-718`, `:890-936`).
  - None has a page that scrolls itself while a slice settles.

**The ticket's harness case, reproduced.** The page is `load()` with a 3000 px body scroller in a 713 px viewport at dpr 1. It scrolls itself 200 px down while the second slice settles, and its height doesn't change.

| | `captureAt` | draws | image |
|---|---|---|---|
| `HEAD` | 0, 913, 1426, 2139, 2287 | 0, 713, 1426, 2139, 2287 | 3000 px |
| With the change | 0, 713, 1426, 2139, 2287 | 0, 713, 1426, 2139, 2287 | 3000 px |

On `HEAD`, the second slice is shot at 913 and drawn at 713. So the page's rows 713-912 are left out, and rows 1426-1625 are drawn twice.

**Reproduced in Chrome 153.0.8010.48**, as the ticket says.

- **The script:** `/tmp/vs387-chrome/run-576.js` (see `docs/KAN-576-plan.md`).
  - Its `settlescroll` page is PageG with anchoring on and nothing that changes height.
  - The page scrolls itself 200 px down 200 ms after its first scroll (the capture's scroll to 713), while the second slice settles.
  - Its header lists the other pages.
- **The run:** headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1. The PNGs are read with `/tmp/vs387-chrome/bands-515.py`.
- **The results.**
  - "In place" means each band shows once, at its place at the start (yellow 600, red 1300, green 1500, blue 2500), in a 3000 px image.
  - The `HEAD` column comes from earlier runs of the same `background.js`: the KAN-576 plan's runs and the ones made when KAN-590, KAN-591 and KAN-592 were filed. That code was committed as `6e85e7c`, and `c3ee966` changes only a doc.

  | Page | `HEAD` | With the change |
  |---|---|---|
  | `settlescroll` | offsets 713, 913, 1426, 2139, 2287; red 1100, green at 1300 and at 1500, blue 2500; 3000 tall | offsets 713, 913, 713, 1426, 2139, 2287; in place, a PNG byte-identical to `still`'s |
  | `move-up` (KAN-591) | offsets 713, 1013, 1426, 2139, 2587; red at 1300 and at 1600, green 1800, blue 2800; 3300 tall | offsets 713, 1013, 713, 1426, 2139, 2587; yellow at 600 and at 900, red 1600, green 1800, blue 2800; 3300 tall |
  | `selfscroll` | in place | byte-identical to `HEAD`'s |
  | `selfscroll-grow` (KAN-590) | offsets 713, 913, 1626, 2339, 2387; green nowhere, blue 2300; 2900 tall | byte-identical to `HEAD`'s |
  | `still` | in place | byte-identical to `HEAD`'s |
  | `grow` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor` | in place | byte-identical to `HEAD`'s |
  | `shrink-noanchor` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor-important` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor-important-layer` | in place | byte-identical to `HEAD`'s |
  | `grow-noanchor-important-inline` | in place | byte-identical to `HEAD`'s |
  | `grow-compensate` (KAN-580) | offsets 713, 1313, 2026, 2587; red 1000, green 1200, blue 2200; 2700 tall | byte-identical to `HEAD`'s |

- **With the change, `settlescroll` is put back.** The page's own 713 → 913 is followed by the capture's 913 → 713 before the second slice is shot.
- **`move-up` changes, and is still wrong** (see Choices).

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan592-plan/tree`.

**The rule:**
- The frame check, the last page script before each shot, now also says where the page is in the frame the shot finds, and how tall it is.
- Suppose the page isn't where the slice's scroll left it, and is as tall as it was then. Then it scrolled itself while the slice settled.
  - It is put back where the scroll left it.
  - The slice settles again, and runs the passes that follow the settle, before it is shot.
- This happens once per slice. A page that scrolls itself again is shot where it is, as today.
- A page that is still where its scroll left it is shot as today. So is one whose height changed, because scroll anchoring moved it with its rows (KAN-515).

1. **`background.js`**
   - **`reportFrame` (`:429-434`):**
     - From the frame it already waits for, it answers `{ top, total }`: the offset and height of `window.__vsScroller`, which `measurePage` sets (`:365`).
     - The timer still answers `false`.
   - **`pageIsDrawing` (`:436-441`):** returns that answer, or `false`, in place of `result === true`.
   - **The shot loop (`:536`):**
     - It keeps the frame check's answer in `frame`.
     - When `shot === 1 && frame.top !== reached && frame.total === total`, it puts the page back with `scrollPageTo(tab, reached)` and goes round again (`continue`).
     - The second time round is the loop's second shot: it settles, runs the passes, checks the frame and shoots.
     - The break at `:556` (`i === 0 || shot === 2 || !reshot`) then ends the loop, so a slice is still shot twice at most, the first slice included.
   - **No new page script on a page that doesn't scroll itself.** The call-order tests (`tests/fullpage.test.js:835`, `:935`, `:1003-1018`) are untouched. Putting the page back is one more `scrollAndReport`, only when the page moved.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -426,18 +426,24 @@
    // shot beat that frame to the screen, and an element hidden just before the
    // frame check could still be in the shot (KAN-525). By the time the next frame
    // starts, the page has painted the one with the hides in it.
   +// It answers with where the page is in that frame, and how tall it is: what
   +// the shot finds (KAN-592).
    function reportFrame(ms) {
      return new Promise((resolve) => {
   -    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
   +    requestAnimationFrame(() => requestAnimationFrame(() => {
   +      const el = window.__vsScroller;
   +      resolve({ top: el?.scrollTop, total: el?.scrollHeight });
   +    }));
        setTimeout(() => resolve(false), ms); // whichever lands first wins; the other is a no-op
      });
    }
    
   +// The frame check's answer, or false for a window that isn't drawing.
    async function pageIsDrawing(tab) {
      const [{ result }] = await scriptWithTimeout({
        target: { tabId: tab.id }, func: reportFrame, args: [FRAME_TIMEOUT_MS],
      }, CAPTURE_SCRIPT_TIMEOUT_MS);
   -  return result === true;
   +  return result || false;
    }
    
    // Scroll to y (with `last`, the last slice's report, y past where its rows are
   @@ -533,7 +539,18 @@
            // saved a tall image that is the same screen over and over, with nothing
            // to say so. Ask the page for a frame rather than compare the pixels: a
            // flat stretch of page shoots the same bytes twice while drawing fine.
   -        if (!await pageIsDrawing(tab)) throw new Error('Full page stopped: the window is not drawing (minimized?)');
   +        const frame = await pageIsDrawing(tab);
   +        if (!frame) throw new Error('Full page stopped: the window is not drawing (minimized?)');
   +        // A page that scrolled itself while the slice settled, and is as tall
   +        // as it was, would be shot where it scrolled to and drawn where the
   +        // slice's scroll left it: the rows between were left out, and the ones
   +        // past them went in twice (KAN-592). It goes back, and the slice settles
   +        // and runs the passes that follow the settle again before it is shot.
   +        // Once: a page that scrolls itself again is shot where it is.
   +        if (shot === 1 && frame.top !== reached && frame.total === total) {
   +          await scrollPageTo(tab, reached);
   +          continue;
   +        }
            url = await captureVisible(tab.windowId);
            // captureVisibleTab shoots whichever tab is showing in the window. If the
            // user switched tabs (or moved this one out) mid-stitch, this slice is
   ```

2. **`tests/fullpage.test.js`:** a new section after the KAN-576 one. It goes after `:403` and before "pages that turn scroll anchoring off" (`:405`), and holds two tests:
   - **The ticket's page.** It checks where each slice was shot, where each was drawn, and the image's height.
   - **A page that scrolls itself each time the second slice settles.**
     - It is put back once, and on the second settle the slice is shot where the page is.
     - The page stops after five scrolls, so a stitch that puts it back every time still ends.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -401,7 +401,42 @@
      assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], "drew the slices back by the page's own scroll");
      assert.strictEqual(canvases[canvases.length - 1].height, 3000, "cut the image short by the page's own scroll");
    });
   +
   +// --- a page that scrolls itself while a slice settles ----------------------
   +// Each slice was drawn where its scroll left the page, and shot once the page
   +// had settled. A page that scrolled itself while the slice settled was shot
   +// where it scrolled to: the rows between were left out, and the ones past them
   +// went in twice. The frame check now says where the page is, and a page that
   +// has moved and is as tall as it was goes back, and the slice settles again,
   +// once (KAN-592).
    
   +test('puts a page that scrolls itself while a slice settles back before it shoots that slice', async () => {
   +  const body = el(3000, 713);
   +  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  // The page scrolls itself 200 px down while the second slice settles. Its height doesn't change.
   +  let scrolled = false;
   +  const timer = ctx.setTimeout;
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && !scrolled) { scrolled = true; body.scrollTop += 200; } return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'shot the second slice where the page scrolled itself to');
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
   +  assert.strictEqual(canvases[canvases.length - 1].height, 3000, 'cut the image short');
   +});
   +
   +test('shoots a slice where the page is when it scrolls itself again after it is put back', async () => {
   +  // A page that scrolls itself 200 px down each time the second slice
   +  // settles. It stops after five, so a stitch that puts it back every time
   +  // still ends.
   +  const body = el(3000, 713);
   +  const { ctx, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  let scrolls = 0;
   +  const timer = ctx.setTimeout;
   +  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return timer(fn, ms); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'put the page back more than once');
   +  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 7, 'did not put the page back once');
   +});
   +
    // --- pages that turn scroll anchoring off ----------------------------------
    // The stitch sees content above the screen change height by how far scroll
    // anchoring moves the offset (KAN-515). A page with `overflow-anchor: none`
   ```

**Choices:**

- **Put the page back rather than draw the slice where it was shot.** Drawn where it was shot, the slice would leave a gap. The slice before it ends where this one was meant to start, so the rows between would never be shot.
- **The frame check says where the page is.**
  - It is the last page script before every shot, and it answers from the frame the shot finds.
  - So there is no new page pass, and the call-order tests are untouched.
- **The page's height tells the page's own scroll apart from scroll anchoring, as in KAN-576.** Content above that changes height changes the page's height by as much as anchoring moves the offset. Two cases follow:
  - **Height changed as well:** a page that scrolls itself while its height changes in the same settle isn't put back. KAN-590 describes the same case between slices.
  - **KAN-591's page:** anchoring's move, with the height unchanged, is now taken for the page's own scroll while the second slice settles, so the page is put back there.
    - The image is still 3300 tall with 300 rows in twice. The rows in twice are now yellow's (600 and 900) rather than red's (1300 and 1600).
    - KAN-591 stays open.
- **Once per slice**, like the second shot for fixed and sticky elements (KAN-525).
  - A page that scrolls itself on every settle, such as one that snaps to sections, would otherwise never be shot. The second time, it is shot where it is, as today.
  - Putting the page back uses the slice's second shot. So a fixed element that turns up after that slice's last hide is shot in, as happens today on a slice's second shot.
- **The first slice too.** A page that scrolls itself while the first slice settles is put back the same way.
  - The `i === 0` in the break (`:556`) only stops a second shot for fixed and sticky elements.
  - Putting the page back goes round again before the loop reaches that break.
- **An exact comparison.** Chrome rounds an instant scroll to the device's pixels as it scrolls, and doesn't move it afterwards.
  - At device scale factors 1.25, 1.5, 1.75 and 2, `scrollTop` read straight after scrolls to 713, 1426, 2139, 1234.5 and past the end was the same two frames and 300 ms later. For example, 713 read 712.8 both times at 1.25.
  - So a page that hasn't moved answers the frame check with `reached` exactly.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 416 tests and 414 pass. The two new tests fail:
   - "puts a page that scrolls itself while a slice settles back before it shoots that slice", with `captureAt` at `[0, 913, 1426, 2139, 2287]`;
   - "shoots a slice where the page is when it scrolls itself again after it is put back", with "did not put the page back once" (6 scrolls, not 7).
2. Apply the `background.js` diff. → verify: `npm test` passes all 416.
3. In real Chrome, run `node /tmp/vs387-chrome/run-576.js --ext /Users/john/dev/viewshot --page <page>` for these pages: `settlescroll`, `selfscroll`, `still`, `grow`, `grow-noanchor`, `shrink-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline`, `grow-compensate`, `selfscroll-grow` and `move-up`. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`. If a run saves no file, or saves something other than a PNG, run it again. → verify:
   - On `settlescroll`:
     - the page's offsets are 713, 913, 713, 1426, 2139, 2287;
     - yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image.
   - All twelve PNGs have the md5s listed under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan592-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 414 |
| `HEAD` + the `background.js` diff only | passes 414 |
| `HEAD` + the test diff only | 414 of 416 pass. The two new tests fail: `captureAt` `[0, 913, 1426, 2139, 2287]`, and 6 scrolls, not 7 |
| `HEAD` + both diffs | passes 416 |
| both diffs, without `shot === 1` | "shoots a slice where the page is when it scrolls itself again after it is put back" fails, with `captureAt` `[0, 713, 1426, 2139, 2287]`: the page was put back after each of its five scrolls |
| both diffs, without the height check | KAN-515's grow and shrink tests fail, with `captureAt` `[0, 713, 1426, 2139, 2587]` and `[0, 713, 1426, 1987]`: anchoring's move was put back |

**Chrome:** see the table and notes under "What the repo does now".
- **PNG md5s with the change:**
  - `c5eebb48c46485161d24873e68c29c93`: every "in place" run, `settlescroll` among them.
  - `9f3d4fa5468292b823f7555248f646c6`: `shrink-noanchor`.
  - `f891b0521729f45f95db8d3006ee90e0`: `grow-compensate`.
  - `cd5c1376da0a509ab24822a03dfc47c6`: `selfscroll-grow`.
  - `c372eb39610318deb9d5fd17fa7f2d05`: `move-up`.
- **PNG md5s on `HEAD`, where they differ:**
  - `7e17f1d7d4654b59b77b509ad16aa3b7`: `settlescroll`.
  - `be59a16b037d48efe0f80778098a40a7`: `move-up`.
- **Runs that saved no file:** the first run of `settlescroll` with the change. It saved a file when run again.

**Scroll offsets at fractional device scale factors:** `/tmp/vs387-chrome/drift-592.js <dsf>`, headless, on PageG `still`, for 1.25, 1.5, 1.75 and 2. At each one, `scrollTop` read straight after an instant scroll equals `scrollTop` read two frames and 300 ms later.

## Open questions

None.
