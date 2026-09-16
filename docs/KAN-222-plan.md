# KAN-222: Add MP4 as a recording format

Ticket: https://prattsolutions.atlassian.net/browse/KAN-222. It is a To Do Story labelled `viewshot`, with no comments and no links.

## What the repo does now

As of `14b118f`:

- **The popup offers two recording formats.** The format list has WebM and GIF, each labelled "(record)" (`popup.html:23-24`).
  - `isRecFmt` (`popup.js:3`) decides which formats record.
  - `toggleRec` (`popup.js:80-86`) uses it to turn Visible into Record and to disable Full page and Region.
  - The click handler uses it to start a recording instead of a screenshot (`popup.js:96`).
- **The worker passes the format through.**
  - `startRecording` stores `opts.format` in `rec` (`background.js:373`) and sends it to the offscreen document (`background.js:391`).
  - `stopRecording` passes the format to `buildName` as the file extension (`background.js:454`).
- **The offscreen document records everything except GIF as WebM.**
  - `format === 'gif'` takes the GIF path (`offscreen.js:54`). Every other format goes to `MediaRecorder` (`offscreen.js:95-115`).
  - The MIME type comes from `pickWebmMime()` (`offscreen.js:102`), which picks the first supported of VP9, VP8 and plain WebM (`offscreen.js:147-150`).
  - The finished file is always saved as a `video/webm` Blob (`offscreen.js:138`).
- **Screenshot shortcuts already handle any recording format.** For any format other than png, jpg or webp, `encode` saves a PNG named `.png` (`background.js:96-101`). `tests/shortcut-format.test.js:56-63` checks this for WebM and GIF.
- **The docs only mention WebM and GIF.** `README.md:8` says "Tab recording to WebM or GIF". The manifest description says "record to WebM/GIF" (`manifest.json:5`, 120 characters).
- **Tests that depend on the format list:**
  - "the README mentions recording to every format the popup records to" (`tests/readme.test.js:17-24`) reads the "(record)" options from `popup.html`. It requires a README line that names each one.
  - The manifest description must be at most 132 characters and must mention recording (`tests/manifest.test.js:15-24`).
  - "the default format is a still format the UI offers, never a recording one" lists the recording formats as `['webm', 'gif']` (`tests/defaults.test.js:120`).
  - The offscreen harness, `loadOffscreen` (`tests/capture-errors.test.js:352-390`), doesn't keep the MIME type a `MediaRecorder` was created with (`:356`) or the type of the saved `Blob` (`:376`).
  - `tests/` defines 128 tests, 23 of them in `tests/capture-errors.test.js`.

## Change

Nine files change: four code files, the README, the manifest and three test files.

1. **`popup.html`:** add MP4 to the list of recording formats.

   ```diff
   @@ -21,6 +21,7 @@
            <option value="jpg">JPG</option>
            <option value="webp">WebP</option>
            <option value="webm">WebM (record)</option>
   +        <option value="mp4">MP4 (record)</option>
            <option value="gif">GIF (record)</option>
          </select>
        </label>
   ```

2. **`popup.js`:** make `isRecFmt` count MP4 as a recording format. Record, the disabled Full page and Region buttons, and starting the recording all follow from this.

   ```diff
   @@ -1,6 +1,6 @@
    const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
    const $ = (id) => document.getElementById(id);
   -const isRecFmt = (f) => f === 'webm' || f === 'gif';
   +const isRecFmt = (f) => f === 'webm' || f === 'mp4' || f === 'gif';
    let activeTab = null;

    const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };
   ```

