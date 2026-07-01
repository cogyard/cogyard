// cogyard desktop shell — Electron main process.
//
// THIN SHELL over the always-on portal (task 51). The desktop app starts NO
// server, forks NOTHING, watches NOTHING, caches NOTHING. There is exactly one
// portal server per machine — the `com.cogyard.serve` LaunchAgent on
// :7437 — and this app is a native viewer onto it:
//   1. Open a BrowserWindow on http://localhost:7437/ (localhost = a secure
//      context, so dock badge + native Notification "just work" with no TLS).
//      If :7437 is down, show a friendly placeholder and retry — never fork a
//      server, never crash-loop.
//   2. Dock-badge poller: every 30s GET the CHEAP stat-cached /api/projects and
//      sum p.unmerged → app.setBadgeCount(n). ~0 git on a hit.
//   3. Notifications: per-project task-count diffing needs /api/overview (which
//      spawns `git status --porcelain` per project). Gated behind a notify flag
//      AND a slower cadence so it never becomes an unconditional 30s git storm.
//   4. Link routing: same-origin navigation stays in the portal window. A
//      worktree dev-server link (localhost:OTHER_PORT) opens in its own in-app
//      tab titled "project - worktree"; a truly external URL opens in the OS
//      browser.
//   5. Single-instance lock; nothing to clean up on quit (no child server).
//
// History: task 36 forked its own portal server on a free port for crash
// isolation / secure-context badge / a phase-4 "ship to strangers" bundle. All
// three were moot (:7437 is its own launchd process, localhost is already a
// secure context, and the app cannot exist without a cogyard install) — so the
// fork + the Path-A rebuild-on-launch + the dist build-watcher + the phase-4
// portal-staging bundle were all removed by task 51. The shell adapts to the
// existing read-mostly :7437 API; it does NOT modify the server.

