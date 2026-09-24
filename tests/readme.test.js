const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const readme = read('README.md');
const popup = read('src/popup/popup.html');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));

// --- what the extension does --------------------------------------------
// Nothing tied the README to the code, so it went on describing the first
// release: no recording, no scrollbar option, no shortcut keys.

test('the README mentions recording to every format the popup records to', () => {
  const formats = [...popup.matchAll(/<option value="\w+">(\w+) \(record\)<\/option>/g)].map((m) => m[1]);
  assert.ok(formats.length, 'popup.html has no "(record)" formats to look for');
  for (const f of formats) {
    assert.ok(readme.split('\n').some((line) => /record/i.test(line) && line.includes(f)),
      `no line of the README mentions recording to ${f}`);
  }
});

test('the README names the popup\'s scrollbar option', () => {
  const label = popup.match(/id="hideScrollbar" \/>\s*<span>([^<]+)<\/span>/)?.[1];
  assert.ok(label, 'popup.html has no label for the hideScrollbar checkbox');
  assert.ok(readme.includes(label), `the README never mentions "${label}"`);
});

test('the README gives the default key for every shortcut', () => {
  for (const [name, { suggested_key: key }] of Object.entries(manifest.commands)) {
    if (key?.default) assert.ok(readme.includes(`\`${key.default}\``), `the README never mentions ${key.default} (${name})`);
  }
});

// --- permissions --------------------------------------------------------
// The README promised "Minimal permissions (`activeTab`)" while the manifest
// asked for five more.

test('the README lists exactly the permissions the manifest requests', () => {
  const section = readme.split(/^## /m).find((s) => s.startsWith('Permissions\n'));
  assert.ok(section, 'the README has no "## Permissions" section');
  const listed = [...section.matchAll(/^- `(\w+)`/gm)].map((m) => m[1]);
  assert.deepStrictEqual(listed.sort(), [...manifest.permissions].sort());
});

// --- development --------------------------------------------------------
// Nothing in the README said there were tests, let alone how to run them,
// and the Web Store zip script arrived without a mention either.

test('the README says how to run the tests', () => {
  assert.ok(pkg.scripts?.test, 'package.json has no test script for the README to point at');
  assert.ok(readme.includes('`npm test`'), 'the README never says to run `npm test`');
});

test('the README says how to build the Web Store zip', () => {
  assert.ok(pkg.scripts?.package, 'package.json has no package script for the README to point at');
  assert.ok(readme.includes('`npm run package`'), 'the README never says to run `npm run package`');
});
