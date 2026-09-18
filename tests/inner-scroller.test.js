const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const PNG = 'data:image/png;base64,AAAA';

class HTMLElement {}

// Minimal load function for our inner scroller tests
function load({ body, inner, iw = 1512, ih = 767, dpr = 2 }) {
  const canvases = [];
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; this.draws = []; canvases.push(this); }
    getContext() { const self = this; return { drawImage: function(_img, sx, sy, sw, sh, dx, dy, dw, dh) { self.draws.push(arguments.length > 5 ? {sx, sy, sw, sh, dx, dy, dw, dh} : { sx: 0, sy: _img, sw: sx, sh: sy }) }, fillStyle: '', fillRect() {} }; }
    async convertToBlob() { return { type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; }
  }
  const captureAt = [];
  let last = PNG;
  let captureTimeout;
  let pageScriptTimeout;
  const context = {
    console, URL, btoa, Date, clearTimeout, setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); }, HTMLElement,
    document: { documentElement: body, body, scrollingElement: body, querySelectorAll: () => (inner ? [inner] : []) },
    requestAnimationFrame: (cb) => { cb(); },
    getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }),
    window: { innerWidth: iw, innerHeight: ih, devicePixelRatio: dpr, scrollTo: (x, y) => { if (body) body.scrollTo(typeof x === 'object' ? x : { left: x, top: y }); }, getComputedStyle: (e) => ({ position: 'static', overflow: 'visible', overflowY: e === inner ? 'auto' : 'visible' }) },
    OffscreenCanvas: FakeCanvas,
    createImageBitmap: async () => ({ width: iw * dpr, height: ih * dpr }),
    fetch: async () => ({ blob: async () => ({}) }),
    chrome: {
      scripting: { executeScript: async ({ func, args }) => [{ result: await func.apply(null, args || []) }] },
      tabs: { captureVisibleTab: async () => { const at = inner ? inner.scrollTop : 0; captureAt.push(at); return (last = PNG + at); }, get: async (id) => ({ id, windowId: 9, active: true }) },
      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => {} }, commands: { onCommand: { addListener() {} } }, action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, dom: { openOrClosedShadowRoot: () => null }
    }
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
  return { ctx: context, canvases, captureAt };
}

function el(scrollHeight, clientHeight) {
  let top = 0;
  return {
    scrollHeight, clientHeight,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, Math.max(0, scrollHeight - clientHeight))); },
    scrollTo(o) { this.scrollTop = o.top; },
  };
}

function innerEl(scrollHeight, clientHeight, rect) {
  const e = el(scrollHeight, clientHeight);
  e.getBoundingClientRect = () => rect;
  return e;
}

test('measures inner scroller correctly', () => {
  const body = el(767, 767);
  const inner = innerEl(3000, 500, { top: 100, bottom: 600, height: 500 });
  const { ctx } = load({ body, inner });
  const m = ctx.measurePage();
  assert.strictEqual(m.total, 3000);
  assert.strictEqual(m.vh, 500);
  assert.strictEqual(m.rect.top, 100);
  assert.strictEqual(m.rect.bottom, 600);
  assert.strictEqual(m.rect.height, 500);
});

test('captureFullPage for inner scroller', async () => {
  const body = el(767, 767);
  const inner = innerEl(3000, 500, { top: 100, bottom: 600, height: 500 });
  const { ctx, canvases, captureAt } = load({ body, inner });
  await ctx.captureFullPage({ id: 1, windowId: 9 });
  assert.strictEqual(canvases[0].height, (100 + 3000 + 167) * 2); // (top + total + (767-600)) * 2
  assert.deepStrictEqual(captureAt, [0, 500, 1000, 1500, 2000, 2500]);
});

test('captureFullPage with inner scroller exceeding viewport at bottom', async () => {
  const body = el(767, 767);
  // Extends below 767
  const inner = innerEl(3000, 800, { top: 100, bottom: 900, height: 800 });
  const { ctx, canvases } = load({ body, inner });
  await ctx.captureFullPage({ id: 1, windowId: 9 });
  // footerH = Math.max(0, 767 - 900) = 0
  // pageHeight = Math.max(0, 100) + 3000 + 0 = 3100
  assert.strictEqual(canvases[0].height, 3100 * 2);
  
  // sliceBottom = Math.min(767, 900) = 767
  // sliceH = 767 - 100 = 667
  const draws = canvases[0].draws;
  // first draw is header, second is footer (not drawn if 0), third is slice
  const headerDraw = draws[0];
  assert.strictEqual(headerDraw.sh, 100 * 2);
});

test('captureFullPage with inner scroller exceeding viewport at top', async () => {
  const body = el(767, 767);
  // Extends above 0
  const inner = innerEl(3000, 800, { top: -100, bottom: 700, height: 800 });
  const { ctx, canvases } = load({ body, inner });
  await ctx.captureFullPage({ id: 1, windowId: 9 });
  // headerH = Math.max(0, -100) = 0
  // footerH = Math.max(0, 767 - 700) = 67
  // pageHeight = 0 + 3000 + 67 = 3067
  assert.strictEqual(canvases[0].height, 3067 * 2);
  
  const sliceDraw = canvases[0].draws[0];
  assert.strictEqual(sliceDraw.sy, 0); // sliceTop = Math.max(0, -100) = 0
  assert.strictEqual(sliceDraw.sh, 700 * 2); // sliceBottom(700) - 0
  const footerDraw = canvases[1].draws[0];
  assert.strictEqual(footerDraw.sh, 67 * 2);
});
