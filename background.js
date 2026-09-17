const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The `capture` branch answers synchronously, before it starts any work. The
// popup closes itself on Region, and a sendMessage whose sender is torn down in
// the same turn is dropped while the worker is cold-starting - the wake is
// still in flight when the frame goes away, so the capture never runs at all. A
// warm worker wins that race, which is why it only failed sometimes: the
// "press Region twice" bug. The popup awaits this ack before window.close().
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'capture') { sendResponse(true); runCapture(msg.mode, msg.opts, msg.tabId).catch(captureFailed); }
  else if (msg?.type === 'rec-start') {
    // Answered once the start has worked or failed: the popup enables Stop
    // from `rec`, and a start that fails before `rec` is written leaves
    // nothing there for it to see.
    const start = recStartGate
      .then(() => startRecording(msg.streamId, msg.opts, msg.tabId))
      .then(() => sendResponse(true), (e) => { console.error('[ViewShot]', e); sendResponse(false); return recFailed(); });
    recStartGate = start.catch(() => {}); // one start's failure must not stall the next
    return true;
  }
  else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
  // MAX only when the cap is what ended the recording: a Stop that landed
  // first has already saved the file and cleared the badge, and a MAX over
  // that reports trouble with a recording that is finished.
  else if (msg?.type === 'rec-cap-hit') stopRecording().then((stopped) => { if (stopped) return flashBadge('MAX'); }).catch((e) => console.error('[ViewShot]', e));
  else if (msg?.type === 'rec-failed') recFailed();
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  const map = { 'capture-visible': 'visible', 'capture-fullpage': 'fullpage', 'capture-region': 'region' };
  if (map[cmd]) runCapture(map[cmd], await getOpts(), tab?.id).catch(captureFailed);
});

// `rec` is kept in chrome.storage.local so a recording outlives a worker
// restart. The recording itself lives in the offscreen document, which is gone
// once Chrome restarts or the extension is installed, updated or reloaded, so
// after either of those nothing is recording, whatever the key says.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('rec'));
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('rec'));

async function getOpts() {
  const { opts } = await chrome.storage.local.get('opts');
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (o.filename === 'shot-{date}') o.filename = DEFAULTS.filename; // migrate old default
  return o;
}

