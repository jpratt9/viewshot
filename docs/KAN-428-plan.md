# KAN-428: A clipboard copy's offscreen document vouches for a recording that isn't running

Ticket: https://prattsolutions.atlassian.net/browse/KAN-428 (To Do, no comments, labels `bug` and `viewshot`). Blocked by KAN-421, which is Done (`9c66f89`).

## What the repo does now

Line numbers are from `9c66f89`, with a clean working tree. `npm test` passes 250.

- **`getRec()` asks whether *a* document exists, not which one.** `background.js:59-68`: the key survives whenever `chrome.offscreen.hasDocument()` is true (`:64`), and a `hasDocument()` that can't answer leaves it alone.
- **One document is shared by recordings and clipboard copies.** `ensureOffscreen()` (`background.js:459-487`) creates at most one, with reasons `['CLIPBOARD', 'USER_MEDIA']` (`:465`); `copyImage()` calls it (`:517`) and `startRecording()` calls it (`:559`). So a document opened for a copy answers `hasDocument()` for a recording it knows nothing about.
- **Nothing else can tell two documents apart.** `offscreen.js` has no identity of any kind: its listener (`:6-17`) answers `offscreen-ping` with `'pong'` (`:7`) and `offscreen-busy` from its own `rec` and `saving` (`:10`, `:37-38`). Both answers are about *a* document, never about *which* one.
- **The stale key then sticks.** Every later read keeps it: the badge reset (`background.js:533`), `startRecording`'s refusal (`:554`), `stopRecording` (`:662`), and `closeOffscreen()` (`:494-495`), which returns early before it ever asks `offscreen-busy` (`:504`) — so the copy's own document is left open too, which is the thing `closeOffscreen` exists to prevent (`:489-493`).
- **So** the ticket's sequence — document dies under an awake worker, then a clipboard copy opens a new one before anything reads `rec` — leaves `REC` on the badge, Stop enabled and Record greyed out in the popup (`popup.js:58`, `:65`, `:101`), and a document open with nothing in it. It clears only at a worker restart, at Stop, or when that copy's document happens to close.

### Why the ticket's own fix direction can't be used as written

The ticket suggests `offscreen-busy`, or a narrower question that "reports only the recorder". Neither can be asked from `getRec()`, because for most of a start there is no recorder to report:

- `startRecording` writes `rec` at `background.js:562`, and only sends `rec-start-offscreen` at `:588`. Between them sit `blipRecordingIndicator` and `getViewport` — two in-page calls with their own deadlines (`SCRIPT_TIMEOUT_MS`, `:150`), plus the blip's hold (`:584`). On a busy page that window is seconds long.
- The document sets its own `rec` later still, only once `getUserMedia` has resolved (`offscreen.js:75`).
- `getRec()` is called inside that window, by `startRecording` itself (`background.js:586`), by the badge reset's timer (`:533`), and by `rec-check` whenever a popup opens (`:32-35`). An `offscreen-busy`-shaped answer is `false` for all of them, so the check would delete the key it was just given and every Record would abort at `:586`.

The question that *can* be asked at any moment is which document is on the other end: that is true from the moment the document loads, before any recording, and it doesn't change for its lifetime.

## Change

Two source files and two test files.

### 1. `offscreen.js` — the document says which one it is

```diff
@@ -1,6 +1,11 @@
 const log = (...a) => console.log('[ViewShot/offscreen]', ...a);
 log('offscreen loaded, GIF available =', typeof GIF !== 'undefined');
 
+// This document's own name, minted when it loads and fixed for its lifetime.
+// A recording is written down with the id of the document it started in, so
+// the one Chrome opens later for a clipboard copy can be told apart from the
+// one the recording lives in. Only ever compared, never parsed.
+const docId = crypto.randomUUID();
+
 chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
   if (msg?.type === 'offscreen-ping') { sendResponse('pong'); return; }
+  // Asked while a recording is marked as running. offscreen-busy answers for
+  // whatever is in this document, which is nothing for the first seconds of a
+  // start; this answers for the document itself, which is true from load.
+  if (msg?.type === 'offscreen-id') { sendResponse(docId); return; }
   // Asked before the worker closes this document: a recording that is running,
```

