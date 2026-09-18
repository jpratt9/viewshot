# KAN-599: Full page shoots a slice it puts back before content that fades in on that scroll has finished

Ticket: https://prattsolutions.atlassian.net/browse/KAN-599 (To Do, Task, labels `bug` and `viewshot`). Its one comment moves it to To Do: KAN-596, the only ticket blocking it, is Done.

## What the repo does now

Line numbers are from the working tree, `f34f5e2` with the uncommitted KAN-600 change in it. At `f34f5e2` every `background.js` line past 334 is four lower. KAN-600 doesn't touch the shot loop, and in `tests/fullpage.test.js` it only changes `:475` and adds a section after `:557`, so that file's line numbers hold either way.

- **A slice the capture puts back is shot without settling again.**
  - Each round of the shot loop (`background.js:529-581`) starts with the 500 ms settle (`:530`), then the fixed and sticky passes (`:534-537`), then the frame check (`:546`).
  - A page the frame check finds away from where the slice's scroll left it (`reached`), and as tall as it was, goes back with `scrollPageTo(tab, reached)` (`:556-560`, KAN-592). That sets `back` and `continue`s, and the round it lands in skips the settle (`:530`, KAN-596).
  - So between the put-back and the shot (`:561`) there are only the passes and the frame check.
- **Neither of those waits for what the put-back's scroll sets off.**
  - `reportFrame` waits two animation frames (`:435-443`). It is there so the frame the shot finds has the hides in it (KAN-525), not to give the page time.
  - `captureVisible`'s rate limit (`:190-206`; `CAPTURE_MIN_GAP_MS` is 550 ms, `:175`) counts from the previous slice's shot, and this slice's own 500 ms settle already sits between the two, so it adds little or nothing.
  - A fade that runs each time its rows come back on screen is therefore shot part-way. The "Choices" section of `docs/KAN-596-plan.md` names this ("What the shot no longer waits for").
- **Once per slice.** `shot === 1` (`:556`) allows a put-back only on the slice's first round, and the break at `:580` (`shot === 2`) ends the loop after the second, so a slice that was put back is never shot twice.
- **Tests:** `npm test` passes 418. The KAN-592/596 section (`tests/fullpage.test.js:405-455`) has three tests, two of which pin one put-back per slice as seven `scrollAndReport` calls (`:440`, `:454`). No test has a page with anything a put-back sets off.

**Reproduced in the test harness** by the new test under Change, run on a copy of the working tree with only the test diff applied: `fadedAt` is `[true, false, true, true, true]`. The slice that was put back is the one shot before the band finished. Its `captureAt` is `[0, 713, 1426, 2139, 2287]` either way: the rows are in place, and only what the put-back set off is caught part-way.

**Reproduced in Chrome 153.0.8010.48**, headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.

- **The script:** `/tmp/kan599-plan/run-599.js`, which is `/tmp/kan600-plan/run-600.js` with one more page.
  - `settlescroll-fade` is the ticket's page: `settlescroll` (PageG, anchoring on, nothing changes height, and it scrolls itself 200 px down 200 ms after its first scroll) with a 40 px magenta band at 750 that an IntersectionObserver fades in over 400 ms each time it comes on screen.
  - `settlescroll-again-fade` is the new page: `settlescroll-again` (it scrolls itself 200 px down 200 ms after **each** time it lands on 713, five times at most) with that same band.
- **Reading the PNGs:** `/tmp/vs387-chrome/bands-515.py` for where the bands are, `/tmp/vs387-chrome/clear-596.py` for rows with nothing drawn in them, and `/tmp/kan596-plan/fade-596.py` for the mean colour of the band's rows, 750-789.

| Page | The working tree | With the change |
|---|---|---|
| `settlescroll-fade` | offsets 713, 913, 713, 1426, 2139, 2287; bands in place, no blank rows, 3000 px tall; the band's rows average rgb (255, 245, 255) | the same offsets, and the same bands; the band's rows average (255, 0, 255) |
| `settlescroll-again-fade` | offsets 713, 913, 713, 1426, 1626, 1426, 2139, 2287; the same PNG as `settlescroll-fade`'s | offsets 713, 913, 713, 913, 713, 1426, 1626, 1426, 2139, 2287; that same PNG again, band still (255, 245, 255) |

The first row is the ticket, down to the offsets and the mean colour. The second is the page this change doesn't help; see Choices.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of the working tree outside the repo, in `/tmp/kan599-plan/both`.

**The rule:** a slice that is put back settles again before it is shot, so what that scroll set off has finished. A page that scrolled itself again in that settle is put back a second time and shot straight away, as KAN-596 has it. At most twice, and only before the slice's shot.

