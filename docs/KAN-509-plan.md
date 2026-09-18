# KAN-509: Full page blanks a sticky element slotted into a scroller inside a web component

Ticket: https://prattsolutions.atlassian.net/browse/KAN-509 (To Do, Task, labels `bug` and `viewshot`, no comments). Its one blocker, KAN-507, is Done.

## What the repo does now

Line numbers are from `99790d3`, with a clean working tree. The ticket's refs (`background.js:455-456`, `:472`, `tests/fullpage.test.js:470`) still point at the right code.

- **The check for a scroller of its own** (`markSticky`, `background.js:455-460`):
  - The climb at `:456` starts at `el.parentElement || el.getRootNode().host` and steps the same way.
  - It never looks at `assignedSlot`.
- **A slotted element:**
  - A component lays it out under its `<slot>`, in the component's shadow tree.
  - Its `parentElement` is still the host in the page, so the climb goes host, then page, and never reaches a scroller around the slot.
  - The same goes when the slot takes a wrapper the sticky element sits in: the climb goes from the wrapper to the host.
- **What follows** (`:461-464`):
  - The element counts as the page's, so its place is read as `static`.
  - Stuck in a scrolled box, that place is not where it is painted. `hideStuckSticky` (`:472`) then hides it in every slice.
- **Tests** (`tests/fullpage.test.js`): `npm test` passes 325.
  - The scroller cases are "leaves a sticky element stuck inside a scroller of its own where it is painted" (`:470`) and "leaves a sticky header in a component inside a scroller where it is painted" (`:589`). Neither has a slot.
  - `shadowHost()` (`:549`) models a host and its root, and nothing in the harness sets `assignedSlot`.

**Reproduced in Chrome 153.0.8010.48.**

- **The run:** headless, with a disposable profile and `HEAD` loaded unpacked. The format was PNG, and the viewport 1280×713 at dpr 1.
- **The script:** a new one written while planning, `/tmp/vs387-chrome/run-509.js`, read with `/tmp/vs387-chrome/bands-509.py`. It copies `run-507.js` and swaps in PageD.
- **PageD:** 3300 px tall and white. It has three hosts, and each host's shadow root is a 300 px box with `overflow: auto` holding a `<slot>`. A script scrolls each box 500 px down on load.
- **The headers:** each is `position: sticky; top: 0`, 30 px tall, with 1000 px of page content after it. So each is stuck to the top of its box:
  - **`#slotted`:** magenta `#ff00ff`, slotted itself, in an open root. Its host is at 0, so it is painted at 0-29.
  - **`#inWrap`:** yellow `#ffff00`, inside a wrapper `div` that is what the slot takes, in an open root. Its host is at 500, so it is painted at 500-529.
  - **`#closedIn`:** orange `#ff8800`, slotted itself, in a closed root. Its host is at 1000, so it is painted at 1000-1029.
- **The slices:** at 0, 713, 1426, 2139 and 2587.

| Element | Rows on `HEAD` |
|---|---|
| magenta `#slotted` (slotted, open root) | none |
| yellow `#inWrap` (in a slotted wrapper, open root) | none |
| orange `#closedIn` (slotted, closed root) | none |

- **That is the ticket's case:** all three headers are left out of the image.
- **`after` reports** all three visible with their own inline `position: sticky`, each box still at 500, and the page at 0.

## Change

Two files change: `background.js` and `tests/fullpage.test.js`. Both diffs below were applied and tested on a copy of `HEAD` outside the repo (see "Checked while planning").

**The rule:** the ticket's fix direction. `p.assignedSlot ||` goes at the front of both climb steps, so an element a component shows through a slot climbs from that slot.

1. **`background.js`** (`:456`, and the comment above it):

   ```diff
   --- a/background.js
   +++ b/background.js
   @@ -451,9 +451,12 @@
          // page, though: one inside a scroller of its own moves with the page,
          // stuck or not, so its place is where it is painted. The climb goes on
          // through the host of a shadow root: a component in a scrolled box sticks
   -      // to that box (KAN-507).
   +      // to that box (KAN-507). And an element a component shows through a slot
   +      // is laid out under the slot, so the climb goes there first: a scroller
   +      // around the slot is its own (KAN-509). assignedSlot only answers for an
   +      // open root.
          const onPage = list.filter((el) => {
   -        for (let p = el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.parentElement || p.getRootNode().host) {
   +        for (let p = el.assignedSlot || el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.assignedSlot || p.parentElement || p.getRootNode().host) {
              if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) return false;
            }
            return true;
   ```

2. **`tests/fullpage.test.js`**: one test, with two cases:
   - the header slotted itself;
   - a wrapper it sits in slotted.

   In both, the slot's parent is a box with `overflow: auto`, and the page parent is a `shadowHost('open')`.

   ```diff
   --- a/tests/fullpage.test.js
   +++ b/tests/fullpage.test.js
   @@ -602,6 +602,29 @@
      assert.ok(!header.seen.includes('hidden'), 'blanked a header stuck inside the scroller its component sits in');
    });
    
   +test('leaves a sticky header slotted into a scroller inside a component where it is painted', async () => {
   +  // The header is the page's own, but the component lays it out under a
   +  // <slot> inside a scrolled box, and that box is what it sticks to. The slot
   +  // takes the header itself or a wrapper it sits in; either way its parent in
   +  // the page is the component (KAN-509).
   +  const cases = {
   +    'the header slotted': (header, host, slot) => Object.assign(header, { parentElement: host, assignedSlot: slot }),
   +    'a wrapper slotted': (header, host, slot) => Object.assign(header, { parentElement: { parentElement: host, assignedSlot: slot } }),
   +  };
   +  for (const [name, place] of Object.entries(cases)) {
   +    const body = el(3052, 767);
   +    const header = positioned('sticky');
   +    header.getBoundingClientRect = () => {
   +      const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
   +      return { top, bottom: top + 30 };
   +    };
   +    place(header, shadowHost('open'), { parentElement: { overflow: 'auto' } }); // the slot, in the box
   +    const { ctx } = load({ de: el(767, 767), body, fixed: [header] });
   +    await ctx.captureFullPage(TAB);
   +    assert.ok(!header.seen.includes('hidden'), `blanked a header shown through a slot in a scroller (${name})`);
   +  }
   +});
   +
    test('asks chrome.dom about HTMLElements only', async () => {
      // It throws on anything else, an <svg> icon say, and a throw there stops
      // the capture. Nothing but an HTMLElement can host a shadow root anyway.
   ```

