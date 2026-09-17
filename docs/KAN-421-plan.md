# KAN-421: An offscreen document that dies while the worker is awake leaves the recording marked as running

Ticket: https://prattsolutions.atlassian.net/browse/KAN-421 (To Do, no comments, labels `bug` and `viewshot`). Blocked by KAN-297, which is Done.

## What the repo does now

Line numbers are from `9f2dbd3`, with a clean working tree.

- **The check runs once per worker start.** `verifyRec()` (`background.js:52-59`) is the only thing that compares `rec` with `chrome.offscreen.hasDocument()`, and it is called once, at module scope: `const recChecked = verifyRec().catch(…)` (`background.js:60`).
- **Every read then trusts that one result.** `getRec()` (`background.js:64-67`) awaits `recChecked` and reads storage. Once the worker has been up a moment that promise is settled, so no read re-checks anything:
  - `closeOffscreen()` (`background.js:494`) — its own `hasDocument()` call (`:497`) sits *after* the early return on `rec` (`:494-495`), so a set key never reaches it.
  - `flashBadge()`'s reset (`background.js:532`), which paints `REC` again.
  - `startRecording`'s "already running" refusal (`background.js:553`) and its pre-recorder re-check (`:585`).
  - `stopRecording` (`background.js:661`), which then sends `rec-stop-offscreen`.
- **The `rec-check` message doesn't help an awake worker.** The branch (`background.js:28-31`) awaits the same settled `recChecked`. The popup sends it on every open (`popup.js:209-215`) to *start* the worker; against a worker that is already running it starts nothing and checks nothing.
- **Nothing reports the document dying.** `offscreen.js` messages the worker only for ordinary endings: `rec-stop` when the captured track ends (`offscreen.js:79`) and `rec-failed` when a start fails (`offscreen.js:235`). `background.js` has no port, no `onDisconnect`, and no unload hook, so a renderer crash is silent.
- **So** a document that goes away while the worker stays awake leaves `rec` set with nothing recording: `REC` on the badge, the popup's Stop enabled and Record greyed out (`popup.js:58`, `:65`, `:101`), and `closeOffscreen()` returning early so a clipboard copy's document is left open. It clears only when the worker restarts or Stop is pressed.
- **Tests:** `npm test` passes 246. `tests/offscreen-lifecycle.test.js` is the only harness that mocks `chrome.offscreen` and `rec` together. Its `load()` (`:12-58`) has `hasDoc` and `rec` knobs and returns `docLives()`, `send()` and `fire()`; `docExists` only ever changes through `createDocument`/`closeDocument`, so no test can make a document die mid-test. The four KAN-297 tests (`:155-180`) all start from a worker that is *already* stale.

## Change

One source file and one test file.

### 1. `background.js` — check on every read instead of once per start

Replace `verifyRec()`, `recChecked` and `getRec()` (`background.js:46-67`) with a single `getRec()` that does the check itself:

```diff
@@ -43,26 +43,20 @@
 chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('rec'));
 chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('rec'));
 
-// Disabling the extension ends a recording too - the offscreen document goes
-// with it - but Chrome fires neither event above when it is enabled again, so
-// the key was left behind with nothing recording: Stop stayed enabled, Record
-// stayed greyed out, a failed screenshot's badge ended on REC, and a clipboard
-// copy left its document open. The recording only ever lives in the offscreen
-// document, so a `rec` with no document is a leftover, whatever put it there.
-async function verifyRec() {
-  const { rec } = await chrome.storage.local.get('rec');
-  // Only asked about when there is a key to check: with no key there is nothing
-  // for a document to vouch for.
-  if (!rec || await chrome.offscreen.hasDocument()) return;
-  console.warn('[ViewShot] a recording was marked as running with no offscreen document; forgetting it');
-  await chrome.storage.local.remove('rec');
-}
-const recChecked = verifyRec().catch((e) => console.warn('[ViewShot] rec check failed:', e));
-
-// Every read of `rec` goes through here, so none of them can beat the check
-// above: a Stop pressed on a stale popup is the one that used to win that race.
-async function getRec() {
-  await recChecked;
-  return (await chrome.storage.local.get('rec')).rec;
-}
+// Every read of `rec` goes through here, and every read checks it. The
+// recording only ever lives in the offscreen document, so a key with no
+// document is a leftover: disabling the extension leaves one behind, because
+// Chrome fires neither event above when it is enabled again, and so does a
+// document that dies on its own - a renderer crash, or Chrome discarding it.
+// Checking once per worker start missed that second one entirely: the worker
+// can stay awake right through it, and then the badge kept showing REC, the
+// popup kept Stop enabled and Record greyed out, and a clipboard copy left its
+// document open.
+async function getRec() {
+  const { rec } = await chrome.storage.local.get('rec');
+  // Only asked when there is a key to check, and a hasDocument() that can't
+  // answer leaves the key alone: it is evidence only when it says there is no
+  // document.
+  if (!rec || await chrome.offscreen.hasDocument().catch(() => true)) return rec;
+  console.warn('[ViewShot] a recording was marked as running with no offscreen document; forgetting it');
+  await chrome.storage.local.remove('rec');
+  await chrome.action.setBadgeText({ text: '' }); // REC over nothing
+}
```

