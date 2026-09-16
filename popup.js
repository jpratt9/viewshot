const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
const $ = (id) => document.getElementById(id);
const isRecFmt = (f) => f === 'webm' || f === 'mp4' || f === 'gif';
let activeTab = null;

const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };

// Pages that aren't http(s), file, ftp or chrome:// are refused before anything
// is sent: captures there failed in the worker, which threw into a console the
// user never has open. chrome:// pages (the New Tab page is one) refuse
// executeScript ("Cannot access a chrome:// URL"), which Full page and Region
// need, but activeTab still lets Chrome capture and record them, so Visible
// and Record go through.
// activeTab is null until load() resolves; the worker's badge covers that gap.
const CAPTURABLE = /^(https?|file|ftp|chrome):/i;
const CHROME_PAGE = /^chrome:/i;
const uncapturable = (tab) => !!(tab && tab.url && !CAPTURABLE.test(tab.url));
// Chrome never lets an extension script the Web Store (all of chrome.google.com
// and chromewebstore.google.com), so Full page and Region can't run there.
// Visible still can: Chrome lets activeTab capture the store.
const WEB_STORE = /^https?:\/\/([\w-]+\.)*(chromewebstore|chrome)\.google\.com([:/?#]|$)/i;

function apply(o) {
  $('format').value = o.format;
  $('quality').value = o.quality;
  $('qualityVal').textContent = Math.round(o.quality * 100) + '%';
  $('filename').value = o.filename;
  $('toClipboard').checked = o.toClipboard;
  $('hideScrollbar').checked = o.hideScrollbar;
  toggleQuality();
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
  apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
  // The Stop button stays greyed out unless a recording is actually running.
  $('stopBtn').disabled = !stored.rec;
}

function read() {
  return {
    format: $('format').value,
    quality: parseFloat($('quality').value),
    filename: $('filename').value.trim() || 'shot-{date}-{time}',
    toClipboard: $('toClipboard').checked,
    hideScrollbar: $('hideScrollbar').checked,
  };
}

const save = () => {
  const o = read();
  try { localStorage.setItem('opts', JSON.stringify(o)); } catch { /* mirror is best-effort */ }
  return chrome.storage.local.set({ opts: o });
};
// Quality slider only applies to the still image formats jpg/webp.
const toggleQuality = () => { $('qualityRow').style.display = (['jpg', 'webp'].includes($('format').value)) ? 'flex' : 'none'; };

// Recording captures the whole visible tab, so full-page/region don't apply —
// disable them and relabel the "Visible" button as "Record" for video formats.
function toggleRec() {
  const rec = isRecFmt($('format').value);
  const vis = document.querySelector('.mode[data-mode="visible"]');
  vis.querySelector('.lbl').textContent = rec ? 'Record' : 'Visible';
  vis.querySelector('.ico').textContent = rec ? '●' : '▢';
  document.querySelectorAll('.mode[data-mode="fullpage"], .mode[data-mode="region"]').forEach((b) => { b.disabled = rec; });
}

document.querySelectorAll('#modes .mode').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (uncapturable(activeTab)) {
      showError('Can’t capture this page. Open a normal http(s) page and try again.');
      return; // keep the popup open so the error is visible
    }
    const opts = read();
    if (isRecFmt(opts.format)) {
      // Mint the capture stream id HERE, while the click's user gesture is still
      // live — getMediaStreamId rejects without it, and the background worker
      // (a plain message handler) has no gesture to offer.
      let streamId;
      try {
        streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
      } catch (e) {
        console.error('[ViewShot] getMediaStreamId failed:', e);
        showError('Can’t record this tab. Open a normal http(s) page and try again.');
        return; // keep the popup open so the error is visible
      }
      await save();
      chrome.runtime.sendMessage({ type: 'rec-start', streamId, opts });
      $('stopBtn').disabled = false; // popup stays open, so reflect the live recording
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
      await save();
      // Wait for the worker to acknowledge before closing anything. window.close()
      // in the same turn as the send tears this frame down while a cold-starting
      // worker is still waking, and the message goes with it - the click did
      // nothing at all, and pressing Region again worked only because the second
      // press met a worker that was already awake.
      try {
        await chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, opts });
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

$('stopBtn').addEventListener('click', () => { if ($('stopBtn').disabled) return; chrome.runtime.sendMessage({ type: 'rec-stop' }); $('stopBtn').disabled = true; });

$('format').addEventListener('change', () => { toggleQuality(); toggleRec(); save(); });
$('quality').addEventListener('input', () => { $('qualityVal').textContent = Math.round($('quality').value * 100) + '%'; });
$('quality').addEventListener('change', save);
$('filename').addEventListener('change', save);
$('toClipboard').addEventListener('change', save);
$('hideScrollbar').addEventListener('change', save);
$('shortcuts').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });

paintFromCache(); // synchronous: correct UI in the first frame
load();           // then reconcile with chrome.storage + the active tab
