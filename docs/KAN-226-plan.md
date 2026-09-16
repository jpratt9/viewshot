# KAN-226: Add the MIT license notice for the bundled gif.js

Ticket: https://prattsolutions.atlassian.net/browse/KAN-226 (To Do, no comments). This ticket blocks KAN-224.

## What the repo does now

- `gif.js` and `gif.worker.js` are byte-for-byte the same as `dist/gif.js` and `dist/gif.worker.js` in the gif.js 0.2.0 npm package (checked with `cmp`). Their only header is line 1, for example `// gif.js 0.2.0 - https://github.com/jnordberg/gif.js` (`gif.js:1`, `gif.worker.js:1`).
- `offscreen.html:3` loads `gif.js`, and `offscreen.js:70` starts `gif.worker.js` as a worker.
- No file in the repo contains gif.js's copyright line or its MIT license text:
  - `LICENSE` is the GPLv3 license for ViewShot itself.
  - `README.md:18-19` credits only that license.
  - `package.json` and `manifest.json` don't mention a license.
- Chrome loads the extension unpacked from the repo root (`README.md:13-16`), so every file in the root ships with it. `manifest.json` doesn't list non-code files, so a new file in the root needs no manifest change.

## Change

Add one new file, `THIRD_PARTY_NOTICES.txt`, in the repo root. It uses `.txt` so it opens as plain text in a browser tab or an editor.

Nothing else changes:

- `gif.js` and `gif.worker.js` stay untouched, so they remain identical to the upstream 0.2.0 files.
- `manifest.json` needs no change.
- `README.md` doesn't ship in the extension, and README updates are KAN-223's job.
- There is no packaging script yet. When KAN-224 adds one, its zip must include `THIRD_PARTY_NOTICES.txt`.

Exact contents of `THIRD_PARTY_NOTICES.txt`:

```
ViewShot bundles the third-party code listed below, under the license shown
for each.

================================================================================
gif.js 0.2.0 - https://github.com/jnordberg/gif.js
Files in this extension: gif.js, gif.worker.js
================================================================================

The MIT License (MIT)

Copyright (c) 2013-2018 Johan Nordberg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The license text above, from "The MIT License (MIT)" to "THE SOFTWARE.", is copied exactly from upstream's `LICENSE` file (github.com/jnordberg/gif.js, `master` branch). That file has LF line endings and ends in a newline, and its copyright line is the one the ticket quotes. The 0.2.0 npm package has no `LICENSE` file. Its README's License section has the same MIT text but reads `Copyright (c) 2013 Johan Nordberg`.

## Steps

1. Create `THIRD_PARTY_NOTICES.txt` in the repo root with the contents above.
   → verify: this command prints nothing, meaning the license text matches upstream exactly:
   ```
   diff <(sed -n '/^The MIT License/,/^THE SOFTWARE\.$/p' THIRD_PARTY_NOTICES.txt) <(curl -fsSL https://raw.githubusercontent.com/jnordberg/gif.js/master/LICENSE)
   ```
2. Confirm the file ships with the loaded extension.
   → verify:
   - Reload ViewShot at `chrome://extensions` (or use Load unpacked on the repo root). No new errors appear on its card.
   - Open its service worker console and run `fetch(chrome.runtime.getURL('THIRD_PARTY_NOTICES.txt')).then(r => r.text()).then(console.log)`. It prints the notice.
3. Confirm nothing else changed.
   → verify:
   - `git status --short` lists only `THIRD_PARTY_NOTICES.txt` and this plan in `docs/`, so `gif.js` and `gif.worker.js` are unchanged.
   - `npm test` still passes all 97 cases.

## Open questions

1. **NeuQuant notice.** `gif.worker.js` also contains gif.js's `TypedNeuQuant.js` (the bundle names `"./TypedNeuQuant.js"` on `gif.worker.js:2`). That code is a port of Anthony Dekker's NeuQuant.
   - In the gif.js 0.2.0 package, the source file `src/TypedNeuQuant.js` starts with `Copyright (c) 1994 Anthony Dekker`. It grants its license "with the only requirement being that this copyright notice remain intact".
   - The dist build strips that header, so the vendored worker doesn't include it.
   - The ticket only asks for gif.js's MIT notice.

   Should `THIRD_PARTY_NOTICES.txt` get a second section with Dekker's notice? Two other bundled files, `LZWEncoder.js` and `GIFEncoder.js`, only credit their authors and set no license terms, so they need nothing.
2. **Version bump.** The new file ships in the extension. Should the version go from 0.3.2 to 0.3.3 in `manifest.json:4` and `package.json:3`? The ticket doesn't say, and past commits differ: 380fb7b and d076bef bumped it, but 7d0a487 and 1f71c31 didn't.
