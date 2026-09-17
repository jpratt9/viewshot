# KAN-323: The popup can undo a settings change made while it is opening

Ticket: https://prattsolutions.atlassian.net/browse/KAN-323 (To Do, one comment, labels `bug` and `viewshot`). Its only blocker, KAN-312, is Done.

The comment (John Pratt) says:
- KAN-312 shipped in `24e3b0c` on `main`, and CI passed.
- The description's line numbers match that commit.
- It was decided on KAN-312 that this settings window belongs to this ticket.

## What the repo does now

Line numbers are from `24e3b0c`, with a clean working tree. They match the ticket's.

- **The form is filled in twice as the popup opens:**
  - **`paintFromCache()`** (`popup.js:42-46`) fills it right away from the `localStorage` copy of `opts`.
  - **`load()`** (`popup.js:48-63`) then waits for `chrome.tabs.query` and `chrome.storage.local.get(['opts', 'rec'])` together (`:52-55`). It sets Stop (`:61`) and always calls `apply()` with the `opts` it read (`:62`).
- **`apply()`** (`popup.js:25-34`) writes every control's value, then runs `toggleQuality()` (`:32`) and `toggleRec()` (`:33`).
- **The controls work before `load()` finishes.**
  - Changing Format runs `toggleQuality()`, `toggleRec()` and `save()` (`popup.js:176`). Quality, Name and the two checkboxes run `save()` (`:178-181`).
  - `save()` (`popup.js:75-79`) writes the whole form to the `localStorage` copy and to `chrome.storage.local`.
  - A press of a mode button calls `save()` too (`:120`, `:143`).
- **Nothing tells `load()` that `save()` ran.**
  - The storage listener returns early unless `rec` changed (`popup.js:170`).
  - `recChanged` (`:5`) is only about `rec`.
  - So a setting saved while `load()` waits is put back to the older stored value by `apply()`, and storage keeps the new one. The next capture or recording reads the form (`popup.js:103`) and saves it back (`:120`, `:143`), and the edit is lost.
- **Reproduced in headless Chrome 152.0.7977.83** while planning. The setup is under "Checked while planning". The popup's tab query was held back 3 s, and each edit was made once the popup's storage read had finished.
  - **Name edited during the wait:** after `load()`, the form showed `{title}`, but storage had `{title}-renamed`.
  - **Format switched from PNG to JPG during the wait:** after `load()`, the form showed PNG with the Quality row hidden, but storage had JPG.
  - **Name edited during the wait while PageA was recording:** the form showed `{title}`, but storage had `{title}-renamed`. Stop was enabled and Record was greyed out.
- **Tests:** `npm test` passes 162 tests.
  - **`bootPopup`** in `tests/defaults.test.js` (`:39-81`):
    - runs `popup.js` without letting `load()` continue;
    - keeps each element's listeners (`makeEl`, `:26-35`);
    - stores what `set` is given (`:60`);
    - has `settle()` to let `load()` finish (`:79`).
  - **The form tests there** only edit after `load()` has finished. "mirrors settings to the synchronous cache on save" (`:184-190`) is one example. "chrome.storage wins over a stale cache once it resolves" (`:198-201`) checks that `load()` replaces the cached values with storage.
  - **The KAN-312 test** "a settings change while the popup is opening leaves load() to set Stop and Record" (`tests/capture-errors.test.js:860-866`) fires a storage event for `opts`, not `save()`, and checks only Stop and Record.
  - **No test saves a setting before `load()` finishes.**

## Change

Three files change: `popup.js`, `tests/defaults.test.js` and `tests/capture-errors.test.js`. The diffs below were applied and tested on a copy (see "Checked while planning").

