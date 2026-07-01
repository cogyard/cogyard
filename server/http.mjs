// server/http.mjs — HTTP/transport plumbing: static SPA serving, JSON responses,
// the one API error shape, param guards, and the middleware seam for task 12.
//
// No CORS and no OPTIONS handling on purpose: the server delivers the SPA and
// /api on the same origin in prod (:7437 / http://cogyard via Caddy) and dev
// goes through the Angular proxy (frontend/proxy.conf.json → :7440), so nothing
// is ever cross-origin.

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, extname, normalize, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Built Angular SPA (after `npm run build -w frontend`). Served at root with an
// SPA fallback, so this one server delivers both the UI and /api in production.
const DIST = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'frontend', 'dist', 'frontend', 'browser');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json' };

export function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// The single error shape, used by /api AND static serving (one contract for
// every failure the client can see).
export function errJson(res, code, message) {
  json(res, code, { error: message });
}

export function serveStatic(res, urlPath) {
  if (!existsSync(DIST)) return errJson(res, 503, 'SPA not built — run: npm run build -w frontend');
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  if (!file.startsWith(DIST)) return errJson(res, 403, 'forbidden'); // path traversal guard
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html'); // SPA fallback
  const type = MIME[extname(file)] || 'application/octet-stream';
  const cache = file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(readFileSync(file));
}

// --- Param guards (return null when valid, an error message when not) --------

export function badHash(h) {
  return /^[0-9a-fA-F]{4,40}$/.test(h) ? null : 'bad hash';
}
export function badRelPath(p) {
  return (p && !p.includes('..') && !p.startsWith('/')) ? null : 'bad path';
}
export function badKind(k) {
  return ['staged', 'unstaged', 'untracked'].includes(k) ? null : 'bad kind';
}

// ============================================================================
// SEAM for task 12 (working-tree actions) — first consumed by task 026's
// POST /api/usage/collect (the portal's usage-refresh button).
// ----------------------------------------------------------------------------
// 12 adds POST endpoints (routes/actions.mjs) that mutate the git index and
// shell out to open files. They will need:
//   * readBody (below) — JSON body parsing for the POSTs.
//   * requireSameOrigin(req) (below) — origin gate for every non-GET.
//   * assertInProject(proj, relPath) — realpath containment under proj.path.
// Do not delete readBody as dead code; it is the seam.
// ============================================================================

// Origin gate for non-GET endpoints. Everything is same-origin by design
// (prod http://cogyard via Caddy; dev via ng-serve proxies on arbitrary
// worktree-allocated localhost ports), so allow http://cogyard and any
// localhost/127.0.0.1 origin. Returns null when acceptable, an error message
// otherwise. Browsers always send Origin on POST; a missing header means a
// non-browser caller on this machine (curl), which is fine for a local tool.
export function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (origin === 'http://cogyard') return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null;
  return 'cross-origin request rejected';
}
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// Path-containment guard for the working-tree actions. `baseDir` is a checkout
// dir already validated as one of the project's real worktrees (never a raw
// caller cwd); `rel` is the project-relative path the action targets. Returns
// the contained absolute path, or null if `rel` escapes baseDir via traversal,
// an absolute path, or a symlink that resolves outside. realpathSync collapses
// symlinks on both sides so e.g. a `_tasks` shared-store symlink that points
// outside the project is correctly rejected (the v1 posture for task 15).
export function assertInProject(baseDir, rel) {
  if (!rel || typeof rel !== 'string' || rel.includes('\0')) return null;
  // Reject absolute paths and any `..` segment outright (mirrors badRelPath) —
  // a clean 403 rather than letting join() neutralize them into a confusing
  // deep-in-repo path that then fails at git. The realpath check below is the
  // backstop for symlink escapes that survive these syntactic checks.
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
  const abs = join(baseDir, rel);
  let baseReal;
  try { baseReal = realpathSync(baseDir); } catch { return null; }
  // The target itself may not exist yet (it always does for status-listed files,
  // but be defensive); resolve the deepest existing ancestor instead.
  let probe = abs, tailReal = null;
  for (;;) {
    try { tailReal = realpathSync(probe); break; } catch { /* not yet on disk */ }
    const parent = join(probe, '..');
    if (parent === probe) return null;
    probe = parent;
  }
  // tailReal is the realpath of `abs` (or its nearest existing ancestor); the
  // unresolved tail (if any) is appended back so the final check covers the whole
  // path. Either way it must sit strictly under baseReal.
  const resolved = probe === abs ? tailReal : join(tailReal, abs.slice(probe.length));
  if (resolved !== baseReal && !resolved.startsWith(baseReal + sep)) return null;
  return resolved;
}
