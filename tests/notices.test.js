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
    assert.strictEqual(read(`src/vendor/${f}`).split('\n')[0], `// ${f} ${release} - https://github.com/jnordberg/gif.js`,
      `${f} is not the gif.js ${release} the notice describes`);
  }
});

// --- the NeuQuant notice inside gif.worker.js ---------------------------
// gif.worker.js also bundles gif.js's TypedNeuQuant.js, a port of Anthony
// Dekker's NeuQuant. Its license asks only that Dekker's copyright notice
// remain intact, and gif.js's minified build strips it, so the notice file
// carries it instead.

test('the notices file carries Dekker\'s NeuQuant notice for gif.worker.js', () => {
  const worker = read('src/vendor/gif.worker.js');
  assert.ok(worker.includes('"./TypedNeuQuant.js"'),
    'gif.worker.js no longer bundles TypedNeuQuant.js, so the NeuQuant section is stale');
  const release = notices.match(/^NeuQuant - bundled as TypedNeuQuant\.js in gif\.js (\S+)\nFiles in this extension: gif\.worker\.js$/m)?.[1];
  assert.ok(release, 'no NeuQuant section covers gif.worker.js');
  assert.ok(worker.startsWith(`// gif.worker.js ${release} - `),
    `the NeuQuant section names gif.js ${release}, which is not the vendored release`);
  assert.match(notices, /^Copyright \(c\) 1994 Anthony Dekker$/m);
  assert.match(notices, /^copies from any such party to do so, with the only requirement being\nthat this copyright notice remain intact\.$/m,
    'the condition that makes the NeuQuant notice mandatory is missing');
});
