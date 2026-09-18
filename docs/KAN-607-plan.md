# KAN-607: Full page stitch leaves a blank band on a snapping page that still holds the __vsAnchor rule a capture from before KAN-600 left in it

Ticket: https://prattsolutions.atlassian.net/browse/KAN-607 (To Do, Task, labels `bug` and `viewshot`, no comments, no links).

## What the repo does now

Line numbers are from `0fba784`, with a clean working tree.

- **`measurePage` only writes the rule into a page that doesn't have one yet** (`background.js:339-344`).
  - It puts `<style id="__vsAnchor">` with `@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}` first in `<head>`, but only when `document.getElementById('__vsAnchor')` finds nothing.
  - If the element is already there, it is used as it is, whatever its text says.
- **The cleanup scroll takes the element out** (`scrollAndReport` with `cleanup`, `background.js:400-405`). A capture that died before its cleanup scroll leaves the element in the page, and it stays there until the next capture on that page finishes.
- **A rule left by a capture from before KAN-600** (`c437896`) holds `@layer{*{overflow-anchor:auto!important}}`.
  - That text doesn't turn snapping off. The next capture turns anchoring on but leaves snapping on, so a page that snaps lands the capture's scrolls on its snap points, as it did before KAN-600.
  - The "Choices" section of `docs/KAN-600-plan.md` names this (`:150`).
- **Tests:** `npm test` passes 421.
  - "uses the anchoring rule a capture that died left behind, and takes it out" (`tests/fullpage.test.js:559-569`) puts exactly that pre-KAN-600 text in the page.
  - It checks that no second rule goes in and that the rule comes out. It doesn't check the text the slices are shot with.

**Reproduced in the test harness** with `/tmp/kan599-plan/probe-issues.js` (its `stale` and `control` probes), on copies of `HEAD`.
- The page is KAN-600's snapping test page: a 3000 px body scroller in a 713 px viewport at dpr 1. Each scroll snaps to the nearest snap point (every 500 px) unless the rule's text has `scroll-snap-type:none!important`.
- `stale` puts a `__vsAnchor` holding the pre-KAN-600 text in the page before the capture. `control` doesn't.

| `__vsAnchor` before the capture | Tree | `captureAt` and draws | image | rows no slice covers |
|---|---|---|---|---|
| none | `HEAD` | 0, 713, 1426, 2139, 2287 | 3000 px | none |
| the rule from before KAN-600 | `HEAD` | 0, 500, 1500, 2000, 2287 | 3000 px | 1213-1499 |
| the rule from before KAN-600 | with the change | 0, 713, 1426, 2139, 2287 | 3000 px | none |

In every run, the capture took `__vsAnchor` out when it finished.

**Reproduced in Chrome 153.0.8010.48**, headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/kan607-plan/run-607.js`. It is `/tmp/kan599-plan/run-issues.js`, changed to load `/tmp/kan607-plan/cdp.js`.
  - `run-issues.js` and the scripts before it load `/tmp/vs387-chrome/cdp.js`, and `/tmp/vs387-chrome` is no longer on this machine.
  - `/tmp/kan607-plan/cdp.js` gives those scripts the `launch(udd)` they expect. It uses `/tmp/kan398-chrome/cdp.js`'s pipe client (copied to `/tmp/kan607-plan/pipe.js`) and a 1280×800 headless window.
  - On `HEAD`, `still` saves `c5eebb48c46485161d24873e68c29c93` with it: the same PNG as in the earlier plans.
- **The page:** `snap-stale` is the ticket's page: `snap` with `<style id="__vsAnchor">@layer{*{overflow-anchor:auto!important}}</style>` already in `<head>`.
- **Reading the PNGs:** `/tmp/kan607-plan/run.sh <ext dir> <page> <label>` runs one capture and prints the page's offsets, the PNG's md5 and its size.
  - `bands-515.py` and `clear-596.py` went with `/tmp/vs387-chrome`.
  - So a PNG counts as in place when its md5 matches `still`'s.

| Page | `HEAD` | With the change |
|---|---|---|
| `snap-stale` | offsets 500, 1500, 2000, 2287; md5 `19fabe3feda26c1be453dc73f0890fba`, the ticket's PNG | offsets 713, 1426, 2139, 2287; md5 `c5eebb48c46485161d24873e68c29c93`, byte-identical to `still`'s |
| `snap` | offsets 713, 1426, 2139, 2287; md5 `c5eebb48c46485161d24873e68c29c93` | the same |

After every run, the page was scrolled back to 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan607-plan/tree`. `git apply --check` takes both on the repo as it is.

**The rule:** if a `__vsAnchor` element is already in the page, it is kept, and `measurePage` writes the current rule's text into it before the capture scrolls.
- The capture then turns snapping off, whatever text a capture that died left behind.
- A page without the element gets a new one, put first in `<head>` as it is today, with the same text.

