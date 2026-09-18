const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const PNG = 'data:image/png;base64,AAAA';

// A scrollable element that clamps writes the way a real one does — clamping is
// what makes the last slice overlap the previous, so the tests need it.
function el(scrollHeight, clientHeight) {
  let top = 0;
  return {
    scrollHeight, clientHeight,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, Math.max(0, scrollHeight - clientHeight))); },
    scrollTo(o) { this.scrollTop = o.top; },
  };
}

// Reports overflow but refuses to move: an overlay-locked page, or a scroller
// nested somewhere we can't reach.
function lockedEl(scrollHeight, clientHeight) {
  return { scrollHeight, clientHeight, get scrollTop() { return 0; }, set scrollTop(_v) {}, scrollTo() {} };
}

// A scroller with `scroll-behavior: smooth`: a scrollTop write or a default
// scrollTo only starts an animation, so the offset still reads the old value
// straight after. Only `behavior: 'instant'` moves it at once.
function smoothEl(scrollHeight, clientHeight) {
  const real = el(scrollHeight, clientHeight);
  return {
    scrollHeight, clientHeight,
    get scrollTop() { return real.scrollTop; },
    set scrollTop(_v) {},
    scrollTo(o) { if (o.behavior === 'instant') real.scrollTop = o.top; },
  };
}

// background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
// the capture are all mocked — nothing real is touched.
function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
  const canvases = [];
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
    getContext() {
      return { drawImage: (_img, x, y, w, h) => this.draws.push({ x, y, w, h }), fillStyle: '', fillRect() {} };
    }
    async convertToBlob() {
      // Chrome's own limits (KAN-210): past them it throws rather than encode.
      if (this.width > 65535 || this.height > 65535 || this.width * this.height > 268435456) throw new Error('IndexSizeError: The size of "OffscreenCanvas" is zero.');
      return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
  }

  // Where the page really sat at the moment of each capture. Draw offsets alone
  // can't catch the bug: the old code drew at the offsets it asked for, which
  // look right even though every slice was the same unmoved viewport.
  const captureAt = [];
  let last = PNG;
  const scriptCalls = [];
  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
  const context = {
    console,
    URL, btoa, Date, clearTimeout,
    // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
    setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
    // A window that is drawing runs the callback; from frozenAt on it never does.
    // The probe for slice k runs before capture k, so captureAt is one short.
    requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
    getComputedStyle: (e) => ({ position: fixed.includes(e) ? (e.pos || 'fixed') : 'static' }),
    window: {
      innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr,
      // Faithful to the browser: window.scrollTo drives the document scroller.
      // It therefore does nothing when html is pinned to the viewport height,
      // which is exactly the case that broke.
      scrollTo: (x, y) => { if (de) de.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); },
    },
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: iw * dpr, height: ih * dpr }),
    fetch: async () => ({ blob: async () => ({}) }),
    chrome: {
      scripting: {
        executeScript: async ({ func, args }) => {
          scriptCalls.push(func.name || 'anon');
          // Chrome awaits a function that returns a promise; the frame report does.
          return [{ result: await func.apply(null, args || []) }];
        },
      },
      tabs: {
        captureVisibleTab: async () => {
          const at = Math.max(de ? de.scrollTop : 0, body ? body.scrollTop : 0);
          captureAt.push(at);
          if (captureAt.length === failAt) throw new Error('capture failed');
          // A window that draws hands back a different frame at each offset; one
          // that isn't drawing hands back the frame it last presented, forever.
          // sameAt: the slices a flat stretch of page shoots identically.
          if ((frozenAt && captureAt.length >= frozenAt) || sameAt.includes(captureAt.length)) return last;
          return (last = PNG + at);
        },
        // From capture `leaveAt` on, the tab is no longer the one showing in
        // window 9: `leave` says whether it was switched away from or moved.
        get: async (id) => ({ id, windowId: 9, active: true, ...(leaveAt && captureAt.length >= leaveAt ? leave : {}) }),
      },
      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    },
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
  return { ctx: context, canvases, scriptCalls, captureAt };
}

const TAB = { id: 1, windowId: 9 };