Choices:

- **Both steps take the slot:**
  - The first step covers an element slotted itself.
  - The climb step covers an ancestor that is slotted: the wrapper case, and a slot a component passes on into another component's slot.
- **An element that isn't slotted climbs as it does now.** Its `assignedSlot` is null, and that includes a slot's own fallback content. A slot straight under its shadow root goes on to the host through the KAN-507 step.
- **Closed roots aren't covered.** `assignedSlot` is null for an element in a closed root's slot (measured), so `#closedIn` is still left out. See "Open questions".
- **Nothing else changes:** the walk, the `static` read, the per-slice check and the restore all stay as they are.
- **No README, manifest or version change.**

## Checked while planning

**Tests:** run on a copy of `HEAD` (`git archive`) in `/tmp/kan509-plan/tree`, with Node 24.9.0.

- **As it is now:** `npm test` passes 325.
- **Test change only:** 326 run and 325 pass. "leaves a sticky header slotted into a scroller inside a component where it is painted" fails with "blanked a header shown through a slot in a scroller (the header slotted)".
- **Both changes:** all 326 pass.
- **Both changes, with one piece broken at a time:**

  | Piece broken | Failing test | Message |
  |---|---|---|
  | No `assignedSlot` at the first step | "leaves a sticky header slotted into a scroller inside a component where it is painted" | "blanked a header shown through a slot in a scroller (the header slotted)" |
  | No `assignedSlot` at the climb step | the same test | "blanked a header shown through a slot in a scroller (a wrapper slotted)" |

**Chrome 153.0.8010.48:** headless, with `run-509.js`. The script asks the page these questions from the worker, through `chrome.scripting.executeScript` with a `func`, which is how `markSticky` runs. It asks after the popup has granted `activeTab`, then runs the full-page capture.

| Asked in the injected script | Answer |
|---|---|
| `assignedSlot` of `#slotted` / of the wrapper | the `<slot>`, whose parent is the `overflow: auto` box / the same |
| `assignedSlot` of `#inWrap` (not slotted itself) | `null` |
| `assignedSlot` of `#closedIn` (closed root) | `null` |
| `chrome.dom.openOrClosedShadowRoot` of `#closedIn`'s host | the closed root |
| does a `<slot>` in that root list `#closedIn` in `assignedElements()`? | yes |
| `getBoundingClientRect().top` of `#slotted` / `#inWrap` / `#closedIn` | 0 / 500 / 1000, each stuck to the top of its box |

The rows each header shows in:

| Element | `HEAD` | This change (`--ext /tmp/kan509-plan/tree`) |
|---|---|---|
| magenta `#slotted` (slotted, open root) | none | 0-29 |
| yellow `#inWrap` (in a slotted wrapper, open root) | none | 500-529 |
| orange `#closedIn` (slotted, closed root) | none | none |

- **On both builds, `after` reports:**
  - all three headers `visible`, with their inline `position` still `sticky`;
  - each box still at 500;
  - the page at 0.
- **Capture log:** the run with the change logged no errors.

## Steps

1. Make the `tests/fullpage.test.js` change above.
   → verify: `npm test` runs 326 and 325 pass. Only "leaves a sticky header slotted into a scroller inside a component where it is painted" fails, with "blanked a header shown through a slot in a scroller (the header slotted)".
2. Make the `background.js` change above.
   → verify: `npm test` passes all 326.
3. Check the change in Chrome with `/tmp/vs387-chrome/run-509.js`, which was written while planning. Run it headless, with `--ext` pointed first at a copy of `HEAD` (`git archive HEAD | tar -x -C /tmp/kan509-head`) and then at the repo. Read each saved PNG with `python3 /tmp/vs387-chrome/bands-509.py <png>`.
   → verify:
   - **On `HEAD`:** all three headers are left out.
   - **On the repo:** magenta at 0-29 and yellow at 500-529, once each. Orange is still left out, since its root is closed.
   - **On both builds**, `after` reports the three headers `visible` with inline `position: sticky`, each box at 500, and the page at 0.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/fullpage.test.js` and `docs/KAN-509-plan.md`.

## Noticed while planning, not changed

None.

## Open questions

1. **Should a component with a closed shadow root be covered too?**
   - The ticket is about any web component, but its fix direction is `p.assignedSlot ||`, and `assignedSlot` only answers for an open root. In Chrome 153 it reads `null` for an element slotted into a closed root, even from the extension's isolated world. So with this plan, `#closedIn` is still left out of the image.
   - **What covering it would take:**
     - At each climb step, whenever the parent hosts a shadow root, get that root with `chrome.dom.openOrClosedShadowRoot` and find the `<slot>` whose `assignedElements()` holds the element.
     - The probe found `#closedIn` that way.
     - That is a second way in beside `assignedSlot`, a few lines in `markSticky`, and a closed-root case in the test.
   - The plan stays with the ticket's fix direction until this is answered.