3. **`offscreen.js`:** `pickWebmMime()` becomes `pickMime(format)`, which tries H.264 first for MP4. The saved Blob's type comes from the format.

   ```diff
   @@ -99,7 +99,7 @@
        // dropped the last second of every recording on the floor.
        const chunks = [];
        rec.chunks = chunks;
   -    const mime = pickWebmMime();
   +    const mime = pickMime(format);
        log('starting MediaRecorder, mime=', mime);
        rec.recorder = new MediaRecorder(stream, { mimeType: mime });
        rec.recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
   @@ -135,7 +135,7 @@
        // completes — track-stopping waits for `stop` too.
        const { recorder, chunks, stopped } = rec;
        stopped.then(() => {
   -      download(new Blob(chunks, { type: 'video/webm' }), filename);
   +      download(new Blob(chunks, { type: `video/${format}` }), filename);
          stream.getTracks().forEach((t) => t.stop());
        });
        // Already inactive if the track ended first: there is nothing left to stop.
   @@ -144,9 +144,13 @@
      }
    }

   -function pickWebmMime() {
   -  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
   -  return types.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
   +// MP4 is there for QuickTime Player, which can't open WebM, so it names H.264
   +// (avc1), the codec QuickTime plays.
   +function pickMime(format) {
   +  const types = format === 'mp4'
   +    ? ['video/mp4;codecs=avc1', 'video/mp4']
   +    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
   +  return types.find((t) => MediaRecorder.isTypeSupported(t)) || `video/${format}`;
    }

    function download(blob, filename) {
   ```

4. **`background.js`:** only comments change. Two of them list the recording formats.

   ```diff
   @@ -96,8 +96,8 @@
    async function encode(pngDataUrl, opts) {
      const mimes = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
      // The shortcuts pass the stored format as-is, and the popup can leave that
   -  // on webm or gif. Those still get a PNG, so name the file .png as well
   -  // rather than asking for PNG data to be saved as .webm or .gif.
   +  // on webm, mp4 or gif. Those still get a PNG, so name the file .png as well
   +  // rather than asking for PNG data to be saved as .webm, .mp4 or .gif.
      const ext = mimes[opts.format] ? opts.format : 'png';
      const mime = mimes[ext];
      const bmp = await createImageBitmap(await (await fetch(pngDataUrl)).blob());
   @@ -353,7 +353,7 @@
      }
    }

   -// ---- record the visible tab to WebM/GIF via the offscreen document ----
   +// ---- record the visible tab to WebM/MP4/GIF via the offscreen document ----
    const log = (...a) => console.log('[ViewShot]', ...a);

    async function flashBadge(text) {
   ```

5. **`README.md` and `manifest.json`:** add MP4 to the list of recording formats in both.

   ```diff
   --- a/README.md
   +++ b/README.md
   @@ -5,7 +5,7 @@
    ## Features
    - One-click capture: visible area · full page (scroll-stitch, sticky-header aware) · region select
    - PNG / JPG / WebP, with a quality slider
   -- Tab recording to WebM or GIF — choose one as the format, then **Record** and **Stop recording** (GIFs are 10 fps, up to 720px wide, and stop by themselves after about a minute)
   +- Tab recording to WebM, MP4 or GIF — choose one as the format, then **Record** and **Stop recording** (GIFs are 10 fps, up to 720px wide, and stop by themselves after about a minute)
    - Filename templates — `{date} {time} {domain} {title}`
    - Download or copy straight to clipboard
    - **Hide scrollbar before capturing** keeps the scrollbar out of screenshots (on by default)
   --- a/manifest.json
   +++ b/manifest.json
   @@ -2,7 +2,7 @@
      "manifest_version": 3,
      "name": "ViewShot",
      "version": "0.3.2",
   -  "description": "One-click screenshots: visible area, full page, or region. PNG/JPG/WebP, or record to WebM/GIF. 100% local, no tracking.",
   +  "description": "One-click screenshots: visible area, full page, or region. PNG/JPG/WebP, or record to WebM/MP4/GIF. 100% local, no tracking.",
      "permissions": ["activeTab", "downloads", "scripting", "storage", "offscreen", "tabCapture"],
      "action": {
        "default_popup": "popup.html",
   ```

