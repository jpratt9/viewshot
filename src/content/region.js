(() => {
  if (window.__shotRegion) return;
  window.__shotRegion = true;
  const dpr = window.devicePixelRatio || 1;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.18);';
  const sel = document.createElement('div');
  sel.style.cssText =
    'position:fixed;display:none;border:1px solid #39d353;background:rgba(57,211,83,.15);' +
    'z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(sel);

  let sx = 0, sy = 0, dragging = false;
  const clamp = (v, max) => Math.max(0, Math.min(v, max));

  // Escape cancels here and the page must not see that press at all. Capture on
  // window is the earliest hook, but preventDefault alone only drops the
  // browser's own action - the event still runs on to the page's handlers and
  // closes their modal, exits their player or clears their search box behind
  // the overlay, so it gets stopped outright. The keyup counts as part of the
  // same press: plenty of pages bind Escape to that instead.
  const KEY_EVENTS = ['keydown', 'keyup'];
  let escaping = false;
  const unbindKeys = () => {
    escaping = false;
    for (const type of KEY_EVENTS) window.removeEventListener(type, onKey, true);
    window.removeEventListener('blur', unbindKeys);
  };
  const teardown = () => {
    overlay.remove();
    sel.remove();
    window.__shotRegion = false;
    window.__shotRegionCancel = null;
    // Cancelling on a keydown leaves the key listeners up until that press's own
    // keyup has been swallowed; blur is the backstop for a keyup delivered
    // somewhere else. Every other exit drops them right away.
    if (escaping) window.addEventListener('blur', unbindKeys);
    else unbindKeys();
    window.removeEventListener('blur', onBlur);
  };
  const finish = (rect) => {
    teardown();
    chrome.runtime.sendMessage({ type: 'shot-region', rect });
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') { if (escaping) unbindKeys(); return; }
    if (escaping) return; // key repeat while the cancel finishes
    escaping = true;
    finish(null);
  };
  // Focus leaving the page means the selection was abandoned - the toolbar icon
  // was clicked, or another tab/window took over. Without this the dimming sits
  // on the page indefinitely and gets baked into the next capture. A drag that
  // runs past the window edge keeps pointer capture, so never cancel mid-drag.
  const onBlur = () => { if (!dragging) finish(null); };
  for (const type of KEY_EVENTS) window.addEventListener(type, onKey, true);
  window.addEventListener('blur', onBlur);
  // Lets the worker clear a stale overlay before the next capture. Silent on
  // purpose: a shot-region message here could land after the next selection's
  // listener is installed and cancel that one instead.
  window.__shotRegionCancel = teardown;

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left button only; a right-click would leave a stale anchor
    dragging = true; sx = e.clientX; sy = e.clientY;
    sel.style.display = 'block';
    sel.style.left = sx + 'px'; sel.style.top = sy + 'px';
    sel.style.width = '0px'; sel.style.height = '0px';
  });
  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    sel.style.left = Math.min(sx, e.clientX) + 'px';
    sel.style.top = Math.min(sy, e.clientY) + 'px';
    sel.style.width = Math.abs(e.clientX - sx) + 'px';
    sel.style.height = Math.abs(e.clientY - sy) + 'px';
  });
  overlay.addEventListener('mouseup', (e) => {
    // Ignore a mouseup with no matching mousedown on the overlay (the drag began
    // before injection finished). Without this, sx/sy are still 0,0 and the rect
    // becomes the whole viewport-to-cursor area instead of what was selected.
    if (!dragging) return;
    dragging = false;
    // The overlay holds pointer capture during the drag, so clientX/Y can fall
    // outside the viewport; clamp so the rect matches the visible selection.
    const ex = clamp(e.clientX, window.innerWidth), ey = clamp(e.clientY, window.innerHeight);
    const x = Math.min(sx, ex), y = Math.min(sy, ey);
    const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
    if (w < 5 || h < 5) { finish(null); return; }
    finish({ x, y, w, h, dpr });
  });
})();