The five call sites (`background.js:494`, `:532`, `:553`, `:585`, `:661`) are unchanged — they already go through `getRec()`.

### 2. `background.js` — the `rec-check` branch runs the check

```diff
@@ -25,10 +25,10 @@
   else if (msg?.type === 'rec-failed') recFailed();
-  // The popup reads `rec` from storage without waking the worker, so a leftover
-  // key would go unnoticed for as long as the popup was the only thing running.
-  // This message exists to start the worker, which checks the key at every start.
-  else if (msg?.type === 'rec-check') { recChecked.then(() => sendResponse(true)); return true; }
+  // The popup reads `rec` from storage without waking the worker, so a leftover
+  // key would go unnoticed for as long as the popup was the only thing running.
+  // This message is what checks it for the popup: opening one is also the way a
+  // key whose document died under an awake worker gets noticed.
+  else if (msg?.type === 'rec-check') {
+    getRec().catch((e) => console.warn('[ViewShot] rec check failed:', e)).then(() => sendResponse(true));
+    return true;
+  }
```

`popup.js` doesn't change: it already sends `rec-check` on open (`popup.js:209-215`), and its `storage.local.onChanged` listener (`popup.js:190-195`) repaints Stop and Record when the key goes.

### 3. `tests/offscreen-lifecycle.test.js`

- **`load()`'s return (`:51-58`)** gets two one-line accessors beside `docLives`, because nothing can currently observe this bug:
  - `killDoc: () => { docExists = false; }` — the document going away with no worker restart and no `closeDocument`.
  - `key: () => rec` — what is actually in storage, without a read that would itself check it.
- **Three new tests**, after the KAN-297 group (`:180`):
  1. "a document that dies while the worker is awake is noticed by the next read" — `load({ rec, hasDoc: true })`, `assert.ok(await ctx.getRec())`, `killDoc()`, then `assert.strictEqual(await ctx.getRec(), undefined)`.
  2. "Stop after the document died doesn't message it" — same setup, `killDoc()`, then `assert.strictEqual(await ctx.stopRecording(), false)` and no `rec-stop-offscreen` in `calls.sent`.
  3. "rec-check re-checks a worker that is already awake" — same setup, one `await ctx.getRec()` first so any cached check is settled, `killDoc()`, `send({ type: 'rec-check' })`, then `assert.strictEqual(key(), null)`.
- **One existing assertion (`:179`)** in "rec-check answers once the leftover key has been checked" becomes `assert.strictEqual(key(), null, …)`. Under the new mechanism its current `await ctx.getRec()` would do the checking itself, so it would pass whether or not `rec-check` did anything.
- **One existing name (`:155`)**: "a recording with no offscreen document is forgotten at the next worker start" → "…at the next read", which is what the check is now tied to.

### Choices

- **Move the check into the read rather than add a second mechanism.** `getRec()` already exists and every consumer already goes through it, so the ticket's "check it again" is one function doing what it did before, on every call instead of once. This deletes `verifyRec()` and `recChecked` rather than adding anything.
- **The worker-start check goes away with them.** Nothing acts on `rec` except through `getRec()`, and the one direct reader — the popup — sends `rec-check` on open, which now checks. A stale key that nobody reads harms nobody.
- **Cost:** one extra `chrome.offscreen.hasDocument()` per read, and only while a key is set. With no recording `rec` is undefined and nothing is asked. During a recording the reads are the badge reset, a second Record press, and Stop.
- **Clear the badge where the key is dropped.** The ticket names `REC`-over-nothing as one of the three symptoms, and nothing else repaints the badge until the next capture failure.
- **A `hasDocument()` that rejects leaves the key alone.** `verifyRec()`'s rejection used to be swallowed by a `.catch` on `recChecked`; the same failure now has to not take the caller down with it, and "can't tell" must not mean "throw the recording away".
- **No change to `offscreen.js`, `popup.js`, the manifest, the README or the version.**

