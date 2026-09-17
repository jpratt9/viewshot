# KAN-218: Full page blanks sticky elements that start below the first screen

Ticket: https://prattsolutions.atlassian.net/browse/KAN-218 (To Do, Task, labels `bug` and `viewshot`, no comments, no blockers).

## What the repo does now

Line numbers are from `9e2356f`, with a clean working tree. The ticket's own refs (`:171`, `:194-212`) are from an older commit; the code they point at is `:234` and `:263-282` today.

- **The stitch** (`captureFullPage`, `background.js:210-259`): `measurePage` (`:172`) reports the page height and viewport, `positions` (`:218-220`) is one offset per screen, and the loop scrolls to each with `scrollPageTo` (`:202`) and draws the slice at the offset the page actually landed on.
- **The hiding** (`background.js:234`): at `i === 1` — the first slice after the top — it calls `setFixedHidden(tab, true)` once and sets `hid`. Nothing calls it again: everything it hid stays hidden for the rest of the capture, and `finally` restores it at `:246`.
- **What it hides** (`setFixedHidden`, `:263-282`): every element in the document whose computed `position` is `fixed` or `sticky`, with no test of where the element sits. It keeps `[el, el.style.visibility]` pairs in `window.__shotHidden` and puts them back on the restore call.
- **So the ticket's case:** a sticky table header, section heading or sidebar further down the page is `position: sticky` like a pinned header is, and it is hidden from slice 2 onward. It never appeared in slice 1, so it appears nowhere in the final image and leaves blank space.
- **Tests** (`tests/fullpage.test.js`, 267 lines): `npm test` passes 228 across the suite.
  - `load()` (`:42-103`) fakes the page: `document.querySelectorAll` answers a `fixed` array the test passes in, and `getComputedStyle` reports `'fixed'` for anything in it (`:65-66`).
  - One test uses it (`:249`), and only to check the **restore**: a header left hidden when a slice throws part-way.
  - **Nothing pins what gets hidden.** `grep -n "sticky" tests/*.js` returns nothing.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. The diffs below were applied and tested on a copy of the repo (see "Checked while planning").

The rule this takes: **`fixed` is hidden as it is today; a `sticky` element is hidden only if the first screen showed it.** A `fixed` element is pinned to the viewport wherever the page is, so every later slice would stitch it in again — that is the case the hiding was written for. A sticky element is only a repeat risk if it is one of the pinned ones at the top; the ones further down are what this ticket is about.

1. **`background.js`:** a marking pass at the top of the page, and a hide that spares whatever it didn't mark.

   ```diff
   @@ -229,6 +229,9 @@ async function captureFullPage(tab) {
          // Stop rather than stack the same viewport down the canvas.
          if (i > 0 && actual <= landed) break;
          landed = actual;
   +      // Which sticky elements this first screen shows, while the page is still
   +      // at the top: the ones further down have to be left alone below.
   +      if (i === 0 && positions.length > 1) await markStickyOnFirstScreen(tab);
          // Keep fixed/sticky elements (pinned headers, banners) on the FIRST slice
          // only; hide them on later slices so they aren't stitched in repeatedly.
          if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
   @@ -260,20 +263,48 @@ async function captureFullPage(tab) {

    // Temporarily hide position:fixed / position:sticky elements (the cause of
    // repeated headers/banners in scroll-stitch), then restore them afterward.
   +// A sticky element is only worth hiding if it is one of the pinned ones the
   +// first slice already shows. The rest - sticky table headers, section headings,
   +// sidebars further down - never appear in that slice, so hiding them blanked
   +// them out of every slice that should have shown them. Run at the top of the
   +// page, where a sticky element is still where the document puts it.
   +async function markStickyOnFirstScreen(tab) {
   +  await chrome.scripting.executeScript({
   +    target: { tabId: tab.id },
   +    func: () => {
   +      const list = [];
   +      for (const el of document.querySelectorAll('*')) {
   +        if (getComputedStyle(el).position !== 'sticky') continue;
   +        const r = el.getBoundingClientRect();
   +        if (r.bottom > 0 && r.top < window.innerHeight) list.push(el);
   +      }
   +      window.__shotSticky = list;
   +    },
   +  });
   +}
   +
    async function setFixedHidden(tab, hide) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (doHide) => {
          if (doHide) {
   +        // Only the sticky elements the first screen showed: window.__shotSticky
   +        // is what markStickyOnFirstScreen left behind. `fixed` is unconditional
   +        // - it is pinned to the viewport wherever the page is, so every later
   +        // slice would stitch it in again.
   +        const sticky = window.__shotSticky || [];
            const list = [];
            for (const el of document.querySelectorAll('*')) {
              const pos = getComputedStyle(el).position;
   -          if (pos === 'fixed' || pos === 'sticky') { list.push([el, el.style.visibility]); el.style.visibility = 'hidden'; }
   +          if (pos !== 'fixed' && pos !== 'sticky') continue;
   +          if (pos === 'sticky' && !sticky.includes(el)) continue;
   +          list.push([el, el.style.visibility]); el.style.visibility = 'hidden';
            }
            window.__shotHidden = list;
          } else if (window.__shotHidden) {
            for (const [el, v] of window.__shotHidden) el.style.visibility = v;
            window.__shotHidden = null;
   +        window.__shotSticky = null;
          }
        },
        args: [hide],
   ```