// --- picking the element that actually scrolls -----------------------------

test('measures the document when the document is what scrolls', () => {
  const { ctx } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  const m = ctx.measurePage();
  assert.strictEqual(m.total, 3000);
});

test('measures <body> when html is pinned to the viewport and body scrolls', () => {
  // html,body{height:100%;overflow-x:hidden} — html cannot scroll, body owns it.
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
  const m = ctx.measurePage();
  assert.strictEqual(m.total, 3052, 'must measure the body, not the un-scrollable html');
});

test('reports the starting offset from the real scroller, not window.scrollY', () => {
  const body = el(3052, 767);
  body.scrollTop = 900;
  const { ctx } = load({ de: el(767, 767), body });
  assert.strictEqual(ctx.measurePage().prevY, 900);
});

test('falls back to scrollingElement when nothing overflows', () => {
  const de = el(700, 700);
  const { ctx } = load({ de, body: el(700, 700), ih: 700 });
  assert.strictEqual(ctx.measurePage().total, 700);
});

// --- scrolling reports where the page actually landed ----------------------

test('scrolling a body-scroller page moves it and reports the new offset', () => {
  const body = el(3052, 767);
  const { ctx } = load({ de: el(767, 767), body });
  assert.strictEqual(ctx.scrollAndReport(1534), 1534);
  assert.strictEqual(body.scrollTop, 1534);
});

test('a request past the end reports the clamped offset, not the request', () => {
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
  assert.strictEqual(ctx.scrollAndReport(99999), 3052 - 767);
});

test('a page that refuses to scroll reports 0 rather than the request', () => {
  const { ctx } = load({ de: lockedEl(3052, 767), body: el(767, 767) });
  assert.strictEqual(ctx.scrollAndReport(1534), 0);
});

// --- the stitch itself -----------------------------------------------------
// The regression: every slice used to be drawn at the REQUESTED offset. On a
// page where window.scrollTo is a no-op that meant one unmoved viewport stacked
// down the canvas, which is what produced the repeated-content screenshots.

test('actually moves a body-scroller page between slices', async () => {
  const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 767, 1534, 2285],
    'every slice must be captured at a different scroll offset, not one unmoved viewport');
});

test('stitches a body-scroller page at the offsets it actually reached', async () => {
  const { ctx, canvases, captureAt } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), captureAt.map((y) => y * 2));
});

test('stitches a normal document-scrolling page unchanged', async () => {
  const { ctx, canvases, captureAt } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200]);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 800, 1600, 2200]);
});

test('never captures the same viewport twice', async () => {
  const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  assert.strictEqual(new Set(captureAt).size, captureAt.length);
});

test('stops after one slice when the page will not advance', async () => {
  const { ctx, canvases } = load({ de: lockedEl(3052, 767), body: el(767, 767) });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0],
    'a stuck page must not stack the same viewport down the canvas');
});

test('trims the canvas to what was actually stitched', async () => {
  const { ctx, canvases } = load({ de: lockedEl(3052, 767), body: el(767, 767) });
  await ctx.captureFullPage(TAB);
  assert.strictEqual(canvases[0].height, 3052 * 2, 'full-height canvas allocated up front');
  assert.strictEqual(canvases[1].height, 767 * 2, 'trimmed down to the one captured viewport');
});

test('leaves the canvas untrimmed when every slice lands', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  assert.strictEqual(canvases.length, 1, 'no trim pass needed');
});

test('restores the original scroll offset when done', async () => {
  const body = el(3052, 767);
  body.scrollTop = 640;
  const { ctx } = load({ de: el(767, 767), body });
  await ctx.captureFullPage(TAB);
  assert.strictEqual(body.scrollTop, 640);
});

// --- pages too big for one image ---------------------------------------------
// Chrome encodes no canvas past 65,535 px a side or 268,435,456 px² in all, and
// cuts a JPEG at 65,500 px and a WebP at 16,383 px without a word. The stitch
// found out only after scrolling every screen, and a WebP lost its bottom with
// no error. It now scales down to fit what it will be saved as (KAN-210).

