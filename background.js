const DEFAULTS = { format: 'png', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'capture') runCapture(msg.mode, msg.opts).catch((e) => console.error('[ViewShot]', e));
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
  if (mode === 'visible') png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  else if (mode === 'fullpage') png = await captureFullPage(tab);
  else if (mode === 'region') png = await captureRegion(tab);
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

// ---- clipboard via an offscreen document ----
async function copyImage(pngDataUrl) {
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Write the screenshot image to the clipboard',
  }).catch(() => {});
  await chrome.runtime.sendMessage({ type: 'shot-clipboard', dataUrl: pngDataUrl });
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
