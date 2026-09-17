# KAN-242: Recordings of pages the extension can't script aren't sized to the tab

Ticket: https://prattsolutions.atlassian.net/browse/KAN-242 (To Do, Task, labels `bug` and `viewshot`, one comment). Nothing blocks it.

The ticket's line numbers are older: its `background.js:356-386` is now `background.js:598-645`, its `background.js:393-408` is now `background.js:647-668`, and its `offscreen.js:39-42` is now `offscreen.js:62-65`.

## What the repo does now

Line numbers are from `d03d645`, with a clean working tree.

- **The only source of a recording's size is a script in the page.** `startRecording` (`background.js:598-645`) calls `getViewport(tab?.id)` (`:631`), which runs `window.innerWidth/innerHeight × devicePixelRatio` through `scriptWithTimeout` (`:653-668`).
- **On a page that refuses scripts it gives up.** The `catch` (`:664-667`) logs `[ViewShot] getViewport failed:` and returns `null`. Nothing else is consulted — `startRecording` sends `width: dims?.width, height: dims?.height` (`:642`), both `undefined`.
- **The offscreen document then doesn't pin the capture.** `startRecording` there only adds the min/max block when both arrive: `if (width && height)` (`offscreen.js:62-65`). Without it, `getUserMedia` runs on `chromeMediaSource`/`chromeMediaSourceId` alone, which is the default-ceiling-plus-black-padding path its own comment describes (`offscreen.js:56-60`).
- **Measured** (the ticket, and its comment): a 1280×713 tab recorded as an 800×600 WebM and a 720×540 GIF, both with black bars, on the Web Store, a `file://` page without file access, and `chrome://version/`, `chrome://settings/`, `chrome://extensions/`, `chrome://newtab/`. An http page in the same run gave 1278×712 WebM and 720×401 GIF.
- **The pages this happens on are all reachable from Record.** KAN-217 keeps Record allowed on the Web Store and on `file://` without file access; KAN-252 (`e226216`) lets it through on `chrome://`.
- **The worker already holds the tab.** `startRecording` reads it at `:607` (`getActiveTab(tabId)` → `chrome.tabs.get`) and passes only its id to `getViewport`.
- **The comment above that call is wrong** (`background.js:624-630`). It says `chrome.tabs.Tab.width/height` "reports the outer window dims (tab strip + omnibox + bookmarks bar + status bar all included)", which is why `764bd58` stopped using them. Measured again in Chrome 153.0.8010.48 (see "Checked while planning"), `Tab.width/height` is the web-contents viewport in CSS pixels; `chrome.windows.get()` is the outer window.
- **Tests:** `npm test` passes 276 tests.
  - `loadBg` (`tests/capture-errors.test.js:21-97`) has `scriptFails`, which throws `Cannot access a chrome:// URL` from the fake `executeScript` (`:59`).
  - `TAB` (`:9`) is `{ id: 7, windowId: 1, url: 'https://a.com', title: 'T' }` — no `width` or `height`.
  - The dims a start sends are asserted in one place: "a recording of a page that answers everything is sized to the tab" (`:778-779`).
  - Two tests already start a recording with `scriptFails` (`:1558-1567`, `:229-238`); neither looks at the dims.

## Change

Two files change: `background.js` and `tests/capture-errors.test.js`.

