const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'region.js'), 'utf8');

// Minimal DOM/chrome stand-ins so region.js's IIFE can run headless. Only the
// handful of APIs it actually touches are implemented; nothing real is used.
function makeEl() {
  return {
    style: {},
    listeners: {},
    removed: false,
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    remove() { this.removed = true; },
  };
}

function loadRegion(opts = {}) {
  const { innerWidth = 1512, innerHeight = 850, alreadyActive = false } = opts;
  const dpr = 'dpr' in opts ? opts.dpr : 2; // not a destructuring default: `dpr: undefined` is a real case
  const created = [];
  const sent = [];
  const winListeners = {};
  const window = {
    __shotRegion: alreadyActive, devicePixelRatio: dpr, innerWidth, innerHeight,
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = winListeners[type] || [];
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
  };
  const document = {
    documentElement: { appendChild() {} },
    createElement() { const el = makeEl(); created.push(el); return el; },
  };
  // Copy out of the vm realm so deepStrictEqual's prototype check passes.
  const chrome = {
    runtime: { sendMessage: (m) => sent.push({ type: m.type, rect: m.rect ? { ...m.rect } : m.rect }) },
  };

  const context = { window, document, chrome };
  vm.createContext(context);
  vm.runInContext(CODE, context);

  return { overlay: created[0], sel: created[1], sent, window, winListeners, created };
}

const fire = (el, type, ev) => (el.listeners[type] || []).forEach((fn) => fn(ev));
const down = (x, y, button = 0) => ({ clientX: x, clientY: y, button });
const up = down;

// A key event records what the handler did to it: a page behind the overlay
// only ever sees the press if both flags come back false.
const keyEvent = (type, key = 'Escape') => ({
  type, key, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; },
  stopImmediatePropagation() { this.stopped = true; },
});
const press = (winListeners, ev) => {
  (winListeners[ev.type] || []).slice().forEach((fn) => fn(ev));
  return ev;
};

// --- the 2.3MB bug: a mouseup with no matching mousedown ------------------
// If the drag starts before region.js finishes injecting, the overlay only
// ever sees the mouseup. sx/sy are still 0,0, so the rect used to become
// (0,0)-to-cursor — near-viewport-sized — instead of nothing.

test('ignores a mouseup that had no mousedown on the overlay', () => {
  const { overlay, sent } = loadRegion();
  fire(overlay, 'mouseup', up(1200, 700));
  assert.deepStrictEqual(sent, [], 'no capture should be requested');
});

test('leaves the overlay up after a stray mouseup so the user can retry', () => {
  const { overlay, sel } = loadRegion();
  fire(overlay, 'mouseup', up(1200, 700));
  assert.strictEqual(overlay.removed, false);
  assert.strictEqual(sel.removed, false);
});

test('a stray mousemove does not draw the selection box', () => {
  const { overlay, sel } = loadRegion();
  fire(overlay, 'mousemove', down(400, 300));
  assert.strictEqual(sel.style.left, undefined);
});

// --- normal drags ---------------------------------------------------------

test('reports the dragged rect with the page devicePixelRatio', () => {
  const { overlay, sent } = loadRegion({ dpr: 2 });
  fire(overlay, 'mousedown', down(100, 120));
  fire(overlay, 'mouseup', up(300, 270));
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: { x: 100, y: 120, w: 200, h: 150, dpr: 2 } }]);
});

test('normalizes a drag made up-and-to-the-left', () => {
  const { overlay, sent } = loadRegion({ dpr: 1 });
  fire(overlay, 'mousedown', down(300, 270));
  fire(overlay, 'mouseup', up(100, 120));
  assert.deepStrictEqual(sent[0].rect, { x: 100, y: 120, w: 200, h: 150, dpr: 1 });
});

test('cancels a drag smaller than the 5px threshold', () => {
  const { overlay, sent } = loadRegion();
  fire(overlay, 'mousedown', down(100, 100));
  fire(overlay, 'mouseup', up(103, 102));
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: null }]);
});

