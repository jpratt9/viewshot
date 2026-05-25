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
    dragging = false;
    const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
    const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
    if (w < 5 || h < 5) { finish(null); return; }
    finish({ x, y, w, h, dpr });
  });
})();
