const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

// background.js with a chrome.offscreen mock that tracks document lifetime.
// The document is the thing under test: it shares a renderer main thread with
// the action popup, so it must not outlive the work it was created for.
function load({ hasDoc = false, rec = null, createRejects = false, docId = null } = {}) {
  const calls = { create: 0, close: 0, sent: [], badges: [] };
  const on = {}; // background.js's runtime.onStartup / onInstalled listeners
  let onMsg; // background.js's own runtime.onMessage listener (the first one)
  let docExists = hasDoc;
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { onMsg = onMsg || fn; }, removeListener() {} },
      onStartup: { addListener: (fn) => { on.onStartup = fn; } },
      onInstalled: { addListener: (fn) => { on.onInstalled = fn; } },
      sendMessage: async (m) => {
        calls.sent.push(m);
        // docId: which document is on the other end. null stands for one that
        // never answers the question - it is only ever asked of a document a
        // recording was written down against.
        if (m.type === 'offscreen-id') return docId;
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
        set: async (value) => { if ('rec' in value) rec = value.rec; },
        remove: async (k) => { if (k === 'rec') rec = null; },
      },
    },
    action: {
      setBadgeText: async ({ text }) => { calls.badges.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
  };
  const context = {
    chrome, console, URL, btoa, Date, clearTimeout,
    setTimeout: (fn) => fn(), // collapse the ping-poll backoff
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  return {
    ctx: context, calls, docLives: () => docExists,
    // The document going away on its own - a renderer crash - with no worker
    // restart and no closeDocument. `key` is what storage holds, read without a
    // getRec() that would check it on the way past.
    killDoc: () => { docExists = false; },
    key: () => rec,
    send: (msg, sendResponse = () => {}) => onMsg(msg, {}, sendResponse),
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
  // hasDoc: a running recording lives in a document, and one marked as running
  // without one is the leftover the check at worker start forgets.
  const { ctx, calls, docLives } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  await ctx.copyImage(PNG);
  assert.strictEqual(calls.close, 0, 'closing mid-recording would destroy the capture');
  assert.strictEqual(docLives(), true);
});

// A stopped recording is still saved in there: `rec` is removed before the
// document hears about the Stop, a GIF is encoded, and the file downloads from
// a URL the document owns. A clipboard copy in that window closed the document,
// and the recording was never saved.
test('leaves the document alone while a stopped recording is still being saved in it', async () => {
  const { ctx, calls, docLives } = load({ hasDoc: true }); // Stop has removed `rec`
  let saving = true;
  ctx.chrome.runtime.sendMessage = async (m) => {
    calls.sent.push(m);
    if (m.type === 'offscreen-busy') return saving;
    return m.type === 'offscreen-ping' ? 'pong' : 'done';
  };
  await ctx.copyImage(PNG);
  assert.strictEqual(calls.close, 0, 'closing mid-encode would lose the GIF');
  assert.strictEqual(docLives(), true);
  saving = false; // saved, and the download is done with the file
  await ctx.copyImage(PNG);
  assert.strictEqual(calls.close, 1, 'the document outlived the recording it was saving');
});

// Once the recording is saved, though, nothing closed the document: it stayed
// open until a clipboard copy closed it, and with that setting off, for good.
// The document now says when the download is done with the file, and the
// worker closes it then, through the same checks a copy's close goes through.
test('closes the document once a stopped recording has been saved', async () => {
  const { calls, docLives, send } = load({ hasDoc: true }); // Stop has removed `rec`
  send({ type: 'rec-saved' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.close, 1, 'the document outlived the recording it saved');
  assert.strictEqual(docLives(), false);
});

test('a saved recording leaves the document to a recording still running in it', async () => {
  const { calls, docLives, send } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  send({ type: 'rec-saved' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.close, 0, 'closing mid-recording would destroy the capture');
  assert.strictEqual(docLives(), true);
});

test('a saved recording leaves the document to another one still being saved in it', async () => {
  const { ctx, calls, docLives, send } = load({ hasDoc: true });
  ctx.chrome.runtime.sendMessage = async (m) => (m.type === 'offscreen-busy' ? true : 'done');
  send({ type: 'rec-saved' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.close, 0, 'closing mid-save would lose the other recording');
  assert.strictEqual(docLives(), true);
});

// A copy uses the document from its ensureOffscreen until the document answers
// the write, and the document doesn't count it: rec-saved in between closed
// the document under the write, and the copy failed.
test('a saved recording leaves the document to a clipboard write still under way in it', async () => {
  const { ctx, calls, docLives, send } = load();
  let answer;
  ctx.chrome.runtime.sendMessage = async (m) => {
    calls.sent.push(m);
    if (m.type === 'shot-clipboard') return new Promise((r) => { answer = r; });
    return m.type === 'offscreen-ping' ? 'pong' : 'done';
  };
  const copy = ctx.copyImage(PNG);
  await new Promise((r) => setImmediate(r)); // the write is under way
  send({ type: 'rec-saved' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.close, 0, 'closing mid-write would fail the copy');
  assert.strictEqual(docLives(), true);
  answer('done');
  await copy;
  assert.strictEqual(calls.close, 1, 'the copy left its document open');
});

// Nothing waits on the listener's close, so a failure in it is only ever seen
// if the listener logs it.
test('a saved recording whose close fails logs it', async () => {
  const { ctx, calls, send } = load({ hasDoc: true });
  const errors = [];
  ctx.console = { ...console, error: (...a) => errors.push(a) };
  ctx.chrome.storage.local.get = async () => { throw new Error('storage failed'); };
  send({ type: 'rec-saved' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(errors.length, 1, 'the failed close was never reported');
  assert.match(String(errors[0][1]), /storage failed/);
  assert.strictEqual(calls.close, 0);
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
    const { ctx, calls, fire } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
    await fire(event, ...args);
    await ctx.copyImage(PNG);
    assert.strictEqual(calls.close, 1, 'the leftover recording still kept the document open');
  });
}

// --- or the extension was disabled and enabled again --------------------------
// Neither event fires then, so the key outlived the recording with nothing to
// clear it: Stop stayed enabled, Record stayed greyed out, and a clipboard copy
// left its document open. The recording only lives in the offscreen document,
// so a key with no document is a leftover.

test('a recording with no offscreen document is forgotten at the next read', async () => {
  const { ctx } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: false });
  assert.strictEqual(await ctx.getRec(), undefined, 'nothing was recording, whatever the key said');
});

test("a running recording's key survives a worker start", async () => {
  const { ctx } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  assert.ok(await ctx.getRec(), 'the recording in that document was forgotten');
});

test("Stop on a leftover recording doesn't message a document that isn't there", async () => {
  const { ctx, calls } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: false });
  assert.strictEqual(await ctx.stopRecording(), false, 'it stopped a recording that was not running');
  assert.ok(!calls.sent.some((m) => m.type === 'rec-stop-offscreen'),
    'that message logged "Could not establish connection" with no document to hear it');
});

test('rec-check answers once the leftover key has been checked', async () => {
  const { send, key } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: false });
  const replies = [];
  const ret = send({ type: 'rec-check' }, (v) => replies.push(v));
  assert.strictEqual(ret, true, 'an async reply needs the port held open');
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(replies, [true]);
  assert.strictEqual(key(), null, 'the popup was answered before the key was checked');
});

