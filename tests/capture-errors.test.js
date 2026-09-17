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
function loadBg({ captureFails = null, captureHangs = null, scriptFails = false, noActiveTab = false } = {}) {
  const shots = [];
  const badges = [];
  const sleeps = [];
  const deadlines = [];
  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  let scriptTimeout; // SCRIPT_TIMEOUT_MS, likewise
  let now = 100000;
  let onMessage, onCommand;

  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    async convertToBlob() { return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }

  const chrome = {
    // The first message listener is background.js's own; Region adds more later.
    runtime: {
      onMessage: { addListener: (fn) => { onMessage = onMessage || fn; }, removeListener() {} },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      sendMessage: async () => {},
    },
    commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
    tabs: {
      query: async () => (noActiveTab ? [] : [TAB]),
      get: async (id) => { if (id !== TAB.id) throw new Error(`No tab with id: ${id}.`); return TAB; },
      captureVisibleTab: async () => {
        shots.push(now);
        if (captureHangs && captureHangs(shots.length)) return new Promise(() => {}); // Chrome never answers
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
    // rather than actually waiting. The capture and page-script deadlines
    // aren't sleeps: they are held until the test calls expire().
    setTimeout: (fn, ms) => {
      if (ms === captureTimeout || ms === scriptTimeout) { deadlines.push(fn); return; }
      sleeps.push(ms || 0); now += ms || 0; fn();
    },
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
  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
  scriptTimeout = vm.runInContext('SCRIPT_TIMEOUT_MS', context);
  return {
    ctx: context, shots, badges, sleeps,
    message: (msg, respond = () => {}) => onMessage(msg, {}, respond), // respond gets the listener's answer
    command: (cmd, tab) => onCommand(cmd, tab),
    tick: (ms) => { now += ms; },
    expire: () => deadlines.splice(0).forEach((fn) => fn()), // the held deadlines pass
  };
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

// --- a capture Chrome never answers -----------------------------------------
// Chrome was seen never to return from a captureVisibleTab call. The gate
// waited on that call for good, so the capture never finished and neither did
// any capture after it: nothing saved, no badge, and the page left with its
// scrollbar hidden.

test('gives up on a capture Chrome never answers', async () => {
  const bg = loadBg({ captureHangs: (n) => n === 1 });
  const hidden = [];
  const setScrollbarHidden = bg.ctx.setScrollbarHidden;
  bg.ctx.setScrollbarHidden = (tab, hide) => { hidden.push(hide); return setScrollbarHidden(tab, hide); };
  let failure;
  bg.ctx.runCapture('visible', OPTS).catch((e) => { failure = e; bg.ctx.captureFailed(e); });
  await settle();
  assert.strictEqual(failure, undefined, 'gave up before the deadline');
  bg.expire();
  await settle();
  assert.match(String(failure), /did not answer/, 'still waiting on a call Chrome will never answer');
  assert.deepStrictEqual(hidden, [true, false], 'the scrollbar was left hidden');
  assert.deepStrictEqual(bg.badges, ['!']);
});

test('a capture Chrome never answers does not hold up the next one', async () => {
  const bg = loadBg({ captureHangs: (n) => n === 1 });
  bg.ctx.runCapture('visible', OPTS).catch(() => {});
  let next;
  bg.ctx.runCapture('visible', OPTS).then(() => { next = 'saved'; }, (e) => { next = e; });
  await settle();
  bg.expire();
  await settle();
  assert.strictEqual(bg.shots.length, 2, 'the next capture never reached Chrome');
  assert.strictEqual(next, 'saved');
});

test('gives up on a quota retry Chrome never answers', async () => {
  const bg = loadBg({
    captureFails: (n) => (n === 1 ? 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.' : null),
    captureHangs: (n) => n === 2,
  });
  let failure;
  bg.ctx.runCapture('visible', OPTS).catch((e) => { failure = e; });
  await settle();
  assert.strictEqual(bg.shots.length, 2, 'the quota rejection was not retried');
  assert.strictEqual(failure, undefined, 'gave up before the deadline');
  bg.expire();
  await settle();
  assert.match(String(failure), /did not answer/, 'still waiting on a retry Chrome will never answer');
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

function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true } = {}) {
  const els = {};
  const sent = [];
  const writes = [];
  const streams = [];
  let onStored; // popup.js's chrome.storage.local.onChanged listener
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
  els.stopBtn = makeEl();
  els.stopBtn.disabled = true; // as popup.html has it
  const context = {
    console: { ...console, error: () => {} }, Math, parseFloat, JSON,
    window: { close: () => {} },
    document: {
      getElementById: (id) => (els[id] = els[id] || makeEl()),
      // toggleRec() asks for the Visible/Record button: hand back the one the test clicks.
      querySelector: (sel) => modes.find((b) => sel.includes(`"${b.dataset.mode}"`)) || makeEl(),
      querySelectorAll: (sel) => sel.includes('#modes') ? modes : modes.filter(b => sel.includes(`"${b.dataset.mode}"`)),
    },
    chrome: {
      tabs: { query: async () => { await startupGate; if (startupFails) throw new Error('startup failed'); return [{ id: 1, url, title: 'T' }]; }, create: () => {} },
      storage: {
        local: {
          get: async () => store, set: async (o) => { writes.push(o); }, // `opts` and `rec`
          onChanged: { addListener: (fn) => { onStored = fn; } },
        },
      },
      runtime: { sendMessage: async (m) => { sent.push(m); if (reply instanceof Error) throw reply; return reply; } }, // the worker's answer
      tabCapture: { getMediaStreamId: async () => { streams.push('requested'); if (streamIdFails) throw new Error('stream id refused'); return 'sid'; } },
      extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);
  const btn = (mode) => modes.find((b) => b.dataset.mode === mode);
  return {
    els, sent, btn, writes, streams,
    ready: settle, // let load() resolve so activeTab is populated
    click: (mode) => btn(mode).listeners.click[0](),
    stop: () => els.stopBtn.listeners.click[0](),
    stored: (changes) => onStored?.(changes), // storage changing while the popup is open
  };
}

test('refuses devtools, chrome-untrusted:// and about:blank pages', async () => {
  for (const url of ['devtools://devtools/bundled/x.html', 'chrome-untrusted://print/', 'about:blank']) {
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
// granted activeTab it lets captureVisibleTab and tabCapture through. The popup
// refused every mode there, and then still refused Record, so captures Chrome
// allows never reached the worker.

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

test('records on chrome:// pages', async () => {
  for (const url of CHROME_URLS) {
    for (const format of ['webm', 'gif']) {
      const p = loadPopup(url);
      await p.ready();
      p.els.format.value = format; // turns Visible into Record
      await p.click('visible');
      assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], `recording ${url} as ${format} was blocked`);
    }
  }
});

test('the refusal messages no longer steer the user away from chrome:// pages or the Web Store', async () => {
  // Visible and Record work on both.
  const page = loadPopup('devtools://devtools/bundled/x.html');
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

// --- other extensions' pages and data: URLs ----------------------------------
// Chrome refuses executeScript on these too, and once the popup has granted
// activeTab it lets captureVisibleTab and tabCapture through, as on chrome://
// pages. The popup still refused every mode there.

const EXTENSION_AND_DATA_URLS = ['chrome-extension://abc/page.html', 'data:text/html,<p>x</p>'];

test('takes a Visible screenshot of other extensions\' pages and data: URLs', async () => {
  for (const url of EXTENSION_AND_DATA_URLS) {
    const p = loadPopup(url);
    await p.ready();
    await p.click('visible');
    assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], `Visible on ${url} was wrongly blocked`);
  }
});

test('refuses Full page and Region on other extensions\' pages and data: URLs with a message', async () => {
  for (const url of EXTENSION_AND_DATA_URLS) {
    for (const mode of ['fullpage', 'region']) {
      const p = loadPopup(url);
      await p.ready();
      await p.click(mode);
      assert.deepStrictEqual(p.sent, [], `${mode} on ${url} was sent to the worker`);
      assert.strictEqual(p.els.err.hidden, false);
      assert.match(p.els.err.textContent, /Full page or Region on other extensions’ pages or data: URLs\. Visible still works/);
    }
  }
});

test('records on other extensions\' pages and data: URLs', async () => {
  for (const url of EXTENSION_AND_DATA_URLS) {
    for (const format of ['webm', 'gif']) {
      const p = loadPopup(url);
      await p.ready();
      p.els.format.value = format; // turns Visible into Record
      await p.click('visible');
      assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], `recording ${url} as ${format} was blocked`);
    }
  }
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
    constructor(stream, { mimeType } = {}) { this.mimeType = mimeType; this.state = 'recording'; recorders.push(this); }
    start() {}
    // Mirrors the real ordering: a final dataavailable, then onstop, both async.
    stop() { this.state = 'inactive'; }
    flush(blob) { this.ondataavailable({ data: blob }); }
    finish() { this.onstop?.(); } // `stop` fires whether or not anyone listens
  }
  FakeRecorder.isTypeSupported = () => true;

  const sent = [];
  const timers = []; // download()'s URL revoke, a minute on
  let onMessage;
  const trackListeners = {};
  const track = { stop() {}, addEventListener: (type, fn) => { trackListeners[type] = fn; } };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const context = {
    console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
    chrome: {
      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, sendMessage: async (m) => { sent.push(m); }, getURL: (p) => p },
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    MediaRecorder: FakeRecorder,
    Blob: class { constructor(parts, { type } = {}) { this.parts = parts; this.size = parts.length; this.type = type; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: {
      createElement: () => ({ style: {}, click() {}, remove() {}, appendChild() {} }),
      body: { appendChild() {} },
    },
    setTimeout: (fn) => { timers.push(fn); return 0; }, clearInterval: () => {}, setInterval: () => 0,
    GIF: class {},
  };
  vm.createContext(context);
  vm.runInContext(read('offscreen.js'), context);
  // download() writes through an <a>, so keep each Blob on its way through.
  vm.runInContext('download = ((real) => (blob, name) => { __downloads.push([blob, name]); real(blob, name); })(download);', Object.assign(context, { __downloads: downloads }));
  return {
    ctx: context, recorders, downloads, sent, endTrack: () => trackListeners.ended(),
    message: (msg, respond = () => {}) => onMessage(msg, {}, respond),
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
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

// --- MP4 recordings ----------------------------------------------------------
// QuickTime Player can't open WebM, so MP4 is offered as a third recording
// format. It names H.264 for MediaRecorder, and the rest of the path - chunks,
// stop, save - is the one WebM already takes.

test('Record with MP4 selected starts an MP4 recording', async () => {
  const p = loadPopup('https://a.com/x');
  await p.ready();
  p.els.format.value = 'mp4'; // turns Visible into Record
  await p.click('visible');
  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], 'MP4 was taken for a screenshot format');
  assert.strictEqual(p.sent[0].opts.format, 'mp4');
});

test('an MP4 recording asks for H.264 and is saved as video/mp4', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'mp4', 100, 100);
  const r = o.recorders[0];
  assert.strictEqual(r.mimeType, 'video/mp4;codecs=avc1');
  r.flush({ size: 10 });
  o.ctx.stopRecording('out.mp4');
  r.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
  assert.strictEqual(o.downloads[0][0].type, 'video/mp4');
  assert.strictEqual(o.downloads[0][1], 'out.mp4');
});

test('an MP4 recording falls back to plain video/mp4 where H.264 isn\'t supported', async () => {
  const o = loadOffscreen();
  o.ctx.MediaRecorder.isTypeSupported = (t) => t !== 'video/mp4;codecs=avc1';
  await o.ctx.startRecording('sid', 'mp4', 100, 100);
  assert.strictEqual(o.recorders[0].mimeType, 'video/mp4');
});

test('a WebM recording still asks for VP9 and is saved as video/webm', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  assert.strictEqual(o.recorders[0].mimeType, 'video/webm;codecs=vp9');
  o.recorders[0].flush({ size: 10 });
  o.ctx.stopRecording('out.webm');
  o.recorders[0].finish();
  await settle();
  assert.strictEqual(o.downloads[0][0].type, 'video/webm');
});

// --- the worker's own active-tab lookup coming back empty ------------------
// The popup and the shortcuts knew which tab they meant but never said, so the
// worker asked Chrome for the active tab all over again. In headless Chrome
// that lookup came back empty while the first popup after a (re)load was open.
// A screenshot then did nothing at all, with no badge, and a recording started
// without its tab: no blip, not sized to the tab, and no {domain} or {title}
// for its name.

test('the popup says which tab a screenshot or recording is for', async () => {
  for (const [format, type] of [['png', 'capture'], ['webm', 'rec-start']]) {
    const p = loadPopup('https://a.com/x');
    await p.ready();
    p.els.format.value = format; // webm turns Visible into Record
    await p.click('visible');
    assert.deepStrictEqual(p.sent.map((m) => [m.type, m.tabId]), [[type, 1]], `${type} did not name the popup's tab`);
  }
});

test('a screenshot uses the tab it was sent for, even when the worker finds no active tab', async () => {
  const bg = loadBg({ noActiveTab: true });
  bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id });
  await settle();
  assert.strictEqual(bg.shots.length, 1, 'the screenshot was never taken');
  assert.deepStrictEqual(bg.badges, []);
});

test('a shortcut uses the tab Chrome hands it, even when the worker finds no active tab', async () => {
  const bg = loadBg({ noActiveTab: true });
  await bg.command('capture-visible', TAB);
  await settle();
  assert.strictEqual(bg.shots.length, 1, 'the shortcut did nothing');
  assert.deepStrictEqual(bg.badges, []);
});

test('a screenshot with no tab to take flashes the badge instead of doing nothing', async () => {
  const bg = loadBg({ noActiveTab: true });
  bg.message({ type: 'capture', mode: 'visible', opts: OPTS }); // sent before the popup had found its tab
  await settle();
  assert.strictEqual(bg.shots.length, 0);
  assert.deepStrictEqual(bg.badges, ['!'], 'nothing was saved, and nothing said so');
});

test('a recording uses the tab it was sent for, even when the worker finds no active tab', async () => {
  const bg = loadBg({ noActiveTab: true });
  const { chrome } = bg.ctx;
  const targets = [];
  const stored = [];
  const sent = [];
  chrome.offscreen = { hasDocument: async () => true }; // already open
  const run = chrome.scripting.executeScript;
  chrome.scripting.executeScript = (o) => { targets.push(o.target.tabId); return run(o); };
  keepStore(chrome); // the start reads `rec` back before it starts the recorder
  const set = chrome.storage.local.set;
  chrome.storage.local.set = async (o) => { stored.push({ ...o.rec }); return set(o); };
  chrome.runtime.sendMessage = async (m) => { sent.push({ ...m }); };
  Object.assign(bg.ctx.window, { innerWidth: 1280, innerHeight: 713, devicePixelRatio: 1 });
  bg.message({ type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: TAB.id });
  await settle();
  assert.deepStrictEqual(targets, [TAB.id, TAB.id], 'the blip and the viewport read were skipped');
  assert.deepStrictEqual(stored, [{ url: TAB.url, title: TAB.title, format: 'webm', filename: 'x' }], 'no {domain} or {title} to name the file with');
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.deepStrictEqual([start.width, start.height], [1280, 713], 'the recording was not sized to the tab');
});

// A named tab can close before the worker looks it up. Falling back to the
// active tab then would shoot or record a different page under its name.

test('a screenshot of a tab that has since closed flashes the badge', async () => {
  const bg = loadBg();
  bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: 99 }); // no tab with that id any more
  await settle();
  assert.strictEqual(bg.shots.length, 0, 'shot whatever tab was showing instead');
  assert.deepStrictEqual(bg.badges, ['!']);
});