1. **`background.js`**
   - **`getViewport` takes the tab, not its id** (`:653`), so its `catch` can fall back to the size Chrome already told us about. `startRecording` passes `tab` (`:631`).
   - **The `catch` (`:664-667`) returns `{ width: tab.width, height: tab.height }`** when the tab has them, and `null` only when it doesn't. These are CSS pixels, so the recording is framed right; on a HiDPI display it is captured at 1x where the script's `devicePixelRatio` would have given 2x (see "Open questions").
   - **The two comments that describe the old behaviour** (`:624-630`, `:647-652`) say what `Tab.width/height` actually is and why the script is still preferred.

   ```diff
   @@ -621,13 +621,14 @@ async function startRecording(streamId, opts, tabId) {
      // skip straight to recording — the badge + Chrome's own blue capture border
      // are still visible to the user as recording-active cues.
      const blipOver = tab ? await blipRecordingIndicator(tab.id) : 0;
   -  // Query the captured tab's ACTUAL viewport (innerWidth/innerHeight) — NOT
   -  // chrome.tabs.Tab.width/height, which reports the outer window dims (tab
   -  // strip + omnibox + bookmarks bar + status bar all included). tabCapture
   -  // only captures the web-contents viewport, so pinning min/max to the outer
   -  // window dims makes Chrome pad the difference with black (~150-200px bar
   -  // at the bottom). innerWidth/innerHeight × devicePixelRatio gives the
   -  // physical pixels that match what tabCapture actually delivers.
   -  const dims = await getViewport(tab?.id);
   +  // Query the captured tab's ACTUAL viewport (innerWidth/innerHeight). NOT
   +  // chrome.windows.get(), which is the outer window (tab strip + omnibox +
   +  // bookmarks bar all included): tabCapture only streams the web-contents
   +  // viewport, so pinning min/max to the window pads the difference with
   +  // black (~150-200px bar at the bottom). innerWidth/innerHeight ×
   +  // devicePixelRatio gives the physical pixels tabCapture delivers; the tab
   +  // is passed so a page that refuses the script still has a size to fall
   +  // back on.
   +  const dims = await getViewport(tab);
   @@ -644,22 +645,27 @@ async function startRecording(streamId, opts, tabId) {
    // Get the captured tab's real viewport in PHYSICAL pixels (innerWidth/Height
    // × devicePixelRatio). This is what tabCapture actually streams — pinning
   -// getUserMedia's min/max to these values eliminates both letterboxing AND the
   -// bottom-padding-black-bar that comes from using outer window dims. Returns
   -// null on chrome:// pages, any URL where executeScript can't inject, and a
   -// page that doesn't answer in time.
   -async function getViewport(tabId) {
   -  if (!tabId) return null;
   +// getUserMedia's min/max to these values eliminates the letterboxing an
   +// unpinned capture has (scaled to a ceiling resolution, padded with black).
   +// chrome:// pages, the Web Store and file:// without file access refuse the
   +// script, and so does a page that doesn't answer in time, so fall back to
   +// chrome.tabs.Tab.width/height: the same viewport, but in CSS pixels, which
   +// on a HiDPI display records at 1x rather than at the page's own dpr.
   +// Unpinned is worse than 1x: it letterboxes a 1280x713 tab to 800x600.
   +async function getViewport(tab) {
   +  if (!tab?.id) return null;
      try {
        const [{ result }] = await scriptWithTimeout({
   -      target: { tabId },
   +      target: { tabId: tab.id },
          func: () => ({
            width: Math.round(window.innerWidth * window.devicePixelRatio),
            height: Math.round(window.innerHeight * window.devicePixelRatio),
          }),
        });
        return result;
      } catch (e) {
        console.warn('[ViewShot] getViewport failed:', e);
   -    return null;
   +    return tab.width && tab.height ? { width: tab.width, height: tab.height } : null;
      }
    }
   ```

2. **`tests/capture-errors.test.js`**
   - **`TAB` (`:9`) gains `width: 1280, height: 713`** — what Chrome reports for the viewport this fixture already stands for. It is read only by the new tests; every existing assertion on `TAB` names its fields one by one.
   - **Two tests**, next to the existing dims test (`:757-779`):
     - a start on a page that refuses scripts is still sized to the tab (`loadBg({ scriptFails: true })`, assert `[start.width, start.height]` is `[1280, 713]`);
     - a tab Chrome reports no size for sends no dims (same, with `chrome.tabs.get` answering a tab without `width`/`height`; assert both are `undefined`, i.e. the offscreen document is left to its own ceiling rather than being pinned to `undefined`).

## Steps

