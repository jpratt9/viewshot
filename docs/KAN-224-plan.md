# KAN-224: Add a packaging script for the Chrome Web Store zip

Ticket: https://prattsolutions.atlassian.net/browse/KAN-224 (To Do, no comments). Its only blocker, KAN-226, is Done.

## What the repo does now

- **No packaging:**
  - `package.json:6-8` has one script, `"test": "node --test"`.
  - The repo has no build script, no `scripts/` folder and no zip.
  - `.gitignore:1` only lists `.DS_Store`.
  - No commit mentions packaging.
- **Unpacked only:** Chrome loads the repo root as it is (`README.md:15-18`, `README.md:29`). That folder also holds `tests/`, `docs/`, `.github/`, `package.json`, `README.md` and `.gitignore`, and the extension uses none of them.
- **Files the extension loads:** `manifest.json` and the 13 files it leads to:
  - `manifest.json` names `popup.html` (`manifest.json:8`), the four icons (`manifest.json:10`, `manifest.json:12`) and `background.js` (`manifest.json:13`).
  - `popup.html` loads `popup.css` (`popup.html:5`) and `popup.js` (`popup.html:57`).
  - `background.js` injects `region.js` (`background.js:281`) and opens `offscreen.html` (`background.js:302`).
  - `offscreen.html` loads `gif.js` and `offscreen.js` (`offscreen.html:3-4`).
  - `offscreen.js` starts `gif.worker.js` as a worker (`offscreen.js:70`). `gif.js` also names that file as its default worker script (`gif.js:2`).
  - `popup.css`, `popup.js`, `region.js` and `gif.worker.js` name no other files. `popup.css` has no `url()`.
- **Notices:**
  - `LICENSE` is ViewShot's GPLv3 license.
  - `THIRD_PARTY_NOTICES.txt` holds the gif.js MIT notice and the NeuQuant notice. Both must ship with `gif.js` and `gif.worker.js`.
  - `docs/KAN-226-plan.md:24` already says this ticket's zip must include `THIRD_PARTY_NOTICES.txt`.
- **The ticket's list:** the files above come to 16, which is exactly what the ticket lists:
  - `popup.*` means `popup.html`, `popup.css` and `popup.js`.
  - `offscreen.*` means `offscreen.html` and `offscreen.js`.
  - "the icons" means `icon16.png`, `icon32.png`, `icon48.png` and `icon128.png`.
  - "the license" means `LICENSE`.
- **Tools:** `/usr/bin/zip` is Info-ZIP Zip 3.0. npm 11.6.0 runs package scripts with `sh`.
- **Tests:**
  - `npm test` passes 113 tests on Node v24.9.0.
  - Each file that describes the code has a test that fails if the file drifts out of date: `tests/manifest.test.js`, `tests/readme.test.js`, `tests/notices.test.js` and `tests/ci.test.js`.

## Change

Two files change and one new file is added.

1. **`package.json`** gets a `package` script after `test` (`package.json:7`):
   ```json
     "scripts": {
       "test": "node --test",
       "package": "rm -f viewshot.zip && zip -X -MM viewshot.zip manifest.json background.js popup.html popup.css popup.js region.js offscreen.html offscreen.js gif.js gif.worker.js icon16.png icon32.png icon48.png icon128.png LICENSE THIRD_PARTY_NOTICES.txt"
     }
   ```
   `npm run package` writes `viewshot.zip` to the repo root, with all 16 files at the top level of the zip.
2. **`.gitignore`** gets a second line, `viewshot.zip`, so the build output never shows up in `git status`.
3. **`tests/package.test.js`** is a new file, built like `tests/ci.test.js`. It reads the file list from the `package` script and fails in either of these cases:
   - The script is missing, or one of the files it lists doesn't exist.
   - The list isn't exactly `manifest.json`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, plus every file name that appears in quotes inside a zipped `.json`, `.html`, `.css` or `.js` file.

   This means the suite fails if the extension starts loading a file the zip leaves out. It also fails if a repo-only file such as `README.md` is added to the zip. Right now, every quoted file name in those files is a real reference (checked while planning).

   ```js
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
   ```

