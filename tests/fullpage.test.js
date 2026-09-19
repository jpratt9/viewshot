const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const PNG = 'data:image/png;base64,AAAA';

// The page's HTMLElement. chrome.dom.openOrClosedShadowRoot takes one of these
// and nothing else: Chrome 153 throws on an <svg> (KAN-507).
class HTMLElement {}

// A scrollable element that clamps writes the way a real one does — clamping is
// what makes the last slice overlap the previous, so the tests need it.
function el(scrollHeight, clientHeight) {
  let top = 0;
  return {
    scrollHeight, clientHeight,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - clientHeight))); },
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
function load({ de, body, iw = 1512, ih = 767, dpr = 2, fixed = [], light = fixed, anchorOff = [], snapOn = [], failAt = 0, leaveAt = 0, leave = {}, frozenAt = 0, sameAt = [] }) {
  const canvases = [];
  const styles = new Map(); // the <style> elements the capture puts in the page, by id
  if (de) {
    de.prepend = de.prepend || ((s) => styles.set(s.id, s));
    de.appendChild = de.appendChild || ((s) => styles.set(s.id, s));
  }
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
  // And what each capture showed of the fixed and sticky elements: the
  // visibility each one had at that moment, in the order the test passed them.
  const shownAt = [];
  let last = PNG;
  const scriptCalls = [];
  const sent = []; // what the worker told the popup
  let onMessage; // background.js's chrome.runtime.onMessage listener
  let captureTimeout; // CAPTURE_TIMEOUT_MS, read once background.js has loaded
  let pageScriptTimeout; // CAPTURE_SCRIPT_TIMEOUT_MS, likewise
  const observers = []; // the MutationObservers the capture makes in the page
  const context = {
    console,
    URL, btoa, Date, clearTimeout,
    // Collapse the settle sleeps so tests stay fast. The capture deadline never passes.
    setTimeout: (fn, ms) => { if (ms !== captureTimeout && ms !== pageScriptTimeout) fn(); },
    HTMLElement,
    // light: what document.querySelectorAll('*') finds, which is all of `fixed`
    // unless a test puts some of them in a shadow root and passes its host.
    // anchorOff: what the query for an inline `overflow-anchor` finds, and
    // snapOn: what the one for an inline `scroll-snap-type` finds.
    document: {
      documentElement: de, body, scrollingElement: de, querySelectorAll: (sel) => (sel === '*' ? light : sel.includes('scroll-snap-type') ? snapOn : anchorOff),
      getElementById: (id) => styles.get(id) || null,
      createElement: () => ({ remove() { styles.delete(this.id); } }),
      head: {},
    },
    // The capture's observers: what each one watches, until it is disconnected.
    // Nothing calls one back unless a test does, as the browser would once the
    // page's script has run.
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.on = null; observers.push(this); }
      observe(node) { this.on = node; }
      disconnect() { this.on = null; }
    },
    // A window that is drawing runs the callback; from frozenAt on it never does.
    // The probe for slice k runs before capture k, so captureAt is one short.
    requestAnimationFrame: (cb) => { if (!frozenAt || captureAt.length < frozenAt - 1) cb(); },
    getComputedStyle: (e) => ({ position: fixed.includes(e) ? (e.pos || 'fixed') : 'static', overflow: e.overflow || 'visible' }),
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
      scripting: { insertCSS: async () => {}, removeCSS: async () => {},
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
          shownAt.push(fixed.map((e) => e.style.visibility));
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
      runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async (m) => { sent.push({ ...m }); } }, // copy out of the vm realm
      commands: { onCommand: { addListener() {} } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      dom: {
        openOrClosedShadowRoot: (e) => {
          if (!(e instanceof HTMLElement)) throw new Error('Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): ');
          return e.root || null;
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(CODE, context);
  captureTimeout = vm.runInContext('CAPTURE_TIMEOUT_MS', context);
  pageScriptTimeout = vm.runInContext('CAPTURE_SCRIPT_TIMEOUT_MS', context);
  return { ctx: context, canvases, scriptCalls, captureAt, shownAt, sent, styles, observers, message: (m) => onMessage(m, {}, () => {}) };
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
  assert.strictEqual(ctx.scrollAndReport(1534).actual, 1534);
  assert.strictEqual(body.scrollTop, 1534);
});

test('a request past the end reports the clamped offset, not the request', () => {
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
  assert.strictEqual(ctx.scrollAndReport(99999).actual, 3052 - 767);
});

test('a page that refuses to scroll reports 0 rather than the request', () => {
  const { ctx } = load({ de: lockedEl(3052, 767), body: el(767, 767) });
  assert.strictEqual(ctx.scrollAndReport(1534).actual, 0);
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
  assert.strictEqual(ctx.scrollAndReport(1600).actual, 1600);
  assert.strictEqual(de.scrollTop, 1600);
});

test('a smooth-scrolling body scroller also lands before it reports', () => {
  // html,body{height:100%;overflow-x:hidden} with body{scroll-behavior:smooth}.
  const body = smoothEl(3052, 767);
  const { ctx } = load({ de: el(767, 767), body });
  assert.strictEqual(ctx.scrollAndReport(1534).actual, 1534);
  assert.strictEqual(body.scrollTop, 1534);
});

test('stitches every screen of a smooth-scrolling page', async () => {
  const { ctx, captureAt } = load({ de: smoothEl(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200], 'stopped before the end of the page');
});

// --- content above the screen that changes height --------------------------
// Each slice was drawn where the page was when it was shot. Content above the
// screen that loads in or goes away moves everything under it, and Chrome's
// scroll anchoring moves the page with it, so every slice after that was drawn
// off from the ones before: the rows the page grew by went in twice, and the
// rows it shrank by not at all. They are now drawn back by as much (KAN-515).

// A page whose content above the screen changes height by `by` px while the
// second slice settles, with the offset moved by as much, the way scroll
// anchoring does it.
function anchoredPage(by) {
  let height = 3000, top = 0, changed = false;
  const body = {
    clientHeight: 713,
    get scrollHeight() { return height; },
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, height - 713)); },
    scrollTo(o) { this.scrollTop = o.top; },
  };
  const page = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  const timer = page.ctx.setTimeout;
  page.ctx.setTimeout = (fn, ms) => { if (ms === 500 && top && !changed) { changed = true; height += by; top += by; } return timer(fn, ms); };
  return page;
}

test('lines the slices up after content above the screen grows', async () => {
  const { ctx, canvases, captureAt } = anchoredPage(300);
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 1013, 1726, 2439, 2587]);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], 'drew the rows the page grew by twice');
});

test('lines the slices up after content above the screen shrinks', async () => {
  const { ctx, canvases, captureAt } = anchoredPage(-300);
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 413, 1126, 1839, 1987]);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], 'left out the rows the page shrank by');
});

test('stops after one slice when a scroll comes back with nothing', async () => {
  // A scroll with no result reads as a page that won't advance, as it did
  // before the scroll reported where it started. Without `from` in
  // scrollPageTo's fallback, the slice is drawn at NaN and the stitch never
  // ends (KAN-515).
  const { ctx, canvases } = load({ de: el(767, 767), body: el(3052, 767) });
  const run = ctx.chrome.scripting.executeScript;
  let scrolls = 0;
  ctx.chrome.scripting.executeScript = async (o) => {
    if (o.func.name !== 'scrollAndReport' || ++scrolls === 1) return run(o);
    if (scrolls > 5) throw new Error('kept on scrolling');
    return [{}];
  };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0], 'went on past a scroll that came back with nothing');
});