## Steps

1. Make the `background.js` changes (sections 1 and 2).
   → verify: `npm test` passes 246 again. It first fails two tests in `tests/capture-errors.test.js` — "a failed screenshot's ! gives way to REC while a recording runs" and "the frame cap still flashes MAX when it ends a recording" — because both mark a recording as running in a harness with no `chrome.offscreen`, which a per-read check now reaches. Each gets the one line the rest of that file already uses, `chrome.offscreen = { hasDocument: async () => true }`: a running recording is in a document.
2. Make the `tests/offscreen-lifecycle.test.js` changes (section 3).
   → verify: `npm test` passes 249. Then, to prove the three new tests can fail, run them in a scratch copy whose `background.js` is the one-shot version from `9f2dbd3`: exactly those three fail, 15 pass. "rec-check answers once the leftover key has been checked" passes there too, and should — its key was stale from the start, which is what the old check caught.
3. Check it in Chrome 152, repo loaded unpacked, with the KAN-297 driver's setup (headless, `--remote-debugging-pipe --enable-unsafe-extension-debugging`, fresh profile with `download.default_directory` in `Default/Preferences`, one warm-up popup).
   - Start a WebM recording from the popup on a local http page and close that popup.
   - Kill the document without touching the worker: `Target.closeTarget` on the `offscreen.html` target, while a CDP session is attached to the service worker so it stays awake. Confirm the worker target is still the same one afterwards.

   → verify, with no worker restart in between:
   - a new popup shows **Stop disabled and Record usable**;
   - `rec` is gone and the badge is empty;
   - Record starts a fresh recording, and Stop saves a `.webm`;
   - a Visible capture with "Copy to clipboard" on leaves no offscreen document open.
4. Check that a live recording is still left alone.
   → verify: with the document intact, the same reads keep the key — Record, wait, Stop saves a `.webm`; and a recording that spans a worker restart (kill the worker target instead of the document, then Stop from a new popup) still saves.
5. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `tests/offscreen-lifecycle.test.js`, `tests/capture-errors.test.js` (step 1's two harness lines) and this plan.

## Checked in Chrome 152.0.7977.83

Headless, `--remote-debugging-pipe --enable-unsafe-extension-debugging`, fresh profile with `download.default_directory` in `Default/Preferences`, one warm-up popup, extension loaded with `Extensions.loadUnpacked`. A WebM recording was started from the popup on a local http page; a CDP session stayed attached to the service worker to hold it awake, and the `offscreen.html` target was then closed with `Target.closeTarget`. In both runs the document was gone and **the same worker was still running** — no restart, so nothing re-ran a startup check. Both runs showed `rec` set and the badge on `REC` before anything read the key: the leftover state the ticket describes, **now reproduced** rather than read off the code.

| After the document died | one-shot check (`9f2dbd3`) | this change |
| --- | --- | --- |
| Popup Stop | enabled | **disabled** |
| Popup Record | greyed out | **usable** |
| `rec` after the popup opened | still set | **gone** |
| Badge after the popup opened | `REC` | **empty** |
| Clipboard copy left a document open | yes | **no** |
| A fresh Record/Stop from that state | nothing saved (Record was greyed out) | **saved a `.webm`** |

- **A live recording is still left alone.** With the document intact, the worker target was closed instead: the document stayed, the popup still showed Stop enabled, and Stop saved a second `.webm`. Both copies behaved the same way here.

## Open questions

1. **Should a clipboard copy's document be allowed to vouch for a recording?** `hasDocument()` says only whether *a* document exists, not what is in it. A stale `rec` that coincides with a document opened for a clipboard copy would survive every read until that copy's document closes. The ticket doesn't say, and the alternative — asking the document whether it is recording, the way `closeOffscreen()` asks `offscreen-busy` (`background.js:499`, `offscreen.js:10`) — is a bigger change than this plan makes. The plan keeps the existing "any document counts" test.