Choices:

- **`zip`, not a Node zip writer:** Node has no zip API, the package has no dependencies, and `zip` is already installed.
- **Each file named separately:** globs like `popup.*`, `offscreen.*` and `icon*.png` would also pick up stray files such as `popup.js.orig`. If the list misses a file the extension needs, the new test catches it.
- **`-MM`:** without it, zip warns about a missing file, leaves it out and still exits with 0. With it, zip exits with 18 and writes no zip. Both behaviours were checked while planning.
- **`rm -f` first:** zip adds to an existing archive. Without the `rm`, a file removed from the list would stay in the zip from the previous build.
- **`-X`:** leaves out Unix owner IDs and extra timestamps, so the zip holds only the files themselves.
- **Output is `viewshot.zip` in the repo root,** overwritten on every run.
  - The store reads the version from `manifest.json`, not from the file name.
  - When Chrome loads the root unpacked, it ignores the zip.
- **macOS and Linux only:** the script needs `sh`, `rm` and `zip`, which macOS has. It won't run from Windows `cmd`.
- **No version bump:** nothing the extension runs changes. KAN-223, KAN-225 and KAN-227 made the same call.
- **Nothing else changes:** the extension's files, `manifest.json`, `README.md` and the CI workflow stay as they are.

Checked while planning, on a copy of the repo outside this folder:

- **Script:** `npm run package` exited with 0 and zipped the 16 files. The same zip command produced 16 files identical to the repo's.
- **Test:** with the new test, 115 tests pass. Each of these changes makes it fail:
  - dropping `popup.css` from the script;
  - adding `README.md` to the script;
  - naming a missing `nope.js` (`npm run package` also exits with 18);
  - going back to the current `package.json`, which fails both new cases.

## Steps

1. Add `viewshot.zip` to `.gitignore`, on the line after `.gitignore:1`.
   → verify: `git check-ignore viewshot.zip` prints `viewshot.zip`.
2. Add `tests/package.test.js` with the contents above.
   → verify: `node --test tests/package.test.js` fails both cases, because `package.json` has no `package` script yet.
3. Add the `package` script to `package.json`, after `package.json:7`.
   → verify:
   - `npm test` passes 115 tests (113 existing plus the 2 new ones).
   - Try these temporary edits to the script:
     - Dropping `popup.css` fails the second case.
     - Adding `README.md` fails the second case.
     - Naming a file that doesn't exist fails the first case, and `npm run package` exits with 18 and leaves no `viewshot.zip`.
   - Undo the edits and confirm `npm test` passes again.
4. Build the zip.
   → verify:
   - `npm run package` exits with 0 and prints an `adding:` line for each of the 16 files.
   - `unzip -Z1 viewshot.zip` prints exactly the 16 names, with no folders.
   - `git status --short` doesn't list `viewshot.zip`.
   - The zipped files match the repo's copies. This command prints only the path of the temporary folder it unzips into, with no `cmp` output:
     ```
     T=$(mktemp -d) && unzip -q viewshot.zip -d "$T" && for f in $(unzip -Z1 viewshot.zip); do cmp "$f" "$T/$f"; done; echo "$T"
     ```
5. Load that unzipped folder in Chrome 152. Use Load unpacked at `chrome://extensions`, or headless Chrome as earlier changes did.
   → verify:
   - The extension's card shows no errors.
   - The popup opens with its styles.
   - Visible, Full page and Region each save a file.
   - A short GIF recording saves a `.gif`. The recording loads `offscreen.html`, `offscreen.js`, `gif.js` and `gif.worker.js` from the zip.
6. Check that nothing else changed.
   → verify: `git status --short` lists only `.gitignore`, `package.json`, `tests/package.test.js` and this plan.

## Open questions

1. **README.** After this change, the Development section (`README.md:28-31`) still only says "There's no build step and nothing to install" and explains how to run `npm test`. Should it also say that `npm run package` builds `viewshot.zip` for the Chrome Web Store?
   - The ticket doesn't ask for this.
   - If the answer is yes, `tests/readme.test.js` could check for it, the same way it checks for `npm test` (`tests/readme.test.js:52-55`).