test('a recording whose tab has since closed sets nothing up', async () => {
  const bg = loadBg();
  const stored = [];
  bg.ctx.chrome.offscreen = { hasDocument: async () => true }; // already open
  bg.ctx.chrome.storage.local.set = async (o) => { stored.push(o); };
  bg.message({ type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: 99 });
  await settle();
  assert.strictEqual(stored.length, 0, 'marked as recording with nothing recording');
  assert.deepStrictEqual(bg.badges, ['!'], 'REC went up, or the failed start went unnoticed');
});

// --- a second recording started over the first ------------------------------
// Record stayed enabled while a recording ran, and nothing further along
// checked either: the worker overwrote `rec`, and the offscreen document
// replaced its own `rec`, leaving the recording already running with nothing
// that could stop or save it. Stop then saved only the second recording.

const RUNNING = { url: 'https://b.com', title: 'B', format: 'webm', filename: 'y' };

test('Record is greyed out while a recording is running', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
  await p.ready();
  assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over a running recording');
  await p.click('visible');
  assert.deepStrictEqual(p.sent, [], 'a second recording was started');
});

test('Visible still takes a screenshot while a recording is running', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'png' }, rec: RUNNING } });
  await p.ready();
  await p.click('visible');
  assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture']);
});

test('Record stays greyed out once it has started a recording, until Stop', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
  await p.ready();
  await p.click('visible');
  p.stored({ rec: { newValue: RUNNING } }); // the worker marks it as running
  assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over the recording it started');
  await p.click('visible');
  p.stop();
  assert.strictEqual(p.btn('visible').disabled, false, 'Stop left Record greyed out');
  await p.click('visible');
  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start', 'rec-stop', 'rec-start']);
});