1. **`popup.js`:**
   - Add an `optsSaved` flag next to `recChanged` (`:5`).
   - `save()` sets the flag (`:75-76`).
   - Once the flag is set, `load()` leaves the form alone and only runs `toggleRec()`, so Record follows the Stop it has just set (`:62`). Otherwise it calls `apply()` as before.

   ```diff
   @@ -3,6 +3,7 @@ const $ = (id) => document.getElementById(id);
    const isRecFmt = (f) => f === 'webm' || f === 'mp4' || f === 'gif';
    let activeTab = null;
    let recChanged = false; // the storage listener at the bottom has seen `rec` change
   +let optsSaved = false; // save() has stored the form since the popup opened
    
    const showError = (text) => { const e = $('err'); e.textContent = text; e.hidden = false; };
    
   @@ -59,7 +60,11 @@ async function load() {
      // `rec` changed while this function waited: the storage listener has already
      // set Stop from that change, which can be newer than `stored.rec`.
      if (!recChanged) $('stopBtn').disabled = !stored.rec;
   -  apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
   +  // If save() ran while this function waited, storage already holds what the
   +  // form shows, and `stored.opts` is older: leave the form alone. Record still
   +  // has to follow the Stop set above.
   +  if (optsSaved) toggleRec();
   +  else apply(migrate({ ...DEFAULTS, ...(stored.opts || {}) }));
    }
    
    function read() {
   @@ -73,6 +78,7 @@ function read() {
    }
    
    const save = () => {
   +  optsSaved = true;
      const o = read();
      try { localStorage.setItem('opts', JSON.stringify(o)); } catch { /* mirror is best-effort */ }
      return chrome.storage.local.set({ opts: o });
   ```

2. **`tests/defaults.test.js`:** add a new section at the end (after `:206`) with two tests:
   - "a Name changed while the popup is opening stays in the form"
   - "a format changed while the popup is opening stays in the form"

   Each test boots the popup with `bootPopup()`, so `load()` has read storage but hasn't continued. It then changes a control and calls that control's `change` listener before `settle()`.

   ```diff
   @@ -204,3 +204,27 @@ test('still migrates the old filename default through the cache path', () => {
      const popup = bootPopup({}, { format: 'jpg', filename: 'shot-{date}' });
      assert.strictEqual(popup.els.filename.value, DEFAULT_NAME);
    });
   +
   +// --- a setting changed while the popup is opening ---------------------------
   +// load() waits on a storage read and a tab query, and the form is filled in
   +// from the cache before that. A setting changed during the wait was saved, and
   +// then load() put the older stored value back in the form.
   +
   +test('a Name changed while the popup is opening stays in the form', async () => {
   +  const popup = bootPopup({ opts: { format: 'png', filename: 'stored' } }, { format: 'png', filename: 'stored' });
   +  popup.els.filename.value = 'renamed'; // after load() read storage, before it went on
   +  popup.els.filename.listeners.change[0]();
   +  await popup.settle();
   +  assert.strictEqual(popup.els.filename.value, 'renamed', 'load() put the older Name back in the form');
   +  assert.strictEqual(popup.store.opts.filename, 'renamed');
   +});
   +
   +test('a format changed while the popup is opening stays in the form', async () => {
   +  const popup = bootPopup({ opts: { format: 'png' } }, { format: 'png' });
   +  popup.els.format.value = 'jpg'; // after load() read storage, before it went on
   +  popup.els.format.listeners.change[0]();
   +  await popup.settle();
   +  assert.strictEqual(popup.els.format.value, 'jpg', 'load() put the older format back in the form');
   +  assert.strictEqual(popup.els.qualityRow.style.display, 'flex', 'the quality row no longer matches the format');
   +  assert.strictEqual(popup.store.opts.format, 'jpg');
   +});
   ```

