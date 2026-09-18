# KAN-611: Full page stitch draws rows twice when a __vsAnchor rule a capture that died left behind sits after a page layer that turns anchoring off

Ticket: https://prattsolutions.atlassian.net/browse/KAN-611 (To Do, Task, labels `bug` and `viewshot`). It is blocked by KAN-607, which is Done, and its one comment says it is unblocked.

## What the repo does now

Line numbers are from `9a89dbe`, with a clean working tree.

- **`measurePage` only puts the rule first in `<head>` when it makes a new one** (`background.js:341-347`).
  - The `prepend` (`:345`) is inside `if (!style)`.
  - A `<style id="__vsAnchor">` that a capture that died left behind gets the current rule's text (KAN-607), but it stays where it is.
- **Where the rule sits decides whether it wins.** Its `!important` outranks a page's own `!important` in a layer only while its layer is declared first. That is why a new rule goes first in `<head>` (KAN-582).
- **A rule left behind can end up after the page's own layers** in two ways:
  - the page puts its own style sheets in front of it after the capture died;
  - a capture that died before KAN-582 (`463e505`) left it at the end of `<head>`, because that code put it in with `appendChild`. The "Choices" section of `docs/KAN-582-plan.md` names this (`:184`).
- **The cleanup scroll takes the element out** (`background.js:405`), so only the next capture on that page is affected.
- **Tests:** `npm test` passes 421.
  - "uses the anchoring rule a capture that died left behind, with this capture's text, and takes it out" (`tests/fullpage.test.js:559-574`) counts `head.prepend` calls and expects none (`:565-566`, `:571`).
  - So it pins a rule left behind staying where it is.

**Reproduced in Chrome 153.0.8010.48**, headless, with the tree loaded unpacked, PNG output, and a 1280×713 viewport at dpr 1.
- **The script:** `/tmp/kan611-plan/run-611.js`. It is `/tmp/kan607-plan/run-607b.js`, the ticket's script, changed to load `/tmp/kan611-plan/cdp.js`. `cdp.js` and `pipe.js` in `/tmp/kan611-plan` are `/tmp/kan607-plan`'s, pointed at this folder.
- **The pages:**
  - `layer-stale-after` is the ticket's page, `grow-noanchor-important-layer`. That is PageG with `@layer page { html, body { overflow-anchor: none !important } }`, and a grey block at 100 px that grows from 200 to 500 px on the page's first scroll.
  - Its `<head>` already holds a `<style id="__vsAnchor">` with the current rule, after the page's own `<style>`. That makes it the last element in `<head>`, where a capture from before KAN-582 left it.
  - `layer-stale-before` has that element before the page's `<style>`.
- **Reading the PNGs:** `/tmp/kan611-plan/run.sh <ext dir> <page> <label>` runs one capture. It prints the page's offsets, the PNG's md5, and the rows of each colour band down the middle column (`/tmp/kan611-plan/bands.py`).

| Page | `HEAD` | With the change |
|---|---|---|
| `layer-stale-after` | offsets 713, 1426, 2139, 2587; 3300 px, with yellow at 600 and at 900, red at 1600, green at 1800 and blue at 2800; md5 `c372eb39610318deb9d5fd17fa7f2d05`, the ticket's PNG | offsets 713, 1013, 1726, 2439, 2587; 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500; md5 `c5eebb48c46485161d24873e68c29c93`, byte-identical to `still`'s |
| `layer-stale-before` | in place (`c5eebb48…`), from the ticket's run | the same |

- After every run, the page was scrolled back to 0.
- The test harness has no CSS, so no layer can win in it. It can only show where the rule goes.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs were applied and tested on a copy of `HEAD` outside the repo, in `/tmp/kan611-plan/tree`. `git apply --check` takes both on the repo as it is.

**The rule:** every time, `measurePage` puts the rule first in `<head>`, or first in the root element when there is no `<head>`. That holds whether it made the element or found one a capture that died left behind. `prepend` on an element that's already in the page moves it, so the page still holds one rule.