6. **`tests/capture-errors.test.js`:**
   - `loadOffscreen`'s fake `MediaRecorder` now keeps its `mimeType`, and its fake `Blob` keeps its `type`.
   - A new "MP4 recordings" section at the end of the file adds three tests:
     1. Record with MP4 selected sends `rec-start` with `format: 'mp4'`.
     2. An MP4 recording asks for `video/mp4;codecs=avc1` and is saved as `video/mp4`, with the name it was given.
     3. A WebM recording still asks for `video/webm;codecs=vp9` and is saved as `video/webm`.

   ```diff
   @@ -353,7 +353,7 @@
      const recorders = [];
      const downloads = [];
      class FakeRecorder {
   -    constructor() { this.state = 'recording'; recorders.push(this); }
   +    constructor(stream, { mimeType } = {}) { this.mimeType = mimeType; this.state = 'recording'; recorders.push(this); }
        start() {}
        // Mirrors the real ordering: a final dataavailable, then onstop, both async.
        stop() { this.state = 'inactive'; }
   @@ -373,7 +373,7 @@
        },
        navigator: { mediaDevices: { getUserMedia: async () => stream } },
        MediaRecorder: FakeRecorder,
   -    Blob: class { constructor(parts) { this.parts = parts; this.size = parts.length; } },
   +    Blob: class { constructor(parts, { type } = {}) { this.parts = parts; this.size = parts.length; this.type = type; } },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        document: {
          createElement: () => ({ style: {}, click() {}, remove() {}, appendChild() {} }),
   @@ -457,3 +457,42 @@
      assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
      assert.strictEqual(o.downloads[0][0].parts.length, 2, 'the saved recording is missing its final chunk');
    });
   +
   +// --- MP4 recordings ----------------------------------------------------------
   +// QuickTime Player can't open WebM, so MP4 is offered as a third recording
   +// format. It names H.264 for MediaRecorder, and the rest of the path - chunks,
   +// stop, save - is the one WebM already takes.
   +
   +test('Record with MP4 selected starts an MP4 recording', async () => {
   +  const p = loadPopup('https://a.com/x');
   +  await p.ready();
   +  p.els.format.value = 'mp4'; // turns Visible into Record
   +  await p.click('visible');
   +  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start'], 'MP4 was taken for a screenshot format');
   +  assert.strictEqual(p.sent[0].opts.format, 'mp4');
   +});
   +
   +test('an MP4 recording asks for H.264 and is saved as video/mp4', async () => {
   +  const o = loadOffscreen();
   +  await o.ctx.startRecording('sid', 'mp4', 100, 100);
   +  const r = o.recorders[0];
   +  assert.strictEqual(r.mimeType, 'video/mp4;codecs=avc1');
   +  r.flush({ size: 10 });
   +  o.ctx.stopRecording('out.mp4');
   +  r.finish();
   +  await settle();
   +  assert.strictEqual(o.downloads.length, 1, 'the recording was never saved');
   +  assert.strictEqual(o.downloads[0][0].type, 'video/mp4');
   +  assert.strictEqual(o.downloads[0][1], 'out.mp4');
   +});
   +
   +test('a WebM recording still asks for VP9 and is saved as video/webm', async () => {
   +  const o = loadOffscreen();
   +  await o.ctx.startRecording('sid', 'webm', 100, 100);
   +  assert.strictEqual(o.recorders[0].mimeType, 'video/webm;codecs=vp9');
   +  o.recorders[0].flush({ size: 10 });
   +  o.ctx.stopRecording('out.webm');
   +  o.recorders[0].finish();
   +  await settle();
   +  assert.strictEqual(o.downloads[0][0].type, 'video/webm');
   +});
   ```

