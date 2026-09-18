# KAN-442: Recordings of pages the extension can't script come out at 1x on a HiDPI display

Ticket: https://prattsolutions.atlassian.net/browse/KAN-442 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-242, is Done.

## What the repo does now

Line numbers are from `fda67a4`, with a clean working tree.

- **The script path returns physical pixels.** `getViewport` (`background.js:657-672`) runs `window.innerWidth/innerHeight × window.devicePixelRatio` in the page (`:663-664`).
- **The fallback returns CSS pixels.** Its `catch` returns `{ width: tab.width, height: tab.height }` (`:670`). `chrome.tabs.Tab.width/height` does not scale with the device scale factor, so on a display at `devicePixelRatio` 2 these are half the physical size.
- **Nothing tells the two apart downstream.** `startRecording` sends `width: dims?.width, height: dims?.height` (`background.js:643`), and the offscreen document pins `minWidth/maxWidth/minHeight/maxHeight` to whatever arrives (`offscreen.js:63-65`). A fallback recording on a HiDPI display is therefore captured at 1x.
- **No dpr is available to the worker.** `self.devicePixelRatio` is `undefined` in the service worker (measured, see "Checked while planning"). The `rec-start` message from the popup carries `{ type, streamId, tabId, opts }` (`popup.js:136`) and no dpr. `chrome.storage.local` holds only `rec` and `opts`. The full-page screenshot path has its own `m.dpr` (`background.js:318, 357, 366`) from `measurePage`, which is a separate scripted read and needs the page to answer.
- **Both sources the ticket names have a gap**, as it says: the popup's `devicePixelRatio` doesn't cover `Alt+Shift+S` (`chrome.commands.onCommand` mints the stream id and calls `startRecording` directly, `background.js:60-61`), and a dpr remembered from the last answered `getViewport` is a new stored key that is empty until a scriptable page has been recorded.
- **There is a third source the ticket doesn't name: the offscreen document.** Measured at `--force-device-scale-factor=2`, its `devicePixelRatio` is **2** — the same as the page's and the popup's. It is available on both entry points, needs no new stored state, and the document already exists by the time the dims are read: `startRecording` calls `ensureOffscreen()` (`background.js:608`) before `getViewport` (`:632`), and the offscreen document is the context that calls `getUserMedia` (`offscreen.js:71`).
- **Tests:** `npm test` passes 278 tests.
  - `loadOffscreen` (`tests/capture-errors.test.js:496-545`) fakes `getUserMedia` as `async () => stream` (`:510`) and **throws its argument away**, so no test sees the `mandatory` block today.
  - Its vm context has no `devicePixelRatio`.
  - `tests/shortcut-format.test.js:103` replaces `getViewport` wholesale with `async () => ({ width: 1280, height: 720 })`.

## Change

Three files change: `background.js`, `offscreen.js` and `tests/capture-errors.test.js`.

The fallback's dims stay in CSS pixels on the wire and are scaled where a real `devicePixelRatio` exists. The script path is left alone: its dims already are physical pixels, and its `devicePixelRatio` includes page zoom, which the offscreen document's does not (see "Checked while planning").

1. **`background.js`**
   - **The `catch` marks its dims as CSS pixels** (`:670`): `{ width: tab.width, height: tab.height, cssPx: true }`. `dims` is only read for `width`/`height` (`:643`) and logged (`:645`), so nothing else sees the extra field.
   - **`startRecording` passes the marker through** (`:641-644`).
   - **The comment at `:653-656`** no longer says the fallback records at 1x; it says the offscreen document scales it.

   ```diff
   @@ -650,10 +650,10 @@
    // getUserMedia's min/max to these values eliminates the letterboxing an
    // unpinned capture has (scaled to a ceiling resolution, padded with black).
    // chrome:// pages, the Web Store and file:// without file access refuse the
    // script, and so does a page that doesn't answer in time, so fall back to
   -// chrome.tabs.Tab.width/height: the same viewport, but in CSS pixels, which
   -// on a HiDPI display records at 1x rather than at the page's own dpr.
   -// Unpinned is worse than 1x: it letterboxes a 1280x713 tab to 800x600.
   +// chrome.tabs.Tab.width/height: the same viewport, but in CSS pixels. Those
   +// are marked cssPx so the offscreen document can scale them by its own
   +// devicePixelRatio, which is the display's - the worker has none of its own.
    async function getViewport(tab) {
   @@ -667,7 +667,7 @@
      } catch (e) {
        console.warn('[ViewShot] getViewport failed:', e);
   -    return tab.width && tab.height ? { width: tab.width, height: tab.height } : null;
   +    return tab.width && tab.height ? { width: tab.width, height: tab.height, cssPx: true } : null;
      }
    }
   @@ -640,7 +640,7 @@
      await chrome.runtime.sendMessage({
        type: 'rec-start-offscreen', streamId, format: opts.format,
   -    width: dims?.width, height: dims?.height,
   +    width: dims?.width, height: dims?.height, cssPx: dims?.cssPx,
      });
   ```