test('tears the overlay down once a drag completes', () => {
  const { overlay, sel, window } = loadRegion();
  fire(overlay, 'mousedown', down(100, 100));
  fire(overlay, 'mouseup', up(300, 300));
  assert.strictEqual(overlay.removed, true);
  assert.strictEqual(sel.removed, true);
  assert.strictEqual(window.__shotRegion, false);
});

// --- clamping: the overlay keeps pointer capture past the window edge ------

test('clamps a drag that runs off the top-left to the viewport origin', () => {
  const { overlay, sent } = loadRegion({ innerWidth: 1512, innerHeight: 850 });
  fire(overlay, 'mousedown', down(100, 100));
  fire(overlay, 'mouseup', up(-500, -400)); // released outside the window
  assert.deepStrictEqual(sent[0].rect, { x: 0, y: 0, w: 100, h: 100, dpr: 2 });
});

test('clamps a drag that runs off the bottom-right to the viewport edge', () => {
  const { overlay, sent } = loadRegion({ innerWidth: 1512, innerHeight: 850 });
  fire(overlay, 'mousedown', down(1400, 800));
  fire(overlay, 'mouseup', up(2000, 1200));
  assert.deepStrictEqual(sent[0].rect, { x: 1400, y: 800, w: 112, h: 50, dpr: 2 });
});

// --- non-primary buttons --------------------------------------------------

test('a right-click does not arm the selection anchor', () => {
  const { overlay, sent } = loadRegion();
  fire(overlay, 'mousedown', down(900, 600, 2));
  fire(overlay, 'mouseup', up(1200, 700, 2));
  assert.deepStrictEqual(sent, []);
});

test('a right-click mid-drag does not move the anchor', () => {
  const { overlay, sent } = loadRegion({ dpr: 1 });
  fire(overlay, 'mousedown', down(100, 100));
  fire(overlay, 'mousedown', down(900, 600, 2));
  fire(overlay, 'mouseup', up(300, 300));
  assert.deepStrictEqual(sent[0].rect, { x: 100, y: 100, w: 200, h: 200, dpr: 1 });
});

// --- pre-existing behavior that must keep working -------------------------

test('Escape cancels the selection', () => {
  const { sent, winListeners, overlay } = loadRegion();
  const ev = press(winListeners, keyEvent('keydown'));
  assert.strictEqual(ev.prevented, true);
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: null }]);
  assert.strictEqual(overlay.removed, true);
});

test('re-injection while an overlay is already active is a no-op', () => {
  const { created } = loadRegion({ alreadyActive: true });
  assert.deepStrictEqual(created, [], 'no second overlay should be built');
});

test('falls back to dpr 1 when devicePixelRatio is unset', () => {
  const { overlay, sent } = loadRegion({ dpr: undefined });
  fire(overlay, 'mousedown', down(10, 10));
  fire(overlay, 'mouseup', up(110, 110));
  assert.strictEqual(sent[0].rect.dpr, 1);
});

// --- abandoning a selection -----------------------------------------------
// Clicking Region and then walking away used to leave the dimmed overlay on the
// page forever: it stayed through a Visible/Full page capture and got baked in.

test('losing page focus cancels an idle selection', () => {
  const { sent, overlay, sel, window, winListeners } = loadRegion();
  winListeners.blur[0]();
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: null }]);
  assert.strictEqual(overlay.removed, true);
  assert.strictEqual(sel.removed, true);
  assert.strictEqual(window.__shotRegion, false);
});

test('losing focus mid-drag does not cancel', () => {
  const { overlay, sent, winListeners } = loadRegion({ dpr: 1 });
  fire(overlay, 'mousedown', down(100, 100));
  winListeners.blur[0](); // dragging past the window edge blurs on some platforms
  fire(overlay, 'mouseup', up(300, 300));
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: { x: 100, y: 100, w: 200, h: 200, dpr: 1 } }]);
});

