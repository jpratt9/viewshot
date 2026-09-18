# KAN-269: Screenshots of pages the extension can't script still show the scrollbar with "Hide scrollbar before capturing" on

Ticket: https://prattsolutions.atlassian.net/browse/KAN-269 (To Do, Task, labels `bug` and `viewshot`, no comments). Its only blocker, KAN-253, is Done.

## What the repo does now

Line numbers are from `1f1f940`, with a clean working tree.

- **Both Visible routes hide the scrollbar the same way.** The popup's `capture` message (`background.js:11`) and `Alt+Shift+V` (`background.js:72-73`) both call `runCapture`. When `opts.hideScrollbar` is on, it calls `setScrollbarHidden(tab, true)` before the shot and `setScrollbarHidden(tab, false)` in its `finally` (`background.js:213-220`). The option is on by default (`background.js:1`, `popup.js:1`).
- **The only thing that hides it is a style put into the page.** `setScrollbarHidden` (`background.js:428-452`) runs `chrome.scripting.executeScript` through `scriptWithTimeout` to add `<style id="__shotHideScrollbar">`.
- **A page that refuses the script is still shot, with its scrollbar.**
  - The bare `catch` at `background.js:451` ignores the refusal. That is on purpose: the comment at `:429-431` says a cosmetic step must not be where the capture dies.
  - The same comment then says such pages "show no page scrollbar to hide anyway". The ticket measured otherwise: a data: page and another extension's page were each saved with a scrollbar along the right edge.
- **The popup lets Visible run on exactly these pages.**
  - chrome:// pages, the Web Store, other extensions' pages and data: URLs all refuse `executeScript`.
  - So Full page and Region stop there with a message (`popup.js:152-163`).
  - Visible goes through, because `activeTab` still lets Chrome capture those pages (`popup.js:11-25`, from KAN-253).
- **The README makes the promise with no exceptions.** `README.md:11` says: "**Hide scrollbar before capturing** keeps the scrollbar out of screenshots (on by default)".
- **Tests:** `npm test` passes 285 tests.
  - "hiding the scrollbar does not fail a capture on an uninjectable page" (`tests/capture-errors.test.js:212-216`) pins the `catch`: a refused hide must not reject.
  - "the README names the popup's scrollbar option" (`tests/readme.test.js:26-30`) requires the README to contain the checkbox's label, "Hide scrollbar before capturing" (`popup.html:46-47`).
- **The only other records of this** are `docs/KAN-253-plan.md:261-263`, under "Noticed while planning, not changed", and the message of commit `cfcc91f`.

## Change

Two files change: `README.md`, and one comment in `background.js`.

Nothing the extension does changes, because nothing it can do would hide the scrollbar on these pages (see "Checked while planning"). So the fix is to stop saying that it does:

- the README says where the option can't work;
- the comment says what happens on those pages, instead of claiming they have no scrollbar.

The `catch` stays, because the capture must still go ahead on these pages.

1. **`README.md:11`** names the pages where the option can't work. The label is kept word for word, so `tests/readme.test.js:26-30` still finds it.

   ```diff
   @@ -11,1 +11,1 @@
   -- **Hide scrollbar before capturing** keeps the scrollbar out of screenshots (on by default)
   +- **Hide scrollbar before capturing** keeps the scrollbar out of screenshots (on by default), except on chrome:// pages, the Web Store, other extensions' pages and data: URLs, where Chrome doesn't let extensions run scripts
   ```

2. **`background.js:429-431`**: the comment keeps its reason for the `catch` and drops the claim the ticket disproves.

   ```diff
   @@ -429,3 +429,5 @@
      // Cosmetic, so an uninjectable page must not be where the capture dies: on a
      // chrome:// URL this threw "Cannot access a chrome:// URL" before the shutter
   -  // was ever reached, and such pages show no page scrollbar to hide anyway.
   +  // was ever reached. Such a page is shot with its scrollbar, though: a data:
   +  // page or another extension's page taller than the window keeps it along the
   +  // right edge, and nothing outside the page can take it out.
   ```