1. **`background.js`, `measurePage` (`:335-344`):**
   - The element is looked up once, into `style`. A new one is made and put in only when there isn't one.
   - `style.textContent` is then set either way.
   - A comment says why (KAN-607).

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -336,12 +336,15 @@ function measurePage() {
      // capture's scrolls on its snap points, not where the slices ask, and the
      // rows between two slices the snap points pulled apart were never shot
      // (KAN-600).
   -  if (!document.getElementById('__vsAnchor')) {
   -    const style = document.createElement('style');
   +  // A rule a capture that died left behind is kept, and gets this rule's text:
   +  // one left before KAN-600 doesn't turn snapping off (KAN-607).
   +  let style = document.getElementById('__vsAnchor');
   +  if (!style) {
   +    style = document.createElement('style');
        style.id = '__vsAnchor';
   -    style.textContent = '@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}';
        (document.head || document.documentElement).prepend(style);
      }
   +  style.textContent = '@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}';
      // A page's own `!important` in a style attribute outranks every style sheet
      // rule, so each element with one gets the capture's own inline
      // `auto !important`, and the cleanup scroll puts the page's back (KAN-583).
   ```

2. **`tests/fullpage.test.js`, the stale-rule test (`:559-569`):**
   - It records the rule's text at each shot, the way the anchoring test does (`:541-545`), and expects the current rule at all four shots.
   - Its name says so.
   - A comment says the text it puts in is the one from before KAN-600 (KAN-607).

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -556,15 +556,20 @@ test('takes the anchoring rule back out when a slice fails', async () => {
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   -test('uses the anchoring rule a capture that died left behind, and takes it out', async () => {
   +test("uses the anchoring rule a capture that died left behind, with this capture's text, and takes it out", async () => {
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
   +  // The rule's text from before KAN-600, which leaves scroll snapping on (KAN-607).
      const left = { id: '__vsAnchor', textContent: '@layer{*{overflow-anchor:auto!important}}', remove() { styles.delete(this.id); } };
      styles.set(left.id, left);
      const add = ctx.document.head.prepend;
      let added = 0;
      ctx.document.head.prepend = (s) => { added++; return add(s); };
   +  const shoot = ctx.chrome.tabs.captureVisibleTab;
   +  const rules = [];
   +  ctx.chrome.tabs.captureVisibleTab = async (...a) => { rules.push(styles.get('__vsAnchor')?.textContent); return shoot(...a); };
      await ctx.captureFullPage(TAB);
      assert.strictEqual(added, 0, 'put a second rule in');
   +  assert.deepStrictEqual(rules, Array(4).fill('@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}'), "shot a slice with the rule's old text");
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
   ```

**Choices:**

- **Rewrite the text of the element that's there, rather than take it out and put in a new one.**
  - I tried the other way in the harness, in `/tmp/kan607-plan/replace`: `document.getElementById('__vsAnchor')?.remove()` before the block, which then always runs.
  - It shoots with the right text too. But the existing test's "put a second rule in" check fails, because a new rule goes in where one was already there.
  - Keeping the element keeps that test as it is, and keeps the diff smallest.
- **Where the element sits:** a rule left behind stays where the capture that left it put it, first in `<head>` at that time. A page that has since put its own layer in front of it isn't what this ticket covers.
- **The text is set every time, not only when it differs.**
  - A new element and one left by a capture from after KAN-600 get the same text they would have had anyway.
  - On a new element, the text now goes in just after the element goes into the page, not just before. Both happen in the same page script, before `measurePage` reads the page's height, so nothing is drawn in between.
- **Extend the stale-rule test rather than add a second snapping test.**
  - The harness has no CSS. KAN-600's test page (`:636-655`) snaps only while the rule's text lacks `scroll-snap-type:none!important`.
  - So checking the text at each shot is the same check, without a second copy of that page.
  - The ticket's snapping result itself is checked by the harness probe and in Chrome.
- **Not covered:** `scroll-snap-type` with `!important` in a style attribute, which is KAN-606.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 421 tests and 420 pass.
   - The one that fails is "uses the anchoring rule a capture that died left behind, with this capture's text, and takes it out".
   - Its failure message is "shot a slice with the rule's old text", with `@layer{*{overflow-anchor:auto!important}}` at all four shots.
2. Apply the `background.js` diff. → verify: `npm test` passes all 421.
3. In real Chrome, run `/tmp/kan607-plan/run.sh /Users/john/dev/viewshot <page> repo` for these pages: `snap-stale`, `snap`, `still`, `grow-noanchor-important-layer` and `grow-noanchor`. If a run prints `NO PNG`, run it again. → verify:
   - on `snap-stale`, `snap` and `still`, the offsets are 713, 1426, 2139, 2287, then 0;
   - on `grow-noanchor-important-layer` and `grow-noanchor`, the offsets are 713, 1013, 1726, 2439, 2587, then 0;
   - every PNG is 1280×3000, with md5 `c5eebb48c46485161d24873e68c29c93`.

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan607-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 421 |
| `HEAD` + the test diff only | 420 of 421 pass. The stale-rule test fails with the old text at all four shots |
| `HEAD` + the `background.js` diff only | passes 421 |
| `HEAD` + both diffs | passes 421 |
| `replace` (the alternative under "Choices") + the test diff | 420 of 421 pass. The stale-rule test fails on "put a second rule in" |

**Harness probe:** `node /tmp/kan599-plan/probe-issues.js <tree>` gave the table under "What the repo does now".

**Chrome:**
- **Pages run on `HEAD`:** `still`, `snap-stale` and `snap`.
  - The first `snap` run saved no PNG: the page reported no offsets, so the capture never started. The second run did.
- **Pages run with both diffs:** `snap-stale`, `snap`, `still`, `grow-noanchor-important-layer` and `grow-noanchor`. Each one saved a PNG the first time.
- **PNG md5s** (every PNG was 1280×3000):
  - `snap-stale` on `HEAD`: `19fabe3feda26c1be453dc73f0890fba`.
  - All the others: `c5eebb48c46485161d24873e68c29c93`.

## Open questions

None.
