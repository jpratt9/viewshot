# KAN-400: A glow whose animation starts late can still reach the recording after the blip's hold is over

Ticket: https://prattsolutions.atlassian.net/browse/KAN-400 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-387, is Done.

The ticket's line numbers are older: its `background.js:544` is now `:694`, its `:553`/`:478-481` are now `:711` and `:623`/`:636`, and its `:556` is now `:713`.

## What the repo does now

Line numbers are from `4af97ec`, with a clean working tree.

- **The blip is fire-and-forget inside the page.** `blipRecordingIndicator` (`background.js:683-714`) injects a function that adds an overlay and calls `o.animate(...)`, attaching only `.onfinish = () => o.remove()` (`:694-695`). It returns `undefined` at once. Nothing reads `Animation.ready` or `Animation.finished`, and the page never messages the worker: its whole contract is the `executeScript` return value.
- **Both holds are counted off the worker's own clock.**
  - **Timed out:** the `catch` returns `deadline + BLIP_ANIM_MS + 50` (`:711`), an offset from the worker's `deadline` (`:684`).
  - **Answered:** `await new Promise((r) => setTimeout(r, BLIP_ANIM_MS + 50))` (`:713`), counted from when the script *ran*, not from the frame the animation first painted.
- **The caller sleeps to that instant** (`startRecording`, `:623` and `:636`), with the viewport read in between so the two overlap.
- **The only page-side guard is a pre-check:** `if (Date.now() > deadline) return;` (`:691`). It stops a glow being *added* late; it says nothing about a glow added just before the deadline whose animation starts later.
- **There is a precedent for a page reporting back:** `captureRegion` (`:474-496`) installs a one-shot `chrome.runtime.onMessage` listener, keeps its resolver in a module-scoped `cancelPendingRegion` (`:457`), and removes the listener when it settles. `region.js` sends `shot-region` from the page.
- **The worker has no `blip-done` channel.** Its top-level listener (`:10-38`) handles `capture`, `rec-start`, `rec-stop`, `rec-cap-hit`, `rec-failed` and `rec-check` only.
- **Tests:** `npm test` passes 282 tests.
  - `loadBg` (`tests/capture-errors.test.js:21-97`) runs the injected function for real: its fake `executeScript` calls `o.func.apply(null, o.args)` (`:61`), so the blip's body runs against the vm context's `document`, `Date` and `chrome`.
  - Three tests fake an element as `{ style: {}, animate: () => ({}) }` — `:1493`, `:1510`, `:1536`. That bare object has no `finished`.
  - Its context has no `crypto`; `loadOffscreen` has `crypto: { randomUUID: () => 'doc-1' }` (`:513`).
  - The fake `setTimeout` (`:60-67`) runs any sleep at once and advances the clock, except the three script/capture deadlines, which it holds until `expire()`. `sleeps` records every duration, so a computed wait is observable.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`.

The hold ends when the page says its glow is gone, and the worker's clock only bounds it. The report goes over a one-shot `chrome.runtime.onMessage` listener, the same shape `captureRegion` already uses, so the top-level dispatcher is untouched and the channel exists on the timed-out path as well as the answered one.

1. **`background.js`**
   - **`BLIP_HOLD_MS`**, next to `BLIP_ANIM_MS` (`:680`): how long past the blip's deadline the recorder waits for a page that never reports. `SCRIPT_TIMEOUT_MS + BLIP_ANIM_MS + 50` — the same 2 s grace the page gets to run any script, plus the animation (see "Open questions").
   - **The injected function takes an `id` and reports** (`:688-699`): it messages `blip-done` when the animation settles, and also when it returns early because it ran past its deadline — a page that showed nothing ends the hold at once instead of waiting the ceiling out. `.finished.then(tell, tell)` covers a cancelled animation, so the worker is never left waiting on one.
   - **`blipRecordingIndicator` returns a promise, not a timestamp** (`:683-714`): `null` when the page refused the script (nothing was shown), otherwise a promise that settles on the page's report or at the ceiling, whichever comes first. The listener is installed before the injection so a fast page can't report before anyone is listening, and is removed when it settles.
   - **`startRecording` awaits it after the viewport read** (`:623`, `:636`), keeping today's overlap.

   ```diff
   @@ -621,7 +621,7 @@ async function startRecording(streamId, opts, tabId) {
   -  const blipOver = tab ? await blipRecordingIndicator(tab.id) : 0;
   +  const glowGone = tab ? await blipRecordingIndicator(tab.id) : null;
    @@ -632,7 +632,7 @@
      // A blip that ran out of time may have shown its glow just before its
   -  // deadline, and the wait for it to fade was skipped along with the blip.
   -  // The viewport read above has already used up part of that wait.
   -  if (blipOver > Date.now()) await sleep(blipOver - Date.now());
   +  // deadline, and the wait for it to fade was skipped along with the blip.
   +  // The viewport read above has already run while the glow was on screen.
   +  if (glowGone) await glowGone;
   @@ -678,10 +678,15 @@
    const BLIP_ANIM_MS = 650;
   +// How long past the blip's deadline the recorder waits for a page that never
   +// reports its glow. o.animate() doesn't paint when the script runs - the
   +// animation starts on the page's next frame - and a page busy enough to miss
   +// the blip's deadline is the one that may not produce that frame for a while.
   +const BLIP_HOLD_MS = SCRIPT_TIMEOUT_MS + BLIP_ANIM_MS + 50;
    async function blipRecordingIndicator(tabId) {
      const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
   +  const id = crypto.randomUUID(); // a report from an earlier blip is not this one's
   +  let done;
   +  const reported = new Promise((resolve) => {
   +    done = () => { chrome.runtime.onMessage.removeListener(onMsg); resolve(); };
   +    const onMsg = (msg) => { if (msg?.type === 'blip-done' && msg.id === id) done(); };
   +    chrome.runtime.onMessage.addListener(onMsg);
   +  });
      try {
        await scriptWithTimeout({
          target: { tabId },
   -      func: (animMs, deadline) => {
   +      func: (animMs, deadline, id) => {
   +        // The hold ends on this, not on the worker's clock: the animation only
   +        // starts on the page's next frame, which can be long after the script.
   +        const tell = () => chrome.runtime.sendMessage({ type: 'blip-done', id }).catch(() => {});
   -        if (Date.now() > deadline) return;
   +        if (Date.now() > deadline) { tell(); return; } // nothing shown, nothing to hold for
            const o = document.createElement('div');
            o.style.cssText = '...';
            (document.body || document.documentElement).appendChild(o);
   -        o.animate([...], { duration: animMs, easing: 'ease-out' })
   -          .onfinish = () => o.remove();
   +        o.animate([...], { duration: animMs, easing: 'ease-out' })
   +          .finished.then(() => { o.remove(); tell(); }, () => { o.remove(); tell(); });
          },
   -      args: [BLIP_ANIM_MS, deadline],
   +      args: [BLIP_ANIM_MS, deadline, id],
        });
      } catch (e) {
        console.warn('[ViewShot] blip failed:', e);
   -    return Date.now() < deadline ? 0 : deadline + BLIP_ANIM_MS + 50;
   +    // A page that refuses scripts fails at once and shows nothing. A page that
   +    // ran out of time may have run the script just before its deadline, so it
   +    // still has a glow to report.
   +    if (Date.now() < deadline) { done(); return null; }
      }
   -  await new Promise((r) => setTimeout(r, BLIP_ANIM_MS + 50));
   -  return 0;
   +  return Promise.race([reported, sleep(Math.max(0, deadline + BLIP_HOLD_MS - Date.now())).then(done)]);
    }
   ```

2. **`tests/capture-errors.test.js`**
   - **`loadBg`'s context gains `crypto: { randomUUID: () => 'blip-1' }`**, matching `loadOffscreen:513`.
   - **The three fake elements** (`:1493`, `:1510`, `:1536`) return an animation with a `finished` promise instead of `{}`, and those tests route the page's `chrome.runtime.sendMessage` into `bg.message` so the report reaches the worker's listener. Without this the injected function throws on `undefined.finished` and every one of them silently becomes a "blip failed" test.
   - **Three tests**, under the existing blip banner (`:1485-1521`):
     - a glow that finishes long after the script ran still holds the recorder: the page reports late, and `rec-start-offscreen` is sent no earlier than the report;
     - a page that runs the blip after its deadline ends the hold at once rather than waiting the ceiling out (`sleeps` shows no `BLIP_HOLD_MS` wait);
     - a `blip-done` carrying another blip's id doesn't end this one's hold.

## Steps

1. **Add `BLIP_HOLD_MS` and give the injected function its `id` and `tell`** (`background.js:680`, `:688-699`). → verify: `npm test` — the three tests at `:1490`, `:1507`, `:1529` fail on `undefined.finished`, which is step 3's fixture work; nothing else changes.
2. **Make `blipRecordingIndicator` return a promise and `startRecording` await it** (`:683-714`, `:623`, `:636`). → verify: `npm test` — same three failures, no new ones.
3. **Update `loadBg`'s context and the three fake elements**, and route the page's `sendMessage` into `bg.message`. → verify: `npm test` passes 282 again.
4. **Add the three tests.** → verify: `npm test` passes 285; each fails with step 1 or step 2 reverted.
5. **Check it in Chrome 153.0.8010.48**, `--headless=new`, disposable profile, the repo loaded with `Extensions.loadUnpacked`, popup driven with `Extensions.triggerAction`, on a page whose main thread is blocked long enough to miss the blip's deadline (the busy page from `docs/KAN-387-plan.md`). → verify: the saved WebM's first second is the page's own colour in every frame `ffmpeg` reads — no green edge — and the worker log shows the recorder starting after the page's `blip-done`.
6. **Check an ordinary page in the same run.** → verify: the glow still shows once, the recording still has no green in its first second, and the start is no slower than before (the report arrives about `BLIP_ANIM_MS` after the glow appears, where today it waited `BLIP_ANIM_MS + 50` from the answer).
7. **Check a `chrome://` page.** → verify: Record still starts immediately, with the existing "blip failed" warning and no hold.
8. **Check that nothing else changed.** → verify: `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

1. **How long should the recorder wait for a page that never reports?** The ticket says to close the hold on what the page did, but a page whose main thread never frees up never reports, so a ceiling has to exist and its length is a tradeoff the ticket doesn't settle.
   - This plan uses `SCRIPT_TIMEOUT_MS + BLIP_ANIM_MS + 50` (2700 ms) past the deadline: a page gets the same 2 s to produce its first frame that it gets to run the script at all. Worst case, a start on a page that is both slow to run the script and never reports is delayed ~4.7 s, against ~2.7 s today.
   - Keeping today's ceiling (`deadline + BLIP_ANIM_MS + 50`) instead would leave the reported window open: a glow whose animation starts more than 700 ms after the deadline still lands in the recording, which is the bug.
   - If a 4.7 s worst case isn't acceptable, the constant is the only thing that changes.
2. **Nothing else in the ticket is left open.** The answered and timed-out paths both end up on the same report, so the ticket's "the timed-out path has no channel for that today" is answered by the one-shot listener rather than by two mechanisms.

## Implementation and verification

Done as planned, with three departures, all in how the change is tested or bounded rather than in what it does.

- **Steps 1-2 — `background.js`.** `BLIP_HOLD_MS` sits next to `BLIP_ANIM_MS`; the injected function takes an `id`, reports `blip-done` when its animation settles (`finished.then(over, over)`) and when it returns early past its deadline; `blipRecordingIndicator` installs a one-shot listener before the injection and returns `null` for a page that refused the script, otherwise a race between the report and the ceiling; `startRecording` awaits that after the viewport read.
  - **Departure — the ceiling is one timer from the blip's start.** The plan computed `sleep(deadline + BLIP_HOLD_MS - Date.now())` at the end. It is now `sleep(SCRIPT_TIMEOUT_MS + BLIP_HOLD_MS)` taken when the blip starts: the same instant, `deadline + BLIP_HOLD_MS`, but a fixed duration the test harness can hold like the other deadlines. A computed remainder can't be told apart from an ordinary sleep there, and the harness runs those at once, so every test would have seen the ceiling win the race.
- **Step 3 — the harness.** `loadBg` gains `crypto`, and two things the plan didn't list, both needed for the report to be testable at all:
  - **every `onMessage` listener is kept** (it kept only the first, so the blip's one-shot listener was never registered), and the default `chrome.runtime.sendMessage` hands a page's `blip-done` to all of them, as Chrome does. `bg.message` still reaches only `background.js`'s own listener, so no existing test changes meaning;
  - **the ceiling (`SCRIPT_TIMEOUT_MS + BLIP_HOLD_MS`) is held until `expire()`**, like the script and capture deadlines.

  **Five** fake elements, not three, needed an animation with a `finished` promise (`:1495, :1512, :1537, :1618, :1651` all used `animate: () => ({})`); they share a small `animating(bg)` helper. The two tests that replace `sendMessage` wholesale forward to the default so the page's report still arrives. "a blip the page answers in time leaves the start nothing to hold for" asserted the old `0` return; it now checks the same claim against the new contract — a blip the page answers and reports in time leaves the hold settled.
  → `npm test` passed 282.
- **Step 4 — three tests.** → `npm test` passes **285**. Each fails with its part removed:
  - hold on the old fixed `BLIP_ANIM_MS + 50` wait instead of the report → all three fail;
  - drop the `id` check → "a report from another blip does not end this one's hold" fails;
  - drop the report from a page that ran late → "a page that runs the blip after its deadline holds the recorder for nothing" fails.
- **Steps 5-7 — real recordings**, Chrome 153.0.8010.48, `--headless=new`, a disposable profile per run, `download.default_directory` in `Default/Preferences`, the extension loaded with `Extensions.loadUnpacked`, popup driven with `Extensions.triggerAction`, WebM. A white http page records every overlay it gets (`MutationObserver` on `zIndex 2147483647`) and when it is removed; the worker's `chrome.runtime.sendMessage` is wrapped over CDP to stamp `rec-start-offscreen`. All times are ms from the Record press. **Busy** means the page burns its main thread for 1.9 s from the press, so the script runs just inside its deadline, and then burns another 1.5 s the moment the overlay goes in, so the script's answer misses the deadline *and* the animation can't get its first frame — this ticket's case.

  | code | page | overlay added | worker gave up on the script | glow gone | recorder started | green frames |
  |---|---|---|---|---|---|---|
  | HEAD | busy | 1903 | 2030 | 4043 | **3411** — 632 ms before the glow was gone | **8 of 21**, the first one included |
  | **this change** | busy | 1945 | 2080 | 4111 | **4117** — after it | **0 of 3** |
  | HEAD | normal | 70 | — | 728 | 788 | 0 of 7 |
  | **this change** | normal | 50 | — | 713 | **718** | 0 of 7 |
  | **this change** | `chrome://version/` | — | "Cannot access a chrome:// URL" at 31 | — | **30** | 0 of 7 |

  - **The ticket's case reproduces on HEAD and is gone with the change.** On HEAD the recorder started while the late-starting glow was still playing, and 8 of the saved file's 21 frames are green, starting with the first (`#c4f3cd` fading to white). With the change the recorder waited for the page's report and started 6 ms after the glow was removed; every frame is white.
  - **An ordinary start is faster, not slower.** The hold ends on the report instead of a fixed 700 ms from the answer: 5 ms after the glow instead of 60 ms, 718 ms from the press instead of 788.
  - **`chrome://` holds nothing**: the recorder was told to start at 30 ms, alongside the existing "blip failed" warning.
  - Green frames were counted over every decoded frame (`-vsync passthrough`) of an 8-px strip at the left edge, the same measure as `docs/KAN-387-plan.md`; a frame counts as green when G is more than 20 above both R and B. The files with few frames are of a static page — tab capture only sends a frame when something changes.
- **Step 8 — nothing else changed.** `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

The open question on the ceiling is unchanged: none of these runs reached it — the busy page's report came at 4111 ms, well inside the ceiling at ~4.7 s from the blip's start.

## The open question, settled — and a bug found settling it

**The ceiling is the viewport read's own deadline: `BLIP_HOLD_MS = SCRIPT_TIMEOUT_MS`.** A page that never reports gets 2 s past the blip's deadline, not 2.7 s.

- **The repo already sets the budget.** The comment above `SCRIPT_TIMEOUT_MS` (`background.js:178-186`) records that the stream id the popup mints only works for about 10 s — Chrome 152 took one used at 9.2 s and refused one used at 10.3 s — and that "two 2 s deadlines leave a start, and one queued behind it, time to use theirs". A start that a queued one waits behind (`recStartGate`) must therefore stay within its two script deadlines, about 4 s from the blip.
- **2.7 s past the deadline breaks that.** It makes a start's worst case about 4.7 s from the blip, and a start queued behind it uses its stream id at about 9.4 s plus overheads — at the 10 s edge, where the recording fails outright.
- **2 s past the deadline costs nothing.** The hold overlaps the viewport read, whose own deadline already ends 4 s from the blip, so no start takes longer than it did before this ticket.

**Settling it turned up a bug in `d1601a7`: the hold no longer overlapped the viewport read.** `blipRecordingIndicator` is `async`, and an async function hands back a promise it returns as its own. So `await blipRecordingIndicator(...)` sat through the whole hold, and only then did `getViewport` start. The plan said the overlap was kept; it wasn't. On a page that stays blocked, the viewport read's 2 s deadline was paid after the hold instead of during it. The unit tests missed it because the fake `executeScript` answers at once, so the viewport read never had to wait.

- **Fix:** `blipRecordingIndicator` returns `{ gone }` — the race wrapped in an object, so the caller's `await` gets it back straight after the injection — and `startRecording` awaits `blip.gone` after the viewport read.
- **Test:** "a glow that finishes long after the script ran still holds the recorder" now also asserts that the viewport read ran while the hold was pending. It fails with `d1601a7`'s shape of those three lines restored and passes with the fix. The three tests that watched the hold settle now wait on `.gone`; they had been passing on the wrapper's own settling. `npm test` passes 285.

**Measured**, Chrome 153.0.8010.48, `--headless=new`, the busy page from "Implementation and verification": the main thread is blocked 1.9 s from the Record press, then for a further *n* ms the moment the overlay goes in. The worker was instrumented with timestamps in a copy of the extension. Times are ms from the press.

| blocked after the overlay | blip returned | viewport read done | hold over | glow gone | recorder started | green frames |
|---|---|---|---|---|---|---|
| 0 (the KAN-387 case) | 1905 | 1911 | 2551 — the report | 2550 | 2552 | 0 of 7 |
| 1200 ms | 2027 | 3112 | 3773 — the report | 3768 | 3776 | 0 of 6 |
| 1500 ms | 2056 | 3418 | 4052 — the ceiling | 4083 | 4056 | 0 of 5 |
| 5000 ms | 2043 | 4046 | 4046 — the ceiling | 7583 | **4048** | 8 of 25 |
| 5000 ms, **`d1601a7`'s shape** | **4035** — sat through the hold | **6040** — only started after it | 6040 | 7561 | **6043** | — |

- **"blip returned" is now at the blip's deadline** (about 2 s), and the viewport read finishes while the hold is still pending. Under `d1601a7`'s shape, blip returned at 4035 and the viewport read only finished at 6040.
- **A start that never gets a report now takes 4.0 s from the blip**, its two script deadlines, where `d1601a7`'s shape took 6.0 s with this ceiling (and about 6.7 s with the 2.7 s one it shipped).
- **Pages that free up within the 2 s grace record clean.** The 1500 ms case ended on the ceiling 27 ms before the fade's last frame; those 27 ms of an ease-out fade to 0 are invisible, and the file has no green or faintly tinted frame.
- **A page still blocked more than 2 s past the deadline still puts its glow in the recording** (the 5000 ms row: its animation only started at about 6900 ms). This is the case the ceiling exists to give up on. Covering it means holding a start past its two deadlines, which spends the time a queued start needs for its stream id. `d1601a7` didn't cover it either — its recorder started at about 6.7 s, before this glow.
