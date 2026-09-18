# KAN-240: WebM recordings are saved without a duration

Ticket: https://prattsolutions.atlassian.net/browse/KAN-240 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-208, is Done.

## What the repo does now

Line numbers are from `9880f96`, with a clean working tree.

- **The file is saved exactly as MediaRecorder wrote it.**
  - `stopRecording` waits on `rec.stopped` and then saves `new Blob(chunks, { type: 'video/${format}' })` (`offscreen.js:215-219`).
  - `chunks` is filled by `ondataavailable` (`offscreen.js:175`) from `recorder.start(1000)` (`:183`).
  - Nothing in the repo reads or rewrites the file's header.
- **Nothing records how long a recording ran.**
  - `rec.stopped` resolves with the `stop` event, which no caller reads (`offscreen.js:179`).
  - Nothing notes when the recorder started.
- **The recording can end before `stopRecording` runs.** When the recorded tab closes, the recorder stops by itself. `stopRecording` runs only once the worker's `rec-stop-offscreen` has made the round trip, and by then `rec.stopped` has already resolved (the comment at `offscreen.js:176-178`, from KAN-208).
- **MP4 is not affected.** `docs/KAN-222-plan.md:305` and `:316` record that the MP4 files have a duration and only the WebM files don't. GIFs are encoded by gif.js (`offscreen.js:201-208`).
- **Tests:** `npm test` passes 285 tests.
  - `loadOffscreen` (`tests/capture-errors.test.js:493-549`) fakes MediaRecorder. Its chunks are bare `{ size }` objects (for example `:615`, `:646`) with no `arrayBuffer()`. Its `Blob` keeps what it was given as `parts` (`:524`). Its context has no `Date` of its own.
  - `settle` is one `setImmediate` (`:10`), so anything the save does in microtasks has finished by the time it returns.
  - `loadBg` already fakes the clock with `Date: class extends Date { static now() { return now; } }` (`:91`).

## Change

Two files change: `offscreen.js` and `tests/capture-errors.test.js`.

A WebM's length goes in a `Duration` element in the Segment's `Info`. MediaRecorder streams the file out and never goes back to write one. Chrome's file has a fixed layout, measured in "Checked while planning":

- the EBML header;
- a Segment of unknown size, whose first child is `Info`;
- no SeekHead and no Cues.

All of this is in the first chunk. So an 11-byte `Duration` can be added at the end of `Info`, `Info`'s one-byte size can be raised to match, and nothing else in the file has to move or change. The length is the wall-clock time from the recorder's start to its `stop`. That time is taken where the recorder stops, so a tab-closed recording isn't stretched by the worker's round trip.

