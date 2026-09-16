# KAN-223: README is out of date

Ticket: https://prattsolutions.atlassian.net/browse/KAN-223 (To Do, no comments). No ticket blocks it.

## What the repo does now

- `README.md` has 19 lines and hasn't changed since a19b382, the GPLv3 relicense. It has three sections: Features (`README.md:5-11`), Install (unpacked) (`README.md:13-16`) and License (`README.md:18-19`).
- **Recording**
  - `popup.html:23-24` offers `WebM (record)` and `GIF (record)`. Choosing either one relabels Visible as Record and disables Full page and Region (`popup.js:70-78`).
  - The Stop recording button is at `popup.html:55` (`popup.js:125`). While a recording runs, the badge shows `REC` (`background.js:358-359`).
  - GIFs run at 10 fps and are at most 720px wide. They stop by themselves after 600 frames, about a minute, and the badge flashes `MAX` (`offscreen.js:26-28`, `offscreen.js:81-88`, `background.js:14`).
  - The README only names PNG/JPG/WebP (`README.md:3`, `README.md:7`).
- **Scrollbar option**
  - "Hide scrollbar before capturing" is at `popup.html:44-47`. It's on by default: `hideScrollbar: true` in `DEFAULTS` (`popup.js:1`, `background.js:1`).
  - `runCapture` applies it around every screenshot, but not around recordings (`background.js:77-84`).
  - The README never mentions it.
- **Shortcuts**
  - `manifest.json:14-26` suggests Alt+Shift+V for the visible area, Alt+Shift+F for the full page and Alt+Shift+R for a region.
  - The popup's Shortcuts link opens `chrome://extensions/shortcuts` (`popup.html:52`, `popup.js:133`).
  - `README.md:10` only says "Customizable keyboard shortcuts".
- **Permissions:** `README.md:11` says "Minimal permissions (`activeTab`) — nothing leaves your device". `manifest.json:6` requests six:
  - `activeTab` lets `captureVisibleTab` and `executeScript` run on the tab where the user clicked the icon or pressed a shortcut. The manifest has no `host_permissions`.
  - `downloads` is used to save screenshots with `chrome.downloads.download` (`background.js:91`). Recordings don't use it: the offscreen document saves them through an `<a download>` link (`offscreen.js:147-154`).
  - `scripting` injects code into the page:
    - `region.js` (`background.js:274`)
    - the full-page helpers (`background.js:115-137`, `background.js:194-212`)
    - the scrollbar style (`background.js:217-241`)
    - the recording blip and the viewport check (`background.js:386-430`)
  - `storage` holds the `opts` settings and the `rec` recording state (`popup.js:44`, `popup.js:65`, `background.js:24`, `background.js:357`, `background.js:434`).
  - `offscreen` is for the document that writes to the clipboard and records (`background.js:289-311`, `offscreen.js:1-2`).
  - `tabCapture` is how the popup gets the recording stream id (`popup.js:94`).

  "Nothing leaves your device" is still true. The only `fetch` calls read data URLs (`background.js:99`, `background.js:174`, `background.js:279`, `offscreen.js:18`).
- **Development**
  - There is no build step and there are no dependencies.
  - `package.json:7` is `"test": "node --test"`, which runs the 102 tests in `tests/`.
  - `.github/workflows/test.yml` runs `npm test` on Node 24 on every push and pull request.
  - The README mentions none of this.
- **Tests:** no test reads `README.md`. Other files that describe the code each have a test that fails when they drift: `tests/manifest.test.js`, `tests/notices.test.js` and `tests/ci.test.js`. Each of the last four commits added or extended one of them.

## Change

Two files change:

1. **`README.md`** gets the full new contents below. Compared with the current file:
   - After `README.md:7` comes a new recording bullet.
   - After `README.md:9` comes a new scrollbar-option bullet.
   - `README.md:10` now gives the shortcut keys.
   - `README.md:11` now points to the new Permissions section.
   - Two new sections, Permissions and Development, go between Install (`README.md:13-16`) and License (`README.md:18-19`).