### 2. `background.js` — write the recording down with its document

```diff
@@ -557,7 +557,11 @@
   const tab = await getActiveTab(tabId); // the tab the popup minted the stream id for
   await ensureOffscreen();
+  // Which document this recording is about to live in. ensureOffscreen has
+  // just had a `pong` out of it, so a rejection here means it went away in
+  // between; the recording is then written down without one and falls back to
+  // the plain "is there a document" check.
+  const docId = await chrome.runtime.sendMessage({ type: 'offscreen-id' }).catch(() => null);
   log('offscreen ready, sending rec-start-offscreen, format=', opts.format);
   // Persist enough to name the file at stop time, surviving a worker restart.
-  await chrome.storage.local.set({ rec: { url: tab?.url, title: tab?.title, format: opts.format, filename: opts.filename } });
+  await chrome.storage.local.set({ rec: { url: tab?.url, title: tab?.title, format: opts.format, filename: opts.filename, docId } });
```

### 3. `background.js` — `getRec()` checks the document, not just a document

```diff
@@ -59,9 +59,17 @@
 async function getRec() {
   const { rec } = await chrome.storage.local.get('rec');
-  // Only asked when there is a key to check, and a hasDocument() that can't
-  // answer leaves the key alone: it is evidence only when it says there is no
-  // document.
-  if (!rec || await chrome.offscreen.hasDocument().catch(() => true)) return rec;
-  console.warn('[ViewShot] a recording was marked as running with no offscreen document; forgetting it');
+  // Only asked when there is a key to check, and an answer that can't be had
+  // leaves the key alone: it is evidence only when it says the document the
+  // recording lives in is gone.
+  if (!rec) return rec;
+  if (await chrome.offscreen.hasDocument().catch(() => true)) {
+    // Clipboard copies share this one document (ensureOffscreen), so "a
+    // document exists" used to be answered by one opened for a copy after the
+    // recording's own had died - and the key then survived every read.
+    if (!rec.docId) return rec; // written down before it had one to compare
+    const id = await chrome.runtime.sendMessage({ type: 'offscreen-id' }).catch(() => null);
+    if (id == null || id === rec.docId) return rec; // no answer is not an answer
+  }
+  console.warn('[ViewShot] a recording was marked as running in an offscreen document that is gone; forgetting it');
   await chrome.storage.local.remove('rec');
   await chrome.action.setBadgeText({ text: '' }); // REC over nothing
 }
```

The seven call sites (`background.js:33`, `:495`, `:533`, `:554`, `:586`, `:662`) are unchanged.

### 4. `tests/offscreen-lifecycle.test.js`

- **`load()` (`:12-58`)** gets a `docId` option, defaulting to `null`, and its `sendMessage` stub (`:22-25`) answers `offscreen-id` with it. A `null` answer stands for a document that never had the branch, and the tests that set an id use plain strings.
- **Four new tests**, after the KAN-421 group (`:227`):
  1. "a document opened for a clipboard copy doesn't vouch for a recording that died with its own" — `load({ rec: { format: 'webm', filename: 'x', docId: 'A' }, hasDoc: true, docId: 'B' })`, then `getRec()` is `undefined`, `key()` is `null`, and `calls.badges` ends `''`.
  2. "a recording's own document still vouches for it" — the same with `docId: 'A'` on both sides: the key survives.
  3. "a document that can't say which one it is leaves the recording alone" — the `offscreen-id` answer rejects; the key survives.
  4. "a copy's document is closed once the recording it isn't holding is forgotten" — same setup as 1, then `await ctx.copyImage(PNG)` and `calls.close` is 1 with `docLives()` false. This is the ticket's third symptom.
- The existing tests all carry a `rec` with no `docId`, so they take the `!rec.docId` path and keep their current behaviour — including "leaves the document alone while a recording is running" (`:108`) and the whole KAN-297/421 group (`:149-227`).

### 5. `tests/capture-errors.test.js`