2. **`tests/fullpage.test.js`:** one line in the harness so a fake element can say it is sticky, and a new section with five tests.

   ```diff
   @@ -63,7 +63,7 @@ function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0,
        // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
        setTimeout: (fn, ms) => { if (ms !== captureTimeout) fn(); },
        document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
   -    getComputedStyle: (e) => ({ position: fixed.includes(e) ? 'fixed' : 'static' }),
   +    getComputedStyle: (e) => ({ position: fixed.includes(e) ? (e.pos || 'fixed') : 'static' }),
        window: {
   @@ -264,4 +264,56 @@ test('stops rather than stitch in a tab the user switched to', async () => {
        assert.strictEqual(body.scrollTop, 640, 'the stopped stitch left the page scrolled');
      }
    });
   +
   +// --- sticky elements further down the page ---------------------------------
   +// From the second slice on, every fixed or sticky element was hidden for the
   +// rest of the capture. That is right for a pinned header, which the first slice
   +// already shows, but a sticky table header, section heading or sidebar further
   +// down never appears in that slice: it was hidden in every slice that should
   +// have shown it, leaving blank space where it belongs.
   +
   +// Keeps what the capture did to the element's visibility, in order.
   +function positioned(pos, top, bottom) {
   +  const seen = [];
   +  return {
   +    pos, seen,
   +    getBoundingClientRect: () => ({ top, bottom }),
   +    style: { set visibility(v) { seen.push(v); }, get visibility() { return seen.length ? seen[seen.length - 1] : ''; } },
   +  };
   +}
   +
   +test('leaves a sticky element that starts below the first screen alone', async () => {
   +  const heading = positioned('sticky', 900, 960); // a sticky table header a screen down
   +  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [heading] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(heading.seen, [], 'blanked a sticky element the first slice never showed');
   +});
   +
   +test('still hides a sticky header the first screen shows', async () => {
   +  const header = positioned('sticky', 0, 60);
   +  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [header] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(header.seen, ['hidden', ''], 'a pinned sticky header was stitched into every slice');
   +});
   +
   +test('still hides a fixed element wherever it sits', async () => {
   +  const button = positioned('fixed', 700, 760); // a back-to-top button, pinned to the viewport
   +  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [button] });
   +  await ctx.captureFullPage(TAB);
   +  assert.deepStrictEqual(button.seen, ['hidden', ''], 'a fixed element was left to repeat down the stitch');
   +});
   +
   +test('runs no sticky pass on a page that fits one screen', async () => {
   +  const { ctx, scriptCalls } = load({ de: el(700, 700), body: el(700, 700), ih: 700 });
   +  await ctx.captureFullPage(TAB);
   +  // measurePage, the one scroll, and the scroll back: no marking, no hiding.
   +  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
   +});
   +
   +test('marks and hides once on a page that needs several slices', async () => {
   +  const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
   +  await ctx.captureFullPage(TAB);
   +  // the marking, the hiding, and the restore - one each, however many slices
   +  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 3, 'the marking or the hiding ran more than once');
   +});
   ```

Choices:

