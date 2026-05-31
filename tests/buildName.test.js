const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load background.js in a sandbox with a no-op `chrome` so its top-level
// listener registrations don't throw, then pull out the real buildName().
// (chrome.* APIs are fully mocked — no extension/runtime is touched.)
function loadBackground() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
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
