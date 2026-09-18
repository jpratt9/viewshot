const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true, audio: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Region's `capture` is answered synchronously, before any work starts. The
// popup closes itself on Region, and a sendMessage whose sender is torn down in
// the same turn is dropped while the worker is cold-starting - the wake is
// still in flight when the frame goes away, so the capture never runs at all. A
// warm worker wins that race, which is why it only failed sometimes: the
// "press Region twice" bug. The popup awaits this ack before window.close().
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'capture' && msg.mode === 'region') { sendResponse(true); runCapture(msg.mode, msg.opts, msg.tabId).catch(captureFailed); }
  // Visible and Full page leave the popup open, so they are answered once the
  // image is saved or copied, or with the error text when the capture fails,
  // and the popup says which (KAN-220). The badge still flashes: the popup can
  // have been closed by then.
  else if (msg?.type === 'capture') {
    runCapture(msg.mode, msg.opts, msg.tabId, msg.popupId).then(() => sendResponse(true), (e) => { captureFailed(e); sendResponse({ error: e.message || String(e) }); });
    return true;
  }
  // A popup asks as it opens. A capture it didn't send - from a popup closed
  // since, or a shortcut - is shown there too, with its buttons greyed out
  // until that capture has ended (KAN-545).
  else if (msg?.type === 'capture-check') sendResponse(shooting);
  else if (msg?.type === 'rec-start') {
    if (commandStartPending) { sendResponse(false); return; }
    recStartPending++;
    // Answered once the start has worked or failed: the popup enables Stop
    // from `rec`, and a start that fails before `rec` is written leaves
    // nothing there for it to see.
    const start = recStartGate
      .then(() => startRecording(msg.streamId, msg.opts, msg.tabId))
      .then(() => sendResponse(true), (e) => { console.error('[ViewShot]', e); sendResponse(false); return recFailed(); });
    recStartGate = start.catch(() => {}).finally(() => { recStartPending--; closeOffscreen().catch(e => console.error('[ViewShot]', e)); });
    return true;
  }
  else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
  // MAX only when the cap is what ended the recording: a Stop that landed
  // first has already saved the file and cleared the badge, and a MAX over
  // that reports trouble with a recording that is finished.
  else if (msg?.type === 'rec-cap-hit') stopRecording().then((stopped) => { if (stopped) return flashBadge('MAX'); }).catch((e) => console.error('[ViewShot]', e));
  else if (msg?.type === 'shot-region') {
    // Its turn like any capture's (runGate, KAN-213): alongside a full page,
    // its finally took the scrollbar style away in the middle of the stitch.
    const shot = runGate.then(() => chrome.storage.session.get('pendingRegion')).then(async ({ pendingRegion }) => {
      if (!pendingRegion) return;
      await chrome.storage.session.remove('pendingRegion');
      const { tab, opts } = pendingRegion;
      try {
        if (!msg.rect) return; // user cancelled
        await sleep(80); // let the overlay clear before capturing
        const bmp = await createImageBitmap(await (await fetch(await captureVisible(tab.windowId))).blob());
        const d = msg.rect.dpr;
        const canvas = new OffscreenCanvas(Math.round(msg.rect.w * d), Math.round(msg.rect.h * d));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, msg.rect.x * d, msg.rect.y * d, msg.rect.w * d, msg.rect.h * d, 0, 0, msg.rect.w * d, msg.rect.h * d);
        const png = await blobToDataURL(await canvas.convertToBlob({ type: 'image/png' }));
        await saveCapture(png, opts, tab);
      } catch(e) {
        captureFailed(e);
      } finally {
        if (opts.hideScrollbar) await setScrollbarHidden(tab, false).catch(() => {});
      }
    });
    runGate = shot.catch(() => {});
    shot.catch(captureFailed);
  }
  else if (msg?.type === 'rec-failed') recFailed();
  // A recording's file is saved and the document has let go of it. Nothing else
  // closes the document after a recording; closeOffscreen still leaves it to a
  // recording running in it, or another one still being saved.
  else if (msg?.type === 'rec-saved') closeOffscreen().catch((e) => console.error('[ViewShot]', e));
  // The popup reads `rec` from storage without waking the worker, so a leftover
  // key would go unnoticed for as long as the popup was the only thing running.
  // This message is what checks it for the popup: opening one is also the way a
  // key whose document died under an awake worker gets noticed.
  else if (msg?.type === 'rec-check') {
    getRec().catch((e) => console.warn('[ViewShot] rec check failed:', e)).then(() => sendResponse(true));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'toggle-recording') {
    // Reserve the start before awaiting storage. Repeated keys may stop a
    // start already marked REC, but must never queue another recording.
    if (recStartPending) {
      try { if (await getRec()) await stopRecording(); }
      catch (e) { console.error('[ViewShot]', e); await flashBadge('!'); }
      return;
    }
    recStartPending++;
    commandStartPending = true;
    const start = recStartGate.then(async () => {
      if (await getRec()) { await stopRecording(); return; }
      const opts = await getOpts();
      if (!['webm', 'mp4', 'gif'].includes(opts.format)) {
        await flashBadge('!');
        return;
      }
      const target = tab?.id ? tab : await getActiveTab();
      if (!target?.id) throw new Error('No active tab to record');
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
      try { await startRecording(streamId, opts, target.id); }
      catch (e) { console.error('[ViewShot]', e); await recFailed(); }
    }).catch(async (e) => {
      // Stream acquisition/Stop failures must not erase a live recording.
      console.error('[ViewShot]', e);
      await flashBadge('!');
    });
    recStartGate = start.catch(() => {}).finally(() => { recStartPending--; commandStartPending = false; closeOffscreen().catch(e => console.error('[ViewShot]', e)); });
    await recStartGate;
    return;
  }
  const map = { 'capture-visible': 'visible', 'capture-fullpage': 'fullpage', 'capture-region': 'region' };
  if (map[cmd]) runCapture(map[cmd], await getOpts(), tab?.id).catch(captureFailed);
});