test('pressing Record twice in quick succession starts one recording', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
  await p.ready();
  await Promise.all([p.click('visible'), p.click('visible')]);
  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], 'the second press started another recording');
});

test('Record comes back when the tab can\'t be recorded', async () => {
  const p = loadPopup('https://a.com/x', { streamIdFails: true, store: { opts: { format: 'webm' } } });
  await p.ready();
  await p.click('visible');
  assert.strictEqual(p.els.err.hidden, false);
  assert.strictEqual(p.btn('visible').disabled, false, 'a start that failed left Record greyed out');
});

test('the worker won\'t start a recording over one that is running', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const stored = [];
  const sent = [];
  chrome.offscreen = { hasDocument: async () => true }; // open, and recording
  chrome.storage.local.get = async () => ({ rec: RUNNING });
  chrome.storage.local.set = async (o) => { stored.push(o); };
  chrome.runtime.sendMessage = async (m) => { sent.push(m); };
  bg.message({ type: 'rec-start', streamId: 'sid2', opts: { ...OPTS, format: 'gif' }, tabId: TAB.id });
  await settle();
  assert.deepStrictEqual(stored, [], 'the running recording\'s `rec` was overwritten');
  assert.deepStrictEqual(sent, [], 'the offscreen document was told to start another recording');
});

