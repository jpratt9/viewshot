# KAN-221: Record tab audio

Ticket: https://prattsolutions.atlassian.net/browse/KAN-221. It is a To Do Story labelled `viewshot`, with no comments and no links.

## What the repo does now

As of `ec15a6e`:

- **The offscreen document asks for video only.** `startRecording` calls `getUserMedia({ video: { mandatory } })` (`offscreen.js:75`). The ticket's `offscreen.js:44` is where that call used to be. The tab's sound is never captured, so a WebM of a tab playing sound is silent.
- **Nothing plays captured audio back out.** There is no `AudioContext` anywhere in the repo. A recording's tracks stop in `stopRecording` once the file is saved (`offscreen.js:230-234`) and in `teardown` when it fails (`offscreen.js:317-322`).
- **The MIME types name only video codecs.** `pickMime` tries `video/webm;codecs=vp9`, then `vp8`, then plain `video/webm` (`offscreen.js:243-248`).
- **The worker passes the recording settings through.**
  - Both kinds of start end in `startRecording(streamId, opts, tabId)` (`background.js:864`):
    - a popup start takes `msg.opts`, which is the popup's `read()` (`background.js:12-23`);
    - a shortcut start takes `getOpts()`, which is `DEFAULTS` merged with the stored `opts` (`background.js:79`, `background.js:137-142`).
  - `rec-start-offscreen` carries `streamId`, `format`, `width`, `height` and `cssPx` (`background.js:906-909`). The offscreen handler passes those to `startRecording` (`offscreen.js:26`).
- **Settings are defined twice and must match.**
  - `DEFAULTS` is declared in `background.js:1` and again in `popup.js:1`. `tests/defaults.test.js:109-111` checks the two are identical.
  - In the popup:
    - `apply()` fills the form (`popup.js:27-38`) and `read()` reads it (`popup.js:72-80`).
    - Every setting saves on `change` (`popup.js:197-203`).
    - `toggleQuality` shows the Quality row for JPG and WebP only (`popup.js:89-90`).
  - The rows are in `popup.html:16-48`. Checkbox rows use the existing `.row.check` style (`popup.css:35-36`).
- **The offscreen document is created with the `CLIPBOARD` and `USER_MEDIA` reasons** (`background.js:733-737`). The manifest already has `tabCapture` and `offscreen`.
- **The README describes recording and permissions:** recording at `README.md:8`, and `tabCapture` as "get the tab's video for recording" at `README.md:26`.
- **Tests:** `npm test` runs 346 tests, and all pass.
  - Some fixtures list every setting, and their tests compare the saved or sent settings with them as a whole. These fail as soon as `read()` returns a new key:
    - `tests/defaults.test.js:256` (4 tests);
    - `tests/defaults.test.js:293` (20 tests);
    - `tests/capture-errors.test.js:1184` (2 tests).
  - `loadOffscreen` (`tests/capture-errors.test.js:506-564`) has no `AudioContext`.

## Change

Seven files change: four code files, the README and two test files.

1. **`popup.html`:** add a "Record tab audio" checkbox row straight after the Quality row (`popup.html:33`).

   ```diff
   @@ -32,6 +32,11 @@
          <span id="qualityVal" class="val"></span>
        </label>

   +    <label class="row check" id="audioRow">
   +      <input type="checkbox" id="audio" />
   +      <span>Record tab audio</span>
   +    </label>
   +
        <label class="row">
          <span>Name</span>
          <input type="text" id="filename" placeholder="shot-{date}-{time}" />
   ```

