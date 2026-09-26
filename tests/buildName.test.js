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

// --- Chrome naming the file -------------------------------------------------
// With another extension's onDeterminingFilename listener installed, Chrome
// dropped downloads.download's filename and saved every shot as download.jpg.

function loadSaving({ downloadFails = false } = {}) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src/background/background.js'), 'utf8');
  const deep = () => new Proxy(function () {}, { get: () => deep(), apply: () => undefined });
  let determine;
  const started = [];
  const downloads = {
    onDeterminingFilename: { addListener: (fn) => { determine = fn; } },
    download: async (o) => { started.push({ ...o }); if (downloadFails) throw new Error('Invalid filename'); },
  };
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    async convertToBlob({ type }) { return { type, arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }
  const context = {
    chrome: new Proxy({ downloads }, { get: (t, k) => (k in t ? t[k] : deep()) }),
    console, URL, btoa, setTimeout, clearTimeout, Date,
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  // What Chrome is told to call a download at `url`: undefined is "decide
  // yourself", 'unanswered' means the listener left Chrome waiting.
  const named = (url) => {
    let out = 'unanswered';
    determine({ url }, (s) => { out = s && { ...s }; });
    return out;
  };
  return { ctx: context, started, named };
}

const OPTS = { format: 'jpg', quality: 0.92, filename: 'shot-{title}', toClipboard: false };
const TAB = { url: 'https://a.com', title: 'Page' };

test('names its own shot in the step Chrome actually goes by', async () => {
  const { ctx, started, named } = loadSaving();
  await ctx.saveCapture('data:image/png;base64,AAAA', OPTS, TAB);
  assert.deepStrictEqual(named(started[0].url), { filename: 'shot-Page.jpg' });
});

test('leaves every other download for Chrome to name', () => {
  const { named } = loadSaving();
  assert.strictEqual(named('https://example.com/file.zip'), undefined);
});

test('a shot is named once, and not held onto afterwards', async () => {
  const { ctx, started, named } = loadSaving();
  await ctx.saveCapture('data:image/png;base64,AAAA', OPTS, TAB);
  named(started[0].url);
  assert.strictEqual(named(started[0].url), undefined);
});

test('a download that never starts is not left waiting for a name', async () => {
  const { ctx, started, named } = loadSaving({ downloadFails: true });
  await assert.rejects(() => ctx.saveCapture('data:image/png;base64,AAAA', OPTS, TAB));
  assert.strictEqual(named(started[0].url), undefined);
});