test('a second start leaves a running WebM recording to be saved', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const first = o.recorders[0];
  first.flush({ size: 10 });
  await o.ctx.startRecording('sid2', 'webm', 100, 100);
  assert.strictEqual(o.recorders.length, 1, 'a second recorder was started over the first');
  o.ctx.stopRecording('out.webm');
  first.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the first recording was never saved');
  assert.strictEqual(o.downloads[0][0].parts.length, 1);
});

test('a second start leaves a running GIF recording in place', async () => {
  const o = loadOffscreen();
  vm.runInContext("rec = { format: 'gif', gif: {}, frames: 5 }", o.ctx); // what its frame timer reads
  const running = vm.runInContext('rec', o.ctx);
  await o.ctx.startRecording('sid2', 'webm', 100, 100);
  assert.strictEqual(vm.runInContext('rec', o.ctx), running, 'the GIF\'s frame timer now reads the new recording');
  assert.strictEqual(o.recorders.length, 0, 'a second recording was started');
});

// --- a recording that ends while the popup is open --------------------------
// The popup read `rec` once, when it opened. A recording can end without its
// Stop - the recorded tab closes, a GIF reaches its frame cap, a start fails in
// the offscreen document - and the worker removes `rec` then, but an open
// popup kept Stop enabled and Record greyed out until it was opened again.

test('an open popup gives Record back when the recording ends on its own', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
  await p.ready();
  p.stored({ rec: { oldValue: RUNNING } }); // stopRecording removed it
  assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop stayed enabled with nothing recording');
  assert.strictEqual(p.btn('visible').disabled, false, 'Record stayed greyed out with nothing recording');
  await p.click('visible');
  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start']);
});

test('an open popup gives Record back when its start fails in the offscreen document', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
  await p.ready();
  await p.click('visible');
  p.stored({ rec: { newValue: RUNNING } }); // the worker marks it as running
  assert.strictEqual(p.els.stopBtn.disabled, false);
  assert.strictEqual(p.btn('visible').disabled, true);
  p.stored({ rec: { oldValue: RUNNING } }); // then rec-failed removes it
  assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop stayed enabled after the start failed');
  assert.strictEqual(p.btn('visible').disabled, false, 'Record stayed greyed out after the start failed');
});

test('a settings change leaves an open popup\'s Stop and Record alone', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
  await p.ready();
  p.stored({ opts: { newValue: { format: 'webm' } } }); // save() after a control changes
  assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
  assert.strictEqual(p.btn('visible').disabled, true, 'Record came back mid-recording');
});

// --- a recording change that lands while the popup is opening ---------------
// load() waits on a storage read and a tab query. When `rec` changed after the
// read, the storage listener applied the change, and then load() set Stop from
// the older value it had read. The popup kept that state until `rec` changed
// again or the popup was reopened.

test('an opening popup keeps a recording end that lands before load() finishes', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
  p.stored({ rec: { oldValue: RUNNING } }); // removed after load() read it, before load() went on
  await p.ready();
  assert.strictEqual(p.els.stopBtn.disabled, true, 'load() enabled Stop for a recording that had ended');
  assert.strictEqual(p.btn('visible').disabled, false, 'load() greyed Record out for a recording that had ended');
});

