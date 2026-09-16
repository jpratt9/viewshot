const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PNG = 'data:image/png;base64,AAAA';
const TAB = { id: 7, windowId: 1, url: 'https://a.com', title: 'T' };
const settle = () => new Promise((r) => setImmediate(r));

// Three unrelated errors showed up in chrome://extensions at once, and each one
// had the same shape: a real failure that reached the console and nothing else.
//   - MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, from two shots inside one second
//   - "Cannot access a chrome:// URL", from a capture on a chrome:// page
//   - "Cannot read properties of null (reading 'chunks')", from the recorder's
//     final flush landing after stop() had already nulled `rec`

// background.js against a fake browser. `clock` stands in for Date.now so the
// rate-limit gate can be driven without real waiting; sleeps advance it.
function loadBg({ captureFails = null, scriptFails = false } = {}) {
  const shots = [];
  const badges = [];
  const sleeps = [];
  let now = 100000;

  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    async convertToBlob() { return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }

  const chrome = {
    runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => {} },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      query: async () => [TAB],
      captureVisibleTab: async () => {
        shots.push(now);
        const e = captureFails && captureFails(shots.length);
        if (e) throw new Error(e);
        return PNG;
      },
    },
    scripting: {
      executeScript: async (o) => {
        if (scriptFails) throw new Error('Cannot access a chrome:// URL');
        return [{ result: o.func ? o.func.apply(null, o.args || []) : undefined }];
      },
    },
    downloads: { download: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    action: {
      setBadgeText: async ({ text }) => { if (text) badges.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
  };

  const context = {
    chrome, console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
    URL, btoa, clearTimeout,
    // Sleeps are the thing under test here, so record them and move the clock
    // rather than actually waiting.
    setTimeout: (fn, ms) => { sleeps.push(ms || 0); now += ms || 0; fn(); },
    // buildName still needs a real Date; only now() is under our control.
    Date: class extends Date { static now() { return now; } },
    window: {},
    document: { getElementById: () => null, head: null, documentElement: { appendChild() {} }, createElement: () => ({ style: {} }) },
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  return { ctx: context, shots, badges, sleeps, tick: (ms) => { now += ms; } };
}

const OPTS = { format: 'png', quality: 1, filename: 'x', toClipboard: false, hideScrollbar: true };

// --- MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND -------------------------------
// captureVisibleTab allows 2 calls/sec extension-wide and rejects instead of
// queueing. Two quick shots, or a Region straight after a Visible, blew past it.

test('spaces consecutive captures out past the per-second quota', async () => {
  const bg = loadBg();
  await bg.ctx.runCapture('visible', OPTS);
  await bg.ctx.runCapture('visible', OPTS);
  assert.strictEqual(bg.shots.length, 2);
  assert.ok(bg.shots[1] - bg.shots[0] >= 500,
    `only ${bg.shots[1] - bg.shots[0]}ms apart, which is inside the 2/sec quota`);
});

test('does not delay a capture that already stands alone', async () => {
  const bg = loadBg();
  await bg.ctx.runCapture('visible', OPTS);
  bg.tick(5000); // plenty of idle time since the last shot
  const before = bg.sleeps.length;
  await bg.ctx.runCapture('visible', OPTS);
  assert.ok(!bg.sleeps.slice(before).some((ms) => ms >= 500),
    'waited out a gap that had already elapsed');
});

test('retries once when the quota is hit anyway', async () => {
  const bg = loadBg({ captureFails: (n) => (n === 1 ? 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.' : null) });
  await bg.ctx.runCapture('visible', OPTS);
  assert.strictEqual(bg.shots.length, 2, 'the quota rejection should have been retried');
  assert.deepStrictEqual(bg.badges, [], 'a retry that succeeds is not a user-visible failure');
});

test('does not retry a failure that is not about the quota', async () => {
  const bg = loadBg({ captureFails: () => 'Cannot access contents of the page' });
  await bg.ctx.runCapture('visible', OPTS).catch(() => {});
  assert.strictEqual(bg.shots.length, 1);
});

test('a failed capture does not stall the next one', async () => {
  const bg = loadBg({ captureFails: (n) => (n === 1 ? 'Cannot access contents of the page' : null) });
  await bg.ctx.runCapture('visible', OPTS).catch(() => {});
  await bg.ctx.runCapture('visible', OPTS);
  assert.strictEqual(bg.shots.length, 2, 'the gate stayed shut on the rejected promise');
});

// --- "Cannot access a chrome:// URL" ---------------------------------------
// Hiding the scrollbar is cosmetic and is on by default, so on a chrome:// page
// it threw before the shutter was ever reached, and the failure went nowhere
// but the console - identical, from outside, to a button that does nothing.

test('hiding the scrollbar does not fail a capture on an uninjectable page', async () => {
  const bg = loadBg({ scriptFails: true });
  await assert.doesNotReject(() => bg.ctx.setScrollbarHidden(TAB, true));
  await assert.doesNotReject(() => bg.ctx.setScrollbarHidden(TAB, false));
});

test('an uninjectable page still reaches the shutter', async () => {
  const bg = loadBg({ scriptFails: true });
  await bg.ctx.runCapture('visible', OPTS);
  assert.strictEqual(bg.shots.length, 1, 'the cosmetic step swallowed the whole capture');
});

test('a capture that really fails flashes the badge instead of dying quietly', async () => {
  const bg = loadBg({ captureFails: () => 'Cannot access a chrome:// URL' });
  await bg.ctx.runCapture('visible', OPTS).catch(bg.ctx.captureFailed);
  await settle(); // flashBadge is fire-and-forget: let it reach setBadgeText
  assert.deepStrictEqual(bg.badges, ['!']);
});

// --- "blip failed" ---------------------------------------------------------
// Starting a recording on a page that refuses scripts (the Web Store, or a
// file:// page without file access) skips the edge-glow blip on purpose. The
// skip was logged with console.error, and chrome://extensions lists every
// console.error from the worker as an extension error.

test('recording a page that refuses scripts logs a warning, not an error', async () => {
  const bg = loadBg({ scriptFails: true });
  const logged = { error: [], warn: [] };
  bg.ctx.console.error = (...a) => logged.error.push(a.join(' '));
  bg.ctx.console.warn = (...a) => logged.warn.push(a.join(' '));
  bg.ctx.chrome.offscreen = { hasDocument: async () => true }; // already open
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' });
  assert.deepStrictEqual(logged.error, [], 'chrome://extensions lists these as extension errors');
  assert.ok(logged.warn.some((m) => m.includes('blip failed')), 'the skipped blip left no trace in the console');
});

// --- the popup says which page it was --------------------------------------

function loadPopup(url, { fileAccess = true, streamIdFails = false } = {}) {
  const els = {};
  const sent = [];
  const makeEl = () => {
    const el = {
      style: {}, dataset: {}, listeners: {},
      disabled: false, hidden: true, checked: false, value: '', textContent: '',
      addEventListener(t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); },
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
    };
    return el;
  };
  const modes = ['visible', 'fullpage', 'region'].map((m) => {
    const el = makeEl();
    el.dataset.mode = m;
    return el;
  });
  const context = {
    console: { ...console, error: () => {} }, Math, parseFloat, JSON,
    window: { close: () => {} },
    document: {
      getElementById: (id) => (els[id] = els[id] || makeEl()),
      querySelector: () => makeEl(),
      querySelectorAll: (sel) => (sel.includes('#modes') ? modes : []),
    },
    chrome: {
      tabs: { query: async () => [{ id: 1, url, title: 'T' }], create: () => {} },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      runtime: { sendMessage: async (m) => { sent.push(m); return true; } },
      tabCapture: { getMediaStreamId: async () => { if (streamIdFails) throw new Error('stream id refused'); return 'sid'; } },
      extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);
  return {
    els, sent,
    ready: settle, // let load() resolve so activeTab is populated
    click: (mode) => modes.find((b) => b.dataset.mode === mode).listeners.click[0](),
  };
}

test('refuses the extension gallery and devtools too', async () => {
  for (const url of ['chrome-extension://abc/page.html', 'devtools://devtools/bundled/x.html', 'about:blank']) {
    for (const mode of ['visible', 'region']) {
      const p = loadPopup(url);
      await p.ready();
      await p.click(mode);
      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was allowed through`);
      assert.strictEqual(p.els.err.hidden, false, `${mode} on ${url} was refused without a message`);
    }
  }
});

test('lets an ordinary page through untouched', async () => {
  for (const url of ['https://a.com/x', 'http://a.com', 'file:///tmp/a.html']) {
    const p = loadPopup(url);
    await p.ready();
    await p.click('visible');
    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `${url} was wrongly blocked`);
  }
});

// --- chrome:// pages ---------------------------------------------------------
// Chrome refuses executeScript on chrome:// pages, but once the popup has
// granted activeTab it lets captureVisibleTab through. The popup refused every
// mode there, so the one capture Chrome allows never reached the worker.

const CHROME_URLS = ['chrome://extensions/', 'chrome://version/', 'chrome://newtab/'];

test('takes a Visible screenshot of chrome:// pages', async () => {
  for (const url of CHROME_URLS) {
    const p = loadPopup(url);
    await p.ready();
    await p.click('visible');
    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `Visible on ${url} was wrongly blocked`);
  }
});

test('refuses Full page and Region on chrome:// pages with a message rather than a silent no-op', async () => {
  for (const url of CHROME_URLS) {
    for (const mode of ['fullpage', 'region']) {
      const p = loadPopup(url);
      await p.ready();
      await p.click(mode);
      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was sent to the worker`);
      assert.strictEqual(p.els.err.hidden, false);
      assert.match(p.els.err.textContent, /Full page or Region on chrome:\/\/ pages\. Visible still works/);
    }
  }
});

test('still refuses Record on chrome:// pages', async () => {
  for (const url of CHROME_URLS) {
    const p = loadPopup(url);
    await p.ready();
    p.els.format.value = 'webm'; // turns Visible into Record
    await p.click('visible');
    assert.deepStrictEqual(p.sent, [], `recording ${url} was sent to the worker`);
    assert.strictEqual(p.els.err.hidden, false);
  }
});

test('the refusal messages no longer steer the user away from chrome:// pages or the Web Store', async () => {
  // Visible works on both, and Record works on the Web Store.
  const page = loadPopup('chrome-extension://abc/page.html');
  await page.ready();
  await page.click('visible');
  assert.strictEqual(page.els.err.hidden, false);
  assert.doesNotMatch(page.els.err.textContent, /chrome:\/\/|Web Store/);

  const rec = loadPopup('https://a.com/x', { streamIdFails: true });
  await rec.ready();
  rec.els.format.value = 'webm'; // turns Visible into Record
  await rec.click('visible');
  assert.deepStrictEqual(rec.sent, [], 'a recording started without a stream id');
  assert.strictEqual(rec.els.err.hidden, false);
  assert.doesNotMatch(rec.els.err.textContent, /chrome:\/\/|Web Store/);
});

// --- pages that pass the scheme check but still can't be captured ---------
// Chrome never lets an extension script the Web Store, and a file:// page can't
// be scripted or captured until "Allow access to file URLs" is on. The popup
// let both through, so the only sign of the failure was a 3-second badge, and
// for Region the popup had already closed by then.

const WEB_STORE_URLS = ['https://chromewebstore.google.com/detail/x/abc', 'https://chrome.google.com/webstore/category/extensions'];

test('refuses Full page and Region on the Web Store', async () => {
  for (const url of WEB_STORE_URLS) {
    for (const mode of ['fullpage', 'region']) {
      const p = loadPopup(url);
      await p.ready();
      await p.click(mode);
      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was sent to the worker`);
      assert.strictEqual(p.els.err.hidden, false);
      assert.match(p.els.err.textContent, /Web Store/);
    }
  }
});

test('still takes Visible on the Web Store, and Full page on look-alike hosts', async () => {
  const cases = [
    ...WEB_STORE_URLS.map((url) => [url, 'visible']), // Chrome lets activeTab capture the store
    ['https://www.google.com/chrome/', 'fullpage'],
    ['https://notchrome.google.com/', 'fullpage'],
    ['https://chromewebstore.google.com.example/', 'fullpage'],
  ];
  for (const [url, mode] of cases) {
    const p = loadPopup(url);
    await p.ready();
    await p.click(mode);
    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `${mode} on ${url} was wrongly blocked`);
  }
});

test('refuses every screenshot mode on a file:// page while file access is off', async () => {
  for (const mode of ['visible', 'fullpage', 'region']) {
    const p = loadPopup('file:///tmp/a.html', { fileAccess: false });
    await p.ready();
    await p.click(mode);
    assert.deepStrictEqual(p.sent, [], `${mode} was sent to the worker`);
    assert.strictEqual(p.els.err.hidden, false);
    assert.match(p.els.err.textContent, /Allow access to file URLs/);
  }
});

test('still records on the Web Store, and on a file:// page without file access', async () => {
  for (const [url, fileAccess] of [[WEB_STORE_URLS[0], true], ['file:///tmp/a.html', false]]) {
    const p = loadPopup(url, { fileAccess });
    await p.ready();
    p.els.format.value = 'webm'; // turns Visible into Record
    await p.click('visible');
    assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], `recording ${url} was blocked`);
  }
});

// --- "Cannot read properties of null (reading 'chunks')" --------------------
// MediaRecorder.stop() flushes one last dataavailable on a later task, by which
// time stopRecording has already nulled `rec`. The handler read rec.chunks, so
// it threw and the final second of every recording was lost.

function loadOffscreen() {
  const recorders = [];
  const downloads = [];
  class FakeRecorder {
    constructor() { this.state = 'recording'; recorders.push(this); }
    start() {}
    // Mirrors the real ordering: a final dataavailable, then onstop, both async.
    stop() { this.state = 'inactive'; }
    flush(blob) { this.ondataavailable({ data: blob }); }
    finish() { this.onstop?.(); } // `stop` fires whether or not anyone listens
  }
  FakeRecorder.isTypeSupported = () => true;

  const sent = [];
  const trackListeners = {};
  const track = { stop() {}, addEventListener: (type, fn) => { trackListeners[type] = fn; } };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const context = {
    console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async (m) => { sent.push(m); }, getURL: (p) => p },
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    MediaRecorder: FakeRecorder,
    Blob: class { constructor(parts) { this.parts = parts; this.size = parts.length; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: {
      createElement: () => ({ style: {}, click() {}, remove() {}, appendChild() {} }),
      body: { appendChild() {} },
    },
    setTimeout: () => 0, clearInterval: () => {}, setInterval: () => 0,
    GIF: class {},
  };
  vm.createContext(context);
  vm.runInContext(read('offscreen.js'), context);
  // download() writes through an <a>, so swap it out and keep the Blob instead.
  vm.runInContext('download = (blob, name) => { __downloads.push([blob, name]); };', Object.assign(context, { __downloads: downloads }));
  return { ctx: context, recorders, downloads, sent, endTrack: () => trackListeners.ended() };
}

test('the final flush after stop() still lands in the recording', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  r.flush({ size: 10 });
  o.ctx.stopRecording('out.webm');
  // `rec` is null now; this is the flush MediaRecorder still owed us.
  assert.doesNotThrow(() => r.flush({ size: 7 }), 'the handler dereferenced a nulled rec');
  r.finish();
  await settle(); // the save waits on the recorder's `stop`
  assert.strictEqual(o.downloads.length, 1);
  assert.strictEqual(o.downloads[0][0].parts.length, 2, 'the last chunk never reached the file');
});

test('a zero-length flush is still ignored', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  r.flush({ size: 0 });
  o.ctx.stopRecording('out.webm');
  r.finish();
  await settle();
  assert.strictEqual(o.downloads[0][0].parts.length, 0);
});

// --- a WebM recording lost when its tab closed -----------------------------
// Closing the recorded tab ends the track, and MediaRecorder stops by itself -
// final flush, then `stop` - before rec-stop has been to the worker and back.
// stopRecording() only set onstop after that, so it never ran and no file was
// written.

test('a recording whose tab was closed is still saved', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  r.flush({ size: 10 });
  o.endTrack();
  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-stop'], 'the ended track did not ask the worker to stop');
  // The recorder winds itself down before the worker's answer arrives.
  r.state = 'inactive';
  r.flush({ size: 7 });
  r.finish();
  o.ctx.stopRecording('out.webm'); // the worker's rec-stop-offscreen
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
  assert.strictEqual(o.downloads[0][1], 'out.webm');
  assert.strictEqual(o.downloads[0][0].parts.length, 2, 'the saved recording is missing chunks');
});

test('a tab-closed recording waits for a stop that is still on its way', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  r.flush({ size: 10 });
  o.endTrack();
  // Already inactive, with its final flush and `stop` still queued: it must not
  // be stopped again, and nothing may be saved before that flush lands.
  r.state = 'inactive';
  r.stop = () => { throw new Error('stop() called on an inactive recorder'); };
  o.ctx.stopRecording('out.webm');
  await settle();
  assert.strictEqual(o.downloads.length, 0, 'saved before the final flush arrived');
  r.flush({ size: 7 });
  r.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
  assert.strictEqual(o.downloads[0][0].parts.length, 2, 'the saved recording is missing its final chunk');
});
