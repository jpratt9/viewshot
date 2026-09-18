# KAN-511: Full page blanks a sticky element slotted into a scroller inside a closed shadow root

Ticket: https://prattsolutions.atlassian.net/browse/KAN-511 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-509, is Done.

## What the repo does now

Line numbers are from `14e2172`, with a clean working tree. The ticket's refs (`background.js:458-459`, `:475`) came from the uncommitted KAN-509 change, which is now `4605402`, and still point at the right code.

- **The check for a scroller of its own** (`markSticky`, `background.js:458-463`):
  - The climb at `:459` steps `p.assignedSlot || p.parentElement || p.getRootNode().host`, from the element and from each node it reaches.
  - `assignedSlot` is its only way from a slotted node to the slot. The comment above it says as much (`:456-457`): it "only answers for an open root".
- **An element slotted into a closed root:**
  - Its `assignedSlot` is `null`, so the climb goes to its `parentElement`, the host in the page, and never reaches a scroller around the slot.
  - The same goes when the slot takes a wrapper the sticky element sits in: the climb goes from the wrapper to the host.
- **What follows** (`:464-467`):
  - The element counts as the page's, so its place is read as `static`.
  - Stuck in a scrolled box, that place is not where it is painted. `hideStuckSticky` (`:475`) then hides it in every slice.
- **`chrome.dom.openOrClosedShadowRoot`** is already called in `markSticky`'s walk (`:442`) and in `setFixedHidden`'s (`:501`). Both call it only for an `HTMLElement`, since it throws on anything else.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 327.
  - The slotted cases (`:605-626`, `:628-639`) all use `shadowHost('open')` and set `assignedSlot`.
  - `shadowHost()` (`:549-555`): its root's `querySelectorAll` hands back what the test put inside, whatever the selector. The fake `chrome.dom.openOrClosedShadowRoot` (`:123-128`) hands back that root for either mode, and throws on anything that isn't an `HTMLElement`.
  - No fake has `assignedElements()`.

**Reproduced in Chrome 153.0.8010.48.**

- **The run:** headless, with a disposable profile and `HEAD` loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** a new one written while planning, `/tmp/vs387-chrome/run-511.js`, read with `/tmp/vs387-chrome/bands-511.py`. It copies `run-509.js` and adds a fourth component to its PageD, as PageE.
- **PageE:** 3800 px tall and white. It has four hosts, and each host's shadow root is a 300 px box with `overflow: auto` holding a `<slot>`. A script scrolls each box 500 px down on load.
- **The headers:** each is `position: sticky; top: 0`, 30 px tall, with 1000 px of page content after it. So each is stuck to the top of its box:
  - **`#slotted`:** magenta `#ff00ff`, slotted itself, in an open root. Its host is at 0, so it is painted at 0-29.
  - **`#inWrap`:** yellow `#ffff00`, inside a wrapper `div` that is what the slot takes, in an open root. Its host is at 500, so it is painted at 500-529.
  - **`#closedIn`:** orange `#ff8800`, slotted itself, in a closed root. Its host is at 1000, so it is painted at 1000-1029. This is the ticket's header.
  - **`#closedWrap`:** cyan `#00ffff`, inside a wrapper `div` that is what the slot takes, in a closed root. Its host is at 1500, so it is painted at 1500-1529. This root has a second slot before the box, `<slot name="title">`, which takes nothing.
- **The slices:** at 0, 713, 1426, 2139, 2852 and 3087.

| Element | Rows on `HEAD` |
|---|---|
| magenta `#slotted` (slotted, open root) | 0-29 |
| yellow `#inWrap` (in a slotted wrapper, open root) | 500-529 |
| orange `#closedIn` (slotted, closed root) | none |
| cyan `#closedWrap` (in a slotted wrapper, closed root) | none |

- **That is the ticket's case:** both closed-root headers are left out of the image. The open-root ones show at their places (KAN-509).
- **`after` reports** all four visible with their own inline `position: sticky`, each box still at 500, and the page at 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:** the ticket's fix direction. When `assignedSlot` has no answer, a climb step asks `chrome.dom.openOrClosedShadowRoot` for the root the node's parent hosts. It then goes to the `<slot>` in that root whose `assignedElements()` holds the node.