No tests change. No code path changes, and the behavior that stays (a refused hide doesn't fail the capture) is already pinned by `tests/capture-errors.test.js:212-216`.

## Steps

1. **`README.md:11`: name the pages the option can't work on.** → verify: `npm test` still passes 285, including "the README names the popup's scrollbar option".
2. **`background.js:429-431`: replace the comment's last line with the three above.** → verify: `git diff background.js` changes only comment lines, and `npm test` still passes 285.
3. **Check the pages the ticket didn't, and the shortcut.**
   - **Setup:** Chrome 153.0.8010.48, `--headless=new`, a disposable profile, `download.default_directory` set in `Default/Preferences`, and the repo loaded with CDP `Extensions.loadUnpacked`. Window 1280×800, so the tab is 1280×713. Format PNG, with "Hide scrollbar before capturing" on.
   - **Routes:** take Visible from the popup (`Extensions.triggerAction`), and again with `Alt+Shift+V` (CDP key events sent to the page, as in KAN-219's check).
   - **Pages:**
     - `chrome://credits/`, which is taller than the window;
     - the Web Store, `https://chromewebstore.google.com/`;
     - a 3000 px `page.html` in a second unpacked extension (KAN-253's setup);
     - a 3000 px `data:text/html,…` page, opened with `Target.createTarget({ url, forTab: true })`;
     - a 3000 px http page from `python3 -m http.server`, as the control.

   → verify:
   - Both routes save a 1280×713 PNG on every page, with no error and no badge.
   - On the first four pages, any page that scrolls keeps its scrollbar along the right edge, as the README will now say.
   - On the http page, neither PNG has a scrollbar.
4. **Check that nothing else changed.** → verify: `git status --short` lists only `README.md`, `background.js` and this plan.

## Open questions

1. **Should the popup tell the user too?**
   - This plan fixes the two places that say something untrue, and changes nothing the user sees. The ticket doesn't say whether a screenshot of one of these pages should come with a notice.
   - If it should, the part to reuse is the popup's existing message for these same pages (`showError`, `popup.js:152-163`). But there are two catches:
     - Visible succeeds on these pages, so the message would appear next to a saved screenshot rather than explain a failure.
     - `Alt+Shift+V` has no popup to show it in.
   - Adding it means a `popup.js` change plus tests, so it is left out unless you want it.

## Checked while planning

Nothing was run in a browser for this plan. Step 3 is where the saved files get checked.

A code fix is ruled out by how Chrome controls each possible way in. None of the following was measured here:

- **`chrome.scripting.insertCSS`** could add the same style without a script. But Chrome allows it only where it allows `executeScript`, so the same pages refuse it.
- **Cropping the screenshot** would need to know whether the page has a scrollbar, and how wide it is.
  - From outside the page, the worker has only the image and `Tab.width`, and `Tab.width` includes the scrollbar.
  - A blind crop would cut a strip of real content off every page that has no scrollbar.
  - Even a correct crop is narrower than a normal hidden-scrollbar screenshot, where the content widens to fill the space.
- **`chrome.debugger`'s `Emulation.setScrollbarsHidden`** does hide scrollbars.
  - It needs the `debugger` permission, which brings an install warning and shows a bar across the window while attached.
  - Chrome also won't attach it to chrome:// pages, the Web Store or other extensions' pages, so it would only help on data: URLs.
- **`npm test` at `1f1f940`:** 285 pass, 0 fail.

## Implementation and verification

Done as planned. The open question was left as planned: nothing changes in the popup.

- **Step 1 — `README.md:11`.** The line now ends ", except on chrome:// pages, the Web Store, other extensions' pages and data: URLs, where Chrome doesn't let extensions run scripts". → `npm test` passed 285, including "the README names the popup's scrollbar option".
- **Step 2 — `background.js:429-433`.** The comment's last line was replaced with the three planned lines. → `git diff background.js` shows only those comment lines, and `npm test` passed 285.
- **Step 3 — real screenshots.**
  - **Setup:** Chrome 153.0.8010.48, `--headless=new`, a disposable profile, and `download.default_directory` set in `Default/Preferences`. The changed repo and a second unpacked extension were loaded with `Extensions.loadUnpacked`, and one warm-up popup was opened and closed first. Window 1280×800, format PNG, "Hide scrollbar before capturing" on.
  - **Routes:** Visible from the popup (`Extensions.triggerAction`, then a click on Visible), and from `Alt+Shift+V` (CDP key events sent to the page).
  - **Pages:** every page reported `innerWidth` 1280 and `clientWidth` 1265, so each had a 15 px scrollbar, and every page was taller than the window.

  | page | height (px) | popup | Alt+Shift+V |
  |---|---|---|---|
  | `chrome://credits/` | 32379 | scrollbar | scrollbar |
  | Web Store | 5275 | scrollbar, plus a horizontal one along the bottom | same |
  | other extension's `page.html` | 3000 | scrollbar | scrollbar |
  | `data:text/html,…` | 3000 | scrollbar | scrollbar |
  | http (control) | 3000 | none | none |

  - **Result:** all 10 shots were saved as 1280×713 PNGs under the names they were given. There was no popup error, no badge, and no ViewShot console output.
  - **How "scrollbar" was judged:** on the first four pages, the rightmost 15 px of the image is the scrollbar's dark track (mean RGB 48–55), with its thumb at the top, next to the page's content. On the http page, that strip is the page's white (255).
  - This covers both of the ticket's "Not checked" items: chrome:// pages and the Web Store, and the Visible shortcut on all four kinds of page.
- **Step 4.** → `git status --short` lists only `README.md`, `background.js` and this plan.
- **Files:** the harness is `/tmp/vs269-check.js`, built on `/tmp/vs387-chrome/cdp.js`. The shots are in `/tmp/vs269-dl-xHUzLh`.