import { app, BrowserWindow, WebContentsView, ipcMain, shell, Notification, nativeImage, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { get } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The one portal per machine. localhost (not 127.0.0.1) so the window origin is
// a secure context for navigator.setAppBadge + Notification, with zero TLS.
const SERVER_PORT = 7437;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

const POLL_INTERVAL_MS = 30_000;     // badge cadence (cheap /api/projects)
// Notifications need /api/overview, which spawns git per project — run it far
// less often than the badge so it's never a 30s git storm. Set COGYARD_DESKTOP_
// NOTIFY=0 to disable notifications entirely (pure cheap-badge shell, zero git).
const NOTIFY_INTERVAL_MS = 120_000;
const NOTIFY_ENABLED = process.env.COGYARD_DESKTOP_NOTIFY !== '0';
const PORTAL_RETRY_MS = 3_000;       // re-attempt the portal load while :7437 is down

let mainWindow = null;
let pollTimer = null;
let portalRetryTimer = null;
let lastNotifyAt = 0;      // ms timestamp of the last /api/overview notification poll
let lastCounts = null;     // Map<slug, {label, blocked, ready}> from the previous notify poll
// Tabbed shell: one window, a WebContentsView per tab. Tab 0 is the portal;
// each worktree dev-server link opens/raises its own tab.
let tabStrip = null;        // WebContentsView hosting tabstrip.html (the tab bar)
const tabs = [];            // [{ id, kind:'portal'|'worktree', port, title, view }]
let activeTabId = null;
let nextTabId = 1;
const STRIP_H = 40;         // tab-strip height in px
// Cmd+F find-in-page (task 56): a small overlay WebContentsView, hidden until
// ⌘F, that drives the ACTIVE tab's native webContents.findInPage(). Lives in the
// shell so it works on every tab uniformly (portal + worktree dev-server tabs).
let findBar = null;         // WebContentsView hosting findbar.html
let findVisible = false;
let findTarget = null;      // the webContents currently wired for found-in-page
let lastFindQuery = '';
const FIND_W = 340;         // find-bar overlay width / height in px
const FIND_H = 44;

// --- small GET-JSON helper (localhost only) ------------------------------
function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = get(`${SERVER_URL}${path}`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${path}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

// --- poll tick: dock badge + notifications -------------------------------
// In the shell THIS native writer is the SOLE dock-badge writer: the web
// BadgeService detects Electron (UA) and stays a no-op, so the two can never
// fight (that was the 14↔7 flip).
async function pollTick() {
  // Badge: sum unmerged worktrees from the CHEAP stat-cached /api/projects
  // (~0 git on a hit). This is what makes the always-open app cheap.
  try {
    const projects = await getJson('/api/projects');
    const unmerged = projects.reduce((n, p) => n + (p.unmerged || 0), 0);
    app.setBadgeCount(unmerged);
    console.log(`[cogyard] dock badge = ${unmerged} unmerged worktree(s)`);
  } catch {
    return; // server offline/transient — keep the last badge, skip notifications
  }

  // Notifications: per-project task counts only live on /api/overview, which
  // spawns `git status --porcelain` per project. Gate it behind the notify flag
  // AND the slower NOTIFY_INTERVAL so it never runs every 30s.
  if (!NOTIFY_ENABLED) return;
  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_INTERVAL_MS) return;
  lastNotifyAt = now;
  try {
    const data = await getJson('/api/overview');
    diffAndNotify(data.projects || []);
  } catch {
    // transient (server restart/offline) — diff on the next notify cycle
  }
}

// Native notifications on meaningful, reproducible transitions between ticks:
//   blocked↑ — a task became BLOCKED_ON (or had a dependency go unmet)
//   ready↑   — a new task is unblocked and ready to pick up
// First tick only seeds the baseline (no notification burst on launch). Each
// notification click focuses the window and deep-links to that project.
function diffAndNotify(projects) {
  const current = new Map();
  for (const p of projects) {
    if (!p.tasks) continue;
    current.set(p.slug, {
      label: p.label || p.slug,
      blocked: p.tasks.blocked || 0,
      ready: p.tasks.ready || 0,
    });
  }
  if (lastCounts) {
    for (const [slug, c] of current) {
      const prev = lastCounts.get(slug);
      if (!prev) continue; // project first seen this tick — seed, don't notify
      if (c.blocked > prev.blocked) {
        notify(`${c.label}: a task became blocked`,
          `Blocked tasks ${prev.blocked} → ${c.blocked}`, slug);
      }
      if (c.ready > prev.ready) {
        const delta = c.ready - prev.ready;
        notify(`${c.label}: ${delta} task${delta > 1 ? 's' : ''} ready to pick up`,
          `Ready tasks ${prev.ready} → ${c.ready}`, slug);
      }
    }
  }
  lastCounts = current;
}

function notify(title, body, slug) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => focusWindow(slug));
  n.show();
  console.log(`[cogyard] notification: ${title}`);
}

// Bring the window forward, switch to the portal tab, and (if we know the slug)
// deep-link it to that project.
function focusWindow(slug) {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const portal = tabs.find((t) => t.kind === 'portal');
  if (portal) {
    setActiveTab(portal.id);
    if (slug) {
      portal.view.webContents.loadURL(`${SERVER_URL}/p/${encodeURIComponent(slug)}/tasks`);
    }
  }
}

// --- link routing --------------------------------------------------------
// Helpers shared by the portal window and the preview windows.
function isLocalhost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}
// Our portal server (the in-app window's origin).
function isInternal(url) {
  try {
    const u = new URL(url);
    return isLocalhost(u.hostname) && Number(u.port) === SERVER_PORT;
  } catch {
    return false;
  }
}
// A localhost dev server on some OTHER port — a worktree preview candidate.
function isWorktreeDevServer(url) {
  try {
    const u = new URL(url);
    const port = Number(u.port);
    return isLocalhost(u.hostname) && port > 0 && port !== SERVER_PORT;
  } catch {
    return false;
  }
}