1. **`background.js`** (`:456-459`):

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -454,9 +454,15 @@
          // to that box (KAN-507). And an element a component shows through a slot
          // is laid out under the slot, so the climb goes there first: a scroller
          // around the slot is its own (KAN-509). assignedSlot only answers for an
   -      // open root.
   +      // open root, so for a closed one the climb looks through the root
   +      // chrome.dom hands back for the host, for the slot whose
   +      // assignedElements() holds the element (KAN-511).
   +      const slotOf = (n) => {
   +        const root = n.parentElement instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(n.parentElement);
   +        return root && [...root.querySelectorAll('slot')].find((s) => s.assignedElements().includes(n));
   +      };
          const onPage = list.filter((el) => {
   -        for (let p = el.assignedSlot || el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.assignedSlot || p.parentElement || p.getRootNode().host) {
   +        for (let p = el.assignedSlot || slotOf(el) || el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.assignedSlot || slotOf(p) || p.parentElement || p.getRootNode().host) {
              if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) return false;
            }
            return true;
   ```

2. **`tests/fullpage.test.js`**: one test after `:626`, with two cases:
   - the header slotted itself;
   - a wrapper it sits in slotted.

   In both cases:
   - `assignedSlot` is `null`.
   - The page parent is a `shadowHost('closed')` whose root holds two slots. The first sits outside the box and takes nothing. The second sits in a box with `overflow: auto`, and its `assignedElements()` lists the slotted node.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -625,6 +625,31 @@
      }
    });
    
   +test('leaves a sticky header slotted into a scroller inside a closed shadow root where it is painted', async () => {
   +  // A closed root's slot doesn't show as assignedSlot, so the climb looks for
   +  // it among the root's slots: the one whose assignedElements() holds the
   +  // header, or the wrapper it sits in. The root's other slot sits outside the
   +  // box and takes nothing (KAN-511).
   +  const cases = {
   +    'the header slotted': (header, host) => Object.assign(header, { parentElement: host, assignedSlot: null }),
   +    'a wrapper slotted': (header, host) => (header.parentElement = { parentElement: host, assignedSlot: null }),
   +  };
   +  for (const [name, place] of Object.entries(cases)) {
   +    const body = el(3052, 767);
   +    const header = positioned('sticky');
   +    header.getBoundingClientRect = () => {
   +      const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
   +      return { top, bottom: top + 30 };
   +    };
   +    let slotted; // what the slot in the box takes
   +    const slot = { parentElement: { overflow: 'auto' }, assignedElements: () => [slotted] };
   +    slotted = place(header, shadowHost('closed', { assignedElements: () => [] }, slot));
   +    const { ctx } = load({ de: el(767, 767), body, fixed: [header] });
   +    await ctx.captureFullPage(TAB);
   +    assert.ok(!header.seen.includes('hidden'), `blanked a header shown through a closed root's slot in a scroller (${name})`);
   +  }
   +});
   +
    test('reads a slotted sticky element as the page\'s when nothing around its slot scrolls', async () => {
      // Climbing through the slot mustn't make every slotted element its own: with
      // no scroller between the slot and the page, a bottom bar stuck to the first
   ```

Choices:

- **`assignedSlot` stays first.** For an open root it gives the same slot the lookup finds (measured), so the lookup only runs where `assignedSlot` has no answer. The KAN-509 path and its tests stay as they are.
- **Both steps take the lookup**, just as both take `assignedSlot`:
  - The first step covers an element slotted itself.
  - The climb step covers a slotted ancestor: the wrapper case, and a slot one component passes on into another component's slot.
- **`slotOf` is defined inside the injected func.** Both steps need it, and executeScript serializes the func on its own, so it can't live outside it. That is also why `setFixedHidden` repeats the walk.
- **Only for an `HTMLElement` parent**, the same check as `:442`:
  - `chrome.dom` throws on anything else.
  - A parent can be an SVG element (the child of a `<foreignObject>`), or null (a node at the top of a shadow root).
- **`assignedElements()` without `flatten`:** a node is assigned straight to a slot in the root its parent hosts, so the climb goes one slot at a time.
- **A node the parent's root doesn't slot climbs as it does now:** no slot holds it, so the step falls through to `parentElement`.
- **Nothing else changes:** the walk, the `static` read, the per-slice check and the restore all stay as they are.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan511-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 327.
- **Test change only:** 328 run and 327 pass. "leaves a sticky header slotted into a scroller inside a closed shadow root where it is painted" fails with "blanked a header shown through a closed root's slot in a scroller (the header slotted)".
- **Both changes:** all 328 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing test | Message |
  |---|---|---|
  | No lookup at the first step | "leaves a sticky header slotted into a scroller inside a closed shadow root where it is painted" | "blanked a header shown through a closed root's slot in a scroller (the header slotted)" |
  | No lookup at the climb step | the same test | "blanked a header shown through a closed root's slot in a scroller (a wrapper slotted)" |
  | The root's first slot, not the one whose `assignedElements()` holds the node | the same test | "blanked a header shown through a closed root's slot in a scroller (the header slotted)" |
  | No `HTMLElement` check before `chrome.dom` | six tests, listed below | "Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): " |

  The six are every test whose climb meets a parent that isn't an `HTMLElement`:
  - "leaves a sticky element stuck inside a scroller of its own where it is painted"
  - "reads a sticky element as the page's when nothing between it and the page scrolls"
  - "leaves a sticky header in a component inside a scroller where it is painted"
  - "leaves a sticky header slotted into a scroller inside a component where it is painted"
  - "leaves a sticky header slotted into a scroller inside a closed shadow root where it is painted"
  - "reads a slotted sticky element as the page's when nothing around its slot scrolls"

**Chrome 153.0.8010.48:** headless, with `run-511.js`. Like `run-509.js`, it asks the page these questions from the worker, through `chrome.scripting.executeScript` with a `func`, which is how `markSticky` runs. It asks after the popup has granted `activeTab`, then runs the full-page capture. The `slotOf` it asks with is this change's, copied in.

| Asked in the injected script | Answer |
|---|---|
| `assignedSlot` of `#slotted` / of `#inWrap`'s wrapper | the `<slot>`, whose parent is the `overflow: auto` box / the same |
| `assignedSlot` of `#closedIn` / of `#closedWrap`'s wrapper | `null` / `null` |
| `slotOf` of `#closedIn` / of `#closedWrap`'s wrapper | the `<slot>` in the `overflow: auto` box / the same, not the `title` slot before it |
| `slotOf` of `#slotted` / of `#inWrap`'s wrapper | the slot `assignedSlot` gives |
| `slotOf` of `#inWrap` / of `#closedWrap` (not slotted themselves) | `null` / `null` |
| `getBoundingClientRect().top` of `#slotted` / `#inWrap` / `#closedIn` / `#closedWrap` | 0 / 500 / 1000 / 1500, each stuck to the top of its box |

The rows each header shows in:

| Element | `HEAD` | This change (`--ext /tmp/kan511-plan/tree`) |
|---|---|---|
| magenta `#slotted` (slotted, open root) | 0-29 | 0-29 |
| yellow `#inWrap` (in a slotted wrapper, open root) | 500-529 | 500-529 |
| orange `#closedIn` (slotted, closed root) | none | 1000-1029 |
| cyan `#closedWrap` (in a slotted wrapper, closed root) | none | 1500-1529 |

- **On both builds, `after` reports:**
  - all four headers `visible`, with their inline `position` still `sticky`;
  - each box still at 500;
  - the page at 0.
- **Capture log:** neither run logged a `[ViewShot]` line.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 328 and 327 pass. Only "leaves a sticky header slotted into a scroller inside a closed shadow root where it is painted" fails, with "blanked a header shown through a closed root's slot in a scroller (the header slotted)".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 328.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-511.js`, which was written while planning. Run it headless, with `--ext` pointed first at a copy of `HEAD` (`mkdir -p /tmp/kan511-head && git archive HEAD | tar -x -C /tmp/kan511-head`) and then at the repo. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-511.py <png>`.
   → verify:
   - **On `HEAD`:** magenta at 0-29 and yellow at 500-529. Orange and cyan are left out.
   - **On the repo:** magenta at 0-29, yellow at 500-529, orange at 1000-1029 and cyan at 1500-1529, once each.
   - **On both builds**, `after` reports the four headers `visible` with inline `position: sticky`, each box at 500, and the page at 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-511-plan.md`.

## Noticed while planning, not changed

None.

## Open questions

None.
