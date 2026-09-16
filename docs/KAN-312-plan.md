# KAN-312: The popup can show an older recording state when rec changes while it is opening

Ticket: https://prattsolutions.atlassian.net/browse/KAN-312 (To Do, one comment, labels `bug` and `viewshot`). Its only blocker, KAN-308, is Done.

The comment (John Pratt) says:
- KAN-308 shipped in `4728bb0` on `main`, and CI passed.
- The description's line numbers still match that commit.
- It was decided on KAN-308 that this window stays with this ticket.

## What the repo does now

Line numbers are from `4728bb0`, with a clean working tree. They match the ticket's.

- **`load()`** (`popup.js:47-60`):
  - waits for `chrome.tabs.query` and `chrome.storage.local.get(['opts', 'rec'])` together (`:51-54`);
  - then always sets Stop from the `rec` it read (`:58`);
  - then calls `apply()` (`:59`). `apply()` runs `toggleRec()` (`:32`), which greys Record out while Stop is enabled (`:89`).
- **The storage listener** (`popup.js:166-170`), added by KAN-308:
  - sets Stop from each new `rec` value (`:168`) and calls `toggleRec()`;
  - ignores changes to other keys (`:167`);
  - leaves nothing that `load()` can check.
- **So `load()` undoes a `rec` change that arrives while it waits.** The listener applies the change, and then `load()` sets Stop from the older value it read. The popup keeps that state until `rec` changes again or the popup is reopened.
- **Reproduced in headless Chrome 152.0.7977.83** while planning. The setup is under "Checked while planning". The popup's tab query was held back 3 s so the window could be hit. Times are from when the popup's script started.
  - **A recording ends while the popup opens:**
    - A WebM recording was running on PageA, and a popup was opening on PageB.
    - PageA was closed during the wait. At 0.45 s, `rec` was removed and the listener set Stop to disabled.
    - At 3 s, `load()` enabled Stop and greyed Record out again.
    - The popup stayed that way, although `rec` was gone, the badge was clear and `PageA.webm` had been saved.
  - **A recording starts while the popup opens:**
    - Nothing was recording, and a popup was opening on PageB.
    - `rec` was written from the worker during the wait. At 0.42 s, the listener enabled Stop and greyed Record out.
    - At 3 s, `load()` disabled Stop and enabled Record again, although `rec` was still set.
- **Tests:** `npm test` passes 159 tests.
  - **`loadPopup`** in `tests/capture-errors.test.js` (`:236-290`):
    - keeps the listener (`:239`, `:271`) and returns `stored(changes)` to call it (`:288`);
    - fakes `tabs.query` and `storage.local.get` so they resolve at once (`:267`, `:270`). `load()` still doesn't continue until the test awaits `ready()` (`:285`).
  - **KAN-308's three tests** (`:808`, `:818`, `:830`) all change storage after `await p.ready()`, once `load()` has finished. No test changes storage while `load()` waits.
  - **`tests/defaults.test.js:192-196`** requires `load()` to read storage in one call.

## Change

