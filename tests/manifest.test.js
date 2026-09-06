const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
const manifest = load('manifest.json');
const pkg = load('package.json');

// --- the store listing --------------------------------------------------
// Chrome truncates manifest.description at 132 characters, in the listing and
// in chrome://extensions, with no warning anywhere. The first one ran to 171
// and was cut mid-sentence — visibly, right after an em dash.

test('the description fits in what Chrome will actually show', () => {
  assert.ok(manifest.description.length <= 132,
    `description is ${manifest.description.length} chars; Chrome shows "${manifest.description.slice(0, 132)}"`);
});

test('the description still names what the extension does', () => {
  for (const claim of [/screenshot/i, /region/i, /record/i]) {
    assert.match(manifest.description, claim);
  }
});

// --- the two version strings --------------------------------------------
// There is no build step to derive one from the other, so they are bumped by
// hand and drift silently: the manifest version is what Chrome installs, the
// package version is what the repo claims to be.

test('manifest.json and package.json agree on the version', () => {
  assert.strictEqual(manifest.version, pkg.version);
});

test('the version is a plain dotted number Chrome will accept', () => {
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
});