2. **`popup.js`:**
   - Add `audio: false` to `DEFAULTS` (`:1`).
   - Fill the checkbox in `apply()` (`:35`) and read it in `read()` (`:78`).
   - Save it on `change` like the other settings (`:197`).
   - Show its row only for WebM (`toggleAudio`, next to `toggleQuality` at `:90`), both when the form is filled and when the format changes (`:36`, `:200`).

   ```diff
   @@ -1 +1 @@
   -const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
   +const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true, audio: false };
   @@ -33,7 +33,9 @@
      if (!edited.has('filename')) $('filename').value = o.filename;
      if (!edited.has('toClipboard')) $('toClipboard').checked = o.toClipboard;
      if (!edited.has('hideScrollbar')) $('hideScrollbar').checked = o.hideScrollbar;
   +  if (!edited.has('audio')) $('audio').checked = o.audio;
      toggleQuality();
   +  toggleAudio();
      toggleRec();
    }
   @@ -76,6 +78,7 @@
        filename: $('filename').value.trim() || 'shot-{date}-{time}',
        toClipboard: $('toClipboard').checked,
        hideScrollbar: $('hideScrollbar').checked,
   +    audio: $('audio').checked,
      };
    }
   @@ -88,6 +91,8 @@
    // Quality slider only applies to the still image formats jpg/webp.
    const toggleQuality = () => { $('qualityRow').style.display = (['jpg', 'webp'].includes($('format').value)) ? 'flex' : 'none'; };
   +// Tab audio is recorded into WebM only (KAN-221).
   +const toggleAudio = () => { $('audioRow').style.display = $('format').value === 'webm' ? 'flex' : 'none'; };
   @@ -194,10 +199,10 @@
   -for (const id of ['format', 'quality', 'filename', 'toClipboard', 'hideScrollbar']) {
   +for (const id of ['format', 'quality', 'filename', 'toClipboard', 'hideScrollbar', 'audio']) {
      $(id).addEventListener('change', () => {
        if (!ready) edited.add(id);
   -    if (id === 'format') { toggleQuality(); toggleRec(); }
   +    if (id === 'format') { toggleQuality(); toggleAudio(); toggleRec(); }
        return save();
      });
    }
   ```

3. **`background.js`:** add the same `audio: false` to `DEFAULTS` (`:1`), and pass the setting to the offscreen document with the start (`:907`). The popup and the shortcut both reach this line, so Alt+Shift+S records audio whenever the saved setting is on.

   ```diff
   @@ -1 +1 @@
   -const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true };
   +const DEFAULTS = { format: 'jpg', quality: 0.92, filename: 'shot-{date}-{time}', toClipboard: false, hideScrollbar: true, audio: false };
   @@ -905,7 +905,7 @@
      if (!(await getRec())) { console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
      await chrome.runtime.sendMessage({
   -    type: 'rec-start-offscreen', streamId, format: opts.format,
   +    type: 'rec-start-offscreen', streamId, format: opts.format, audio: opts.audio,
        width: dims?.width, height: dims?.height, cssPx: dims?.cssPx,
      });
   ```