Two files change: `popup.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy (see "Checked while planning").

1. **`popup.js`:**
   - Add a `recChanged` flag next to `activeTab` (`:4`).
   - The storage listener sets the flag once it has checked that `rec` changed (`:167-168`).
   - `load()` sets Stop from its read only while the flag is unset (`:58`).
   - `apply()` still runs in full, so Record follows whichever value set Stop.

   ```diff
   @@ -2,6 +2,7 @@
    const $ = (id) => document.getElementById(id);
    const isRecFmt = (f) => f === 'webm' || f === 'mp4' || f === 'gif';
    let activeTab = null;
   +let recChanged = false; // the storage listener at the bottom has seen `rec` change
    
    const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };
    
   @@ -54,8 +55,10 @@
      ]);
      [activeTab] = tabs;
      // The Stop button stays greyed out unless a recording is actually running.
   -  // Set before apply(), whose toggleRec() greys Record out from it.
   -  $('stopBtn').disabled = !stored.rec;
   +  // Set before apply(), whose toggleRec() greys Record out from it. Skipped if
   +  // `rec` changed while this function waited: the storage listener has already
   +  // set Stop from that change, which can be newer than `stored.rec`.
   +  if (!recChanged) $('stopBtn').disabled = !stored.rec;
      apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
    }
    
   @@ -165,6 +168,7 @@
    // load().
    chrome.storage.local.onChanged.addListener((changes) => {
      if (!('rec' in changes)) return;
   +  recChanged = true;
      $('stopBtn').disabled = !changes.rec.newValue;
      toggleRec();
    });
   ```

2. **`tests/capture-errors.test.js`:** add a new section at the end (after `:836`) with three tests:
   - "an opening popup keeps a recording end that lands before load() finishes"
   - "an opening popup keeps a recording start that lands before load() finishes"
   - "a settings change while the popup is opening leaves load() to set Stop and Record"

   Each test changes storage as soon as `loadPopup()` returns. By then `load()` has read storage but hasn't continued. `loadPopup()` itself doesn't change.

   ```diff
   @@ -834,3 +834,33 @@
      assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
      assert.strictEqual(p.btn('visible').disabled, true, 'Record came back mid-recording');
    });
   +
   +// --- a recording change that lands while the popup is opening ---------------
   +// load() waits on a storage read and a tab query. When `rec` changed after the
   +// read, the storage listener applied the change, and then load() set Stop from
   +// the older value it had read. The popup kept that state until `rec` changed
   +// again or the popup was reopened.
   +
   +test('an opening popup keeps a recording end that lands before load() finishes', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
   +  p.stored({ rec: { oldValue: RUNNING } }); // removed after load() read it, before load() went on
   +  await p.ready();
   +  assert.strictEqual(p.els.stopBtn.disabled, true, 'load() enabled Stop for a recording that had ended');
   +  assert.strictEqual(p.btn('visible').disabled, false, 'load() greyed Record out for a recording that had ended');
   +});
   +
   +test('an opening popup keeps a recording start that lands before load() finishes', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' } } });
   +  p.stored({ rec: { newValue: RUNNING } }); // written after load() read it, before load() went on
   +  await p.ready();
   +  assert.strictEqual(p.els.stopBtn.disabled, false, 'load() greyed Stop out while a recording was running');
   +  assert.strictEqual(p.btn('visible').disabled, true, 'load() left Record enabled over a running recording');
   +});
   +
   +test('a settings change while the popup is opening leaves load() to set Stop and Record', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
   +  p.stored({ opts: { newValue: { format: 'webm' } } }); // save() before load() went on
   +  await p.ready();
   +  assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
   +  assert.strictEqual(p.btn('visible').disabled, true, 'Record came back mid-recording');
   +});
   ```

Choices:

- **A flag, not a second read.**
  - Reading `rec` again after the wait would only move the window.
  - It would also break "reads storage once, not once per key" (`tests/defaults.test.js:192-196`).
  - The flag adds no round trip.
- **The listener stays where it is, registered before `load()` runs.** If `load()` registered it after the read, a change in between would be missed completely. That was the gap KAN-308 closed.
- **Any `rec` change sets the flag, even one made before the read.** In that case the read and the event carry the same value, so skipping `load()`'s write changes nothing. A later change arrives as a later event.
- **The flag is set after the listener checks for `rec`, not before.**
  - `save()` writes `opts` whenever a control changes (`popup.js:72-76`).
  - The controls work before `load()` finishes, because `paintFromCache()` fills them in first (`:41-45`).
  - If an `opts` change set the flag, `load()` would leave Stop in its HTML default (disabled) while a recording runs.
  - "a settings change while the popup is opening leaves load() to set Stop and Record" covers this.
- **The `opts` half of the read isn't changed.** See "Noticed while planning, not changed".
- **The flag sits next to `activeTab`** (`popup.js:4`), the file's only other variable.
- **No test harness changes.**
  - `loadPopup()` already gives tests the listener.
  - Its fakes resolve without letting `load()` continue, so a test can change storage in between.
  - The other three popup harnesses already have a stand-in `onChanged` (`tests/region-dispatch.test.js`, `tests/region-cancel.test.js`, `tests/defaults.test.js`).
- **No README, manifest or version change.** Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **As it is now:** `npm test` passes 159 tests.
  - **Test changes only:** 162 tests run. 160 pass, and exactly two of the new ones fail (listed in step 1).
  - **Both changes:** 162 tests pass.
  - **Both changes, with one piece left out:**
    1. **The listener sets the flag, but `load()` doesn't check it:** only the two "an opening popup keeps…" tests fail.
    2. **`load()` checks the flag, but the listener never sets it:** only the same two tests fail.
    3. **The flag is set before the listener checks for `rec`:** only "a settings change while the popup is opening leaves load() to set Stop and Record" fails.
- **Headless Chrome 152.0.7977.83,** comparing a copy with only the test changes ("unchanged") against a copy with both changes ("changed"):
  - **Setup:**
    - The headless setup from step 3 of `docs/KAN-217-plan.md`:
      - `--headless=new --remote-debugging-pipe --enable-unsafe-extension-debugging`;
      - a temporary profile with `download.default_directory` set;
      - `Extensions.loadUnpacked`, `Target.createTarget({ url, forTab: true })` and `Extensions.triggerAction`;
      - one warm-up popup.
    - **Pages:** two local http pages, PageA and PageB.
    - **Clicks:** buttons were clicked with `Runtime.evaluate` and `userGesture: true`, as in `docs/KAN-308-plan.md`.
    - **Widening the window:** in each copy, `popup.html` loaded one extra script just before `popup.js`. Its core:

      ```js
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (...a) => new Promise((r) => setTimeout(() => r(query(...a)), 3000));
      ```

      So `load()` waited 3 s after its storage read had finished. The script also recorded, in the popup, when:
      - the read finished;
      - the tab query was released;
      - each `rec` change event arrived;
      - Stop's or Record's `disabled` was set.
    - **Why not a script added over CDP:** Chrome attached the action popup when it was already running (`waitingForDebugger: false`), so `Page.addScriptToEvaluateOnNewDocument` came too late.
    - **The recording on PageA** was started with format WebM and Name `{title}`, from a popup that had already finished loading.
    - **Each change** was made about 0.5 s after the popup opened, once its storage read had finished.
  - **Results:** times are from when the popup's script started.

    | Case | Unchanged | Changed |
    |---|---|---|
    | Popup on PageB opens while PageA records. Nothing changes `rec`, and Name is edited during the wait | At 3 s, `load()` enables Stop and greys Record out, which matches storage | The same |
    | Popup on PageB opens while PageA records, and PageA is closed during the wait | At 0.45 s, `rec` is removed and the listener sets Stop to disabled. At 3 s, `load()` enables Stop and greys Record out again. The popup ends with Stop enabled and Record greyed out. `rec` is gone, the badge is clear, and `PageA.webm` is saved | At 0.53 s, `rec` is removed and the listener sets Stop to disabled. At 3 s, `load()` leaves Stop alone. The popup ends with Stop disabled and Record enabled. `rec` is gone, the badge is clear, and `PageA.webm` is saved |
    | Popup on PageB opens with nothing recording, and `rec` is written from the worker during the wait | At 0.42 s, the listener enables Stop and greys Record out. At 3 s, `load()` disables Stop and enables Record again, although `rec` is set | At 0.48 s, the listener enables Stop and greys Record out. At 3 s, `load()` leaves Stop alone, and Record stays greyed out. When `rec` is removed again, the popup shows Stop disabled and Record enabled |

  - Neither copy logged a console error in the worker, the offscreen document or the popup.
  - **Not checked in Chrome:**
    - **The window at its real width** (one storage read and one tab query). The race wasn't hit without the delay.
    - **A real recording starting while the popup opens.** `rec` was written from the worker directly, in the shape `startRecording` writes it (`background.js:401`).

## Steps

1. Make the `tests/capture-errors.test.js` change above.
   → verify: `npm test` runs 162 tests. 160 pass, and only these two new tests fail:
   - "an opening popup keeps a recording end that lands before load() finishes", with "load() enabled Stop for a recording that had ended"
   - "an opening popup keeps a recording start that lands before load() finishes", with "load() greyed Stop out while a recording was running"
2. Make the `popup.js` change above.
   → verify: `npm test` passes 162 tests: the 159 existing ones plus the three new ones.
3. Check the change in Chrome 152.
   - **Setup:** the headless setup under "Checked while planning". Load a copy of the repo whose `popup.html` loads the 3 s delay script before `popup.js`. The delay script never goes into the repo.

   → verify:
   - **PageA closed while a popup on PageB waits:** the popup ends with Stop disabled and Record enabled, and `PageA.webm` is saved.
   - **`rec` written while a popup waits:** the popup ends with Stop enabled and Record greyed out.
   - **Nothing changes while a popup waits:** Stop and Record match `rec`.
   - No console errors in the worker, the offscreen document or the popup.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **`load()` can also undo a settings change made while the popup opens.**
  - **When:** a control is changed after `load()` has read `opts` but before `load()` continues. `save()` stores the new value (`popup.js:72-76`), and then `apply()` (`:59`) puts the older value back in the form.
  - **Seen in headless Chrome** with the 3 s delay, in both copies:
    - Name was changed to `{title}-renamed` during the wait.
    - After `load()` finished, the form showed `{title}`, but storage had `{title}-renamed`.
  - **What happens next:** the next capture or recording uses the form's values (`popup.js:100`) and saves them back (`:117`, `:140`). So the edit is lost without any message.
  - **How likely:** the control has to be changed during the one storage read and one tab query.

## Open questions

None.

- The ticket names the window and the lines involved, and the comment keeps that window in this ticket.
- A recording ending and a recording starting while the popup opens both go wrong at the same line (`popup.js:58`), so the change covers both.
