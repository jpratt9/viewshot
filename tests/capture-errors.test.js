const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PNG = 'data:image/png;base64,AAAA';
const TAB = { id: 7, windowId: 1, url: 'https://a.com', title: 'T', width: 1280, height: 713 };
const settle = () => new Promise((r) => setImmediate(r));

// Three unrelated errors showed up in chrome://extensions at once, and each one
// had the same shape: a real failure that reached the console and nothing else.
//   - MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, from two shots inside one second
//   - "Cannot access a chrome:// URL", from a capture on a chrome:// page
//   - "Cannot read properties of null (reading 'chunks')", from the recorder's
//     final flush landing after stop() had already nulled `rec`

// background.js against a fake browser. `clock` stands in for Date.now so the
// rate-limit gate can be driven without real waiting; sleeps advance it.
function loadBg({ captureFails = null, captureHangs = null, scriptFails = false, scriptHangs = false, noActiveTab = false } = {}) {
  const shots = [];
  const badges = [];
  const sleeps = [];
  const deadlines = [];
  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  let scriptTimeout; // SCRIPT_TIMEOUT_MS, likewise
  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
  let blipCeiling; // SCRIPT_TIMEOUT_MS + BLIP_HOLD_MS, likewise
  let now = 100000;
  let onMessage, onCommand;
  const listeners = []; // every onMessage listener: a blip's hold adds its own

  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    async convertToBlob() { return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }

  const chrome = {
    // The first message listener is background.js's own; Region adds more later.
    runtime: {
      onMessage: {
        addListener: (fn) => { onMessage = onMessage || fn; listeners.push(fn); },
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
      },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      // The page's blip reports through here, and Chrome hands a page's message
      // to every listener the worker has.
      sendMessage: async (m) => { if (m?.type === 'blip-done') listeners.slice().forEach((fn) => fn(m, {}, () => {})); },
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
        if (scriptHangs) return new Promise(() => {}); // main thread blocked: the page never runs it
        return [{ result: o.func ? o.func.apply(null, o.args || []) : undefined }];
      },
    },
    downloads: { download: async () => {} },
    storage: { session: (() => { let s = {}; return { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o), remove: async (k) => delete s[k] }; })(), local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    action: {
      setBadgeText: async ({ text }) => { if (text) badges.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
  };

  const context = {
    chrome, console: { ...console, error: () => {}, warn: () => {}, log: () => {} },
    URL, btoa, clearTimeout,
    crypto: { randomUUID: () => 'blip-1' }, // the id a blip's report has to carry
    // Sleeps are the thing under test here, so record them and move the clock
    // rather than actually waiting. The capture and page-script deadlines, and
    // the blip's ceiling, aren't sleeps: they are held until the test calls expire().
    setTimeout: (fn, ms) => {
      if (ms === captureTimeout || ms === scriptTimeout || ms === pageScriptTimeout || ms === blipCeiling) { deadlines.push(fn); return; }
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
  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
  blipCeiling = vm.runInContext('SCRIPT_TIMEOUT_MS + BLIP_HOLD_MS', context);
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

// A full page is scaled to fit what it will be saved as (KAN-210): WebP's limit
// is the tightest, and the clipboard always takes a PNG.
test('a full page is sized for the format it will be saved in', async () => {
  const bg = loadBg();
  const formats = [];
  bg.ctx.captureFullPage = async (_tab, format) => { formats.push(format); throw new Error('stop'); };
  await bg.ctx.runCapture('fullpage', { ...OPTS, format: 'webp' }).catch(() => {});
  await bg.ctx.runCapture('fullpage', { ...OPTS, format: 'jpg', toClipboard: true }).catch(() => {});
  assert.deepStrictEqual(formats, ['webp', 'png']);
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

function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {}, startupGate, startupFails = false, reply = true, scriptError } = {}) {
  const els = {};
  const sent = [];
  const writes = [];
  const streams = [];
  const scripts = []; // the tab each script the popup tried was for
  let onStored; // popup.js's chrome.storage.local.onChanged listener
  let onMessage; // popup.js's chrome.runtime.onMessage listener: the worker's clipboard write
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
      // the worker's answer. The popup's startup rec-check is the worker's
      // business, not this file's, so it is left out of `sent`.
      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, sendMessage: async (m) => { if (m.type !== 'rec-check') sent.push(m); if (reply instanceof Error) throw reply; return reply; } },
      tabCapture: { getMediaStreamId: async () => { streams.push('requested'); if (streamIdFails) throw new Error('stream id refused'); return 'sid'; } },
      extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
      // A script on the page: Chrome refuses one with `scriptError`, as its
      // error page does (KAN-546).
      scripting: { executeScript: async (o) => { scripts.push(o.target.tabId); if (scriptError) throw new Error(scriptError); return [{}]; } },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    crypto: { randomUUID: () => 'popup-1' }, // the id this popup's captures carry (KAN-552)
  };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);
  const btn = (mode) => modes.find((b) => b.dataset.mode === mode);
  return {
    ctx: context, els, sent, btn, writes, streams, scripts,
    ready: settle, // let load() resolve so activeTab is populated
    click: (mode) => btn(mode).listeners.click[0](),
    stop: () => els.stopBtn.listeners.click[0](),
    stored: (changes) => onStored?.(changes), // storage changing while the popup is open
    message: (msg, respond = () => {}) => onMessage(msg, {}, respond), // a worker's message reaching the popup
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
  const videos = []; // the <video> a GIF start waits on
  let now = 0; // Date.now() in the document: a recording's length is read off it
  class FakeRecorder {
    constructor(stream, { mimeType } = {}) { this.mimeType = mimeType; this.state = 'recording'; recorders.push(this); }
    start() {}
    // Mirrors the real ordering: a final dataavailable, then onstop, both async.
    stop() { this.state = 'inactive'; }
    flush(blob) { this.ondataavailable({ data: blob }); }
    finish() { this.onstop?.(); } // `stop` fires whether or not anyone listens
    fail(error) { this.state = 'inactive'; this.onerror?.({ error }); }
  }
  FakeRecorder.isTypeSupported = () => true;
  const players = []; // what a start with audio plays the tab's sound back out through
  class FakeAudioContext {
    constructor() { this.destination = {}; this.closed = false; players.push(this); }
    createMediaStreamSource(from) { return { connect: (to) => { this.source = { from, to }; } }; }
    close() { this.closed = true; return Promise.resolve(); }
  }

  const sent = [];
  const asked = []; // what each getUserMedia was asked for: the pinned dims live here
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
    navigator: { mediaDevices: { getUserMedia: async (c) => { asked.push(c); return stream; } } },
    devicePixelRatio: 2, // a HiDPI display: the fallback's CSS-pixel dims are scaled by it
    crypto: { randomUUID: () => 'doc-1' }, // the id this document answers with
    MediaRecorder: FakeRecorder,
    AudioContext: FakeAudioContext,
    Blob: class { constructor(parts, { type } = {}) { this.parts = parts; this.size = parts.length; this.type = type; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: {
      createElement: (tag) => {
        const el = { style: {}, click() {}, remove() {}, appendChild() {} };
        // A GIF start waits for this video's metadata and play() before it
        // has an encoder; the test releases both.
        if (tag === 'video') { Object.assign(el, { play: async () => {}, videoWidth: 100, videoHeight: 100 }); videos.push(el); }
        if (tag === 'canvas') el.getContext = () => ({ drawImage() {} }); // gif.js draws each frame through it
        return el;
      },
      body: { appendChild() {} },
    },
    setTimeout: (fn) => { timers.push(fn); return 0; }, clearInterval: () => {}, setInterval: () => 0, clearTimeout: () => {},
    GIF: class {},
    Date: class extends Date { static now() { return now; } },
  };
  vm.createContext(context);
  vm.runInContext(read('offscreen.js'), context);
  // download() writes through an <a>, so keep each Blob on its way through.
  vm.runInContext('download = ((real) => (blob, name) => { __downloads.push([blob, name]); real(blob, name); })(download);', Object.assign(context, { __downloads: downloads }));
  return {
    ctx: context, recorders, downloads, videos, sent, asked, players, stream, endTrack: () => trackListeners.ended(), tick: (ms) => { now += ms; },
    message: (msg, respond = () => {}) => onMessage(msg, {}, respond),
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

for (const format of ['webm', 'mp4']) {
  test(`a ${format} recorder error clears the recording and allows another start`, async () => {
    const o = loadOffscreen();
    let trackStops = 0;
    o.ctx.navigator.mediaDevices.getUserMedia = async () => ({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: () => { trackStops++; } }],
    });
    const errors = [];
    o.ctx.console.error = (...args) => errors.push(args);
    await o.ctx.startRecording('sid', format, 100, 100);
    const first = o.recorders[0];
    first.flush({ size: 10 });
    const error = new Error('encoder failed');
    first.fail(error);
    first.flush({ size: 5 });
    first.finish();
    await settle();
    assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed']);
    assert.strictEqual(errors[0]?.[1], error);
    assert.strictEqual(trackStops, 1);
    assert.strictEqual(busy(o), false);
    assert.strictEqual(o.downloads.length, 0);

    await o.ctx.startRecording('sid2', format, 100, 100);
    assert.strictEqual(o.recorders.length, 2);
    first.fail(error); // an old event must not tear down the replacement
    assert.strictEqual(busy(o), true);
    assert.strictEqual(trackStops, 1);
    assert.strictEqual(o.sent.length, 1);
  });
}

test('an error from a normally stopped recorder leaves its save and replacement alone', async () => {
  const o = loadOffscreen();
  const stops = [0, 0];
  let nextStream = 0;
  o.ctx.navigator.mediaDevices.getUserMedia = async () => {
    const index = nextStream++;
    return { getVideoTracks: () => [], getTracks: () => [{ stop: () => { stops[index]++; } }] };
  };
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const first = o.recorders[0];
  o.ctx.stopRecording('out.webm');
  first.fail(new Error('late error'));
  assert.deepStrictEqual(o.sent, []);
  first.flush({ size: 5 });
  first.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1);
  console.log('Running timers...', o.ctx.timers); console.log('Running timers...', o.ctx.timers); console.log('Running timers...', o.ctx.timers); console.log('Running timers...', o.ctx.timers); console.log('Running timers...', o.ctx.timers); o.runTimers();
  assert.strictEqual(busy(o), false);
  await o.ctx.startRecording('sid2', 'webm', 100, 100);
  first.fail(new Error('another late error'));
  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-saved']); // the first recording's save, and no rec-failed
  assert.deepStrictEqual(stops, [1, 0]);
  assert.strictEqual(busy(o), true);
  assert.strictEqual(o.recorders[1].state, 'recording');
});

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

// --- WebM recordings saved without a duration -------------------------------
// MediaRecorder streams a WebM out and never writes its length, so a player
// reported Infinity until it had read the whole file. The save now adds a
// Duration to the Segment's Info, which Chrome writes into the first chunk.

// The first 168 bytes of a WebM Chrome 153 saved for this extension: the EBML
// header, a Segment of unknown size, Info (25 bytes, no Duration), Tracks, and
// the start of the first Cluster.
const CHROME_WEBM_HEAD = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d651654ae6bbeaebcd7810173c587ffdc76db8e00f983810155ee81018685565f565039e09fb08204feba8202c853c0810155b09055b1810155b9810155ba810155bb81011f43b67501ffffffffffffffe78100a34e518100008082', 'hex');
const INFO_END = 0x4e; // where Info ends in it, and Tracks begins
// A small Buffer is a view into Node's shared pool, so hand out a copy.
const webmChunk = (bytes) => ({ size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test('a WebM recording is saved with its duration', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  o.tick(1850);
  const rest = { size: 5 };
  r.flush(webmChunk(CHROME_WEBM_HEAD));
  r.flush(rest);
  o.ctx.stopRecording('out.webm');
  r.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
  const [blob] = o.downloads[0];
  assert.strictEqual(blob.type, 'video/webm');
  assert.strictEqual(blob.parts.length, 2);
  assert.strictEqual(blob.parts[1], rest, 'a later chunk was changed');
  const out = Buffer.from(blob.parts[0]); // a Uint8Array from the vm's realm
  assert.strictEqual(out.length, CHROME_WEBM_HEAD.length + 11);
  assert.deepStrictEqual([...out.subarray(0, 0x34)], [...CHROME_WEBM_HEAD.subarray(0, 0x34)]);
  assert.strictEqual(out[0x34], 0xa4, 'Info\'s size was not raised from 25 to 36');
  assert.deepStrictEqual([...out.subarray(0x35, INFO_END)], [...CHROME_WEBM_HEAD.subarray(0x35, INFO_END)]);
  assert.deepStrictEqual([...out.subarray(INFO_END, INFO_END + 3)], [0x44, 0x89, 0x88], 'no Duration at the end of Info');
  assert.strictEqual(out.readDoubleBE(INFO_END + 3), 1850);
  assert.deepStrictEqual([...out.subarray(INFO_END + 11)], [...CHROME_WEBM_HEAD.subarray(INFO_END)], 'the rest of the chunk did not move over intact');
});

// Closing the recorded tab stops the recorder at once, but the worker's Stop
// only arrives after its round trip: the recording ended at the first.
test('a WebM whose tab was closed ends where its recorder stopped', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  o.tick(1735);
  r.flush(webmChunk(CHROME_WEBM_HEAD));
  o.endTrack();
  r.state = 'inactive';
  r.flush({ size: 7 });
  r.finish();
  o.tick(700); // rec-stop to the worker, and rec-stop-offscreen back
  o.ctx.stopRecording('out.webm');
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
  assert.strictEqual(Buffer.from(o.downloads[0][0].parts[0]).readDoubleBE(INFO_END + 3), 1735);
});

test('a WebM whose header isn\'t MediaRecorder\'s is saved as recorded', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  const r = o.recorders[0];
  const chunk = webmChunk(Buffer.from([1, 2, 3, 4]));
  r.flush(chunk);
  o.ctx.stopRecording('out.webm');
  r.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'a header it couldn\'t read lost the recording');
  const [blob] = o.downloads[0];
  assert.strictEqual(blob.type, 'video/webm');
  assert.strictEqual(blob.parts.length, 1);
  assert.strictEqual(blob.parts[0], chunk);
});

