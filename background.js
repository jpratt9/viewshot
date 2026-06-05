const DEFAULTS = { format: 'png', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'capture') runCapture(msg.mode, msg.opts).catch((e) => console.error('[ViewShot]', e));
  else if (msg?.type === 'rec-start') startRecording(msg.streamId, msg.opts).catch((e) => console.error('[ViewShot]', e));
  else if (msg?.type === 'rec-stop') stopRecording().catch((e) => console.error('[ViewShot]', e));
  else if (msg?.type === 'rec-cap-hit') stopRecording().then(() => flashBadge('MAX')).catch((e) => console.error('[ViewShot]', e));
  else if (msg?.type === 'rec-failed') chrome.storage.local.remove('rec').then(() => flashBadge('!'));
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const map = { 'capture-visible': 'visible', 'capture-fullpage': 'fullpage', 'capture-region': 'region' };
  if (map[cmd]) runCapture(map[cmd], await getOpts()).catch((e) => console.error('[ViewShot]', e));
});

async function getOpts() {
  const { opts } = await chrome.storage.local.get('opts');
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (o.filename === 'shot-{date}') o.filename = DEFAULTS.filename; // migrate old default
  return o;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runCapture(mode, opts) {
  const tab = await getActiveTab();
  if (!tab) return;
  let png;
  if (opts.hideScrollbar) { await setScrollbarHidden(tab, true); await sleep(50); /* let the bar repaint out */ }
  try {
    if (mode === 'visible') png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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
  const mime = mimes[opts.format] || 'image/png';
  const bmp = await createImageBitmap(await (await fetch(pngDataUrl)).blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob(mime === 'image/png' ? { type: mime } : { type: mime, quality: opts.quality });
  return { dataUrl: await blobToDataURL(blob), ext: opts.format };
}

// ---- full page: scroll the viewport and stitch ----
async function captureFullPage(tab) {
  const [{ result: m }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      total: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      vh: window.innerHeight,
      vw: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
      prevY: window.scrollY,
    }),
  });

  const canvas = new OffscreenCanvas(Math.round(m.vw * m.dpr), Math.round(m.total * m.dpr));
  const ctx = canvas.getContext('2d');
  const positions = [...new Set(
    Array.from({ length: Math.ceil(m.total / m.vh) }, (_, i) => Math.min(i * m.vh, Math.max(0, m.total - m.vh)))
  )];

  let hid = false;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (y) => window.scrollTo(0, y), args: [pos] });
    // Keep fixed/sticky elements (pinned headers, banners) on the FIRST slice
    // only; hide them on later slices so they aren't stitched in repeatedly.
    if (i === 1 && !hid) { await setFixedHidden(tab, true); hid = true; }
    await sleep(500); // settle + respect captureVisibleTab's ~2/sec rate limit
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    ctx.drawImage(bmp, 0, Math.round(pos * m.dpr));
  }

  if (hid) await setFixedHidden(tab, false); // restore
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (y) => window.scrollTo(0, y), args: [m.prevY] });
  return await blobToDataURL(await canvas.convertToBlob({ type: 'image/png' }));
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
}

// ---- region: overlay drag-select, then crop the visible capture ----
async function captureRegion(tab) {
  const resultP = new Promise((resolve) => {
    const onMsg = (msg) => {
      if (msg?.type === 'shot-region') { chrome.runtime.onMessage.removeListener(onMsg); resolve(msg.rect); }
    };
    chrome.runtime.onMessage.addListener(onMsg);
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['region.js'] });
  const rect = await resultP;
  if (!rect) return null;

  await sleep(80); // let the overlay clear before capturing
  const bmp = await createImageBitmap(await (await fetch(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))).blob());
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
  await offscreenCreating;
  offscreenCreating = null;
  // createDocument can resolve just before the page's message listener is live,
  // so the first rec-start would be dropped. Ping until it answers (the cause
  // of the "press record twice to start" bug).
  for (let i = 0; i < 40; i++) {
    try { if ((await chrome.runtime.sendMessage({ type: 'offscreen-ping' })) === 'pong') break; } catch {}
    await sleep(25);
  }
  console.log('[ViewShot] offscreen document ready');
}

// ---- clipboard via the offscreen document ----
async function copyImage(pngDataUrl) {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ type: 'shot-clipboard', dataUrl: pngDataUrl });
}

// ---- record the visible tab to WebM/GIF via the offscreen document ----
const log = (...a) => console.log('[ViewShot]', ...a);

async function flashBadge(text) {
  await chrome.action.setBadgeBackgroundColor({ color: '#e5534b' });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
}

async function startRecording(streamId, opts) {
  log('rec-start received, opts=', opts, 'streamId=', streamId);
  // The stream id is minted in the popup (under its user gesture); we just wire
  // it to the offscreen recorder, which is the only context with media APIs.
  const tab = await getActiveTab(); // for the filename only
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
  if (tab) await blipRecordingIndicator(tab.id);
  // Query the captured tab's ACTUAL viewport (innerWidth/innerHeight) — NOT
  // chrome.tabs.Tab.width/height, which reports the outer window dims (tab
  // strip + omnibox + bookmarks bar + status bar all included). tabCapture
  // only captures the web-contents viewport, so pinning min/max to the outer
  // window dims makes Chrome pad the difference with black (~150-200px bar
  // at the bottom). innerWidth/innerHeight × devicePixelRatio gives the
  // physical pixels that match what tabCapture actually delivers.
  const dims = await getViewport(tab?.id);
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
// null on chrome:// pages or any URL where executeScript can't inject.
async function getViewport(tabId) {
  if (!tabId) return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
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
async function blipRecordingIndicator(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (animMs) => {
        const o = document.createElement('div');
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;box-shadow:inset 0 0 44px 10px rgba(57,211,83,.6);opacity:0;';
        (document.body || document.documentElement).appendChild(o);
        o.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: animMs, easing: 'ease-out' })
          .onfinish = () => o.remove();
      },
      args: [BLIP_ANIM_MS],
    });
  } catch (e) {
    // chrome:// URLs and similar refuse executeScript — skip the wait so we
    // don't delay the recording start for nothing.
    console.error('[ViewShot] blip failed:', e);
    return;
  }
  await new Promise((r) => setTimeout(r, BLIP_ANIM_MS + 50));
}

async function stopRecording() {
  log('rec-stop received');
  const { rec } = await chrome.storage.local.get('rec');
  if (!rec) { console.warn('[ViewShot] stop with no active recording'); return; }
  const filename = buildName(rec.filename, rec.format, { url: rec.url, title: rec.title });
  log('stopping, will save as', filename);
  await chrome.storage.local.remove('rec');
  await chrome.action.setBadgeText({ text: '' });
  await chrome.runtime.sendMessage({ type: 'rec-stop-offscreen', filename });
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
