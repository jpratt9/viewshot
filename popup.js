const DEFAULTS = { format: 'png', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
const $ = (id) => document.getElementById(id);
const isRecFmt = (f) => f === 'webm' || f === 'gif';
let activeTab = null;

const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };

async function load() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { opts } = await chrome.storage.local.get('opts');
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (o.filename === 'shot-{date}') o.filename = DEFAULTS.filename; // migrate old default
  $('format').value = o.format;
  $('quality').value = o.quality;
  $('qualityVal').textContent = Math.round(o.quality * 100) + '%';
  $('filename').value = o.filename;
  $('toClipboard').checked = o.toClipboard;
  $('hideScrollbar').checked = o.hideScrollbar;
  toggleQuality();
  toggleRec();

  // The Stop button stays greyed out unless a recording is actually running.
  const { rec } = await chrome.storage.local.get('rec');
  $('stopBtn').disabled = !rec;
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

const save = () => chrome.storage.local.set({ opts: read() });
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
        showError('Can’t record this tab. Open a normal http(s) page (not chrome://, the Web Store, or a new tab) and try again.');
        return; // keep the popup open so the error is visible
      }
      await save();
      chrome.runtime.sendMessage({ type: 'rec-start', streamId, opts });
    } else {
      await save();
      chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, opts });
    }
    window.close();
  });
});

$('stopBtn').addEventListener('click', () => { if ($('stopBtn').disabled) return; chrome.runtime.sendMessage({ type: 'rec-stop' }); window.close(); });

$('format').addEventListener('change', () => { toggleQuality(); toggleRec(); save(); });
$('quality').addEventListener('input', () => { $('qualityVal').textContent = Math.round($('quality').value * 100) + '%'; });
$('quality').addEventListener('change', save);
$('filename').addEventListener('change', save);
$('toClipboard').addEventListener('change', save);
$('hideScrollbar').addEventListener('change', save);
$('shortcuts').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });

load();
