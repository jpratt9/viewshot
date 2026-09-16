# KAN-308: An open popup keeps Stop enabled and Record greyed out after a recording ends on its own

Ticket: https://prattsolutions.atlassian.net/browse/KAN-308 (To Do, no comments, labels `bug` and `viewshot`). Its only blocker, KAN-215, is Done.

## What the repo does now

Line numbers are from `1d550fc`, with a clean working tree. They match the ticket's, which were taken from the uncommitted KAN-215 change that `1d550fc` shipped.

- **Popup**
  - **`load()`** (`popup.js:47-60`) reads `opts` and `rec` with one `chrome.storage.local.get` call (`:53`). It then sets Stop from `rec` (`:58`) and calls `apply()` (`:59`), which runs `toggleRec()`. `toggleRec()` greys Record out while Stop is enabled (`popup.js:89`).
  - **Stop's state is set in three places only:**
    - `load()` (`:58`);
    - a press of Record (`:119`);
    - a press of Stop (`:161`).
  - **Record's state is set only when `toggleRec()` runs**, which happens from:
    - `apply()` (`:32`);
    - a failed `getMediaStreamId` (`:114`);
    - a press of Stop (`:161`);
    - a format change (`:163`).
  - **`popup.js` doesn't listen for anything.** It has no `chrome.storage.onChanged` listener and no `chrome.runtime.onMessage` listener.
- **The worker removes `rec` without the popup's Stop** in three cases:
  - **The capture track ends:** the offscreen document sends `rec-stop` (`offscreen.js:54`). The worker then runs `stopRecording` (`background.js:13`, `:478-487`), which removes `rec` at `:484`.
  - **A GIF reaches its frame cap:** the offscreen document sends `rec-cap-hit` (`offscreen.js:90`). The worker runs the same `stopRecording` and then flashes `MAX` (`background.js:14`).
  - **A start fails in the offscreen document:** `onRecError` sends `rec-failed` (`offscreen.js:181`). The worker removes `rec` and flashes `!` (`background.js:15`).

  After any of these, pressing Stop only logs `[ViewShot] stop with no active recording` (`background.js:481`).
- **Reproduced in headless Chrome 152.0.7977.83** while planning (the setup is under "Checked while planning"). In all three cases, `rec` was gone and the badge had changed, but the open popup still showed Record greyed out and Stop enabled:
  - **Recorded tab closed:** a WebM recording was running on PageA, and a popup was open on PageB. After PageA was closed, `PageA.webm` was saved.
  - **GIF frame cap:** a GIF recording was started from a popup, and that popup stayed open. After 62 s, `rec` was gone, the badge showed `MAX`, and `PageB.gif` was saved.
  - **Failed start:** in the popup page, `chrome.tabCapture.getMediaStreamId` was replaced with a function that returns an id `getUserMedia` refuses. After Record was pressed, the offscreen document logged `[ViewShot] recording failed: AbortError: Error starting tab capture`, `rec` was gone, and the badge showed `!`.
- **Tests:** `npm test` passes 156 tests.
  - **Four harnesses load `popup.js`:**
    - `loadPopup` in `tests/capture-errors.test.js` (`:236-283`);
    - `loadPopup` in `tests/region-dispatch.test.js` (`:33-86`);
    - `loadPopup` in `tests/region-cancel.test.js` (`:169-208`);
    - `bootPopup` in `tests/defaults.test.js` (`:39-80`).
  - **Their storage fakes** have only `local.get` and `local.set`: `tests/capture-errors.test.js:267`, `tests/region-dispatch.test.js:60-67`, `tests/region-cancel.test.js:194`, `tests/defaults.test.js:51-61`.
  - No test changes storage while the popup is open.

## Change

Five files change: `popup.js` and four test files. The diffs below were applied and tested on a copy (see "Checked while planning").

