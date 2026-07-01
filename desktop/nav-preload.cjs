// Content-view preload: wire back/forward history navigation. Electron's
// WebContentsView doesn't map mouse side-buttons or keyboard nav shortcuts the
// way a Chrome tab does, so we do it here. Attached to EVERY content view (the
// portal tab and each worktree preview tab) and runs on every page load, so it
// survives reloads + SPA route changes and works on whatever view is active —
// navigating that view's own history (for the portal SPA that's your full
// project/worktree/view journey, since each is a router navigation).

// Mouse side-buttons (for a real 5-button mouse).
window.addEventListener('mouseup', (e) => {
  // e.button: 3 = back side-button, 4 = forward side-button.
  if (e.button === 3) { e.preventDefault(); window.history.back(); }
  else if (e.button === 4) { e.preventDefault(); window.history.forward(); }
});

// Keyboard shortcuts → history nav: ⌥⌘← (back) / ⌥⌘→ (forward). This matches the
// user's BetterTouchTool 3-finger-swipe mapping (which already drives VSCode), so
// the same BTT gesture works in cogyard with no extra setup.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey || !e.altKey || e.ctrlKey) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); window.history.back(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); window.history.forward(); }
});