// --- a page that scrolls itself between slices -----------------------------
// Each slice scrolled on from where the page was, so a page that scrolled
// itself between slices had its own scroll taken for content above the screen
// changing height: the rows it scrolled past were left out, and every slice
// after was drawn that far above where the page has it. A page as tall as it
// was when the last slice's scroll left it has had nothing above change
// height, so the next slice now scrolls on from where that scroll left it
// (KAN-576).


test('KAN-590: lines the slices up on a page that scrolls itself and grows', async () => {
  const body = el(3000, 713);
  let baseScroll = 0;
  body.querySelectorAll = () => {
    baseScroll = body.scrollTop;
    return [{ getBoundingClientRect: () => ({ top: 100 - (body.scrollTop - baseScroll), bottom: 110 - (body.scrollTop - baseScroll), height: 10 }) }];
  };
  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  ctx.chrome.tabs.captureVisibleTab = async (...a) => {
    const url = await shoot(...a);
    if (captureAt.length === 2) {
      body.scrollTop += 200;
      body.scrollHeight += 100;
    }
    return url;
  };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2387]);
});

test('lines the slices up on a page that scrolls itself between them', async () => {
  const body = el(3000, 713);
  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  // The page scrolls itself 200 px down right after the second shot. Its height doesn't change.
  ctx.chrome.tabs.captureVisibleTab = async (...a) => { const url = await shoot(...a); if (captureAt.length === 2) body.scrollTop += 200; return url; };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'scrolled on from where the page scrolled itself to');
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287], "drew the slices back by the page's own scroll");
  assert.strictEqual(canvases[canvases.length - 1].height, 3000, "cut the image short by the page's own scroll");
});

// --- a page that scrolls itself while a slice settles ----------------------
// Each slice was drawn where its scroll left the page, and shot once the page
// had settled. A page that scrolled itself while the slice settled was shot
// where it scrolled to: the rows between were left out, and the ones past them
// went in twice. The frame check now says where the page is, and a page that
// has moved and is as tall as it was goes back (KAN-592). It was then shot
// without settling again: a page that scrolls itself on every settle did it
// again, and was shot where it scrolled to (KAN-596). That shot caught what
// the put-back set off, a fade-in for one, part-way, so the slice now settles
// once more first. A page that moves again in that settle goes back a second
// time, and is shot without settling (KAN-599). A slice shot again for a
// fixed element (KAN-525) goes back the same way before that second shot
// (KAN-605).

test('puts a page that scrolls itself while a slice settles back before it shoots that slice', async () => {
  const body = el(3000, 713);
  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  // The page scrolls itself 200 px down while the second slice settles. Its height doesn't change.
  let scrolled = false;
  const timer = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && !scrolled) { scrolled = true; body.scrollTop += 200; } return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'shot the second slice where the page scrolled itself to');
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 713, 1426, 2139, 2287]);
  assert.strictEqual(canvases[canvases.length - 1].height, 3000, 'cut the image short');
});

test('shoots a slice it puts back before the page scrolls itself again', async () => {
  // A page that scrolls itself 200 px down each time the second slice
  // settles. It stops after five, so a stitch that puts it back every time
  // still ends.
  const body = el(3000, 713);
  const { ctx, canvases, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  let scrolls = 0;
  const timer = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'let the page settle again, and shot it where it scrolled itself to');
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 913, 1426, 2139, 2287]);
  assert.strictEqual(canvases[canvases.length - 1].height, 3000, 'cut the image short');
  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 8, 'did not put the page back twice');
});

test('shoots a slice where the page is when it scrolls itself again before that shot', async () => {
  // A page that scrolls itself 200 px down each time it is asked for a frame
  // at 713, straight after it is put back too. It stops after five, so a
  // stitch that puts it back every time still ends.
  const body = el(3000, 713);
  const { ctx, canvases, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  let scrolls = 0;
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return frame(cb); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'put the page back more than twice');
  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 8, 'did not put the page back twice');
  assert.deepStrictEqual(canvases[0].draws.map((d) => d.y), [0, 913, 1426, 2139, 2287], 'drew the slice where it was shot');
});

test('lets a slice it puts back settle before it shoots it', async () => {
  // A page that scrolls itself 200 px down while the second slice settles,
  // with a band that fades in each time a scroll brings it back on screen.
  // The fade only finishes in a settle that no scroll cuts short.
  const body = el(3000, 713);
  const { ctx, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  let scrolled = false, seen = 0, faded = true;
  const fadedAt = []; // whether the band had finished fading in, at each shot
  const look = () => { if (body.scrollTop !== seen) { seen = body.scrollTop; faded = false; } };
  const timer = ctx.setTimeout, shoot = ctx.chrome.tabs.captureVisibleTab;
  ctx.setTimeout = (fn, ms) => {
    look();
    if (ms === 500) {
      if (body.scrollTop === 713 && !scrolled) { scrolled = true; body.scrollTop += 200; look(); } else faded = true;
    }
    return timer(fn, ms);
  };
  ctx.chrome.tabs.captureVisibleTab = async (...a) => { look(); fadedAt.push(faded); return shoot(...a); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287], 'shot the second slice where the page scrolled itself to');
  assert.deepStrictEqual(fadedAt, [true, true, true, true, true], 'shot the slice it put back before the band faded in');
});

test("puts a page that scrolls itself while a slice's second shot settles back before that shot", async () => {
  // A banner turns up after the second slice's last fixed hide, so that slice
  // is shot again (KAN-525), and the page scrolls itself 200 px down while
  // that second shot settles. The second shot is the one drawn, where the
  // slice's scroll left the page, so the page goes back before it (KAN-605).
  const body = el(3000, 713);
  const banner = positioned('fixed', 663, 713);
  const light = []; // what the page has in it
  const { ctx, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1, fixed: [banner], light });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && !light.length) light.push(banner); return frame(cb); };
  let scrolled = false;
  const timer = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && light.length && body.scrollTop === 713 && !scrolled) { scrolled = true; body.scrollTop += 200; } return timer(fn, ms); };
  // Which shots the stitch draws: each one's URL carries its number.
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  ctx.chrome.tabs.captureVisibleTab = async (...a) => `${await shoot(...a)}#${captureAt.length}`;
  const drawn = [];
  const get = ctx.fetch;
  ctx.fetch = (url) => { drawn.push(Number(url.split('#')[1])); return get(url); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 2139, 2287], 'shot the slice again where the page scrolled itself to');
  assert.deepStrictEqual(drawn, [1, 3, 4, 5, 6]);
});