1. **`popup.js`:** after the Stop listener (`:161`), add a `chrome.storage.local.onChanged` listener. When `rec` changes, it sets Stop from the new value and calls `toggleRec()`, so Record follows.

   ```diff
   @@ -159,6 +159,15 @@
    });
    
    $('stopBtn').addEventListener('click', () => { if ($('stopBtn').disabled) return; chrome.runtime.sendMessage({ type: 'rec-stop' }); $('stopBtn').disabled = true; toggleRec(); });
   +// A recording can also end without this Stop: the recorded tab closes, a GIF
   +// reaches its frame cap, or the start fails in the offscreen document. The
   +// worker removes `rec` then, so follow the key rather than only reading it in
   +// load().
   +chrome.storage.local.onChanged.addListener((changes) => {
   +  if (!('rec' in changes)) return;
   +  $('stopBtn').disabled = !changes.rec.newValue;
   +  toggleRec();
   +});
    
    $('format').addEventListener('change', () => { toggleQuality(); toggleRec(); save(); });
    $('quality').addEventListener('input', () => { $('qualityVal').textContent = Math.round($('quality').value * 100) + '%'; });
   ```

2. **`tests/capture-errors.test.js`:**
   - **`loadPopup()`** (`:236-283`) keeps the listener that `popup.js` registers, and returns `stored(changes)` to call it.
   - **A new section at the end** (after `:793`) with three tests:
     - "an open popup gives Record back when the recording ends on its own"
     - "an open popup gives Record back when its start fails in the offscreen document"
     - "a settings change leaves an open popup's Stop and Record alone"

   ```diff
   @@ -236,6 +236,7 @@
    function loadPopup(url, { fileAccess = true, streamIdFails = false, store = {} } = {}) {
      const els = {};
      const sent = [];
   +  let onStored; // popup.js's chrome.storage.local.onChanged listener
      const makeEl = () => {
        const el = {
          style: {}, dataset: {}, listeners: {},
   @@ -264,7 +265,12 @@
        },
        chrome: {
          tabs: { query: async () => [{ id: 1, url, title: 'T' }], create: () => {} },
   -      storage: { local: { get: async () => store, set: async () => {} } }, // `opts` and `rec`
   +      storage: {
   +        local: {
   +          get: async () => store, set: async () => {}, // `opts` and `rec`
   +          onChanged: { addListener: (fn) => { onStored = fn; } },
   +        },
   +      },
          runtime: { sendMessage: async (m) => { sent.push(m); return true; } },
          tabCapture: { getMediaStreamId: async () => { if (streamIdFails) throw new Error('stream id refused'); return 'sid'; } },
          extension: { isAllowedFileSchemeAccess: async () => fileAccess }, // "Allow access to file URLs"
   @@ -279,6 +285,7 @@
        ready: settle, // let load() resolve so activeTab is populated
        click: (mode) => btn(mode).listeners.click[0](),
        stop: () => els.stopBtn.listeners.click[0](),
   +    stored: (changes) => onStored?.(changes), // storage changing while the popup is open
      };
    }
    
   @@ -791,3 +798,39 @@
      assert.strictEqual(vm.runInContext('rec', o.ctx), running, 'the GIF\'s frame timer now reads the new recording');
      assert.strictEqual(o.recorders.length, 0, 'a second recording was started');
    });
   +
   +// --- a recording that ends while the popup is open --------------------------
   +// The popup read `rec` once, when it opened. A recording can end without its
   +// Stop - the recorded tab closes, a GIF reaches its frame cap, a start fails in
   +// the offscreen document - and the worker removes `rec` then, but an open
   +// popup kept Stop enabled and Record greyed out until it was opened again.
   +
   +test('an open popup gives Record back when the recording ends on its own', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
   +  await p.ready();
   +  p.stored({ rec: { oldValue: RUNNING } }); // stopRecording removed it
   +  assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop stayed enabled with nothing recording');
   +  assert.strictEqual(p.btn('visible').disabled, false, 'Record stayed greyed out with nothing recording');
   +  await p.click('visible');
   +  assert.deepStrictEqual(p.sent.map((m) => m.type), ['rec-start']);
   +});
   +
   +test('an open popup gives Record back when its start fails in the offscreen document', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
   +  await p.ready();
   +  await p.click('visible');
   +  p.stored({ rec: { newValue: RUNNING } }); // the worker marks it as running
   +  assert.strictEqual(p.els.stopBtn.disabled, false);
   +  assert.strictEqual(p.btn('visible').disabled, true);
   +  p.stored({ rec: { oldValue: RUNNING } }); // then rec-failed removes it
   +  assert.strictEqual(p.els.stopBtn.disabled, true, 'Stop stayed enabled after the start failed');
   +  assert.strictEqual(p.btn('visible').disabled, false, 'Record stayed greyed out after the start failed');
   +});
   +
   +test('a settings change leaves an open popup\'s Stop and Record alone', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
   +  await p.ready();
   +  p.stored({ opts: { newValue: { format: 'webm' } } }); // save() after a control changes
   +  assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
   +  assert.strictEqual(p.btn('visible').disabled, true, 'Record came back mid-recording');
   +});
   ```

