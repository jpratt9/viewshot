const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const settle = () => new Promise((r) => setImmediate(r));

// --- screenshot shortcuts with a recording format selected --------------
// The popup never takes a screenshot in WebM, MP4 or GIF: it turns Visible into
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
    runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => {} },
    commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: 'https://a.com', title: 'T' }],
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    },
    scripting: { insertCSS: async () => {}, removeCSS: async () => {}, executeScript: async () => [{}] },
    downloads: { download: async (o) => { downloads.push(o); } },
    storage: { session: (() => { let s = {}; return { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o), remove: async (k) => delete s[k] }; })(), local: { get: async () => ({ opts: { format, filename: 'shot' } }) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
  const context = {
    chrome, console: { ...console, error: () => {} }, URL, btoa, Date,
    // Nothing on this path needs a real wait, and the capture deadline never passes.
    setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
  await onCommand(command);
  await settle(); // the listener doesn't return the capture, so let it finish
  return downloads;
}

for (const format of ['webm', 'mp4', 'gif']) {
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

// Exercise the real command/start/stop paths, substituting only page setup.
function recordingBrowser(format = 'webm', storedRec = null, saved = {}) {
  let onCommand, onMessage, rec = storedRec, hasDoc = !!storedRec;
  const calls = { streams: [], sent: [], badges: [] };
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { onMessage = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      sendMessage: async (m) => { calls.sent.push(m); return m.type === 'offscreen-id' ? 'doc' : 'pong'; },
    },
    commands: { onCommand: { addListener(fn) { onCommand = fn; } } },
    storage: { session: (() => { let s = {}; return { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o), remove: async (k) => delete s[k] }; })(), local: {
      get: async (key) => key === 'rec' ? { rec } : { opts: { format, filename: 'recording', ...saved } },
      set: async (v) => { if ('rec' in v) rec = v.rec; },
      remove: async () => { rec = null; },
    } },
    tabs: { get: async (id) => ({ id, url: 'https://example.com', title: 'Tab' }), query: async () => [{ id: 9 }] },
    tabCapture: { getMediaStreamId: async (o) => { calls.streams.push(o.targetTabId); return 'stream'; } },
    offscreen: { hasDocument: async () => hasDoc },
    action: { setBadgeText: async ({ text }) => calls.badges.push(text), setBadgeBackgroundColor: async () => {} },
  };
  const ctx = vm.createContext({ chrome, console: { log() {}, warn() {}, error() {} }, setTimeout() {}, Date, URL });
  vm.runInContext(read('background.js'), ctx);
  ctx.ensureOffscreen = async () => { hasDoc = true; };
  ctx.blipRecordingIndicator = async () => 0;
  ctx.getViewport = async () => ({ width: 1280, height: 720 });
  return { ctx, calls, rec: () => rec, setFormat: (f) => { format = f; }, killDoc: () => { hasDoc = false; },
    press: (id = 7) => onCommand('toggle-recording', { id }),
    popup: () => new Promise((resolve) => onMessage({ type: 'rec-start', streamId: 'popup-stream', opts: { format, filename: 'popup' }, tabId: 8 }, {}, resolve)),
  };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

for (const format of ['webm', 'mp4', 'gif']) {
  test(`recording shortcut starts ${format} and stops it from another tab even with an image selected`, async () => {
    const b = recordingBrowser(format);
    await b.press();
    assert.deepStrictEqual(b.calls.streams, [7]);
    assert.strictEqual(b.rec().format, format);
    assert.strictEqual(b.calls.sent.find(m => m.type === 'rec-start-offscreen').format, format);
    b.setFormat('jpg');
    await b.press(99);
    assert.strictEqual(b.rec(), null);
    assert.deepStrictEqual(b.calls.streams, [7]);
    assert.strictEqual(b.calls.sent.find(m => m.type === 'rec-stop-offscreen').filename, `recording.${format}`);
  });
}

// Alt+Shift+S reads the saved settings rather than the popup's form, so "Record
// tab audio" reaches the offscreen document through getOpts() (KAN-221). Saved
// settings from before the option existed fall back to DEFAULTS: no audio.
for (const [saved, audio] of [[{ audio: true }, true], [{ audio: false }, false], [{}, false]]) {
  test(`recording shortcut sends audio ${audio} when the saved settings have ${JSON.stringify(saved)}`, async () => {
    const b = recordingBrowser('webm', null, saved);
    await b.press();
    assert.strictEqual(b.calls.sent.find(m => m.type === 'rec-start-offscreen').audio, audio);
  });
}

test('image formats require selecting a recording format first', async () => {
  for (const f of ['jpg', 'png', 'webp']) {
    const b = recordingBrowser(f); await b.press();
    assert.strictEqual(b.calls.streams.length, 0);
    assert.ok(b.calls.badges.includes('!'));
  }
});

test('stale recording state does not prevent a shortcut start', async () => {
  const b = recordingBrowser('webm', { docId: 'doc', format: 'gif' }); b.killDoc();
  await b.press(); assert.strictEqual(b.rec().format, 'webm');
});

test('stream acquisition failure releases the gate for retry', async () => {
  const b = recordingBrowser();
  b.ctx.chrome.tabCapture.getMediaStreamId = async () => { throw new Error('denied'); };
  await b.press(); assert.strictEqual(b.rec(), null); assert.ok(b.calls.badges.includes('!'));
  b.ctx.chrome.tabCapture.getMediaStreamId = async () => 'ok';
  await b.press(); assert.strictEqual(b.rec().format, 'webm');
});

test('early repeated command and popup start cannot queue another recording', async () => {
  const b = recordingBrowser(), wait = deferred();
  b.ctx.chrome.tabCapture.getMediaStreamId = () => wait.promise;
  const first = b.press(); await settle();
  await b.press(); assert.strictEqual(await b.popup(), false);
  wait.resolve('stream'); await first;
  assert.strictEqual(b.calls.sent.filter(m => m.type === 'rec-start-offscreen').length, 1);
});

test('shortcut stops a recording during startup without waiting for the blip', async () => {
  const b = recordingBrowser(), wait = deferred();
  b.ctx.blipRecordingIndicator = () => wait.promise;
  const first = b.press(); await settle(); assert.ok(b.rec());
  await b.press(); assert.strictEqual(b.rec(), null);
  wait.resolve(0); await first;
  assert.strictEqual(b.calls.sent.filter(m => m.type === 'rec-start-offscreen').length, 0);
});

test('shortcut during an early popup start does not acquire another stream', async () => {
  const b = recordingBrowser(), wait = deferred();
  b.ctx.ensureOffscreen = () => wait.promise;
  const popup = b.popup(); await settle(); await b.press();
  assert.strictEqual(b.calls.streams.length, 0);
  wait.resolve(); assert.strictEqual(await popup, true);
});

test('failed shortcut setup clears recording state and permits a retry', async () => {
  const b = recordingBrowser();
  const send = b.ctx.chrome.runtime.sendMessage;
  b.ctx.chrome.runtime.sendMessage = async (m) => {
    if (m.type === 'rec-start-offscreen') throw new Error('offscreen disappeared');
    return send(m);
  };
  await b.press();
  assert.strictEqual(b.rec(), null);
  assert.ok(b.calls.badges.includes('!'));
  b.ctx.chrome.runtime.sendMessage = send;
  await b.press();
  assert.strictEqual(b.rec().format, 'webm');
});

test('failed shortcut state lookup does not erase an existing recording', async () => {
  const rec = { docId: 'doc', format: 'webm', filename: 'existing' };
  const b = recordingBrowser('webm', rec);
  const get = b.ctx.chrome.storage.local.get;
  b.ctx.chrome.storage.local.get = async () => { throw new Error('storage unavailable'); };
  await b.press();
  assert.strictEqual(b.rec(), rec);
  assert.strictEqual(b.calls.streams.length, 0);
  assert.ok(b.calls.badges.includes('!'));
  b.ctx.chrome.storage.local.get = get;
  await b.press();
  assert.strictEqual(b.rec(), null);
});
