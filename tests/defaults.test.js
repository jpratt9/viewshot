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

// Boots popup.js WITHOUT letting its async load() settle, so assertions can see
// exactly what the first painted frame contained.
function bootPopup(store = {}, cache = null) {
  const els = {};
  const storageGets = [];
  const mirror = { value: cache === null ? null : JSON.stringify(cache) };
  const document = {
    getElementById: (id) => (els[id] = els[id] || makeEl()),
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
  const chrome = {
    tabs: { query: async () => [{ id: 1, url: 'https://a.com', title: 'T' }], create: () => {} },
    storage: {
      local: {
        // chrome.storage.local.get accepts a key or an array of keys.
        // chrome.storage.local.get accepts a key or an array of keys.
        get: async (k) => {
          storageGets.push(Array.isArray(k) ? [...k] : k); // copy out of the vm realm
          const out = {};
          for (const key of (Array.isArray(k) ? k : [k])) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (o) => Object.assign(store, o),
        onChanged: { addListener() {} },
      },
    },
    runtime: { sendMessage: () => {} },
    tabCapture: { getMediaStreamId: async () => 'sid' },
  };
  const localStorage = {
    getItem: (k) => (k === 'opts' ? mirror.value : null),
    setItem: (k, v) => { if (k === 'opts') mirror.value = v; },
  };
  const context = { document, chrome, console, Math, parseFloat, JSON, localStorage };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);
  return {
    ...context, els, store, mirror, storageGets,
    // const/let live in the context's lexical scope, not on the context object.
    DEFAULTS: { ...vm.runInContext('DEFAULTS', context) },
    save: vm.runInContext('save', context),
    settle: () => new Promise((r) => setImmediate(r)),
  };
}

async function loadPopup(store = {}, cache = null) {
  const p = bootPopup(store, cache);
  await p.settle(); // let the top-level load() finish reconciling
  return p;
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
const DEFAULT_NAME = bg.DEFAULTS.filename;

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
  assert.ok(!['webm', 'mp4', 'gif'].includes(bg.DEFAULTS.format),
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

// --- first paint must not wait on any async round trip ----------------------
// Chrome does not show the popup until its onload completes, so anything the
// UI awaits before painting is lag the user sees on every single click.

test('paints the form before any async work settles', () => {
  const popup = bootPopup({ opts: { format: 'webp' } }, { format: 'webp', quality: 0.5, filename: 'x', toClipboard: true, hideScrollbar: false });
  // No settle() — this is the first frame.
  assert.strictEqual(popup.els.format.value, 'webp');
  assert.strictEqual(popup.els.filename.value, 'x');
  assert.strictEqual(popup.els.toClipboard.checked, true);
});

test('falls back to defaults in the first frame when no cache exists', () => {
  const popup = bootPopup({}, null);
  assert.strictEqual(popup.els.format.value, 'jpg');
  assert.strictEqual(popup.els.filename.value, DEFAULT_NAME);
});

test('a corrupt cache does not break the first paint', () => {
  const popup = bootPopup({});
  popup.mirror.value = '{not json';
  const again = bootPopup({});
  again.mirror.value = '{not json';
  assert.strictEqual(again.els.format.value, 'jpg', 'falls back to defaults rather than throwing');
});

test('mirrors settings to the synchronous cache on save', async () => {
  const popup = await loadPopup({ opts: { format: 'webp' } });
  popup.els.filename.value = 'renamed';
  popup.els.quality.value = '0.8';
  popup.save();
  assert.strictEqual(JSON.parse(popup.mirror.value).filename, 'renamed');
});

test('reads storage once, not once per key', async () => {
  const popup = await loadPopup({ opts: { format: 'png' }, rec: null });
  assert.strictEqual(popup.storageGets.length, 1, 'opts and rec must come from a single round trip');
  assert.deepStrictEqual(popup.storageGets[0], ['opts', 'rec']);
});

test('chrome.storage wins over a stale cache once it resolves', async () => {
  const popup = await loadPopup({ opts: { format: 'png' } }, { format: 'webp' });
  assert.strictEqual(popup.els.format.value, 'png', 'cache is a paint hint, storage is the truth');
});

test('still migrates the old filename default through the cache path', () => {
  const popup = bootPopup({}, { format: 'jpg', filename: 'shot-{date}' });
  assert.strictEqual(popup.els.filename.value, DEFAULT_NAME);
});

// --- a setting changed while the popup is opening ---------------------------
// load() waits on a storage read and a tab query, and the form is filled in
// from the cache before that. A setting changed during the wait was saved, and
// then load() put the older stored value back in the form.

test('a Name changed while the popup is opening stays in the form', async () => {
  const popup = bootPopup({ opts: { format: 'png', filename: 'stored' } }, { format: 'png', filename: 'stored' });
  popup.els.filename.value = 'renamed'; // after load() read storage, before it went on
  popup.els.filename.listeners.change[0]();
  await popup.settle();
  assert.strictEqual(popup.els.filename.value, 'renamed', 'load() put the older Name back in the form');
  assert.strictEqual(popup.store.opts.filename, 'renamed');
});

test('a format changed while the popup is opening stays in the form', async () => {
  const popup = bootPopup({ opts: { format: 'png' } }, { format: 'png' });
  popup.els.format.value = 'jpg'; // after load() read storage, before it went on
  popup.els.format.listeners.change[0]();
  await popup.settle();
  assert.strictEqual(popup.els.format.value, 'jpg', 'load() put the older format back in the form');
  assert.strictEqual(popup.els.qualityRow.style.display, 'flex', 'the quality row no longer matches the format');
  assert.strictEqual(popup.store.opts.format, 'jpg');
});