// `rec` is kept in chrome.storage.local so a recording outlives a worker
// restart. The recording itself lives in the offscreen document, which is gone
// once Chrome restarts or the extension is installed, updated or reloaded, so
// after either of those nothing is recording, whatever the key says.
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('rec'));
chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('rec'));

// Every read of `rec` goes through here, and every read checks it. The
// recording only ever lives in the offscreen document, so a key with no
// document is a leftover: disabling the extension leaves one behind, because
// Chrome fires neither event above when it is enabled again, and so does a
// document that dies on its own - a renderer crash, or Chrome discarding it.
// Checking once per worker start missed that second one entirely: the worker
// can stay awake right through it, and then the badge kept showing REC, the
// popup kept Stop enabled and Record greyed out, and a clipboard copy left its
// document open.
async function getRec() {
  const { rec } = await chrome.storage.local.get('rec');
  // Only asked when there is a key to check, and an answer that can't be had
  // leaves the key alone: it is evidence only when it says the document the
  // recording lives in is gone.
  if (!rec) return rec;
  if (await chrome.offscreen.hasDocument().catch(() => true)) {
    // Clipboard copies share this one document (ensureOffscreen), so "a
    // document exists" used to be answered by one opened for a copy after the
    // recording's own had died - and the key then survived every read.
    if (!rec.docId) return rec; // written down before it had one to compare
    const id = await chrome.runtime.sendMessage({ type: 'offscreen-id' }).catch(() => null);
    if (id == null || id === rec.docId) return rec; // no answer is not an answer
  }
  console.warn('[ViewShot] a recording was marked as running in an offscreen document that is gone; forgetting it');
  await chrome.storage.local.remove('rec');
  await chrome.action.setBadgeText({ text: '' }); // REC over nothing
}

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
// The same, for the scripts a capture runs in the page. A page whose main
// thread never frees up never runs them, and an executeScript that never
// answers left runCapture pending for good: the page stayed scrolled with its
// headers and scrollbar hidden and no badge ever flashed. Generous, because
// the bug this fixes is "forever" and any bound fixes it, while too short a
// bound breaks a page that was only busy: at 5s a page blocked for 20s lost a
// capture it used to get. A screenshot has no clock of its own to race - that
// is SCRIPT_TIMEOUT_MS's 10s stream id, for a recording - and a page still
// blocked after half a minute is not going to produce a shot worth having.
const CAPTURE_SCRIPT_TIMEOUT_MS = 30000;
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
// How long the page gets to produce the two frames reportFrame waits for
// before the stitch gives up on it. A window that is drawing answers in about
// 33ms; one that isn't never will, and the wait is paid once, on the slice the
// capture stops at.
const FRAME_TIMEOUT_MS = 1000;
const SCRIPT_TIMEOUT_MS = 2000;
function scriptWithTimeout(injection, ms = SCRIPT_TIMEOUT_MS) {
  return Promise.race([
    chrome.scripting.executeScript(injection),
    sleep(ms).then(() => { throw new Error(`executeScript did not answer within ${ms / 1000}s`); }),
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

// One capture at a time (KAN-213). captureGate only spaces out the single
// captureVisibleTab calls, so a second capture - a shortcut pressed twice, or
// a shortcut during the popup's capture - ran alongside the first. Two full
// pages scrolled the same page under each other and shot each other's
// offsets; the second one recorded the headers the first had hidden as their
// own visibility, so they were left hidden; and one capture's finally took
// the scrollbar style away while the other was still shooting. Now a capture
// waits for the one before it to finish, and so does a Region's shot
// (shot-region). Its page scripts and captureVisibleTab calls each have a
// deadline (CAPTURE_SCRIPT_TIMEOUT_MS, CAPTURE_TIMEOUT_MS), so a page or a
// shot that never answers can't hold the others up for good.
let runGate = Promise.resolve();
// Whether a Visible or Full page is taking its turn, for a popup that opens
// during it (KAN-545). Only the popup that sent a capture hears how it went,
// in its answer, so the end of each one also goes out to every popup, for one
// opened since. So does its start, for one that is already open (KAN-561).
// Nothing may be listening, as with its progress. A Region is neither: its
// runCapture ends with the overlay up, and its shot waits for the drag.
let shooting = false;
function runCapture(mode, opts, tabId, popupId) {
  const run = runGate.then(async () => {
    if (mode !== 'region') { shooting = true; chrome.runtime.sendMessage({ type: 'capture-start' }).catch(() => {}); }
    const tab = await getActiveTab(tabId);
    if (!tab) throw new Error('No tab to capture'); // flash the badge rather than do nothing
    await cancelRegion(tab); // an abandoned overlay would otherwise dim this shot
  
    if (mode === 'region') {
      if (opts.hideScrollbar) { await setScrollbarHidden(tab, true); await sleep(50); /* let the bar repaint out */ }
      await chrome.storage.session.set({ pendingRegion: { tab, opts } });
      await captureRegion(tab);
      return;
    }

    let png;
    if (opts.hideScrollbar) { await setScrollbarHidden(tab, true); await sleep(50); /* let the bar repaint out */ }
    try {
      if (mode === 'visible') png = await captureVisible(tab.windowId);
      else if (mode === 'fullpage') png = await captureFullPage(tab, opts.toClipboard ? 'png' : opts.format, popupId);
    } finally {
      if (opts.hideScrollbar) await setScrollbarHidden(tab, false); // restore
    }
    if (!png) return;
    await saveCapture(png, opts, tab);
  });
  if (mode !== 'region') {
    const done = (error) => { shooting = false; chrome.runtime.sendMessage({ type: 'capture-done', toClipboard: opts.toClipboard, error }).catch(() => {}); };
    run.then(() => done(), (e) => done(e.message || String(e)));
  }
  runGate = run.catch(() => {}); // one capture's failure must not stall the next
  return run;
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
  let el = de.scrollHeight > de.clientHeight + 1 ? de
         : (b && b.scrollHeight > b.clientHeight + 1) ? b
         : null;
  if (!el) {
    for (const node of document.querySelectorAll('*')) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const style = window.getComputedStyle(node);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') { el = node; break; }
      }
    }
  }
  el = el || document.scrollingElement || de;
  window.__vsScroller = el;
  const isRoot = el === de || el === b || el === document.scrollingElement;
  const rect = isRoot ? null : el.getBoundingClientRect();
  return {
    total: el.scrollHeight,
    vh: isRoot ? window.innerHeight : Math.min(el.clientHeight, window.innerHeight),
    vw: window.innerWidth,
    winH: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    prevY: el.scrollTop,
    rect: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null
  };
}

function scrollAndReport(to, cleanup) {
  const de = document.documentElement, b = document.body;
  let el = window.__vsScroller;
  if (!el) {
    el = de.scrollHeight > de.clientHeight + 1 ? de
           : (b && b.scrollHeight > b.clientHeight + 1) ? b
           : null;
    if (!el) {
      for (const node of document.querySelectorAll('*')) {
        if (node.scrollHeight > node.clientHeight + 1) {
          const style = window.getComputedStyle(node);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') { el = node; break; }
        }
      }
    }
    el = el || document.scrollingElement || de;
  }
  if (cleanup) delete window.__vsScroller;
  const isRoot = el === de || el === b || el === document.scrollingElement;
  // 'instant' overrides a page's `scroll-behavior: smooth` (Bootstrap 5,
  // Tailwind's scroll-smooth). Without it the scroll animates, the read below
  // still sees the old offset, and the stitch stops after the first screen.
  el.scrollTo({ top: to, behavior: 'instant' });
  if (isRoot) window.scrollTo({ left: 0, top: to, behavior: 'instant' }); // no-op unless the document itself is the scroller
  return { actual: el.scrollTop, total: el.scrollHeight };
}

// Ask the page for a frame. A window that isn't drawing - minimized, occluded -
// presents none, so requestAnimationFrame never runs and the timer answers false
// instead: timers keep running in a window that isn't presenting, which is what
// makes them the half of this that can always answer. Runs in the page, so it
// can't read FRAME_TIMEOUT_MS and is handed it.
// It answers from the frame after the one it asks for. requestAnimationFrame
// runs before its frame is painted, so an answer from the first one let the
// shot beat that frame to the screen, and an element hidden just before the
// frame check could still be in the shot (KAN-525). By the time the next frame
// starts, the page has painted the one with the hides in it.
function reportFrame(ms) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    setTimeout(() => resolve(false), ms); // whichever lands first wins; the other is a no-op
  });
}

