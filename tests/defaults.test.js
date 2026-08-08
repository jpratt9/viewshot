const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// background.js is a classic service worker: a no-op `chrome` is enough for its
// top-level listener registrations. (All chrome.* APIs are mocked.)
function loadBackground() {
  const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => undefined });
  const context = { chrome: deep(), console, URL, btoa, setTimeout, clearTimeout, Date };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  // `const DEFAULTS` lives in the context's lexical scope, not on the context
  // object, so it has to be evaluated out. Spread it into a plain object of this
  // realm so deepStrictEqual's prototype check can pass.
  return { ...context, DEFAULTS: { ...vm.runInContext('DEFAULTS', context) } };
}

// popup.js touches the DOM at load, so it needs stand-ins for the handful of
// elements it reads. Every element is created on demand and remembered by id so
// assertions can inspect what load() wrote into it.
function makeEl() {
  const el = {
    style: {}, dataset: {}, listeners: {},
    disabled: false, hidden: false, checked: false, value: '', textContent: '',
    addEventListener(t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
  return el;
}

async function loadPopup(store = {}) {
  const els = {};
  const document = {
    getElementById: (id) => (els[id] = els[id] || makeEl()),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
  const chrome = {
    tabs: { query: async () => [{ id: 1, url: 'https://a.com', title: 'T' }], create: () => {} },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => Object.assign(store, o),
      },
    },
    runtime: { sendMessage: () => {} },
    tabCapture: { getMediaStreamId: async () => 'sid' },
  };
  const context = { document, chrome, console, Math, parseFloat };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);
  await new Promise((r) => setImmediate(r)); // let the top-level load() settle
  return { ...context, els, store, DEFAULTS: { ...vm.runInContext('DEFAULTS', context) } };
}

// Still-image formats offered in the UI, straight from the markup so the test
// tracks the real options rather than a hand-copied list.
function stillFormatsFromMarkup() {
  const opts = [...read('popup.html').matchAll(/<option value="([^"]+)">([^<]*)</g)];
  return opts.map(([, v, label]) => ({ value: v, label }))
    .filter((o) => !/record/i.test(o.label))
    .map((o) => o.value);
}

const bg = loadBackground();

// --- the duplication guard -------------------------------------------------
// DEFAULTS is declared identically in background.js and popup.js (the worker is
// a classic script, so there is no shared module to import). Nothing but this
// test stops the two copies from drifting apart.

test('background.js and popup.js declare identical DEFAULTS', async () => {
  const popup = await loadPopup();
  assert.deepStrictEqual(popup.DEFAULTS, bg.DEFAULTS);
});

// --- the default format itself --------------------------------------------

test('defaults to jpg', () => {
  assert.strictEqual(bg.DEFAULTS.format, 'jpg');
});

test('the default format is a still format the UI offers, never a recording one', () => {
  const still = stillFormatsFromMarkup();
  assert.ok(still.includes(bg.DEFAULTS.format),
    `DEFAULTS.format ${bg.DEFAULTS.format} is not one of ${still.join(', ')}`);
  assert.ok(!['webm', 'gif'].includes(bg.DEFAULTS.format),
    'a recording format as the default would make the keyboard shortcuts write image bytes into a video file');
});

test('the default quality is in range for the lossy default format', () => {
  assert.ok(bg.DEFAULTS.quality > 0 && bg.DEFAULTS.quality <= 1);
});

// --- how the default reaches the popup ------------------------------------

test('an unconfigured popup shows the default format', async () => {
  const popup = await loadPopup({});
  assert.strictEqual(popup.els.format.value, 'jpg');
});

test('a saved format wins over the default', async () => {
  const popup = await loadPopup({ opts: { format: 'png' } });
  assert.strictEqual(popup.els.format.value, 'png');
});

test('saved settings are merged over defaults, not replaced wholesale', async () => {
  const popup = await loadPopup({ opts: { format: 'webp' } });
  assert.strictEqual(popup.els.format.value, 'webp');
  assert.strictEqual(popup.els.filename.value, bg.DEFAULTS.filename); // untouched key falls back
  assert.strictEqual(popup.els.hideScrollbar.checked, bg.DEFAULTS.hideScrollbar);
});

test('the quality row is visible for the lossy default format', async () => {
  const popup = await loadPopup({});
  assert.strictEqual(popup.els.qualityRow.style.display, 'flex');
});

test('the quality row stays hidden for png', async () => {
  const popup = await loadPopup({ opts: { format: 'png' } });
  assert.strictEqual(popup.els.qualityRow.style.display, 'none');
});