4. **`offscreen.js`:**
   - The handler passes `msg.audio` on (`:26`).
   - For WebM with audio on, `startRecording` also asks for the tab's audio, using the same stream id in the same legacy `mandatory` form as the video (`:70-75`).
   - It plays that audio back out through an `AudioContext` for as long as it is captured (`:88`).
   - The context is closed when the tracks stop: after the file is saved (`:230-234`) and in `teardown` (`:317-322`).

   ```diff
   @@ -26 +26 @@
   -  else if (msg?.type === 'rec-start-offscreen') { log('rec-start-offscreen, format=', msg.format, 'dims=', msg.width, 'x', msg.height, msg.cssPx ? '(css px)' : ''); startRecording(msg.streamId, msg.format, msg.width, msg.height, msg.cssPx).catch(onRecError); }
   +  else if (msg?.type === 'rec-start-offscreen') { log('rec-start-offscreen, format=', msg.format, 'dims=', msg.width, 'x', msg.height, msg.cssPx ? '(css px)' : '', 'audio=', !!msg.audio); startRecording(msg.streamId, msg.format, msg.width, msg.height, msg.cssPx, msg.audio).catch(onRecError); }
   @@ -44 +44 @@
   -let rec = null; // { stream, format, recorder?, chunks?, gif?, timer?, frames? }
   +let rec = null; // { stream, format, playback?, recorder?, chunks?, gif?, timer?, frames? }
   @@ -48 +48 @@
   -async function startRecording(streamId, format, width, height, cssPx) {
   +async function startRecording(streamId, format, width, height, cssPx, audio) {
   @@ -70,9 +70,13 @@
      log('requesting getUserMedia for streamId', streamId, 'mandatory=', mandatory);
   +  const constraints = { video: { mandatory } };
   +  // The tab's sound as well, when "Record tab audio" is on: WebM only (KAN-221).
   +  // It is redeemed from the same stream id, in the same legacy form.
   +  if (audio && format === 'webm') constraints.audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
      const start = { stopped: false };
      lastStart = start;
      let stream;
      try {
   -    stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory } });
   +    stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
   @@ -88,4 +92,10 @@
      rec = { stream, format };
   +  // Chrome stops playing a tab's sound to the user once it is captured. Play
   +  // it back out from here for as long as it is.
   +  if (constraints.audio) {
   +    rec.playback = new AudioContext();
   +    rec.playback.createMediaStreamSource(stream).connect(rec.playback.destination);
   +  }
      // Chrome's own "Stop sharing" bar (and closing the captured tab) ends the
   @@ -230,5 +240,6 @@
   -    const { recorder, chunks, stopped, startedAt } = rec;
   +    const { recorder, chunks, stopped, startedAt, playback } = rec;
        stopped.then(async (stoppedAt) => {
          download(format === 'webm' ? await withDuration(chunks, stoppedAt - startedAt) : new Blob(chunks, { type: `video/${format}` }), filename);
          stream.getTracks().forEach((t) => t.stop());
   +      playback?.close(); // the tab plays its own sound again once its tracks stop
        });
   @@ -317,6 +328,7 @@
    function teardown() {
      if (!rec) return;
      if (rec.timer) clearInterval(rec.timer);
      try { rec.stream.getTracks().forEach((t) => t.stop()); } catch {}
   +  rec.playback?.close();
      rec = null;
    }
   ```

5. **`README.md`:** add the option to Features after `:8`, and mention the audio in the `tabCapture` line (`:26`).

   ```diff
   @@ -8,6 +8,7 @@
    - Tab recording to WebM, MP4 or GIF — choose one as the format, then **Record** and **Stop recording** (GIFs are 10 fps, up to 720px wide, and stop by themselves after about a minute)
   +- **Record tab audio** adds the tab's sound to WebM recordings (off by default), and the tab keeps playing it to you while it records
    - Filename templates — `{date} {time} {domain} {title}`
   @@ -26 +27 @@
   -- `tabCapture` — get the tab's video for recording
   +- `tabCapture` — get the tab's video, and its audio when **Record tab audio** is on, for recording
   ```

6. **`tests/defaults.test.js`:**
   - `:256`: add `audio: true` to `stored`. After `:271`, add `assert.strictEqual(popup.els.audio.checked, stored.audio);`.
   - `:291`: add `audio: true` to the settings each test edits. This adds 4 generated tests, in which the checkbox is changed while the popup is still opening.
   - `:293`: add `audio: false` to `stored`.
   - After `:172`, add a new test next to the Quality row ones:

   ```js
   test('the audio row shows only for WebM, and follows the format', async () => {
     for (const [format, display] of [['webm', 'flex'], ['mp4', 'none'], ['gif', 'none'], ['jpg', 'none']]) {
       const popup = await loadPopup({ opts: { format } });
       assert.strictEqual(popup.els.audioRow.style.display, display, format);
     }
     const popup = await loadPopup({ opts: { format: 'png' } });
     popup.els.format.value = 'webm';
     await popup.els.format.listeners.change[0]();
     assert.strictEqual(popup.els.audioRow.style.display, 'flex', 'choosing WebM did not show the audio row');
   });
   ```