3. **The other three popup harnesses** each get `onChanged: { addListener() {} }` in their `chrome.storage.local` fake. Without it, `popup.js` throws "Cannot read properties of undefined (reading 'addListener')" as soon as it loads.
   - `tests/region-dispatch.test.js`:

     ```diff
     @@ -64,6 +64,7 @@
                return out;
              },
              set: async (o) => Object.assign(store, o),
     +        onChanged: { addListener() {} },
            },
          },
          runtime: { sendMessage: (msg) => { sent.push(msg); return ack; } },
     ```

   - `tests/region-cancel.test.js`:

     ```diff
     @@ -191,7 +191,7 @@
          },
          chrome: {
            tabs: { query: async () => [TAB], create: () => {} },
     -      storage: { local: { get: async () => ({}), set: async () => {} } },
     +      storage: { local: { get: async () => ({}), set: async () => {}, onChanged: { addListener() {} } } },
            runtime: { sendMessage: (m) => sent.push(m) },
            tabCapture: { getMediaStreamId: async () => 'sid' },
          },
     ```

   - `tests/defaults.test.js`:

     ```diff
     @@ -58,6 +58,7 @@
                return out;
              },
              set: async (o) => Object.assign(store, o),
     +        onChanged: { addListener() {} },
            },
          },
          runtime: { sendMessage: () => {} },
     ```

Choices:

- **The popup follows the `rec` key, not the messages that end a recording.**
  - `rec` is what `load()` already reads for Stop, and all three cases end with the worker removing it.
  - `rec-stop`, `rec-cap-hit` and `rec-failed` come from the offscreen document before the worker has acted on them. A popup that listened to those messages would be copying the worker's handling of them.
- **It uses `chrome.storage.local.onChanged`, not `chrome.storage.onChanged`.**
  - The extension only uses local storage, so the listener doesn't have to check which storage area changed.
  - `StorageArea.onChanged` is in Chrome 73 and later, and the extension already relies on `chrome.offscreen.hasDocument` (Chrome 116).
- **The listener ignores changes to other keys.**
  - `save()` writes `opts` whenever a control changes (`popup.js:72-76`), including during a recording. The listener returns early unless `rec` changed.
  - "a settings change leaves an open popup's Stop and Record alone" covers this.
- **It follows `rec` being written, too.** Record goes back to greyed out when the worker writes the key. That's what the failed-start case needs: the worker writes `rec` before the offscreen document fails, then removes it.
  - A side effect: a popup opened just before the worker writes `rec` now greys Record out once the key appears. `docs/KAN-215-plan.md` noted that gap. It wasn't checked in Chrome.
- **The popup still enables Stop as soon as Record is pressed** (`popup.js:119`).
  - If a start fails before the worker writes `rec` (for example, the tab has closed), nothing changes in storage, and Stop stays enabled.
  - The ticket leaves that case to KAN-216, so this plan doesn't touch it.
- **The tests go in `tests/capture-errors.test.js`**, next to KAN-215's popup tests, and use its `RUNNING` constant.
  - The other three popup harnesses only need a stand-in for the listener.
- **No README, manifest or version change.**
  - The `storage` permission is already in the manifest.
  - Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **As it is now:** `npm test` passes 156 tests.
  - **Test changes only:** 159 tests run. 157 pass, and exactly two of the new ones fail (listed in step 1).
  - **Both changes:** 159 tests pass.
  - **Both changes, with one piece left out:**
    1. **No check that `rec` changed:** only "a settings change leaves an open popup's Stop and Record alone" fails, with "TypeError: Cannot read properties of undefined (reading 'newValue')".
    2. **No `toggleRec()` in the listener:** only the two "gives Record back" tests fail, each with "Record stayed greyed out…".
    3. **The `popup.js` change without the other three harness changes:** 18 tests fail with "TypeError: Cannot read properties of undefined (reading 'addListener')".
