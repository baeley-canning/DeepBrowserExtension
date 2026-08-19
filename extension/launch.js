/**
 * The launcher popup.
 *
 * A popup is the one thing that ALWAYS renders when the toolbar icon is
 * clicked — it needs no service worker awake, no API support, no gesture
 * plumbing. The side panel needs all three, and when that chain broke the icon
 * did nothing at all, with no way to tell why.
 *
 * So the icon opens this, and this opens the panel. If sidePanel is
 * unavailable, "Open in a tab" always works.
 */
document.getElementById("side").addEventListener("click", async () => {
  const err = document.getElementById("err");
  err.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Called directly from a click, which is the user gesture sidePanel.open()
    // requires. Prefer the window so the panel is available on every tab.
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (e) {
    err.textContent = `Couldn't open the side panel: ${e?.message || e}. Use "Open in a tab".`;
  }
});
