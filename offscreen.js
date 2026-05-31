// The offscreen document is the only extension context with DOM + media APIs,
// so both clipboard writes and tab recording run here.
const log = (...a) => console.log('[ViewShot/offscreen]', ...a);
log('offscreen loaded, GIF available =', typeof GIF !== 'undefined');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'offscreen-ping') { sendResponse('pong'); return; }
  if (msg?.type === 'shot-clipboard') copyToClipboard(msg.dataUrl);
  else if (msg?.type === 'rec-start-offscreen') { log('rec-start-offscreen, format=', msg.format); startRecording(msg.streamId, msg.format).catch(onRecError); }
  else if (msg?.type === 'rec-stop-offscreen') { log('rec-stop-offscreen, filename=', msg.filename); stopRecording(msg.filename); }
});

async function copyToClipboard(dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (e) {
    console.error('[ViewShot] clipboard write failed:', e);
  }
}

// ---- recording ----
const GIF_FPS = 10;
const GIF_MAX_WIDTH = 720;
const GIF_MAX_FRAMES = 600; // ~60s cap so addFrame copies don't exhaust memory
let rec = null; // { stream, format, recorder?, chunks?, gif?, timer?, frames? }

async function startRecording(streamId, format) {
  // tabCapture ids are redeemed only through this legacy constraints form.
  log('requesting getUserMedia for streamId', streamId);
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  log('got MediaStream, video tracks:', stream.getVideoTracks().length);
  rec = { stream, format };

  if (format === 'gif') {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await new Promise((res) => { video.onloadedmetadata = res; });
    await video.play();

    const scale = Math.min(1, GIF_MAX_WIDTH / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    rec.gif = new GIF({ workers: 2, quality: 10, width: w, height: h, workerScript: chrome.runtime.getURL('gif.worker.js') });
    rec.frames = 0;
    const delay = Math.round(1000 / GIF_FPS);
    rec.timer = setInterval(() => {
      if (rec.frames >= GIF_MAX_FRAMES) { clearInterval(rec.timer); rec.timer = null; console.warn('[ViewShot] GIF frame cap reached, stopping capture'); return; }
      ctx.drawImage(video, 0, 0, w, h);
      rec.gif.addFrame(ctx, { copy: true, delay });
      rec.frames++;
    }, delay);
  } else {
    rec.chunks = [];
    const mime = pickWebmMime();
    log('starting MediaRecorder, mime=', mime);
    rec.recorder = new MediaRecorder(stream, { mimeType: mime });
    rec.recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    rec.recorder.start();
    log('MediaRecorder state:', rec.recorder.state);
  }
}

function stopRecording(filename) {
  if (!rec) return;
  const { stream, format } = rec;

  if (format === 'gif') {
    if (rec.timer) clearInterval(rec.timer);
    rec.gif.on('finished', (blob) => download(blob, filename));
    rec.gif.render();
  } else {
    rec.recorder.onstop = () => download(new Blob(rec.chunks, { type: 'video/webm' }), filename);
    rec.recorder.stop();
  }
  stream.getTracks().forEach((t) => t.stop());
  rec = null;
}

function pickWebmMime() {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function download(blob, filename) {
  log('downloading', filename, 'size=', blob.size, 'bytes');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function onRecError(e) {
  console.error('[ViewShot] recording failed:', e);
  rec = null;
  chrome.runtime.sendMessage({ type: 'rec-failed' });
}
