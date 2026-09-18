const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true, audio: false };
const $ = (id) => document.getElementById(id);
const isRecFmt = (f) => f === 'webm' || f === 'mp4' || f === 'gif';
let activeTab = null;
let recChanged = false; // the storage listener at the bottom has seen `rec` change
const edited = new Set(); // input can precede change while startup is pending
let ready = false;

const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };

// Pages that aren't http(s), file, ftp, chrome://, another extension's page or
// a data: URL are refused before anything is sent: captures there failed in the
// worker, which threw into a console the user never has open. chrome:// pages
// (the New Tab page is one), other extensions' pages and data: URLs all refuse
// executeScript, which Full page and Region need, but activeTab still lets
// Chrome capture and record them, so Visible and Record go through.
// Capture stays disabled until load() has reconciled settings and the tab.
const CAPTURABLE = /^(https?|file|ftp|chrome|chrome-extension|data):/i;
const CHROME_PAGE = /^chrome:/i;
const EXTENSION_OR_DATA = /^(chrome-extension|data):/i;
const uncapturable = (tab) => !!(tab && tab.url && !CAPTURABLE.test(tab.url));
// Chrome never lets an extension script the Web Store (all of chrome.google.com
// and chromewebstore.google.com), so Full page and Region can't run there.
// Visible still can: Chrome lets activeTab capture the store.
const WEB_STORE = /^https?:\/\/([\w-]+\.)*(chromewebstore|chrome)\.google\.com([:/?#]|$)/i;

function apply(o) {
  if (!edited.has('format')) $('format').value = o.format;
  if (!edited.has('quality')) {
    $('quality').value = o.quality;
    $('qualityVal').textContent = Math.round(o.quality * 100) + '%';
  }
  if (!edited.has('filename')) $('filename').value = o.filename;
  if (!edited.has('toClipboard')) $('toClipboard').checked = o.toClipboard;
  if (!edited.has('hideScrollbar')) $('hideScrollbar').checked = o.hideScrollbar;
  if (!edited.has('audio')) $('audio').checked = o.audio;
  toggleQuality();
  toggleAudio();
  toggleRec();
}

const migrate = (o) => (o.filename === 'shot-{date}' ? { ...o, filename: DEFAULTS.filename } : o);

// Chrome will not paint the popup until its onload completes, so every awaited
// round trip before first paint is lag the user sees. localStorage is
// synchronous and lives in this document, so the form is filled in before the
// first frame; chrome.storage stays the source of truth and reconciles below.
function paintFromCache() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('opts') || 'null'); } catch { /* no mirror yet */ }
  apply(migrate({ ...DEFAULTS, ...(cached || {}) }));
}

async function load() {
  // In parallel, and one storage call rather than two: these used to be three
  // sequential IPC round trips, with the form gated behind a tabs.query it did
  // not need.
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get(['opts', 'rec']),
  ]);
  [activeTab] = tabs;
  // The Stop button stays greyed out unless a recording is actually running.
  // Set before apply(), whose toggleRec() greys Record out from it. Skipped if
  // `rec` changed while this function waited: the storage listener has already
  // set Stop from that change, which can be newer than `stored.rec`.
  if (!recChanged) $('stopBtn').disabled = !stored.rec;
  apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
  ready = true;
  edited.clear();
  toggleRec();
}

function read() {
  return {
    format: $('format').value,
    quality: parseFloat($('quality').value),
    filename: $('filename').value.trim() || 'shot-{date}-{time}',
    toClipboard: $('toClipboard').checked,
    hideScrollbar: $('hideScrollbar').checked,
    audio: $('audio').checked,
  };
}

const save = async () => {
  if (!ready) await startup;
  if (!ready) return; // initialization failed; never save the fallback form
  const o = read();
  try { localStorage.setItem('opts', JSON.stringify(o)); } catch { /* mirror is best-effort */ }
  return chrome.storage.local.set({ opts: o });
};
// Quality slider only applies to the still image formats jpg/webp.
const toggleQuality = () => { $('qualityRow').style.display = (['jpg', 'webp'].includes($('format').value)) ? 'flex' : 'none'; };
// Tab audio is recorded into WebM (KAN-221) and MP4 (KAN-544), not GIF.
const toggleAudio = () => { $('audioRow').style.display = ['webm', 'mp4'].includes($('format').value) ? 'flex' : 'none'; };

// Recording captures the whole visible tab, so full-page/region don't apply —
// disable them and relabel the "Visible" button as "Record" for video formats.
// Record is greyed out too while a recording runs (Stop enabled): a second
// start would record over that one, and it would be lost.
function toggleRec() {
  const rec = isRecFmt($('format').value);
  const vis = document.querySelector('.mode[data-mode="visible"]');
  vis.querySelector('.lbl').textContent = rec ? 'Record' : 'Visible';
  vis.querySelector('.ico').textContent = rec ? '●' : '▢';
  vis.disabled = !ready || rec && !$('stopBtn').disabled;
  document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = !ready || rec; });
}

