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
  };
}

// Reports overflow but refuses to move: an overlay-locked page, or a scroller
// nested somewhere we can't reach.
function lockedEl(scrollHeight, clientHeight) {
  return { scrollHeight, clientHeight, get scrollTop() { return 0; }, set scrollTop(_v) {} };
}

// background.js in a sandbox wired to a fake page. chrome.*, the canvas, and
// the capture are all mocked — nothing real is touched.
function load({ de, body, iw = 1512, ih = 767, dpr = 2 }) {
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
  const context = {
    console,
    URL, btoa, Date, clearTimeout,
    setTimeout: (fn) => fn(),      // collapse the settle sleeps so tests stay fast
    document: { documentElement: de, body, scrollingElement: de, querySelectorAll: () => [] },
    window: {
      innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr,
      // Faithful to the browser: window.scrollTo drives the document scroller.
      // It therefore does nothing when html is pinned to the viewport height,
      // which is exactly the case that broke.
      scrollTo: (_x, y) => { if (de) de.scrollTop = y; },
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
          return 'data:image/png;base64,AAAA';
        },
      },
      runtime: { onMessage: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    },
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
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
