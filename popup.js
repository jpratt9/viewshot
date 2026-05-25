const DEFAULTS = { format: 'png', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false };
const $ = (id) => document.getElementById(id);

async function load() {
  const { opts } = await chrome.storage.local.get('opts');
  const o = { ...DEFAULTS, ...(opts || {}) };
  if (o.filename === 'shot-{date}') o.filename = DEFAULTS.filename; // migrate old default
  $('format').value = o.format;
  $('quality').value = o.quality;
  $('qualityVal').textContent = Math.round(o.quality * 100) + '%';
  $('filename').value = o.filename;
  $('toClipboard').checked = o.toClipboard;
  toggleQuality();
}

function read() {
  return {
    format: $('format').value,
    quality: parseFloat($('quality').value),
    filename: $('filename').value.trim() || 'shot-{date}-{time}',
    toClipboard: $('toClipboard').checked,
  };
}

const save = () => chrome.storage.local.set({ opts: read() });
const toggleQuality = () => { $('qualityRow').style.display = $('format').value === 'png' ? 'none' : 'flex'; };

document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await save();
    chrome.runtime.sendMessage({ type: 'capture', mode: btn.dataset.mode, opts: read() });
    window.close();
  });
});

$('format').addEventListener('change', () => { toggleQuality(); save(); });
$('quality').addEventListener('input', () => { $('qualityVal').textContent = Math.round($('quality').value * 100) + '%'; });
$('quality').addEventListener('change', save);
$('filename').addEventListener('change', save);
$('toClipboard').addEventListener('change', save);
$('shortcuts').addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });

load();
