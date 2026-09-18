# Plan for KAN-489: shot-clipboard message broadcasts to both popup and offscreen document causing a race condition

## What the code does now

- `copyImage` sends the same `{ type: 'shot-clipboard', dataUrl }` twice. Step 1 at `background.js:575` is meant for the popup. Step 3 at `background.js:602` is meant for the offscreen document.
- The popup (`popup.js:221`) and the offscreen document (`offscreen.js:24`) both answer every `shot-clipboard` message, whichever step sent it.
- A running recording keeps the offscreen document open, because `closeOffscreen` returns early while `getRec()` finds a recording (`background.js:547-548`). So during a recording, step 1's message reaches the offscreen document as well as the popup.
- The offscreen document never has focus, so its `navigator.clipboard.write` fails. `sendMessage` returns whichever answer arrives first. If the document's `{error}` arrives first, `background.js:577` throws:
  - A successful copy from the popup is thrown away and the badge flashes `!`.
  - If the popup is closed (for example, Alt+Shift+V), the error comes before step 2's write to the active tab is ever tried, so nothing is copied.

## The change

Give the offscreen document's clipboard write its own message type, `shot-clipboard-offscreen`. The worker already names its recording messages to the offscreen document this way: `rec-start-offscreen` at `background.js:687` and `rec-stop-offscreen` at `background.js:801`, handled at `offscreen.js:25-26`. `shot-clipboard` then belongs to the popup alone.

Each context then answers only its own write, in both directions:
- The offscreen document ignores step 1's message.
- A popup opened between step 1 and step 3 ignores step 3's message.

When only the offscreen document is open, step 1's message now gets no answer. Chrome either resolves that `sendMessage` with `undefined` or rejects it. `copyImage` already handles both as "nobody copied" (`.catch(() => null)`, then the `=== 'done'` / `?.error` checks) and moves on to step 2.

## Files to change

1. **`background.js:600-602`**: step 3 sends the new type. A comment explains why.
   ```javascript
       // 3. Try the offscreen document as a fallback (will fail but will report the error)
       // Under its own type: Chrome hands shot-clipboard to every extension page, and
       // a document held open by a recording answered the popup's write in step 1 with
       // its focus error, throwing the popup's copy away when it answered first (KAN-489).
       await ensureOffscreen();
       const offscreenRes = await chrome.runtime.sendMessage({ type: 'shot-clipboard-offscreen', dataUrl: pngDataUrl }).catch(() => null);
   ```

2. **`offscreen.js:21-24`**: answer only the new type. The existing comment stays, plus one line:
   ```javascript
     // Only its own write: shot-clipboard is the popup's (KAN-489).
     if (msg?.type === 'shot-clipboard-offscreen') { copyToClipboard(msg.dataUrl).then(() => sendResponse('done')).catch((e) => sendResponse({ error: e.message || String(e) })); return true; }
   ```

3. **`popup.js:221`**: no change. The popup already answers only `shot-clipboard`, and after this change only step 1 sends that.

4. **`tests/offscreen-lifecycle.test.js`**: this harness has the offscreen document answer `shot-clipboard`, which is the bug itself.
   - **`:28-31`**, the default `sendMessage` mock: no popup is open in these tests, so `shot-clipboard` goes unanswered. The `docExists` answer moves to `shot-clipboard-offscreen`.
     ```javascript
             // No popup is open here: the popup's write goes unanswered, and only the
             // document answers its own.
             if (m.type === 'shot-clipboard') throw new Error('Could not establish connection. Receiving end does not exist.');
             if (m.type === 'shot-clipboard-offscreen') {
               if (!docExists) throw new Error('Could not establish connection. Receiving end does not exist.');
               return 'done';
             }
     ```
   - **`:111`**: change the check to `order.includes('shot-clipboard-offscreen')`. The write that has to be acknowledged before the close is the offscreen document's.
   - **`:183-186`**: `shot-clipboard` goes unanswered because no popup is open, and `shot-clipboard-offscreen` returns the held promise. Remove the `calls.create === 0` check, which was only there to tell the two steps apart.
     ```javascript
         if (m.type === 'shot-clipboard') throw new Error('Receiving end does not exist.'); // no popup
         if (m.type === 'shot-clipboard-offscreen') return new Promise((r) => { answer = r; });
     ```

5. **`tests/capture-errors.test.js`**: add two tests on the offscreen document's listener after the `offscreen-id` test (`:1482-1491`). They use `loadOffscreen()` (`:493`), `PNG` (`:8`) and `settle` (`:10`).
   ```javascript
   // --- whose clipboard write it is ---------------------------------------------
   // Chrome hands a worker's message to every extension page. The worker's first
   // clipboard try is for the popup, and a document held open by a recording
   // answered it too - with its focus error - and when that answer came first the
   // popup's copy was thrown away and the badge showed ! (KAN-489).

   test("the document leaves the popup's clipboard write to the popup", async () => {
     const o = loadOffscreen();
     const answers = [];
     const held = o.message({ type: 'shot-clipboard', dataUrl: PNG }, (a) => answers.push(a));
     await settle();
     assert.notStrictEqual(held, true, 'it held the port open for a write that was not its own');
     assert.deepStrictEqual(answers, [], "it answered the popup's write");
   });

   test('the document still answers its own clipboard write', async () => {
     const o = loadOffscreen();
     Object.assign(o.ctx, { fetch: async () => ({ blob: async () => ({}) }), ClipboardItem: class {} });
     o.ctx.navigator.clipboard = { write: async () => {} };
     const answers = [];
     assert.strictEqual(o.message({ type: 'shot-clipboard-offscreen', dataUrl: PNG }, (a) => answers.push(a)), true);
     await settle();
     assert.deepStrictEqual(answers, ['done']);
   });
   ```

## Steps

1. Make the test changes (4 and 5) before touching the code. → verify: `npm test` shows 9 failures and everything else passes:
   - the 2 new tests;
   - 7 copies in `offscreen-lifecycle.test.js` that expect to succeed (`:82`, `:107`, `:117`, `:178`, the two `ENDINGS` tests at `:225`, and `:372`). They fail because the worker still sends `shot-clipboard` at step 3, which the mock no longer answers.
2. Change `background.js:602` and `offscreen.js:24` (1 and 2). → verify: `npm test` passes in full, with 2 more tests than before the change.
3. Run `grep -n "shot-clipboard" background.js offscreen.js popup.js`. → verify:
   - `shot-clipboard` appears only at `background.js:575` and `popup.js:221`;
   - `shot-clipboard-offscreen` appears only at the step 3 send in `background.js` and at `offscreen.js:24`.
4. In Chrome, reload the unpacked extension. Start a WebM recording on an http(s) page. In the popup, switch the format to PNG and tick "Copy to clipboard instead of download". Close the popup and press Alt+Shift+V. → verify: the shot pastes from the clipboard, and the badge stays on REC with no `!` flash. Before the change, this flashed `!` and nothing was copied.
5. With the same recording still running, open the popup and click Visible. → verify: the shot pastes and no `!` flashes. Then press Stop, and the WebM still saves.

## Open questions

None.