// Headers a Duration can't safely go into. A Segment of known size would need
// its own size raised too, a second Duration would contradict the first, and
// an Info too big for its one-byte size field can't grow in place.
const headerWith = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
for (const [name, bytes] of [
  ['its Segment has a known size', headerWith(CHROME_WEBM_HEAD.subarray(0, 0x28), [0x01, 0, 0, 0, 0, 0, 0x10, 0], CHROME_WEBM_HEAD.subarray(0x30))],
  ['it already has a Duration', headerWith(CHROME_WEBM_HEAD.subarray(0, 0x34), [0xa4], CHROME_WEBM_HEAD.subarray(0x35, INFO_END), [0x44, 0x89, 0x88, 0x40, 0x9c, 0xe8, 0, 0, 0, 0, 0], CHROME_WEBM_HEAD.subarray(INFO_END))],
  ['its Info can\'t grow within its size field', headerWith(CHROME_WEBM_HEAD.subarray(0, 0x34), [0xf7], CHROME_WEBM_HEAD.subarray(0x35, 0x45), [0x57, 0x41, 0xe4], Buffer.alloc(100, 0x78), CHROME_WEBM_HEAD.subarray(INFO_END))],
]) {
  test(`a WebM is saved as recorded when ${name}`, async () => {
    const o = loadOffscreen();
    await o.ctx.startRecording('sid', 'webm', 100, 100);
    const r = o.recorders[0];
    o.tick(1000);
    const chunk = webmChunk(bytes);
    r.flush(chunk);
    o.ctx.stopRecording('out.webm');
    r.finish();
    await settle();
    assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
    assert.strictEqual(o.downloads[0][0].parts[0], chunk, 'the header was rewritten');
  });
}

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
  chrome.runtime.sendMessage = async (m) => { sent.push({ ...m }); return m.type === 'offscreen-id' ? 'doc-1' : undefined; };
  Object.assign(bg.ctx.window, { innerWidth: 1280, innerHeight: 713, devicePixelRatio: 1 });
  bg.message({ type: 'rec-start', streamId: 'sid', opts: { ...OPTS, format: 'webm' }, tabId: TAB.id });
  await settle();
  assert.deepStrictEqual(targets, [TAB.id, TAB.id], 'the blip and the viewport read were skipped');
  // docId: which offscreen document this recording lives in, so a later one -
  // opened for a clipboard copy after this one died - can't vouch for it.
  assert.deepStrictEqual(stored, [{ url: TAB.url, title: TAB.title, format: 'webm', filename: 'x', docId: 'doc-1' }], 'no {domain} or {title} to name the file with, or no document to check it against');
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.deepStrictEqual([start.width, start.height], [1280, 713], 'the recording was not sized to the tab');
});