3. **`tests/capture-errors.test.js`:** add a new section at the end (after `:866`) with one test: "Record follows a running recording when a setting is saved while the popup is opening". The Record button lives in this file's `loadPopup()`, and `RUNNING` is defined here too (`:720`).

   ```diff
   @@ -864,3 +864,16 @@ test('a settings change while the popup is opening leaves load() to set Stop and
      assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
      assert.strictEqual(p.btn('visible').disabled, true, 'Record came back mid-recording');
    });
   +
   +// --- a setting saved while the popup is opening -----------------------------
   +// load() leaves the form alone once save() has run, because storage then holds
   +// what the form shows. It still sets Stop, and Record has to follow it.
   +
   +test('Record follows a running recording when a setting is saved while the popup is opening', async () => {
   +  const p = loadPopup('https://a.com/x', { store: { opts: { format: 'webm' }, rec: RUNNING } });
   +  p.els.format.value = 'webm'; // picked after load() read storage, before it went on
   +  p.els.format.listeners.change[0]();
   +  await p.ready();
   +  assert.strictEqual(p.els.stopBtn.disabled, false, 'Stop was greyed out mid-recording');
   +  assert.strictEqual(p.btn('visible').disabled, true, 'Record was left enabled over a running recording');
   +});
   ```

Choices:

- **`save()` sets the flag, not the storage listener.**
  - The flag is set before `load()` can go on, because `save()` runs in the same task as the control's `change` event.
  - The storage event for that write comes later, after `chrome.storage.local.set` has finished. It could arrive after `load()` has already put the old value back.
  - `save()` is also the only place in the popup that writes `opts`, so every path is covered: a control change or a mode-button press.
- **Once `save()` has run, the form is what storage holds.** `save()` writes `read()`, the whole form, so leaving the form alone shows exactly what was stored.
- **Only `toggleRec()` runs in that case, not all of `apply()`.**
  - `load()` has just set Stop (`popup.js:61`), and Record's state depends on it (`:92`).
  - `toggleQuality()` isn't needed: only a Format change affects the Quality row, and that change runs `toggleQuality()` itself (`:176`).
  - Running `apply(read())` instead would rewrite an emptied Name field with the default name, because `read()` substitutes it (`:69`).
  - "Record follows a running recording when a setting is saved while the popup is opening" covers the `toggleRec()` call.
- **A separate flag, not `recChanged`.**
  - One shared flag would tie the two halves together. A `rec` change would make `load()` skip the stored settings, and a `save()` would make it skip setting Stop.
  - On a copy where `save()` also set `recChanged` and `load()` checked it in both places, two tests failed: "Record follows a running recording when a setting is saved while the popup is opening" and KAN-312's "an opening popup keeps a recording start that lands before load() finishes".
- **If the `localStorage` copy is missing or out of date,** the other controls hold cached or default values when the user edits, and `save()` stores those along with the edit. `save()` already does this today. With this change, the form keeps showing what was stored instead of switching to older values that storage no longer has.
- **No README, manifest or version change.** Recent fixes kept 0.3.2.

Checked while planning, on copies of the repo outside this folder:

- **Unit tests:**
  - **As it is now:** `npm test` passes 162 tests.
  - **Test changes only:** 165 tests run. 163 pass, and exactly two of the new ones fail (listed in step 1).
  - **All changes:** 165 tests pass.
  - **All changes, with one piece left out:**
    1. **`save()` sets the flag, but `load()` doesn't check it:** only the two `tests/defaults.test.js` tests fail.
    2. **`load()` checks the flag, but `save()` never sets it:** only the same two tests fail.
    3. **`load()` skips `apply()` but doesn't run `toggleRec()`:** only "Record follows a running recording when a setting is saved while the popup is opening" fails, with "Record was left enabled over a running recording".
