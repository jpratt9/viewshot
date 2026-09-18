# KAN-605: Full page stitch misplaces a slice it shoots again for a fixed element when the page scrolls itself while that shot settles

Ticket: https://prattsolutions.atlassian.net/browse/KAN-605 (To Do, Task, labels `bug` and `viewshot`). It is blocked by KAN-599, which is Done, and its one comment says it is unblocked. It blocks KAN-608, which is Done.

## What the repo does now

Line numbers are from `8aec9f6`, with a clean working tree.

- **A slice can be shot twice** (KAN-525). In the shot loop (`background.js:537-594`), the slice is shot (`:574`), and then the fixed and sticky passes run again (`:587-592`).
  - If they find a fixed or sticky element the page put in, or pinned, after the passes before the shot, they set `reshot`.
  - The loop then goes round again: it settles (`:539`), runs the passes (`:543-546`) and the frame check (`:555`), and shoots again.
  - The second shot is the one drawn (`url`, `:595`), at the slice's `actual` (`:515`), which is where the slice's scroll left the page.
- **The put-back only runs before the slice's first shot.** Its condition is `!url && backs < 2 && frame.top !== reached && frame.total === total` (`:569`).
  - `url` is only set by a shot. So once the first shot is taken, a page that scrolled itself while the second shot settled isn't put back.
  - That second shot is taken where the page scrolled to, and drawn where the slice's scroll left it.
- **A slice that was put back is never shot again.** The break (`:593`) ends the loop after any round past the first (`shot > 1`, KAN-599). So `backs` is 0 when a second shot's first round starts.
- **Tests:** `npm test` passes 423.
  - "shoots a slice again where the page is when it scrolls itself while that second shot settles" (`tests/fullpage.test.js:484-507`) pins the current behaviour:
    - `captureAt` is `[0, 713, 913, 1426, 2139, 2287]`, and the shots drawn are `[1, 3, 4, 5, 6]`;
    - the "Open questions — settled" section of `docs/KAN-599-plan.md` says so, and that without `!url` `captureAt` is `[0, 713, 713, 1426, 2139, 2287]` (`:250`, `:259`).
  - "shoots a slice it put back twice only once, even when a fixed element turns up after that shot" (`:509-526`) pins `shot > 1`.

**Reproduced in Chrome 153.0.8010.48**, as the ticket says. The run is headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/kan605-plan/run-605.js`, which is `/tmp/kan606-plan/run-606.js` unchanged. That is `/tmp/kan611-plan/run-611.js` plus reporting of inline `scroll-snap-type`, and it has the ticket's page.
- **Running it:** `/tmp/kan605-plan/run.sh <ext dir> <page> <label>` runs one capture. It prints:
  - the page's offsets and the PNG's md5;
  - the rows of each colour band down the middle column (`/tmp/kan611-plan/bands.py`);
  - on a fade page, the mean colour of the band's rows, 750-789 (`/tmp/kan596-plan/fade-596.py`).
- **The page:** `reshot-scroll` is PageG `still`. The run wraps the worker's `captureVisible`. Right after the second shot, the page puts in a `position: fixed` banner, and 200 ms later it scrolls itself 200 px down.

| Page | `HEAD` (`/tmp/kan605-plan/head`) | With the change (`/tmp/kan605-plan/tree`) |
|---|---|---|
| `reshot-scroll` | offsets 713, 913, 1426, 2139, 2287, then 0; 3000 px, with red at 1100, green at 1300 and at 1500, and blue at 2500; md5 `7e17f1d7d4654b59b77b509ad16aa3b7`, the ticket's PNG | offsets 713, 913, 713, 1426, 2139, 2287, then 0; 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500; md5 `c5eebb48c46485161d24873e68c29c93`, byte-identical to `still`'s |

- With the change, the second slice's second shot is taken at 713 after the page is put back from 913, and it is drawn at 713.
- The banner isn't in the image: fixed elements are hidden from the second slice on, and the first slice was shot before the banner existed.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`.
- Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan605-plan/tree`.
- `git apply --check` accepts both on the repo as it is.

**The rule:** the put-back runs before any shot of the slice, not only the first. A second shot for a fixed element goes back the same way when the page scrolled itself while it settled.
- It is still twice at most per slice: a slice that was put back before its first shot is never shot again (`shot > 1`), so a second shot's rounds start with `backs` at 0.

1. **`background.js`, the put-back (`:557-569`):**
   - `!url &&` comes out of the condition.
   - The comment drops "only before the slice is shot", and says why a second shot goes back too (KAN-605).

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -563,10 +563,12 @@ async function captureFullPage(tab, format, popupId) {
            // finished by the shot (KAN-599). A page that scrolled itself again in
            // that settle goes back once more, and is shot without settling: in
            // that time, a page that scrolls itself after every scroll did it
   -        // again, and was shot where it scrolled to (KAN-596). Twice, and only
   -        // before the slice is shot: a page that scrolls itself again before
   -        // that shot is shot where it is.
   -        if (!url && backs < 2 && frame.top !== reached && frame.total === total) {
   +        // again, and was shot where it scrolled to (KAN-596). Twice at most: a
   +        // page that scrolls itself again before that shot is shot where it is.
   +        // A second shot, for a fixed element that turned up after the first
   +        // (KAN-525), is drawn in the same place, so the page goes back before
   +        // that one too (KAN-605).
   +        if (backs < 2 && frame.top !== reached && frame.total === total) {
              await scrollPageTo(tab, reached);
              backs++;
              continue;
   ```

