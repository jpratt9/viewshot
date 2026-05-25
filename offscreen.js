chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type !== 'shot-clipboard') return;
  try {
    const blob = await (await fetch(msg.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (e) {
    console.error('[ViewShot] clipboard write failed:', e);
  }
});