test('shoots a slice it put back twice only once, even when a fixed element turns up after that shot', async () => {
  // A page that scrolls itself 200 px down each time the second slice
  // settles, five times at most, so that slice is put back twice and shot on
  // its third round. A banner turns up in the frame that shot waits for,
  // after its last fixed hide. A slice that was put back isn't shot again.
  const body = el(3000, 713);
  const banner = positioned('fixed', 663, 713);
  const light = []; // what the page has in it
  const { ctx, captureAt, scriptCalls } = load({ de: el(713, 713), body, ih: 713, dpr: 1, fixed: [banner], light });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && !light.length) light.push(banner); return frame(cb); };
  let scrolls = 0;
  const timer = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && scrolls < 5) { scrolls++; body.scrollTop += 200; } return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 913, 1426, 2139, 2287], 'shot the slice it put back twice again');
  assert.strictEqual(scriptCalls.filter((f) => f === 'scrollAndReport').length, 8, 'did not put the page back twice');
});

// --- pages that turn scroll anchoring off ----------------------------------
// The stitch sees content above the screen change height by how far scroll
// anchoring moves the offset (KAN-515). A page with `overflow-anchor: none`
// moves the rows on screen instead, so the slices after it were drawn off from
// the ones before. Anchoring is now on for every element while the page is
// shot, with a rule put in the way the scrollbar one is (KAN-575). The rule
// sits in a cascade layer, so a page's own `!important` on a more specific
// selector doesn't outrank it (KAN-581). It goes first in <head>, so its layer
// comes before any the page declares (KAN-582). No style sheet rule outranks
// an `!important` in a style attribute, so an element with one gets the
// capture's own inline value for the capture (KAN-583).




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
// have shown it, leaving blank space where it belongs (KAN-218). Sparing it
// then stitched it in again at the top of every later slice it stayed stuck
// in (KAN-403): a sticky element is hidden only in the slices it is stuck in.
// A `bottom` one can be stuck already at the top of the page, so each one's
// place is read as `static`, and the first slice is checked too (KAN-501).
// And a place can move while the capture runs, so it is read on every slice
// (KAN-502). One can also be added to the page, or turn sticky, once the page
// has scrolled, so every slice lists the ones that have (KAN-503). The page can
// do that while the slice settles, too, so each slice lists and checks them
// again once it has (KAN-517).

// Keeps what the capture did to the element's visibility, in order, and holds
// the inline `position` a capture sets on it and puts back.
function positioned(pos, top, bottom) {
  const seen = [];
  const inline = {}; // property -> [value, priority]
  return {
    pos, seen,
    getBoundingClientRect: () => ({ top, bottom }),
    getRootNode: () => ({}), // the document, which has no host
    style: {
      set visibility(v) { seen.push(v); }, get visibility() { return seen.length ? seen[seen.length - 1] : ''; },
      setProperty(name, value, priority = '') { if (value) inline[name] = [value, priority]; else delete inline[name]; },
      getPropertyValue: (name) => (inline[name] ? inline[name][0] : ''),
      getPropertyPriority: (name) => (inline[name] ? inline[name][1] : ''),
    },
  };
}

// A `top: 0` sticky element whose place in the page is `at`, in a container
// that ends at `end`: in its place until the page scrolls past it, then stuck
// to the top of the viewport until the end of its container carries it off.
function stickyAt(scroller, at, end, height = 40) {
  const e = positioned('sticky');
  e.getBoundingClientRect = () => {
    const y = scroller.scrollTop;
    // `static` puts it in its place, stuck or not
    const top = e.style.getPropertyValue('position') === 'static' ? at - y : Math.min(Math.max(at - y, 0), end - height - y);
    return { top, bottom: top + height };
  };
  return e;
}

// A `bottom: 0` sticky element whose place in the page is `at`, in a container
// that starts at `start`: stuck to the bottom of a `vh` viewport until the page
// scrolls down to its place, and in it from then on.
function stickyToBottomAt(scroller, at, start, vh, height = 40) {
  const e = positioned('sticky');
  e.getBoundingClientRect = () => {
    const y = scroller.scrollTop;
    const top = e.style.getPropertyValue('position') === 'static' ? at - y : Math.max(Math.min(at - y, vh - height), start - y);
    return { top, bottom: top + height };
  };
  return e;
}

test('hides a sticky heading only in the slices it is stuck in', async () => {
  // The ticket's page: 3000 px tall in a 713 px viewport, with a 40 px heading
  // whose place is 1200 px down, in a container running to 2600 px.
  const body = el(3000, 713);
  const heading = stickyAt(body, 1200, 2600);
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // Shown in the slice that holds its place, hidden in the three it is stuck at the top of.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into a slice it was stuck in');
  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
});

test('shows a sticky heading in the slice that holds its place after the place moves', async () => {
  // The same page, but content above the heading loads in once the page
  // scrolls, the way a lazy image does, and pushes it 300 px down: its place
  // goes from 1200 px to 1500, and its container's end from 2600 to 2900. The
  // place read at the top is not where the page has it by then (KAN-502).
  const body = el(3000, 713);
  const heading = positioned('sticky');
  heading.getBoundingClientRect = () => {
    const y = body.scrollTop, at = y ? 1500 : 1200;
    const top = heading.style.getPropertyValue('position') === 'static' ? at - y : Math.min(Math.max(at - y, 0), at + 1400 - 40 - y);
    return { top, bottom: top + 40 };
  };
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // In its new place in the third slice, stuck at the top of the last two.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', '', 'hidden', 'hidden'], 'blanked the heading out of the slice that holds its new place, or stitched it in where it was stuck');
  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
});

test('hides a sticky heading the page adds after the first slice in the slices it is stuck in', async () => {
  // The first test's page, but the heading's section is only put in the page
  // once it scrolls, the way a list that renders as it goes does: the pass on
  // the first slice can't find it (KAN-503).
  const body = el(3000, 713);
  const heading = stickyAt(body, 1200, 2600);
  const light = []; // what the page has in it
  const scrollTo = body.scrollTo;
  body.scrollTo = function (o) { scrollTo.call(this, o); if (this.scrollTop && !light.length) light.push(heading); };
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading], light });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // In its place in the second slice, stuck at the top of the last three.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into a slice it was stuck in');
  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
});

test('hides a header the page only makes sticky once it scrolls', async () => {
  // A 60 px header at the top of the page that turns sticky once the page has
  // scrolled: the pass on the first slice reads it as static (KAN-503).
  const body = el(3000, 713);
  const header = stickyAt(body, 0, 3000, 60);
  Object.defineProperty(header, 'pos', { get: () => (body.scrollTop ? 'sticky' : 'static') });
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into a slice it was stuck in');
  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
});

test('starts a new sticky list on the first slice', async () => {
  // A capture that never got to its restore leaves its list on the page. The
  // next one lists the page afresh on its first slice rather than adding to
  // that list: an element on it may have left the page since (KAN-503).
  const gone = positioned('sticky', 100, 140);
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
  ctx.window.__shotSticky = [[gone, '']];
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(gone.seen, [], 'wrote to an element on a list an earlier capture left behind');
});

test('hides a header the page makes sticky while the second slice settles, in that slice', async () => {
  // A 60 px header at the top of the page that the page makes sticky on a timer
  // its first scroll starts: the second slice's listing still reads it as
  // static, and it is stuck at once (KAN-517).
  const body = el(3000, 713);
  const header = stickyAt(body, 0, 3000, 60);
  let turned = false;
  Object.defineProperty(header, 'pos', { get: () => (turned ? 'sticky' : 'static') });
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713) turned = true; return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slice it turned sticky in');
  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
});

