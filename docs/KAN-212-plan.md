# KAN-212: Keyboard shortcuts save a PNG named .webm or .gif when a recording format is selected

Ticket: https://prattsolutions.atlassian.net/browse/KAN-212 (To Do, no comments, labels `bug` and `viewshot`). No ticket blocks it.

## What the repo does now

- **Shortcuts**
  - `onCommand` (`background.js:18-21`) maps each of the three commands to a mode and calls `runCapture(mode, await getOpts())`.
  - `getOpts` (`background.js:23-28`) merges the stored `opts` over `DEFAULTS`, so `format` is whatever the popup saved last. The popup saves it in `popup.js:62-66`, and does so on every format change (`popup.js:127`).
  - Nothing on this path checks for `webm` or `gif`.
- **Popup:** it never passes a recording format to `runCapture`.
  - For `webm`/`gif` (`isRecFmt`, `popup.js:3`), a click goes down the recording branch (`popup.js:88-102`).
  - `toggleRec` (`popup.js:72-78`) disables Full page and Region.
  - So only the shortcuts can call `runCapture` with `webm` or `gif`.
- **Saving:** `runCapture` (`background.js:72-93`) takes the shot the same way for all three modes (`background.js:79-81`).
  - With `toClipboard` on, it copies the PNG (`background.js:87-88`), and no file name is involved.
  - Otherwise it calls `encode()` and downloads the result under the name from `buildName(opts.filename, ext, tab)` (`background.js:90-91`).
- **The bug**
  - `encode()` (`background.js:96-106`) falls back to `image/png` for a format it doesn't know (`background.js:98`), but still returns `ext: opts.format` (`background.js:105`).
  - `buildName` appends that `ext` (`background.js:458`), so the download asks for PNG data to be named `shot-<date>-<time>.webm` or `.gif`.
  - `blobToDataURL` labels the data URL with the blob's real type (`background.js:466`), so the URL itself says `image/png`.
- **What Chrome 152 does with that request.** This was checked for this plan in headless Chrome 152.0.7977.83, using a copy of the extension with `"host_permissions": ["<all_urls>"]`:
  - `chrome.downloads.download` replaces a file extension that doesn't match the data URL's type. PNG data named `.gif`, `.webm` or `.txt` was saved as `.png`, and JPEG data named `.png` was saved as `.jpeg`.
  - With the current `background.js`, the shortcut's call (`runCapture('visible', await getOpts())`) saved these files:
    - with `gif` or `webm` stored: `kan212.png`, containing PNG bytes;
    - with `jpg` stored: `kan212.jpg`, containing JPEG bytes.
  - So in this Chrome, the file on disk already ends in `.png`. The code still asks for the wrong name, and only Chrome's renaming corrects it.
- **Tests**
  - No test fires a shortcut or checks what a download is named. The harnesses stub out `commands.onCommand.addListener` and `downloads.download` (for example `tests/capture-errors.test.js:35` and `tests/capture-errors.test.js:51`).
  - `loadBg` (`tests/capture-errors.test.js:21-76`) is the closest existing harness.

## Change

Two files change:

1. **`background.js`, in `encode()`:**
   - Pick the extension first: `opts.format` if it is a key of `mimes`, otherwise `png`.
   - Take `mime` from that extension and return the same `ext`.
   - `background.js:98` and `background.js:105` change, and a 3-line comment plus the new `ext` line go in after `background.js:97`.
2. **`tests/shortcut-format.test.js`** is a new file with 3 tests. It loads `background.js` against a fake browser, fires the real `onCommand` listener with a stored format, and checks the download that results.

Nothing else changes:

- The shortcuts still take the screenshot. The ticket says they "still take a screenshot, but save it under the wrong extension", so the plan fixes the name and keeps the screenshot.
- `popup.js` stays the same, because it never sends `webm` or `gif` to `runCapture`.
- Copy to clipboard stays the same. It always copies a PNG and never uses a file name.
- `jpg`, `png` and `webp` get the same MIME type and extension as before.
- For the version, see Open questions.

New `encode()`, at `background.js:95-110` after the change:

```js
// ---- re-encode to chosen format/quality via OffscreenCanvas ----
async function encode(pngDataUrl, opts) {
  const mimes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  // The shortcuts pass the stored format as-is, and the popup can leave that
  // on webm or gif. Those still get a PNG, so name the file .png as well
  // rather than asking for PNG data to be saved as .webm or .gif.
  const ext = mimes[opts.format] ? opts.format : 'png';
  const mime = mimes[ext];
  const bmp = await createImageBitmap(await (await fetch(pngDataUrl)).blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob(mime === 'image/png' ? { type: mime } : { type: mime, quality: opts.quality });
  return { dataUrl: await blobToDataURL(blob), ext };
}
```