// The popup and the shortcuts say which tab they mean. Asking Chrome for the
// active tab is only the fallback: from the worker, that query has come back
// empty (headless Chrome, while the first popup after a load was open).
async function getActiveTab(tabId) {
  if (tabId) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// chrome.tabs.captureVisibleTab is capped at MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
// (2/sec, extension-wide) and rejects rather than queueing when it is exceeded.
// Back-to-back shots land inside that window constantly - a double press, a
// Region right after a Visible, the first slice of a stitch following an
// earlier capture - so every call goes through this gate: one at a time, spaced
// out, and retried once if it still comes back over quota.
const CAPTURE_MIN_GAP_MS = 550;
const CAPTURE_TIMEOUT_MS = 5000;
let captureGate = Promise.resolve();
let lastCaptureAt = 0;

function captureVisible(windowId) {
  const shot = captureGate.then(async () => {
    const wait = CAPTURE_MIN_GAP_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    try {
      return await captureWithTimeout(windowId);
    } catch (e) {
      if (!/quota/i.test(e?.message || '')) throw e;
      await sleep(CAPTURE_MIN_GAP_MS);
      return await captureWithTimeout(windowId);
    } finally {
      lastCaptureAt = Date.now();
    }
  });
  captureGate = shot.catch(() => {}); // one caller's failure must not stall the next
  return shot;
}

// Chrome has been seen never to answer a captureVisibleTab call. Every capture
// queued behind it then waited until the worker restarted, with the page left
// scrolled and its scrollbar and headers hidden. So a call that takes longer
// than CAPTURE_TIMEOUT_MS fails instead: the page is put back, the badge
// flashes, and the next capture goes ahead.
function captureWithTimeout(windowId) {
  return Promise.race([
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
    sleep(CAPTURE_TIMEOUT_MS).then(() => { throw new Error(`captureVisibleTab did not answer within ${CAPTURE_TIMEOUT_MS / 1000}s`); }),
  ]);
}

// executeScript answers only once the page has run the script. A recording
// start waits on two of these, and every later start waits on it
// (recStartGate), so a page that never runs them (its main thread blocked, say)
// would hold up all of them for good. So a call that takes longer than
// SCRIPT_TIMEOUT_MS fails instead, the way a page that refuses scripts does.
// The deadline is short because the stream id the popup minted for the start
// only works for about 10 s: Chrome 152 took one used at 9.2 s and refused one
// used at 10.3 s. Two 2 s deadlines leave a start, and one queued behind it,
// time to use theirs.
const SCRIPT_TIMEOUT_MS = 2000;
function scriptWithTimeout(injection) {
  return Promise.race([
    chrome.scripting.executeScript(injection),
    sleep(SCRIPT_TIMEOUT_MS).then(() => { throw new Error(`executeScript did not answer within ${SCRIPT_TIMEOUT_MS / 1000}s`); }),
  ]);
}

// A capture has no UI thread to report into: the popup has closed on Region and
// never existed for the keyboard shortcuts. So a failure flashes the badge -
// silence was indistinguishable from a capture that simply did nothing, which
// is what "Cannot access a chrome:// URL" looked like from the outside.
function captureFailed(e) {
  console.error('[ViewShot]', e);
  flashBadge('!').catch(() => {});
}

async function runCapture(mode, opts, tabId) {
  const tab = await getActiveTab(tabId);
  if (!tab) throw new Error('No tab to capture'); // flash the badge rather than do nothing
  await cancelRegion(tab); // an abandoned overlay would otherwise dim this shot
  let png;
  if (opts.hideScrollbar) { await setScrollbarHidden(tab, true); await sleep(50); /* let the bar repaint out */ }
  try {
    if (mode === 'visible') png = await captureVisible(tab.windowId);
    else if (mode === 'fullpage') png = await captureFullPage(tab);
    else if (mode === 'region') png = await captureRegion(tab);
  } finally {
    if (opts.hideScrollbar) await setScrollbarHidden(tab, false); // restore
  }
  if (!png) return;

  if (opts.toClipboard) {
    await copyImage(png);
  } else {
    const { dataUrl, ext } = await encode(png, opts);
    await chrome.downloads.download({ url: dataUrl, filename: buildName(opts.filename, ext, tab), saveAs: false });
  }
}

// ---- re-encode to chosen format/quality via OffscreenCanvas ----
async function encode(pngDataUrl, opts) {
  const mimes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  // The shortcuts pass the stored format as-is, and the popup can leave that
  // on webm, mp4 or gif. Those still get a PNG, so name the file .png as well
  // rather than asking for PNG data to be saved as .webm, .mp4 or .gif.
  const ext = mimes[opts.format] ? opts.format : 'png';
  const mime = mimes[ext];
  const bmp = await createImageBitmap(await (await fetch(pngDataUrl)).blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob(mime === 'image/png' ? { type: mime } : { type: mime, quality: opts.quality });
  return { dataUrl: await blobToDataURL(blob), ext };
}

// The document is not always what scrolls. `html,body{height:100%}` plus any
// non-visible overflow (e.g. overflow-x:hidden, which forces overflow-y to
// auto) pins <html> to the viewport height and makes <body> its own scroll
// container. window.scrollTo() is then a silent no-op and window.scrollY
// always reads 0, so the stitch captures one unmoved viewport over and over.
// These two run in the page. executeScript serializes them standalone, so they
// can't share a helper and each repeats the same three-line pick.
function measurePage() {
  const de = document.documentElement, b = document.body;
  const el = de.scrollHeight > de.clientHeight + 1 ? de
           : (b && b.scrollHeight > b.clientHeight + 1) ? b
           : (document.scrollingElement || de);
  return {
    total: el.scrollHeight,
    vh: window.innerHeight,
    vw: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    prevY: el.scrollTop,
  };
}

function scrollAndReport(to) {
  const de = document.documentElement, b = document.body;
  const el = de.scrollHeight > de.clientHeight + 1 ? de
           : (b && b.scrollHeight > b.clientHeight + 1) ? b
           : (document.scrollingElement || de);
  // 'instant' overrides a page's `scroll-behavior: smooth` (Bootstrap 5,
  // Tailwind's scroll-smooth). Without it the scroll animates, the read below
  // still sees the old offset, and the stitch stops after the first screen.
  el.scrollTo({ top: to, behavior: 'instant' });
  window.scrollTo({ left: 0, top: to, behavior: 'instant' }); // no-op unless the document itself is the scroller
  return el.scrollTop;
}

// Scroll to y and report where the page ACTUALLY landed. The caller stitches
// at the returned offset rather than the requested one, so a page that clamps,
// animates, or ignores the scroll still produces a correctly aligned image.
async function scrollPageTo(tab, y) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: scrollAndReport, args: [y],
  });
  return result || 0;
}