test('the worker can tear the overlay down without sending a rect', () => {
  const { overlay, sel, window, sent } = loadRegion();
  window.__shotRegionCancel();
  assert.strictEqual(overlay.removed, true);
  assert.strictEqual(sel.removed, true);
  assert.strictEqual(window.__shotRegion, false);
  // A shot-region here would resolve the NEXT capture's listener as a cancel.
  assert.deepStrictEqual(sent, [], 'silent teardown must not message the worker');
});

test('a cancelled overlay releases its listeners and its re-injection guard', () => {
  const { window, winListeners } = loadRegion();
  window.__shotRegionCancel();
  assert.deepStrictEqual(winListeners.keydown, []);
  assert.deepStrictEqual(winListeners.keyup, []);
  assert.deepStrictEqual(winListeners.blur, []);
  assert.strictEqual(window.__shotRegionCancel, null);
  assert.strictEqual(window.__shotRegion, false, 'a fresh injection must be able to mount');
});

// --- Escape must not reach the page ---------------------------------------
// Cancelling used to only preventDefault, so the same press ran on to the
// page's own handlers: it closed their modal or exited their video player at
// the same time as it dismissed the overlay.

test('the page never sees the Escape that cancels the overlay', () => {
  const { winListeners } = loadRegion();
  const ev = press(winListeners, keyEvent('keydown'));
  assert.strictEqual(ev.stopped, true, 'the press must not run on to page handlers');
  assert.strictEqual(ev.prevented, true);
});

test('swallows the keyup that ends the cancelling press', () => {
  const { winListeners, sent } = loadRegion();
  press(winListeners, keyEvent('keydown'));
  const ev = press(winListeners, keyEvent('keyup'));
  assert.strictEqual(ev.stopped, true, 'pages that bind Escape to keyup would fire otherwise');
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: null }], 'still one cancel');
});

test('releases the key listeners once the cancelling press ends', () => {
  const { winListeners } = loadRegion();
  press(winListeners, keyEvent('keydown'));
  press(winListeners, keyEvent('keyup'));
  assert.deepStrictEqual(winListeners.keydown, []);
  assert.deepStrictEqual(winListeners.keyup, []);
  assert.deepStrictEqual(winListeners.blur, [], 'the keyup backstop goes too');
});

test('losing focus releases a swallow still waiting on its keyup', () => {
  const { winListeners } = loadRegion();
  press(winListeners, keyEvent('keydown'));
  winListeners.blur[0](); // the keyup landed in whatever took focus
  assert.deepStrictEqual(winListeners.keydown, [], 'Escape must not stay swallowed for good');
  assert.deepStrictEqual(winListeners.keyup, []);
});

test('a held Escape cancels once, not once per repeat', () => {
  const { winListeners, sent } = loadRegion();
  press(winListeners, keyEvent('keydown'));
  press(winListeners, keyEvent('keydown')); // auto-repeat while the key is down
  press(winListeners, keyEvent('keyup'));
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: null }]);
});

test('a stray Escape keyup is swallowed without disarming the overlay', () => {
  const { winListeners, sent } = loadRegion(); // key went down before injection
  const upEv = press(winListeners, keyEvent('keyup'));
  assert.strictEqual(upEv.stopped, true);
  assert.deepStrictEqual(sent, [], 'a keyup alone is not a cancel');
  press(winListeners, keyEvent('keydown'));
  assert.deepStrictEqual(sent, [{ type: 'shot-region', rect: null }], 'Escape still works');
});

test('keys other than Escape pass through to the page', () => {
  const { winListeners, sent, overlay } = loadRegion();
  const ev = press(winListeners, keyEvent('keydown', 'a'));
  assert.strictEqual(ev.prevented, false);
  assert.strictEqual(ev.stopped, false);
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(overlay.removed, false);
});
