# KAN-225: Run npm test in CI

Ticket: https://prattsolutions.atlassian.net/browse/KAN-225 (To Do, no comments, nothing blocking it).

## What the repo does now

- **Test command:** `package.json:7` defines `"test": "node --test"`. The package has no dependencies, no lockfile, no `engines` field and no `.nvmrc`.
- **Tests:** `node --test` picks up the 10 `*.test.js` files in `tests/`.
  - They use only Node's built-in modules: `node:test`, `node:assert`, `node:fs`, `node:path` and `node:vm`.
  - Locally, on Node v24.9.0 with npm 11.6.0, the suite runs 100 tests. The ticket's count of 97 was written before KAN-226 and KAN-227 added tests.
  - Node 24 prints its `ℹ tests …` / `ℹ pass …` summary even when the output isn't a terminal, so the same lines will appear in the CI log.
- **CI:** there is no `.github/` folder and no other CI setup. GitHub reports 0 workflows and 0 runs for jpratt9/viewshot, and `main` is the only branch.

## Change

Add one new file, `.github/workflows/test.yml`:

```yaml
name: test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm test
```

Choices:

- **Triggers:** `push` and `pull_request` on every branch, as the ticket asks.
- **Node 24:** it's the current LTS release line, and it's the version the suite already passes on locally (v24.9.0). The repo doesn't pin a Node version anywhere else.
- **Action versions:** `actions/checkout@v7` (v7.0.1, released 2026-07-20) and `actions/setup-node@v7` (v7.0.0, released 2026-07-14) are the newest major versions.
- **No install step:** there are no dependencies to install, and `npm ci` would fail without a lockfile. For the same reason, setup-node's npm cache stays off, since it needs a lockfile too.

Nothing else changes: `package.json`, the tests and the extension files all stay as they are.

## Steps

1. Create `.github/workflows/test.yml` with the contents above.
   → verify: this command prints `['pull_request', 'push'] {'run': 'npm test'}`. (PyYAML reads the `on:` key as `True`, which is why the command looks up `w[True]`.)
   ```
   python3 -c "import yaml; w = yaml.safe_load(open('.github/workflows/test.yml')); print(sorted(w[True]), w['jobs']['test']['steps'][-1])"
   ```
2. Run the workflow's command locally.
   → verify: `npm test` passes all 100 tests and exits with 0 (`npm test; echo $?` ends in `0`).
3. Check that the extension still loads. Chrome loads the whole repo folder, which now includes `.github/`.
   → verify: reload ViewShot at `chrome://extensions`. No new errors appear on its card.
4. After the ship step pushes the commit, check that GitHub runs the workflow.
   → verify:
   - `gh api repos/jpratt9/viewshot/actions/workflows --jq .total_count` prints `1`.
   - `gh run list --workflow test.yml --limit 1` shows a run for the pushed commit.
   - `gh run watch <run-id> --exit-status` finishes successfully.
   - `gh run view <run-id> --log | grep 'ℹ pass'` shows `ℹ pass 100`.

   Notes:
   - The `pull_request` trigger is checked by step 1's command; no test pull request gets opened.
   - Pushing a file under `.github/workflows/` needs a GitHub token with the `workflow` scope. The `gh` login has that scope. If the push is refused for that reason, push with `gh`'s credentials instead:
     ```
     git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main
     ```

## Open questions

None. The ticket names the CI system, the repo, the command to run and when to run it.