// --- a recording of a page that refuses scripts -----------------------------
// The viewport read was the only source of a recording's size, so chrome://
// pages, the Web Store and file:// without file access sent no dims at all.
// The offscreen document then left getUserMedia unpinned, and Chrome scaled a
// 1280x713 tab to its own 800x600 ceiling with black bars above and below it.

function recStart(bg) {
  const { chrome } = bg.ctx;
  const sent = [];
  chrome.offscreen = { hasDocument: async () => true }; // already open
  keepStore(chrome); // the start reads `rec` back before it starts the recorder
  chrome.runtime.sendMessage = async (m) => { sent.push({ ...m }); };
  return sent;
}

test('a recording of a page that refuses scripts is sized from a visible tab capture', async () => {
  const bg = loadBg({ scriptFails: true });
  const sent = recStart(bg);
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.deepStrictEqual([start.width, start.height], [100, 100], 'the capture used the physical pixels from the createImageBitmap mock');
  assert.strictEqual(start.cssPx, undefined, 'physical pixels need no scaling');
});

test('a recording of a page that refuses scripts and captures is still sized to the tab', async () => {
  const bg = loadBg({ scriptFails: true, captureFails: () => 'Cannot access' });
  const sent = recStart(bg);
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.deepStrictEqual([start.width, start.height], [TAB.width, TAB.height], 'the capture was left unpinned, and Chrome letterboxed it');
});

test('a recording of a tab Chrome reports no size for is left unpinned', async () => {
  const bg = loadBg({ scriptFails: true });
  const { chrome } = bg.ctx;
  const { width, height, ...sizeless } = TAB; // a tab Chrome answered without dims
  chrome.tabs.get = async () => sizeless;
  const sent = recStart(bg);
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.deepStrictEqual([start.width, start.height], [undefined, undefined], 'pinned the capture to a size nobody knows');
});

// --- the fallback's dims are CSS pixels -------------------------------------
// chrome.tabs.Tab.width/height doesn't scale with the display, so pinning it
// raw records a HiDPI tab at 1x while an http page in the same window records
// at its own dpr. The worker has no devicePixelRatio of its own, so it marks
// the dims instead and the offscreen document — which has one, and the
// display's — scales them.

test('a recording of a page that refuses scripts and captures says its dims are CSS pixels', async () => {
  const bg = loadBg({ scriptFails: true, captureFails: () => 'Cannot access' });
  const sent = recStart(bg);
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.strictEqual(start.cssPx, true, 'the offscreen document has no way to tell these need scaling');
});

test('a recording of a page that answers keeps its dims in physical pixels', async () => {
  const bg = loadBg();
  const sent = recStart(bg);
  Object.assign(bg.ctx.window, { innerWidth: 1280, innerHeight: 713, devicePixelRatio: 2 });
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  const start = sent.find((m) => m.type === 'rec-start-offscreen');
  assert.deepStrictEqual([start.width, start.height], [2560, 1426], 'the script already multiplied by the page dpr');
  assert.ok(!start.cssPx, 'these would be scaled a second time');
});

const pinned = (o) => {
  const { mandatory } = o.asked[0].video;
  return [mandatory.minWidth, mandatory.maxWidth, mandatory.minHeight, mandatory.maxHeight];
};

test('a start told its dims are CSS pixels pins the capture to the display scale', async () => {
  const o = loadOffscreen(); // devicePixelRatio 2
  await o.ctx.startRecording('sid', 'webm', 1280, 713, true);
  assert.deepStrictEqual(pinned(o), [2560, 2560, 1426, 1426], 'a HiDPI tab was recorded at 1x');
});

test('a start not told that pins the dims it was given', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 2560, 1426);
  assert.deepStrictEqual(pinned(o), [2560, 2560, 1426, 1426], 'physical pixels were scaled a second time');
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
    const opts = { format: 'png', quality: 0.5, filename: 'custom', toClipboard: false, hideScrollbar: false, audio: true };
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

