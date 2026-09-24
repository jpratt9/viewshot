// The offscreen document is the only extension context with DOM + media APIs,
// so both clipboard writes and tab recording run here.
const log = (...a) => console.log('[ViewShot/offscreen]', ...a);
log('offscreen loaded, GIF available =', typeof GIF !== 'undefined');

// This document's own name, minted when it loads and fixed for its lifetime.
// A recording is written down with the id of the document it started in, so
// the one Chrome opens later for a clipboard copy can be told apart from the
// one the recording lives in. Only ever compared, never parsed.
const docId = crypto.randomUUID();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'offscreen-ping') { sendResponse('pong'); return; }
  // Asked while a recording is marked as running. offscreen-busy answers for
  // whatever is in this document, which is nothing for the first seconds of a
  // start; this answers for the document itself, which is true from load.
  if (msg?.type === 'offscreen-id') { sendResponse(docId); return; }
  // Asked before the worker closes this document: a recording that is running,
  // or stopped but not saved yet, lives only in here.
  if (msg?.type === 'offscreen-busy') { sendResponse(!!rec || saving > 0); return; }
  // Answered so the worker can close this document once the write is done —
  // an offscreen document shares its renderer main thread with the popup, and
  // Chrome won't paint the popup until that thread lets its onload finish.
  // Only its own write: shot-clipboard is the popup's (KAN-489).
  if (msg?.type === 'shot-clipboard-offscreen') { copyToClipboard(msg.dataUrl).then(() => sendResponse('done')).catch((e) => sendResponse({ error: e.message || String(e) })); return true; }
  else if (msg?.type === 'rec-start-offscreen') { log('rec-start-offscreen, format=', msg.format, 'dims=', msg.width, 'x', msg.height, msg.cssPx ? '(css px)' : '', 'audio=', !!msg.audio); startRecording(msg.streamId, msg.format, msg.width, msg.height, msg.cssPx, msg.audio).catch(onRecError); }
  else if (msg?.type === 'rec-stop-offscreen') { log('rec-stop-offscreen, filename=', msg.filename); stopRecording(msg.filename); }
});

