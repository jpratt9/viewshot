const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

// --- the Web Store zip --------------------------------------------------
// Chrome loads the repo root unpacked, so every file is there while the
// extension is being worked on. The store gets only what `npm run package`
// zips, and a file left off that list breaks only the published build.

const zipped = pkg.scripts?.package?.match(/^rm -f viewshot\.zip && zip -X -MM viewshot\.zip (.+)$/)?.[1].split(' ') ?? [];

test('npm run package rebuilds viewshot.zip from files that exist', () => {
  assert.ok(zipped.length, 'package.json has no package script that rebuilds viewshot.zip');
  for (const f of zipped) assert.ok(fs.existsSync(path.join(root, f)), `the package script zips ${f}, which does not exist`);
});

test('the zip holds exactly the files the extension loads, plus its license notices', () => {
  const needed = new Set(['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']);
  for (const f of zipped.filter((f) => /\.(json|html|css|js)$/.test(f))) {
    for (const [, ref] of read(f).matchAll(/["']([\w.-]+\.(?:html|css|js|png))["']/g)) needed.add(ref);
  }
  assert.deepStrictEqual([...zipped].sort(), [...needed].sort());
});
