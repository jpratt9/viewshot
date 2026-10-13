const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load background.js in a sandbox with a no-op `chrome` so its top-level
// listener registrations don't throw, then pull out the real buildName().
// (chrome.* APIs are fully mocked — no extension/runtime is touched.)
function loadBackground() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src/background/background.js'), 'utf8');
  const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => undefined });
  const context = { chrome: deep(), console, URL, btoa, setTimeout, clearTimeout, Date };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

const { buildName } = loadBackground();

test('substitutes {domain} (stripping www) and {title}, appends the extension', () => {
  const name = buildName('{domain}-{title}', 'webm', { url: 'https://www.example.com/x', title: 'My Page' });
  assert.strictEqual(name, 'example.com-My-Page.webm');
});

test('uses the given extension for recordings (gif)', () => {
  assert.strictEqual(buildName('clip', 'gif', { url: 'https://a.com', title: '' }), 'clip.gif');
});

test('sanitizes filesystem-illegal characters out of the name', () => {
  assert.strictEqual(buildName('{title}', 'png', { url: 'https://a.com', title: 'a/b:c*d?' }), 'a-b-c-d.png');
});

test('falls back to "shot" when the template reduces to nothing', () => {
  assert.strictEqual(buildName('///', 'webm', { url: 'https://a.com', title: '' }), 'shot.webm');
});

test('expands {date}/{time} into a timestamped name', () => {
  const name = buildName('shot-{date}-{time}', 'webm', { url: 'https://a.com', title: '' });
  assert.match(name, /^shot-\d{4}-\d{2}-\d{2}-\d{6}\.webm$/);
});

test('does not throw on an unparseable tab URL (empty {domain})', () => {
  assert.strictEqual(buildName('{domain}x', 'png', { url: 'not a url', title: '' }), 'x.png');
});

test('truncates very long titles to 60 chars', () => {
  const longTitle = 'a'.repeat(100);
  const name = buildName('{title}', 'png', { url: 'https://a.com', title: longTitle });
  assert.strictEqual(name, 'a'.repeat(60) + '.png');
});

// --- Chrome keeping the name ------------------------------------------------
// Any extension listening to onDeterminingFilename had the last word on
// downloads.download's filename, even by calling suggest() with nothing, and
// every shot was saved as download.jpeg. A shot now goes to the offscreen
// document, which saves it as an <a download> carrying its name.

// background.js with no chrome.downloads at all, as Chrome hands it over now
// that the manifest doesn't ask for it. `save` is the offscreen document's
// answer to a save.
function loadSaving({ open = true, save = async () => 'done' } = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src/background/background.js'), 'utf8');
  const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => undefined });
  const sent = [];
  const doc = { open, created: [], closes: 0 };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      sendMessage: async (m) => {
        sent.push({ ...m });
        if (m.type === 'offscreen-ping') return 'pong';
        if (m.type === 'offscreen-busy') return false;
        if (m.type === 'shot-save-offscreen') return save(m);
      },
    },
    offscreen: {
      hasDocument: async () => doc.open,
      createDocument: async (o) => { doc.created.push(o); doc.open = true; },
      closeDocument: async () => { doc.closes++; doc.open = false; },
    },
    storage: { local: { get: async () => ({}) } },
    downloads: undefined,
  };
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    async convertToBlob({ type }) { return { type, arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }
  const context = {
    chrome: new Proxy(chrome, { get: (t, k) => (k in t ? t[k] : deep()) }),
    console: { ...console, log: () => {} }, URL, btoa, setTimeout, clearTimeout, Date,
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { ctx: context, sent, doc, saves: () => sent.filter((m) => m.type === 'shot-save-offscreen') };
}

const PNG = 'data:image/png;base64,AAAA';
const OPTS = { format: 'jpg', quality: 0.92, filename: 'shot-{title}', toClipboard: false };
const TAB = { url: 'https://a.com', title: 'Page' };

test('a shot goes to the offscreen document under its name, and never to chrome.downloads', async () => {
  const { ctx, saves } = loadSaving();
  await ctx.saveCapture(PNG, OPTS, TAB);
  const [save] = saves();
  assert.strictEqual(save.filename, 'shot-Page.jpg');
  assert.match(save.dataUrl, /^data:image\/jpeg;base64,/);
});

test('opens the offscreen document for a shot when none is open', async () => {
  const { ctx, sent, doc } = loadSaving({ open: false });
  await ctx.saveCapture(PNG, OPTS, TAB);
  assert.strictEqual(doc.created.length, 1);
  assert.ok(doc.created[0].reasons.includes('BLOBS'), 'the shot is saved from a blob: URL');
  const types = sent.map((m) => m.type);
  assert.ok(types.indexOf('offscreen-ping') < types.indexOf('shot-save-offscreen'), 'sent before the document was listening');
});

test('a shot the offscreen document did not save fails the capture', async () => {
  const { ctx } = loadSaving({ save: async () => ({ error: 'Failed to fetch' }) });
  await assert.rejects(() => ctx.saveCapture(PNG, OPTS, TAB), /Failed to fetch/);
  const { ctx: unanswered } = loadSaving({ save: async () => undefined });
  await assert.rejects(() => unanswered.saveCapture(PNG, OPTS, TAB), /did not save/);
});

test('the offscreen document is not closed under a shot on its way to it', async () => {
  let answer;
  const { ctx, doc } = loadSaving({ save: () => new Promise((r) => { answer = r; }) });
  const saving = ctx.saveCapture(PNG, OPTS, TAB);
  await new Promise((r) => setImmediate(r)); // sent, and not answered yet
  await ctx.closeOffscreen(); // a clipboard copy finishing, say
  assert.strictEqual(doc.closes, 0, 'closed the document the shot was sent to');
  answer('done');
  await saving;
  await ctx.closeOffscreen(); // from here, the document says whether it is busy
  assert.strictEqual(doc.closes, 1, 'the finished save still held the document open');
});