2. **`offscreen.js`**
   - **The dispatch passes `msg.cssPx`** (`:25`).
   - **`startRecording` takes it and scales before pinning** (`:51`, `:63-65`). Physical pixels are what tabCapture streams, so CSS-pixel dims are multiplied by this document's `devicePixelRatio` — the display's scale factor, which is what `Tab.width/height` is missing.

   ```diff
   @@ -25,1 +25,1 @@
   -  else if (msg?.type === 'rec-start-offscreen') { log('rec-start-offscreen, format=', msg.format, 'dims=', msg.width, 'x', msg.height); startRecording(msg.streamId, msg.format, msg.width, msg.height).catch(onRecError); }
   +  else if (msg?.type === 'rec-start-offscreen') { log('rec-start-offscreen, format=', msg.format, 'dims=', msg.width, 'x', msg.height, msg.cssPx ? '(css px)' : ''); startRecording(msg.streamId, msg.format, msg.width, msg.height, msg.cssPx).catch(onRecError); }
   @@ -51,1 +51,1 @@
   -async function startRecording(streamId, format, width, height) {
   +async function startRecording(streamId, format, width, height, cssPx) {
   @@ -62,4 +62,10 @@
      const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
   +  // The worker's fallback dims are chrome.tabs.Tab.width/height, which is the
   +  // viewport in CSS pixels: it doesn't scale with the display. tabCapture
   +  // streams physical pixels, so pinning those raw records a HiDPI tab at 1x.
   +  // This document has no display of its own, but its devicePixelRatio is the
   +  // display's scale factor all the same - and unlike the page's, it doesn't
   +  // move with page zoom, which is what Tab.width/height needs.
   +  if (cssPx && width && height) { width = Math.round(width * devicePixelRatio); height = Math.round(height * devicePixelRatio); }
      if (width && height) {
        Object.assign(mandatory, { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height });
      }
   ```

3. **`tests/capture-errors.test.js`**
   - **`loadOffscreen` keeps what `getUserMedia` was asked for** (`:510`) and exposes it, and its vm context gains `devicePixelRatio: 2`.
   - **Three tests**, next to the existing dims tests (`:784-812`) and the offscreen start tests:
     - the worker marks fallback dims as CSS pixels: `loadBg({ scriptFails: true })`, the `rec-start-offscreen` it sends carries `cssPx: true` with `[TAB.width, TAB.height]`;
     - a start told its dims are CSS pixels pins `getUserMedia` to `width × devicePixelRatio`: `1280 × 2`, `713 × 2`;
     - a start not told that pins the dims as they arrived, so the script path is untouched by this change.

## Steps

