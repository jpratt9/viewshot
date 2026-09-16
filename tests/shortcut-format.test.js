const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const settle = () => new Promise((r) => setImmediate(r));

// --- screenshot shortcuts with a recording format selected --------------
// The popup never takes a screenshot in WebM or GIF: it turns Visible into
// Record and disables the other two modes. The shortcuts read the same
// stored format with no such check, and encode() fell back to PNG data but
// still named the file after the format, so Alt+Shift+V asked for a PNG to
// be saved as shot.gif. Chrome 152 quietly renames that to .png, which hid
// the mismatch rather than fixing it.

// Loads background.js against a fake browser whose stored format is `format`,
// presses `command`, and returns every download the worker started.
async function pressShortcut(command, format) {
  const downloads = [];
  let onCommand;
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    // Hand back a blob of whatever type was asked for, so the data URL shows
    // what encode() actually produced.
    async convertToBlob({ type }) { return { type, arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: 'https://a.com', title: 'T' }],
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    },
    scripting: { executeScript: async () => [{}] },
    downloads: { download: async (o) => { downloads.push(o); } },
    storage: { local: { get: async () => ({ opts: { format, filename: 'shot' } }) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const context = {
    chrome, console: { ...console, error: () => {} }, URL, btoa, Date,
    setTimeout: (fn) => fn(), // nothing on this path needs a real wait
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  await onCommand(command);
  await settle(); // the listener doesn't return the capture, so let it finish
  return downloads;
}

for (const format of ['webm', 'gif']) {
  test(`a screenshot shortcut with ${format} selected downloads a PNG named .png`, async () => {
    const downloads = await pressShortcut('capture-visible', format);
    assert.strictEqual(downloads.length, 1, 'the shortcut should still take the screenshot');
    assert.match(downloads[0].url, /^data:image\/png;/);
    assert.strictEqual(downloads[0].filename, 'shot.png', `the PNG was requested as ${downloads[0].filename}`);
  });
}

test('a shortcut with an image format selected still downloads that format', async () => {
  for (const [format, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const [download] = await pressShortcut('capture-visible', format);
    assert.ok(download.url.startsWith(`data:${mime};`), `${format} was not encoded as ${mime}`);
    assert.strictEqual(download.filename, `shot.${format}`);
  }
});