- **Headless Chrome 152.0.7977.83,** comparing a copy with only the test changes ("unchanged") against a copy with both changes ("changed"):
  - **Setup:**
    - the setup under "Checked while planning" in `docs/KAN-215-plan.md`: format and Name set in the popup, and buttons clicked with `Runtime.evaluate` and `userGesture: true`;
    - a `MutationObserver` in the popup page that records each change to Stop's `disabled` attribute;
    - Name `{title}`.
  - **Results:** in each case, the popup stayed open while the recording ended.

    | Case | Unchanged | Changed |
    |---|---|---|
    | WebM recording on PageA, popup open on PageB, then PageA closed with `Target.closeTarget` | `rec` removed, and `PageA.webm` saved. The popup still shows Record greyed out and Stop enabled. Stop never changed | `rec` removed, and `PageA.webm` saved. The popup shows Record enabled and Stop disabled. Stop changed once: disabled |
    | Popup on PageB records a GIF and stays open until the frame cap | After 62 s, `rec` removed, the badge showed `MAX`, and `PageB.gif` was saved. The popup still shows Record greyed out and Stop enabled. Stop changed once: enabled, by the press | After 61 s, the same, except the popup shows Record enabled and Stop disabled. Stop changed twice: enabled, then disabled |
    | Popup on PageB, with `getMediaStreamId` replaced by one that returns an id `getUserMedia` refuses, presses Record | The offscreen document logged `recording failed: AbortError: Error starting tab capture`, `rec` was removed, and the badge showed `!`. The popup still shows Record greyed out and Stop enabled | The same log, `rec` removal and badge. The popup shows Record enabled and Stop disabled. Stop changed twice: enabled, then disabled |

  - **KAN-215's check** (step 3 of `docs/KAN-215-plan.md`), run again on the changed copy, gave the same results as in that plan, with no errors from the worker or the offscreen document.
  - **Not checked in Chrome:**
    - A popup opened just before the worker writes `rec`.
    - Chrome's own "Stop sharing" button. Closing the tab ends the same capture track, and its `ended` event is what sends `rec-stop` (`offscreen.js:54`).

## Steps

1. Make the four test-file changes above.
   → verify: `npm test` runs 159 tests. 157 pass, and only these two new tests fail:
   - "an open popup gives Record back when the recording ends on its own", with "Stop stayed enabled with nothing recording"
   - "an open popup gives Record back when its start fails in the offscreen document", with "Stop stayed enabled after the start failed"
2. Make the `popup.js` change above.
   → verify: `npm test` passes 159 tests: the 156 existing ones plus the three new ones.
3. Check the change in Chrome 152, with the repo loaded unpacked.
   - **Setup:** the headless setup under "Checked while planning", with a `MutationObserver` on Stop's `disabled` attribute in the popup page.

   → verify: in each case below, the popup that is still open ends up with Record enabled and Stop disabled, and Stop's last recorded change is "disabled".
   - **Recorded tab closed:** close the recorded tab while a popup is open on another tab. The recording is still saved.
   - **GIF frame cap:** let a GIF reach its frame cap (about a minute) with its popup open. The badge shows `MAX`, and the GIF is saved.
   - **Failed start:** replace `getMediaStreamId` in the popup page with one that returns an id `getUserMedia` refuses, then press Record. The offscreen document logs `recording failed`, and the badge shows `!`.

   Then run KAN-215's check again. Its results don't change.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/capture-errors.test.js`, `tests/region-dispatch.test.js`, `tests/region-cancel.test.js`, `tests/defaults.test.js` and this plan.

## Noticed while planning, not changed

- **`load()` can apply an older `rec` than the listener did.**
  - **When:** `rec` changes after `load()` has read it (`popup.js:53`) but before `load()` applies it (`popup.js:58`), and the change event arrives in between.
  - **What happens:** the listener applies the new value first, and then `load()` applies the older one.
  - **How likely:** the window is the one storage read and one tab query that `load()` waits on as the popup opens. It wasn't seen in Chrome.

## Open questions

None.

- The ticket names the gap: nothing in the popup watches `rec` after it opens. It also names the three ways a recording ends without Stop, and each of them removes `rec`.
- It leaves the popup enabling Stop before it knows whether the start worked to KAN-216, and this plan doesn't change that.
