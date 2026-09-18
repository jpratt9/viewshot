const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PNG = 'data:image/png;base64,AAAA';
const TAB = { id: 7, windowId: 1, url: 'https://a.com', title: 'T' };
const settle = () => new Promise((r) => setImmediate(r));

// background.js against a fake page. `order` records every side effect in the
// sequence it happened, which is what these tests are actually about: the
// overlay has to be gone BEFORE the shutter fires.
function loadBg({ scriptFails = false } = {}) {
  const order = [];
  const listeners = [];
  const downloads = [];

  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    async convertToBlob() { return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }

  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i !== -1) listeners.splice(i, 1); },
      },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      sendMessage: async () => {},
    },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      query: async () => [TAB],
      captureVisibleTab: async () => { order.push('capture'); return PNG; },
    },
    scripting: {
      executeScript: async (o) => {
        const isCancel = o.func && String(o.func).includes('__shotRegionCancel');
        order.push(o.files ? `inject:${o.files[0]}` : isCancel ? 'cancel' : `func:${o.func.name || 'anon'}`);
        if (scriptFails) throw new Error('Cannot access contents of the page');
        return [{ result: o.func ? o.func.apply(null, o.args || []) : undefined }];
      },
    },
    downloads: { download: async (d) => { order.push('download'); downloads.push(d); } },
    storage: { session: (() => { let s = {}; return { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o), remove: async (k) => delete s[k] }; })(), local: { get: async () => ({}) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };

  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
  const context = {
    chrome, console, URL, btoa, Date, clearTimeout,
    // Collapse the settle sleeps. The capture deadline never passes.
    setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
    window: {}, // the page the cancel injection runs against
    document: { getElementById: () => null, head: null, documentElement: { appendChild() {} }, createElement: () => ({ style: {} }) },
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);

  const baseline = listeners.length; // background.js's own top-level listener
  return {
    ctx: context, order, downloads, listeners,
    extraListeners: () => listeners.length - baseline,
    dispatch: (msg) => listeners.forEach((fn) => fn(msg)),
  };
}

const OPTS = { format: 'png', quality: 1, filename: 'x', toClipboard: false, hideScrollbar: false };

// --- the reported bug -------------------------------------------------------
// Click Region, walk away, then take a Visible shot: the dimmed overlay was
// still on the page and got baked into the image.

test('clears an abandoned overlay before the shutter fires', async () => {
  const { ctx, order } = loadBg();
  await ctx.runCapture('visible', OPTS);
  assert.ok(order.indexOf('cancel') !== -1, 'the teardown must be attempted');
  assert.ok(order.indexOf('cancel') < order.indexOf('capture'), 'and it must happen before the capture');
});

test('clears it before a full page stitch too', async () => {
  const { ctx, order } = loadBg();
  await ctx.runCapture('fullpage', OPTS).catch(() => {}); // measurePage has no real page to read
  assert.strictEqual(order[0], 'cancel');
});

test('the injected teardown calls the page hook', async () => {
  const { ctx } = loadBg();
  let torn = 0;
  ctx.window.__shotRegionCancel = () => { torn++; };
  await ctx.cancelRegion(TAB);
  assert.strictEqual(torn, 1);
});

test('the injected teardown is a no-op on a page with no overlay', async () => {
  const { ctx } = loadBg(); // window has no __shotRegionCancel
  await assert.doesNotReject(() => ctx.cancelRegion(TAB));
});

test('an uninjectable page does not block the capture', async () => {
  const { ctx, order, downloads } = loadBg({ scriptFails: true });
  await ctx.runCapture('visible', OPTS); // chrome:// refuses injection, and holds no overlay
  assert.strictEqual(downloads.length, 1, 'the shot must still be taken and saved');
  assert.ok(order.includes('capture'));
});

// --- the abandoned promise --------------------------------------------------
// captureRegion now saves state to session storage and exits. Starting another
// capture has to clear that state.