test('hides a sticky heading the page adds while the second slice settles, in that slice', async () => {
  // A 40 px heading whose place is 300 px down, in a container running to
  // 2600 px, that the page puts in on a timer its first scroll starts: the
  // second slice's listing can't find it, and it is stuck at once (KAN-517).
  const body = el(3000, 713);
  const heading = stickyAt(body, 300, 2600);
  const light = []; // what the page has in it
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading], light });
  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && !light.length) light.push(heading); return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // Not in the page for the first slice, stuck at the top of the four after.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the heading was stitched into the slice it turned up in');
  assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
});

test('hides a bar the page makes sticky while the first slice settles, in that slice', async () => {
  // The page was scrolled when the capture started, so the scroll to the top is
  // the capture's own too. A 40 px `bottom: 0` bar whose place is 2400 px down,
  // made sticky on a timer that scroll starts, is stuck to the bottom of the
  // first screen at once (KAN-517).
  const body = el(3000, 713);
  body.scrollTop = 640;
  const bar = stickyToBottomAt(body, 2400, 0, 713);
  let turned = false;
  Object.defineProperty(bar, 'pos', { get: () => (turned ? 'sticky' : 'static') });
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [bar] });
  const timer = ctx.setTimeout; // the page's timer runs during the first slice's 500 ms settle
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 0) turned = true; return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  // Stuck to the bottom of the first three slices, in its place in the last two.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['hidden', 'hidden', 'hidden', '', ''], 'the bar was stitched into the first slice, where it was stuck');
  assert.strictEqual(bar.style.visibility, '', 'left the bar hidden');
});

test('leaves a sticky element that is never stuck alone', async () => {
  const body = el(3052, 767);
  const heading = stickyAt(body, 900, 940); // its container ends where it does, so it only ever scrolls by
  const { ctx } = load({ de: el(767, 767), body, fixed: [heading] });
  await ctx.captureFullPage(TAB);
  assert.ok(!heading.seen.includes('hidden'), 'blanked a sticky element that was never stuck');
});

test('gives a sticky element back its own visibility, in its place and after the capture', async () => {
  const body = el(3000, 713);
  const heading = stickyAt(body, 1200, 2600);
  heading.style.visibility = 'visible'; // set on the element by the page itself
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['visible', 'visible', 'hidden', 'hidden', 'hidden'], 'lost the visibility the page gave the heading');
  assert.strictEqual(heading.style.visibility, 'visible', 'restored the heading to something other than its own visibility');
});

test('counts a sticky element within a pixel of its place as in it', async () => {
  const body = el(3052, 767);
  const heading = stickyAt(body, 900, 940); // never stuck
  // Rects are fractional: once the page has scrolled, this one is painted half a pixel off where `static` puts it.
  const exact = heading.getBoundingClientRect;
  heading.getBoundingClientRect = () => { const r = exact(); const d = body.scrollTop && heading.style.getPropertyValue('position') !== 'static' ? 0.5 : 0; return { top: r.top + d, bottom: r.bottom + d }; };
  const { ctx } = load({ de: el(767, 767), body, fixed: [heading] });
  await ctx.captureFullPage(TAB);
  assert.ok(!heading.seen.includes('hidden'), 'blanked a sticky element half a pixel from its place');
});

test('still hides a sticky header the first screen shows', async () => {
  const body = el(3052, 767);
  const header = stickyAt(body, 0, 3052, 60);
  const { ctx, shownAt } = load({ de: el(767, 767), body, fixed: [header] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden'], 'a pinned sticky header was stitched into every slice');
  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
});

test('shows a bottom-sticky bar at its own place, not over the first screen', async () => {
  // A 40 px `bottom: 0` bar whose place is 2400 px down, in a container that
  // starts at the top: at the top of the page it is stuck to the bottom of the
  // screen. It carries the page's own inline `position: sticky !important`.
  const body = el(3000, 713);
  const bar = stickyToBottomAt(body, 2400, 0, 713);
  bar.style.setProperty('position', 'sticky', 'important');
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [bar] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // Stuck to the bottom of the first three slices, in its place in the last two.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['hidden', 'hidden', 'hidden', '', ''], 'the bar was stitched in where it was stuck, or blanked out of its own place');
  assert.strictEqual(bar.style.visibility, '', 'left the bar hidden');
  assert.deepStrictEqual([bar.style.getPropertyValue('position'), bar.style.getPropertyPriority('position')], ['sticky', 'important'], 'did not put the page\'s own position back');
});

test('leaves a sticky element stuck inside a scroller of its own where it is painted', async () => {
  // A table header stuck to the top of a scrolled box. The box moves with the
  // page, so the header does too; `static` would put it 300 px further up, out
  // of the box's view, which is not where the page shows it. Any overflow but
  // visible and clip makes the box a scroller ('hidden auto' is overflow-x
  // hidden, overflow-y auto).
  for (const overflow of ['auto', 'scroll', 'hidden', 'hidden auto']) {
    const body = el(3052, 767);
    const header = positioned('sticky');
    header.parentElement = { overflow }; // the box
    header.getBoundingClientRect = () => {
      const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
      return { top, bottom: top + 30 };
    };
    const { ctx } = load({ de: el(767, 767), body, fixed: [header] });
    await ctx.captureFullPage(TAB);
    assert.ok(!header.seen.includes('hidden'), `blanked a header stuck inside its own scroller (overflow: ${overflow})`);
  }
});

test('reads a sticky element as the page\'s when nothing between it and the page scrolls', async () => {
  // overflow: clip makes no scroller, and <body> and <html> are the page
  // itself whatever their own overflow says: <body> is the scroller on a page
  // whose <body> scrolls, and <html> can hold elements added straight to it.
  const cases = {
    'a wrapper with overflow: clip': (body) => ({ overflow: 'clip', parentElement: body }),
    '<body>, scrolling': (body) => Object.assign(body, { overflow: 'auto' }),
    '<html>, overflow: hidden': (_body, de) => Object.assign(de, { overflow: 'hidden' }),
  };
  for (const [name, parent] of Object.entries(cases)) {
    const body = el(3000, 713), de = el(713, 713);
    const bar = stickyToBottomAt(body, 2400, 0, 713);
    bar.parentElement = parent(body, de);
    const { ctx, shownAt } = load({ de, body, ih: 713, fixed: [bar] });
    await ctx.captureFullPage(TAB);
    assert.deepStrictEqual(shownAt.map(([v]) => v), ['hidden', 'hidden', 'hidden', '', ''], `read the bar as painted under ${name}`);
  }
});

test('puts a bar hidden on the first slice back when the capture stops there', async () => {
  // A page that won't scroll stops the stitch before the second slice's fixed
  // hide, the step that used to be the only one with anything to put back.
  const body = lockedEl(3052, 767);
  const bar = stickyToBottomAt(body, 2400, 0, 767);
  const { ctx, captureAt } = load({ de: el(767, 767), body, fixed: [bar] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0], 'the stitch did not stop at the first slice');
  assert.strictEqual(bar.style.visibility, '', 'left the bar hidden');
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

test('hides fixed elements before and after the settle and after the shot on every slice but the first, and lists and checks sticky ones before and after the settle on every slice', async () => {
  const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(3052, 767) });
  await ctx.captureFullPage(TAB);
  // the fixed hide three times on each of the three slices after the first, the restore once, and the sticky listing and check three times on each of the four slices
  assert.strictEqual(scriptCalls.filter((n) => n === 'func').length, 25, 'the fixed hide ran on the first slice or missed a later one, its settle or its shot, or a slice or its settle went unlisted or unchecked');
});

// --- fixed elements that turn up after the second slice ---------------------
// The fixed hide ran once, on the second slice, so a fixed element the page put
// in, or pinned, after it was never hidden: it was stitched into every later
// slice at the same spot on the screen (KAN-516). Every slice after the first
// now hides the ones that have turned up since.

test('hides a fixed element the page adds after the second slice', async () => {
  // A cookie banner the page only puts in once it has scrolled to the third
  // slice: the fixed hide on the second can't find it (KAN-516).
  const body = el(3000, 713);
  const banner = positioned('fixed', 663, 713);
  const light = []; // what the page has in it
  const scrollTo = body.scrollTo;
  body.scrollTo = function (o) { scrollTo.call(this, o); if (this.scrollTop >= 1426 && !light.length) light.push(banner); };
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // Not in the page for the first two slices, hidden in the three after.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the banner was stitched into the slices after it turned up');
  assert.strictEqual(banner.style.visibility, '', 'left the banner hidden');
});

test('hides an element the page only makes fixed after the second slice', async () => {
  // A header the page only pins to the viewport once it has scrolled to the
  // third slice: the fixed hide on the second reads it as static (KAN-516).
  const body = el(3000, 713);
  const header = positioned('fixed', 0, 60);
  Object.defineProperty(header, 'pos', { get: () => (body.scrollTop >= 1426 ? 'fixed' : 'static') });
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slices after it was pinned');
  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
});

test('starts a new fixed list on the first fixed hide', async () => {
  // A capture that never got to its restore leaves its list on the page. The
  // next one's first fixed hide lists the page afresh rather than adding to
  // that list: an element on it may have left the page since (KAN-516).
  const gone = positioned('fixed', 100, 140);
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
  ctx.window.__shotHidden = [[gone, '']];
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(gone.seen, [], 'wrote to an element on a list an earlier capture left behind');
});

// --- fixed elements that turn up while a slice settles ----------------------
// Each slice after the first hid the fixed elements straight after its scroll,
// before the settle, so one the page put in, or pinned, during the settle was
// stitched into that slice at its spot on the screen, and hidden only from the
// next slice on (KAN-522). The fixed hide now runs again once the slice has
// settled, before the frame the shot waits for.

test('hides a fixed element the page adds while the second slice settles', async () => {
  // A banner the page puts in on a timer its first scroll starts: it turns up
  // after the second slice's fixed hide, and before that slice's shot.
  const body = el(3000, 713);
  const banner = positioned('fixed', 663, 713);
  const light = []; // what the page has in it
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713 && !light.length) light.push(banner); return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2287]);
  // Not in the page for the first slice, hidden in the four after.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the banner was stitched into the slice it turned up in');
  assert.strictEqual(banner.style.visibility, '', 'left the banner hidden');
});