New `tests/shortcut-format.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const settle = () => new Promise((r) => setImmediate(r));

// --- screenshot shortcuts with a recording format selected --------------
// The popup never takes a screenshot in WebM or GIF: it turns Visible into
// Record and disables the other two modes. The shortcuts read the same
// stored format with no such check, and encode() fell back to PNG data but
// still named the file after the format, so Alt+Shift+V asked for a PNG to
// be saved as shot.gif. Chrome 152 quietly renames that to .png, which hid
// the mismatch rather than fixing it.

// Loads background.js against a fake browser whose stored format is `format`,
// presses `command`, and returns every download the worker started.
async function pressShortcut(command, format) {
  const downloads = [];
  let onCommand;
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {}, fillStyle: '', fillRect() {} }; }
    // Hand back a blob of whatever type was asked for, so the data URL shows
    // what encode() actually produced.
    async convertToBlob({ type }) { return { type, arrayBuffer: async () => new Uint8Array([1]).buffer }; }
  }
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
    tabs: {
      query: async () => [{ id: 7, windowId: 1, url: 'https://a.com', title: 'T' }],
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
    },
    scripting: { executeScript: async () => [{}] },
    downloads: { download: async (o) => { downloads.push(o); } },
    storage: { local: { get: async () => ({ opts: { format, filename: 'shot' } }) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  const context = {
    chrome, console: { ...console, error: () => {} }, URL, btoa, Date,
    setTimeout: (fn) => fn(), // nothing on this path needs a real wait
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: 100, height: 100 }),
    fetch: async () => ({ blob: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(read('background.js'), context);
  await onCommand(command);
  await settle(); // the listener doesn't return the capture, so let it finish
  return downloads;
}

for (const format of ['webm', 'gif']) {
  test(`a screenshot shortcut with ${format} selected downloads a PNG named .png`, async () => {
    const downloads = await pressShortcut('capture-visible', format);
    assert.strictEqual(downloads.length, 1, 'the shortcut should still take the screenshot');
    assert.match(downloads[0].url, /^data:image\/png;/);
    assert.strictEqual(downloads[0].filename, 'shot.png', `the PNG was requested as ${downloads[0].filename}`);
  });
}

test('a shortcut with an image format selected still downloads that format', async () => {
  for (const [format, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const [download] = await pressShortcut('capture-visible', format);
    assert.ok(download.url.startsWith(`data:${mime};`), `${format} was not encoded as ${mime}`);
    assert.strictEqual(download.filename, `shot.${format}`);
  }
});
```

Both files were tried on a copy of the repo in `/tmp`:

- **Before the `encode()` change:** the webm and gif tests fail (`'shot.webm'` and `'shot.gif'` where `'shot.png'` was expected), and the image-format test passes.
- **After the change:** all 3 tests pass, and `npm test` passes all 110.
- **In headless Chrome 152:** the changed `background.js` saved `kan212.png` for `gif` and `webm`, and `kan212.jpg` for `jpg`. These are the same files the current code produces there.

## Steps

1. Add `tests/shortcut-format.test.js` with the contents above.
   → verify: `node --test tests/shortcut-format.test.js` fails the webm and gif tests, reporting `'shot.webm'` and `'shot.gif'`, and passes the image-format test.
2. Change `encode()` in `background.js` as shown above.
   → verify: `node --test tests/shortcut-format.test.js` passes all 3 tests.
3. Check the change in real Chrome.
   → verify: in headless Chrome 152, using a temporary copy of the extension whose manifest adds `"host_permissions": ["<all_urls>"]` so a capture can run without a click:
   - **Launch:** start `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` with `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging` and a temporary `--user-data-dir`. Branded Chrome no longer accepts `--load-extension`, so load the copy with the CDP command `Extensions.loadUnpacked`.
   - **Downloads:** before launching, set the download folder in the profile's `Default/Preferences` (`download.default_directory`). Don't use CDP's `Browser.setDownloadBehavior`: it renames every download to `download.<ext>`, which hides the name being checked.
   - **Capture:** open a page served by `python3 -m http.server`, then attach to the extension's service worker. There, store `{ format: 'gif', filename: 'kan212' }` as `opts` and run `await runCapture('visible', await getOpts())`, which is the same call the Alt+Shift+V listener makes (`background.js:20`).
   - **Expected result:**
     - The download folder gets `kan212.png`, whose first bytes are `89 50 4E 47`.
     - With `jpg` stored instead, it gets `kan212.jpg`, whose first bytes are `FF D8 FF`.
     - Nothing lands in `~/Downloads`.
4. Check that nothing else changed.
   → verify:
   - `git status --short` lists only `background.js`, `tests/shortcut-format.test.js` and this plan in `docs/`.
   - `npm test` passes all 110 tests: the current 107 plus the 3 new ones.

## Open questions

1. **Is the fix still wanted?** Chrome 152 already saves these screenshots as `.png` (see above), so the symptom the ticket describes doesn't show up in this Chrome.
   - The code still asks for `shot-<date>-<time>.gif`, and the file only gets the right name because Chrome renames it.
   - The change is small and makes the requested name match the data, so the recommendation is to do it anyway.
   - The alternative is to close KAN-212 as not reproducible in Chrome 152.
2. **Version bump.** `background.js` ships with the extension. Should the version go from 0.3.2 to 0.3.3 in `manifest.json:4` and `package.json:3`? The ticket doesn't say, and past fixes differ: d076bef and 380fb7b bumped it, but 7d0a487 and 1f71c31, which also changed `background.js`, didn't.