1. **`offscreen.js`**
   - **`rec.stopped` resolves with the time the recorder stopped** (`:179`), and the start time is kept on `rec` (after `:183`).
   - **`stopRecording` gives a WebM its duration before saving it** (`:215-217`). MP4 is saved as before.
   - **New `withDuration(chunks, ms)`** after `pickMime` (`:233`). It adds the element and returns the new Blob. Any other layout, or any failure to read the header, saves the file as recorded: a WebM with no duration still plays, and a lost one doesn't.

   ```diff
   @@ -176,10 +176,13 @@
        // Closing the captured tab ends the track, and the recorder stops by itself
        // - final flush, then `stop` - before rec-stop has been to the worker and
        // back. An onstop set in stopRecording() by then never runs, so listen now.
   -    rec.stopped = new Promise((res) => { rec.recorder.onstop = res; });
   +    // It resolves with the time the recorder stopped: the end of the recording,
   +    // however late the worker's Stop arrives after it.
   +    rec.stopped = new Promise((res) => { rec.recorder.onstop = () => res(Date.now()); });
        // Timeslice → periodic dataavailable. Survives an offscreen-doc eviction
        // mid-recording (MV3 may tear it down); without this, a crash loses
        // everything because the only flush is at stop().
        rec.recorder.start(1000);
   +    rec.startedAt = Date.now();
        log('MediaRecorder state:', rec.recorder.state);
   @@ -215,5 +218,5 @@
   -    const { recorder, chunks, stopped } = rec;
   -    stopped.then(() => {
   -      download(new Blob(chunks, { type: `video/${format}` }), filename);
   +    const { recorder, chunks, stopped, startedAt } = rec;
   +    stopped.then(async (stoppedAt) => {
   +      download(format === 'webm' ? await withDuration(chunks, stoppedAt - startedAt) : new Blob(chunks, { type: `video/${format}` }), filename);
          stream.getTracks().forEach((t) => t.stop());
        });
   ```

   ```js
   // MediaRecorder writes a WebM as it goes and never goes back for its length,
   // so a player reports Infinity until it has read to the end. Chrome's file
   // opens with the EBML header, then a Segment of unknown size whose first child
   // is Info, all in the first chunk, and nothing points past Info - no SeekHead,
   // no Cues - so a Duration can go at the end of Info without moving anything
   // that is referred to. Any other layout is saved as recorded: a file without
   // a duration still plays, and one lost to a parse error doesn't.
   async function withDuration(chunks, ms) {
     const plain = new Blob(chunks, { type: 'video/webm' });
     try {
       const head = new Uint8Array(await chunks[0].arrayBuffer());
       // An EBML number is one byte longer than its first byte's leading zero
       // bits. An ID keeps that marker bit; a size drops it, and all ones is unknown.
       const vint = (at, keepMarker) => {
         const len = Math.clz32(head[at]) - 23;
         if (!(len >= 1 && len <= 8) || at + len > head.length) throw new Error(`no EBML number at ${at}`);
         let value = keepMarker ? head[at] : head[at] & (0xff >> len);
         for (let i = 1; i < len; i++) value = value * 256 + head[at + i];
         return { len, value, unknown: !keepMarker && value === 2 ** (7 * len) - 1 };
       };
       const element = (at) => {
         const id = vint(at, true), size = vint(at + id.len, false);
         return { id: id.value, sizeAt: at + id.len, size, data: at + id.len + size.len };
       };
       const ebml = element(0);
       const segment = element(ebml.data + ebml.size.value);
       const info = element(segment.data);
       if (ebml.id !== 0x1a45dfa3 || segment.id !== 0x18538067 || !segment.size.unknown || info.id !== 0x1549a966) throw new Error('not the layout MediaRecorder writes');
       const end = info.data + info.size.value;
       let scale = 1e6; // TimecodeScale, in ns: Duration counts in these
       for (let at = info.data; at < end;) {
         const child = element(at);
         if (child.id === 0x4489) return plain; // it has one already
         if (child.id === 0x2ad7b1) { scale = 0; for (let i = 0; i < child.size.value; i++) scale = scale * 256 + head[child.data + i]; }
         at = child.data + child.size.value;
       }
       const size = info.size.value + 11; // ID 44 89, size 88, an 8-byte float
       if (end > head.length || size >= 2 ** (7 * info.size.len) - 1) throw new Error('Info does not fit');
       const out = new Uint8Array(head.length + 11);
       out.set(head.subarray(0, end));
       for (let i = info.size.len - 1, v = size; i >= 0; i--, v = Math.floor(v / 256)) out[info.sizeAt + i] = v & 0xff;
       out[info.sizeAt] |= 0x80 >> (info.size.len - 1);
       out.set([0x44, 0x89, 0x88], end);
       new DataView(out.buffer).setFloat64(end + 3, ms * 1e6 / scale);
       out.set(head.subarray(end), end + 11);
       return new Blob([out, ...chunks.slice(1)], { type: 'video/webm' });
     } catch (e) {
       console.warn('[ViewShot] saving the WebM without a duration:', e);
       return plain;
     }
   }
   ```

   The existing tests keep passing unchanged. Their `{ size }` chunks have no `arrayBuffer()`, so a WebM save in the harness takes the fallback and saves `chunks` as they are, which is what they assert. The fallback only adds microtasks, which `settle` already waits out.

