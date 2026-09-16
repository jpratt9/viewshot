# KAN-257: Test "refuses the extension gallery and devtools too" doesn't test the extension gallery

Ticket: https://prattsolutions.atlassian.net/browse/KAN-257 (To Do, no comments, label `viewshot`, no links). The ticket explains what's wrong with the name but doesn't say how to fix it.

## What the repo does now

- **The test**, as of `e226216`, is "refuses the extension gallery and devtools too" (`tests/capture-errors.test.js:210-220`).
  - It presses Visible and Region on `chrome-extension://abc/page.html`, `devtools://devtools/bundled/x.html` and `about:blank` (`:211-212`).
  - Each time, it expects nothing to be sent (`:216`) and an error to be shown (`:217`).
  - The popup refuses all three pages before sending anything. None of them matches `CAPTURABLE` (`popup.js:15`), so `uncapturable()` (`popup.js:17`) stops the click at `popup.js:91-94`.
- **None of the three pages is the extensions gallery.** "Extensions gallery" is Chrome's old name for the Web Store, as in the error "The extensions gallery cannot be scripted." (`docs/KAN-217-plan.md:16`, `docs/KAN-217-plan.md:29`, `docs/KAN-243-plan.md:113`).
- **The name has been wrong since the test was added.**
  - `d076bef` added the test with the same three pages, pressing only Region. At that commit, the popup's only check was `/^(https?|file|ftp):/i` (`popup.js:12`). The Web Store's https URL passed it, so the test couldn't have covered the store.
  - `52821dc` (KAN-241) added Visible and the message check but kept the name.
  - The "too" referred to the test that came just before it in `d076bef`, "refuses a chrome:// page with a message rather than a silent no-op". KAN-241 removed that test (`docs/KAN-241-plan.md:106`). This test now comes straight after `loadPopup` (`tests/capture-errors.test.js:166-208`), at the start of the "the popup says which page it was" section (`:164`).
- **The Web Store is already covered** in the same file, by the three tests the ticket lists. All three use `WEB_STORE_URLS` (`:296`):
  - "refuses Full page and Region on the Web Store" (`:298-309`)
  - "still takes Visible on the Web Store, and Full page on look-alike hosts" (`:311-324`)
  - "still records on the Web Store, and on a file:// page without file access" (`:337-345`)
- **This test can't cover the Web Store as it stands.** It expects both modes it presses to be refused. On the Web Store, the popup refuses only Full page and Region (`popup.js:119-122`), so Visible goes through.
- **Where the old name appears:**
  - in code, only at `tests/capture-errors.test.js:210`;
  - in the plans for two Done tickets: `docs/KAN-241-plan.md:34`, `:107` and `:129`, and `docs/KAN-252-plan.md:132`;
  - in the "Related" section of KAN-253's description.
- **Apostrophes in test names are escaped** with `\'` (`tests/notices.test.js:18`, `tests/notices.test.js:47`, `tests/readme.test.js:26`).
- **Test count:** `tests/` defines 128 tests, 23 of them in `tests/capture-errors.test.js`.

## Change

One line changes, in `tests/capture-errors.test.js`: the test gets a name that lists the pages it covers.

```diff
@@ -207,7 +207,7 @@
   };
 }
 
-test('refuses the extension gallery and devtools too', async () => {
+test('refuses other extensions\' pages, devtools and about:blank', async () => {
   for (const url of ['chrome-extension://abc/page.html', 'devtools://devtools/bundled/x.html', 'about:blank']) {
     for (const mode of ['visible', 'region']) {
       const p = loadPopup(url);
```

Choices:

- **Rename the test instead of adding the Web Store to it.** Three tests already cover the store, and this test couldn't check it without changing what it asserts.
- **List the three pages the test uses.** "Other extensions' pages" means `chrome-extension://` URLs. It's the wording KAN-253 uses.
- **Drop "too".** The test it referred to no longer exists.
- **Escape the apostrophe with `\'`**, as the other test names do.
- **Leave the test body as it is.** Its assertion messages already name each mode and URL.
- **Leave the old name in `docs/KAN-241-plan.md` and `docs/KAN-252-plan.md`.** Those plans describe the code as it was when they were written, including line numbers.
- **No README or version change.** Only a test name changes.

## Steps

1. Make the change above.
   → verify: `node --test tests/capture-errors.test.js` passes all 23 tests, and its output includes "refuses other extensions' pages, devtools and about:blank". `grep -rn "extension gallery" tests/` prints nothing.
2. Run the whole suite.
   → verify: `npm test` passes 128 tests, the same count as before.
3. Check that nothing else changed.
   → verify: `git status --short` lists only `tests/capture-errors.test.js` and this plan.

## Noticed while planning, not changed

- **KAN-253's description still uses the old name.** Its "Related" section cites "refuses the extension gallery and devtools too" (`tests/capture-errors.test.js:210-220`). Once this change is made, no test has that name.

## Open questions

None.

- The ticket explains what's wrong with the name and lists the tests that already cover the Web Store.
- The popup lets Visible through on the Web Store, so this test can't cover the store without changing what it checks.