test('an opening popup keeps a recording start that lands before load() finishes', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
  p.stored({ rec: { newValue: RUNNING } }); // written after load() read it, before load() went on
  await p.ready();
  assert.strictEqual(p.els.stopBtn.disabled, false, 'load() greyed Stop out while a recording was running');
  assert.strictEqual(p.btn('visible').disabled, true, 'load() left Record enabled over a running recording');
});

test('a settings change while the popup is opening leaves load() to set Stop and Record', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
  p.stored({ opts: { newValue: { format: 'webm' } } }); // save() before load() went on
  await p.ready();
  assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
  assert.strictEqual(p.btn('visible').disabled, true, 'Record came back mid-recording');
});

// --- a setting saved while the popup is opening -----------------------------
// load() leaves the form alone once save() has run, because storage then holds
// what the form shows. It still sets Stop, and Record has to follow it.

test('Record follows a running recording when a setting is saved while the popup is opening', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
  p.els.format.value = 'webm'; // picked after load() read storage, before it went on
  p.els.format.listeners.change[0]();
  await p.ready();
  assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
  assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over a running recording');
});

for (const format of ['webp', 'webm']) {
  test(`capture waits for reconciled settings: ${format}`, async () => {
    let release;
    const startupGate = new Promise(r => { release = r; });
    const opts = { format: 'png', quality: 0.5, filename: 'custom', toClipboard: false, hideScrollbar: false };
    const p = loadPopup('https://a.com', { store: { opts }, startupGate });
    p.els.format.value = format;
    const saving = p.els.format.listeners.change[0]();
    for (const mode of ['visible', 'fullpage', 'region']) {
      assert.strictEqual(p.btn(mode).disabled, true);
      await p.click(mode);
    }
    assert.strictEqual(p.sent.length, 0);
    assert.strictEqual(p.writes.length, 0);
    assert.strictEqual(p.streams.length, 0);
    release();
    await saving;
    await p.ready();
    assert.strictEqual(p.btn('visible').disabled, false);
    assert.strictEqual(p.btn('fullpage').disabled, format === 'webm');
    assert.strictEqual(p.btn('region').disabled, format === 'webm');
    const capture = p.click('visible');
    if (format === 'webm') assert.strictEqual(p.streams.length, 1, 'stream request must precede any await');
    await capture;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.sent[0].opts)), { ...opts, format });
  });
}

test('failed initialization reports an error and cannot save fallback options', async () => {
  const p = loadPopup('https://a.com', { startupFails: true });
  p.els.format.value = 'webm';
  await p.els.format.listeners.change[0]();
  await p.ready();
  assert.strictEqual(p.els.err.hidden, false);
  assert.match(p.els.err.textContent, /load settings/);
  await p.els.format.listeners.change[0]();
  for (const mode of ['visible', 'fullpage', 'region']) {
    assert.strictEqual(p.btn(mode).disabled, true);
    await p.click(mode);
  }
  assert.strictEqual(p.writes.length, 0);
  assert.strictEqual(p.sent.length, 0);
  assert.strictEqual(p.streams.length, 0);
});

// --- REC stuck on, or wiped during a recording ------------------------------
// startRecording marks the recording as running and puts REC up before it
// tells the offscreen document to start. When that document never answered its
// ping, or never got the message, nothing undid either: REC stayed on, an open
// popup kept Stop enabled, and closeOffscreen() wouldn't close the document.
// The popup enabled Stop without hearing whether the start worked. And the !
// of a screenshot that failed mid-recording blanked the badge 3 s later,
// wiping REC while the recording ran on.

const WEBM_START = { type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: TAB.id };
const UNREACHABLE = 'Could not establish connection. Receiving end does not exist.';

test('a start whose new offscreen document never answers sets nothing up, and says so', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const stored = [];
  const sent = [];
  let reply;
  chrome.offscreen = { hasDocument: async () => false, createDocument: async () => {} };
  chrome.storage.local.set = async (o) => { stored.push(o); };
  chrome.runtime.sendMessage = async (m) => { sent.push(m.type); throw new Error(UNREACHABLE); };
  bg.message(WEBM_START, (r) => { reply = r; });
  await settle();
  assert.deepStrictEqual(stored, [], 'marked as recording with nothing recording');
  assert.ok(!sent.includes('rec-start-offscreen'), 'started a recording in a document that never answered');
  assert.deepStrictEqual(bg.badges, ['!'], 'REC went up, or the failed start went unnoticed');
  assert.strictEqual(reply, false, 'the popup was told the recording started');
});

test('a start the offscreen document never gets is undone', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const storage = [];
  let reply;
  chrome.offscreen = { hasDocument: async () => true }; // open, but not listening
  keepStore(chrome); // the start reads `rec` back before it starts the recorder
  const { set, remove } = chrome.storage.local;
  chrome.storage.local.set = async (o) => { storage.push(['set', ...Object.keys(o)]); return set(o); };
  chrome.storage.local.remove = async (k) => { storage.push(['remove', k]); return remove(k); };
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') throw new Error(UNREACHABLE); };
  bg.message(WEBM_START, (r) => { reply = r; });
  await settle();
  assert.deepStrictEqual(storage, [['set', 'rec'], ['remove', 'rec']], 'still marked as recording with nothing recording');
  assert.deepStrictEqual(bg.badges, ['REC', '!'], 'REC stayed up, or the failed start went unnoticed');
  assert.strictEqual(reply, false, 'the popup was told the recording started');
});

test('a start that fails in the offscreen document is still undone', async () => {
  const bg = loadBg();
  const removed = [];
  bg.ctx.chrome.storage.local.remove = async (k) => { removed.push(k); };
  bg.message({ type: 'rec-failed' });
  await settle();
  assert.deepStrictEqual(removed, ['rec'], 'still marked as recording with nothing recording');
  assert.deepStrictEqual(bg.badges, ['!'], 'the failed start went unnoticed');
});