// ---- full page: scroll the viewport and stitch ----
async function captureFullPage(tab) {
  const [{ result: m }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: measurePage,
  });

  const canvas = new OffscreenCanvas(Math.round(m.vw * m.dpr), Math.round(m.total * m.dpr));
  const ctx = canvas.getContext('2d');
  const positions = [...new Set(
    Array.from({ length: Math.ceil(m.total / m.vh) }, (_, i) => Math.min(i * m.vh, Math.max(0, m.total - m.vh)))
  )];

  let hid = false, landed = 0;
  // finally: a slice that throws part-way must still put the page back, not
  // leave it scrolled to where the stitch stopped with its headers hidden.
  try {
    for (let i = 0; i < positions.length; i++) {
      const actual = await scrollPageTo(tab, positions[i]);
      // The page refused to advance (unscrollable, or a scroller we can't drive).
      // Stop rather than stack the same viewport down the canvas.
      if (i > 0 && actual <= landed) break;
      landed = actual;
      // Keep fixed/sticky elements (pinned headers, banners) on the FIRST slice
      // only; hide them on later slices so they aren't stitched in repeatedly.
      if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
      await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
      const url = await captureVisible(tab.windowId);
      // captureVisibleTab shoots whichever tab is showing in the window. If the
      // user switched tabs (or moved this one out) mid-stitch, this slice is
      // another tab: stop rather than stitch it in.
      const now = await chrome.tabs.get(tab.id);
      if (!now.active || now.windowId !== tab.windowId) throw new Error('Full page stopped: another tab is now showing');
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      ctx.drawImage(bmp, 0, Math.round(actual * m.dpr)); // where it really is, not where we asked
    }
  } finally {
    if (hid) await setFixedHidden(tab, false); // restore
    await scrollPageTo(tab, m.prevY);
  }

  // Trim to what was actually stitched, so an early stop yields a short correct
  // image instead of a tall one padded with blank space.
  const filled = Math.min(canvas.height, Math.round((landed + m.vh) * m.dpr));
  let out = canvas;
  if (filled > 0 && filled < canvas.height) {
    out = new OffscreenCanvas(canvas.width, filled);
    out.getContext('2d').drawImage(canvas, 0, 0);
  }
  return await blobToDataURL(await out.convertToBlob({ type: 'image/png' }));
}

// Temporarily hide position:fixed / position:sticky elements (the cause of
// repeated headers/banners in scroll-stitch), then restore them afterward.
async function setFixedHidden(tab, hide) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (doHide) => {
      if (doHide) {
        const list = [];
        for (const el of document.querySelectorAll('*')) {
          const pos = getComputedStyle(el).position;
          if (pos === 'fixed' || pos === 'sticky') { list.push([el, el.style.visibility]); el.style.visibility = 'hidden'; }
        }
        window.__shotHidden = list;
      } else if (window.__shotHidden) {
        for (const [el, v] of window.__shotHidden) el.style.visibility = v;
        window.__shotHidden = null;
      }
    },
    args: [hide],
  });
}

