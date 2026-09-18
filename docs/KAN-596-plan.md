# KAN-596: Full page stitch misplaces a slice when the page scrolls itself again after the capture puts it back

Ticket: https://prattsolutions.atlassian.net/browse/KAN-596 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-592, is Done.

## What the repo does now

Line numbers are from `98773a9` (KAN-592's commit, the ticket's "working tree"), with a clean working tree.

- **A page that moved while a slice settled is put back, and the slice settles again.**
  - Each round of the shot loop (`background.js:525-574`) starts with the 500 ms settle (`:526`). Then come the fixed and sticky passes (`:530-533`) and the frame check (`:542-543`).
  - Suppose the frame check finds the page away from where the slice's scroll left it (`reached`), and as tall as it was. Then it is put back with `scrollPageTo(tab, reached)` and `continue` (`:550-553`), which goes round to the settle at `:526` again.
- **Once per slice.** The page is put back only on the first round (`shot === 1`).
  - On the second round, the slice is shot wherever the page is (`:554`).
  - It is drawn at `actual`, where the scroll left it (`:502`; the draws are at `:619-629` and `:631-641`).
- **The second settle is when the page scrolls itself again.** A page that moved during the first settle gets another 500 ms after it is put back.
- **Tests:** `npm test` passes 416.
  - The KAN-592 section (`tests/fullpage.test.js:405-438`) has two tests.
  - The second, "shoots a slice where the page is when it scrolls itself again after it is put back" (`:426-438`), pins the ticket's `captureAt`, `[0, 913, 1426, 2139, 2287]`.

**The ticket's harness case, reproduced.** The page is `load()` with a 3000 px body scroller in a 713 px viewport at dpr 1. It scrolls itself 200 px down each time the second slice settles, five times at most, and its height doesn't change. The rows were read with `/tmp/kan592-plan/probe-followups.js`, page D.

| | `captureAt` | draws | image |
|---|---|---|---|
| `HEAD` | 0, 913, 1426, 2139, 2287 | 0, 713, 1426, 2139, 2287 | 3000 px |
| With the change | 0, 713, 1426, 2139, 2287 | 0, 713, 1426, 2139, 2287 | 3000 px |

**Reproduced in Chrome 153.0.8010.48**, as the ticket says.

- **The script:** `/tmp/vs387-chrome/run-576.js --page settlescroll-again`.
- **The run:** headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **Reading the PNGs:** `/tmp/vs387-chrome/bands-515.py` for where the bands are, and `/tmp/vs387-chrome/clear-596.py` for rows with nothing drawn in them.

| | Page offsets | Saved PNG |
|---|---|---|
| `HEAD` | 713, 913, 713, 913, 1426, 2139, 2287 | red 1100, green at 1300 and at 1500, blue 2500; 3000 tall |
| With the change (three runs, all the same) | 713, 913, 713, 1426, 1626, 1426, 2139, 2287 | in place, with no rows blank; byte-identical to `still`'s |

- **With the change, the second slice is shot straight after it is put back.** That shot comes before the page's 200 ms timer fires.
- **The timer then fires after the third slice's scroll.** The page goes 1426 → 1626 while the third slice settles, and KAN-592's put-back brings it back to 1426. That slice is shot at once too.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan596-plan/tree`.

**The rule:**
- A slice that is put back is shot without settling again.
- The fixed and sticky passes and the frame check still run before that shot.
- The rest is as KAN-592 left it: once per slice, on the first slice too, and only for a page as tall as it was.

1. **`background.js`, the shot loop (`:524-553`):**
   - `let url;` (`:524`) becomes `let url, back = false;`.
   - The settle (`:526`) runs only `if (!back)`.
   - The put-back (`:550-553`) sets `back = true` before its `continue`.
   - The comment above it (`:544-549`) now says the slice is shot without settling again, and why.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -521,9 +521,9 @@ async function captureFullPage(tab, format, popupId) {
            await hideStuckSticky(tab);
          }
          // A slice can be shot twice: see the fixed hide after the shot (KAN-525).
   -      let url;
   +      let url, back = false;
          for (let shot = 1; ; shot++) {
   -        await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   +        if (!back) await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
            // And the fixed ones the page put in, or pinned, while it settled: the
            // hide above ran before they were there (KAN-522). It goes before the
            // frame check, so the frame the shot waits for has this hide in it.
   @@ -544,11 +544,14 @@ async function captureFullPage(tab, format, popupId) {
            // A page that scrolled itself while the slice settled, and is as tall
            // as it was, would be shot where it scrolled to and drawn where the
            // slice's scroll left it: the rows between were left out, and the ones
   -        // past them went in twice (KAN-592). It goes back, and the slice settles
   -        // and runs the passes that follow the settle again before it is shot.
   -        // Once: a page that scrolls itself again is shot where it is.
   +        // past them went in twice (KAN-592). It goes back, and the slice runs
   +        // the passes that follow the settle again and is shot, without settling
   +        // again: in that time, a page that scrolls itself after every scroll did
   +        // it again, and was shot where it scrolled to (KAN-596). Once: a page
   +        // that scrolls itself again before that is shot where it is.
            if (shot === 1 && frame.top !== reached && frame.total === total) {
              await scrollPageTo(tab, reached);
   +          back = true;
              continue;
            }
            url = await captureVisible(tab.windowId);
   ```