- **The offscreen harness (`:504-508`)** gets a `crypto: { randomUUID: () => 'doc-1' }` global. Its fake DOM has no `crypto`, so `offscreen.js` throws at load without it.
- **`:707-712`** ("a recording uses the tab it was sent for…"): its `sendMessage` stub (`:707`) answers `offscreen-id` with `'doc-1'`, and the expected stored object (`:712`) gains `docId: 'doc-1'`. This is what proves the id is written down.
- **`:1093`** ("a second start that fails leaves the first recording its rec"): `sent` collects every type the worker sends, so the expectation becomes `['offscreen-id', 'rec-start-offscreen']`.
- **One new test**, beside the start-failure group (`:964-1000`): "a start whose document won't say which one it is is still recorded" — `offscreen-id` rejects, `rec-start-offscreen` is still sent, the stored `rec` has `docId: null`, and the reply is `true`.
- The other start tests are unaffected: `:802` and `:975` refuse or fail before `ensureOffscreen`, and the rest find their message by type rather than comparing the whole list.

### Choices

- **Identity, not activity.** "Is this the document the recording started in?" is answerable at every moment `getRec()` can be called; "is a recorder running in there?" is not (see above). It also needs no ack for `rec-start-offscreen`, which is fire-and-forget today (`offscreen.js:15`).
- **Keep `hasDocument()` in front.** It is the cheap local answer, it is what the shipped KAN-421 tests exercise, and the new question is only worth a round trip when there is a document to interrogate.
- **A key with no `docId` behaves exactly as it does today.** That covers a recording written down when the id couldn't be read, and it is why no existing test changes behaviour. `onInstalled` clears `rec` (`background.js:48`), so an upgrade can't leave one behind either.
- **A document that doesn't answer keeps its recording.** Same rule as the `hasDocument()` rejection: "can't tell" must not mean "throw the recording away". The window where that matters is small — `ensureOffscreen` only returns once a document has answered a ping (`:475-484`).
- **Cost:** one extra `sendMessage` per read of `rec`, and only while a recording with a `docId` is marked as running and a document exists. With no recording nothing is asked, which is every screenshot and every clipboard copy.
- **No change to `popup.js`, `region.js`, the manifest, the README or the version.** The popup already repaints from `storage.local.onChanged` (`popup.js:190-195`) and already sends `rec-check` on open (`:215`).

## Steps

1. Make the `offscreen.js` change (section 1).
   → verify: `npm test` first fails the 18 tests that load `offscreen.js`, all with `ReferenceError: crypto is not defined` — its harness builds the context by hand (`tests/capture-errors.test.js:504-528`) and has no `crypto`. With the one line from section 5 it passes 250 again; nothing asks `offscreen-id` yet.
2. Make the two `background.js` changes (sections 2 and 3).
   → verify: `npm test` fails exactly two tests in `tests/capture-errors.test.js` — "a recording uses the tab it was sent for, even when the worker finds no active tab" (`:712`, the stored object now carries `docId`) and "a second start that fails leaves the first recording its rec" (`:1093`, the start now sends `offscreen-id` first). Both are the change showing up, not a regression.
3. Make the `tests/capture-errors.test.js` changes (section 5).
   → verify: `npm test` passes 251.
4. Make the `tests/offscreen-lifecycle.test.js` changes (section 4).
   → verify: `npm test` passes 255. Then run the file in a scratch copy whose `background.js` is `9c66f89`'s: 23 tests, and **two** of the four fail — "a document opened for a clipboard copy doesn't vouch for a recording that died with its own" and "a copy's document is closed once the recording it isn't holding is forgotten", the two that pin the bug. The other two pass on both, which is what they are for: they hold the change to leaving a recording alone when the document *is* its own, and when it can't say.