test('hides an element the page only makes fixed while the second slice settles', async () => {
  // A header the page pins to the viewport on a timer its first scroll starts:
  // the second slice's fixed hide still reads it as static.
  const body = el(3000, 713);
  const header = positioned('fixed', 0, 60);
  let pinned = false;
  Object.defineProperty(header, 'pos', { get: () => (pinned ? 'fixed' : 'static') });
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
  const timer = ctx.setTimeout; // the page's timer runs during the second slice's 500 ms settle
  ctx.setTimeout = (fn, ms) => { if (ms === 500 && body.scrollTop === 713) pinned = true; return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slice it was pinned in');
  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
});

test('asks for a frame only after the passes that follow the settle', async () => {
  // The shot is taken once the page has started a frame, and that frame has to
  // come after the hides, or the shot can show what they took out (KAN-517).
  const { ctx, scriptCalls } = load({ de: el(767, 767), body: el(1534, 767) }); // two slices
  await ctx.captureFullPage(TAB);
  // the first slice: the sticky listing and check, both again once it has settled, the frame, and both again after the shot;
  // the second: the sticky listing, the fixed hide and the sticky check, all three again once it has settled, the frame, and all three again after the shot
  assert.deepStrictEqual(scriptCalls, ['measurePage', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'func', 'scrollAndReport', 'func', 'func', 'func', 'func', 'reportFrame', 'func', 'func', 'func', 'scrollAndReport'], 'asked for the frame before a pass that follows the settle');
});

// --- fixed elements that turn up after a slice's last fixed hide ------------
// The fixed hide that follows the settle was the last one before the shot. A
// fixed element the page put in, or pinned, after it was stitched into that
// slice at its spot on the screen, and hidden only from the next slice on. And
// the frame check answered from requestAnimationFrame, which runs before its
// frame is painted, so the shot could still show an element that hide took out
// (KAN-525). A fixed hide now runs after the shot too, and one it finds sends
// the slice back to settle and be shot again, once. The frame check answers
// from the frame after the one it asks for.

test('shoots a slice again when a fixed element turns up between its last fixed hide and its shot', async () => {
  // A banner the page puts in from a frame callback of its own, in the frame
  // the second slice's frame check asks for: after that slice's last fixed
  // hide, and before its shot.
  const body = el(3000, 713);
  const banner = positioned('fixed', 663, 713);
  const light = []; // what the page has in it
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713 && !light.length) light.push(banner); return frame(cb); };
  // Which shots the stitch draws: each one's URL carries its number.
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  ctx.chrome.tabs.captureVisibleTab = async (...a) => `${await shoot(...a)}#${captureAt.length}`;
  const drawn = [];
  const get = ctx.fetch;
  ctx.fetch = (url) => { drawn.push(Number(url.split('#')[1])); return get(url); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(drawn, [1, 3, 4, 5, 6], 'the banner was stitched into the slice it turned up in');
  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 2139, 2287]);
  // Not in the page for the first slice, in the second slice's first shot, and hidden in its second shot and the three slices after.
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden', 'hidden']);
  assert.strictEqual(banner.style.visibility, '', 'left the banner hidden');
});

test('shoots a slice again when the page makes an element fixed between its last fixed hide and its shot', async () => {
  // A header the page pins to the viewport in the frame the second slice's
  // frame check asks for: that slice's last fixed hide still read it as static.
  const body = el(3000, 713);
  const header = positioned('fixed', 0, 60);
  let pinned = false;
  Object.defineProperty(header, 'pos', { get: () => (pinned ? 'fixed' : 'static') });
  const { ctx, captureAt, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [header] });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 713) pinned = true; return frame(cb); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden', 'hidden'], 'the header was stitched into the slice it was pinned in');
  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 2139, 2287]);
  assert.strictEqual(header.style.visibility, '', 'left the header hidden');
});