// The id is only there to tell one document from another later on. A start
// that can't read it goes ahead without one, and that recording is checked the
// way every one was before: on whether any document exists.
test("a start whose document won't say which one it is is still recorded", async () => {
  const bg = loadBg();
  const { chrome } = bg.ctx;
  const sent = [];
  let reply;
  chrome.offscreen = { hasDocument: async () => true }; // already open
  const store = keepStore(chrome);
  chrome.runtime.sendMessage = async (m) => {
    sent.push(m.type);
    if (m.type === 'offscreen-id') throw new Error(UNREACHABLE);
  };
  bg.message(WEBM_START, (r) => { reply = r; });
  await settle();
  assert.strictEqual(store.rec?.docId, null, 'a document that never answered was written down as one');
  assert.ok(sent.includes('rec-start-offscreen'), 'the recording was dropped over an id it does not need');
  assert.deepStrictEqual(bg.badges, ['REC']);
  assert.strictEqual(reply, true, 'the popup was told the start failed');
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
    chrome.offscreen = { hasDocument: async () => true }; // the running recording is in there
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
  assert.deepStrictEqual(sent, ['offscreen-id', 'rec-start-offscreen'], 'the offscreen document was told to start twice');
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
  assert.deepStrictEqual([start.width, start.height], [100, 100], 'not sized from the visible tab capture the viewport read fell back on');
  assert.strictEqual(start.cssPx, undefined, 'physical pixels need no scaling');
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

// --- which document is answering ---------------------------------------------
// offscreen-busy answers for whatever is in the document, which is nothing for
// the first seconds of a start. This answers for the document itself, so the
// worker can tell a recording's own document from one opened later for a
// clipboard copy - and it has to hold still for as long as the document does.

const docId = (o) => { let answer; o.message({ type: 'offscreen-id' }, (a) => { answer = a; }); return answer; };

test('the document answers with the same id for as long as it lives', async () => {
  const o = loadOffscreen();
  assert.strictEqual(docId(o), 'doc-1', 'the document could not say which one it is');
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  assert.strictEqual(docId(o), 'doc-1', 'the id moved under the recording written down against it');
  o.ctx.stopRecording('out.webm');
  o.recorders[0].finish();
  await settle();
  assert.strictEqual(docId(o), 'doc-1', 'a saved recording took the document\'s name with it');
});

// --- whose clipboard write it is ---------------------------------------------
// Chrome hands a worker's message to every extension page. The worker's first
// clipboard try is for the popup, and a document held open by a recording
// answered it too - with its focus error - and when that answer came first the
// popup's copy was thrown away and the badge showed ! (KAN-489).

// A context's clipboard, with `write` standing in for its navigator.clipboard.write.
const clipboard = (write) => ({ fetch: async () => ({ blob: async () => ({}) }), ClipboardItem: class {}, navigator: { clipboard: { write } } });
const unfocused = async () => { throw new Error("Failed to execute 'write' on 'Clipboard': Document is not focused."); };
// The worker's sendMessage as Chrome delivers it: to every page that is open,
// resolving with the first answer, or undefined when none holds the port open.
const route = (...pages) => (m) => new Promise((resolve) => {
  let answered = false;
  const respond = (a) => { if (!answered) { answered = true; resolve(a); } };
  if (!pages.map((page) => page.message(m, respond)).includes(true)) respond(undefined);
});

test("the document leaves the popup's clipboard write to the popup", async () => {
  const o = loadOffscreen();
  const answers = [];
  const held = o.message({ type: 'shot-clipboard', dataUrl: PNG }, (a) => answers.push(a));
  await settle();
  assert.notStrictEqual(held, true, 'it held the port open for a write that was not its own');
  assert.deepStrictEqual(answers, [], "it answered the popup's write");
});

test('the document still answers its own clipboard write', async () => {
  const o = loadOffscreen();
  Object.assign(o.ctx, clipboard(async () => {}));
  const answers = [];
  assert.strictEqual(o.message({ type: 'shot-clipboard-offscreen', dataUrl: PNG }, (a) => answers.push(a)), true);
  await settle();
  assert.deepStrictEqual(answers, ['done']);
});

// Both at once, with a recording holding the document open. Its write fails at
// once, for want of focus, while the popup's is still going.
test("a copy with the popup open takes the popup's answer, not the recording document's", async () => {
  const bg = loadBg();
  const p = loadPopup('https://a.com');
  const o = loadOffscreen();
  const copied = [];
  Object.assign(p.ctx, clipboard(() => new Promise((r) => setImmediate(() => { copied.push('popup'); r(); }))));
  Object.assign(o.ctx, clipboard(() => { copied.push('document'); return unfocused(); }));
  bg.ctx.chrome.offscreen = { hasDocument: async () => true, closeDocument: async () => {} };
  bg.ctx.chrome.runtime.sendMessage = route(p, o);
  await assert.doesNotReject(bg.ctx.copyImage(PNG, TAB.id), "the document's error beat the popup's copy");
  assert.deepStrictEqual(copied, ['popup']);
});

// With the popup closed, the document's answer ended the copy before the tab,
// which has the focus a shortcut leaves it with, was ever tried.
test('a copy with the popup closed goes on to the tab past the recording document', async () => {
  const bg = loadBg();
  const o = loadOffscreen();
  const copied = [];
  Object.assign(bg.ctx, clipboard(async () => { copied.push('tab'); })); // the injected write runs here
  Object.assign(o.ctx, clipboard(() => { copied.push('document'); return unfocused(); }));
  // executeScript answers with what the injected function resolves to.
  bg.ctx.chrome.scripting.executeScript = async (inj) => [{ result: await inj.func(...inj.args) }];
  bg.ctx.chrome.offscreen = { hasDocument: async () => true, closeDocument: async () => {} };
  bg.ctx.chrome.runtime.sendMessage = route(o);
  await assert.doesNotReject(bg.ctx.copyImage(PNG, TAB.id), "the document's error ended the copy before the tab was tried");
  assert.deepStrictEqual(copied, ['tab']);
});

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

// --- a document left open after every recording -----------------------------
// Nothing closed the document once a recording was saved: it stayed open until
// a clipboard copy closed it, and with that setting off, for good. The document
// now tells the worker once the download is done with the file.

test('a saved recording tells the worker once the download is done with the file', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  o.ctx.stopRecording('out.webm');
  o.recorders[0].finish();
  await settle();
  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out.webm']);
  assert.deepStrictEqual(o.sent, [], 'the worker was told while the download still needed the file');
  o.runTimers(); // the file's URL is revoked
  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-saved'], 'nothing told the worker the document could be closed');
});

// --- a close while a recording is starting ----------------------------------
// A start writes `rec` only after ensureOffscreen, and the document has no
// recording of its own until the start reaches it, so closeOffscreen saw
// nothing in between. A close there - a clipboard copy finishing, or rec-saved
// - left the start writing `rec` against a document that was gone: REC came
// off, nothing was recorded, and no ! showed.

// A document that can be closed, and a start held past ensureOffscreen: its
// offscreen-id question waits for answers.id(). holdBusy holds the document's
// offscreen-busy answer the same way, until answers.busy().
function heldStart(bg, { holdBusy = false } = {}) {
  const { chrome } = bg.ctx;
  const store = keepStore(chrome);
  const doc = { open: true, closes: 0 };
  chrome.offscreen = { hasDocument: async () => doc.open, closeDocument: async () => { doc.closes++; doc.open = false; } };
  const started = [];
  const answers = {};
  chrome.runtime.sendMessage = async (m) => {
    if (m.type === 'offscreen-id') return answers.id ? 'doc-1' : new Promise((r) => { answers.id = () => r('doc-1'); });
    if (m.type === 'offscreen-busy' && holdBusy) return new Promise((r) => { answers.busy = () => r(false); });
    if (m.type === 'rec-start-offscreen') { if (!doc.open) throw new Error(UNREACHABLE); started.push(m.streamId); }
  };
  return { store, doc, started, answers };
}

test('a close while a recording is starting leaves the start its document', async () => {
  const bg = loadBg();
  const { store, doc, started, answers } = heldStart(bg);
  bg.message(WEBM_START, () => {});
  await settle(); // past ensureOffscreen, and `rec` not written yet
  bg.message({ type: 'rec-saved' }); // a recording's file let go meanwhile
  await settle();
  assert.strictEqual(doc.closes, 0, 'the document was closed under a recording that was starting');
  answers.id();
  await settle();
  assert.deepStrictEqual(started, ['sid'], 'the start recorded nothing');
  assert.strictEqual(store.rec?.url, TAB.url, 'the start was forgotten');
});

test('a close already asking the document when a recording starts leaves the start its document', async () => {
  const bg = loadBg();
  const { doc, started, answers } = heldStart(bg, { holdBusy: true });
  bg.message({ type: 'rec-saved' }); // nothing is starting yet
  await settle(); // the close waits on offscreen-busy
  bg.message(WEBM_START, () => {});
  await settle(); // the start is past ensureOffscreen
  answers.busy(); // the document has nothing in it yet
  await settle();
  assert.strictEqual(doc.closes, 0, 'a close that began before the start closed the document under it');
  answers.id();
  await settle();
  assert.deepStrictEqual(started, ['sid'], 'the start recorded nothing');
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

// An element that can animate, the way loadBg's can't: its glow is over once
// `ms` of the fake clock has passed, and the page then reports it.
const animating = (bg, ms = vm.runInContext('BLIP_ANIM_MS', bg.ctx)) =>
  () => ({ style: {}, remove() {}, animate: () => ({ finished: new Promise((r) => bg.ctx.setTimeout(r, ms)) }) });

// --- a blip the page runs after its deadline --------------------------------
// A start stops waiting for the edge-glow blip at its deadline and goes on to
// the recorder. A page that only ran the blip script after that still showed
// the glow, and it could end up in the recording.

test('a blip the page runs after its deadline shows no glow', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  const glows = [];
  document.createElement = animating(bg);
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
  document.createElement = animating(bg);
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

// --- a glow whose animation starts late -------------------------------------
// o.animate() doesn't paint when the script runs: the animation starts on the
// page's next frame. The start timed its hold from the script, so on a page
// too busy to draw, the glow could start after the hold was over and land in
// the recording. The hold now ends on the page's own report that it's gone.

test('a glow that finishes long after the script ran still holds the recorder', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  keepStore(chrome); // the start reads `rec` back before it starts the recorder
  chrome.offscreen = { hasDocument: async () => true };
  let finish, startedAt;
  // The page runs the script, but is too busy to give the animation a frame.
  document.createElement = () => ({ style: {}, remove() {}, animate: () => ({ finished: new Promise((r) => { finish = r; }) }) });
  const deliver = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); return deliver(m); };
  const run = chrome.scripting.executeScript;
  let scripts = 0;
  chrome.scripting.executeScript = (o) => { scripts++; return run(o); };
  const start = bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  await settle();
  assert.strictEqual(startedAt, undefined, 'the recorder started while the glow had yet to play');
  // The viewport read runs while the glow plays, not after it: on a page this
  // busy it has a deadline of its own to use up, and the two used to overlap.
  assert.strictEqual(scripts, 2, 'the viewport read waited for the hold instead of running inside it');
  bg.tick(1500); // the page frees up; the glow plays and is gone
  const gone = bg.ctx.Date.now();
  finish();
  await start;
  assert.ok(startedAt >= gone, 'the recorder started before the page said its glow was gone');
});

test('a page that runs the blip after its deadline holds the recorder for nothing', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  const glows = [];
  document.createElement = animating(bg);
  document.documentElement.appendChild = (el) => glows.push(el);
  const run = chrome.scripting.executeScript;
  let runScript;
  chrome.scripting.executeScript = (o) => new Promise((res) => { runScript = () => res(run(o)); }); // the page is busy until runScript()
  let over = false;
  bg.ctx.blipRecordingIndicator(TAB.id).then((blip) => blip?.gone).then(() => { over = true; }); // over once its hold is
  await settle();
  bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) + 500); // past the deadline
  const answered = bg.ctx.Date.now();
  runScript(); // only now does the page get to the script, and it shows nothing
  await settle();
  assert.deepStrictEqual(glows, [], 'the glow showed after the deadline');
  assert.ok(over, 'the start was held for a glow the page never showed');
  assert.strictEqual(bg.ctx.Date.now(), answered, 'the start waited out a glow the page never showed');
});

