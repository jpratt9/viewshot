# KAN-628: Update insertCSS mock and restore deleted scroll anchoring/snapping tests

## Changes

### 1. `tests/fullpage.test.js`

**Update the `insertCSS` test mock to intercept style queries:**
- Around line 113, inside `load()`, add `const insertedCSS = [];` to track injected rules.
- Around line 119, update the `chrome.scripting` mock:
  ```javascript
        scripting: {
          insertCSS: async ({ css }) => { insertedCSS.push(css); },
          removeCSS: async ({ css }) => {
            const idx = insertedCSS.indexOf(css);
            if (idx !== -1) insertedCSS.splice(idx, 1);
          },
  ```
- Around line 108, update `getComputedStyle` to enforce the user-origin CSS cascade precedence over inline styles (`!important` or not):
  ```javascript
      getComputedStyle: (e) => {
        const inlineSnap = (e.style && e.style.getPropertyValue) ? e.style.getPropertyValue('scroll-snap-type') || 'none' : 'none';
        const inlineAnchor = (e.style && e.style.getPropertyValue) ? e.style.getPropertyValue('overflow-anchor') || 'auto' : 'auto';
        const userCss = insertedCSS.join(' ');
        return {
          position: fixed.includes(e) ? (e.pos || 'fixed') : 'static',
          overflow: e.overflow || 'visible',
          'scroll-snap-type': userCss.includes('scroll-snap-type: none !important') ? 'none' : inlineSnap,
          'overflow-anchor': userCss.includes('overflow-anchor: auto !important') ? 'auto' : inlineAnchor,
        };
      },
  ```
- Around line 144, return `insertedCSS` from `load()` so tests can assert on it:
  ```javascript
    return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, styles, observers, insertedCSS, message: (m) => onMessage(m, {}, () => {}) };
  ```

**Restore the deleted tests (rewritten for `insertCSS`):**
Append the following tests to `tests/fullpage.test.js` to restore coverage for the bugs that KAN-619 left unchecked:

```javascript
// --- pages that turn scroll anchoring off ----------------------------------

test('turns scroll anchoring on while the page is shot, and back off after', async () => {
  const { ctx, insertedCSS } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  const rules = [];
  ctx.chrome.tabs.captureVisibleTab = async (...a) => { rules.push(insertedCSS.join(' ')); return shoot(...a); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(rules, Array(4).fill('* { overflow-anchor: auto !important; scroll-snap-type: none !important; }'), 'shot a slice without the rule');
  assert.strictEqual(insertedCSS.length, 0, 'left the rule inserted');
});

test('takes the anchoring rule back out when a slice fails', async () => {
  const { ctx, insertedCSS } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1, failAt: 2 });
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  let shotWith;
  ctx.chrome.tabs.captureVisibleTab = async (...a) => { shotWith = insertedCSS.length > 0; return shoot(...a); };
  await assert.rejects(ctx.captureFullPage(TAB));
  assert.ok(shotWith, 'shot the slice that failed without the rule');
  assert.strictEqual(insertedCSS.length, 0, 'left the rule inserted');
});

test("turns anchoring on over a page's own `!important` in a style attribute, and puts it back after", async () => {
  const htmlEl = positioned('static');
  htmlEl.style.setProperty('overflow-anchor', 'none', 'important');
  const page = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  
  const shoot = page.ctx.chrome.tabs.captureVisibleTab;
  const overrides = [];
  page.ctx.chrome.tabs.captureVisibleTab = async (...a) => {
    overrides.push(page.ctx.getComputedStyle(htmlEl)['overflow-anchor']);
    return shoot(...a);
  };
  await page.ctx.captureFullPage(TAB);
  assert.deepStrictEqual(overrides, Array(4).fill('auto'), "did not override the page's own inline anchoring");
  assert.strictEqual(page.ctx.getComputedStyle(htmlEl)['overflow-anchor'], 'none', "did not restore the page's own inline anchoring");
});

// --- pages with scroll snapping --------------------------------------------

test('turns scroll snapping off while the page is shot', async () => {
  const snaps = [0, 500, 1000, 1500, 2000, 2287];
  const body = el(3000, 713);
  const htmlEl = positioned('static');
  const scroll = body.scrollTo;
  
  let page;
  body.scrollTo = function (o) {
    const snap = page.ctx.getComputedStyle(htmlEl)['scroll-snap-type'];
    const off = snap === 'none';
    const top = off ? o.top : snaps.reduce((a, b) => (Math.abs(b - o.top) < Math.abs(a - o.top) ? b : a));
    scroll.call(this, { ...o, top });
  };
  page = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  
  await page.ctx.captureFullPage(TAB);
  assert.deepStrictEqual(page.captureAt, [0, 713, 1426, 2139, 2287], 'shot the slices where the snap points pulled them');
  assert.deepStrictEqual(page.canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
});

test("turns scroll snapping off over a page's own `!important` in a style attribute, and puts it back after", async () => {
  const snaps = [0, 500, 1000, 1500, 2000, 2287];
  const htmlEl = positioned('static'), bodyEl = positioned('static');
  for (const e of [htmlEl, bodyEl]) e.style.setProperty('scroll-snap-type', 'y mandatory', 'important');
  const body = el(3000, 713);
  const scroll = body.scrollTo;
  
  let page;
  body.scrollTo = function (o) {
    const htmlSnap = page.ctx.getComputedStyle(htmlEl)['scroll-snap-type'];
    const bodySnap = page.ctx.getComputedStyle(bodyEl)['scroll-snap-type'];
    const off = htmlSnap === 'none' && bodySnap === 'none';
    const top = off ? o.top : snaps.reduce((a, b) => (Math.abs(b - o.top) < Math.abs(a - o.top) ? b : a));
    scroll.call(this, { ...o, top });
  };
  page = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  
  await page.ctx.captureFullPage(TAB);
  assert.deepStrictEqual(page.captureAt, [0, 713, 1426, 2139, 2287], 'shot the slices where the snap points pulled them');
  assert.deepStrictEqual(page.canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
  assert.strictEqual(page.ctx.getComputedStyle(htmlEl)['scroll-snap-type'], 'y mandatory', "did not restore the page's own inline snapping");
  assert.strictEqual(page.ctx.getComputedStyle(bodyEl)['scroll-snap-type'], 'y mandatory', "did not restore the page's own inline snapping");
});
```

## Steps

1. Update `tests/fullpage.test.js` to modify `load()`'s internal variables, the `scripting` mock, the `getComputedStyle` mock, and its return object. → verify: `npm test` runs and passes (to ensure we didn't break existing mock properties).
2. Append the 5 scroll layout tests to the end of `tests/fullpage.test.js`. → verify: `npm test` runs and confirms the new test cases pass.

## Open Questions

None. The original tests that dealt with DOM state mutation, infinite script loop fighting, and crash recovery via DOM leftovers (e.g., `test('disconnects the observer a capture that died left on the root element')`) were fundamentally obsoleted by the switch to `chrome.scripting.insertCSS` since it leverages Chrome's isolated native CSS injection layer and does not interact with the page's script layer or DOM. Only the cascade precedence and behavioral override tests above need to be ported.