// Temporarily hide the page scrollbar(s) so they don't show up in the shot.
// Uses a removable <style> rather than overflow:hidden so scrolling still
// works (the full-page mode relies on scrolling to stitch slices).
async function setScrollbarHidden(tab, hide) {
  // Cosmetic, so an uninjectable page must not be where the capture dies: on a
  // chrome:// URL this threw "Cannot access a chrome:// URL" before the shutter
  // was ever reached, and such pages show no page scrollbar to hide anyway.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (doHide) => {
        const ID = '__shotHideScrollbar';
        const existing = document.getElementById(ID);
        if (doHide) {
          if (existing) return;
          const style = document.createElement('style');
          style.id = ID;
          style.textContent =
            '::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}html{scrollbar-width:none!important}';
          (document.head || document.documentElement).appendChild(style);
        } else if (existing) {
          existing.remove();
        }
      },
      args: [hide],
    });
  } catch { /* chrome:// and friends refuse injection */ }
}

// ---- region: overlay drag-select, then crop the visible capture ----

// Resolve of the selection currently awaiting a drag, if any.
let cancelPendingRegion = null;

// Clicking Region and then walking away leaves the dimmed overlay on the page:
// it would be stitched into the next Visible/Full page shot, and a second
// Region click would no-op against its re-entrancy guard. Tear it down first.
// The page-side teardown sends no message (see region.js), so the abandoned
// promise is settled here instead of racing the next capture's listener.
async function cancelRegion(tab) {
  cancelPendingRegion?.(null);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (window.__shotRegionCancel) window.__shotRegionCancel(); },
    });
  } catch { /* chrome:// and friends refuse injection, and hold no overlay */ }
}

async function captureRegion(tab) {
  const resultP = new Promise((resolve) => {
    const done = (rect) => {
      chrome.runtime.onMessage.removeListener(onMsg);
      cancelPendingRegion = null;
      resolve(rect);
    };
    const onMsg = (msg) => { if (msg?.type === 'shot-region') done(msg.rect); };
    chrome.runtime.onMessage.addListener(onMsg);
    cancelPendingRegion = done;
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['region.js'] });
  const rect = await resultP;
  if (!rect) return null;

  await sleep(80); // let the overlay clear before capturing
  const bmp = await createImageBitmap(await (await fetch(await captureVisible(tab.windowId))).blob());
  const d = rect.dpr;
  const canvas = new OffscreenCanvas(Math.round(rect.w * d), Math.round(rect.h * d));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, rect.x * d, rect.y * d, rect.w * d, rect.h * d, 0, 0, rect.w * d, rect.h * d);
  return await blobToDataURL(await canvas.convertToBlob({ type: 'image/png' }));
}

// ---- offscreen document (shared by clipboard + recording; only one allowed) ----
let offscreenCreating;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  console.log('[ViewShot] ensureOffscreen hasDocument=', has);
  if (has) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD', 'USER_MEDIA'],
      justification: 'Write screenshots to the clipboard and record the tab to video',
    });
  }
  // finally, not a bare assignment: a rejected createDocument would otherwise
  // stay cached here and every later call would re-await the same rejection.
  try { await offscreenCreating; } finally { offscreenCreating = null; }
  // createDocument can resolve just before the page's message listener is live,
  // so the first rec-start would be dropped. Ping until it answers (the cause
  // of the "press record twice to start" bug). One that never answers is a
  // failure, not a document to carry on with.
  for (let i = 0; i < 40; i++) {
    try {
      if ((await chrome.runtime.sendMessage({ type: 'offscreen-ping' })) === 'pong') {
        console.log('[ViewShot] offscreen document ready');
        return;
      }
    } catch {}
    await sleep(25);
  }
  throw new Error('The offscreen document never answered');
}

// An offscreen document shares its renderer process — and therefore its Blink
// main thread — with the action popup, and only AUDIO_PLAYBACK documents ever
// expire on their own. Leaving one open means every popup open competes with
// whatever that document is doing, and Chrome does not paint the popup until
// its onload completes. So close it the moment the work is finished.
async function closeOffscreen() {
  const { rec } = await chrome.storage.local.get('rec');
  if (rec) return; // a recording lives in there; closing would kill it
  try {
    if (!(await chrome.offscreen.hasDocument())) return;
    // `rec` is removed before the document hears about the Stop, and the
    // recording is only saved after that: a GIF is encoded first, which can take
    // a while, and the file then downloads from a URL the document owns. Closing
    // the document in between lost the recording, so ask it first. One that
    // can't answer has no recording in it.
    if ((await chrome.runtime.sendMessage({ type: 'offscreen-busy' }).catch(() => false)) === true) return;
    await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn('[ViewShot] closeDocument failed:', e);
  }
}

