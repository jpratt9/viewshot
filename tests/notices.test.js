const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Chrome loads the extension from the repo root, so that is where the notice
// has to sit to ship with the code it covers.
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const notices = read('THIRD_PARTY_NOTICES.txt');

// --- gif.js's MIT notice ------------------------------------------------
// gif.js and gif.worker.js are vendored gif.js 0.2.0, which is MIT licensed,
// and MIT requires its copyright and permission notice to travel with every
// copy. The vendored files carry a one-line header and nothing more, so the
// notice lives in THIRD_PARTY_NOTICES.txt instead.

test('the notices file carries gif.js\'s copyright and MIT permission notice', () => {
  assert.match(notices, /^Copyright \(c\) 2013-2018 Johan Nordberg$/m);
  assert.match(notices, /^The above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software\.$/m,
    'the MIT condition that makes the notice mandatory is missing');
  assert.match(notices, /^THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/m,
    'the MIT warranty disclaimer is missing');
});

// --- the notice against what is vendored --------------------------------
// Upgrading or swapping out gif.js would leave a notice that describes code
// the extension no longer ships.

test('the notice names the gif.js release and files that are actually vendored', () => {
  const release = notices.match(/^gif\.js (\S+) - https:\/\/github\.com\/jnordberg\/gif\.js$/m)?.[1];
  assert.ok(release, 'THIRD_PARTY_NOTICES.txt has no "gif.js <version> - <url>" line');
  const covered = [...notices.matchAll(/^Files in this extension: (.+)$/gm)].flatMap((m) => m[1].split(/,\s*/));
  for (const f of ['gif.js', 'gif.worker.js']) {
    assert.ok(covered.includes(f), `${f} is vendored but no section of the notice covers it`);
    assert.strictEqual(read(f).split('\n')[0], `// ${f} ${release} - https://github.com/jnordberg/gif.js`,
      `${f} is not the gif.js ${release} the notice describes`);
  }
});