- **The decision is made at the top of the page, in its own pass.** A sticky element that is already stuck reports a rect at the top of the viewport, so "does it start below the first screen?" can only be read while the page is at `positions[0]`. The existing hide runs at `positions[1]`, which is too late to tell a stuck header from one in flow.
- **`fixed` keeps today's behaviour, hidden from the second slice on.** Leaving it to the same first-screen test would spare anything that only appears once the page scrolls — a back-to-top button, a sticky CTA bar — and those would then repeat down the whole stitch. The ticket doesn't ask for that, so it doesn't change.
- **The two scripts share state through `window.__shotSticky`,** the way the hide already shares `window.__shotHidden` and the scrollbar its `__shotHideScrollbar` element. executeScript serializes each function standalone, so they can't share a helper (the comment at `:170` already says so).
- **The marking only runs when there will be a second slice** (`positions.length > 1`). Without that, every one-screen full-page capture would pay for a script call whose result is never read; today such a page runs no hide at all.
- **A capture that dies between the mark and the restore leaves `window.__shotSticky` on the page.** `window.__shotHidden` already behaves that way, the next capture overwrites it, and the restore clears both.
- **The rect test is `bottom > 0 && top < innerHeight`** — anything the first screen shows any part of, which is the same "was it in this slice" question the stitch asks.
- **The tests drive `captureFullPage`,** not `setFixedHidden` directly: what matters is what the whole capture did to the element, and the existing fixed-header test (`:249`) is already written that way.
- **No README, manifest or version change.**

Checked while planning, on a copy of the tree outside this folder, with Node 24.9.0:

- **As it is now:** `npm test` passes 228.
- **Test change only:** 233 tests run, 231 pass. "leaves a sticky element that starts below the first screen alone" fails with "blanked a sticky element the first slice never showed", and "marks and hides once on a page that needs several slices" fails on the call count.
- **Both changes:** all 233 pass.
- **Both changes, with one piece left out** (each time, only the named tests fail):

  | Piece | Failing test | Message |
  |---|---|---|
  | The `pos === 'sticky' && !sticky.includes(el)` spare | "leaves a sticky element that starts below the first screen alone" | "blanked a sticky element the first slice never showed" |
  | The `markStickyOnFirstScreen` call at `i === 0` | "still hides a sticky header the first screen shows" (+ the call-count test) | "a pinned sticky header was stitched into every slice" |
  | The `positions.length > 1` guard | "runs no sticky pass on a page that fits one screen" | "ran the sticky passes on a page with one slice" |

- **Not checked in Chrome while planning.** Step 3 covers that.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 233 tests, 231 pass, and exactly the two tests named above fail with those messages.
2. Make the `background.js` change above.
   → verify: `npm test` passes all 233.
3. Check the change in Chrome 152, with the repo loaded unpacked, on an http page (PageA) built for this: white background, 3000 px tall, and three coloured blocks —
   - `#top`: `position: sticky; top: 0`, 60 px tall, `#22cc22` (green), first thing in the body, so the first screen shows it;
   - `#mid`: `position: sticky; top: 0`, 40 px tall, `#ff0000` (red), inside a container running from 800 px to 2600 px, so its natural place is about 1200 px down — below the first screen;
   - `#btn`: `position: fixed; right: 20px; bottom: 20px`, 80×40, `#0000ff` (blue).
   - **Setup:** the setup from step 3 of `docs/KAN-387-plan.md` — headless Chrome over a CDP pipe with `Extensions.loadUnpacked`, PageA as a tab target, the popup opened with `Extensions.triggerAction({ id, targetId })` after one warm-up, buttons pressed with `Runtime.evaluate` and `userGesture: true`, downloads to a temp dir with `Browser.setDownloadBehavior`. Format PNG, Name `{title}-{time}`.
   - **Reading the stitched PNG:** `ffmpeg -v error -i <file> -f rawvideo -pix_fmt rgb24 -` piped into a short python that walks the rows and prints, for each of the three colours, the row ranges that contain it.

   → verify each case:
   - **The ticket's case:** press Full page on PageA. In the saved PNG, red is **present** — before the change it appears nowhere. Note which row ranges it lands in: a sticky heading that stays stuck across slices can appear more than once (see "Open questions").
   - **The same page on the code as it is now** (a copy from `git archive HEAD`, loaded unpacked), for comparison: no red anywhere in the image.
   - **Both, for the elements that must not change:** green appears once, in a band at the top of the image, and blue appears once, inside the first screen's rows. If either repeats down the image, the `fixed` path or the first-screen test is wrong.
   - **A page with one screen** (the same page, 600 px tall): the capture still works and the page is left as it was — nothing hidden, nothing left hidden.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and this plan.

## Open questions

- **A spared sticky element that stays stuck will appear in more than one slice.** Once it is not hidden, it shows at its natural place in the slice that contains it, and again at the top of each later slice while it is still stuck inside its container. The ticket asks for it not to be blanked, and says nothing about repeats; this plan takes "shown more than once" over "never shown". Doing better would mean hiding each sticky element only for the slices where it is stuck, which needs its natural offset recorded at the top and a hide/restore pass per slice — a much bigger change than this one, and a slower capture. Step 3 records how many times red actually lands in the image, so the size of the trade is on paper before it ships.