// --- tabbed shell --------------------------------------------------------
// One window: a tab-strip view on top + one content WebContentsView per tab.
// Content views don't overlap the strip (strip y:0..STRIP_H, content below), so
// only the active content view is attached at a time; the strip stays attached.

function makeContentView() {
  const view = new WebContentsView({ webPreferences: {
    preload: join(__dirname, 'nav-preload.cjs'), // mouse back/forward → history nav
    contextIsolation: true,
    nodeIntegration: false,
  } });
  try { view.setBackgroundColor('#2f3338'); } catch { /* older electron — ignore */ }
  return view;
}

// The active tab's web contents — what ⌘F searches.
function activeWebContents() {
  const t = tabs.find((x) => x.id === activeTabId);
  return t ? t.view.webContents : null;
}

function layout() {
  if (!mainWindow) return;
  const { width, height } = mainWindow.getContentBounds();
  if (tabStrip) tabStrip.setBounds({ x: 0, y: 0, width, height: STRIP_H });
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) active.view.setBounds({ x: 0, y: STRIP_H, width, height: Math.max(0, height - STRIP_H) });
  // Find bar floats top-right, just under the strip; reposition on every resize.
  if (findBar && findVisible) {
    const fw = Math.min(FIND_W, Math.max(160, width - 24));
    findBar.setBounds({ x: width - fw - 12, y: STRIP_H + 8, width: fw, height: FIND_H });
  }
}

function renderStrip() {
  if (!tabStrip) return;
  // Only show chips once a worktree preview is open. With just the portal there's
  // nothing to switch between, so a lone "Dashboard" chip would just be noise.
  const show = tabs.length > 1;
  tabStrip.webContents.send('tabs', {
    tabs: show ? tabs.map((t) => ({ id: t.id, title: t.title, closable: t.kind !== 'portal' })) : [],
    activeId: activeTabId,
  });
}

function setActiveTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t || !mainWindow) return;
  if (activeTabId !== id) {
    hideFindBar(); // close ⌘F when switching tabs — it re-opens on the new tab's content
    const prev = tabs.find((x) => x.id === activeTabId);
    if (prev) { try { mainWindow.contentView.removeChildView(prev.view); } catch { /* not attached */ } }
    activeTabId = id;
    mainWindow.contentView.addChildView(t.view);
  }
  layout();
  renderStrip();
  t.view.webContents.focus();
}

function closeTab(id) {
  const i = tabs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const t = tabs[i];
  if (t.kind === 'portal') return; // the portal tab is permanent
  const wasActive = activeTabId === id;
  try { mainWindow.contentView.removeChildView(t.view); } catch { /* not attached */ }
  try { t.view.webContents.destroy(); } catch { /* already gone */ }
  tabs.splice(i, 1);
  console.log(`[cogyard] tab closed: "${t.title}"`);
  if (wasActive) {
    activeTabId = null;
    const next = tabs[i] || tabs[i - 1] || tabs[0];
    if (next) setActiveTab(next.id); else renderStrip();
  } else {
    renderStrip();
  }
}

// Open (or raise) the tab for the worktree dev server on this port.
function addWorktreeTab(url) {
  const port = Number(new URL(url).port);
  const existing = tabs.find((t) => t.kind === 'worktree' && t.port === port);
  if (existing) { existing.url = url; existing.view.webContents.loadURL(url); setActiveTab(existing.id); return; }
  const title = resolveWorktreeTitle(port);
  const view = makeContentView();
  // `url` = the real dev-server target. Tracked so ⌘R can re-attempt it when the
  // tab is showing our placeholder (a data: URL) — reloading the placeholder
  // itself does nothing, which is why a dead server used to need close+reopen.
  const tab = { id: nextTabId++, kind: 'worktree', port, title, view, url };
  tabs.push(tab);
  wireWorktreeRouting(view.webContents, port);
  // Keep the tab label = "project - worktree"; ignore the loaded page's <title>.
  view.webContents.on('page-title-updated', (e) => e.preventDefault());
  // Remember the last real URL we actually landed on (not the placeholder), so a
  // ⌘R after the server comes back re-attempts where the user was.
  view.webContents.on('did-navigate', (_e, navUrl) => {
    if (navUrl && !navUrl.startsWith('data:')) tab.url = navUrl;
  });
  // Dead dev server → friendly placeholder instead of Chromium's error page.
  view.webContents.on('did-fail-load', (_e, code, _d, _u, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted (our own redirect)
    view.webContents.loadURL(placeholderUrl(title, port));
  });
  view.webContents.loadURL(url);
  setActiveTab(tab.id);
  console.log(`[cogyard] worktree tab opened: "${title}" (localhost:${port})`);
}