document.querySelectorAll('#modes .mode').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!ready || btn.disabled) return;
    if (uncapturable(activeTab)) {
      showError('Can’t capture this page. Open a normal http(s) page and try again.');
      return; // keep the popup open so the error is visible
    }
    const opts = read();
    if (isRecFmt(opts.format)) {
      // Greyed out before the first await: a second press while this one waits
      // would start a second recording over it.
      btn.disabled = true;
      // Mint the capture stream id HERE, while the click's user gesture is still
      // live — getMediaStreamId rejects without it, and the background worker
      // (a plain message handler) has no gesture to offer.
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
      } catch (e) {
        console.error('[ViewShot] getMediaStreamId failed:', e);
        showError('Can’t record this tab. Open a normal http(s) page and try again.');
        toggleRec(); // nothing is recording, so Record comes back
        return; // keep the popup open so the error is visible
      }
      await save();
      // Stop is left to the storage listener below, which enables it once the
      // worker has marked the recording as running. A start that fails before
      // then changes nothing in storage, so the worker's answer is what brings
      // Record back.
      let started = false;
      try {
        started = await chrome.runtime.sendMessage({ type: 'rec-start', streamId, tabId: activeTab.id, opts });
      } catch (e) {
        console.error('[ViewShot] rec-start message failed:', e);
      }
      if (!started) {
        showError('Couldn’t start the recording. Try again.');
        toggleRec(); // nothing is recording, so Record comes back
      }
    } else {
      // Until "Allow access to file URLs" is on, Chrome refuses both
      // executeScript and captureVisibleTab on file:// pages. Recording needs
      // neither, so only the screenshot modes stop here.
      if (/^file:/i.test(activeTab?.url || '') && !(await chrome.extension.isAllowedFileSchemeAccess())) {
        showError('Can’t capture this file. In chrome://extensions, open ViewShot’s Details, turn on “Allow access to file URLs”, and try again.');
        return; // keep the popup open so the error is visible
      }
      if (btn.dataset.mode !== 'visible' && WEB_STORE.test(activeTab?.url || '')) {
        showError('Chrome doesn’t let extensions run Full page or Region on the Web Store. Visible still works here.');
        return; // keep the popup open so the error is visible
      }
      if (btn.dataset.mode !== 'visible' && CHROME_PAGE.test(activeTab?.url || '')) {
        showError('Chrome doesn’t let extensions run Full page or Region on chrome:// pages. Visible still works here.');
        return; // keep the popup open so the error is visible
      }
      if (btn.dataset.mode !== 'visible' && EXTENSION_OR_DATA.test(activeTab?.url || '')) {
        showError('Chrome doesn’t let extensions run Full page or Region on other extensions’ pages or data: URLs. Visible still works here.');
        return; // keep the popup open so the error is visible
      }
      await save();
      // Wait for the worker to acknowledge before closing anything. window.close()
      // in the same turn as the send tears this frame down while a cold-starting
      // worker is still waking, and the message goes with it - the click did
      // nothing at all, and pressing Region again worked only because the second
      // press met a worker that was already awake.
      try {
        await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, tabId: activeTab?.id, opts });
      } catch (e) {
        console.error('[ViewShot] capture message failed:', e);
        showError('Couldn’t reach the extension worker. Try again.');
        return; // keep the popup open so the error is visible
      }
      // Region hands the page over to a drag. Left open, the popup covers the
      // dimmed overlay, holds the focus its Escape-to-cancel needs, and makes
      // the dimming look like a bug rather than a live selection.
      if (btn.dataset.mode === 'region') window.close();
    }
  });
});

$('stopBtn').addEventListener('click', () => { if ($('stopBtn').disabled) return; chrome.runtime.sendMessage({ type: 'rec-stop' }); $('stopBtn').disabled = true; toggleRec(); });
// A recording can also end without this Stop: the recorded tab closes, a GIF
// reaches its frame cap, or the start fails in the offscreen document. The
// worker removes `rec` then, so follow the key rather than only reading it in
// load().
chrome.storage.local.onChanged.addListener((changes) => {
  if (!('rec' in changes)) return;
  recChanged = true;
  $('stopBtn').disabled = !changes.rec.newValue;
  toggleRec();
});

for (const id of ['format', 'quality', 'filename', 'toClipboard', 'hideScrollbar', 'audio']) {
  $(id).addEventListener('change', () => {
    if (!ready) edited.add(id);
    if (id === 'format') { toggleQuality(); toggleAudio(); toggleRec(); }
    return save();
  });
}
$('quality').addEventListener('input', () => { if (!ready) edited.add('quality'); $('qualityVal').textContent = Math.round($('quality').value * 100) + '%'; });
$('filename').addEventListener('input', () => { if (!ready) edited.add('filename'); });
$('shortcuts').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });

paintFromCache(); // synchronous: correct UI in the first frame
// Un-awaited, so it is not on the path to the first paint: this only starts the
// worker, which checks `rec` against the offscreen document. If the key was a
// leftover - the extension disabled mid-recording, which Chrome tells the worker
// nothing about when it is enabled again - the worker removes it, and the
// storage listener above enables Record and greys out Stop. Nothing else here
// wakes the worker: this popup reads storage without it.
chrome.runtime.sendMessage({ type: 'rec-check' }).catch(() => { /* a worker that can't answer has no recording in it either */ });
const startup = load().catch(() => {
  showError('Couldn’t load settings. Close and reopen ViewShot to try again.');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'shot-clipboard') {
    (async () => {
      try {
        const blob = await (await fetch(msg.dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        sendResponse('done');
      } catch (e) {
        sendResponse({ error: e.message || String(e) });
      }
    })();
    return true;
  }
});