7. **`tests/capture-errors.test.js`:**
   - `:1184`: add `audio: true` to `opts`. The WebM run of "capture waits for reconciled settings" then also checks that the saved setting reaches `rec-start`.
   - `loadOffscreen` gets a fake `AudioContext` (after `:520`, and in the context at `:537`). It returns the contexts as `players` and the stream as `stream` (`:560`).

     ```js
     const players = []; // what a start with audio plays the tab's sound back out through
     class FakeAudioContext {
       constructor() { this.destination = {}; this.closed = false; players.push(this); }
       createMediaStreamSource(from) { return { connect: (to) => { this.source = { from, to }; } }; }
       close() { this.closed = true; return Promise.resolve(); }
     }
     ```

   - A new "tab audio (KAN-221)" section at the end of the file (after `:2118`) adds 7 tests. They use `const AUDIO_START = { type: 'rec-start-offscreen', streamId: 'sid', format: 'webm', width: 100, height: 100, audio: true }`.
     1. **"a WebM recording with audio on asks for the tab's audio and plays it back out".** After `AUDIO_START`:
        - `o.asked[0].audio` (JSON round-tripped) is `{ mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'sid' } }`;
        - one player exists, its source is `o.stream`, and it is connected to that player's `destination`.
     2. **"stopping a WebM recording with audio lets go of the tab's audio once the file is saved".**
        - After `stopRecording`, the player is still open until the recorder's final flush.
        - After `finish()`, the file is downloaded and the player is closed.
     3. **"a WebM recording with audio off asks for video only".** `startRecording('sid', 'webm', 100, 100)` asks for no `audio` and opens no player.
     4. **"a mp4 recording asks for video only, even with audio on"** and the same for gif (one loop, 2 tests). They start with `{ ...AUDIO_START, format }`, then check that no `audio` was asked for and no player was opened.
     5. **"a failed WebM recording with audio lets go of the tab's audio".** `recorders[0].fail(error)` closes the player, and `o.sent` is `['rec-failed']`.
     6. **"the worker hands the audio setting to the offscreen document".** `recStart(bg)` is followed by `startRecording('sid', { ...OPTS, format: 'webm', audio: true }, TAB.id)`, and the `rec-start-offscreen` sent has `audio: true`.

Choices:

- **WebM only**, as the ticket says. The ticket was written before MP4 was added (KAN-222), and that change left audio to this ticket ("No audio (KAN-221)" in `33eead2`). GIF has no sound. See open question 1.
- **Off by default.** The ticket asks for "an option to include" the audio, so recordings stay as they are unless it is turned on. See open question 2.
- **The row shows only when WebM is selected,** in the same way as the Quality row, which shows only for JPG and WebP. It sits right under Quality, so each format's settings appear under Format. No CSS changes: `.row.check` already styles checkbox rows.
- **The offscreen document decides whether to capture audio.** It already decides everything that depends on the format (the GIF path and `pickMime`). The worker passes on the saved setting unchanged. A setting left on from WebM therefore does nothing to MP4 or GIF recordings.
- **Audio is requested the way Chrome's tabCapture docs do it in an offscreen document:** the same stream id, and a `mandatory` block for `audio` beside the one for `video`. Playback goes `AudioContext` → `createMediaStreamSource(stream)` → `destination`, also as in Chrome's docs.
  - The context closes in the same step that stops the tracks, so there is no gap in which the tab is captured but silent.
  - It closes after the final flush, so the sound keeps playing until the recording really ends.
- **`pickMime` stays as it is.** When the MIME type names only a video codec, Chrome's `MediaRecorder` encodes the audio track as Opus in WebM. Step 4 checks with `ffprobe` that the saved file has that Opus stream.
- **No manifest change and no new offscreen reason.** `tabCapture` already covers the tab's audio. `USER_MEDIA` covers `getUserMedia` and the playback; Chrome's own tab-recorder sample uses only that reason. `AUDIO_PLAYBACK` is not used: those documents close by themselves after 30 s without sound (`background.js:755-757`), which would kill a recording.
- **`rec` in storage doesn't change.** The setting is only needed when the recording starts.
- **No version bump**, as with the recent changes.

## Steps