async function pageIsDrawing(tab) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id }, func: reportFrame, args: [FRAME_TIMEOUT_MS],
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result === true;
}

// Scroll to y and report where the page ACTUALLY landed. The caller stitches
// at the returned offset rather than the requested one, so a page that clamps,
// animates, or ignores the scroll still produces a correctly aligned image.
async function scrollPageTo(tab, y, cleanup = false) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id }, func: scrollAndReport, args: [y, cleanup],
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result || { actual: 0, total: 0 };
}

// ---- full page: scroll the viewport and stitch ----
// Chrome encodes no canvas past 65,535 px a side or 268,435,456 px² in all -
// convertToBlob throws IndexSizeError - and cuts a JPEG at 65,500 px and a
// WebP at 16,383 px without a word (KAN-210). A full page that would be
// bigger is scaled down to fit, worked out before the first scroll: the old
// stitch only found out after it had scrolled every screen.
const MAX_SIDE = { png: 65535, jpg: 65500, webp: 16383 };
const MAX_AREA = 268435456;
async function captureFullPage(tab, format, popupId) {
  const [{ result: m }] = await scriptWithTimeout({
    target: { tabId: tab.id },
    func: measurePage,
  }, CAPTURE_SCRIPT_TIMEOUT_MS);

  const w = Math.round(m.vw * m.dpr);
  const footerH = m.rect ? Math.max(0, m.winH - m.rect.bottom) : 0;
  const headerH = m.rect ? Math.max(0, m.rect.top) : 0;
  const pageHeight = m.rect ? headerH + m.total + footerH : m.total;
  const h = Math.round(pageHeight * m.dpr);
  const side = MAX_SIDE[format] || MAX_SIDE.png; // a recording format is saved as PNG
  let scale = Math.min(1, side / w, side / h, Math.sqrt(MAX_AREA / (w * h)));
  const initialScale = scale;
  let canvas = new OffscreenCanvas(Math.floor(w * scale), Math.floor(h * scale));
  let ctx = canvas.getContext('2d');
  let maxCanvasHeight = Math.floor(Math.min(side, MAX_AREA / (w * scale)));

  let hid = false, landed = 0, target = 0, i = 0;
  let footerCanvas = null;
  // finally: a slice that throws part-way must still put the page back, not
  // leave it scrolled to where the stitch stopped with its headers hidden.
  try {
    while (true) {
      const { actual, total } = await scrollPageTo(tab, target);
      m.total = total;
      // The page refused to advance (unscrollable, or a scroller we can't drive).
      // Stop rather than stack the same viewport down the canvas.
      if (i > 0 && actual <= landed) break;
      landed = actual;
      // Which screen this is, out of how many the page is now tall enough for,
      // for the popup (KAN-220). Not waited for, and nothing may be listening:
      // a shortcut's capture has no popup, and a popup can close mid-stitch.
      // popupId says which popup asked for this capture (none for a
      // shortcut's), so a popup whose capture waits its turn behind this one
      // doesn't show these screens as its own (KAN-552).
      chrome.runtime.sendMessage({ type: 'capture-progress', popupId, screen: i + 1, screens: Math.max(i + 1, Math.ceil(m.total / m.vh)) }).catch(() => {});
      // The sticky elements that stick to the page, listed on the first slice
      // and added to on every later one (KAN-503). From here on there is
      // something for the finally to put back.
      if (m.total > m.vh) hid = true;
      if (hid) {
        await markFixedAndSticky(tab, i > 0, i === 1, i === 0);
        await hideStuckSticky(tab);
      }
      // A slice can be shot twice: see the fixed hide after the shot (KAN-525).
      let url;
      for (let shot = 1; ; shot++) {
        await sleep(500); // let the page settle after the scroll (captureVisible gates the rate limit)
        // And the fixed ones the page put in, or pinned, while it settled: the
        // hide above ran before they were there (KAN-522). It goes before the
        // frame check, so the frame the shot waits for has this hide in it.
        if (hid) {
          await markFixedAndSticky(tab, i > 0, false, false);
          await hideStuckSticky(tab);
        }
        // captureVisibleTab hands back the last frame the window presented. A
        // window that isn't drawing - minimized, occluded - presents none, so
        // every slice comes back as the frame before it. The offsets still
        // advance and the tab is still the one showing, so neither guard here
        // catches it, and the stitch drew that one screen at every offset and
        // saved a tall image that is the same screen over and over, with nothing
        // to say so. Ask the page for a frame rather than compare the pixels: a
        // flat stretch of page shoots the same bytes twice while drawing fine.
        if (!await pageIsDrawing(tab)) throw new Error('Full page stopped: the window is not drawing (minimized?)');
        url = await captureVisible(tab.windowId);
        // captureVisibleTab shoots whichever tab is showing in the window. If the
        // user switched tabs (or moved this one out) mid-stitch, this slice is
        // another tab: stop rather than stitch it in.
        const now = await chrome.tabs.get(tab.id);
        if (!now.active || now.windowId !== tab.windowId) throw new Error('Full page stopped: another tab is now showing');
        // And the fixed and sticky ones the page put in, or pinned, after the hide above:
        // they are in this shot, at their spot on the screen (KAN-525, KAN-526). One
        // found here sends the slice back to settle and run the passes above
        // again before it is shot again. Shot straight away, it would wait out
        // the rest of CAPTURE_MIN_GAP_MS after those passes instead, and give
        // the page that long to put in another. The second shot is kept: the
        // next slice's first fixed hide finds whatever turns up after it.
        let reshot = false;
        if (hid) {
          const res = await markFixedAndSticky(tab, i > 0, false, false);
          if (res.fixedReshot || res.stickyReshot) reshot = true;
          if (await hideStuckSticky(tab)) reshot = true;
        }
        if (i === 0 || shot === 2 || !reshot) break;
      }
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      
      const sliceTopTemp = m.rect ? Math.round(Math.max(0, m.rect.top) * m.dpr) : 0;
      const sliceBottomTemp = m.rect ? Math.round(Math.min(m.winH, m.rect.bottom) * m.dpr) : 0;
      const sliceHTemp = m.rect ? Math.max(0, sliceBottomTemp - sliceTopTemp) : 0;
      
      const currentBottom = m.rect
        ? Math.round((Math.max(0, m.rect.top) + actual) * m.dpr * scale + sliceHTemp * scale)
        : Math.round((actual * m.dpr + bmp.height) * scale);

      if (currentBottom > maxCanvasHeight) {
        const pageHeight = m.rect ? Math.max(0, m.rect.top) + m.total + Math.max(0, m.winH - m.rect.bottom) : m.total;
        const new_h = Math.round(pageHeight * m.dpr);
        const newScale = Math.min(1, side / w, side / new_h, Math.sqrt(MAX_AREA / (w * new_h)));
        if (newScale < scale) {
          const oldScale = scale;
          scale = newScale;
          maxCanvasHeight = Math.floor(Math.min(side, MAX_AREA / (w * scale)));
          
          const newDrawBottom = Math.round(currentBottom / oldScale * scale);
          const newCanvas = new OffscreenCanvas(Math.floor(w * scale), Math.min(maxCanvasHeight, newDrawBottom + 2000));
          newCanvas.getContext('2d').drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, newCanvas.width, Math.round(canvas.height * (scale / oldScale)));
          canvas = newCanvas;
          ctx = canvas.getContext('2d');
        }
      }

      // Whole rows at each end, so scaled slices meet without a seam.
      if (m.rect) {
        if (i === 0) {
          const drawHeaderH = Math.round(Math.max(0, m.rect.top) * m.dpr);
          if (drawHeaderH > 0) {
            ctx.drawImage(bmp, 0, 0, bmp.width, drawHeaderH, 0, 0, Math.round(bmp.width * scale), Math.round(drawHeaderH * scale));
          }
          const footerTop = Math.round(Math.min(m.winH, m.rect.bottom) * m.dpr);
          const drawFooterH = Math.max(0, bmp.height - footerTop);
          if (drawFooterH > 0) {
            footerCanvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(drawFooterH * scale));
            footerCanvas.getContext('2d').drawImage(bmp, 0, footerTop, bmp.width, drawFooterH, 0, 0, footerCanvas.width, footerCanvas.height);
          }
        }
        const sliceTop = Math.round(Math.max(0, m.rect.top) * m.dpr);
        const sliceBottom = Math.round(Math.min(m.winH, m.rect.bottom) * m.dpr);
        const sliceH = Math.max(0, sliceBottom - sliceTop);
        const drawTop = Math.round((Math.max(0, m.rect.top) + actual) * m.dpr * scale);
        const drawBottom = Math.round((Math.max(0, m.rect.top) + actual) * m.dpr * scale + sliceH * scale);
        
        if (drawBottom > canvas.height) {
          if (drawBottom > maxCanvasHeight) break;
          const newCanvas = new OffscreenCanvas(canvas.width, Math.min(maxCanvasHeight, drawBottom + 2000));
          newCanvas.getContext('2d').drawImage(canvas, 0, 0);
          canvas = newCanvas;
          ctx = canvas.getContext('2d');
        }
        ctx.drawImage(bmp, 0, sliceTop, bmp.width, sliceH, 0, drawTop, Math.round(bmp.width * scale), drawBottom - drawTop);
      } else {
        const top = Math.round(actual * m.dpr * scale);
        const bottom = Math.round((actual * m.dpr + bmp.height) * scale);
        
        if (bottom > canvas.height) {
          if (bottom > maxCanvasHeight) break;
          const newCanvas = new OffscreenCanvas(canvas.width, Math.min(maxCanvasHeight, bottom + 2000));
          newCanvas.getContext('2d').drawImage(canvas, 0, 0);
          canvas = newCanvas;
          ctx = canvas.getContext('2d');
        }
        ctx.drawImage(bmp, 0, top, Math.round(bmp.width * scale), bottom - top); // where it really is, not where we asked
      }

      if (actual >= m.total - m.vh) break;
      target = Math.min(target + m.vh, Math.max(0, m.total - m.vh));
      i++;
    }

    if (footerCanvas) {
      const drawFooterTop = Math.round((Math.max(0, m.rect.top) + landed + m.vh) * m.dpr * scale);
      const drawFooterW = Math.round(footerCanvas.width * (scale / initialScale));
      const drawFooterH = Math.round(footerCanvas.height * (scale / initialScale));
      const finalHeight = drawFooterTop + drawFooterH;
      if (finalHeight > canvas.height && drawFooterTop <= maxCanvasHeight) {
        const newCanvas = new OffscreenCanvas(canvas.width, Math.min(maxCanvasHeight, finalHeight));
        newCanvas.getContext('2d').drawImage(canvas, 0, 0);
        canvas = newCanvas;
        ctx = canvas.getContext('2d');
      }
      if (drawFooterTop <= maxCanvasHeight) {
        ctx.drawImage(footerCanvas, 0, 0, footerCanvas.width, footerCanvas.height, 0, drawFooterTop, drawFooterW, drawFooterH);
      }
    }
  } finally {
    if (hid) await restoreFixedAndSticky(tab); // restore
    await scrollPageTo(tab, m.prevY, true);
  }

  // Trim to what was actually stitched, so an early stop yields a short correct
  // image instead of a tall one padded with blank space.
  const filled = m.rect
    ? Math.min(canvas.height, Math.round((Math.max(0, m.rect.top) + landed + m.vh + Math.max(0, m.winH - m.rect.bottom)) * m.dpr * scale))
    : Math.min(canvas.height, Math.round((landed + m.vh) * m.dpr * scale));
  let out = canvas;
  if (filled > 0 && filled < canvas.height) {
    out = new OffscreenCanvas(canvas.width, filled);
    out.getContext('2d').drawImage(canvas, 0, 0);
  }
  return await blobToDataURL(await out.convertToBlob({ type: 'image/png' }));
}