7. **`tests/shortcut-format.test.js` and `tests/defaults.test.js`:** add `mp4` to their lists of recording formats. With this change, the shortcut test also checks that a screenshot shortcut with MP4 selected still saves a PNG named `.png`.

   ```diff
   --- a/tests/shortcut-format.test.js
   +++ b/tests/shortcut-format.test.js
   @@ -8,7 +8,7 @@
    const settle = () => new Promise((r) => setImmediate(r));

    // --- screenshot shortcuts with a recording format selected --------------
   -// The popup never takes a screenshot in WebM or GIF: it turns Visible into
   +// The popup never takes a screenshot in WebM, MP4 or GIF: it turns Visible into
    // Record and disables the other two modes. The shortcuts read the same
    // stored format with no such check, and encode() fell back to PNG data but
    // still named the file after the format, so Alt+Shift+V asked for a PNG to
   @@ -53,7 +53,7 @@
      return downloads;
    }

   -for (const format of ['webm', 'gif']) {
   +for (const format of ['webm', 'mp4', 'gif']) {
      test(`a screenshot shortcut with ${format} selected downloads a PNG named .png`, async () => {
        const downloads = await pressShortcut('capture-visible', format);
        assert.strictEqual(downloads.length, 1, 'the shortcut should still take the screenshot');
   --- a/tests/defaults.test.js
   +++ b/tests/defaults.test.js
   @@ -117,7 +117,7 @@
      const still = stillFormatsFromMarkup();
      assert.ok(still.includes(bg.DEFAULTS.format),
        `DEFAULTS.format ${bg.DEFAULTS.format} is not one of ${still.join(', ')}`);
   -  assert.ok(!['webm', 'gif'].includes(bg.DEFAULTS.format),
   +  assert.ok(!['webm', 'mp4', 'gif'].includes(bg.DEFAULTS.format),
        'a recording format as the default would make the keyboard shortcuts write image bytes into a video file');
    });
   ```

Choices:

- **Put MP4 between WebM and GIF** in the list, next to the other video format.
- **Ask for H.264 (`avc1`) first.** MP4 is being added so QuickTime Player can open recordings, and QuickTime plays H.264. Plain `video/mp4` is the fallback, in the same way plain `video/webm` is for WebM.
- **Use one picker for both video formats.** `pickMime(format)` replaces `pickWebmMime()`. The Blob type is `video/webm` or `video/mp4`, taken from the format. WebM and MP4 already share the rest of the recording path (chunks, stop, handling a closed tab, download), so that stays as it is.
- **No filename or shortcut changes.**
  - `buildName` already uses the format as the file extension.
  - `encode` already saves any recording format as a PNG when a screenshot shortcut is used. The shortcut test now checks MP4 as well.
- **Update the README and the manifest description to mention MP4.**
  - The README test requires the README change.
  - The manifest change keeps the store listing accurate. The new description is 124 characters, within the 132 limit.
- **Update the comments that list the recording formats:** `background.js:99-100`, `background.js:356` and the shortcut test's banner.
- **Put the new tests in `tests/capture-errors.test.js`,** which already has the popup and offscreen harnesses (`loadPopup`, `loadOffscreen`). `loadOffscreen`'s fakes now keep the MIME type and the Blob type, so the new tests can check them.
- **Leave the MP4 option visible in Chrome versions that can't record MP4.** There, `new MediaRecorder` throws. The error goes through the existing error path: `onRecError` cleans up and reports `rec-failed` (`offscreen.js:171-175`), and the worker shows `!` (`background.js:15`). The ticket doesn't ask to hide the option.
- **No audio.** The offscreen document only requests video (`offscreen.js:44`). Adding audio is KAN-221.
- **No version bump**, as with the recent changes.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **No changes:** `npm test` passes all 128 tests.
  - **Test changes only:** `tests/capture-errors.test.js` runs 26 tests. Two fail: "Record with MP4 selected starts an MP4 recording" and "an MP4 recording asks for H.264 and is saved as video/mp4". The full suite runs 132 tests, and only those two fail.
  - **Test and code changes, with the README and manifest unchanged:** 131 of 132 pass. The one failure is "the README mentions recording to every format the popup records to", with "no line of the README mentions recording to MP4".
  - **Every change:** `npm test` passes all 132 tests.