// Portal content view: worktree link → its tab; external → OS browser; same-origin stays.
function routeFromPortal(url) {
  if (isWorktreeDevServer(url)) { console.log(`[cogyard] worktree link → tab: ${url}`); addWorktreeTab(url); }
  else { console.log(`[cogyard] external → browser: ${url}`); shell.openExternal(url); }
}
function wirePortalRouting(contents) {
  contents.setWindowOpenHandler(({ url }) => { routeFromPortal(url); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => {
    if (isInternal(url)) return; // same portal origin — stay
    event.preventDefault();
    routeFromPortal(url);
  });
}

// Worktree content view: same dev server stays; portal origin → portal tab;
// another worktree → its tab; external → OS browser.
function routeFromWorktree(url) {
  if (isInternal(url)) {
    const portal = tabs.find((t) => t.kind === 'portal');
    if (portal) { portal.view.webContents.loadURL(url); setActiveTab(portal.id); }
  } else if (isWorktreeDevServer(url)) {
    addWorktreeTab(url);
  } else {
    console.log(`[cogyard] worktree external → browser: ${url}`);
    shell.openExternal(url);
  }
}
function wireWorktreeRouting(contents, devPort) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isLocalhostOnPort(url, devPort)) return { action: 'allow' };
    routeFromWorktree(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isLocalhostOnPort(url, devPort)) return; // same dev server — stay
    event.preventDefault();
    routeFromWorktree(url);
  });
}

// --- worktree preview tabs -----------------------------------------------
// Resolve a localhost dev-server port to a "project - worktree" title via the
// cogyard port registry (~/.cogyard/ports.json). Read directly — NO core/
// import — to keep desktop/ a relocatable island.
function resolveWorktreeTitle(port) {
  try {
    const reg = JSON.parse(readFileSync(join(homedir(), '.cogyard', 'ports.json'), 'utf8'));
    for (const a of Object.values(reg.allocations || {})) {
      if (a.frontend === port || a.backend === port) {
        return `${a.parent_planet || 'project'} - ${a.worktree_name || `:${port}`}`;
      }
    }
  } catch {
    // registry missing/unreadable — fall back to the bare origin
  }
  return `localhost:${port}`;
}

