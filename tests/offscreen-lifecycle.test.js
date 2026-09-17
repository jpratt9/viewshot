const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// background.js with a chrome.offscreen mock that tracks document lifetime.
// The document is the thing under test: it shares a renderer main thread with
// the action popup, so it must not outlive the work it was created for.
function load({ hasDoc = false, rec = null, createRejects = false } = {}) {
  const calls = { create: 0, close: 0, sent: [] };
  const on = {}; // background.js's runtime.onStartup / onInstalled listeners
  let docExists = hasDoc;
  const chrome = {
    runtime: {
      onMessage: { addListener() {}, removeListener() {} },
      onStartup: { addListener: (fn) => { on.onStartup = fn; } },
      onInstalled: { addListener: (fn) => { on.onInstalled = fn; } },
      sendMessage: async (m) => {
        calls.sent.push(m);
        return m.type === 'offscreen-ping' ? 'pong' : 'done';
      },
    },
    commands: { onCommand: { addListener() {} } },
    offscreen: {
      hasDocument: async () => docExists,
      createDocument: async () => {
        calls.create++;
        if (createRejects) throw new Error('createDocument failed');
        docExists = true;
      },
      closeDocument: async () => { calls.close++; docExists = false; },
    },
    storage: {
      local: {
        get: async (k) => (k === 'rec' && rec ? { rec } : {}),
        remove: async (k) => { if (k === 'rec') rec = null; },
      },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const context = {
    chrome, console, URL, btoa, Date, clearTimeout,
    setTimeout: (fn) => fn(), // collapse the ping-poll backoff
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  return {
    ctx: context, calls, docLives: () => docExists,
    fire: async (event, ...args) => {
      assert.ok(on[event], `nothing listens for runtime.${event}`);
      await on[event](...args);
    },
  };
}

const PNG = 'data:image/png;base64,AAAA';

// --- the document must not outlive its work ---------------------------------

test('closes the offscreen document after a clipboard copy', async () => {
  const { ctx, calls, docLives } = load();
  await ctx.copyImage(PNG);
  assert.strictEqual(calls.close, 1);
  assert.strictEqual(docLives(), false, 'must not stay resident competing with the popup');
});

test('still closes the document when the clipboard write rejects', async () => {
  const { ctx, calls } = load();
  ctx.chrome.runtime.sendMessage = async (m) => {
    if (m.type === 'offscreen-ping') return 'pong';
    throw new Error('clipboard failed');
  };
  await assert.rejects(() => ctx.copyImage(PNG));
  assert.strictEqual(calls.close, 1, 'a failed write must not leak the document');
});

test('closes a new document that never answers, and fails the copy', async () => {
  const { ctx, calls, docLives } = load();
  ctx.chrome.runtime.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  await assert.rejects(() => ctx.copyImage(PNG), /offscreen document never answered/);
  assert.strictEqual(calls.close, 1, 'a document that never answered was left open');
  assert.strictEqual(docLives(), false);
});

test('waits for the clipboard write to be acknowledged before closing', async () => {
  const { ctx, calls } = load();
  await ctx.copyImage(PNG);
  const order = calls.sent.map((m) => m.type);
  assert.ok(order.includes('shot-clipboard'), 'the write is sent');
  assert.strictEqual(calls.close, 1, 'and only then is the document closed');
});

// --- but it must survive a live recording -----------------------------------

test('leaves the document alone while a recording is running', async () => {
  const { ctx, calls, docLives } = load({ rec: { format: 'webm', filename: 'x' } });
  await ctx.copyImage(PNG);
  assert.strictEqual(calls.close, 0, 'closing mid-recording would destroy the capture');
  assert.strictEqual(docLives(), true);
});

// --- unless the browser or the extension ended it -----------------------------
// `rec` is kept in chrome.storage.local so a recording outlives a worker
// restart. It also outlived Chrome quitting and the extension reloading, which
// the recording itself doesn't, and nothing cleared it: the popup kept Stop
// enabled, and this document was never closed after a clipboard copy again.

const ENDINGS = [
  ['onStartup', 'Chrome starting again', []],
  ['onInstalled', 'the extension being installed, updated or reloaded', [{ reason: 'update' }]],
];

for (const [event, what, args] of ENDINGS) {
  test(`${what} forgets a recording that couldn't survive it`, async () => {
    const { ctx, calls, fire } = load({ rec: { format: 'webm', filename: 'x' } });
    await fire(event, ...args);
    await ctx.copyImage(PNG);
    assert.strictEqual(calls.close, 1, 'the leftover recording still kept the document open');
  });
}

test('closeOffscreen is a no-op when no document exists', async () => {
  const { calls, ctx } = load({ hasDoc: false });
  await ctx.closeOffscreen();
  assert.strictEqual(calls.close, 0);
});

// --- a failed create must not poison every later call ------------------------

test('retries createDocument after an earlier create rejected', async () => {
  const { ctx, calls } = load({ createRejects: true });
  await assert.rejects(() => ctx.ensureOffscreen());
  // Second attempt must issue a fresh create, not re-await the cached rejection.
  await assert.rejects(() => ctx.ensureOffscreen());
  assert.strictEqual(calls.create, 2, 'offscreenCreating must be cleared on failure');
});

test('reuses an existing document instead of creating a second one', async () => {
  const { ctx, calls } = load({ hasDoc: true });
  await ctx.ensureOffscreen();
  assert.strictEqual(calls.create, 0, 'only one offscreen document is permitted per extension');
});