test('a start that works tells the popup so', async () => {
  const bg = loadBg();
  let reply;
  bg.ctx.chrome.offscreen = { hasDocument: async () => true };
  keepStore(bg.ctx.chrome); // the start reads `rec` back before it starts the recorder
  // Chrome drops an answer sent after the listener returns, unless it returned true.
  assert.strictEqual(bg.message(WEBM_START, (r) => { reply = r; }), true, 'the popup would never hear back');
  await settle();
  assert.strictEqual(reply, true);
  assert.deepStrictEqual(bg.badges, ['REC']);
});

for (const [rec, after] of [[RUNNING, 'REC'], [undefined, '']]) {
  test(`a failed screenshot's ! gives way to ${rec ? 'REC while a recording runs' : 'a blank badge with nothing recording'}`, async () => {
    const bg = loadBg({ captureFails: () => 'Cannot access contents of the page' });
    const { chrome } = bg.ctx;
    const texts = [];
    chrome.storage.local.get = async () => ({ rec });
    chrome.action.setBadgeText = async ({ text }) => { texts.push(text); };
    await bg.ctx.runCapture('visible', OPTS).catch(bg.ctx.captureFailed);
    await settle();
    assert.deepStrictEqual(texts, ['!', after]);
  });
}

test('Record leaves Stop to the worker marking the recording as running', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
  await p.ready();
  await p.click('visible');
  assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop was enabled before the recording was marked as running');
  assert.strictEqual(p.btn('visible').disabled, true, 'Record came back while the start was under way');
  p.stored({ rec: { newValue: RUNNING } });
  assert.strictEqual(p.els.stopBtn.disabled, false);
});

for (const [what, reply] of [['says the start failed', false], ['can\'t be reached', new Error(UNREACHABLE)]]) {
  test(`Record comes back when the worker ${what}`, async () => {
    const p = loadPopup('https://a.com/x', { reply, store: { opts: { format: 'webm' } } });
    await p.ready();
    await p.click('visible');
    assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop was enabled for a recording that never started');
    assert.strictEqual(p.btn('visible').disabled, false, 'a start that failed left Record greyed out');
    assert.strictEqual(p.els.err.hidden, false, 'the failed start went unnoticed');
    await p.click('visible');
    assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start', 'rec-start']);
  });
}

// --- two recordings started at once -----------------------------------------
// startRecording checks `rec` and writes it only after several awaits. Two
// starts inside that gap both got past the check, and when the second then
// failed, its cleanup removed the `rec` the first had written: Stop could no
// longer end the first recording.

// chrome.storage.local that keeps what is written to it.
function keepStore(chrome) {
  const store = {};
  Object.assign(chrome.storage.local, {
    get: async (k) => (k in store ? { [k]: store[k] } : {}),
    set: async (o) => { Object.assign(store, o); },
    remove: async (k) => { delete store[k]; },
  });
  return store;
}

test('a second start that fails leaves the first recording its rec', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const store = keepStore(chrome);
  const sent = [];
  const replies = [];
  let closeSecondTab;
  chrome.offscreen = { hasDocument: async () => true };
  chrome.runtime.sendMessage = async (m) => { sent.push(m.type); };
  const get = chrome.tabs.get;
  // The second start's tab closes, but only once the first start has written rec.
  chrome.tabs.get = (id) => (id === 99 ? new Promise((_, no) => { closeSecondTab = () => no(new Error('No tab with id: 99.')); }) : get(id));
  bg.message(WEBM_START, (r) => replies.push(r));
  bg.message({ ...WEBM_START, streamId: 'sid2', tabId: 99 }, (r) => replies.push(r));
  await settle();
  closeSecondTab?.();
  await settle();
  assert.strictEqual(store.rec?.url, TAB.url, 'the second start removed the first recording\'s rec');
  assert.deepStrictEqual(sent, ['rec-start-offscreen'], 'the offscreen document was told to start twice');
  assert.deepStrictEqual(bg.badges, ['REC'], 'REC was flashed away over a running recording');
  assert.deepStrictEqual(replies, [true, true]);
});

test('a start that fails, cleanup and all, does not hold up the next one', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const store = keepStore(chrome);
  const replies = [];
  chrome.offscreen = { hasDocument: async () => true };
  const remove = chrome.storage.local.remove;
  chrome.storage.local.remove = async () => { chrome.storage.local.remove = remove; throw new Error('storage failed'); };
  bg.message({ ...WEBM_START, tabId: 99 }, (r) => replies.push(r)); // its tab has closed
  bg.message(WEBM_START, (r) => replies.push(r));
  await settle();
  assert.deepStrictEqual(replies, [false, true], 'the next start was never run');
  assert.strictEqual(store.rec?.url, TAB.url, 'the next start was never run');
});

test('a start queued behind one that fails waits for its cleanup', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const store = keepStore(chrome);
  const replies = [];
  const started = [];
  chrome.offscreen = { hasDocument: async () => true };
  const remove = chrome.storage.local.remove;
  chrome.storage.local.remove = (k) => Promise.resolve().then(() => remove(k)); // lands a moment later, as Chrome's does
  let unreachable = true; // the first start's rec-start-offscreen never arrives
  chrome.runtime.sendMessage = async (m) => {
    if (m.type !== 'rec-start-offscreen') return;
    if (unreachable) { unreachable = false; throw new Error(UNREACHABLE); }
    started.push(m.streamId);
  };
  bg.message(WEBM_START, (r) => replies.push(r));
  bg.message({ ...WEBM_START, streamId: 'sid2' }, (r) => replies.push(r));
  await settle();
  assert.deepStrictEqual(replies, [false, true]);
  assert.deepStrictEqual(started, ['sid2'], 'the second start took the failed start\'s rec for a running recording');
  assert.strictEqual(store.rec?.url, TAB.url, 'the second recording was left without its rec');
});