test('settles again and runs the passes that follow the settle before it shoots a slice again', async () => {
  // A second shot straight after the first would wait out the rest of the
  // capture rate limit after its passes, and give the page that long to put
  // in another one.
  const body = el(1534, 767); // two slices
  const banner = positioned('fixed', 700, 767);
  const light = [];
  const { ctx, scriptCalls } = load({ de: el(767, 767), body, fixed: [banner], light });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => { if (body.scrollTop === 767 && !light.length) light.push(banner); return frame(cb); };
  const timer = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => { if (ms === 500) scriptCalls.push('settle'); return timer(fn, ms); };
  await ctx.captureFullPage(TAB);
  // the second slice: the sticky listing, the fixed hide and the sticky check, the settle, all three again, the frame, and all three again after the shot, which finds the banner;
  // then the settle, the three passes that follow it and the frame again, and all three again after the second shot
  assert.deepStrictEqual(scriptCalls, [
    'measurePage',     'scrollAndReport',
    'func',            'func',
    'settle',          'func',
    'func',            'reportFrame',
    'func',            'func',
    'scrollAndReport', 'func',
    'func',            'settle',
    'func',            'func',
    'reportFrame',     'func',
    'func',            'settle',
    'func',            'func',
    'reportFrame',     'func',
    'func',            'func',
    'scrollAndReport'
  ], 'shot the slice again before it settled and ran the passes that follow the settle, or checked after its second shot');
});

test('shoots a slice twice at most, however many fixed elements the page puts in', async () => {
  // A page that puts in another fixed banner at every shot after the first
  // slice's, after the slice's last fixed hide every time.
  const body = el(3000, 713);
  const banners = Array.from({ length: 10 }, () => positioned('fixed', 663, 713));
  const light = [];
  const { ctx, captureAt } = load({ de: el(713, 713), body, ih: 713, fixed: banners, light });
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  ctx.chrome.tabs.captureVisibleTab = (...a) => { if (body.scrollTop > 0) light.push(banners[light.length]); return shoot(...a); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 713, 713, 1426, 1426, 2139, 2139, 2287, 2287], 'shot a slice more than twice, or only once with a banner in it');
  assert.ok(banners.every((b) => b.style.visibility === ''), 'left a banner hidden');
});

test('shoots a slice only once the page has painted the frame its fixed hide is in', async () => {
  // As in Chrome, a frame's requestAnimationFrame callbacks run before it is
  // painted, and captureVisibleTab hands back the last frame painted: here a
  // frame is on the screen once the next one starts, and the settle's frames
  // leave the page on the screen as it is. The banner turns up while the
  // second slice settles, so it is on the screen by the end of the settle; the
  // fixed hide that follows takes it out of the page, but not off the screen.
  const body = el(3000, 713);
  const banner = positioned('fixed', 663, 713);
  const light = [];
  const { ctx } = load({ de: el(713, 713), body, ih: 713, fixed: [banner], light });
  const page = () => (light.length ? banner.style.visibility : 'absent');
  let painted = page(), screen = painted;
  const timer = ctx.setTimeout;
  ctx.setTimeout = (fn, ms) => {
    if (ms === 500) {
      if (body.scrollTop === 713 && !light.length) light.push(banner);
      painted = screen = page();
    }
    return timer(fn, ms);
  };
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => frame(() => { screen = painted; painted = page(); cb(); });
  const shots = []; // the banner in each shot
  const shoot = ctx.chrome.tabs.captureVisibleTab;
  ctx.chrome.tabs.captureVisibleTab = (...a) => { shots.push(screen); return shoot(...a); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shots, ['absent', 'hidden', 'hidden', 'hidden', 'hidden'], 'shot the second slice before the page painted the frame its fixed hide is in');
});

// --- fixed and sticky elements inside a shadow root -------------------------
// document.querySelectorAll doesn't go into a shadow root, so a fixed or
// sticky element inside a web component was never found: a fixed one was
// stitched into every slice, and a sticky one into every slice it was stuck
// in (KAN-507).

// A web component: an element in the page whose shadow root holds `inside`.
// Only an open root shows as `shadowRoot`; chrome.dom reaches either kind.
function shadowHost(mode, ...inside) {
  const root = { querySelectorAll: () => inside };
  const host = Object.assign(new HTMLElement(), { root, shadowRoot: mode === 'open' ? root : null, getRootNode: () => ({}) });
  root.host = host;
  for (const e of inside) e.getRootNode = () => root;
  return host;
}

test('hides a fixed element inside a shadow root, open or closed', async () => {
  for (const mode of ['open', 'closed']) {
    const chat = positioned('fixed', 300, 350); // a chat button the component pins to the viewport
    const { ctx } = load({ de: el(767, 767), body: el(3052, 767), fixed: [chat], light: [shadowHost(mode, chat)] });
    await ctx.captureFullPage(TAB);
    assert.deepStrictEqual(chat.seen, ['hidden', ''], `a fixed element was left to repeat down the stitch (${mode} shadow root)`);
  }
});

test('hides a sticky heading inside a shadow root only in the slices it is stuck in', async () => {
  for (const mode of ['open', 'closed']) {
    const body = el(3000, 713);
    const heading = stickyAt(body, 1200, 2600);
    const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [heading], light: [shadowHost(mode, heading)] });
    await ctx.captureFullPage(TAB);
    assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], `the heading was stitched into a slice it was stuck in (${mode} shadow root)`);
    assert.strictEqual(heading.style.visibility, '', 'left the heading hidden');
  }
});

test('searches a shadow root nested inside another', async () => {
  // A component inside a component: the inner one's root only turns up while
  // the outer one's is searched, and both passes have to search it.
  const body = el(3000, 713);
  const chat = positioned('fixed', 300, 350);
  const heading = stickyAt(body, 1200, 2600);
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [chat, heading], light: [shadowHost('open', shadowHost('closed', chat, heading))] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(chat.seen, ['hidden', ''], 'a fixed element in a nested shadow root was left to repeat down the stitch');
  assert.deepStrictEqual(shownAt.map(([, v]) => v), ['', '', 'hidden', 'hidden', 'hidden'], 'a sticky heading in a nested shadow root was stitched into a slice it was stuck in');
});

test('leaves a sticky header in a component inside a scroller where it is painted', async () => {
  // Nothing in the component's shadow tree scrolls: the header sticks to the
  // box the component sits in, which only a climb through the host reaches.
  const body = el(3052, 767);
  const header = positioned('sticky');
  header.getBoundingClientRect = () => {
    const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
    return { top, bottom: top + 30 };
  };
  const host = shadowHost('open', header);
  host.parentElement = { overflow: 'auto' }; // the box
  const { ctx } = load({ de: el(767, 767), body, fixed: [header], light: [host] });
  await ctx.captureFullPage(TAB);
  assert.ok(!header.seen.includes('hidden'), 'blanked a header stuck inside the scroller its component sits in');
});

test('leaves a sticky header slotted into a scroller inside a component where it is painted', async () => {
  // The header is the page's own, but the component lays it out under a
  // <slot> inside a scrolled box, and that box is what it sticks to. The slot
  // takes the header itself or a wrapper it sits in; either way its parent in
  // the page is the component (KAN-509).
  const cases = {
    'the header slotted': (header, host, slot) => Object.assign(header, { parentElement: host, assignedSlot: slot }),
    'a wrapper slotted': (header, host, slot) => Object.assign(header, { parentElement: { parentElement: host, assignedSlot: slot } }),
  };
  for (const [name, place] of Object.entries(cases)) {
    const body = el(3052, 767);
    const header = positioned('sticky');
    header.getBoundingClientRect = () => {
      const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
      return { top, bottom: top + 30 };
    };
    place(header, shadowHost('open'), { parentElement: { overflow: 'auto' } }); // the slot, in the box
    const { ctx } = load({ de: el(767, 767), body, fixed: [header] });
    await ctx.captureFullPage(TAB);
    assert.ok(!header.seen.includes('hidden'), `blanked a header shown through a slot in a scroller (${name})`);
  }
});