async function copyToClipboard(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// ---- recording ----
const GIF_FPS = 10;
const GIF_MAX_WIDTH = 720;
const GIF_MAX_FRAMES = 600; // ~60s cap so addFrame copies don't exhaust memory
// A video fed by a live capture stream is ready in a few ms: 2 ms on an idle
// page, 80 ms right after a busy one. One that never answers used to hold this
// document for good, so the wait gives up after the same 2 s the worker allows
// its own page calls (SCRIPT_TIMEOUT_MS).
const VIDEO_TIMEOUT_MS = 2000;
let rec = null; // { stream, format, playback?, recorder?, chunks?, gif?, timer?, frames? }
let saving = 0; // recordings stopped but not saved yet (see stopRecording)
let lastStart = null; // { stopped }, so a Stop can reach a start still waiting on getUserMedia

async function startRecording(streamId, format, width, height, cssPx, audio) {
  // One recording at a time: replacing `rec` would leave the one already
  // running with nothing that can stop or save it.
  if (rec) { console.warn('[ViewShot] a recording is already running; not starting another'); return; }
  // tabCapture ids are redeemed only through this legacy constraints form.
  // Pin min/max width+height to the actual tab dims so Chrome's tabCapture
  // pipeline doesn't letterbox the output (default behavior is to scale to a
  // ceiling resolution while preserving source aspect, then pad with black to
  // fit — the bars on top/bottom of recordings). Modern MediaTrackConstraints
  // (aspectRatio, applyConstraints) are silently ignored when chromeMediaSource
  // is set; the legacy mandatory block is the only honored surface.
  const mandatory = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  // The worker's fallback dims are chrome.tabs.Tab.width/height, which is the
  // viewport in CSS pixels: it doesn't scale with the display. tabCapture
  // streams physical pixels, so pinning those raw records a HiDPI tab at 1x.
  // This document has no display of its own, but its devicePixelRatio is the
  // display's scale factor all the same — and unlike the page's, it doesn't
  // move with page zoom, which is what Tab.width/height needs.
  if (cssPx && width && height) { width = Math.round(width * devicePixelRatio); height = Math.round(height * devicePixelRatio); }
  if (width && height) {
    Object.assign(mandatory, { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height });
  }
  log('requesting getUserMedia for streamId', streamId, 'mandatory=', mandatory);
  const constraints = { video: { mandatory } };
  // The tab's sound as well, when "Record tab audio" is on: WebM (KAN-221) and
  // MP4 (KAN-544), not GIF. It is redeemed from the same stream id, in the same
  // legacy form.
  if (audio && format !== 'gif') constraints.audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  const start = { stopped: false };
  lastStart = start;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    // A start stopped while getUserMedia was answering has nothing to report:
    // rec-failed would flash ! right after the user's own Stop.
    if (start.stopped) { console.warn('[ViewShot] getUserMedia failed for a start that was already stopped:', e); return; }
    throw e;
  }
  log('got MediaStream, video tracks:', stream.getVideoTracks().length);
  // The worker reads `rec` for the last time before it sends rec-start-offscreen,
  // so its Stop can still arrive while getUserMedia is answering. The worker has
  // removed `rec` and cleared the badge by then, and ignores any later rec-stop:
  // a recorder started now would run on with nothing that can stop it.
  if (start.stopped) { stream.getTracks().forEach((t) => t.stop()); console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }
  rec = { stream, format };
  // Chrome stops playing a tab's sound to the user once it is captured. Play
  // it back out from here for as long as it is.
  if (constraints.audio) {
    rec.playback = new AudioContext();
    rec.playback.createMediaStreamSource(stream).connect(rec.playback.destination);
  }
  // Chrome's own "Stop sharing" bar (and closing the captured tab) ends the
  // track without telling us. Route it through the normal stop path so the
  // file is still written, the badge clears, and nothing keeps ticking.
  stream.getVideoTracks().forEach((t) => {
    t.addEventListener('ended', () => chrome.runtime.sendMessage({ type: 'rec-stop' }));
  });

  if (format === 'gif') {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    // One deadline covers both waits, since nothing sits between them. Without
    // it, a video that never answered left `rec` set with no encoder in it: the
    // document refused every later start, answered offscreen-busy with true so
    // the worker could never close it, and kept the capture stream running.
    try {
      await Promise.race([
        (async () => { await new Promise((res) => { video.onloadedmetadata = res; }); await video.play(); })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`the video did not start within ${VIDEO_TIMEOUT_MS / 1000}s`)), VIDEO_TIMEOUT_MS)),
      ]);
    } catch (e) {
      // A start the user has already stopped has nothing to report: rec-failed
      // would flash ! right after their own Stop. The check below is its
      // cleanup either way.
      if (!start.stopped) throw e; // onRecError tears this start down and reports it
      console.warn('[ViewShot] the video never started for a start that was already stopped:', e);
    }
    // A Stop can land in those two waits as well. `rec` is set by now, so
    // stopRecording marks this start stopped and leaves the cleanup here:
    // nothing has been captured, and the worker has already removed `rec` and
    // cleared the badge, so a frame timer started now would tick on with
    // nothing that can stop it.
    if (start.stopped) { teardown(); console.warn('[ViewShot] stopped before the recorder started; not starting it'); return; }

    const scale = Math.min(1, GIF_MAX_WIDTH / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    // willReadFrequently=true: gif.js calls getImageData on every frame, so
    // Chrome will use a CPU-backed canvas instead of GPU (faster for readback).
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    rec.gif = new GIF({ workers: 2, quality: 10, width: w, height: h, workerScript: chrome.runtime.getURL('src/vendor/gif.worker.js') });
    rec.frames = 0;
    const delay = Math.round(1000 / GIF_FPS);
    // Held locally as well as on `rec` so the tick can always cancel itself,
    // even once `rec` has been nulled out from under it.
    const timer = setInterval(() => {
      // The error path nulls `rec` without clearing this interval. Without the
      // guard the tick throws every 100ms forever, saturating the main thread
      // this document shares with the popup — and Chrome will not paint the
      // popup until that thread lets its onload complete.
      if (!rec || !rec.gif) { clearInterval(timer); return; }
      if (rec.frames >= GIF_MAX_FRAMES) {
        clearInterval(timer); rec.timer = null;
        console.warn('[ViewShot] GIF frame cap reached, auto-stopping');
        // Run the same end-to-end stop path the Stop button uses — background
        // will compute the filename, set the MAX badge, and send us the
        // rec-stop-offscreen message back. No zombie "recording" state left.
        chrome.runtime.sendMessage({ type: 'rec-cap-hit' });
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      rec.gif.addFrame(ctx, { copy: true, delay });
      rec.frames++;
    }, delay);
    rec.timer = timer;
  } else {
    // Close over the array, not over `rec`. stop() nulls `rec` synchronously
    // while MediaRecorder still owes one final dataavailable on a later task,
    // so reading rec.chunks here threw "Cannot read properties of null" and
    // dropped the last second of every recording on the floor.
    const chunks = [];
    rec.chunks = chunks;
    const mime = pickMime(format, !!constraints.audio);
    log('starting MediaRecorder, mime=', mime);
    rec.recorder = new MediaRecorder(stream, { mimeType: mime });
    const recorder = rec.recorder;
    recorder.onerror = (event) => {
      // A late error from a stopped recorder must not clear a newer recording.
      if (rec?.recorder === recorder) onRecError(event.error || event);
    };
    rec.recorder.ondataavailable = (e) => { 
      if (e.data.size) {
        chunks.push(e.data);
        openDB().then(db => db.transaction('recordings', 'readwrite').objectStore('recordings').put(e.data, chunks.length));
      }
    };
    // Closing the captured tab ends the track, and the recorder stops by itself
    // - final flush, then `stop` - before rec-stop has been to the worker and
    // back. An onstop set in stopRecording() by then never runs, so listen now.
    // It resolves with the time the recorder stopped: the end of the recording,
    // however late the worker's Stop arrives after it.
    rec.stopped = new Promise((res) => { rec.recorder.onstop = () => res(Date.now()); });
    // Timeslice → periodic dataavailable. Survives an offscreen-doc eviction
    // mid-recording (MV3 may tear it down); without this, a crash loses
    // everything because the only flush is at stop().
    rec.recorder.start(1000);
    rec.startedAt = Date.now();
    const startedAt = rec.startedAt;
    openDB().then(db => {
      const store = db.transaction('recordings', 'readwrite').objectStore('recordings');
      store.clear();
      store.put({ format, startedAt }, 'meta');
    });
    log('MediaRecorder state:', rec.recorder.state);
  }
}