// Temporarily hide position:fixed / position:sticky elements (the cause of
// repeated headers/banners in scroll-stitch), then restore them afterward.
// A sticky element repeats only in the slices it is stuck in, pinned to the
// top of the viewport instead of where the document puts it: a pinned header
// in every slice after the first, a sticky table header, section heading or
// sidebar further down in the slices after the one that holds its place.
// Hiding every sticky element blanked those out of the image (KAN-218), and
// hiding only the ones the first screen showed stitched them in again at the
// top of every slice they stayed stuck in (KAN-403). So each slice hides the
// ones that are away from their place (see hideStuckSticky).
// Where the page has a sticky element is where `static` puts it: one that
// isn't stuck sits there, and one that is stuck can be anywhere else, a
// `bottom: 0` bar whose place is further down pinned to the bottom of the
// first screen, say (KAN-501). So each is read that way, all at once, and put
// back before anything is painted. On every slice, not once at the top: a
// place can move while the capture runs, when content above it loads in
// (KAN-502). Within a pixel of its place counts as in it: rects are
// fractional.
async function hideStuckSticky(tab) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id },
    func: () => {
      const list = window.__shotSticky || [];
      const painted = list.map(([el]) => el.getBoundingClientRect().top);
      const was = list.map(([el]) => [el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]);
      for (const [el] of list) el.style.setProperty('position', 'static', 'important');
      const place = list.map(([el]) => el.getBoundingClientRect().top);
      let changed = false;
      list.forEach(([el, v], k) => {
        el.style.setProperty('position', ...was[k]);
        const set = Math.abs(painted[k] - place[k]) > 1 ? 'hidden' : v;
        if (el.style.visibility !== set) {
          el.style.visibility = set;
          changed = true;
        }
      });
      return changed;
    },
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result;
}