test('leaves a sticky header slotted into a scroller inside a closed shadow root where it is painted', async () => {
  // A closed root's slot doesn't show as assignedSlot, so the climb looks for
  // it among the root's slots: the one whose assignedElements() holds the
  // header, or the wrapper it sits in. The root's other slot sits outside the
  // box and takes nothing (KAN-511).
  const cases = {
    'the header slotted': (header, host) => Object.assign(header, { parentElement: host, assignedSlot: null }),
    'a wrapper slotted': (header, host) => (header.parentElement = { parentElement: host, assignedSlot: null }),
  };
  for (const [name, place] of Object.entries(cases)) {
    const body = el(3052, 767);
    const header = positioned('sticky');
    header.getBoundingClientRect = () => {
      const top = (header.style.getPropertyValue('position') === 'static' ? 100 : 400) - body.scrollTop;
      return { top, bottom: top + 30 };
    };
    let slotted; // what the slot in the box takes
    const slot = { parentElement: { overflow: 'auto' }, assignedElements: () => [slotted] };
    slotted = place(header, shadowHost('closed', { assignedElements: () => [] }, slot));
    const { ctx } = load({ de: el(767, 767), body, fixed: [header] });
    await ctx.captureFullPage(TAB);
    assert.ok(!header.seen.includes('hidden'), `blanked a header shown through a closed root's slot in a scroller (${name})`);
  }
});

test('reads a slotted sticky element as the page\'s when nothing around its slot scrolls', async () => {
  // Climbing through the slot mustn't make every slotted element its own: with
  // no scroller between the slot and the page, a bottom bar stuck to the first
  // screen is still read at its place in the page (KAN-501, KAN-509).
  const body = el(3000, 713);
  const bar = stickyToBottomAt(body, 2400, 0, 713);
  const around = {}; // what the slot sits in, in the component's shadow tree
  Object.assign(bar, { parentElement: shadowHost('open', around), assignedSlot: { parentElement: around } });
  const { ctx, shownAt } = load({ de: el(713, 713), body, ih: 713, fixed: [bar] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['hidden', 'hidden', 'hidden', '', ''], 'read a bar slotted with nothing around it that scrolls as painted');
});

test('asks chrome.dom about HTMLElements only', async () => {
  // It throws on anything else, an <svg> icon say, and a throw there stops
  // the capture. Nothing but an HTMLElement can host a shadow root anyway.
  const icon = {}; // an <svg>: an element, but not an HTMLElement
  const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767), light: [icon] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 767, 1534, 2285], 'an <svg> on the page stopped the capture');
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

// --- progress for the popup (KAN-220) --------------------------------------
// A full page takes about a second a screen, and the popup showed nothing
// while it ran. The worker now says which screen it is shooting, out of how
// many the page is tall enough for.

test('tells the popup which screen it is shooting, out of how many', async () => {
  const { ctx, sent } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  await ctx.captureFullPage(TAB, 'png', 'popup-1');
  assert.deepStrictEqual(sent, [1, 2, 3, 4].map((screen) => ({ type: 'capture-progress', popupId: 'popup-1', screen, screens: 4 })));
});

// A page that loads more once it has been scrolled: `before` tall at the top,
// `after` from the first scroll away from it on.
function growingEl(before, after, clientHeight) {
  let top = 0, grown = false;
  return {
    get scrollHeight() { return grown ? after : before; },
    clientHeight,
    get scrollTop() { return top; },
    set scrollTop(v) { top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - clientHeight))); if (top > 0) grown = true; },
    scrollTo(o) { this.scrollTop = o.top; },
  };
}

test('counts the screens again when the page grows during the capture', async () => {
  const { ctx, sent } = load({ de: growingEl(2400, 4000, 800), body: el(4000, 4000), ih: 800, dpr: 1 });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(sent.map((m) => `${m.screen} of ${m.screens}`), ['1 of 3', '2 of 5', '3 of 5', '4 of 5', '5 of 5'],
    'kept the count the page had before it grew');
});

test('finishes the stitch when nothing is listening for its progress', async () => {
  const { ctx, captureAt } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  // A shortcut's capture, or a popup closed since: Chrome rejects the send.
  ctx.chrome.runtime.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(captureAt, [0, 800, 1600, 2200]);
});

// --- one capture at a time (KAN-213) ---------------------------------------
// Only the single captureVisibleTab calls went through a gate, so a second
// capture ran alongside the first: a shortcut pressed twice, or a shortcut
// during the popup's capture. Two full pages scrolled the same page under each
// other, the headers the first had hidden stayed hidden, and one capture's
// finally took the scrollbar style away while the other was still shooting.

const RUN_OPTS = { format: 'png', quality: 1, filename: 'x', toClipboard: false, hideScrollbar: true };
const settle = () => new Promise((r) => setImmediate(r));

// What runCapture needs beyond the stitch: session storage for the Region key,
// and somewhere to save to.
function forRunCapture(ctx, session = {}) {
  ctx.chrome.storage.session = {
    get: async (k) => ({ [k]: session[k] }),
    set: async (o) => { Object.assign(session, o); },
    remove: async (k) => { delete session[k]; },
  };
  const saved = [];
  ctx.chrome.downloads = { download: async (o) => { saved.push(o.filename); } };
  return saved;
}

// The <style> setScrollbarHidden puts in the page, and whether it was there
// for each shot.
function scrollbarStyle(ctx) {
  const byId = new Map();
  Object.assign(ctx.document, {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => { const el = { remove: () => byId.delete(el.id) }; return el; },
    head: { appendChild: (el) => byId.set(el.id, el), prepend: (el) => byId.set(el.id, el) },
  });
  const shots = [];
  const capture = ctx.chrome.tabs.captureVisibleTab;
  ctx.chrome.tabs.captureVisibleTab = (...a) => { shots.push(byId.has('__shotHideScrollbar')); return capture(...a); };
  return { shots, inPlace: () => byId.has('__shotHideScrollbar') };
}

test('runs a second full page only once the first has finished', async () => {
  const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767) });
  const saved = forRunCapture(ctx);
  await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('fullpage', RUN_OPTS, TAB.id)]);
  assert.deepStrictEqual(captureAt, [0, 767, 1534, 2285, 0, 767, 1534, 2285], 'the two stitches scrolled the page under each other');
  assert.strictEqual(saved.length, 2);
});

test('leaves a pinned header shown after two full pages at once', async () => {
  const header = { style: { visibility: '' } };
  const { ctx, shownAt } = load({ de: el(767, 767), body: el(3052, 767), fixed: [header] });
  forRunCapture(ctx);
  await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('fullpage', RUN_OPTS, TAB.id)]);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', 'hidden', '', 'hidden', 'hidden', 'hidden']);
  assert.strictEqual(header.style.visibility, '', 'left the pinned header hidden');
});