- **Headless Chrome 152.0.7977.83, with the copy loaded unpacked.** The setup was the one in step 4 below. Recordings were about 3 s long, made on a local http page with a moving box.
  - **Offscreen document:** `MediaRecorder.isTypeSupported` is true for `video/mp4;codecs=avc1` and `video/mp4`, as the ticket says.
  - **MP4 in the popup:** the Visible button reads Record, and Full page and Region are disabled. Record used `video/mp4;codecs=avc1`, the badge showed `REC` and no error appeared. Stop saved a `.mp4` and cleared the badge.
  - **The MP4 files:**
    - `ffprobe` reads them as H.264 Baseline in MP4, 1278×712, lasting about 3.2 s.
    - `avmediainfo`, which uses AVFoundation (as QuickTime Player does), reports "System support for decoding this track: Yes" and "Movie analyzed with 0 error."
  - **WebM and GIF in the same runs:** WebM still saved VP9 at 1278×712 (with no duration, KAN-240). GIF still saved at 720×401.

## Steps

1. Make the test changes above in `tests/capture-errors.test.js`, `tests/shortcut-format.test.js` and `tests/defaults.test.js`.
   → verify: `node --test tests/capture-errors.test.js` runs 26 tests. Only "Record with MP4 selected starts an MP4 recording" and "an MP4 recording asks for H.264 and is saved as video/mp4" fail. `npm test` runs 132 tests, and only the same two fail.
2. Make the code changes above in `popup.html`, `popup.js`, `offscreen.js` and `background.js`.
   → verify: `node --test tests/capture-errors.test.js tests/shortcut-format.test.js` passes all 30 tests. `npm test` fails only "the README mentions recording to every format the popup records to", with "no line of the README mentions recording to MP4".
3. Make the `README.md` and `manifest.json` changes above.
   → verify: `npm test` passes all 132 tests.
4. Check the change in headless Chrome 152 with the repo loaded unpacked, using the setup from step 3 of `docs/KAN-217-plan.md`:
   - **Start Chrome** with `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging` and a temporary `--user-data-dir`. Set `download.default_directory` in that profile's `Default/Preferences`.
   - **Load and open:** load the repo with `Extensions.loadUnpacked`. Open each page with `Target.createTarget({ url, forTab: true })`, then call `Target.activateTarget` on it. Open the popup with `Extensions.triggerAction`.
   - **Warm up:** open and close one popup before recording.
   - **Test page:** use an http page with something moving on it. Put `{domain}` in the Name field.

   → verify:
   - **MP4 in the popup:** the Visible button reads Record, and Full page and Region are disabled. Record shows `REC` and no error. Stop saves a `.mp4` whose name includes the page's domain.
   - **The MP4 file:** `ffprobe` reads it as H.264 in MP4, at the tab's size, with a duration. `avmediainfo` reports "System support for decoding this track: Yes" and "Movie analyzed with 0 error."
   - **Other formats:** WebM and GIF still save a `.webm` and a `.gif`.
5. Check that nothing else changed.
   → verify: `git status --short` lists only the nine files above and this plan.

## Noticed while planning, not changed

- **One MP4 came out at 800×600.**
  - **What happened:** there were three Chrome runs with four MP4 recordings in all. The first recording of the second run was 800×600 rather than 1278×712. That is the size a recording gets when the worker doesn't send the tab's size. The file name had no `{domain}`, so the run couldn't show whether the worker had found the tab.
  - **The rerun:** the next run put `{domain}` in the file names. All three of its MP4 recordings came out at 1278×712, and each name included the domain.
  - **Likely cause:** KAN-249. In headless Chrome, the worker's active-tab lookup sometimes returns no tab, and the recording then isn't sized to the tab. WebM and GIF use the same sizing code, so this isn't specific to MP4.
- **WebM recordings still have no duration.** `ffprobe` reports N/A for them, which is KAN-240. The MP4 files do have a duration.

## Open questions

None. The ticket says what to add, and in headless Chrome 152 the extension records H.264 MP4 that AVFoundation can open.