- **Headless Chrome 152.0.7977.83,** comparing a copy with only the test changes ("unchanged") against a copy with all changes ("changed"):
  - **Setup:** the setup under "Checked while planning" in `docs/KAN-312-plan.md`:
    - the headless setup from step 3 of `docs/KAN-217-plan.md`;
    - each copy's `popup.html` loads an extra script before `popup.js`, which holds `chrome.tabs.query` back 3 s and records when the storage read finishes;
    - buttons clicked with `Runtime.evaluate` and `userGesture: true`.
  - **Before each case:**
    - Settings were PNG (WebM for the recording case) and Name `{title}`, set from a popup that had finished loading.
    - Each edit was made once the popup's storage read had finished: the control's value was set, then its `change` event fired.
  - **Results** (form values are read after `load()` finished):

    | Case | Unchanged | Changed |
    |---|---|---|
    | Name changed to `{title}-renamed` during the wait | Form: `{title}`. Storage: `{title}-renamed` | Form and storage: `{title}-renamed` |
    | Format changed to JPG during the wait | Form: PNG, Quality row hidden. Storage: JPG | Form and storage: JPG, Quality row shown |
    | Nothing edited | Form and storage: PNG, `{title}` | The same |
    | WebM recording running on PageA; popup on PageB, Name changed to `{title}-renamed` during the wait | Form: `{title}`. Storage: `{title}-renamed`. Stop enabled, Record greyed out. Stop in that popup saved `PageA.webm`, then Record was enabled and Stop disabled | Form and storage: `{title}-renamed`. Stop enabled, Record greyed out. Stop in that popup saved `PageA.webm`, then Record was enabled and Stop disabled |

  - Neither copy logged a console error in the worker, the offscreen document or the popup.
  - **Not checked in Chrome:**
    - The window at its real width (one storage read and one tab query). As with KAN-312, it was only reproduced with the delay.
    - A mode button pressed during the wait. It reaches the same `save()`.

## Steps

1. Make the `tests/defaults.test.js` and `tests/capture-errors.test.js` changes above.
   → verify: `npm test` runs 165 tests. 163 pass, and only these two new tests fail:
   - "a Name changed while the popup is opening stays in the form", with "load() put the older Name back in the form"
   - "a format changed while the popup is opening stays in the form", with "load() put the older format back in the form"
2. Make the `popup.js` change above.
   → verify: `npm test` passes 165 tests: the 162 existing ones plus the three new ones.
3. Check the change in Chrome 152.
   - **Setup:** the headless setup under "Checked while planning". Load a copy of the repo whose `popup.html` loads the 3 s delay script before `popup.js`. The delay script never goes into the repo.

   → verify:
   - **Name changed during the wait:** after `load()`, the form and storage both show the new Name.
   - **Format changed from PNG to JPG during the wait:** the form and storage both show JPG, and the Quality row is shown.
   - **Nothing edited:** the form matches storage.
   - **Name changed during the wait while another tab records:** the form keeps the new Name, Stop is enabled, and Record is greyed out. Stop saves the recording.
   - No console errors in the worker, the offscreen document or the popup.
4. Check that nothing else changed.
   → verify: `git status --short` lists only `popup.js`, `tests/defaults.test.js`, `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **`load()` still overwrites an edit that hasn't been committed yet.**
  - **When:** someone is typing in Name, or dragging the Quality slider, while `load()` waits. Those controls only fire `change`, and so `save()`, when the edit is committed. `apply()` then writes the stored value over what is in the field.
  - **Seen in headless Chrome** for Name, with the 3 s delay, in both copies. Name was set to `{title}-typing` during the wait with no `change` event. After `load()`, the form showed `{title}`, and storage still had `{title}`.
  - **The Quality slider case** comes from the code: its `input` listener only updates the label (`popup.js:177`), and `apply()` sets the slider's value. It wasn't checked in Chrome.
  - **Why it's left out:** the ticket describes a change that `save()` has stored (its steps 1-3), and this edit hasn't been stored. Covering it would take a different signal than `save()`.
  - **How likely:** the edit has to be in progress during the one storage read and one tab query.

## Open questions

None.

- The ticket names the path: a control's `change` listener, then `save()`, then `apply()` with the older `opts`. It also names the lines involved, and the plan changes exactly that path.
- The comment keeps the settings window in this ticket.
