// core/launch.mjs — launch.json, which is the preview tool's config and nobody
// else's (tasks 121, 230).
//
// TWO FILES, ONE ENTRY. The preview tool reads `.claude/launch.json` from the
// chat's CURRENT folder and nowhere else (tested 2026-10-17/19, task 230). A
// chat working inside a worktree — moved in with EnterWorktree, or started there
// by the app — therefore reads the worktree's own file, and a chat in the main
// checkout reads the main checkout's. So a worktree's entry, named
// `wt-<worktree-name>`, is written to both: the worktree's file holds that one
// entry and nothing else, and the main checkout's file lists every worktree, so
// a main-checkout chat can start any of them. (Task 121 concluded in August that
// the tool read the main checkout's file from a worktree; what it most likely saw
// was the app's copy of that file inside the worktree, which the hook now
// overwrites.)
//
// WHY THIS IS IN core/. Two callers need it and must not drift: the SessionStart
// hook registers a worktree as it wires it, and the cleanup process drops the
// entry as it removes the worktree. Registration and de-registration reading
// different code is how the file accumulated seventeen stale rows.
//
// PORTS DO NOT LIVE HERE. `ports.json` is the only place a port exists. An
// entry carries one solely because the preview tool opens its browser tab at
// that number; nothing binds a port because of this file.
//
// WHAT AN ENTRY MEANS. `cogyardWorktree` (absolute path) is the entry's owner.
// It is what makes de-registration exact rather than name-matching, and it is
// why a project's own `api` / `frontend` entries — which carry no path — can
// never be swept by anything here.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function launchPath(projectRoot) {
  return join(projectRoot, '.claude', 'launch.json');
}

// A corrupt or absent file must never cost a caller its dev server, so both
// resolve to an empty document rather than throwing.
function readLaunch(projectRoot) {
  const path = launchPath(projectRoot);
  let doc = null;
  if (isFile(path)) {
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { doc = null; }
  }
  if (!doc || typeof doc !== 'object') doc = { version: '0.0.1' };
  if (!Array.isArray(doc.configurations)) doc.configurations = [];
  return doc;
}

function writeLaunch(projectRoot, doc) {
  const path = launchPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, path);
}

// Which worktree owns this entry, if any? Entries written here say so outright.
// The hand-written `wt-*` entries that predate this only carry a `cd` in their
// shell args, so parse that — otherwise they could never be swept. Anything
// else (a project's own `api` / `frontend`) returns null and is left alone.
function entryWorktree(projectRoot, entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.cogyardWorktree === 'string') return entry.cogyardWorktree;
  if (!/^wt-/.test(entry.name || '')) return null;
  const args = Array.isArray(entry.runtimeArgs) ? entry.runtimeArgs : [];
  for (const a of args) {
    if (typeof a !== 'string') continue;
    const m = a.match(/cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))/);
    if (!m) continue;
    const raw = m[1] || m[2] || m[3];
    return raw.startsWith('/') ? raw : join(projectRoot, raw);
  }
  return null;
}

// Drop every entry whose worktree is gone. Returns the names dropped.
//
// `except` de-registers a worktree that still exists on disk — the cleanup path
// needs it when it sweeps before the directory is actually gone, and it is the
// only way to remove a live worktree's entry deliberately.
function sweepLaunchEntries(projectRoot, { except = null } = {}) {
  const doc = readLaunch(projectRoot);
  const swept = [];
  doc.configurations = doc.configurations.filter((c) => {
    const wt = entryWorktree(projectRoot, c);
    if (!wt) return true;                       // not a worktree entry — never ours to drop
    if (except && wt === except) { swept.push(c.name); return false; }
    if (existsSync(wt)) return true;
    swept.push(c.name);
    return false;
  });
  if (swept.length) writeLaunch(projectRoot, doc);
  return swept;
}

// Register (or refresh) one worktree's entry, sweeping dead ones in the same
// write. Returns the names swept.
function registerWorktreeLaunch(projectRoot, { worktree, name, devScript, port }) {
  const doc = readLaunch(projectRoot);
  const swept = [];
  doc.configurations = doc.configurations.filter((c) => {
    const wt = entryWorktree(projectRoot, c);
    if (!wt || existsSync(wt)) return true;
    swept.push(c.name);
    return false;
  });

  doc.configurations = doc.configurations.filter((c) => c.name !== name);
  doc.configurations.push(worktreeEntry({ worktree, name, devScript, port }));

  writeLaunch(projectRoot, doc);
  return swept;
}

// The worktree's own file: exactly this worktree's entry, replacing whatever was
// there — including the copy of the main checkout's file the app drops into a
// worktree it creates, whose entries would run the main checkout's servers.
function writeWorktreeLaunch(worktree, { name, devScript, port }) {
  writeLaunch(worktree, { version: '0.0.1', configurations: [worktreeEntry({ worktree, name, devScript, port })] });
}

// A worktree with no dev command gets no file. Returns whether one was removed.
function removeWorktreeLaunch(worktree) {
  const path = launchPath(worktree);
  if (!isFile(path)) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

// One shape for both files, so the two can never disagree about what runs.
function worktreeEntry({ worktree, name, devScript, port }) {
  return {
    name,
    runtimeExecutable: 'sh',
    runtimeArgs: ['-c', `cd '${worktree}' && ${devScript}`],
    port,
    cogyardWorktree: worktree,
  };
}

// The name a worktree's entry goes under. One rule, so the hook that writes it
// and the briefing that names it can never disagree.
function launchNameFor(worktreeName) {
  return `wt-${worktreeName}`;
}

// launchPath is exported for the Edit/Write guard (task 247), which refuses a
// hand edit to a worktree's file and must not spell the path out itself.
export { registerWorktreeLaunch, writeWorktreeLaunch, removeWorktreeLaunch, sweepLaunchEntries, launchNameFor, launchPath };