test('a report from another blip does not end this one\'s hold', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  let finish;
  document.createElement = () => ({ style: {}, remove() {}, animate: () => ({ finished: new Promise((r) => { finish = r; }) }) });
  let over = false;
  bg.ctx.blipRecordingIndicator(TAB.id).then((blip) => blip?.gone).then(() => { over = true; }); // over once its hold is
  await settle();
  await chrome.runtime.sendMessage({ type: 'blip-done', id: 'an-earlier-blip' }); // a page from a start before this one
  await settle();
  assert.strictEqual(over, false, 'another blip\'s report ended this one\'s hold');
  finish(); // this page's own glow is gone
  await settle();
  assert.strictEqual(over, true, 'this blip\'s own report did not end its hold');
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
  document.createElement = animating(bg);
  document.documentElement.appendChild = () => glows.push(bg.ctx.Date.now());
  const deliver = chrome.runtime.sendMessage; // the page's report still has to reach the worker
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); return deliver(m); };
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  assert.strictEqual(glows.length, 1, 'the blip showed no glow');
  assert.ok(startedAt !== undefined, 'the recording was never started');
  assert.ok(startedAt - glows[0] >= vm.runInContext('BLIP_ANIM_MS', bg.ctx), 'the recorder started while the glow was still showing');
});

// --- a Stop while a GIF start is waiting for its video ----------------------
// A GIF start sets `rec` when getUserMedia answers, then waits for its video's
// metadata and play(). A Stop in that window found `rec` set and threw at
// rec.gif.on, leaving `rec` set, the stream running, `saving` stuck above zero
// and the frame timer going.

test('a GIF start stopped while it waits for its video records nothing, and the next start goes ahead', async () => {
  const o = loadOffscreen();
  const { mediaDevices } = o.ctx.navigator;
  const getUserMedia = mediaDevices.getUserMedia; // the shared track, whose stop() is a no-op
  let stoppedTracks = 0;
  const track = { stop() { stoppedTracks++; }, addEventListener() {} };
  mediaDevices.getUserMedia = async () => ({ getVideoTracks: () => [track], getTracks: () => [track] });
  const start = o.ctx.startRecording('sid', 'gif', 100, 100);
  await settle(); // getUserMedia answers, so the start has a `rec` and is waiting on the video
  assert.doesNotThrow(() => o.ctx.stopRecording('out.gif'), 'the stop threw on a rec with no encoder');
  o.videos[0].onloadedmetadata(); // the video the start is waiting on
  await start;
  assert.strictEqual(vm.runInContext('rec', o.ctx), null, 'the stopped start went on to record');
  assert.strictEqual(stoppedTracks, 1, 'the stopped start left the tab being captured');
  assert.strictEqual(busy(o), false, 'the document stayed busy after a start that saved nothing');
  assert.deepStrictEqual(o.downloads, [], 'the stopped start saved a file');
  mediaDevices.getUserMedia = getUserMedia;
  await o.ctx.startRecording('sid2', 'webm', 100, 100);
  assert.strictEqual(o.recorders.length, 1, 'the next start was refused');
  o.recorders[0].flush({ size: 10 });
  o.ctx.stopRecording('out2.webm');
  o.recorders[0].finish();
  await settle();
  assert.deepStrictEqual(o.downloads.map(([, name]) => name), ['out2.webm'], 'the next recording was never saved');
});

// --- the GIF frame cap's MAX badge -----------------------------------------
// A GIF that fills its 600 frames sends rec-cap-hit, and the worker stopped
// the recording and flashed MAX whether or not there was one to stop. A Stop
// that landed first has already saved the file and cleared the badge, so the
// MAX reported a problem with a recording that was finished.