test('keeps the scrollbar hidden for a whole full page when a visible is asked for during it', async () => {
  const { ctx } = load({ de: el(767, 767), body: el(3052, 767) });
  forRunCapture(ctx);
  const bar = scrollbarStyle(ctx);
  await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('visible', RUN_OPTS, TAB.id)]);
  assert.deepStrictEqual(bar.shots, [true, true, true, true, true], 'the scrollbar came back during the stitch');
  assert.strictEqual(bar.inPlace(), false, 'left the scrollbar hidden');
});

test('puts a Region\'s overlay up only once a full page asked for before it has finished', async () => {
  const { ctx, captureAt } = load({ de: el(767, 767), body: el(3052, 767) });
  forRunCapture(ctx);
  const overlays = [];
  const execute = ctx.chrome.scripting.executeScript;
  ctx.chrome.scripting.executeScript = async (o) => {
    if (o.files) { overlays.push(`after ${captureAt.length} shots`); return [{}]; } // region.js
    return execute(o);
  };
  await Promise.all([ctx.runCapture('fullpage', RUN_OPTS, TAB.id), ctx.runCapture('region', RUN_OPTS, TAB.id)]);
  assert.deepStrictEqual(overlays, ['after 4 shots'], 'the overlay went up in the middle of the stitch');
});

test('finishes a Region shot before a full page asked for after it starts', async () => {
  const body = el(3052, 767);
  body.scrollTop = 640; // where the user made the selection
  const { ctx, captureAt, message } = load({ de: el(767, 767), body });
  const saved = forRunCapture(ctx, { pendingRegion: { tab: TAB, opts: RUN_OPTS } });
  const bar = scrollbarStyle(ctx);
  await ctx.setScrollbarHidden(TAB, true); // the Region hid it when it started
  message({ type: 'shot-region', rect: { x: 0, y: 0, w: 100, h: 100, dpr: 2 } });
  await ctx.runCapture('fullpage', RUN_OPTS, TAB.id);
  for (let i = 0; i < 5; i++) await settle();
  assert.deepStrictEqual(captureAt, [640, 0, 767, 1534, 2285]);
  assert.deepStrictEqual(bar.shots, [true, true, true, true, true], 'the Region took the scrollbar style away during the stitch');
  assert.strictEqual(saved.length, 2);
  assert.strictEqual(bar.inPlace(), false, 'left the scrollbar hidden');
});

// --- whose capture the progress is from (KAN-552) ---------------------------
// A capture waits for the one before it to finish (KAN-213), and a Full page's
// progress didn't say whose capture it was: a popup whose capture waited
// behind a shortcut's Full page showed that Full page's screens as its own.

test('names the popup that asked for the full page in its progress, and none for a shortcut\'s', async () => {
  const { ctx, sent, message } = load({ de: el(3000, 800), body: el(3000, 3000), ih: 800, dpr: 1 });
  forRunCapture(ctx);
  ctx.runCapture('fullpage', RUN_OPTS, TAB.id); // as a shortcut starts it
  message({ type: 'capture', mode: 'fullpage', opts: RUN_OPTS, tabId: TAB.id, popupId: 'popup-1' }); // waits its turn behind it
  await vm.runInContext('runGate', ctx); // both have finished
  assert.deepStrictEqual(sent.filter((m) => m.type === 'capture-progress').map((m) => m.popupId), [undefined, undefined, undefined, undefined, 'popup-1', 'popup-1', 'popup-1', 'popup-1']);
});



test('KAN-597: puts a page back when it scrolls itself and grows while settling', async () => {
  const body = el(3000, 713);
  let baseScroll = 0;
  body.querySelectorAll = () => {
    baseScroll = body.scrollTop;
    return [{ getBoundingClientRect: () => ({ top: 100 - (body.scrollTop - baseScroll), bottom: 110 - (body.scrollTop - baseScroll), height: 10 }) }];
  };
  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  const frame = ctx.requestAnimationFrame;
  let settled = false;
  ctx.requestAnimationFrame = (cb) => {
    // When the slice is settling for the second capture (target 713), simulate scrolling/growing
    if (captureAt.length === 1 && body.scrollTop === 713 && !settled) {
      settled = true;
      body.scrollTop += 200;
      body.scrollHeight += 100;
    }
    return frame(cb);
  };
  await ctx.captureFullPage(TAB);
  // It should be put back to 713 (actually `reached`), and captureAt will show it shot at 713 not 913.
  assert.deepStrictEqual(captureAt, [0, 713, 1426, 2139, 2387]);
});
test('KAN-591: draws each band once when content above grows and content below shrinks', async () => {
  const body = el(3000, 713);
  let baseScroll = 0;
  body.querySelectorAll = () => {
    baseScroll = body.scrollTop;
    return [{ getBoundingClientRect: () => ({ top: 100 - (body.scrollTop - baseScroll), bottom: 110 - (body.scrollTop - baseScroll), height: 10 }) }];
  };
  const { ctx, canvases, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1 });
  const frame = ctx.requestAnimationFrame;
  let settled = false;
  ctx.requestAnimationFrame = (cb) => {
    if (captureAt.length === 1 && body.scrollTop === 713 && !settled) {
      settled = true;
      body.scrollTop += 300;
      baseScroll += 300;
    }
    return frame(cb);
  };
  await ctx.captureFullPage(TAB);
  
  assert.deepStrictEqual(captureAt, [0, 1013, 1726, 2287]);
  assert.deepStrictEqual(canvases[0].draws.map(d => d.y), [0, 713, 1426, 1987]);
  assert.strictEqual(canvases[canvases.length - 1].height, 2700);
});


test('re-hides a listed fixed element the page unhides during the capture', async () => {
  const body = el(3000, 713);
  const header = positioned('fixed', 0, 60);
  const { ctx, shownAt, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1, fixed: [header] });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => {
    if (captureAt.length === 1 && header.style.visibility === 'hidden') {
      header.style.visibility = '';
    }
    return frame(cb);
  };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', 'hidden', 'hidden', 'hidden']);
});

test('prunes an element that loses its fixed positioning and restores its visibility', async () => {
  const body = el(3000, 713);
  const header = positioned('fixed', 0, 60);
  Object.defineProperty(header, 'pos', { get: () => (captureAt.length >= 3 ? 'static' : 'fixed') });
  const { ctx, shownAt, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1, fixed: [header] });
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', 'hidden', 'hidden', '', '', '']);
});

test('prunes an element that loses its sticky positioning and restores its visibility', async () => {
  const body = el(3000, 713);
  const header = positioned('sticky', 0, 60);
  Object.defineProperty(header, 'pos', { get: () => (captureAt.length >= 3 ? 'static' : 'sticky') });
  const { ctx, shownAt, captureAt } = load({ de: el(713, 713), body, ih: 713, dpr: 1, fixed: [header] });
  const frame = ctx.requestAnimationFrame;
  ctx.requestAnimationFrame = (cb) => {
    if (captureAt.length === 2 && header.style.visibility === '') {
      header.style.visibility = 'hidden';
    }
    return frame(cb);
  };
  await ctx.captureFullPage(TAB);
  assert.deepStrictEqual(shownAt.map(([v]) => v), ['', '', 'hidden', '', '', '']);
});