function stopRecording(filename) {
  // No recording yet, but its start may still be waiting on getUserMedia.
  if (!rec) { if (lastStart) lastStart.stopped = true; return; }
  const { stream, format } = rec;
  // A GIF start sets `rec` before it waits for its video, so the encoder may
  // not be there yet: rec.gif.on threw, and the start recorded on. Nothing has
  // been captured, so hand this Stop to the start the same way, and leave
  // `saving` alone: no file is on its way.
  if (format === 'gif' && !rec.gif) { if (lastStart) lastStart.stopped = true; return; }
  // Saved only later: a GIF is encoded first, a video waits for its final
  // flush, and download() still needs the file's URL for a minute after that.
  saving++;

  if (format === 'gif') {
    if (rec.timer) clearInterval(rec.timer);
    let progressTimer;
    const gif = rec.gif;
    const onHang = () => { gif.abort(); };
    const resetTimer = () => { clearTimeout(progressTimer); progressTimer = setTimeout(onHang, 30000); };
    gif.on('start', resetTimer);
    gif.on('progress', resetTimer);
    gif.on('abort', () => {
      clearTimeout(progressTimer);
      saving--;
      onRecError(new Error('GIF encoding timed out or aborted'));
    });
    gif.on('finished', (blob) => {
      clearTimeout(progressTimer);
      download(blob, filename);
    });
    resetTimer();
    gif.render();
    // GIF frames are already captured into the worker, so the stream is no
    // longer needed and `rec` can be cleared synchronously here.
    stream.getTracks().forEach((t) => t.stop());
    rec = null;
  } else {
    // MediaRecorder.stop() is async: it flushes one final `dataavailable`
    // and THEN fires `onstop` on a later task. We must (a) capture
    // `chunks` + `recorder` into locals so the closure doesn't deref a
    // nulled `rec`, and (b) keep the stream alive until that final flush
    // completes — track-stopping waits for `stop` too.
    const { recorder, chunks, stopped, startedAt, playback } = rec;
    stopped.then(async (stoppedAt) => {
      download(format === 'webm' ? await withDuration(chunks, stoppedAt - startedAt) : new Blob(chunks, { type: `video/${format}` }), filename);
      openDB().then(db => db.transaction('recordings', 'readwrite').objectStore('recordings').clear());
      stream.getTracks().forEach((t) => t.stop());
      playback?.close(); // the tab plays its own sound again once its tracks stop
    });
    // Already inactive if the track ended first: there is nothing left to stop.
    if (recorder.state !== 'inactive') recorder.stop();
    rec = null;
  }
}