1. Make the test changes above in `tests/defaults.test.js` and `tests/capture-errors.test.js`.
   → verify: `npm test` runs 358 tests. 323 pass and 35 fail:
   - **In `tests/defaults.test.js`:**
     - "unfinished startup edits survive reconciliation" ×4;
     - "startup preserves untouched settings" ×24;
     - "the audio row shows only for WebM, and follows the format".
   - **In `tests/capture-errors.test.js`:**
     - "capture waits for reconciled settings: webp" and "…: webm";
     - new tests 1, 2, 5 and 6.

   New tests 3 and 4 pass already: they pin what doesn't change.
2. Make the code changes above in `popup.html`, `popup.js`, `background.js` and `offscreen.js`.
   → verify: `npm test` passes all 358 tests.
3. Make the `README.md` changes above.
   → verify: `npm test` still passes all 358 tests. `README.md` has the new Features line after the recording line, and the new `tabCapture` line.
4. Check the change in Chrome itself, not headless: hearing the tab is part of the check.
   - **Setup:** load the repo unpacked. Serve a local http page that plays a steady tone. For example, make a looping `<audio src="tone.wav" controls loop>` from `ffmpeg -f lavfi -i sine=frequency=440:duration=60 tone.wav`, and press play.

   → verify:
   - **WebM with "Record tab audio" on:**
     - The tone keeps playing while it records.
     - Stop saves a `.webm`. `ffprobe -v error -show_entries stream=codec_type,codec_name:format=duration -of compact <file>` lists a `vp9` video stream, an `opus` audio stream and a duration. Playing the file back plays the tone.
     - After Stop, the tab keeps playing the tone.
   - **Alt+Shift+S** with the same settings: the same result.
   - **Chrome's "Stop sharing" bar** during an audio recording saves the file with its audio, and the tone keeps playing.
   - **WebM with the option off:** the file has only the video stream, as now, and the tone never cuts out.
   - **MP4 or GIF selected:** the row is hidden. The MP4 has no audio stream, and the GIF saves as before.
5. Check that nothing else changed.
   → verify: `git status --short` lists only the seven files above and this plan.

## Noticed while planning, not changed

- **The ticket's line reference is out of date.** It says the video-only request is at `offscreen.js:44`; it is at `offscreen.js:75` now.

## Open questions — settled

Both were settled on what the ticket and the repo say. Neither changes the code that shipped.

1. **Should MP4 get the option too?** Not in this change. The ticket asks for WebM, and it was written before MP4 was added. MP4 is filed as **KAN-544**, which is blocked by KAN-221.
   - For MP4 as well: the row would show for MP4, and the check in `offscreen.js` would become `format !== 'gif'`.
   - `pickMime` would also have to name an audio codec QuickTime plays, `video/mp4;codecs=avc1,mp4a.40.2` (AAC). That would need its own check in Chrome.
2. **On or off by default?** Off, as shipped (`audio: false` in both `DEFAULTS`):
   - The ticket asks for "an option to include the tab's audio", which is something a user turns on.
   - Recordings have always been video only, and settings saved before the option existed keep recording that way.
   - Alt+Shift+S records from the saved settings without opening the popup. On by default would start capturing the tab's sound, and playing it back through the offscreen document, for shortcut users who have never seen the checkbox.

## Added when shipping

- **Three more tests** in `tests/shortcut-format.test.js`: "recording shortcut sends audio … when the saved settings have …".
  - They cover Alt+Shift+S, which step 4 couldn't press. The shortcut reads the saved settings through `getOpts()`, not the popup's form.
  - The three cases are: saved `audio: true`, saved `audio: false`, and saved settings from before the option existed, which fall back to `DEFAULTS` and get no audio.
  - `recordingBrowser` takes the saved settings as a third argument.
  - All three pass with this change, and all three fail with the `background.js` it replaces.
- **Open question 1 is now KAN-544** ("MP4 recordings can't include the tab's audio"), which is blocked by this ticket. The option ships off. Both questions are settled above.
- **Step 4 wasn't fully run.** It ran in headed Chrome 153.0.8010.48, and every case it covered came out as expected. It didn't cover:
  - listening to the tab;
  - Alt+Shift+S (covered by the tests above instead);
  - Chrome's "Stop sharing" bar, which was replaced by closing the captured tab, the same `ended` path.
- `npm test` passes all 361.