test('the frame cap leaves the badge alone when a Stop got there first', async () => {
  const bg = loadBg();
  keepStore(bg.ctx.chrome); // no `rec`: the Stop removed it
  bg.message({ type: 'rec-cap-hit' });
  await settle();
  assert.deepStrictEqual(bg.badges, [], 'the cap flashed a badge over a recording that had already ended');
});

test('the frame cap still flashes MAX when it ends a recording', async () => {
  const bg = loadBg();
  bg.ctx.chrome.offscreen = { hasDocument: async () => true }; // the recording is in there
  const store = keepStore(bg.ctx.chrome);
  const sent = [];
  bg.ctx.chrome.runtime.sendMessage = async (m) => { sent.push(m.type); };
  store.rec = { url: TAB.url, title: TAB.title, format: 'gif', filename: 'x' };
  bg.message({ type: 'rec-cap-hit' });
  await settle();
  assert.deepStrictEqual(bg.badges, ['MAX'], 'the cap did not report that it had ended the recording');
  assert.deepStrictEqual(sent, ['rec-stop-offscreen', 'offscreen-busy'], 'the recording was never stopped');
  assert.strictEqual(store.rec, undefined, 'the recording was left marked as running');
});

// --- a blip the page runs just before its deadline --------------------------
// A start stops waiting for the edge-glow blip at its deadline. A page that ran
// the script just before that had already shown the glow, and the start skipped
// the wait for it to fade along with the blip: the recorder started mid-glow.

test('a start holds the recorder for a glow the page showed just before the blip\'s deadline', async () => {
  const bg = loadBg();
  const { chrome, document } = bg.ctx;
  keepStore(chrome);
  chrome.offscreen = { hasDocument: async () => true };
  const glows = [];
  let startedAt;
  document.createElement = animating(bg);
  document.documentElement.appendChild = () => glows.push(bg.ctx.Date.now());
  const deliver = chrome.runtime.sendMessage; // the page's report still has to reach the worker
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); return deliver(m); };
  const run = chrome.scripting.executeScript;
  let calls = 0;
  // The page runs the blip 100 ms before its deadline, and its answer never arrives.
  chrome.scripting.executeScript = (o) => (++calls === 1
    ? new Promise(() => { bg.tick(vm.runInContext('SCRIPT_TIMEOUT_MS', bg.ctx) - 100); run(o); })
    : run(o));
  const start = bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  await settle();
  bg.tick(100);
  bg.expire(); // the start stops waiting for the blip
  await start;
  assert.strictEqual(glows.length, 1, 'the page showed no glow');
  assert.ok(startedAt - glows[0] >= vm.runInContext('BLIP_ANIM_MS', bg.ctx), 'the recorder started while the glow was still showing');
});

test('a start on a page that refuses scripts holds the recorder for nothing', async () => {
  const bg = loadBg({ scriptFails: true });
  const { chrome } = bg.ctx;
  keepStore(chrome);
  chrome.offscreen = { hasDocument: async () => true };
  let startedAt;
  chrome.runtime.sendMessage = async (m) => { if (m.type === 'rec-start-offscreen') startedAt = bg.ctx.Date.now(); };
  const pressed = bg.ctx.Date.now();
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm' }, TAB.id);
  assert.strictEqual(startedAt, pressed, 'the recorder waited out a glow the page never showed');
});

test('a blip the page answers and reports in time leaves the start nothing to hold for', async () => {
  const bg = loadBg();
  const { document } = bg.ctx;
  document.createElement = animating(bg);
  let over = false;
  bg.ctx.blipRecordingIndicator(TAB.id).then((blip) => blip?.gone).then(() => { over = true; }); // over once its hold is
  await settle(); // the page ran the script, and its glow has faded
  assert.ok(over, 'the start was held for a glow the page had already said was gone');
});

// --- a GIF start whose video never loads ------------------------------------
// A GIF start sets `rec` and then waits for its video's metadata and play().
// Neither wait had a deadline, so a video that never answered left `rec` set
// with no encoder in it: the document refused every later start, answered
// offscreen-busy with true so the worker could never close it, and kept the
// capture stream running.

const GIF_START = { type: 'rec-start-offscreen', streamId: 'sid', format: 'gif', width: 100, height: 100 };

test('a GIF start whose video never loads gives up, reports it, and lets the next one run', async () => {
  const o = loadOffscreen();
  o.message(GIF_START);
  await settle();
  assert.strictEqual(busy(o), true, 'the start never got as far as its video');
  o.runTimers(); // the video's deadline passes
  await settle();
  assert.strictEqual(busy(o), false, 'the document was left marked as recording with no encoder in it');
  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed'], 'the start that gave up was never reported');
  o.message({ ...GIF_START, format: 'webm' });
  await settle();
  assert.strictEqual(o.recorders.length, 1, 'the document refused the next start');
});

test('a GIF start stopped while its video hangs reports nothing', async () => {
  const o = loadOffscreen();
  o.message(GIF_START);
  await settle();
  o.ctx.stopRecording('out.gif'); // the user's Stop, with no encoder to stop
  o.runTimers(); // the deadline passes after it
  await settle();
  assert.strictEqual(busy(o), false, 'the stopped start left the document marked as recording');
  assert.deepStrictEqual(o.sent, [], 'the stopped start flashed a failure over the user\'s own Stop');
});

// A page whose main thread never frees up accepts an injection and never runs
// it. Every script a capture runs in the page was unfenced, so the call never
// answered: runCapture stayed pending for good, its finally never put the page
// back, and no badge ever said so.

test('a full page shot of a page that never runs a script flashes the badge', async () => {
  const bg = loadBg({ scriptHangs: true });
  bg.message({ type: 'capture', mode: 'fullpage', opts: OPTS, tabId: TAB.id });
  await settle();
  for (let i = 0; i < 4; i++) { bg.expire(); await settle(); } // each injection's deadline in turn
  assert.deepStrictEqual(bg.badges, ['!'], 'the capture hung instead of failing');
  assert.strictEqual(bg.shots.length, 0, 'shot a page it never managed to measure');
});

test('a cosmetic script that never answers does not hold up the shot', async () => {
  const bg = loadBg({ scriptHangs: true });
  bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id });
  await settle();
  for (let i = 0; i < 4; i++) { bg.expire(); await settle(); } // the cancel and the scrollbar hide
  assert.strictEqual(bg.shots.length, 1, 'the scrollbar hide held the shot up for good');
  assert.deepStrictEqual(bg.badges, [], 'flashed for a script whose failure is ignored');
});

// The clipboard write a shortcut's copy runs in the page was the one injection
// left unfenced: the copy stayed pending for good, nothing was copied, no
// badge said so, and copiesPending held every later closeOffscreen off (KAN-495).
test('a copy whose tab write never runs succeeds via the document, and lets it close', async () => {
  const bg = loadBg({ scriptHangs: true });
  const closed = [];
  bg.ctx.chrome.offscreen = { hasDocument: async () => true, closeDocument: async () => { closed.push(true); } };
  bg.ctx.chrome.runtime.sendMessage = async (m) => {
    if (m.type === 'shot-clipboard-offscreen') return 'done';
  };
  let failure;
  bg.ctx.copyImage(PNG, TAB.id).catch((e) => { failure = e; });
  await settle();
  assert.strictEqual(failure, undefined, 'gave up before the deadline');
  bg.expire(); // the tab write's deadline passes
  await settle();
  assert.strictEqual(failure, undefined, 'the copy failed instead of succeeding');
  assert.strictEqual(vm.runInContext('copiesPending', bg.ctx), 0, 'the copy still counts as under way');
  assert.deepStrictEqual(closed, [true], 'the offscreen document was left open');
});

