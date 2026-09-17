# KAN-297: Disabling and re-enabling the extension mid-recording leaves the recording marked as running

Ticket: https://prattsolutions.atlassian.net/browse/KAN-297 (To Do, two comments, labels `bug` and `viewshot`). Blocked by KAN-294, which is Done.

## What the repo does now

Line numbers are from `db24856`, with a clean working tree.

- **What clears `rec`**
  - `chrome.runtime.onStartup` and `onInstalled` remove it (`background.js:39-40`, KAN-294's change). The comment above them (`:35-38`) says the recording lives in the offscreen document, so after either event nothing is recording "whatever the key says".
  - `recFailed()` removes it (`background.js:513`), and `stopRecording` removes it (`background.js:640`).
  - Nothing else. Disabling the extension also destroys the offscreen document and its recording, and Chrome fires neither event when it is enabled again, so the key is left behind with nothing recording.
- **What trusts `rec`** — every one of these reads `chrome.storage.local` and believes what is there:
  - `closeOffscreen()` returns before it ever asks whether a document exists (`background.js:467-468`; the `hasDocument()` call is at `:470`, which a leftover key never reaches). This is the ticket's "a clipboard copy left the offscreen document open".
  - `flashBadge()`'s reset reads it 3 s later and restores `REC` (`background.js:504-506`). This is comment 2's case: a failed screenshot's `!` ends on `REC` with nothing recording.
  - `startRecording` refuses to start while it is set (`background.js:526-527`), and re-checks it before starting the recorder (`:558`).
  - `stopRecording` acts on it and sends `rec-stop-offscreen` (`background.js:634-642`). With nothing listening, the `rec-stop` handler logs `Could not establish connection` (`background.js:22`).
  - The popup enables Stop from it (`popup.js:58`, `:65`) and greys Record out while Stop is enabled (`popup.js:101`). This is comment 1's case: the leftover key makes Record unusable too.
- **How the popup learns about `rec`**
  - One `chrome.storage.local.get(['opts', 'rec'])` (`popup.js:56-59`). `tests/defaults.test.js:209-210` requires that single call.
  - `chrome.storage.local.onChanged` (`popup.js:190-195`) already re-points Stop **and** calls `toggleRec()` whenever `rec` changes, so a worker that removes the key repairs an open popup's Stop and Record with no new popup UI code.
  - Opening the popup does not wake the service worker: `tabs.query` and `storage.local.get` are answered without it. So a stale key is never noticed until something else sends the worker a message.
- **`chrome.offscreen.hasDocument()`** is already used twice, both in the worker: `ensureOffscreen` (`background.js:432`) and `closeOffscreen` (`background.js:470`).
- **`getOpts()`** (`background.js:42-47`) is the existing pattern for "read a storage key through one helper". This plan adds `getRec()` beside it.
- **Tests:** `npm test` passes 241 tests at `db24856`.
  - `tests/offscreen-lifecycle.test.js` is the only harness that mocks `chrome.offscreen` and `rec` together (`load()` at `:12-57`, with `hasDoc` and `rec` knobs).
  - Its "leaves the document alone while a recording is running" (`:97-102`) and the two KAN-294 endings tests (`:104-124`) load `rec` **without** a document — a state that this change treats as stale.
  - The other background harnesses answer `chrome.storage.local.get` with `{}` or a catch-all proxy and have no `chrome.offscreen`, so a check that only asks about the document when `rec` is set never touches them.
  - Four harnesses load `popup.js`: `tests/defaults.test.js:74`, `tests/capture-errors.test.js:288`, `tests/region-cancel.test.js:203`, `tests/region-dispatch.test.js:80`. Two of their `runtime.sendMessage` mocks are not async (`tests/defaults.test.js:65`, `tests/region-cancel.test.js:197`), and ~28 assertions across them compare `sent` exactly.

## Change

Two source files and six test files.

### 1. `background.js` — check the key against the offscreen document once per worker start

After the `onStartup`/`onInstalled` listeners (`:40`), before `getOpts()`:

```diff
@@ -37,6 +37,25 @@
 chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove('rec'));
 chrome.runtime.onInstalled.addListener(() => chrome.storage.local.remove('rec'));
 
+// Disabling the extension ends a recording too - the offscreen document goes
+// with it - but Chrome fires neither event above when it is enabled again, so
+// the key was left behind with nothing recording: Stop stayed enabled, Record
+// stayed greyed out, a failed screenshot's badge ended on REC, and a clipboard
+// copy left its document open. The recording only ever lives in the offscreen
+// document, so a `rec` with no document is a leftover, whatever put it there.
+async function verifyRec() {
+  const { rec } = await chrome.storage.local.get('rec');
+  // Only asked about when there is a key to check: with no key there is nothing
+  // for a document to vouch for.
+  if (!rec || await chrome.offscreen.hasDocument()) return;
+  console.warn('[ViewShot] a recording was marked as running with no offscreen document; forgetting it');
+  await chrome.storage.local.remove('rec');
+}
+const recChecked = verifyRec().catch((e) => console.warn('[ViewShot] rec check failed:', e));
+
+// Every read of `rec` goes through here, so none of them can beat the check
+// above: a Stop pressed on a stale popup is the one that used to win that race.
+async function getRec() {
+  await recChecked;
+  return (await chrome.storage.local.get('rec')).rec;
+}
+
 async function getOpts() {
```

Then the five reads become `getRec()` calls (nothing else in them changes):

- `background.js:467` — `const rec = await getRec();`
- `background.js:505` — `const rec = await getRec();`
- `background.js:526` — `const rec = await getRec();`
- `background.js:558` — `if (!(await getRec())) { … }`
- `background.js:634` — `const rec = await getRec();`

The two `remove('rec')` calls (`:513`, `:640`) and `startRecording`'s `set` (`:534`) are unchanged.

### 2. `background.js` — a message whose only job is to start the worker

In the router, after the `rec-failed` branch (`:27`):

```diff
@@ -25,6 +25,10 @@
   else if (msg?.type === 'rec-cap-hit') …
   else if (msg?.type === 'rec-failed') recFailed();
+  // The popup reads `rec` from storage without waking the worker, so a leftover
+  // key would go unnoticed for as long as the popup was the only thing running.
+  // This message exists to start the worker, which checks the key at every start.
+  else if (msg?.type === 'rec-check') { recChecked.then(() => sendResponse(true)); return true; }
 });
```

### 3. `popup.js` — poke the worker when the popup opens

Between `paintFromCache()` (`:208`) and `const startup = load()` (`:209`):

```diff
@@ -206,6 +206,11 @@
 paintFromCache(); // synchronous: correct UI in the first frame
+// Un-awaited, so it is not on the path to the first paint: this only starts the
+// worker, which checks `rec` against the offscreen document. If the key was a
+// leftover, the worker removes it and the storage listener above enables Record
+// and greys out Stop. Without this, nothing wakes the worker from here.
+chrome.runtime.sendMessage({ type: 'rec-check' }).catch(() => { /* a worker that can't answer has no recording either */ });
 const startup = load().catch(() => {
```

### 4. `tests/offscreen-lifecycle.test.js`

- `load()` (`:12-57`): capture the router so `rec-check` can be driven —
  `onMessage: { addListener(fn) { onMsg = onMsg || fn; }, removeListener() {} }` — and return `onMsg` as `send(msg)`.
- **Existing loads that mean "a recording is running" get a document**, which is what a live recording always has, and is what stops the new check from treating them as stale:
  - `:97` `load({ rec: { format: 'webm', filename: 'x' } })` → `load({ rec: { … }, hasDoc: true })`.
  - `:114` (the `ENDINGS` loop) `load({ rec: { … } })` → `load({ rec: { … }, hasDoc: true })`, so those two tests still prove the fired listener is what cleared the key.
- **Four new tests**, after the `ENDINGS` loop:
  1. "a recording with no offscreen document is forgotten at the next worker start" — `load({ rec, hasDoc: false })`, then `assert.strictEqual(await ctx.getRec(), undefined)`.
  2. "a running recording's key survives a worker start" — `load({ rec, hasDoc: true })`, then `assert.ok(await ctx.getRec())`.
  3. "Stop on a leftover recording doesn't message a document that isn't there" — `load({ rec, hasDoc: false })`, then `assert.strictEqual(await ctx.stopRecording(), false)` and no `rec-stop-offscreen` in `calls.sent`.
  4. "rec-check answers once the leftover key has been checked" — `send({ type: 'rec-check' }, {}, reply)` returns `true` to hold the port, and the reply arrives only after `getRec()` is empty.

### 5. The four popup harnesses

The startup poke is not what those tests are about, so each harness keeps it out of `sent` (this is what keeps `tests/capture-errors.test.js`'s ~25 exact `sent` assertions, `tests/region-dispatch.test.js:97` and `tests/region-cancel.test.js:216` unchanged), and the two non-async mocks become async so `.catch()` has a promise to attach to:

- `tests/defaults.test.js:65` — `runtime: { sendMessage: () => {} }` → `runtime: { sendMessage: async () => {} }`.
- `tests/region-cancel.test.js:197` — `sendMessage: (m) => sent.push(m)` → `sendMessage: async (m) => { if (m.type !== 'rec-check') sent.push(m); }`.
- `tests/capture-errors.test.js:282` — `sendMessage: async (m) => { sent.push(m); … }` → skip the push for `rec-check`.
- `tests/region-dispatch.test.js:70` — skip the push for `rec-check`, and count it in a new `checks` field the harness returns.

### 6. `tests/region-dispatch.test.js` — one new popup test

"the popup asks the worker to check a leftover recording when it opens": `loadPopup()`, `await settle()`, then `assert.strictEqual(p.checks, 1)`.

### Choices

- **Check the document rather than move `rec` to session storage.** Session storage has the right lifetime, but the popup reads `opts` and `rec` in one `chrome.storage.local.get` and `tests/defaults.test.js:209-210` requires that single call. This is also the fix direction the ticket names.
- **One check per worker start, behind one helper.** `getRec()` mirrors the existing `getOpts()` (`background.js:42`); no new abstraction, and it removes the race the ticket's own symptom depends on (a Stop pressed from a stale popup reaching `stopRecording` before the check has finished).
- **Ask about the document only when `rec` is set.** A worker start with no recording never calls `hasDocument()`, which keeps the harnesses that have no `chrome.offscreen` working.
- **The popup gets one message, not new state.** Its existing `storage.local.onChanged` listener (`popup.js:190-195`) already fixes both Stop and Record when the key goes, which is what comment 1 asks for.
- **No badge write in the check.** After a disable and re-enable Chrome has already cleared the badge; `flashBadge()` reading through `getRec()` covers comment 2.
- **Cost:** the worker now starts when the popup opens. It already started on every capture click, and the message is un-awaited, so it is not on the path to the popup's first paint.
- **No README, manifest or version change.** No new permission is needed; `offscreen` is already in `manifest.json`.

## Steps

1. Make the `background.js` changes (sections 1 and 2).
   → verify: `npm test` runs 241 tests with exactly one failure, "leaves the document alone while a recording is running" in `tests/offscreen-lifecycle.test.js`, which loads a recording with no document. The two `ENDINGS` tests keep passing, but for the wrong reason: the check now clears the key before the event they fire does. Section 4 gives all three a document, which is what puts those two back to testing their own listener.
2. Make the `tests/offscreen-lifecycle.test.js` changes (section 4).
   → verify: `npm test` runs 245 tests; the three from step 1 pass again, and the four new ones pass.
3. Make the `popup.js` change (section 3) and the harness changes (sections 5 and 6).
   → verify: `npm test` passes 246 tests. Run step 3's harness changes before the `popup.js` change too, if a failing-first check is wanted: the new region-dispatch test is then the only failure.
4. Check the ticket's own case in Chrome 152, repo loaded unpacked, using the headless setup in `docs/KAN-294-plan.md` step 3 (download directory set in `Default/Preferences`, one warm-up popup first).
   - Start a WebM recording from a popup on an http page, close the popup, then `chrome.management.setEnabled(id, false)` and `setEnabled(id, true)`.

   → verify, with no other action in between:
   - a new popup shows **Stop disabled and Record usable** (comment 1);
   - `rec` is gone from `chrome.storage.local`;
   - pressing Stop is a no-op, with no `Could not establish connection` in the worker's console;
   - a Visible capture with "Copy to clipboard" on leaves no offscreen document open;
   - a screenshot that fails flashes `!` and ends on an empty badge, not `REC` (comment 2).
5. Check that a real recording is untouched.
   → verify: Record → Stop saves a `.webm`, the badge shows `REC` throughout, and a recording that spans a worker restart (leave it running past the idle timeout, then Stop) still saves.
6. Check that nothing else changed.
   → verify: `git status --short` lists only `background.js`, `popup.js`, the five test files and this plan.

## Checked in Chrome 152.0.7977.83

Headless, `--remote-debugging-pipe --enable-unsafe-extension-debugging`, a fresh profile with `download.default_directory` set in `Default/Preferences`, one warm-up popup, and the extension loaded with `Extensions.loadUnpacked`. A WebM recording was started from the popup on a local http page, its popup was closed, and the extension was then disabled and enabled again with `chrome.management.setEnabled` from chrome://extensions. Three copies were run through the same driver.

| After the re-enable | unchanged (`db24856`) | this change |
| --- | --- | --- |
| Popup Stop | enabled | **disabled** |
| Popup Record | greyed out | **usable** |
| `rec` in storage | still set | **gone** |
| Badge | empty | empty |
| Clipboard copy left a document open | yes | **no** |
| `stopRecording()` | returned `true`, stopping a recording that wasn't running | **returned `false`** |

- **While recording, both copies:** `rec` set, an offscreen document open, badge `REC`.
- **A recording still works afterwards, both copies:** Record then Stop saved a `.webm`.
- **A recording that outlives its worker, both copies:** with the recording running, the service worker target was closed. The document stayed, the popup still showed Stop enabled, and Stop saved a second `.webm`. The check keeps a key whose document is there.
- **The popup's poke was not what fixed it here.** Chrome started the worker itself when the extension was enabled again — the worker target was running before any popup was opened — so a third copy, with the worker check but without the `popup.js` line, gave the same results as the full change in every row above. The poke costs one un-awaited message and removes the fix's dependence on Chrome starting the worker at enable; it is the only part of this change that isn't load-bearing in this build.

## Open questions

1. **Should the popup check for itself instead of waking the worker?** If `chrome.offscreen.hasDocument()` is available in a popup, `load()` could fold it into its existing `Promise.all` and gate Stop on `stored.rec && hasDoc`, with no message and no worker start on every popup open. Whether the `chrome.offscreen` API is exposed outside the service worker isn't documented clearly enough to plan on, and it isn't used outside the worker anywhere in this repo. The plan takes the message route, which is certain to work; if the API is available, step 3 could be replaced by the smaller popup-side check.
2. **Should a leftover key also clear a stale `REC` badge?** The ticket reports the badge as already empty after a re-enable, so the check only removes the key. If some other path can leave `REC` showing with no document, the badge would stay wrong until the next `flashBadge()`.