// --- or the document died on its own ------------------------------------------
// A renderer crash takes the document, and the recording in it, without taking
// the worker: no restart, so a check that only ran when the worker started
// never ran again. The badge kept showing REC, the popup kept Stop enabled and
// Record greyed out, and a clipboard copy left its document open.

test('a document that dies while the worker is awake is noticed by the next read', async () => {
  const { ctx, killDoc } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  assert.ok(await ctx.getRec(), 'the recording was forgotten while its document was still there');
  killDoc();
  assert.strictEqual(await ctx.getRec(), undefined, 'nothing was recording, whatever the key said');
});

test("Stop after the document died doesn't message it", async () => {
  const { ctx, calls, killDoc } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  await ctx.getRec();
  killDoc();
  assert.strictEqual(await ctx.stopRecording(), false, 'it stopped a recording that was not running');
  assert.ok(!calls.sent.some((m) => m.type === 'rec-stop-offscreen'),
    'that message logged "Could not establish connection" with no document to hear it');
});

test('forgetting a leftover recording takes REC off the badge', async () => {
  const { ctx, calls, killDoc } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  await ctx.getRec();
  killDoc();
  await ctx.getRec();
  assert.deepStrictEqual(calls.badges, [''], 'REC was left over a recording that had ended');
});

test('rec-check re-checks a worker that is already awake', async () => {
  const { ctx, send, key, killDoc } = load({ rec: { format: 'webm', filename: 'x' }, hasDoc: true });
  await ctx.getRec(); // whatever the worker checked at startup is long settled
  killDoc();
  send({ type: 'rec-check' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(key(), null, 'opening a popup left the leftover key alone');
});

// --- and the document that answered may not be the one it lived in -----------
// Clipboard copies share this single document, so a copy that opened one after
// the recording's own had died used to answer for it: the key survived every
// read, the badge stayed on REC, Stop stayed enabled - and closeOffscreen
// returned early, leaving the copy's document open too.

const REC_A = { format: 'webm', filename: 'x', docId: 'A' };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

for (const stale of [REC_A, { format: 'webm', filename: 'legacy' }]) {
  test(`replacement loading clears the leftover recording (${stale.docId || 'legacy'})`, async () => {
    const { ctx, calls, key, send, killDoc } = load({ rec: stale, hasDoc: true });
    killDoc();
    const ping = deferred();
    const reachedPing = deferred();
    const create = ctx.chrome.offscreen.createDocument;
    let keyAtCreation;
    ctx.chrome.offscreen.createDocument = async () => {
      keyAtCreation = key();
      return create();
    };
    ctx.chrome.runtime.sendMessage = async (m) => {
      if (m.type === 'offscreen-ping') { reachedPing.resolve(); return ping.promise; }
      throw new Error('Receiving end does not exist');
    };
    const initializing = ctx.ensureOffscreen();
    await reachedPing.promise;
    try {
      assert.strictEqual(key(), null, 'stale state survived into the loading window');
      assert.strictEqual(keyAtCreation, null, 'cleanup must precede creation');
      assert.deepStrictEqual(calls.badges, ['']);
      assert.ok(!(await ctx.getRec()));
      await new Promise((resolve) => send({ type: 'rec-check' }, resolve));
      assert.strictEqual(key(), null);
    } finally {
      ping.resolve('pong');
      await initializing;
    }
  });
}

test("a document opened for a clipboard copy doesn't vouch for a recording that died with its own", async () => {
  const { ctx, calls, key } = load({ rec: REC_A, hasDoc: true, docId: 'B' });
  assert.strictEqual(await ctx.getRec(), undefined, 'a document that never held the recording answered for it');
  assert.strictEqual(key(), null);
  assert.deepStrictEqual(calls.badges, [''], 'REC was left over a recording that had ended');
});

test("a recording's own document still vouches for it", async () => {
  const { ctx, key } = load({ rec: REC_A, hasDoc: true, docId: 'A' });
  assert.ok(await ctx.getRec(), 'the recording was forgotten by the document holding it');
  assert.ok(key());
});

test("a document that can't say which one it is leaves the recording alone", async () => {
  const { ctx, key } = load({ rec: REC_A, hasDoc: true });
  ctx.chrome.runtime.sendMessage = async () => { throw new Error('Could not establish connection.'); };
  assert.ok(await ctx.getRec(), 'not being able to tell threw the recording away');
  assert.ok(key());
});

test("a copy's document is closed once the recording it isn't holding is forgotten", async () => {
  const { ctx, calls, docLives } = load({ rec: REC_A, hasDoc: true, docId: 'B' });
  await ctx.copyImage(PNG);
  assert.strictEqual(calls.close, 1, 'the copy left its document open on a recording that was not there');
  assert.strictEqual(docLives(), false);
});

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

test('concurrent callers share cleanup and readiness without late removal of new state', async () => {
  const { ctx, calls, key } = load({ rec: REC_A });
  const cleanup = deferred();
  const removing = deferred();
  const ping = deferred();
  const pinging = deferred();
  const remove = ctx.chrome.storage.local.remove;
  let removals = 0;
  ctx.chrome.storage.local.remove = async (k) => {
    removals++;
    removing.resolve();
    await cleanup.promise;
    return remove(k);
  };
  ctx.chrome.runtime.sendMessage = async () => { pinging.resolve(); return ping.promise; };
  let finished = 0;
  const first = ctx.ensureOffscreen().then(() => { finished++; });
  // Both callers enter before the first hasDocument lookup resolves.
  const second = ctx.ensureOffscreen().then(() => { finished++; });
  await removing.promise;
  assert.strictEqual(calls.create, 0);
  assert.strictEqual(finished, 0);
  cleanup.resolve();
  await pinging.promise;
  const third = ctx.ensureOffscreen().then(() => { finished++; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.create, 1);
  assert.strictEqual(finished, 0);
  ping.resolve('pong');
  await first;
  const fresh = { docId: 'B', format: 'webm' };
  await ctx.chrome.storage.local.set({ rec: fresh });
  await Promise.all([second, third]);
  assert.strictEqual(removals, 1);
  assert.strictEqual(key(), fresh);
  assert.strictEqual((await ctx.chrome.storage.local.get('rec')).rec, fresh);
});

for (const failure of ['creation', 'readiness']) {
  test(`initialization retries successfully after ${failure} failure`, async () => {
    const { ctx, calls, killDoc } = load();
    const create = ctx.chrome.offscreen.createDocument;
    if (failure === 'creation') ctx.chrome.offscreen.createDocument = async () => { throw new Error('create failed'); };
    else ctx.chrome.runtime.sendMessage = async () => { throw new Error('not ready'); };
    await assert.rejects(ctx.ensureOffscreen(), failure === 'creation' ? /create failed/ : /never answered/);
    killDoc();
    ctx.chrome.offscreen.createDocument = create;
    ctx.chrome.runtime.sendMessage = async () => 'pong';
    await ctx.ensureOffscreen();
    assert.strictEqual(calls.create, failure === 'creation' ? 1 : 2);
  });
}