5. Check it in Chrome 153, repo loaded unpacked, with the KAN-421 driver's setup (headless, `--remote-debugging-pipe --enable-unsafe-extension-debugging`, fresh profile with `download.default_directory` in `Default/Preferences`, one warm-up popup, `Extensions.loadUnpacked`).
   - Start a WebM recording from the popup on a local http page, then close the popup.
   - Hold the worker awake with a CDP session attached to its target, and kill the document with `Target.closeTarget` on the `offscreen.html` target. Confirm the worker target is the same one afterwards.
   - Take a clipboard copy **without opening a popup** — a popup sends `rec-check`, which would read `rec` before any copy could create a document, and that read is not the one the ticket is about. `Runtime.evaluate` on the worker target: `runCapture('visible', { ...DEFAULTS, toClipboard: true }, <tabId>)`.

   → verify, with no worker restart in between:
   - the target list has **no** `offscreen.html` target once the copy is done;
   - `chrome.storage.local.get('rec')` is empty and the badge text is empty;
   - a popup opened after that shows **Record usable and Stop disabled**;
   - Record then starts a fresh recording and Stop saves a `.webm`.
6. Run the same recipe against `9c66f89` as the control.
   → verify it shows the ticket's state: `rec` still set, badge on `REC`, an `offscreen.html` target still open after the copy, and Record greyed out in the next popup.
7. Check that a live recording is still left alone.
   → verify: with the document intact, a clipboard copy during a recording closes nothing, `rec` survives, and Stop still saves a `.webm`; and a recording that spans a worker restart (kill the worker target, then Stop from a new popup) still saves.
8. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `offscreen.js`, `tests/capture-errors.test.js`, `tests/offscreen-lifecycle.test.js` and this plan.

## Checked in Chrome 153.0.8010.48

Headless, `--remote-debugging-pipe --enable-unsafe-extension-debugging`, fresh profile with `download.default_directory` in `Default/Preferences`, one warm-up popup, `Extensions.loadUnpacked`. A WebM recording was started from the popup on a local http page; a CDP session stayed attached to the service worker to hold it awake, and the `offscreen.html` target was then closed with `Target.closeTarget`. In both runs the document was gone with **the same worker still running**. The clipboard copy was then run straight from the worker — `runCapture('visible', { …, toClipboard: true })`, no popup in between, so nothing read `rec` before the copy opened its own document. That is the ticket's sequence, **now reproduced** rather than read off the code.

| After the copy | `9c66f89` | this change |
| --- | --- | --- |
| `rec` | still set | **gone** |
| Badge | `REC` | **empty** |
| Offscreen document left open | yes | **no** |
| Popup Stop | enabled | **disabled** |
| Popup Record | greyed out | **usable** |
| A fresh Record/Stop from that state | nothing saved (Record was greyed out) | **saved a `.webm`** |

- **The recording is written down with its document.** While recording, `rec` read back as `{"docId":"0ecf6b32-23ca-4c32-bfde-a95ea47a047f","filename":"shot-{date}-{time}","format":"webm","title":…,"url":…}`; on `9c66f89` the same key had no `docId`.
- **A live recording is still left alone.** With the document intact, a clipboard copy during a recording closed nothing, `rec` and the badge survived, the popup still showed Stop enabled and Record greyed out, and Stop saved the `.webm`.
- **A recording that outlives its worker still knows its document.** Killing the worker target mid-recording left the document up; the next popup showed Stop enabled, and Stop saved a third `.webm`.
- **How `9c66f89` clears it.** The control saved nothing from the state above, and the key only went when Stop was pressed on the recording that wasn't running — which is what the ticket says.

## Open questions

1. **Should `ensureOffscreen()` invalidate a stale `rec` when it creates a document, rather than leaving it to the next read?** As planned, the key is forgotten at the first read after the new document answers — inside the same clipboard copy, because `closeOffscreen()` reads `rec` (`background.js:495`). A read that lands between `createDocument` and the first `pong` still sees a document and can't get an id, so it leaves the key alone for those few milliseconds. The ticket doesn't say whether that matters.
2. **A recorder that dies inside a document that lives on.** The ticket's title is broader than what identity can prove: a document that is still the right one but whose `MediaRecorder` has stopped would still vouch for the recording. Nothing in the ticket says that happens, and the repro it describes is the two-documents one, so this plan doesn't cover it.