test('starting another capture settles the abandoned selection as a cancel', async () => {
  const { ctx, order } = loadBg();
  await ctx.runCapture('region', OPTS);
  await settle();
  assert.ok(order.includes('inject:region.js'));
  await ctx.runCapture('visible', OPTS);
  await settle();
  assert.ok(order.indexOf('cancel') !== -1, 'it must be cancelled');
});

test('the abandoned selection releases its message listener', async () => {
  const { ctx, extraListeners } = loadBg();
  await ctx.runCapture('region', OPTS);
  await settle();
  assert.strictEqual(extraListeners(), 0, 'no extra listeners should be left behind');
});

// The page-side teardown is silent for exactly this reason: a shot-region sent
// from it could arrive after the next selection installed its listener and
// cancel that one instead.
test('cancelling does not consume the next selection', async () => {
  const { ctx, dispatch, downloads } = loadBg();
  await ctx.runCapture('region', OPTS);
  await settle();
  await ctx.cancelRegion(TAB);
  
  await ctx.runCapture('region', OPTS);
  await settle();
  dispatch({ type: 'shot-region', rect: { x: 10, y: 20, w: 100, h: 80, dpr: 2 } });
  await settle();
  assert.strictEqual(downloads.length, 1, 'the new drag must still produce a shot');
});

test('a second Region click gets a fresh overlay rather than the stale guard', async () => {
  const { ctx, order, dispatch, downloads } = loadBg();
  await ctx.runCapture('region', OPTS);
  await settle();
  await ctx.runCapture('region', OPTS);
  await settle();
  assert.ok(order.indexOf('cancel') < order.lastIndexOf('inject:region.js'), 'torn down before re-injecting');
  dispatch({ type: 'shot-region', rect: { x: 10, y: 20, w: 100, h: 80, dpr: 2 } });
  await settle();
  assert.strictEqual(downloads.length, 1);
});

// --- the popup must get out of the way --------------------------------------
// Left open it covers the dimmed overlay, holds the focus Escape needs, and
// makes a live selection look like a rendering bug.

function loadPopup() {
  const els = {};
  const modes = ['visible', 'fullpage', 'region'].map((m) => makeEl({ mode: m }));
  function makeEl(dataset = {}) {
    const el = {
      style: {}, dataset, listeners: {},
      disabled: false, hidden: false, checked: false, value: '', textContent: '',
      addEventListener(t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); },
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
    };
    return el;
  }
  const sent = [];
  let closed = 0;
  const context = {
    console, Math, parseFloat, JSON,
    window: { close: () => { closed++; } },
    document: {
      getElementById: (id) => (els[id] = els[id] || makeEl()),
      querySelector: () => makeEl(),
      querySelectorAll: (sel) => (sel === '#modes .mode' ? modes : []),
    },
    chrome: {
      tabs: { query: async () => [TAB], create: () => {} },
      storage: { session: (() => { let s = {}; return { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o), remove: async (k) => delete s[k] }; })(), local: { get: async () => ({}), set: async () => {}, onChanged: { addListener() {} } } },
      // The popup's startup rec-check is the worker's business, not this file's.
      runtime: { sendMessage: async (m) => { if (m.type !== 'rec-check') sent.push(m); } },
      tabCapture: { getMediaStreamId: async () => 'sid' },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);
  const click = async (mode) => {
    const btn = modes.find((m) => m.dataset.mode === mode);
    await Promise.all(btn.listeners.click.map((f) => f()));
    await settle();
  };
  return { click, sent, closed: () => closed };
}

test('Region closes the popup so the page can be dragged on', async () => {
  const p = loadPopup();
  await settle(); // wait until startup enables capture
  await p.click('region');
  assert.deepStrictEqual(p.sent.map((m) => m.mode), ['region'], 'the capture is still requested');
  assert.strictEqual(p.closed(), 1);
});

test('the popup stays open for the modes that need no page interaction', async () => {
  for (const mode of ['visible', 'fullpage']) {
    const p = loadPopup();
    await settle(); // wait until startup enables capture
    await p.click(mode);
    assert.strictEqual(p.closed(), 0, `${mode} must not dismiss the popup`);
  }
});