async function markFixedAndSticky(tab, doFixed, fixedFirst, stickyFirst) {
  const [{ result }] = await scriptWithTimeout({
    target: { tabId: tab.id },
    func: (doFixed, fixedFirst, stickyFirst) => {
      const fixedAdded = [];
      const stickyList = [];
      let fixedList = fixedFirst ? [] : window.__shotHidden || [];
      let stickyListed = stickyFirst ? [] : window.__shotSticky || [];
      
      let fixedReshot = false;
      let stickyReshot = false;

      fixedList = fixedList.filter(([el, v]) => {
        if (getComputedStyle(el).position !== 'fixed') {
          if (el.style.visibility !== v) {
            el.style.visibility = v;
            fixedReshot = true;
          }
          return false;
        }
        return true;
      });

      stickyListed = stickyListed.filter(([el, v]) => {
        if (getComputedStyle(el).position !== 'sticky') {
          if (el.style.visibility !== v) {
            el.style.visibility = v;
            stickyReshot = true;
          }
          return false;
        }
        return true;
      });

      const roots = [document];
      while (roots.length) {
        for (const el of roots.pop().querySelectorAll('*')) {
          const shadow = el instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(el);
          if (shadow) roots.push(shadow);
          
          const pos = getComputedStyle(el).position;
          if (doFixed && pos === 'fixed') {
            if (!fixedList.some(([e]) => e === el)) {
              fixedAdded.push([el, el.style.visibility]);
              fixedReshot = true;
            }
            if (el.style.visibility !== 'hidden') {
              el.style.visibility = 'hidden';
              fixedReshot = true;
            }
          }
          if (pos === 'sticky') stickyList.push(el);
        }
      }
      
      if (doFixed) {
        window.__shotHidden = [...fixedList, ...fixedAdded];
      }
      
      const slotOf = (n) => {
        const root = n.parentElement instanceof HTMLElement && chrome.dom.openOrClosedShadowRoot(n.parentElement);
        return root && [...root.querySelectorAll('slot')].find((s) => s.assignedElements().includes(n));
      };
      const onPage = stickyList.filter((el) => {
        for (let p = el.assignedSlot || slotOf(el) || el.parentElement || el.getRootNode().host; p && p !== document.body && p !== document.documentElement; p = p.assignedSlot || slotOf(p) || p.parentElement || p.getRootNode().host) {
          if (/auto|scroll|hidden/.test(getComputedStyle(p).overflow)) return false;
        }
        return true;
      });
      const added = onPage.filter((el) => !stickyListed.some(([e]) => e === el)).map((el) => [el, el.style.visibility]);
      window.__shotSticky = [...stickyListed, ...added];
      
      return { fixedReshot, stickyReshot: stickyReshot || added.length > 0 };
    },
    args: [doFixed, fixedFirst, stickyFirst],
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
  return result;
}

async function restoreFixedAndSticky(tab) {
  await scriptWithTimeout({
    target: { tabId: tab.id },
    func: () => {
      for (const [el, v] of window.__shotHidden || []) el.style.visibility = v;
      for (const [el, v] of window.__shotSticky || []) el.style.visibility = v;
      window.__shotHidden = null;
      window.__shotSticky = null;
    },
  }, CAPTURE_SCRIPT_TIMEOUT_MS);
}

// Temporarily hide the page scrollbar(s) so they don't show up in the shot.
// Uses a removable <style> rather than overflow:hidden so scrolling still
// works (the full-page mode relies on scrolling to stitch slices).
async function setScrollbarHidden(tab, hide) {
  // Cosmetic, so an uninjectable page must not be where the capture dies: on a
  // chrome:// URL this threw "Cannot access a chrome:// URL" before the shutter
  // was ever reached. Such a page is shot with its scrollbar, though: a data:
  // page or another extension's page taller than the window keeps it along the
  // right edge, and nothing outside the page can take it out.
  try {
    await scriptWithTimeout({
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
    }, CAPTURE_SCRIPT_TIMEOUT_MS);
  } catch { /* chrome:// and friends refuse injection */ }
}

// ---- region: overlay drag-select, then crop the visible capture ----

// Resolve of the selection currently awaiting a drag, if any.
// Clicking Region and then walking away leaves the dimmed overlay on the page:
// it would be stitched into the next Visible/Full page shot, and a second
// Region click would no-op against its re-entrancy guard. Tear it down first.
async function cancelRegion(tab) {
  try {
    await scriptWithTimeout({
      target: { tabId: tab.id },
      func: () => { if (window.__shotRegionCancel) window.__shotRegionCancel(); },
    }, CAPTURE_SCRIPT_TIMEOUT_MS);
  } catch { /* chrome:// and friends refuse injection, and hold no overlay */ }
  const { pendingRegion } = await chrome.storage.session.get('pendingRegion');
  if (pendingRegion) {
    if (pendingRegion.opts.hideScrollbar) await setScrollbarHidden(pendingRegion.tab, false).catch(() => {});
    await chrome.storage.session.remove('pendingRegion');
  }
}

async function captureRegion(tab) {
  await scriptWithTimeout({ target: { tabId: tab.id }, files: ['region.js'] }, CAPTURE_SCRIPT_TIMEOUT_MS);
}

// ---- offscreen document (shared by clipboard + recording; only one allowed) ----
let offscreenCreating;
async function ensureOffscreen() {
  if (offscreenCreating) return offscreenCreating;
  const has = await chrome.offscreen.hasDocument();
  console.log('[ViewShot] ensureOffscreen hasDocument=', has);
  if (offscreenCreating) return offscreenCreating;
  if (has) return;
  offscreenCreating = (async () => {
    // Forget a recording whose document died before its replacement exists:
    // while the new listener loads, it cannot answer getRec's identity check.
    await getRec();
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD', 'USER_MEDIA'],
      justification: 'Write screenshots to the clipboard and record the tab to video',
    });
    // Share cleanup, creation and readiness with every caller. A new recording
    // must not start while another caller is still clearing the old one's key.
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
  })();
  // Only the owner resets the gate, including when initialization fails.
  try { await offscreenCreating; } finally { offscreenCreating = null; }
}