2. **`tests/readme.test.js`** is a new file, built like `tests/notices.test.js`. It reads its facts from `popup.html`, `manifest.json` and `package.json`, so if the README falls behind those files again, a test fails.

Nothing else changes:

- The intro (`README.md:3`) stays. It's still accurate, and recording is covered in Features.
- `README.md:9`, "Download or copy straight to clipboard", stays. Copying is broken right now, but fixing that belongs to KAN-206, not to the README.
- The install steps (`README.md:13-16`) stay.
- The version stays the same (`manifest.json:4`, `package.json:3`). Nothing the extension runs changes, and the recent commits that didn't change behaviour (cb013b5, 5ba9553, fd13bfa) didn't bump it either.

New `README.md`:

```markdown
# ViewShot

A fast, minimal, **open-source** Chrome extension for screenshots — capture the **visible area**, the **full page**, or a **region** of any tab and save it as PNG/JPG/WebP (or copy to clipboard). 100% local: no account, no cloud, no tracking.

## Features
- One-click capture: visible area · full page (scroll-stitch, sticky-header aware) · region select
- PNG / JPG / WebP, with a quality slider
- Tab recording to WebM or GIF — choose one as the format, then **Record** and **Stop recording** (GIFs are 10 fps, up to 720px wide, and stop by themselves after about a minute)
- Filename templates — `{date} {time} {domain} {title}`
- Download or copy straight to clipboard
- **Hide scrollbar before capturing** keeps the scrollbar out of screenshots (on by default)
- Keyboard shortcuts — `Alt+Shift+V` visible area · `Alt+Shift+F` full page · `Alt+Shift+R` region (change them at `chrome://extensions/shortcuts`)
- Nothing leaves your device — see [Permissions](#permissions)

## Install (unpacked)
1. Open `chrome://extensions` and enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin the ViewShot icon and click it (or use the keyboard shortcut)

## Permissions
- `activeTab` — capture the tab you clicked the icon or pressed a shortcut on
- `downloads` — save screenshots
- `scripting` — run the region selector, full-page scrolling and scrollbar hiding in that tab
- `storage` — remember your settings and whether a recording is running
- `offscreen` — copy to the clipboard and record, which the background service worker can't do
- `tabCapture` — get the tab's video for recording

## Development
There's no build step and nothing to install: Chrome runs the files in this folder as they are. After changing one, press the reload button on ViewShot's card in `chrome://extensions`.

Run the tests with `npm test`. They use Node's built-in test runner, live in `tests/`, and CI runs them on every push and pull request.

## License
[GNU GPLv3](LICENSE) © John Pratt
```

New `tests/readme.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const readme = read('README.md');
const popup = read('popup.html');
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
// Nothing in the README said there were tests, let alone how to run them.

test('the README says how to run the tests', () => {
  assert.ok(pkg.scripts?.test, 'package.json has no test script for the README to point at');
  assert.ok(readme.includes('`npm test`'), 'the README never says to run `npm test`');
});
```

Both files were tried on a copy of the repo in `/tmp`. Against the current README, all 5 tests fail, each with the message for its gap. Against the new README, all 5 pass.

## Steps

1. Add `tests/readme.test.js` with the contents above.
   → verify: `node --test tests/readme.test.js` fails all 5 tests against the current README.
2. Replace `README.md` with the contents above.
   → verify: `node --test tests/readme.test.js` passes all 5 tests.
3. Check how the README renders.
   → verify: in a Markdown preview (VS Code: ⇧⌘V):
   - the Features list and the Permissions section show as bulleted lists;
   - Development shows as two paragraphs;
   - the Permissions link in Features jumps to that section.
4. Check that nothing else changed.
   → verify:
   - `git status --short` lists only `README.md`, `tests/readme.test.js` and this plan in `docs/`.
   - `npm test` passes all 107 tests: the current 102 plus the 5 new ones.

## Open questions

None. The ticket names each gap, and `manifest.json`, `popup.html` and `package.json` supply the facts needed to fill them.
