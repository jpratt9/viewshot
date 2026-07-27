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

  const finish = (rect) => {
    overlay.remove();
    sel.remove();
    window.__shotRegion = false;
    document.removeEventListener('keydown', onKey, true);
    chrome.runtime.sendMessage({ type: 'shot-region', rect });
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
  document.addEventListener('keydown', onKey, true);

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