2. **`tests/fullpage.test.js`:**
   - **The KAN-592 section comment (`:406-411`)** now says the slice is shot without settling again (KAN-596).
   - **The test at `:426-438`** is on the ticket's harness page.
     - It is renamed "shoots a slice it puts back before the page scrolls itself again".
     - It now expects the slice in place: `captureAt` `[0, 713, 1426, 2139, 2287]`.
     - Like the first KAN-592 test, it also checks the draws and the image's height.
     - It keeps the check that the page is put back once (7 scrolls).
   - **A new test after it:** "shoots a slice where the page is when it scrolls itself again before that shot".
     - Its page scrolls itself 200 px down each time the frame check asks it for a frame at 713, five times at most. So it moves again straight after it is put back, not in a settle.
     - The test checks that the page is put back once and shot where it is.
     - It keeps "once per slice" under test. The changed test's page doesn't move a second time any more, so it no longer covers that.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -407,8 +407,9 @@ test('lines the slices up on a page that scrolls itself between them', async ()
    // had settled. A page that scrolled itself while the slice settled was shot
    // where it scrolled to: the rows between were left out, and the ones past them
    // went in twice. The frame check now says where the page is, and a page that
   -// has moved and is as tall as it was goes back, and the slice settles again,
   -// once (KAN-592).
   +// has moved and is as tall as it was goes back, once (KAN-592). It is shot
   +// without settling again: a page that scrolls itself on every settle did it
   +// again, and was shot where it scrolled to (KAN-596).
    
    test('puts a page that scrolls itself while a slice settles back before it shoots that slice', async () => {
      const body = el(3000, 713);
   @@ -423,16 +424,32 @@ test('puts a page that scrolls itself while a slice settles back before it shoot
      assert.strictEqual(canvases[canvases.length - 1].height, 3000, 'cut the image short');
    });
    
   -test('shoots a slice where the page is when it scrolls itself again after it is put back', async () => {
   +test('shoots a slice it puts back before the page scrolls itself again', async () => {
      // A page that scrolls itself 200 px down each time the second slice
      // settles. It stops after five, so a stitch that puts it back every time
      // still ends.
      const body = el(3000, 713);
   -  const { ctx, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  const { ctx, canvases, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
      let scrolls = 0;
      const timer = ctx.setTimeout;
      ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return timer(fn, ms); };
      await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'let the page settle again, and shot it where it scrolled itself to');
   +  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
   +  assert.strictEqual(canvases[canvases.length - 1].height, 3000, 'cut the image short');
   +  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 7, 'did not put the page back once');
   +});
   +
   +test('shoots a slice where the page is when it scrolls itself again before that shot', async () => {
   +  // A page that scrolls itself 200 px down each time it is asked for a frame
   +  // at 713, straight after it is put back too. It stops after five, so a
   +  // stitch that puts it back every time still ends.
   +  const body = el(3000, 713);
   +  const { ctx, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  let scrolls = 0;
   +  const frame = ctx.requestAnimationFrame;
   +  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return frame(cb); };
   +  await ctx.captureFullPage(TAB);
      assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'put the page back more than once');
      assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 7, 'did not put the page back once');
    });
   ```

**Choices:**

- **Skip the second settle rather than put the page back more times.**
  - The second settle is the time in which the page scrolls itself again.
  - A page that snaps to a section after every scroll would do the same after every put-back, however many there were, and each one would cost another 500 ms settle.
  - The ticket's page only ends up in place after it stops, on its sixth settle.
- **Skip the second settle rather than draw the slice where it was shot.**
  - KAN-592's plan turned that down because the rows between would never be shot.
  - Shot straight after it is put back, the ticket's page comes out whole, with no blank rows.
- **The passes still run after the put-back.**
  - The last passes ran at the offset the page scrolled itself to. `hideStuckSticky` works out which sticky elements are stuck again, at the offset the page is put back to.
  - The frame check still comes last, so the frame the shot finds has both the put-back and the hides in it.
- **Nothing else loses its settle.**
  - `back` is set only by the put-back, and it is reset for each slice.
  - A second shot for fixed and sticky elements (KAN-525) still settles first.
  - The put-back's shot is the slice's second, and the break at `:573` (`shot === 2`) ends the loop after it, as today.
- **What the shot no longer waits for.**
  - After a put-back, the shot waits only for the passes and the frame check, not for 500 ms.
  - Anything the page does in answer to that scroll, other than fixed and sticky elements, is shot as it is at that moment. A fade-in that runs again each time its rows come back on screen is one example.
  - The rows the put-back brings back came on screen with the slice's own scroll, at least 500 ms earlier. So anything that loads in as rows come on screen was asked for then.
  - A page that isn't put back settles as before.
- **A page that scrolls itself again before that shot is still shot where it is**, as today.
  - The new test pins this, with its page moving on each frame check.
  - Seen in Chrome with `settlescroll-now`. That page scrolls itself 200 px down in its own scroll event each time it lands on 713, five times at most.
  - `HEAD` and the change save the same PNG as `settlescroll-again` does on `HEAD`.
  - See Open questions.
- **Once per slice stays.** Without `shot === 1`, the new test fails: the page is put back after each of its five scrolls.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 417 tests and 416 pass. The one that fails is "shoots a slice it puts back before the page scrolls itself again", with `captureAt` at `[0, 913, 1426, 2139, 2287]`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 417.
3. In real Chrome, run `node /tmp/vs387-chrome/run-576.js --ext /Users/john/dev/viewshot --page <page>` for these pages: `settlescroll-again`, `settlescroll`, `move-up`, `still`, `selfscroll`, `grow`, `grow-noanchor`, `shrink-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline`, `grow-compensate`, `selfscroll-grow` and `settlescroll-grow`.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>`, and the `settlescroll-again` one with `python3 /tmp/vs387-chrome/clear-596.py <png>` too.
   - If a run saves no file, or saves something other than a PNG, run it again.

   → verify:
   - On `settlescroll-again`:
     - yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image;
     - `clear-596.py` finds no blank rows.
   - All fourteen PNGs have the md5s listed under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan596-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 416 |
| `HEAD` + the test diff only | 416 of 417 pass. "shoots a slice it puts back before the page scrolls itself again" fails, with `captureAt` `[0, 913, 1426, 2139, 2287]` |
| `HEAD` + the `background.js` diff only | 415 of 416 pass. The test the ticket names fails, with `captureAt` `[0, 713, 1426, 2139, 2287]` |
| `HEAD` + both diffs | passes 417 |
| both diffs, without `shot === 1` | "shoots a slice where the page is when it scrolls itself again before that shot" fails, with `captureAt` `[0, 713, 1426, 2139, 2287]`. With that check taken out, it fails on 11 scrolls, not 7 |

**Chrome:** every page was run on `HEAD` and on the change, with the setup under "What the repo does now".

- `settlescroll-now` comes from `/tmp/kan596-plan/run-596.js`, which is `run-576.js` with that one page added. Every other page comes from `run-576.js`.
- The last column says whether the change's PNG is byte-identical to `HEAD`'s.

| Page | PNG md5 on `HEAD` | Same with the change? |
|---|---|---|
| `settlescroll-again` | `7e17f1d7d4654b59b77b509ad16aa3b7` | No: `c5eebb48c46485161d24873e68c29c93`, in place (three runs of three) |
| `settlescroll-now` | `7e17f1d7d4654b59b77b509ad16aa3b7` | Yes |
| `settlescroll` | `c5eebb48c46485161d24873e68c29c93` | Yes |
| `still`, `selfscroll`, `grow`, `grow-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline` | `c5eebb48c46485161d24873e68c29c93` | Yes |
| `shrink-noanchor` | `9f3d4fa5468292b823f7555248f646c6` | Yes |
| `grow-compensate` | `f891b0521729f45f95db8d3006ee90e0` | Yes |
| `selfscroll-grow` (KAN-590) | `cd5c1376da0a509ab24822a03dfc47c6` | Yes |
| `move-up` (KAN-591) | `c372eb39610318deb9d5fd17fa7f2d05` | Yes |
| `settlescroll-grow` (KAN-597) | `a591d5ec418a228282a7b0ac4190b12d` | Yes |

**Runs that saved no file:** none.

## Open questions — settled

The plan left one question open. It is settled here, and it doesn't change the code shipped in `54b6fd9`.

1. **Should a slice be drawn where it was shot when the page scrolls itself again before the put-back's shot?** Not as part of KAN-596.
   - **What the ticket covers:** a page that scrolls itself again after it is put back. Its page, `settlescroll-again`, does that 200 ms after each time it lands on 713. `54b6fd9` lines that page up; see the Chrome runs above.
   - **Why this case is different:** the page scrolls itself again within a frame or two of being put back, before the frame check the shot waits for. So the slice is shot where the page scrolled to.
     - `settlescroll-now` shows this. It scrolls itself in its own scroll event each time it lands on 713.
     - `98773a9` and `54b6fd9` save the same PNG for it, with red at 1100 and green at 1300 and at 1500.
     - The new test pins it.
   - **Why the slice isn't drawn where it was shot:** the rows between the two offsets would then be blank, rather than left out with the rows past them drawn twice. The KAN-592 plan turned that down for the same reason: "Drawn where it was shot, the slice would leave a gap." This plan keeps to that.
   - **Follow-up:** KAN-598, filed from this question.

**Other follow-up:**
- **KAN-599**, filed from the choice above about what the shot no longer waits for. Content that fades in when the put-back brings its rows back on screen is shot part-way.

**This ticket blocks both.**