// ---- clipboard via the offscreen document ----
async function copyImage(pngDataUrl) {
  // The offscreen listener answers only after the clipboard write resolves, so
  // awaiting here means it is safe to tear the document down straight after.
  // A new document that never answered is closed too.
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: 'shot-clipboard', dataUrl: pngDataUrl });
  } finally {
    await closeOffscreen();
  }
}

// ---- record the visible tab to WebM/MP4/GIF via the offscreen document ----
const log = (...a) => console.log('[ViewShot]', ...a);

async function flashBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
  await chrome.action.setBadgeText({ text });
  // Back to REC, not blank, while a recording is still running: a screenshot
  // can fail in the middle of one.
  setTimeout(async () => {
    const { rec } = await chrome.storage.local.get('rec');
    await chrome.action.setBadgeText({ text: rec ? 'REC' : '' });
  }, 3000);
}

// A start that failed, here or in the offscreen document: nothing is
// recording, so drop `rec` (an open popup follows it) and flash ! over REC.
function recFailed() {
  return chrome.storage.local.remove('rec').then(() => flashBadge('!'));
}

// Starts go through this gate one at a time, each once the one before has
// finished, cleanup included. startRecording checks `rec` and writes it only
// after several awaits, so two starts that overlapped both got past the check,
// and a second one that then failed removed the `rec` the first had written.
let recStartGate = Promise.resolve();