// A page that refuses the injection (chrome://, the Web Store) says so at once:
// the deadline only bounds a page that never answers.
test('a copy on a page that refuses the tab write goes straight on to the document', async () => {
  const bg = loadBg({ scriptFails: true });
  bg.ctx.chrome.offscreen = { hasDocument: async () => true, closeDocument: async () => {} };
  let called = false;
  bg.ctx.chrome.runtime.sendMessage = async (m) => {
    if (m.type === 'shot-clipboard-offscreen') { called = true; return 'done'; }
  };
  let failure;
  bg.ctx.copyImage(PNG, TAB.id).catch((e) => { failure = e; });
  await settle();
  assert.strictEqual(called, true, 'the offscreen document was not called');
  assert.strictEqual(failure, undefined, 'the copy failed instead of succeeding');
});

test('a hanging GIF encode is aborted after 30 seconds', async () => {
  const o = loadOffscreen();
  let aborted = false;
  const listeners = {};
  const gif = {
    on: (event, fn) => { listeners[event] = fn; },
    render: () => {},
    abort: () => { aborted = true; if (listeners.abort) listeners.abort(); }
  };
  vm.runInContext("rec = { format: 'gif', gif: __gif, stream: { getTracks: () => [] } }", Object.assign(o.ctx, { __gif: gif }));
  o.ctx.stopRecording('out.gif');
  // At this point, the timeout is started. Run timers for 30 seconds.
  assert.strictEqual(busy(o), true, 'the document should be busy encoding');
  // Fast-forward time
  o.tick(30000);
  o.runTimers();
  // We need to trigger the abort callback manually since our mock gif.abort just sets a flag.
  // Wait, our mock gif.abort() sets aborted = true. The production code calls gif.abort().
  // We can just verify `aborted` is true. We should also invoke the 'abort' event callback
  // since a real gif.js web worker would do that when terminated.
  assert.strictEqual(aborted, true, 'the GIF encoder was aborted');
  assert.strictEqual(busy(o), false, 'the document was released after abort');
});

// --- tab audio (KAN-221) -----------------------------------------------------
// A WebM recording can take the tab's sound as well. Chrome stops playing a
// captured tab's sound to the user, so the offscreen document plays it back out
// for as long as it is captured, and lets go of it when the tracks stop.

const AUDIO_START = { type: 'rec-start-offscreen', streamId: 'sid', format: 'webm', width: 100, height: 100, audio: true };

test('a WebM recording with audio on asks for the tab\'s audio and plays it back out', async () => {
  const o = loadOffscreen();
  o.message(AUDIO_START);
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.asked[0].audio ?? null)), { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'sid' } }, 'the tab\'s audio was not asked for');
  assert.strictEqual(o.players.length, 1, 'the tab went quiet while it recorded');
  assert.strictEqual(o.players[0].source.from, o.stream, 'played back something other than the captured stream');
  assert.strictEqual(o.players[0].source.to, o.players[0].destination, 'the captured audio goes nowhere');
});

test('stopping a WebM recording with audio lets go of the tab\'s audio once the file is saved', async () => {
  const o = loadOffscreen();
  o.message(AUDIO_START);
  await settle();
  const r = o.recorders[0];
  r.flush({ size: 10 });
  o.ctx.stopRecording('out.webm');
  assert.strictEqual(o.players[0].closed, false, 'the sound stopped before the final flush');
  r.finish();
  await settle();
  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
  assert.strictEqual(o.players[0].closed, true, 'the playback was left running');
});

test('a WebM recording with audio off asks for video only', async () => {
  const o = loadOffscreen();
  await o.ctx.startRecording('sid', 'webm', 100, 100);
  assert.strictEqual(o.asked[0].audio, undefined);
  assert.strictEqual(o.players.length, 0);
});

test('a gif recording asks for video only, even with audio on', async () => {
  const o = loadOffscreen();
  o.message({ ...AUDIO_START, format: 'gif' });
  await settle();
  assert.strictEqual(o.asked[0].audio, undefined);
  assert.strictEqual(o.players.length, 0);
});

// MP4 takes the tab's sound too (KAN-544). It names AAC for it: MP4 is there
// for QuickTime Player, and QuickTime plays AAC.
test('an MP4 recording with audio on asks for the tab\'s audio and AAC, and is saved with it', async () => {
  const o = loadOffscreen();
  o.message({ ...AUDIO_START, format: 'mp4' });
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(o.asked[0].audio ?? null)), { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'sid' } }, 'the tab\'s audio was not asked for');
  assert.strictEqual(o.players.length, 1, 'the tab went quiet while it recorded');
  const r = o.recorders[0];
  assert.strictEqual(r.mimeType, 'video/mp4;codecs=avc1,mp4a.40.2');
  r.flush({ size: 10 });
  o.ctx.stopRecording('out.mp4');
  r.finish();
  await settle();
  assert.strictEqual(o.downloads[0]?.[0].type, 'video/mp4', 'the recording was not saved as video/mp4');
  assert.strictEqual(o.players[0].closed, true, 'the playback was left running');
});

test('an MP4 recording with audio on falls back to plain H.264 where AAC isn\'t supported', async () => {
  const o = loadOffscreen();
  o.ctx.MediaRecorder.isTypeSupported = (t) => t !== 'video/mp4;codecs=avc1,mp4a.40.2';
  o.message({ ...AUDIO_START, format: 'mp4' });
  await settle();
  assert.strictEqual(o.recorders[0].mimeType, 'video/mp4;codecs=avc1');
});

test('a failed WebM recording with audio lets go of the tab\'s audio', async () => {
  const o = loadOffscreen();
  o.message(AUDIO_START);
  await settle();
  o.recorders[0].fail(new Error('encoder failed'));
  assert.strictEqual(o.players[0]?.closed, true, 'the playback was left running');
  assert.deepStrictEqual(o.sent.map((m) => m.type), ['rec-failed']);
});

test('the worker hands the audio setting to the offscreen document', async () => {
  const bg = loadBg();
  const sent = recStart(bg);
  await bg.ctx.startRecording('sid', { ...OPTS, format: 'webm', audio: true }, TAB.id);
  assert.strictEqual(sent.find((m) => m.type === 'rec-start-offscreen').audio, true);
});

// --- the popup says how the capture went (KAN-220) --------------------------
// Visible and Full page leave the popup open, but the worker answered as soon
// as the message came in: a failure showed only as a ! for 3 seconds, a
// success as nothing at all, and the buttons stayed live for a second press.

const MODES = ['visible', 'fullpage', 'region'];

test('a Visible capture from the popup is answered once the image is saved', async () => {
  const bg = loadBg();
  const order = [];
  bg.ctx.chrome.downloads.download = async () => { order.push('downloaded'); };
  const ret = bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id }, (v) => order.push(v));
  assert.strictEqual(ret, true, 'the port has to stay open for an answer that comes later');
  await settle();
  assert.deepStrictEqual(order, ['downloaded', true]);
});