// MP4 is there for QuickTime Player, which can't open WebM, so it names H.264
// (avc1), the codec QuickTime plays, and AAC (mp4a.40.2) for the tab's sound.
function pickMime(format, audio) {
  const types = format === 'mp4'
    ? [...(audio ? ['video/mp4;codecs=avc1,mp4a.40.2'] : []), 'video/mp4;codecs=avc1', 'video/mp4']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || `video/${format}`;
}

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

function download(blob, filename) {
  log('downloading', filename, 'size=', blob.size, 'bytes');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  // Once the download is done with the file, the worker can close this
  // document: nothing else does after a recording, and it shares its main
  // thread with the popup. The worker still asks offscreen-busy first.
  setTimeout(() => { URL.revokeObjectURL(url); saving--; chrome.runtime.sendMessage({ type: 'rec-saved' }); }, 60000);
}

// Release everything this document holds. The frame timer and the capture
// stream both keep working otherwise, and this document's main thread is the
// popup's main thread.
function teardown() {
  if (!rec) return;
  if (rec.timer) clearInterval(rec.timer);
  try { rec.stream.getTracks().forEach((t) => t.stop()); } catch {}
  rec.playback?.close();
  rec = null;
}

function onRecError(e) {
  console.error('[ViewShot] recording failed:', e);
  teardown();
  chrome.runtime.sendMessage({ type: 'rec-failed' });
}
const DB_NAME = 'ViewShotRecovery';
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore('recordings');
    req.onsuccess = (e) => res(e.target.result);
    req.onerror = (e) => rej(req.error);
  });
}

openDB().then((db) => {
  const store = db.transaction('recordings', 'readonly').objectStore('recordings');
  store.getAll().onsuccess = (e) => {
    const vals = e.target.result;
    if (vals.length === 0) return;
    store.getAllKeys().onsuccess = async (k) => {
      const keys = k.target.result;
      const metaIdx = keys.indexOf('meta');
      if (metaIdx === -1) return;
      const meta = vals[metaIdx];
      const chunks = vals.filter((_, i) => i !== metaIdx);
      if (chunks.length > 0) {
        log('Recovered left-over recording', chunks.length, 'chunks, format', meta.format);
        const blob = meta.format === 'webm' ? await withDuration(chunks, chunks.length * 1000) : new Blob(chunks, { type: `video/${meta.format}` });
        download(blob, `recovered-shot.${meta.format}`);
      }
      db.transaction('recordings', 'readwrite').objectStore('recordings').clear();
    };
  };
}).catch(console.error);