1. **`background.js`: mark the fallback dims and pass the marker through** (`:670`, `:643`), and update the comment at `:653-656`. → verify: `npm test` still passes 278 tests.
2. **`offscreen.js`: take `cssPx` and scale by `devicePixelRatio` before pinning** (`:25`, `:51`, `:63`). → verify: `npm test` still passes 278.
3. **`tests/capture-errors.test.js`: record the `getUserMedia` constraints in `loadOffscreen` and add `devicePixelRatio: 2` to its context.** → verify: `npm test` passes 278, unchanged.
4. **Add the three tests.** → verify: `npm test` passes 281; each fails with its own half of steps 1-2 reverted.
5. **Check a real recording at a forced HiDPI scale**, Chrome 153.0.8010.48, disposable profile, extension loaded with `Extensions.loadUnpacked`, `--window-size=1280,800 --force-device-scale-factor=2`, so the tab is 1280×713 CSS / 2560×1426 physical. WebM and GIF on `chrome://version/`, the Web Store and a `file://` page with file access off. → verify: `ffprobe` reads each WebM at ~2560×1426 rather than the ~1280×713 this ticket is about, each GIF at 720 wide with the same aspect, and no frame has black bars at its edges.
6. **Check the http control in the same run.** → verify: an http page still records at ~2560×1426 — the script path is unchanged — and a scriptable page at 150% page zoom still records at ~2560×1426, not half of it.
7. **Check dpr 1 is unchanged**, same harness without `--force-device-scale-factor`. → verify: every page in step 5 still records 1278×712 WebM / 720×401 GIF, as KAN-242 left them.
8. **Check that nothing else changed.** → verify: `git status --short` lists only `background.js`, `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None. The ticket names the bug and two candidate sources for the dpr; this plan uses a third that has neither source's gap, and the "Checked while planning" measurements below are what rule the other two out.

**One limitation to record rather than solve:** an offscreen document is not on a display, so on a multi-monitor setup with different scale factors per display, its `devicePixelRatio` may not be the scale of the display the recorded window is on. It was measured under `--force-device-scale-factor`, which is global, so this run cannot tell "follows the window's display" from "follows the global scale". A mismatch there would record at the other display's scale — still the right framing, and still strictly better than the 1x this ticket is about. The popup route has the same exposure on the shortcut path, and the remembered-dpr route has it on every path.

## Checked while planning

Chrome 153.0.8010.48, headed, disposable profile, the repo loaded with CDP `Extensions.loadUnpacked`, `--window-size=1280,800 --force-device-scale-factor=2`, read from the worker, the popup and the offscreen document:

| context | `devicePixelRatio` |
|---|---|
| the recorded page | 2 |
| the popup | 2 |
| **the offscreen document** (after `ensureOffscreen()`) | **2** |
| the service worker | `undefined` (no such global) |

- The offscreen document also reports `screen.width/height` as 2560×1440, i.e. the real display.
- **Page zoom, on a scriptable page** (`chrome.tabs.setZoom`, the same tab each time):

  | zoom | `Tab.width` | `getViewport().width` | ratio |
  |---|---|---|---|
  | 1 | 1280 | 2560 | 2 |
  | 1.5 | 1280 | 2559 | 1.999 |
  | 2 | 1280 | 2560 | 2 |

  `Tab.width` doesn't move with zoom and the physical capture size doesn't either, so `Tab.width × display scale` is right at every zoom — which is why only the fallback's dims are scaled. The page's own `devicePixelRatio` does include zoom (that is why `innerWidth × devicePixelRatio` stays at 2560), so scaling the script path by the offscreen document's dpr instead would have halved a 200%-zoomed recording.
- No recording was made in this run — steps 5-7 are where the saved files get checked.

## Implementation and verification

Done as planned, with one addition to step 4.

- **Step 1 — `background.js`.** The `catch` returns `{ width: tab.width, height: tab.height, cssPx: true }` (`:670`), `startRecording` sends `cssPx: dims?.cssPx` (`:643`), and the comment at `:653-655` says the offscreen document scales them. → `npm test` passed 278, unchanged.
- **Step 2 — `offscreen.js`.** The dispatch passes `msg.cssPx` and logs `(css px)` (`:25`), `startRecording` takes it (`:51`), and a single line above the existing pin multiplies by `devicePixelRatio` (`:69`). → `npm test` passed 278, unchanged.
- **Step 3 — the harness.** `loadOffscreen`'s `getUserMedia` fake keeps what it was asked for in a new `asked` array, exposed on the handle; the context gains `devicePixelRatio: 2`. → `npm test` passed 278, unchanged.
- **Step 4 — the tests.** **Four**, not three: the plan's three plus a worker-side guard that a page which answers keeps physical pixels and is *not* marked `cssPx`, so the two halves are pinned from both sides. They share a small `pinned(o)` helper that reads the `mandatory` block out of `asked[0]`. → `npm test` passes **282**. With step 1's `cssPx: true` removed, "says its dims are CSS pixels" fails; with step 2's scaling line removed, "pins the capture to the display scale" fails.
- **Steps 5-7 — real recordings**, Chrome 153.0.8010.48, `--headless=new`, disposable profile, `download.default_directory` in `Default/Preferences`, the changed repo loaded with `Extensions.loadUnpacked`, popup driven with `Extensions.triggerAction`, ~3 s per recording, `ffprobe` on each file. Window 1280×800, so the tab is 1280×713 CSS.

  | run | page | WebM | GIF |
  |---|---|---|---|
  | **dpr 2** | http (control) | 2560×1426 | 720×401 |
  | | `chrome://version/` | **2560×1426** | 720×401 |
  | | Web Store | **2560×1426** | 720×401 |
  | | `file://`, file access on | 2560×1426 | 720×401 |
  | | `file://`, file access **off** | **2560×1426** | 720×401 |
  | | http at 150% page zoom | 2558×1424 | — |
  | **dpr 2, scaling line removed** | `chrome://version/` | **1278×712** | 720×401 |
  | **dpr 1** | http, `chrome://version/`, Web Store, `file://` | 1278×712 | 720×401 |

  - The "scaling line removed" row is the before/after control, taken in the same browser with the extension reloaded: 1278×712 is the 1x this ticket is about, and 2560×1426 is the same page with the change.
  - **The zoomed control holds.** A scriptable page at 150% zoom records 2558×1424, not half of it — the script path is untouched, as intended. (2558 rather than 2560 is the rounding of `innerWidth` 853.33 × dpr 3.)
  - **GIF is unchanged everywhere**, at 720×401 in every run: it is capped at 720 px wide, which is below both 1280 and 2560, so only the WebM/MP4 path can show the difference. The GIF was already the right aspect after KAN-242.
  - **No black bars.** The top and bottom 4 rows of the first and last frame of all 20 files are page content — `#fd00fe`/`#c23cff` for the test page, `#1f2123`/`#26282a` for `chrome://version/`, `#ffffff`/`#3f3f41` for the Web Store.
- **Step 8 — nothing else changed.** `git status --short` lists only `background.js`, `offscreen.js`, `tests/capture-errors.test.js` and this plan.

The limitation recorded under "Open questions" is unchanged and untested: every run here forced one global scale factor, so a second display with a different scale is still unknown.