1. **Change `getViewport` to take the tab and fall back to its dims** (`background.js:631`, `:653-668`), and update the two comments. → verify: `npm test` still passes 276 tests (`tests/shortcut-format.test.js:103` replaces `getViewport` wholesale, and the existing dims test covers the script path).
2. **Add `width`/`height` to `TAB`** (`tests/capture-errors.test.js:9`). → verify: `npm test` passes 276 tests, unchanged.
3. **Add the two tests.** → verify: `npm test` passes 278 tests; both fail with step 1 reverted.
4. **Check a real recording of a page that refuses scripts**, in Chrome 153.0.8010.48 on a disposable profile, window sized so the tab's viewport is a known non-4:3 size. WebM **and** GIF (the ticket's comment asks for both), on `chrome://version/`, the Web Store, and a `file://` page with "Allow access to file URLs" off. → verify: `ffprobe` reads each WebM at the tab's viewport size, `ffprobe`/`sips` reads each GIF at that aspect ratio capped to 720px wide, and no frame has black bars (sample the first and last frame's edge rows).
5. **Check an http page in the same run.** → verify: unchanged from today — the WebM is the viewport in physical pixels, the GIF is 720 wide at the viewport's aspect.

## Open questions

- **HiDPI.** On a display at `devicePixelRatio` 2, `Tab.width/height` is half the physical size the script path reports, so a chrome:// recording would come out 1280×713 where an http one in the same window comes out 2560×1426 — right framing, half the linear resolution. The ticket asks only that the recording be sized to the tab, and every measurement in it and in the repo was taken at dpr 1, so this plan takes the 1x recording (settled below, and filed as KAN-442). If that isn't good enough, the dpr has to come from somewhere else, and each source is a bigger change: the popup could send its own `devicePixelRatio` with `rec-start` (it matches the page's — measured below), but the `Alt+Shift+S` shortcut has no popup; or the worker could remember the dpr from the last `getViewport` that did answer (`result.width / tab.width`) and keep it in `chrome.storage.local`, which is a new piece of state and is empty until a scriptable page has been recorded.
- **Nothing else in the ticket is left open.** GIF needs no separate handling: it is scaled from the same stream (`offscreen.js`), so pinning the capture fixes both formats.

## Checked while planning

Chrome 153.0.8010.48, headed, a disposable profile, the repo loaded with CDP `Extensions.loadUnpacked` (a copy with `<all_urls>` added so `executeScript` runs without a click), `--window-size=1280,800`, one http page plus a `chrome://version/` and a Web Store tab. Read from the extension's own popup page:

| dpr | tab | `Tab.width/height` | `chrome.windows.get` | `innerWidth/innerHeight` |
|---|---|---|---|---|
| 1 | http | 1280 × 713 | 1280 × 800 | 1280 × 713 |
| 1 | `chrome://version/` | 1280 × 713 | 1280 × 800 | `Cannot access a chrome:// URL` |
| 1 | Web Store | 1280 × 713 | 1280 × 800 | `The extensions gallery cannot be scripted.` |
| 2 (`--force-device-scale-factor=2`) | http | 1280 × 713 | 1280 × 800 | 1280 × 713, `devicePixelRatio` 2 |
| 2 | `chrome://version/` | 1280 × 713 | 1280 × 800 | `Cannot access a chrome:// URL` |

- `Tab.width/height` is the web-contents viewport in CSS pixels, and Chrome reports it for the pages that refuse scripts too. The outer window (1280×800) is what `chrome.windows.get` gives, not `chrome.tabs.get` — so the ~150-200px black bar `764bd58` fixed is not what this fallback brings back.
- At `devicePixelRatio` 2, `Tab.width/height` does not scale: it stays in CSS pixels while the script path returns 2560×1426. That is the open question above.
- The popup's own `devicePixelRatio` matched the page's in both runs (1 and 2).
- No recording was made in these runs — step 4 is where the saved files get checked.

## Implementation and verification

Done as planned, with one departure from step 2 and one addition to step 3.