test('a page too tall to encode is scaled to fit', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(40000, 767) });
  await ctx.captureFullPage(TAB); // 80,000 px tall at dpr 2
  assert.ok(canvases[0].height <= 65535, `${canvases[0].height} px tall`);
  assert.strictEqual(canvases[0].width, Math.floor(1512 * 2 * (65535 / 80000)), 'the width was not scaled with it');
});

test('a WebP full page is held to 16,383 px', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(10000, 767) });
  await ctx.captureFullPage(TAB, 'webp'); // 20,000 px tall at dpr 2
  assert.ok(canvases[0].height <= 16383, `${canvases[0].height} px tall`);
});

test('a JPEG full page is held to 65,500 px', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(34000, 767) });
  await ctx.captureFullPage(TAB, 'jpg'); // 68,000 px tall at dpr 2
  assert.ok(canvases[0].height <= 65500, `${canvases[0].height} px tall`);
});

test('a wide window is held to the area limit', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(20000, 767), iw: 3840 });
  await ctx.captureFullPage(TAB); // 7,680 × 40,000 px at dpr 2
  assert.ok(canvases[0].width * canvases[0].height <= 268435456, `${canvases[0].width} × ${canvases[0].height} px`);
});

test('scaled slices meet with no gap', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(40000, 767) });
  await ctx.captureFullPage(TAB);
  const draws = canvases[0].draws;
  for (let i = 1; i < draws.length; i++) assert.ok(draws[i].y <= draws[i - 1].y + draws[i - 1].h, `a gap above slice ${i}`);
  const last = draws[draws.length - 1];
  assert.ok(last.y + last.h >= canvases[0].height, 'the last slice stops short of the bottom');
});

test('a scaled page that stops early is trimmed at the same scale', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: lockedEl(40000, 767) });
  await ctx.captureFullPage(TAB); // 80,000 px tall at dpr 2, and it never scrolls
  assert.strictEqual(canvases[1].height, Math.round(767 * 2 * (65535 / 80000)), 'trimmed to the unscaled slice');
});

// --- pages with smooth scrolling -------------------------------------------
// Bootstrap 5 and Tailwind's scroll-smooth put `scroll-behavior: smooth` on the
// root. A scroll there only starts an animation, so the offset read straight
// after was still the old one, the second slice looked stuck, and Full page
// saved the first screen alone.

test('scrolling a smooth-scrolling page lands before it reports', () => {
  const de = smoothEl(3000, 800);
  const { ctx } = load({ de, body: el(3000, 3000), ih: 800, dpr: 1 });
  assert.strictEqual(ctx.scrollAndReport(1600), 1600);
  assert.strictEqual(de.scrollTop, 1600);
});

test('a smooth-scrolling body scroller also lands before it reports', () => {
  // html,body{height:100%;overflow-x:hidden} with body{scroll-behavior:smooth}.
  const body = smoothEl(3052, 767);
  const { ctx } = load({ de: el(767, 767), body });
  assert.strictEqual(ctx.scrollAndReport(1534), 1534);
  assert.strictEqual(body.scrollTop, 1534);
});

test('stitches every screen of a smooth-scrolling page', async () => {
  const { ctx, captureAt } = load({ de: smoothEl(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200], 'stopped before the end of the page');
});

// --- a stitch that stops part-way ------------------------------------------
// The page was only put back after the last slice, so a slice that threw left
// it scrolled to wherever the stitch stopped, with its pinned headers hidden.
// And each slice is a shot of whichever tab is showing in the window, so a
// switch mid-stitch put the other tab into the image.

test('puts the page back when a slice fails part-way', async () => {
  const body = el(3052, 767);
  body.scrollTop = 640;
  const header = { style: { visibility: '' } };
  const { ctx } = load({ de: el(767, 767), body, fixed: [header], failAt: 3 });
  await assert.rejects(() => ctx.captureFullPage(TAB), /capture failed/);
  assert.strictEqual(body.scrollTop, 640, 'left scrolled to where the stitch stopped');
  assert.strictEqual(header.style.visibility, '', 'left the pinned header hidden');
});

test('stops rather than stitch in a tab the user switched to', async () => {
  // Switched to another tab, or dragged this one out to another window.
  for (const leave of [{ active: false }, { windowId: 4 }]) {
    const body = el(3052, 767);
    body.scrollTop = 640;
    const { ctx, canvases } = load({ de: el(767, 767), body, leaveAt: 2, leave });
    await assert.rejects(() => ctx.captureFullPage(TAB), /another tab is now showing/);
    assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0], `stitched in the other tab after ${JSON.stringify(leave)}`);
    assert.strictEqual(body.scrollTop, 640, 'the stopped stitch left the page scrolled');
  }
});

