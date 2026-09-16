const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const workflow = read('.github/workflows/test.yml');
const pkg = JSON.parse(read('package.json'));

// --- the CI workflow ----------------------------------------------------
// GitHub Actions runs the suite for every push and pull request. Nothing
// else checks the workflow before GitHub runs it, so these pin what it is
// there for: when it runs, and that it runs the same `npm test` a laptop does.

test('CI runs on every push and every pull request', () => {
  const on = workflow.match(/^on: \[([^\]]*)\]$/m)?.[1].split(',').map((s) => s.trim()).sort();
  assert.deepStrictEqual(on, ['pull_request', 'push'], 'the workflow no longer triggers on both push and pull_request');
});

test('CI runs the npm test script without an install step the repo cannot satisfy', () => {
  assert.match(workflow, /^ +- run: npm test$/m, 'the workflow does not run npm test');
  assert.ok(pkg.scripts?.test, 'package.json has no test script for CI to run');
  // npm ci refuses to run without a lockfile, and the package has no dependencies to install.
  if (!fs.existsSync(path.join(root, 'package-lock.json'))) {
    assert.doesNotMatch(workflow, /\bnpm (ci|install|i)\b/, 'the workflow installs packages, but there is no lockfile');
  }
});
