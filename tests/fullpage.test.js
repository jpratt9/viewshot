const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

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
function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], failAt = 0, leaveAt = 0, leave = {} }) {
  const canvases = [];
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
    getContext() {
      return { drawImage: (_img, x, y) => this.draws.push({ x, y }), fillStyle: '', fillRect() {} };
    }
    async convertToBlob() {
      return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
  }

  // Where the page really sat at the moment of each capture. Draw offsets alone
  // can't catch the bug: the old code drew at the offsets it asked for, which
  // look right even though every slice was the same unmoved viewport.
  const captureAt = [];
  const scriptCalls = [];
  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  const context = {
    console,
    URL, btoa, Date, clearTimeout,
    // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
    setTimeout: (fn, ms) => { if (ms !== captureTimeout) fn(); },
    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => fixed },
    getComputedStyle: (e) => ({ position: fixed.includes(e) ? 'fixed' : 'static' }),
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
          return [{ result: func.apply(null, args || []) }];
        },
      },
      tabs: {
        captureVisibleTab: async () => {
          captureAt.push(Math.max(de ? de.scrollTop : 0, body ? body.scrollTop : 0));
          if (captureAt.length === failAt) throw new Error('capture failed');
          return 'data:image/png;base64,AAAA';
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