// --- sticky elements further down the page ---------------------------------
// From the second slice on, every fixed or sticky element was hidden for the
// rest of the capture. That is right for a pinned header, which the first slice
// already shows, but a sticky table header, section heading or sidebar further
// down never appears in that slice: it was hidden in every slice that should
// have shown it, leaving blank space where it belongs.

// Keeps what the capture did to the element's visibility, in order.
function positioned(pos, top, bottom) {
  const seen = [];
  return {
    pos, seen,
    getBoundingClientRect: () => ({ top, bottom }),
    style: { set visibility(v) { seen.push(v); }, get visibility() { return seen.length ? seen[seen.length - 1] : ''; } },
  };
}

test('leaves a sticky element that starts below the first screen alone', async () => {
  const heading = positioned('sticky', 900, 960); // a sticky table header a screen down
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [heading] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(heading.seen, [], 'blanked a sticky element the first slice never showed');
});

test('still hides a sticky header the first screen shows', async () => {
  const header = positioned('sticky', 0, 60);
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [header] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(header.seen, ['hidden', ''], 'a pinned sticky header was stitched into every slice');
});

test('still hides a fixed element wherever it sits', async () => {
  const button = positioned('fixed', 700, 760); // a back-to-top button, pinned to the viewport
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [button] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(button.seen, ['hidden', ''], 'a fixed element was left to repeat down the stitch');
});

test('runs no sticky pass on a page that fits one screen', async () => {
  const { ctx, scriptCalls } = load({ de: el(700, 700), body: el(700, 700), ih: 700 });
  await ctx.captureFullPage(TAB);
  // measurePage, the one scroll, and the scroll back: no marking, no hiding.
  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'reportFrame', 'scrollAndReport'], 'ran the sticky passes on a page with one slice');
});

test('marks and hides once on a page that needs several slices', async () => {
  const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  // the marking, the hiding, and the restore - one each, however many slices
  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 3, 'the marking or the hiding ran more than once');
});

// --- a window that stops drawing -------------------------------------------
// captureVisibleTab hands back the last frame the window presented. A window
// that isn't drawing - minimized, occluded - presents none, so every slice came
// back as the frame before it. The offsets still advanced and the tab was still
// the one showing, so neither guard fired: the stitch drew that one screen at
// every offset and saved a tall image that is the first screen over and over.

test('stops rather than stitch the same frame down the canvas', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), frozenAt: 1 });
  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [], 'stitched a frame the window never drew');
});

test('stops when the window stops drawing on the last slice', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), frozenAt: 4 });
  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068],
    'saved a last slice repeating the one before it');
});

test('puts the page back when the window stops drawing', async () => {
  const body = el(3052, 767);
  body.scrollTop = 640;
  const header = { style: { visibility: '' } };
  const { ctx } = load({ de: el(767, 767), body, fixed: [header], frozenAt: 2 });
  await assert.rejects(() => ctx.captureFullPage(TAB), /not drawing/);
  assert.strictEqual(body.scrollTop, 640, 'left scrolled to where the stitch stopped');
  assert.strictEqual(header.style.visibility, '', 'left the pinned header hidden');
});

test('still stitches every slice of a window that is drawing', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068, 4570],
    'a drawing window lost slices to the frame check');
});

test('saves a page whose flat stretch shoots the same slice twice', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), sameAt: [3] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068, 4570],
    'a long gap or a plain background lost the whole capture');
});

test('saves a page flat enough to shoot the same slice three times over', async () => {
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767), sameAt: [2, 3, 4] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 1534, 3068, 4570],
    'a page of one flat colour lost the whole capture');
});