2. **`tests/capture-errors.test.js`**
   - **`loadOffscreen` gets a clock** (`:493-548`), in the same shape as `loadBg`'s (`:91`):

     ```diff
     @@ -496,1 +496,2 @@
        const videos = []; // the <video> a GIF start waits on
     +  let now = 0; // Date.now() in the document: a recording's length is read off it
     @@ -538,1 +539,2 @@
          GIF: class {},
     +    Date: class extends Date { static now() { return now; } },
     @@ -545,1 +547,1 @@
     -    ctx: context, recorders, downloads, videos, sent, asked, endTrack: () => trackListeners.ended(),
     +    ctx: context, recorders, downloads, videos, sent, asked, endTrack: () => trackListeners.ended(), tick: (ms) => { now += ms; },
     ```

   - **A fixture** next to the WebM tests (after `:724`). It is the first 168 bytes of a WebM Chrome 153 saved for this extension (see "Checked while planning"). The chunk hands out a copy of it through `arrayBuffer()`, because a small `Buffer` is a view into Node's shared pool:

     ```js
     const CHROME_WEBM_HEAD = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff1549a966992ad7b1830f42404d80864368726f6d655741864368726f6d651654ae6bbeaebcd7810173c587ffdc76db8e00f983810155ee81018685565f565039e09fb08204feba8202c853c0810155b09055b1810155b9810155ba810155bb81011f43b67501ffffffffffffffe78100a34e518100008082', 'hex');
     const webmChunk = (bytes) => ({ size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer });
     ```

   - **Three tests.** Compare saved bytes as plain arrays, since the part is a `Uint8Array` from the vm's realm.
     - **"a WebM recording is saved with its duration":**
       - Start a WebM, `tick(1850)`, flush `webmChunk(CHROME_WEBM_HEAD)` and a `{ size: 5 }`, stop, `finish()`, `settle()`.
       - The file has 2 parts, and the second is the second chunk, untouched.
       - In the first part, the bytes before `0x34` are unchanged. `Info`'s size byte at `0x34` is `0xa4` (36) rather than `0x99` (25). The bytes from `0x35` to `0x4e` are unchanged.
       - `0x4e` holds `44 89 88`, and a big-endian float64 reading 1850 follows it.
       - Everything after that is the original bytes from `0x4e` on, 11 bytes later.
     - **"a WebM whose tab was closed ends where its recorder stopped":**
       - Start a WebM, `tick(1735)`, flush the head, `endTrack()`, set the state to inactive, flush, `finish()`.
       - Then `tick(700)` for the worker's round trip, then `stopRecording('out.webm')` and `settle()`.
       - The Duration reads 1735, not 2435.
     - **"a WebM whose header isn't MediaRecorder's is saved as recorded":** a chunk whose `arrayBuffer()` gives `[1, 2, 3, 4]` is saved as it was, with `parts` equal to the recorded chunks and type `video/webm`.

## Steps

1. **`offscreen.js`: stop time on `rec.stopped`, start time on `rec`, `withDuration`, and its call in `stopRecording`** (`:179`, `:183`, `:215-217`, after `:233`). → verify: `npm test` still passes 285.
2. **`tests/capture-errors.test.js`: the clock in `loadOffscreen`.** → verify: `npm test` still passes 285.
3. **Add the fixture and the three tests.** → verify:
   - `npm test` passes 288.
   - With step 1's `offscreen.js` change reverted, the first two tests fail and the third still passes. The third pins the fallback, which behaves the same way before and after.
