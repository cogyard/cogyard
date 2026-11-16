// core/claims.mjs — the claim details that belong to ONE machine (task 190).
//
// A task file's `env:` block is shared: on a team store every member reads the
// same file. Two of its old fields only mean something on the machine that
// wrote them — `worktree` (a folder name on this disk) and `claimed_by_session`
// (the id of a chat on this machine) — and two people's values would overwrite
// each other in one file. They live here instead, in $COGYARD_HOME/claims.json:
//
//   { "<store real path>#<task id>": { "worktree": "task-190-…", "session": "d01477a1-…", "at": "<iso>" } }
//
// The task file keeps what everyone shares: `claimed_by`, `claimed_at`, `branch`.
// `cli/env.mjs` (claim / release) is the only writer. Readers never open this
// file: core/frontmatter.mjs readTaskFile() lays the record over the task's
// `env` as it loads it, so `fm.env.worktree` / `fm.env.claimed_by_session`
// read the same everywhere they did before the move. A task file that still
// carries the old fields (a store not yet migrated) is read as written until
// this machine records something for it.
//
// Keyed by the store's real path, not a project slug: two projects can share a
// store, and a task file always knows where it is.
//
// The same record also says which chat RESERVED a task's id (`reservedBy`,
// `reservedAt`, written by `cogyard tasks next-id`, task 225). A new task file
// has no claim, so without it a plain `sync push` from any other chat would
// count the file as its own and commit it under its own message.

import { readFileSync, writeFileSync, renameSync, realpathSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { normalizeTaskId } from './validate.mjs';

const CLAIMS_PATH = join(COGYARD_HOME, 'claims.json');

// Re-read only when the file changes — the portal loads every task on every poll.
let cache = { mtimeMs: null, data: {} };
function readAll() {
  let mtimeMs = null;
  try { mtimeMs = statSync(CLAIMS_PATH).mtimeMs; } catch { cache = { mtimeMs: null, data: {} }; return cache.data; }
  if (mtimeMs !== cache.mtimeMs) {
    let data = {};
    try { const j = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) data = j; } catch {}
    cache = { mtimeMs, data };
  }
  return cache.data;
}

const realDir = new Map();
function claimKey(taskPath, id) {
  const dir = dirname(taskPath);
  let real = realDir.get(dir);
  if (!real) { try { real = realpathSync(dir); } catch { real = dir; } realDir.set(dir, real); }
  const fromName = (basename(taskPath).match(/^(\d+(?:\.\d+)?[a-z]?)-/) || [])[1];
  const nid = normalizeTaskId(id ?? fromName) ?? normalizeTaskId(fromName);
  return nid ? `${real}#${nid}` : null;
}

// This machine's record for a task, or null. { worktree?, session?, at? }
function localClaim(taskPath, id) {
  const key = claimKey(taskPath, id);
  return key ? (readAll()[key] || null) : null;
}

// Two sessions claiming at once on one machine both read-modify-write this
// file; an O_EXCL sentinel serializes them (the same primitive `next-id` and
// `sync push` use). A sentinel older than STALE_MS is a crashed holder's.
function withLock(fn) {
  const lock = CLAIMS_PATH + '.lock';
  const STALE_MS = 30 * 1000;
  const deadline = Date.now() + 5000;
  mkdirSync(dirname(CLAIMS_PATH), { recursive: true });
  for (;;) {
    try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`claims.json is locked (${lock}) — retry shortly`);
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch {}
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

// Merge `patch` into this machine's record for a task. A key set to null is
// kept as null (release clears the session but keeps the worktree record).
function setLocalClaim(taskPath, id, patch) {
  const key = claimKey(taskPath, id);
  if (!key) return null;
  return withLock(() => {
    cache.mtimeMs = null; // read fresh under the lock
    const all = { ...readAll() };
    all[key] = { ...(all[key] || {}), ...patch };
    const tmp = `${CLAIMS_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    renameSync(tmp, CLAIMS_PATH);
    cache.mtimeMs = null;
    return all[key];
  });
}

// Record which chat reserved a task file's id (task 225). A null session (a
// human's shell) records nothing — there is no chat to tell apart. A failure
// never fails the reservation: the file then just counts as unclaimed.
function recordReservation(taskPath, session) {
  if (!session) return null;
  try { return setLocalClaim(taskPath, undefined, { reservedBy: session, reservedAt: new Date().toISOString() }); }
  catch { return null; }
}

// Forget which chat reserved a task's id (task 228). `tasks close` calls this:
// a closed task has nothing left for an unnamed `sync push` to sweep up, and a
// reservation outliving the close made the reserving chat's next unnamed push
// count a finished task as its own. Returns whether there was one to clear.
function clearReservation(taskPath, id) {
  const key = claimKey(taskPath, id);
  if (!key) return false;
  return withLock(() => {
    cache.mtimeMs = null;
    const all = { ...readAll() };
    const rec = all[key];
    if (!rec || !('reservedBy' in rec || 'reservedAt' in rec)) return false;
    const { reservedBy, reservedAt, ...rest } = rec;
    if (Object.keys(rest).length) all[key] = rest; else delete all[key];
    const tmp = `${CLAIMS_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    renameSync(tmp, CLAIMS_PATH);
    cache.mtimeMs = null;
    return true;
  });
}

// Lay this machine's record over a task's parsed frontmatter `env` (in memory
// only). Called by readTaskFile for every task it loads.
function withLocalClaim(taskPath, fm) {
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return fm;
  const local = localClaim(taskPath, fm.id);
  if (!local) return fm;
  const env = { ...(fm.env && typeof fm.env === 'object' ? fm.env : {}) };
  if ('worktree' in local) env.worktree = local.worktree;
  if ('session' in local) env.claimed_by_session = local.session;
  fm.env = env;
  return fm;
}

export { CLAIMS_PATH, claimKey, localClaim, setLocalClaim, recordReservation, clearReservation, withLocalClaim };