1. **`background.js`, `measurePage` (`:339-347`):**
   - The `prepend` moves out of `if (!style)`, to just after it.
   - The comment says why (KAN-611).

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -337,13 +337,15 @@ function measurePage() {
      // rows between two slices the snap points pulled apart were never shot
      // (KAN-600).
      // A rule a capture that died left behind is kept, and gets this rule's text:
   -  // one left before KAN-600 doesn't turn snapping off (KAN-607).
   +  // one left before KAN-600 doesn't turn snapping off (KAN-607). It goes first
   +  // again too: the page may have put its own layers in front of it since, and
   +  // one left before KAN-582 sits at the end of <head> (KAN-611).
      let style = document.getElementById('__vsAnchor');
      if (!style) {
        style = document.createElement('style');
        style.id = '__vsAnchor';
   -    (document.head || document.documentElement).prepend(style);
      }
   +  (document.head || document.documentElement).prepend(style);
      style.textContent = '@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}';
      // A page's own `!important` in a style attribute outranks every style sheet
      // rule, so each element with one gets the capture's own inline
   ```

2. **`tests/fullpage.test.js`, the stale-rule test (`:559-574`):**
   - It records what goes through `head.prepend`, and expects exactly the rule left behind: moved first, and not a second rule. This replaces the count of `prepend` calls, which expected none.
   - Its name says so, and a comment gives the reason (KAN-611).

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -556,19 +556,21 @@ test('takes the anchoring rule back out when a slice fails', async () => {
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
    
   -test("uses the anchoring rule a capture that died left behind, with this capture's text, and takes it out", async () => {
   +test("moves the anchoring rule a capture that died left behind first in <head>, with this capture's text, and takes it out", async () => {
      const { ctx, styles } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
      // The rule's text from before KAN-600, which leaves scroll snapping on (KAN-607).
      const left = { id: '__vsAnchor', textContent: '@layer{*{overflow-anchor:auto!important}}', remove() { styles.delete(this.id); } };
      styles.set(left.id, left);
      const add = ctx.document.head.prepend;
   -  let added = 0;
   -  ctx.document.head.prepend = (s) => { added++; return add(s); };
   +  const put = [];
   +  ctx.document.head.prepend = (s) => { put.push(s); return add(s); };
      const shoot = ctx.chrome.tabs.captureVisibleTab;
      const rules = [];
      ctx.chrome.tabs.captureVisibleTab = async (...a) => { rules.push(styles.get('__vsAnchor')?.textContent); return shoot(...a); };
      await ctx.captureFullPage(TAB);
   -  assert.strictEqual(added, 0, 'put a second rule in');
   +  // The rule left behind, and not a second one, goes in front of any layer the
   +  // page has put before it since (KAN-611).
   +  assert.deepStrictEqual(put, [left], 'did not move the rule left behind first in <head>');
      assert.deepStrictEqual(rules, Array(4).fill('@layer{*{overflow-anchor:auto!important;scroll-snap-type:none!important}}'), "shot a slice with the rule's old text");
      assert.strictEqual(styles.size, 0, 'left the rule in the page');
    });
   ```

**Choices:**

- **Move the element that's there, rather than take it out and put in a new one.** Both put the rule first. Moving it keeps KAN-607's choice to keep the element, and the code change is one line moved.
- **Prepend every time, even when the rule is already first.** Checking first would add code, and putting the rule where it already is leaves the page's layers as they were.
- **The test checks where the rule goes, not the stitch.** The harness has no CSS, so no layer can win in it. The stitch itself is checked in Chrome, on `layer-stale-after`.
- **Not covered: a page that puts its own layer in front of the rule while it is being shot.** The rule is put first once, in `measurePage`, before the first scroll. The ticket doesn't ask for more.
- **No README, manifest or version change.**

## Steps

1. Apply the `tests/fullpage.test.js` diff. → verify: `npm test` runs 421 tests and 420 pass.
   - The one that fails is "moves the anchoring rule a capture that died left behind first in <head>, with this capture's text, and takes it out".
   - Its failure message is "did not move the rule left behind first in <head>", with nothing put first (`[]`).
2. Apply the `background.js` diff. → verify: `npm test` passes all 421.
3. In real Chrome, run `/tmp/kan611-plan/run.sh /Users/john/dev/viewshot <page> repo` for these pages: `layer-stale-after`, `layer-stale-before`, `grow-noanchor-important-layer`, `grow-noanchor`, `snap-stale`, `snap` and `still`. If a run prints `NO PNG`, run it again. → verify:
   - on `layer-stale-after`, `layer-stale-before`, `grow-noanchor-important-layer` and `grow-noanchor`, the offsets are 713, 1013, 1726, 2439, 2587, then 0;
   - on `snap-stale`, `snap` and `still`, the offsets are 713, 1426, 2139, 2287, then 0;
   - every PNG is 3000 px, with yellow at 600, red at 1300, green at 1500 and blue at 2500, and md5 `c5eebb48c46485161d24873e68c29c93`.

## Checked while planning

**Tests:** run on copies of `HEAD` (made with `git archive`) in `/tmp/kan611-plan`, with Node 24.9.0.

| Tree | `npm test` |
|---|---|
| `HEAD` | passes 421 |
| `HEAD` + the test diff only | 420 of 421 pass. The stale-rule test fails with "did not move the rule left behind first in <head>": nothing went through `prepend` |
| `HEAD` + the `background.js` diff only | 420 of 421 pass. The old stale-rule test fails with "put a second rule in", because the rule left behind now goes through `prepend` |
| `HEAD` + both diffs | passes 421 |

**Chrome:**
- **Pages run on `HEAD`:** `layer-stale-after`.
- **Pages run with both diffs:** all seven pages in step 3.
- Each run saved a PNG the first time.
- **PNG md5s:**
  - `layer-stale-after` on `HEAD`: `c372eb39610318deb9d5fd17fa7f2d05`, 3300 px.
  - All seven with both diffs: `c5eebb48c46485161d24873e68c29c93`, 3000 px.

## Open questions

None.