// Dark, dependency-free placeholder shown when a worktree dev server isn't
// running (instead of Chrome's error page). Reload (⌘R) re-attempts the load.
function placeholderUrl(title, port) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<body style="margin:0;height:100vh;display:grid;place-items:center;` +
    `background:#2f3338;color:#e8eaee;font:14px/1.5 -apple-system,system-ui,sans-serif">` +
    `<div style="text-align:center;max-width:420px;padding:24px">` +
    `<div style="font-size:17px;font-weight:600">${esc(title)}</div>` +
    `<div style="color:#9aa0a6;margin-top:10px">No dev server is running on ` +
    `<code style="color:#e8eaee">localhost:${port}</code>.</div>` +
    `<div style="color:#9aa0a6;margin-top:4px;font-size:12.5px">Start it in that ` +
    `worktree, then reload with ⌘R.</div></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// Placeholder shown in the portal tab when :7437 itself isn't reachable. We do
// NOT fork a server here (task 43 — nothing auto-starts a background server);
// we just retry the load until the LaunchAgent is back.
function serverDownUrl() {
  const html = `<!doctype html><meta charset="utf-8"><title>cogyard server not running</title>` +
    `<body style="margin:0;height:100vh;display:grid;place-items:center;` +
    `background:#2f3338;color:#e8eaee;font:14px/1.5 -apple-system,system-ui,sans-serif">` +
    `<div style="text-align:center;max-width:460px;padding:24px">` +
    `<div style="font-size:17px;font-weight:600">cogyard server not running</div>` +
    `<div style="color:#9aa0a6;margin-top:10px">Nothing is serving ` +
    `<code style="color:#e8eaee">localhost:${SERVER_PORT}</code>. The desktop app is a ` +
    `viewer onto the always-on portal — it does not start its own server.</div>` +
    `<div style="color:#9aa0a6;margin-top:8px;font-size:12.5px">Re-bootstrap the LaunchAgent:<br>` +
    `<code style="color:#e8eaee">launchctl bootstrap gui/$(id -u) ` +
    `~/Library/LaunchAgents/com.cogyard.serve.plist</code></div>` +
    `<div style="color:#9aa0a6;margin-top:8px;font-size:12.5px">Retrying automatically…</div>` +
    `</div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function isLocalhostOnPort(url, port) {
  try {
    const u = new URL(url);
    return isLocalhost(u.hostname) && Number(u.port) === port;
  } catch {
    return false;
  }
}

// Load the portal into its tab; on failure show the server-down placeholder and
// retry on a gentle timer (never a tight loop, never a forked server).
function loadPortal() {
  const portal = tabs.find((t) => t.kind === 'portal');
  if (!portal) return;
  if (portalRetryTimer) { clearTimeout(portalRetryTimer); portalRetryTimer = null; }
  portal.view.webContents.loadURL(`${SERVER_URL}/`);
}

// ⌘R: reload the active tab. Our placeholder pages are data: URLs, so a plain
// reload() would just re-render the placeholder and never re-attempt the dead
// server (the bug where a worktree tab needed close+reopen). Detect that case and
// re-attempt the real target instead — portal → :7437, worktree → its dev server.
function reloadActive() {
  const t = tabs.find((x) => x.id === activeTabId);
  if (!t) return;
  const wc = t.view.webContents;
  if (wc.getURL().startsWith('data:')) {
    if (t.kind === 'portal') loadPortal();
    else if (t.url) wc.loadURL(t.url);
    else wc.reload();
  } else {
    wc.reload();
  }
}

// --- find-in-page (⌘F) ---------------------------------------------------
// The overlay drives the ACTIVE tab's native webContents.findInPage(). We wire a
// `found-in-page` listener onto whichever webContents is the current target and
// relay its {matches, activeMatchOrdinal} to the bar for the "n/m" counter.
function onFoundInPage(_e, result) {
  if (findBar && findVisible) {
    findBar.webContents.send('find:result', {
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal,
    });
  }
}

function wireFindTarget(wc) {
  if (findTarget === wc) return;
  unwireFindTarget();
  findTarget = wc;
  wc.on('found-in-page', onFoundInPage);
}

function unwireFindTarget() {
  if (findTarget && !findTarget.isDestroyed()) {
    try { findTarget.removeListener('found-in-page', onFoundInPage); } catch { /* gone */ }
  }
  findTarget = null;
}

// ⌘F: show the bar over the active tab, (re)focus + select its input. Pressing
// ⌘F again while it's open just re-selects the query — never a second bar.
function showFindBar() {
  if (!mainWindow || !findBar) return;
  const wc = activeWebContents();
  if (!wc) return;
  wireFindTarget(wc);
  if (!findVisible) {
    mainWindow.contentView.addChildView(findBar); // added last → on top of content
    findVisible = true;
  }
  layout();
  findBar.webContents.focus();
  findBar.webContents.send('find:focus');
}

function hideFindBar() {
  if (!findBar || !findVisible) return;
  try { mainWindow.contentView.removeChildView(findBar); } catch { /* not attached */ }
  findVisible = false;
  if (findTarget && !findTarget.isDestroyed()) {
    try { findTarget.stopFindInPage('clearSelection'); } catch { /* gone */ }
  }
  unwireFindTarget();
  const wc = activeWebContents();
  if (wc) wc.focus();
}

// --- keyboard: ⌘W closes a tab (never the window); ⌘Q quits on a double-press ---
// The default Electron menu maps ⌘W → close-window (which here quits the whole
// app) and ⌘Q → immediate quit. Both are too easy to hit by accident, so we
// install a custom menu that overrides exactly those two accelerators and leaves
// every other standard role (copy/paste, reload, devtools, minimize…) intact.

// ⌘W: close the active tab only when it's an extra (worktree) preview tab. With
// just the portal — or when the portal tab itself is active — do NOTHING. ⌘W must
// never close the main window or quit the app; that's ⌘Q's job.
function closeActiveTab() {
  const active = tabs.find((t) => t.id === activeTabId);
  if (active && active.kind !== 'portal') closeTab(active.id);
}

// ⌘Q: guard against an accidental quit. The first press arms a 2s window and
// shows a hint; a second ⌘Q within it actually quits.
const QUIT_WINDOW_MS = 2000;
let quitArmed = false;
let quitResetTimer = null;
let quitHud = null;

function showQuitHint() {
  try {
    if (quitHud) { try { quitHud.close(); } catch { /* already gone */ } quitHud = null; }
    const hud = new BrowserWindow({
      width: 240, height: 56, show: false, frame: false, transparent: true,
      resizable: false, movable: false, focusable: false, alwaysOnTop: true,
      skipTaskbar: true, hasShadow: false, parent: mainWindow || undefined,
    });
    hud.setIgnoreMouseEvents(true);
    const html = '<body style="margin:0;font:600 13px -apple-system,system-ui">'
      + '<div style="height:56px;display:flex;align-items:center;justify-content:center;'
      + 'background:rgba(32,34,37,.94);color:#e8eaed;border-radius:12px">'
      + 'Press ⌘Q again to quit</div></body>';
    hud.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    if (mainWindow) {
      const b = mainWindow.getBounds();
      hud.setBounds({ x: Math.round(b.x + (b.width - 240) / 2), y: Math.round(b.y + b.height - 110), width: 240, height: 56 });
    }
    hud.showInactive(); // never steals focus, so the 2nd ⌘Q still reaches the menu
    quitHud = hud;
    setTimeout(() => { try { hud.close(); } catch { /* gone */ } if (quitHud === hud) quitHud = null; }, QUIT_WINDOW_MS - 300);
  } catch { /* HUD is best-effort; quit still works without it */ }
}

function requestQuit() {
  if (quitArmed) { app.quit(); return; }
  quitArmed = true;
  showQuitHint();
  if (quitResetTimer) clearTimeout(quitResetTimer);
  quitResetTimer = setTimeout(() => { quitArmed = false; }, QUIT_WINDOW_MS);
}

function installAppMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit cogyard', accelerator: 'Cmd+Q', click: requestQuit },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: showFindBar },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: reloadActive },
        { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Close Tab', accelerator: 'Cmd+W', click: closeActiveTab },
        { role: 'minimize' },
        { role: 'zoom' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- window --------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'cogyard',
    titleBarStyle: 'hiddenInset', // hide the system title bar; keep inset traffic lights
    backgroundColor: '#2f3338',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Tab strip on top (its own view so it can be themed HTML).
  tabStrip = new WebContentsView({
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.contentView.addChildView(tabStrip);
  tabStrip.webContents.loadFile(join(__dirname, 'tabstrip.html'));
  tabStrip.webContents.once('did-finish-load', renderStrip);

  // Tab 0: the portal (permanent, not closable).
  const portalView = makeContentView();
  wirePortalRouting(portalView.webContents);
  // :7437 down → server-down placeholder + a gentle retry (never a forked
  // server, never a crash-loop). -3 = aborted (our own redirect), ignore.
  portalView.webContents.on('did-fail-load', (_e, code, _d, _u, isMain) => {
    if (!isMain || code === -3) return;
    portalView.webContents.loadURL(serverDownUrl());
    if (portalRetryTimer) clearTimeout(portalRetryTimer);
    portalRetryTimer = setTimeout(loadPortal, PORTAL_RETRY_MS);
  });
  tabs.push({ id: nextTabId++, kind: 'portal', port: SERVER_PORT, title: 'Dashboard', view: portalView });
  loadPortal();
  setActiveTab(tabs[0].id);

  // Find bar (⌘F): build it now (hidden), attach on demand in showFindBar().
  findBar = new WebContentsView({
    webPreferences: { preload: join(__dirname, 'find-preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  try { findBar.setBackgroundColor('#00000000'); } catch { /* older electron — ignore */ }
  findBar.webContents.loadFile(join(__dirname, 'findbar.html'));

  mainWindow.on('resize', layout);
  mainWindow.on('closed', () => {
    mainWindow = null; tabStrip = null; tabs.length = 0; activeTabId = null;
    findBar = null; findVisible = false; findTarget = null;
  });
}

// --- boot ----------------------------------------------------------------
// Native trackpad/overscroll back-forward, the OS-level way: let Chromium map
// whatever the user configured in macOS "Swipe between pages" (2- or 3-finger)
// to history navigation — identical to a browser — instead of us re-detecting
// gestures. Electron ships this Chromium feature OFF; re-enable it here, before
// app-ready (command-line switches have no effect after). If a given Electron
// build doesn't honor it, this is a harmless no-op and we fall back to explicit
// keyboard shortcuts the user can bind from BetterTouchTool.
app.commandLine.appendSwitch('enable-features', 'OverscrollHistoryNavigation,TouchpadOverscrollHistoryNavigation');

// Tab-strip IPC: the strip view tells main which tab to activate / close.
ipcMain.on('tab:activate', (_e, id) => setActiveTab(id));
ipcMain.on('tab:close', (_e, id) => closeTab(id));

// Find-bar IPC: the overlay drives findInPage on the active tab. A fresh query
// (no findNext) starts/re-highlights from the top; next/prev step with findNext.
ipcMain.on('find:query', (_e, text) => {
  lastFindQuery = text || '';
  if (!findTarget || findTarget.isDestroyed()) return;
  if (lastFindQuery) findTarget.findInPage(lastFindQuery);
  else try { findTarget.stopFindInPage('clearSelection'); } catch { /* gone */ }
});
ipcMain.on('find:next', () => {
  if (findTarget && !findTarget.isDestroyed() && lastFindQuery) {
    findTarget.findInPage(lastFindQuery, { findNext: true, forward: true });
  }
});
ipcMain.on('find:prev', () => {
  if (findTarget && !findTarget.isDestroyed() && lastFindQuery) {
    findTarget.findInPage(lastFindQuery, { findNext: true, forward: false });
  }
});
ipcMain.on('find:close', () => hideFindBar());

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Dev dock icon: the packaged app gets its icon from build/icon.icns, but a
    // `electron .` dev run shows the generic Electron icon — override it with the
    // committed cogyard mark so dev and packaged look the same in the dock.
    if (!app.isPackaged && app.dock) {
      try {
        const img = nativeImage.createFromPath(join(__dirname, 'build', 'icon.png'));
        if (!img.isEmpty()) app.dock.setIcon(img);
      } catch { /* non-fatal — keep the default icon */ }
    }
    createWindow();
    installAppMenu(); // custom ⌘W (close tab) + ⌘Q (double-press to quit)
    pollTick();
    pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    console.error('[cogyard] failed to start:', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    // macOS apps usually stay alive with no windows, but this shell exists to
    // host the portal — no window means nothing to do, so quit.
    app.quit();
  });

  app.on('before-quit', () => {
    app.isQuiting = true;
    if (pollTimer) clearInterval(pollTimer);
    if (portalRetryTimer) { clearTimeout(portalRetryTimer); portalRetryTimer = null; }
  });
}