// An offscreen document shares its renderer process — and therefore its Blink
// main thread — with the action popup, and only AUDIO_PLAYBACK documents ever
// expire on their own. Leaving one open means every popup open competes with
// whatever that document is doing, and Chrome does not paint the popup until
// its onload completes. So close it the moment the work is finished.
async function closeOffscreen() {
  const rec = await getRec();
  if (rec) return; // a recording lives in there; closing would kill it
  try {
    if (!(await chrome.offscreen.hasDocument())) return;
    // `rec` is removed before the document hears about the Stop, and the
    // recording is only saved after that: a GIF is encoded first, which can take
    // a while, and the file then downloads from a URL the document owns. Closing
    // the document in between lost the recording, so ask it first. One that
    // can't answer has no recording in it.
    if ((await chrome.runtime.sendMessage({ type: 'offscreen-busy' }).catch(() => false)) === true) return;
    // Two uses of the document count as neither: a start, which writes `rec`
    // only after ensureOffscreen, and a clipboard copy waiting on its write.
    // Closing under a start left it recording nothing. Read after the awaits,
    // so one that began during them counts as well.
    if (recStartPending || copiesPending) return;
    await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn('[ViewShot] closeDocument failed:', e);
  }
}

// ---- clipboard via the offscreen document ----
// Copies still writing: from their ensureOffscreen until the document answers.
let copiesPending = 0;
async function copyImage(pngDataUrl, tabId) {
  copiesPending++;
  try {
    // 1. Try the popup
    const popupRes = await chrome.runtime.sendMessage({ type: 'shot-clipboard', dataUrl: pngDataUrl }).catch(() => null);
    if (popupRes === 'done') return;
    if (popupRes?.error) throw new Error(popupRes.error);

    // 2. Try the active tab
    // Fenced like every other page script: a page whose main thread never frees
    // up never runs it, and the copy stayed pending for good - no !, and
    // copiesPending held every later closeOffscreen off (KAN-495).
    if (tabId) {
      const tabRes = await scriptWithTimeout({
        target: { tabId },
        func: async (dataUrl) => {
          try {
            const blob = await (await fetch(dataUrl)).blob();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            return 'done';
          } catch (e) {
            return { error: e.message || String(e) };
          }
        },
        args: [pngDataUrl]
      }, CAPTURE_SCRIPT_TIMEOUT_MS).catch(() => null);
      
      const res = tabRes && tabRes[0] && tabRes[0].result;
      if (res === 'done') return;
      if (res?.error) throw new Error(res.error);
    }

    // 3. Try the offscreen document as a fallback (succeeds using clipboardWrite permission)
    // Under its own type: Chrome hands shot-clipboard to every extension page, and
    // a document held open by a recording answered the popup's write in step 1 with
    // its focus error, throwing the popup's copy away when it answered first (KAN-489).
    await ensureOffscreen();
    const offscreenRes = await chrome.runtime.sendMessage({ type: 'shot-clipboard-offscreen', dataUrl: pngDataUrl }).catch(() => null);
    if (offscreenRes === 'done') return;
    if (offscreenRes?.error) throw new Error(offscreenRes.error);
    
    throw new Error('Clipboard copy failed in all contexts');
  } finally {
    copiesPending--;
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
    const rec = await getRec();
    await chrome.action.setBadgeText({ text: rec ? 'REC' : '' });
  }, 3000);
}