1. **`background.js`, the shot loop (`:528-580`):**
   - `let url, back = false;` (`:528`) becomes `let url, backs = 0;`: how many times this slice has been put back.
   - The settle (`:530`) runs `if (backs < 2)`: on the slice's first round and after its first put-back, but not after its second.
   - The put-back (`:556`) asks `!url && backs < 2` where it asked `shot === 1`, and counts itself with `backs++`. `url` is only set by a shot, so `!url` keeps put-backs to before the slice is shot, as `shot === 1` did.
   - The comment above it (`:548-555`) says why the slice settles again, and why the second put-back's shot doesn't.
   - The break (`:580`) ends the loop after any round past the first (`shot > 1`), not only after the second: with two put-backs the shot is on the slice's third round. On every round the loop has today the two are the same.

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -525,9 +525,9 @@ async function captureFullPage(tab, format, popupId) {
            await hideStuckSticky(tab);
          }
          // A slice can be shot twice: see the fixed hide after the shot (KAN-525).
   -      let url, back = false;
   +      let url, backs = 0;
          for (let shot = 1; ; shot++) {
   -        if (!back) await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
   +        if (backs < 2) await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
            // And the fixed ones the page put in, or pinned, while it settled: the
            // hide above ran before they were there (KAN-522). It goes before the
            // frame check, so the frame the shot waits for has this hide in it.
   @@ -548,14 +548,18 @@ async function captureFullPage(tab, format, popupId) {
            // A page that scrolled itself while the slice settled, and is as tall
            // as it was, would be shot where it scrolled to and drawn where the
            // slice's scroll left it: the rows between were left out, and the ones
   -        // past them went in twice (KAN-592). It goes back, and the slice runs
   -        // the passes that follow the settle again and is shot, without settling
   -        // again: in that time, a page that scrolls itself after every scroll did
   -        // it again, and was shot where it scrolled to (KAN-596). Once: a page
   -        // that scrolls itself again before that is shot where it is.
   -        if (shot === 1 && frame.top !== reached && frame.total === total) {
   +        // past them went in twice (KAN-592). It goes back, and the slice
   +        // settles and runs the passes again, so what the page does as the
   +        // put-back brings its rows back on screen, a fade-in for one, has
   +        // finished by the shot (KAN-599). A page that scrolled itself again in
   +        // that settle goes back once more, and is shot without settling: in
   +        // that time, a page that scrolls itself after every scroll did it
   +        // again, and was shot where it scrolled to (KAN-596). Twice, and only
   +        // before the slice is shot: a page that scrolls itself again before
   +        // that shot is shot where it is.
   +        if (!url && backs < 2 && frame.top !== reached && frame.total === total) {
              await scrollPageTo(tab, reached);
   -          back = true;
   +          backs++;
              continue;
            }
            url = await captureVisible(tab.windowId);
   @@ -577,7 +581,7 @@ async function captureFullPage(tab, format, popupId) {
              if (res.fixedReshot || res.stickyReshot) reshot = true;
              if (await hideStuckSticky(tab)) reshot = true;
            }
   -        if (i === 0 || shot === 2 || !reshot) break;
   +        if (i === 0 || shot > 1 || !reshot) break;
          }
          const bmp = await createImageBitmap(await (await fetch(url)).blob());
   ```

2. **`tests/fullpage.test.js`:**
   - **The KAN-592/596 section comment (`:407-411`)** says the slice now settles once more after it is put back, and that a page which moves again in that settle goes back a second time (KAN-599).
   - **The two tests that count `scrollAndReport` calls (`:440`, `:454`)** expect 8, not 7: the page is put back twice. `:453`'s message reads "more than twice". Neither test's `captureAt` changes, so both pages come out where they do today.
   - **A new test after `:455`:** "lets a slice it puts back settle before it shoots it".
     - Its page is the first KAN-592 test's: a 3000 px body scroller in a 713 px viewport at dpr 1 that scrolls itself 200 px down while the second slice settles, once.
     - It also carries the ticket's band: a fade that starts over on every scroll, and finishes only in a settle no scroll cuts short. `fadedAt` records, at each shot, whether it had finished.
     - It checks that every slice, the one that was put back too, was shot with the fade finished, and that the slices were shot where they are today.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -407,9 +407,12 @@ test('lines the slices up on a page that scrolls itself between them', async ()
    // had settled. A page that scrolled itself while the slice settled was shot
    // where it scrolled to: the rows between were left out, and the ones past them
    // went in twice. The frame check now says where the page is, and a page that
   -// has moved and is as tall as it was goes back, once (KAN-592). It is shot
   +// has moved and is as tall as it was goes back (KAN-592). It was then shot
    // without settling again: a page that scrolls itself on every settle did it
   -// again, and was shot where it scrolled to (KAN-596).
   +// again, and was shot where it scrolled to (KAN-596). That shot caught what
   +// the put-back set off, a fade-in for one, part-way, so the slice now settles
   +// once more first. A page that moves again in that settle goes back a second
   +// time, and is shot without settling (KAN-599).
    
    test('puts a page that scrolls itself while a slice settles back before it shoots that slice', async () => {
      const body = el(3000, 713);
   @@ -437,7 +440,7 @@ test('shoots a slice it puts back before the page scrolls itself again', async (
      assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'let the page settle again, and shot it where it scrolled itself to');
      assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
      assert.strictEqual(canvases[canvases.length - 1].height, 3000, 'cut the image short');
   -  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 7, 'did not put the page back once');
   +  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 8, 'did not put the page back twice');
    });
    
    test('shoots a slice where the page is when it scrolls itself again before that shot', async () => {
   @@ -450,8 +453,31 @@ test('shoots a slice where the page is when it scrolls itself again before that
      const frame = ctx.requestAnimationFrame;
      ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return frame(cb); };
      await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'put the page back more than once');
   -  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 7, 'did not put the page back once');
   +  assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'put the page back more than twice');
   +  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 8, 'did not put the page back twice');
   +});
   +
   +test('lets a slice it puts back settle before it shoots it', async () => {
   +  // A page that scrolls itself 200 px down while the second slice settles,
   +  // with a band that fades in each time a scroll brings it back on screen.
   +  // The fade only finishes in a settle that no scroll cuts short.
   +  const body = el(3000, 713);
   +  const { ctx, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
   +  let scrolled = false, seen = 0, faded = true;
   +  const fadedAt = []; // whether the band had finished fading in, at each shot
   +  const look = () => { if (body.scrollTop !== seen) { seen = body.scrollTop; faded = false; } };
   +  const timer = ctx.setTimeout, shoot = ctx.chrome.tabs.captureVisibleTab;
   +  ctx.setTimeout = (fn, ms) => {
   +    look();
   +    if (ms === 500) {
   +      if (body.scrollTop === 713 && !scrolled) { scrolled = true; body.scrollTop += 200; look(); } else faded = true;
   +    }
   +    return timer(fn, ms);
   +  };
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { look(); fadedAt.push(faded); return shoot(...a); };
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'shot the second slice where the page scrolled itself to');
   +  assert.deepStrictEqual(fadedAt, [true, true, true, true, true], 'shot the slice it put back before the band faded in');
    });
    
    // --- pages that turn scroll anchoring off ----------------------------------
   ```

**Choices:**

- **The settle the slice already has, rather than a wait of its own.** The other way is to ask the page what it is animating, with `document.getAnimations()` after the put-back, and wait for that.
  - It covers only what the browser animates: not a script-driven fade, and not an image that decodes as it comes on screen.
  - It needs a rule for animations that never end, a spinner for one.
  - The page can scroll itself during that wait exactly as it can during a settle, so it needs the second put-back anyway.
  - The 500 ms settle is what every other slice already waits, for the same reason, so there is nothing new to get right.
- **A second put-back keeps KAN-596 fixed.** The settle KAN-596 took out is the time in which its page scrolls itself again, and it still does: with the change, `settlescroll-again` goes 713 → 913 in the first settle, back to 713, 713 → 913 in the second, back to 713, and is shot there. Its PNG is byte-identical to the one the working tree saves.
- **Twice, not until the page stops.** KAN-596 turned down putting the page back "however many there were, and each one would cost another 500 ms settle": its page only ends up in place on its sixth settle. Two put-backs cost one settle more than today, and only on a slice whose page moved while it settled.
- **The second put-back's shot still waits for nothing.** A page that scrolls itself in every settle is shot straight after its second put-back, so what that scroll set off is caught part-way: the ticket's bug on a page the ticket doesn't cover.
  - `settlescroll-again-fade` is that page, and the change saves the same PNG for it as the working tree does, with the band at (255, 245, 255).
  - Each time that page lands on 713 it starts the fade and scrolls itself away 200 ms later, until its fifth time. Only putting it back until it stops, on its sixth settle, would get it shot with the fade finished, and that is what KAN-596 turned down. See Open questions.
- **KAN-598's page comes out as it does today.** `settlescroll-now` scrolls itself in its own scroll event each time it lands on 713, so it moves again straight after each put-back, before any frame check, and is still shot where it is: the same PNG, `7e17f1d7…`. It is put back twice now, which is what its test's `scrollAndReport` count says.
- **What the tests don't pin.** Take `!url` out, or put `shot === 2` back at the break, and `npm test` still passes all 419: no test has a reshot on a slice whose page moved, or a slice put back twice that then wants a reshot. `backs < 2` is pinned — without it, KAN-598's test fails, with `captureAt` `[0, 713, 1426, 2139, 2287]`, because the page is put back until it stops.
- **Nothing else loses or gains a settle.** `backs` is per slice, and only a put-back raises it. A second shot for fixed and sticky elements (KAN-525) still settles first, and a page that is never put back waits exactly as long as it does today.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 419 tests and 416 pass. The three that fail:
   - "shoots a slice it puts back before the page scrolls itself again" and "shoots a slice where the page is when it scrolls itself again before that shot", each with 7 `scrollAndReport` calls where 8 are expected;
   - "lets a slice it puts back settle before it shoots it", with `fadedAt` `[true, false, true, true, true]`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 419.
3. In real Chrome, run `node /tmp/kan599-plan/run-599.js --ext /Users/john/dev/viewshot --page <page>` for these pages: `settlescroll-fade`, `settlescroll-again-fade`, `settlescroll-again`, `settlescroll-now`, `settlescroll`, `settlescroll-grow`, `still`, `selfscroll`, `grow`, `grow-noanchor`, `shrink-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline`, `grow-compensate`, `selfscroll-grow`, `move-up`, `snap` and `snap-1000`.
   - Read each saved PNG with `python3 /tmp/vs387-chrome/bands-515.py <png>` and `python3 /tmp/vs387-chrome/clear-596.py <png>`, and the two fade pages' with `python3 /tmp/kan596-plan/fade-596.py <png>` too.
   - If a run saves no file, or saves something other than a PNG, run it again.

   → verify:
   - On `settlescroll-fade`:
     - the page's offsets are 713, 913, 713, 1426, 2139, 2287;
     - yellow, red, green and blue each show once, at 600, 1300, 1500 and 2500, in a 3000 px image, with no blank rows;
     - the band's rows, 750-789, average rgb (255, 0, 255);
     - the md5 is `6d5ddfe0e5a71e4540d4d62791d44f4e`.
   - On `settlescroll-again`: in place, with no blank rows, md5 `c5eebb48c46485161d24873e68c29c93`.
   - Every other page has the md5 listed for it under "Checked while planning".

## Checked while planning

**Tests:** run on copies of the working tree (`rsync`, without `.git`) in `/tmp/kan599-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| the working tree | passes 418 |
| + the test diff only | 416 of 419 pass: the three step 1 names |
| + the `background.js` diff only | 416 of 418 pass. The two tests that count `scrollAndReport` calls fail, with 8 where they expect 7 |
| + both diffs | passes 419 |
| both diffs, without `backs < 2` in the put-back | "shoots a slice where the page is when it scrolls itself again before that shot" fails, with `captureAt` `[0, 713, 1426, 2139, 2287]` |
| both diffs, without `!url` | passes 419 |
| both diffs, with `shot === 2` back at the break | passes 419 |

**Chrome:** every page in step 3 but `snap` and `snap-1000` was run on the working tree and on the change, one run each, with `/tmp/kan599-plan/batch.sh`. The batch stopped before those two. Their md5 on the working tree is the one KAN-600's step 3 recorded on this tree, and they were run with the change in step 3 (see "Added when shipping"). The last column says whether the change's PNG is byte-identical to the working tree's.

| Page | PNG md5 on the working tree | Same with the change? |
|---|---|---|
| `settlescroll-fade` | `c6537e873a2e77d35b0e345fce0575a2` | No: `6d5ddfe0e5a71e4540d4d62791d44f4e`, with the band at (255, 0, 255) |
| `settlescroll-again-fade` | `c6537e873a2e77d35b0e345fce0575a2` | Yes, band and all |
| `settlescroll-again`, `settlescroll`, `still`, `selfscroll`, `grow`, `grow-noanchor`, `grow-noanchor-important`, `grow-noanchor-important-layer`, `grow-noanchor-important-inline`, `snap`, `snap-1000` | `c5eebb48c46485161d24873e68c29c93` | Yes |
| `settlescroll-now` (KAN-598) | `7e17f1d7d4654b59b77b509ad16aa3b7` | Yes |
| `settlescroll-grow` (KAN-597) | `a591d5ec418a228282a7b0ac4190b12d` | Yes |
| `shrink-noanchor` | `9f3d4fa5468292b823f7555248f646c6` | Yes |
| `grow-compensate` (KAN-580) | `f891b0521729f45f95db8d3006ee90e0` | Yes |
| `selfscroll-grow` (KAN-590) | `cd5c1376da0a509ab24822a03dfc47c6` | Yes |
| `move-up` (KAN-591) | `c372eb39610318deb9d5fd17fa7f2d05` | Yes |

- **Offsets that change with it,** all of them a second put-back: `settlescroll-again` 713, 913, 713, 913, 713, 1426, 1626, 1426, 2139, 2287; `settlescroll-again-fade` the same; `settlescroll-now` 713, 913, 713, 913, 713, 913, 1426, 2139, 2287. Every other page's offsets are the same as on the working tree.
- **After the capture,** every run left the page back at 0, where it started.
- **Runs that saved no file:** none.

## Open questions — settled

The plan left two questions open. Both are settled here, and neither changes the code shipped in `322887a`.

1. **Should a page that scrolls itself in every settle have what its put-back sets off waited for too?** Not as part of KAN-599.
   - **What the ticket covers:** a page that scrolls itself once while a slice settles, `settlescroll-fade`. `322887a` shoots it with the band's fade finished; see "Added when shipping".
   - **Why this case is different:** the page scrolls itself again in the settle after the put-back. So it is put back a second time and shot straight away, as KAN-596 has it, and its fade is still caught part-way. `settlescroll-again-fade` saves the same PNG with the change as without.
   - **Why it isn't covered here:** the only way the change has to get that page shot with the fade finished is to put it back until it stops, with a settle each time, and KAN-596 turned that down. Waiting on something other than a settle is the other way the first Choice weighs. It would need its own rule for what to wait for.
   - **Follow-up:** KAN-604, filed from this question.
2. **Should this change also pin `!url` and `shot > 1` with tests?** Yes, and it does.
   - `322887a` adds a test for each. Each one fails when its piece is taken out; see "Added when shipping".
   - The `!url` test pins a second shot for a fixed element being taken where the page scrolled to. That is KAN-605, pinned the way KAN-596's test pins KAN-598, so KAN-605's fix changes what that test expects.
   - **Follow-up:** KAN-608, filed from this question, is done by those two tests and is closed.

**This ticket blocks KAN-604 and KAN-605.**

## Added when shipping

- **Steps 1 and 2 on this folder:** as the plan says. With the test diff alone, 416 of 419 pass, and the three that fail are the ones step 1 names, with the same values. With both diffs, `npm test` passes all 419, and the change is byte-identical to the diffs above.
- **Two more tests** in `tests/fullpage.test.js`, after the three in "Change". They pin the two pieces "Choices" says no test pinned:
  - "shoots a slice again where the page is when it scrolls itself while that second shot settles" pins `!url`. A banner turns up after the second slice's last fixed hide (as in the KAN-525 tests), and the page scrolls itself 200 px down while the second shot settles. `captureAt` is `[0, 713, 913, 1426, 2139, 2287]`: the page isn't put back after the slice was shot, which is KAN-605. Without `!url`, it is `[0, 713, 713, 1426, 2139, 2287]`.
  - "shoots a slice it put back twice only once, even when a fixed element turns up after that shot" pins `shot > 1`. With `shot === 2` back at the break, the slice is shot a second time on a fourth round, without a settle: `captureAt` is `[0, 713, 713, 1426, 2139, 2287]` where it should be `[0, 713, 1426, 2139, 2287]`.
  - With them, `npm test` passes all 421.
- **Step 3, run on this folder:** every page has the md5 listed for it under "Checked while planning".
  - `settlescroll-fade`: offsets 713, 913, 713, 1426, 2139, 2287; the bands in place, with no blank rows; the band's rows average (255, 0, 255); `6d5ddfe0e5a71e4540d4d62791d44f4e`.
  - `settlescroll-again`: in place, with no blank rows; `c5eebb48c46485161d24873e68c29c93`.
  - `snap` and `snap-1000`: offsets 713, 1426, 2139, 2287, in place; `c5eebb48c46485161d24873e68c29c93`.
  - `settlescroll`'s first run saved no file. It saved one when run again.
- **Filed while shipping:**
  - KAN-604, open question 1's page: a page that scrolls itself in the settle after its put-back is shot part-way after the second put-back.
  - KAN-608, open question 2: no test pins `!url` or `shot > 1`. The two tests above now pin both.
  - KAN-605: a slice shot again for a fixed element (KAN-525) isn't put back when the page scrolls itself while that shot settles. `!url` keeps this as it was; the working tree before this change does the same.