// --- a recording start the page never answers -------------------------------
// startRecording waits on two scripts in the page, the edge-glow blip and the
// viewport read, and neither had a deadline. A page that never ran them held
// its start for good, and every start queued behind it (recStartGate): a later
// Record press got no answer and stayed greyed out. Stop, pressed meanwhile,
// only removed `rec`.

test('a start gives up on a page that never answers, and still records', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  keepStore(chrome);
  const sent = [];
  let reply;
  chrome.offscreen = { hasDocument: async () => true };
  chrome.scripting.executeScript = () => new Promise(() => {}); // the page never runs either script
  chrome.runtime.sendMessage = async (m) => { sent.push(m); };
  bg.message(WEBM_START, (r) => { reply = r; });
  await settle();
  assert.strictEqual(reply, undefined, 'gave up before the deadline');
  bg.expire(); // the blip's deadline
  await settle();
  bg.expire(); // the viewport read's
  await settle();
  assert.strictEqual(reply, true, 'still waiting on a page that will never answer');
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.ok(start, 'the recording was never started');
  assert.deepStrictEqual([start.width, start.height], [undefined, undefined], 'sized to a viewport that was never read');
});

test('a start stopped while it waits on the page records nothing, and the next start goes ahead', async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const store = keepStore(chrome);
  const started = [];
  const replies = [];
  chrome.offscreen = { hasDocument: async () => true };
  const run = chrome.scripting.executeScript;
  let calls = 0;
  chrome.scripting.executeScript = (o) => (++calls <= 2 ? new Promise(() => {}) : run(o)); // only the first start's two never answer
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') started.push(m.streamId); };
  bg.message(WEBM_START, (r) => replies.push(r));
  await settle();
  bg.message({ type: 'rec-stop' });
  await settle();
  assert.strictEqual(store.rec, undefined, 'Stop left the recording marked as running');
  bg.message({ ...WEBM_START, streamId: 'sid2' }, (r) => replies.push(r));
  await settle();
  bg.expire(); // the first start's blip
  await settle();
  bg.expire(); // its viewport read
  await settle();
  assert.deepStrictEqual(replies, [true, true], 'the next start was never run');
  assert.deepStrictEqual(started, ['sid2'], 'the stopped start went on to record');
  assert.strictEqual(store.rec?.url, TAB.url, 'the next recording was left without its rec');
});

// --- a capture while a stopped recording is still being saved ---------------
// The worker removes `rec` before the offscreen document hears about the Stop,
// and the recording is saved in the document after that: a GIF is encoded
// first, and the file then downloads from a URL the document owns. A clipboard
// copy in that window closed the document, and the recording was never saved.
// The worker now asks the document before it closes it.

const busy = (o) => { let answer; o.message({ type: 'offscreen-busy' }, (a) => { answer = a; }); return answer; };

test('a GIF keeps its document busy from its stop until the download is done with the file', async () => {
  const o = loadOffscreen();
  const gif = { on: (event, fn) => { gif[event] = fn; }, render() {} };
  vm.runInContext("rec = { format: 'gif', gif: __gif, stream: { getTracks: () => [] } }", Object.assign(o.ctx, { __gif: gif }));
  assert.strictEqual(busy(o), true, 'the worker could close the document before the stop arrived');
  o.ctx.stopRecording('out.gif');
  assert.strictEqual(busy(o), true, 'the worker could close the document mid-encode');
  gif.finished({ size: 10 }); // gif.js has finished encoding
  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out.gif']);
  assert.strictEqual(busy(o), true, 'the worker could close the document while the download still needs the file');
  o.runTimers();
  assert.strictEqual(busy(o), false, 'the document stayed busy after its file was saved');
});

test('a WebM keeps its document busy from its stop until the download is done with the file', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  r.flush({ size: 10 });
  assert.strictEqual(busy(o), true, 'the worker could close the document before the stop arrived');
  o.ctx.stopRecording('out.webm');
  assert.strictEqual(busy(o), true, 'the worker could close the document before the final flush');
  r.finish();
  await settle();
  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out.webm']);
  assert.strictEqual(busy(o), true, 'the worker could close the document while the download still needs the file');
  o.runTimers();
  assert.strictEqual(busy(o), false, 'the document stayed busy after its file was saved');
});

// --- a Stop while getUserMedia is still answering ---------------------------
// The worker reads `rec` for the last time before it sends rec-start-offscreen,
// so a Stop pressed after that could reach the offscreen document before its
// start had a `rec`. The document ignored that Stop, and the recorder then
// started with nothing that could stop it.