// A start that failed, here or in the offscreen document: nothing is
// recording, so drop `rec` (an open popup follows it) and flash ! over REC.
function recFailed() {
  return chrome.storage.local.remove('rec').then(() => flashBadge('!')).finally(closeOffscreen);
}

// Starts go through this gate one at a time, each once the one before has
// finished, cleanup included. startRecording checks `rec` and writes it only
// after several awaits, so two starts that overlapped both got past the check,
// and a second one that then failed removed the `rec` the first had written.
let recStartGate = Promise.resolve();
// Count popup starts already queued as well as the command in flight, so a
// keyboard repeat cannot enqueue a recording that would begin after Stop.
let recStartPending = 0;
// Popup starts retain their queue, but must not queue behind a key press.
let commandStartPending = false;

async function startRecording(streamId, opts, tabId) {
  log('rec-start received, opts=', opts, 'streamId=', streamId);
  // One recording at a time. Starting another would overwrite `rec`, and the
  // offscreen document would lose the recording already running.
  const rec = await getRec();
  if (rec) { console.warn('[ViewShot] a recording is already running; not starting another'); return; }
  // The stream id is minted by the popup or keyboard command; we just wire
  // it to the offscreen recorder, which is the only context with media APIs.
  const tab = await getActiveTab(tabId); // the tab the stream id was minted for
  await ensureOffscreen();
  // Which document this recording is about to live in. ensureOffscreen has
  // just had a `pong` out of it, so a rejection here means it went away in
  // between; the recording is then written down without one and falls back to
  // the plain "is there a document" check.
  const docId = await chrome.runtime.sendMessage({ type: 'offscreen-id' }).catch(() => null);
  log('offscreen ready, sending rec-start-offscreen, format=', opts.format);
  // Persist enough to name the file at stop time, surviving a worker restart.
  await chrome.storage.local.set({ rec: { url: tab?.url, title: tab?.title, format: opts.format, filename: opts.filename, docId } });
  await chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
  await chrome.action.setBadgeText({ text: 'REC' });
  // Play the edge-glow blip BEFORE starting the recorder so its animation
  // doesn't contaminate the first second of the output. On chrome:// pages
  // where injection fails, blipRecordingIndicator returns immediately and we
  // skip straight to recording — the badge + Chrome's own blue capture border
  // are still visible to the user as recording-active cues.
  const blip = tab ? await blipRecordingIndicator(tab.id) : null;
  // Query the captured tab's ACTUAL viewport (innerWidth/innerHeight). NOT
  // chrome.windows.get(), which is the outer window (tab strip + omnibox +
  // bookmarks bar all included): tabCapture only streams the web-contents
  // viewport, so pinning min/max to the window pads the difference with
  // black (~150-200px bar at the bottom). innerWidth/innerHeight ×
  // devicePixelRatio gives the physical pixels tabCapture delivers; the tab
  // is passed so a page that refuses the script still has a size to fall
  // back on.
  const dims = await getViewport(tab);
  // The glow is still on screen: the page reports when it is gone, and the
  // viewport read above has already run while it was showing.
  if (blip) await blip.gone;
  // Stop removes `rec`, and it can land while the blip or the viewport read is
  // still under way: up to two deadlines on a page that never answers. A
  // recorder started after that would run on with nothing that can stop it.
  if (!(await getRec())) { console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
  await chrome.runtime.sendMessage({
    type: 'rec-start-offscreen', streamId, format: opts.format, audio: opts.audio,
    width: dims?.width, height: dims?.height, cssPx: dims?.cssPx,
  });
  log('rec-start-offscreen sent, dims=', dims);
}

// Get the captured tab's real viewport in PHYSICAL pixels (innerWidth/Height
// × devicePixelRatio). This is what tabCapture actually streams — pinning
// getUserMedia's min/max to these values eliminates the letterboxing an
// unpinned capture has (scaled to a ceiling resolution, padded with black).
// chrome:// pages, the Web Store and file:// without file access refuse the
// script, and so does a page that doesn't answer in time, so fall back to
// chrome.tabs.Tab.width/height: the same viewport, but in CSS pixels. Those
// are marked cssPx so the offscreen document can scale them by its own
// devicePixelRatio, which is the display's — the worker has none of its own.
async function getViewport(tab) {
  if (!tab?.id) return null;
  try {
    const [{ result }] = await scriptWithTimeout({
      target: { tabId: tab.id },
      func: () => ({
        width: Math.round(window.innerWidth * window.devicePixelRatio),
        height: Math.round(window.innerHeight * window.devicePixelRatio),
      }),
    });
    return result;
  } catch (e) {
    console.warn('[ViewShot] getViewport script failed:', e);
    if (tab.width && tab.height) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 10 });
        const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
        return { width: bmp.width, height: bmp.height };
      } catch (err) {
        console.warn('[ViewShot] getViewport capture fallback failed:', err);
        return { width: tab.width, height: tab.height, cssPx: true };
      }
    }
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
// How long past the blip's deadline the recorder waits for a page that never
// reports its glow. o.animate() doesn't paint when the script runs — the
// animation starts on the page's next frame — and a page busy enough to miss
// the blip's deadline is the one that may not produce that frame for a while.
// No longer than the viewport read's own deadline, which the hold overlaps: a
// start then never takes longer than its two script deadlines, and the stream
// id budget above (a start and one queued behind it inside ~10 s) still holds.
const BLIP_HOLD_MS = SCRIPT_TIMEOUT_MS;
// Answers null when the page showed nothing, otherwise { gone }: a promise that
// settles once the page says its glow is gone — or at the ceiling, for a page
// that never says so. The report, not the worker's clock, is what ends the
// hold. Wrapped, not returned bare: an async function hands back the promise it
// returns as its own, so the caller's await would sit through the whole hold
// before the viewport read it is meant to overlap.
async function blipRecordingIndicator(tabId) {
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS; // when the start stops waiting for the script
  const ceiling = sleep(SCRIPT_TIMEOUT_MS + BLIP_HOLD_MS); // deadline + BLIP_HOLD_MS, from the same start
  const id = crypto.randomUUID(); // a report from an earlier blip is not this one's
  // Listening before the injection: a fast page reports while executeScript is
  // still answering, and the report would land on nobody.
  let done;
  const reported = new Promise((resolve) => {
    done = () => { chrome.runtime.onMessage.removeListener(onMsg); resolve(); };
    const onMsg = (msg) => { if (msg?.type === 'blip-done' && msg.id === id) done(); };
    chrome.runtime.onMessage.addListener(onMsg);
  });
  try {
    await scriptWithTimeout({
      target: { tabId },
      func: (animMs, deadline, id) => {
        // What ends the start's hold. The worker can only time the script, and
        // the animation starts on the page's next frame, which can be long
        // after it: a glow timed from here can still be on screen when the
        // recorder starts. Sent for a glow that never showed too, so a page
        // that ran late doesn't hold the recorder for nothing.
        const tell = () => chrome.runtime.sendMessage({ type: 'blip-done', id }).catch(() => {});
        // The start stops waiting for this script at its deadline and goes on to
        // the recorder, so a glow shown after that would end up in the recording.
        if (Date.now() > deadline) { tell(); return; }
        const o = document.createElement('div');
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-shadow:inset 0 0 44px 10px rgba(57,211,83,.6);opacity:0;';
        (document.body || document.documentElement).appendChild(o);
        const over = () => { o.remove(); tell(); };
        // finished, not onfinish: a cancelled animation rejects it, and the
        // worker would otherwise wait out the ceiling for a glow already gone.
        o.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: animMs, easing: 'ease-out' })
          .finished.then(over, over);
      },
      args: [BLIP_ANIM_MS, deadline, id],
    });
  } catch (e) {
    // chrome:// URLs and similar refuse executeScript — skip the wait so we
    // don't delay the recording start for nothing. A page that doesn't answer
    // in time is skipped the same way.
    // Expected on those pages, so only a warning: chrome://extensions lists
    // every console.error from the worker as an extension error.
    console.warn('[ViewShot] blip failed:', e);
    // A page that refuses scripts fails at once and shows nothing. A page that
    // ran out of time may have run the script just before its deadline, so it
    // still has a glow to report, and the hold below is what waits for it.
    if (Date.now() < deadline) { done(); return null; }
  }
  return { gone: Promise.race([reported, ceiling.then(done)]) };
}

async function stopRecording() {
  log('rec-stop received');
  const rec = await getRec();
  // Answered, so the frame cap can tell whether it is the one that ended the
  // recording: false means a Stop got here first.
  if (!rec) { console.warn('[ViewShot] stop with no active recording'); return false; }
  const filename = buildName(rec.filename, rec.format, { url: rec.url, title: rec.title });
  log('stopping, will save as', filename);
  await chrome.storage.local.remove('rec');
  await chrome.action.setBadgeText({ text: '' });
  await chrome.runtime.sendMessage({ type: 'rec-stop-offscreen', filename });
  closeOffscreen().catch((e) => console.error('[ViewShot]', e));
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

async function saveCapture(png, opts, tab) {
  if (opts.toClipboard) {
    await copyImage(png, tab?.id);
  } else {
    const { dataUrl, ext } = await encode(png, opts);
    await chrome.downloads.download({ url: dataUrl, filename: buildName(opts.filename, ext, tab), saveAs: false });
  }
}