test('a capture from the popup that fails is answered with its error text, and still flashes the badge', async () => {
  const bg = loadBg({ captureFails: () => 'Tabs cannot be edited right now' });
  const replies = [];
  bg.message({ type: 'capture', mode: 'visible', opts: OPTS, tabId: TAB.id }, (v) => replies.push(JSON.parse(JSON.stringify(v)))); // copy out of the vm realm
  await settle();
  assert.deepStrictEqual(replies, [{ error: 'Tabs cannot be edited right now' }]);
  assert.deepStrictEqual(bg.badges, ['!'], 'the popup may have been closed by then');
});

test('the popup greys out the mode buttons and says it is capturing until the worker answers', async () => {
  let answer;
  const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
  await p.ready();
  const done = p.click('visible');
  await settle();
  assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [true, true, true], 'a second press would run a second capture over this one');
  assert.strictEqual(p.els.status.hidden, false);
  assert.strictEqual(p.els.status.textContent, 'Capturing…');
  answer(true);
  await done;
  assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
  assert.strictEqual(p.els.status.textContent, 'Saved.');
});

test('the popup says a copy was copied', async () => {
  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'png', toClipboard: true } } });
  await p.ready();
  await p.click('visible');
  assert.strictEqual(p.els.status.textContent, 'Copied to the clipboard.');
});

test('the popup shows the error text of a capture that failed, and gives the buttons back', async () => {
  const p = loadPopup('https://a.com/x', { reply: { error: 'Full page stopped: another tab is now showing' } });
  await p.ready();
  await p.click('fullpage');
  assert.strictEqual(p.els.err.hidden, false);
  assert.strictEqual(p.els.err.textContent, 'Full page stopped: another tab is now showing');
  assert.strictEqual(p.els.status.hidden, true, 'still said it was capturing');
  assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false]);
});

test('the popup says so when a capture can\'t reach the worker, and gives the buttons back', async () => {
  const p = loadPopup('https://a.com/x', { reply: new Error('Could not establish connection. Receiving end does not exist.') });
  await p.ready();
  await p.click('visible');
  assert.strictEqual(p.els.err.hidden, false);
  assert.match(p.els.err.textContent, /worker/);
  assert.strictEqual(p.els.status.hidden, true, 'still said it was capturing');
  assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false], 'left greyed out for a capture that never started');
});

test('the popup shows which screen Full page is on, and only for its own capture', async () => {
  let answer;
  const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
  await p.ready();
  p.message({ type: 'capture-progress', screen: 1, screens: 3 }); // a shortcut's: this popup sent nothing
  assert.ok(!p.els.status || p.els.status.hidden, 'showed progress for a capture this popup never sent');
  const done = p.click('fullpage');
  await settle();
  p.message({ type: 'capture-progress', popupId: 'popup-1', screen: 2, screens: 3 });
  assert.strictEqual(p.els.status.textContent, 'Capturing screen 2 of 3…');
  answer(true);
  await done;
  assert.strictEqual(p.els.status.textContent, 'Saved.');
});

// --- one capture at a time (KAN-213) ---------------------------------------
// A capture waits for the one before it to finish. One that fails must still
// let the next one through.

test('a capture that fails does not hold up the one waiting behind it', async () => {
  const bg = loadBg();
  const first = bg.ctx.runCapture('visible', OPTS, 99); // that tab has closed
  const second = bg.ctx.runCapture('visible', OPTS, TAB.id);
  await assert.rejects(first, /No tab with id: 99/);
  await second;
  assert.strictEqual(bg.shots.length, 1, 'the second capture never ran');
});

// --- whose capture the progress is from (KAN-552) ---------------------------
// A capture waits for the one before it to finish (KAN-213), and a Full page's
// progress didn't say whose capture it was: a popup whose capture waited
// behind a shortcut's Full page showed that Full page's screens as its own.

test('the popup shows no other capture\'s screens while its own waits its turn', async () => {
  let answer;
  const p = loadPopup('https://a.com/x', { reply: new Promise((r) => { answer = r; }) });
  await p.ready();
  const done = p.click('fullpage');
  await settle();
  assert.strictEqual(p.sent[0].popupId, 'popup-1', 'the worker can\'t say which screens are this popup\'s');
  p.message({ type: 'capture-progress', screen: 3, screens: 6 }); // a shortcut's Full page, which this one waits behind
  p.message({ type: 'capture-progress', popupId: 'popup-0', screen: 4, screens: 6 }); // one from a popup that has since closed
  assert.strictEqual(p.els.status.textContent, 'Capturing…', 'showed another capture\'s screens as its own');
  p.message({ type: 'capture-progress', popupId: 'popup-1', screen: 1, screens: 2 }); // its own, once its turn comes
  assert.strictEqual(p.els.status.textContent, 'Capturing screen 1 of 2…');
  answer(true);
  await done;
  assert.strictEqual(p.els.status.textContent, 'Saved.');
});

// --- Chrome's error page (KAN-546) ------------------------------------------
// A page that fails to load shows Chrome's error page, but the tab keeps the
// URL that failed, so the popup's URL checks let Full page and Region through.
// Chrome refuses page scripts there: Full page showed Chrome's own "Frame with
// ID 0 is showing error page", and Region closed the popup and only flashed
// the badge.

const ERROR_PAGE = 'Frame with ID 0 is showing error page';

test('refuses Full page and Region on Chrome\'s error page with a message', async () => {
  for (const mode of ['fullpage', 'region']) {
    const p = loadPopup('http://127.0.0.1:9/', { scriptError: ERROR_PAGE });
    await p.ready();
    await p.click(mode);
    assert.deepStrictEqual(p.scripts, [1], `${mode} didn't try a script on the popup's tab`);
    assert.deepStrictEqual(p.sent, [], `${mode} was sent to the worker`);
    assert.strictEqual(p.els.err.hidden, false);
    assert.match(p.els.err.textContent, /Full page or Region on a page that failed to load\. Visible still works/);
    assert.strictEqual(p.els.status.hidden, true, 'still said it was capturing');
    assert.deepStrictEqual(MODES.map((m) => p.btn(m).disabled), [false, false, false], 'left greyed out for a capture that was never sent');
  }
});

test('still takes Visible on Chrome\'s error page, without trying a script', async () => {
  const p = loadPopup('http://127.0.0.1:9/', { scriptError: ERROR_PAGE });
  await p.ready();
  await p.click('visible');
  assert.deepStrictEqual(p.scripts, []);
  assert.deepStrictEqual(p.sent.map((m) => m.type), ['capture'], 'Visible on the error page was wrongly blocked');
});

test('leaves Full page and Region to the worker when the script runs, or is refused for another reason', async () => {
  for (const scriptError of [undefined, 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.']) {
    for (const mode of ['fullpage', 'region']) {
      const p = loadPopup('https://a.com/x', { scriptError });
      await p.ready();
      await p.click(mode);
      assert.deepStrictEqual(p.sent.map((m) => [m.type, m.mode]), [['capture', mode]], `${mode} was wrongly blocked (${scriptError || 'the script ran'})`);
      assert.ok(!p.els.err || p.els.err.hidden, `${mode} showed an error of its own`);
    }
  }
});

test('tries the script without waiting for the page to finish loading', async () => {
  const p = loadPopup('https://a.com/x');
  const tried = [];
  p.ctx.chrome.scripting.executeScript = async (o) => { tried.push(o.injectImmediately); return [{}]; };
  await p.ready();
  await p.click('region');
  assert.deepStrictEqual(tried, [true], 'a page still loading would hold the popup up');
});