4. **Check real recordings.**
   - **Setup:** Chrome 153.0.8010.48, `--headless=new`, a disposable profile, and `download.default_directory` set in `Default/Preferences`. Load the repo with CDP `Extensions.loadUnpacked`, drive the popup with `Extensions.triggerAction`, and use a window of 1280×800.
   - **The ticket's two WebM recordings on an http page, about 2 s each:** one ended with Stop, one ended by closing the recorded tab (`Target.closeTarget`).

   → verify, for each file:
   - `ffprobe` reports `format=duration` as a number rather than `N/A`, within 0.1 s of the last video packet's `pts_time`.
   - `ffmpeg -v error -i <file> -f null -` prints nothing: the whole file still decodes.
   - Loaded into a `<video>` in the same Chrome (served over http), `duration` at `loadedmetadata` is finite and equals `ffprobe`'s value.
5. **Check the other formats in the same run.** → verify: an MP4 still has its duration and still decodes cleanly, and a GIF still saves at 720×401.
6. **Check that nothing else changed.** → verify: `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.

## Open questions

None. The ticket names the file, the symptom and the expected result. The layout this plan depends on was read from Chrome 153's own output, and step 4 checks the result against the ticket's two measurements.

## Checked while planning

**Chrome 153 still writes no duration.** These files were saved by this extension in Chrome 153.0.8010.48 during KAN-442's check: `/tmp/vs-dl2/dpr1-http-webm.webm` and the other `dpr1-*-webm.webm` files. `ffprobe` reads each as VP9 1278×712 with `duration=N/A` and encoder `Chrome`.

**The header of `dpr1-http-webm.webm`:**

| offset | bytes | element |
|---|---|---|
| `0x00` | `1a45dfa3 9f` … | EBML header, 31 bytes: DocType `webm`, version 4 |
| `0x24` | `18538067 01ffffffffffffff` | Segment, **unknown size** |
| `0x30` | `1549a966 99` | Info, 25 bytes: TimecodeScale `0f4240` (1,000,000 ns), MuxingApp `Chrome`, WritingApp `Chrome`, **no Duration** |
| `0x4e` | `1654ae6b be` … | Tracks, 62 bytes: one VP9 video track |
| `0x91` | `1f43b675 01ffffffffffffff` | the first Cluster, of unknown size, Timecode 0, then SimpleBlocks |

There is no SeekHead before `Info` and no Cues: nothing in the file holds an offset that the 11 inserted bytes would invalidate. `Info` grows from 25 to 36 bytes, so its size still fits the one byte Chrome gave it.

**Other checks:**

- **The duration's accuracy.** The duration comes from the wall clock because the file itself would have to be read through to its last Cluster to find the last frame's timestamp. The ticket's recordings ran at about 30 fps (53 frames in 1.735 s), so start-to-stop time should land within about a frame of the real length. Step 4's 0.1 s bound checks that.
- **Why not vendor a library.** A library such as fix-webm-duration would mean a new file, a `<script>` in `offscreen.html`, an entry in `package.json`'s zip list and a notice in `THIRD_PARTY_NOTICES.txt`. That is more to change than one function in `offscreen.js`.
- **The test clock.** A `Date` set on a vm context's global shadows the built-in one: `vm.runInContext('Date.now()', { Date: { now: () => 42 } })` returns 42. So `loadOffscreen` can take `loadBg`'s clock as it is.
- **A dry run of `withDuration`.** It was copied out of this plan into `/tmp` and run in Node 24 on `dpr1-http-webm.webm`, split into two chunks at byte 2000. The repo was not touched.
  - The output is 4076 bytes: the 4065 it was given, plus 11.
  - `Info`'s size byte went from `0x99` to `0xa4`, and `44 89 88 40 9c e8 00 00 00 00 00` (1850.0) sits at `0x4e`, with Tracks moved to `0x59`.
  - `ffprobe` reads `duration=1.850000`, the value it was given, and `ffmpeg -v error` decodes the whole file with no output.
  - Four bytes that aren't EBML came back as they went in, with the warning logged.
  - That recording's last video packet is at 2.009 s. The 1850 ms was only a test value, which is why step 4 measures the real one.
- **`npm test` at `9880f96`:** 285 pass, 0 fail.

## Implementation and verification

Done as planned.

- **Step 1 — `offscreen.js`.** `rec.stopped` resolves with `Date.now()` from `onstop` (`:181`), and `rec.startedAt` is set right after `recorder.start(1000)` (`:186`). `stopRecording` saves a WebM through `withDuration(chunks, stoppedAt - startedAt)` (`:219-220`), and `withDuration` sits after `pickMime` (`:245`), as written above. → `npm test` passed 285, unchanged.
- **Step 2 — the harness.** `loadOffscreen` has `let now = 0` (`tests/capture-errors.test.js:497`), a `Date` whose `now()` reads it, and a `tick(ms)` on its handle. → `npm test` passed 285, unchanged.
- **Step 3 — the tests.** The fixture is at `:736`, and the three tests are at `:741`, `:769` and `:786`. → `npm test` passes **288**.
  - With `HEAD`'s `offscreen.js` put back, "is saved with its duration" and "ends where its recorder stopped" fail, and "is saved as recorded" passes.
  - Restoring the change brings it back to 288 passing.
- **Steps 4-5 — real recordings.**
  - **Setup:** Chrome 153.0.8010.48, `--headless=new`, a disposable profile, and `download.default_directory` set in `Default/Preferences`. The changed repo was loaded with `Extensions.loadUnpacked`, and one warm-up popup was opened first. Each recording was started from the popup on an http page with a moving box.
  - **Results:** duration is `ffprobe`'s `format=duration`, and the `<video>` column is its `duration` at `loadedmetadata`, in the same Chrome and served over http.

  | file | ended by | duration | last frame (`pts_time`) | frames | `<video>` | decode errors |
  |---|---|---|---|---|---|---|
  | WebM | Stop | **0.885** (was `N/A`) | 0.877 | 24 | 0.885 | none |
  | WebM | closing the tab | **1.330** (was `N/A`) | 1.300 | 40 | 1.33 | none |
  | MP4 | Stop | 1.264933 (unchanged: MP4 had one) | 1.231633 | 38 | 1.264933 | none |
  | GIF | Stop | — | — | — | — | saved at 720×401 |

  - Both WebMs report their length within 0.03 s of their last frame, and none of the files logged the fallback warning.
  - The saved `k240-webm-stop.webm` has `Info`'s size byte at `0xa4` and `44 89 88 40 8b a8 00 00 00 00 00` (885.0) at `0x4e`.
  - The recordings are shorter than the 2 s between the click and Stop, because the recorder only starts after the blip and the viewport read.
- **Also checked: a WebM of a page that doesn't change.** Chrome sent only 2 frames in that recording. Its duration is **1.320**, while its last frame is at 1.001, so it runs 0.32 s past the last frame.
  - That is the time the recording ran, with the last frame held. It is outside this plan's 0.1 s bound, which assumed steady frames like the ticket's.
  - A duration that ends on the last frame would mean reading the file through to its last Cluster, which this plan chose not to do.
- **Step 6.** → `git status --short` lists only `offscreen.js`, `tests/capture-errors.test.js` and this plan.
- **Added at `/ship`: tests for the headers `withDuration` leaves alone.** A table-driven test at `tests/capture-errors.test.js:805` covers three cases:
  - **a Segment of known size:** the check throws "not the layout MediaRecorder writes";
  - **an `Info` that already has a Duration:** it returns early, with no warning;
  - **an `Info` too big for its one-byte size field:** it throws "Info does not fit".

  Each was run against `withDuration` directly to confirm it reaches that guard. → `npm test` passes **291**.
- **Files:** the harness is `/tmp/vs240-check.js`, built on `/tmp/vs387-chrome/cdp.js`. The recordings are in `/tmp/vs240-dl-PBhntR`.
