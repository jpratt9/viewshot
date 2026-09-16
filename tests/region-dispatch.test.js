const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const settle = () => new Promise((r) => setImmediate(r));

// --- the reported bug -------------------------------------------------------
// Region worked intermittently: the first press did nothing at all, the second
// one brought up the overlay. The popup fired chrome.runtime.sendMessage and
// called window.close() in the same turn, so whenever the service worker had
// gone dormant its wake was still in flight when the sending frame was torn
// down, and the message went with it. A warm worker won the race, which is why
// it only failed after the extension had been idle for a while.

function makeEl(extra = {}) {
  const el = {
    style: {}, dataset: {}, listeners: {},
    disabled: false, hidden: true, checked: false, value: '', textContent: '',
    addEventListener(t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    ...extra,
  };
  return el;
}

// popup.js against a fake document that actually hands back the mode buttons,
// so the click handler under test is really registered. `ack` is the worker's
// reply, left pending until a test resolves or rejects it by hand.
function loadPopup(store = { opts: { format: 'jpg' } }) {
  const els = {};
  const sent = [];
  let closed = false;
  let settleAck;
  const ack = new Promise((res, rej) => { settleAck = { res, rej }; });

  const modes = ['visible', 'fullpage', 'region'].map((m) => {
    const el = makeEl();
    el.dataset.mode = m;
    return el;
  });
  const byMode = (m) => modes.find((b) => b.dataset.mode === m);

  const document = {
    getElementById: (id) => (els[id] = els[id] || makeEl()),
    querySelector: () => makeEl(),
    // toggleRec() asks for the fullpage/region pair; the click wiring asks for
    // all three. Both must come back as the same objects the test clicks.
    querySelectorAll: (sel) => (sel.includes('#modes')
      ? modes
      : modes.filter((b) => sel.includes(`"${b.dataset.mode}"`))),
  };

  const chrome = {
    tabs: { query: async () => [{ id: 1, url: 'https://a.com', title: 'T' }], create: () => {} },
    storage: {
      local: {
        get: async (k) => {
          const out = {};
          for (const key of (Array.isArray(k) ? k : [k])) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (o) => Object.assign(store, o),
        onChanged: { addListener() {} },
      },
    },
    runtime: { sendMessage: (msg) => { sent.push(msg); return ack; } },
    tabCapture: { getMediaStreamId: async () => 'sid' },
  };

  const localStorage = { getItem: () => null, setItem: () => {} };
  const context = {
    document, chrome, console: { ...console, error: () => {} }, Math, parseFloat, JSON, localStorage,
    window: { close: () => { closed = true; } },
  };
  vm.createContext(context);
  vm.runInContext(read('popup.js'), context);

  return {
    els, sent, ack: settleAck,
    click: (mode) => byMode(mode).listeners.click[0](),
    closed: () => closed,
  };
}

test('Region keeps the popup open until the worker acknowledges the message', async () => {
  const p = loadPopup();
  p.click('region');
  await settle();
  await settle();
  // The message is out but unanswered - the window in which a cold-starting
  // worker is still waking, and in which closing threw the message away.
  assert.deepStrictEqual(p.sent.map((m) => [m.type, m.mode]), [['capture', 'region']]);
  assert.strictEqual(p.closed(), false, 'closed before the worker answered');
});

test('Region closes the popup only after the answer arrives', async () => {
  const p = loadPopup();
  const done = p.click('region');
  await settle();
  p.ack.res(true);
  await done;
  assert.strictEqual(p.closed(), true);
});

test('a refused message leaves the popup open and says so', async () => {
  const p = loadPopup();
  const done = p.click('region');
  await settle();
  p.ack.rej(new Error('Could not establish connection.'));
  await done;
  assert.strictEqual(p.closed(), false, 'a dropped message must not look like a successful capture');
  assert.strictEqual(p.els.err.hidden, false);
  assert.match(p.els.err.textContent, /worker/i);
});

// --- the other half: the worker has to actually answer ----------------------
// Awaiting in the popup only helps if something replies. The listener has to
// call sendResponse synchronously, before it yields: an async reply needs the
// handler to `return true` to hold the port open, and a handler that returns
// nothing without responding closes the channel and rejects the caller.

function loadBackground() {
  let listener;
  const queries = [];
  const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => undefined });
  const chrome = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    // No active tab, so runCapture gives up straight after this call - enough to
    // show it ran without dragging the whole capture pipeline in.
    tabs: { query: async (q) => { queries.push({ ...q }); return []; } }, // copy out of the vm realm
    storage: deep(), scripting: deep(), downloads: deep(), action: deep(), offscreen: deep(),
  };
  const context = {
    chrome, console: { ...console, error: () => {}, log: () => {}, warn: () => {} },
    URL, btoa, clearTimeout, Date,
    // Giving up flashes the badge, and its 3-second reset mustn't hold the test run open.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  return { listener, queries };
}

test('acknowledges a capture message synchronously, before any await', () => {
  const { listener } = loadBackground();
  const replies = [];
  const ret = listener({ type: 'capture', mode: 'region', opts: {} }, {}, (v) => replies.push(v));
  assert.deepStrictEqual(replies, [true], 'the popup has nothing to await if the worker never replies');
  assert.notStrictEqual(ret, true, 'returning true would hold the port open for a reply already sent');
});

test('still runs the capture after acknowledging it', async () => {
  const { listener, queries } = loadBackground();
  listener({ type: 'capture', mode: 'visible', opts: {} }, {}, () => {});
  await settle();
  assert.deepStrictEqual(queries, [{ active: true, currentWindow: true }],
    'the ack must not have replaced the work it acknowledges');
});

test('leaves the recording messages unacknowledged, as before', () => {
  const { listener } = loadBackground();
  const replies = [];
  listener({ type: 'rec-stop' }, {}, (v) => replies.push(v));
  assert.deepStrictEqual(replies, [], 'only the capture path has a caller waiting on a reply');
});