- **Step 1 — `background.js`.** `getViewport` takes the tab (`:654`), targets `tab.id` (`:658`), and its `catch` returns `{ width: tab.width, height: tab.height }` when the tab has them (`:670`). `startRecording` passes `tab` (`:631`). Both comments rewritten. → `npm test` passed 276, unchanged.
- **Step 2 — `TAB` gains `width: 1280, height: 713`** (`tests/capture-errors.test.js:9`). The plan expected 276 unchanged; **one existing test failed**, and its expectation was the old behaviour rather than a break: "a start gives up on a page that never answers, and still records" (`:1229-1249`) asserted the dims were `[undefined, undefined]`, "sized to a viewport that was never read". A page that never answers is one of the cases the fallback is for, so the assertion now reads `[TAB.width, TAB.height]`, "not sized to the tab the viewport read gave up on". → `npm test` passed 276.
- **Step 3 — the two tests** went in after the existing dims test, behind a banner comment, sharing a small `recStart(bg)` helper that puts the three fakes every recording start needs in place. → `npm test` passes **278**. With step 1's `catch` reverted to `return null`, the new "still sized to the tab" test and the step 2 test both fail; the "no size for" test passes either way, which is what a guard test does.
- **Steps 4 and 5 — real recordings**, Chrome 153.0.8010.48, `--headless=new`, disposable profile, `download.default_directory` in `Default/Preferences`, the changed repo loaded with `Extensions.loadUnpacked`, pages opened with `Target.createTarget({ forTab: true })` + `Target.activateTarget`, the popup opened with `Extensions.triggerAction` (one warm-up popup first), format set and Record/Stop clicked in the popup. Tab viewport 1280×713 at dpr 1. Every recording ran ~3 s.

  | page | WebM | GIF |
  |---|---|---|
  | http (control) | vp9 1278×712 | 720×401 |
  | `chrome://version/` | vp9 1278×712 | 720×401 |
  | Web Store | vp9 1278×712 | 720×401 |
  | `file://`, file access **on** | vp9 1278×712 | 720×401 |
  | `file://`, file access **off** (`developerPrivate`, `isAllowedFileSchemeAccess()` → `false`) | vp9 1278×712 | 720×401 |
  | `chrome://version/`, **fallback removed** (same run, extension reloaded) | **800×600** | **720×540** |

  - The last row is the before/after control: the ticket's numbers reproduce exactly in this harness without the fallback, and the same page records like an http page with it.
  - **No black bars.** The top and bottom 4 rows of the first and last frame of every file are page content: `#fd00fe`/`#c23cff` for the magenta-to-cyan test page, `#1f2123`/`#26282a` for `chrome://version/`, `#ffffff`/`#3f3f41` for the Web Store. Nothing reads as black.
  - **The fallback is what did it.** Asked directly in the worker after the run, `getViewport(tab)` returns `{width: 1280, height: 713}` for `chrome://version/`, the Web Store and `file://` — the pages where the script throws — and the same for http, where the script answers.
- **Nothing else changed.** `git status --short` lists only `background.js`, `tests/capture-errors.test.js` and this plan.

## The open question, settled

**The 1x fallback is the answer for this ticket. The dpr is KAN-442's.**

- **What the ticket asks for is done.** KAN-242 is about a recording that isn't sized to the tab — an 800×600 WebM and a 720×540 GIF with black bars for a 1280×713 tab. Every page it names now records at the tab's size with no bars, the same as an http page. Nothing in the ticket or its comment mentions resolution or HiDPI.
- **Neither way of getting the dpr fits inside this change.** The popup's `devicePixelRatio` matches the page's, but `Alt+Shift+S` has no popup, so the shortcut path would still be 1x — the same bug in half the entry points. Remembering the dpr from the last `getViewport` that answered means a new key in `chrome.storage.local` that is empty until a scriptable page has been recorded, so the first recording after an install or a worker restart would still be 1x. Both are their own piece of work with their own failure to verify, and the repo's habit is one ticket per behaviour.
- **1x is not a regression.** The fallback only runs where the old code sent no dims at all. On those pages this change goes from a letterboxed 800×600 to a correctly framed 1280×713; on a HiDPI display it would go from letterboxed 800×600 to a correctly framed 1x. No page records worse than it did before.

Filed as **KAN-442**, linked as blocked by KAN-242, with the dpr-2 measurements and both fix directions in it.