2. **`tests/fullpage.test.js`**
   - **The section's comment (`:406-416`):** a slice shot again for a fixed element goes back the same way before that second shot (KAN-605).
   - **The test that pinned this ticket (`:484-507`):**
     - It becomes "puts a page that scrolls itself while a slice's second shot settles back before that shot", with its comment to match.
     - The page and the harness are the same. `captureAt` is now `[0, 713, 713, 1426, 2139, 2287]`, and the shots drawn are still `[1, 3, 4, 5, 6]`.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -413,7 +413,9 @@ test('lines the slices up on a page that scrolls itself between them', async ()
    // again, and was shot where it scrolled to (KAN-596). That shot caught what
    // the put-back set off, a fade-in for one, part-way, so the slice now settles
    // once more first. A page that moves again in that settle goes back a second
   -// time, and is shot without settling (KAN-599).
   +// time, and is shot without settling (KAN-599). A slice shot again for a
   +// fixed element (KAN-525) goes back the same way before that second shot
   +// (KAN-605).
    
    test('puts a page that scrolls itself while a slice settles back before it shoots that slice', async () => {
      const body = el(3000, 713);
   @@ -481,11 +483,11 @@ test('lets a slice it puts back settle before it shoots it', async () => {
      assert.deepStrictEqual(fadedAt, [true, true, true, true, true], 'shot the slice it put back before the band faded in');
    });
    
   -test('shoots a slice again where the page is when it scrolls itself while that second shot settles', async () => {
   +test("puts a page that scrolls itself while a slice's second shot settles back before that shot", async () => {
      // A banner turns up after the second slice's last fixed hide, so that slice
      // is shot again (KAN-525), and the page scrolls itself 200 px down while
   -  // that second shot settles. A slice is only put back before it is shot, so
   -  // the second shot is taken where the page scrolled to (KAN-605).
   +  // that second shot settles. The second shot is the one drawn, where the
   +  // slice's scroll left the page, so the page goes back before it (KAN-605).
      const body = el(3000, 713);
      const banner = positioned('fixed', 663, 713);
      const light = []; // what the page has in it
   @@ -502,7 +504,7 @@ test('shoots a slice again where the page is when it scrolls itself while that s
      const get = ctx.fetch;
      ctx.fetch = (url) => { drawn.push(Number(url.split('#')[1])); return get(url); };
      await ctx.captureFullPage(TAB);
   -  assert.deepStrictEqual(captureAt, [0, 713, 913, 1426, 2139, 2287], 'put the page back after the slice was shot');
   +  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 2139, 2287], 'shot the slice again where the page scrolled itself to');
      assert.deepStrictEqual(drawn, [1, 3, 4, 5, 6]);
    });
    
   ```

**Choices:**

- **Put the page back, rather than draw the second shot where it was taken.** Drawn where the page scrolled to, the rows between the slice's scroll and that offset would be left out. This is the KAN-592 case, and KAN-592 put the page back for a first shot for the same reason.
- **The same put-back as a first shot, with the same count.** `backs` isn't reset for a second shot, because it is already 0 there. So a second shot can be put back twice, and the second of those is shot without settling, as KAN-596 and KAN-599 have it for a first shot.
- **What doesn't change:**
  - a slice's first shot, because `url` is unset until then;
  - every slice that isn't shot again, because the loop breaks after its first shot unless a fixed or sticky element turned up.
  - The six other pages under "Checked while planning" stitch byte-identically.
- **The test that pinned this ticket now pins the fix.** It is the ticket's harness case, and `docs/KAN-599-plan.md:259` gives this same `captureAt` for the tree without `!url`.
- **Not covered:**
  - a page that scrolls itself again straight after the put-back, before the shot (KAN-598), now for a second shot too;
  - a fade that a second put-back starts (KAN-604).
  - Both are their own tickets.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 423 tests and 422 pass. The one that fails is "puts a page that scrolls itself while a slice's second shot settles back before that shot", with `captureAt` at `[0, 713, 913, 1426, 2139, 2287]`.
2. Apply the `background.js` diff. → verify: `npm test` passes all 423.
3. In real Chrome, run `/tmp/kan605-plan/run.sh /Users/john/dev/viewshot <page> repo` for these pages: `reshot-scroll`, `still`, `settlescroll`, `settlescroll-again`, `settlescroll-now`, `settlescroll-fade` and `settlescroll-again-fade`. If a run prints `NO PNG`, run it again. → verify:
   - on `reshot-scroll`:
     - the offsets are 713, 913, 713, 1426, 2139, 2287, then 0;
     - the PNG is 3000 px, with yellow at 600, red at 1300, green only at 1500 and blue at 2500, md5 `c5eebb48c46485161d24873e68c29c93`;
   - every other page has the offsets and md5 listed for it under "Checked while planning".

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan605-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 423 |
| `HEAD` + the test diff only | 422 of 423 pass. The changed test fails as step 1 says |
| `HEAD` + the `background.js` diff only | 422 of 423 pass. The test as it is now fails with "put the page back after the slice was shot": `captureAt` is `[0, 713, 713, 1426, 2139, 2287]` |
| `HEAD` + both diffs | passes 423 |

**Chrome:** every page was run on `HEAD` and with both diffs.

| Page | `HEAD` | With the change |
|---|---|---|
| `reshot-scroll` | see the table under "What the repo does now" | the same |
| `still` | offsets 713, 1426, 2139, 2287, then 0; `c5eebb48c46485161d24873e68c29c93` | the same |
| `settlescroll` | offsets 713, 913, 713, 1426, 2139, 2287, then 0; `c5eebb48c46485161d24873e68c29c93` | the same |
| `settlescroll-again` | offsets 713, 913, 713, 913, 713, 1426, 1626, 1426, 2139, 2287, then 0; `c5eebb48c46485161d24873e68c29c93` | the same |
| `settlescroll-now` | offsets 713, 913, 713, 913, 713, 913, 1426, 2139, 2287, then 0; `7e17f1d7d4654b59b77b509ad16aa3b7` (KAN-598) | the same |
| `settlescroll-fade` | offsets 713, 913, 713, 1426, 2139, 2287, then 0; `6d5ddfe0e5a71e4540d4d62791d44f4e`, band (255, 0, 255) | the same |
| `settlescroll-again-fade` | offsets 713, 913, 713, 913, 713, 1426, 1626, 1426, 2139, 2287, then 0; `c6537e873a2e77d35b0e345fce0575a2`, band (255, 245, 255) (KAN-604) | the same |

- **Runs that saved no file:** the first two runs of `settlescroll-again` on `HEAD`. Each time, the page loaded but reported no scroll, so the capture never started. The third run saved a PNG.
- Every other run saved a PNG the first time.

## Open questions

None.