test('a start stopped while it waits on getUserMedia records nothing, and the next start goes ahead', async () => {
  const o = loadOffscreen();
  const { mediaDevices } = o.ctx.navigator;
  const getUserMedia = mediaDevices.getUserMedia; // answers at once
  let answer;
  let stoppedTracks = 0;
  const track = { stop() { stoppedTracks++; }, addEventListener() {} };
  mediaDevices.getUserMedia = () => new Promise((res) => { answer = () => res({ getVideoTracks: () => [track], getTracks: () => [track] }); });
  const start = o.ctx.startRecording('sid', 'webm', 100, 100);
  o.ctx.stopRecording('out.webm'); // the worker's rec-stop-offscreen
  answer();
  await start;
  assert.strictEqual(o.recorders.length, 0, 'the stopped start went on to record');
  assert.strictEqual(stoppedTracks, 1, 'the stopped start left the tab being captured');
  mediaDevices.getUserMedia = getUserMedia;
  await o.ctx.startRecording('sid2', 'webm', 100, 100);
  assert.strictEqual(o.recorders.length, 1, 'the next start was refused');
  o.recorders[0].flush({ size: 10 });
  o.ctx.stopRecording('out2.webm');
  o.recorders[0].finish();
  await settle();
  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out2.webm'], 'the next recording was never saved');
});

// A document that never started a recording can still get a Stop: after the
// extension is disabled and enabled again mid-recording, `rec` is left set
// (KAN-297), and a clipboard copy leaves a new document open for it.
test('a Stop that reaches a document that never started a recording does nothing', () => {
  const o = loadOffscreen();
  assert.doesNotThrow(() => o.ctx.stopRecording('out.webm'), 'a Stop with no start to mark threw'); // the worker's rec-stop-offscreen
  assert.strictEqual(busy(o), false, 'the document was left busy with nothing to save');
});

// --- a stopped start whose getUserMedia fails -------------------------------
// A start stopped while getUserMedia was answering only checked for that Stop
// once getUserMedia answered. When getUserMedia failed instead, the start
// reported rec-failed, and the worker flashed ! right after the user's Stop.

test('a start stopped while it waits on getUserMedia reports nothing when getUserMedia then fails', async () => {
  const o = loadOffscreen();
  const refused = new Error('Error starting tab capture');
  const warnings = [];
  o.ctx.console.warn = (...args) => warnings.push(args);
  let refuse;
  o.ctx.navigator.mediaDevices.getUserMedia = () => new Promise((res, rej) => { refuse = () => rej(refused); });
  o.message({ type: 'rec-start-offscreen', streamId: 'sid', format: 'webm', width: 100, height: 100 });
  o.message({ type: 'rec-stop-offscreen', filename: 'out.webm' });
  refuse();
  await settle();
  assert.deepStrictEqual(o.sent, [], 'the stopped start reported its failure');
  assert.ok(warnings.some((w) => w.includes(refused)), 'the failure left no trace in the console');
});

test('a start whose getUserMedia fails, with no Stop, still reports it', async () => {
  const o = loadOffscreen();
  const refused = new Error('Error starting tab capture');
  const errors = [];
  o.ctx.console.error = (...args) => errors.push(args);
  o.ctx.navigator.mediaDevices.getUserMedia = async () => { throw refused; };
  o.message({ type: 'rec-start-offscreen', streamId: 'sid', format: 'webm', width: 100, height: 100 });
  await settle();
  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed'], 'the failed start was never reported');
  assert.strictEqual(errors[0]?.[1], refused, 'the error logged is not the one getUserMedia failed with');
});

// --- a blip the page runs after its deadline --------------------------------
// A start stops waiting for the edge-glow blip at its deadline and goes on to
// the recorder. A page that only ran the blip script after that still showed
// the glow, and it could end up in the recording.

test('a blip the page runs after its deadline shows no glow', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  const glows = [];
  document.createElement = () => ({ style: {}, animate: () => ({}) });
  document.documentElement.appendChild = (el) => glows.push(el);
  const run = chrome.scripting.executeScript;
  let runScript;
  chrome.scripting.executeScript = (o) => new Promise((res) => { runScript = () => res(run(o)); }); // the page is busy until runScript()
  const blip = bg.ctx.blipRecordingIndicator(TAB.id);
  bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) + 1000);
  bg.expire(); // the deadline passed a second ago
  await blip; // the start has gone on without the glow
  runScript(); // only now does the page get to the script
  assert.deepStrictEqual(glows, [], 'the glow showed after the start had gone on without it');
});

test('a blip the page runs before its deadline still shows its glow', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  const glows = [];
  document.createElement = () => ({ style: {}, animate: () => ({}) });
  document.documentElement.appendChild = (el) => glows.push(el);
  const run = chrome.scripting.executeScript;
  let runScript;
  chrome.scripting.executeScript = (o) => new Promise((res) => { runScript = () => res(run(o)); }); // the page is busy until runScript()
  const blip = bg.ctx.blipRecordingIndicator(TAB.id);
  bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) - 1000);
  runScript(); // the page gets to the script a second before its deadline
  await blip;
  assert.strictEqual(glows.length, 1, 'the glow was skipped although the page ran the script in time');
});

// --- a start that doesn't wait for the blip's glow --------------------------
// A start waits for the edge-glow blip's glow to fade before it starts the
// recorder, or the glow ends up in the recording. loadBg's elements can't
// animate, so every start these tests ran had a blip that threw and skipped
// that wait: deleting it failed no test.

test('a start waits for the blip\'s glow to finish before it starts the recorder', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  keepStore(chrome); // the start reads `rec` back before it starts the recorder
  chrome.offscreen = { hasDocument: async () => true };
  const glows = [];
  let startedAt;
  document.createElement = () => ({ style: {}, animate: () => ({}) });
  document.documentElement.appendChild = () => glows.push(bg.ctx.Date.now());
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); };
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  assert.strictEqual(glows.length, 1, 'the blip showed no glow');
  assert.ok(startedAt !== undefined, 'the recording was never started');
  assert.ok(startedAt - glows[0] >= vm.runInContext('BLIP_ANIM_MS', bg.ctx), 'the recorder started while the glow was still showing');
});
