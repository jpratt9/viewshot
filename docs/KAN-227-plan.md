# KAN-227: Add the NeuQuant copyright notice for the code bundled in gif.worker.js

Ticket: https://prattsolutions.atlassian.net/browse/KAN-227 (To Do, no comments). It was blocked by KAN-226, which is now Done.

## What the repo does now

- `gif.worker.js:2` bundles three gif.js source modules: `"./GIFEncoder.js"`, `"./LZWEncoder.js"` and `"./TypedNeuQuant.js"`. The file is gif.js 0.2.0's `dist/gif.worker.js`, unmodified, and the word "Dekker" appears nowhere in it.
- `THIRD_PARTY_NOTICES.txt` has 29 lines and a single section:
  - lines 1-2 are the intro;
  - lines 4-7 are the gif.js 0.2.0 header block;
  - lines 9-29 are the MIT license text.

  Nothing in the file mentions NeuQuant.
- In the gif.js 0.2.0 npm package, `src/TypedNeuQuant.js` opens with a block comment that holds Dekker's notice. `src/NeuQuant.js` has the same comment. With only the comment markers (`/* `, ` * `, ` */`) removed, the notice is 21 lines long, with no trailing spaces and no tabs.
- The existing tests in `tests/notices.test.js` still work with a second section:
  - line 31 only matches the `gif.js <version> - <url>` line;
  - line 33 collects every `Files in this extension:` line from the file.

## Change

Only one file changes: `THIRD_PARTY_NOTICES.txt`. After line 29, add a second section laid out like the gif.js one: a blank line, the `====` rule, a name line, a `Files in this extension:` line, another `====` rule, a blank line, then the notice text.

Nothing else changes:

- The intro on lines 1-2 already refers to "the third-party code listed below", so it stays as is.
- `gif.worker.js` stays untouched, as an unmodified upstream copy.
- `manifest.json` and `package.json` stay the same, with no version bump. KAN-226 made the same call for a change that only adds a notice.
- `GIFEncoder.js` and `LZWEncoder.js` get no section, because, as the ticket says, they set no license terms.

After `THIRD_PARTY_NOTICES.txt:29`, add a blank line followed by these 26 lines:

```
================================================================================
NeuQuant - bundled as TypedNeuQuant.js in gif.js 0.2.0
Files in this extension: gif.worker.js
================================================================================

NeuQuant Neural-Net Quantization Algorithm
------------------------------------------

Copyright (c) 1994 Anthony Dekker

NEUQUANT Neural-Net quantization algorithm by Anthony Dekker, 1994.
See "Kohonen neural networks for optimal colour quantization"
in "Network: Computation in Neural Systems" Vol. 5 (1994) pp 351-367.
for a discussion of the algorithm.
See also  http://members.ozemail.com.au/~dekker/NEUQUANT.HTML

Any party obtaining a copy of these files from the author, directly or
indirectly, is granted, free of charge, a full and unrestricted irrevocable,
world-wide, paid up, royalty-free, nonexclusive right and license to deal
in this software and documentation files (the "Software"), including without
limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons who receive
copies from any such party to do so, with the only requirement being
that this copyright notice remain intact.

(JavaScript port 2012 by Johan Nordberg)
```

The notice text, from "NeuQuant Neural-Net Quantization Algorithm" through "(JavaScript port 2012 by Johan Nordberg)", matches the upstream comment word for word. That includes the double space after "See also" and the ozemail URL as written; only the comment markers are removed. The file should still end with a single newline, so the new lines become 30-56.

## Steps

1. Add the section above after `THIRD_PARTY_NOTICES.txt:29`.
   → verify: this command prints nothing, which means the notice matches upstream word for word:
   ```
   diff <(sed -n '/^NeuQuant Neural-Net Quantization Algorithm$/,/^(JavaScript port 2012 by Johan Nordberg)$/p' THIRD_PARTY_NOTICES.txt) <(curl -fsSL https://registry.npmjs.org/gif.js/-/gif.js-0.2.0.tgz | tar -xzO package/src/TypedNeuQuant.js | sed -n '1,/\*\//p' | sed -E -e 's#^/\* ?##' -e 's#^ \*/$##' -e 's#^ \* ?##' | sed '$d')
   ```
2. Check that the gif.js section didn't change.
   → verify:
   - `git diff -U0 THIRD_PARTY_NOTICES.txt` shows a single hunk, `@@ -29,0 +30,27 @@`, containing only added lines.
   - KAN-226's check still prints nothing:
     ```
     diff <(sed -n '/^The MIT License/,/^THE SOFTWARE\.$/p' THIRD_PARTY_NOTICES.txt) <(curl -fsSL https://raw.githubusercontent.com/jnordberg/gif.js/master/LICENSE)
     ```
3. Check that the file still ships with the loaded extension.
   → verify:
   - Reload ViewShot at `chrome://extensions`. No new errors appear on its card.
   - In its service worker console, run `fetch(chrome.runtime.getURL('THIRD_PARTY_NOTICES.txt')).then(r => r.text()).then(t => console.log(t.includes('Copyright (c) 1994 Anthony Dekker')))`. It logs `true`.
4. Check that nothing else changed.
   → verify:
   - `git status --short` lists only `THIRD_PARTY_NOTICES.txt` and this plan in `docs/`.
   - `npm test` still passes all 99 tests.

## Open questions

None. The ticket names the file to copy from, the file to change, and the file the new section covers.