async function startRecording(streamId, opts, tabId) {
  log('rec-start received, opts=', opts, 'streamId=', streamId);
  // One recording at a time. Starting another would overwrite `rec`, and the
  // offscreen document would lose the recording already running.
  const { rec } = await chrome.storage.local.get('rec');
  if (rec) { console.warn('[ViewShot] a recording is already running; not starting another'); return; }
  // The stream id is minted in the popup (under its user gesture); we just wire
  // it to the offscreen recorder, which is the only context with media APIs.
  const tab = await getActiveTab(tabId); // the tab the popup minted the stream id for
  await ensureOffscreen();
  log('offscreen ready, sending rec-start-offscreen, format=', opts.format);
  // Persist enough to name the file at stop time, surviving a worker restart.
  await chrome.storage.local.set({ rec: { url: tab?.url, title: tab?.title, format: opts.format, filename: opts.filename } });
  await chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
  await chrome.action.setBadgeText({ text: 'REC' });
  // Play the edge-glow blip BEFORE starting the recorder so its animation
  // doesn't contaminate the first second of the output. On chrome:// pages
  // where injection fails, blipRecordingIndicator returns immediately and we
  // skip straight to recording — the badge + Chrome's own blue capture border
  // are still visible to the user as recording-active cues.
  const blipOver = tab ? await blipRecordingIndicator(tab.id) : 0;
  // Query the captured tab's ACTUAL viewport (innerWidth/innerHeight) — NOT
  // chrome.tabs.Tab.width/height, which reports the outer window dims (tab
  // strip + omnibox + bookmarks bar + status bar all included). tabCapture
  // only captures the web-contents viewport, so pinning min/max to the outer
  // window dims makes Chrome pad the difference with black (~150-200px bar
  // at the bottom). innerWidth/innerHeight × devicePixelRatio gives the
  // physical pixels that match what tabCapture actually delivers.
  const dims = await getViewport(tab?.id);
  // A blip that ran out of time may have shown its glow just before its
  // deadline, and the wait for it to fade was skipped along with the blip.
  // The viewport read above has already used up part of that wait.
  if (blipOver > Date.now()) await sleep(blipOver - Date.now());
  // Stop removes `rec`, and it can land while the blip or the viewport read is
  // still under way: up to two deadlines on a page that never answers. A
  // recorder started after that would run on with nothing that can stop it.
  if (!(await chrome.storage.local.get('rec')).rec) { console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
  await chrome.runtime.sendMessage({
    type: 'rec-start-offscreen', streamId, format: opts.format,
    width: dims?.width, height: dims?.height,
  });
  log('rec-start-offscreen sent, dims=', dims);
}

// Get the captured tab's real viewport in PHYSICAL pixels (innerWidth/Height
// × devicePixelRatio). This is what tabCapture actually streams — pinning
// getUserMedia's min/max to these values eliminates both letterboxing AND the
// bottom-padding-black-bar that comes from using outer window dims. Returns
// null on chrome:// pages, any URL where executeScript can't inject, and a
// page that doesn't answer in time.
async function getViewport(tabId) {
  if (!tabId) return null;
  try {
    const [{ result }] = await scriptWithTimeout({
      target: { tabId },
      func: () => ({
        width: Math.round(window.innerWidth * window.devicePixelRatio),
        height: Math.round(window.innerHeight * window.devicePixelRatio),
      }),
    });
    return result;
  } catch (e) {
    console.warn('[ViewShot] getViewport failed:', e);
    return null;
  }
}

// A quick green "blip" — a soft glow hugging the viewport edges that fades in
// and out, the way Claude tints the tab borders when it takes control. Just an
// edge hue, no full-screen flash. Pointer-events:none so it never blocks the page.
// Must be awaited and finish BEFORE MediaRecorder.start(), otherwise the blip
// itself shows up in the first ~Ns of the recorded output (canonical Screenity
// pattern: animate UI cue → wait for it to fade → start capture on clean DOM).
const BLIP_ANIM_MS = 650;
// Answers the moment the page's glow is over, for a glow the page showed just
// before its deadline: 0 whenever the wait below has already covered it.
async function blipRecordingIndicator(tabId) {
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS; // when the start stops waiting for the script
  try {
    await scriptWithTimeout({
      target: { tabId },
      func: (animMs, deadline) => {
        // The start stops waiting for this script at its deadline and goes on to
        // the recorder, so a glow shown after that would end up in the recording.
        if (Date.now() > deadline) return;
        const o = document.createElement('div');
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-shadow:inset 0 0 44px 10px rgba(57,211,83,.6);opacity:0;';
        (document.body || document.documentElement).appendChild(o);
        o.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: animMs, easing: 'ease-out' })
          .onfinish = () => o.remove();
      },
      args: [BLIP_ANIM_MS, deadline],
    });
  } catch (e) {
    // chrome:// URLs and similar refuse executeScript — skip the wait so we
    // don't delay the recording start for nothing. A page that doesn't answer
    // in time is skipped the same way.
    // Expected on those pages, so only a warning: chrome://extensions lists
    // every console.error from the worker as an extension error.
    console.warn('[ViewShot] blip failed:', e);
    // A page that refuses scripts fails at once and shows nothing. A page that
    // ran out of time may have run the script just before its deadline, so its
    // glow can still be on screen: the start has to hold the recorder until the
    // animation is over.
    return Date.now() < deadline ? 0 : deadline + BLIP_ANIM_MS + 50;
  }
  await new Promise((r) => setTimeout(r, BLIP_ANIM_MS + 50));
  return 0;
}

async function stopRecording() {
  log('rec-stop received');
  const { rec } = await chrome.storage.local.get('rec');
  // Answered, so the frame cap can tell whether it is the one that ended the
  // recording: false means a Stop got here first.
  if (!rec) { console.warn('[ViewShot] stop with no active recording'); return false; }
  const filename = buildName(rec.filename, rec.format, { url: rec.url, title: rec.title });
  log('stopping, will save as', filename);
  await chrome.storage.local.remove('rec');
  await chrome.action.setBadgeText({ text: '' });
  await chrome.runtime.sendMessage({ type: 'rec-stop-offscreen', filename });
  return true;
}

// ---- helpers ----
function buildName(tpl, ext, tab) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  const title = (tab.title || '').slice(0, 60);
  let base = (tpl || 'shot-{date}-{time}')
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{domain}', host)
    .replaceAll('{title}', title);
  base = base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '') || 'shot';
  return `${base}.${ext}`;
}

async function blobToDataURL(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  return `data:${blob.type};base64,${btoa(bin)}`;
}
