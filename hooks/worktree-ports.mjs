#!/usr/bin/env node
// worktree-ports.mjs — port allocation registry for Claude Code worktrees.
// Task: _tasks/042-worktree-port-management.md
//
// Subcommands:
//   worktree-ports.mjs allocate <worktree-path>   -> JSON of {parent_planet, worktree_name, backend, frontend, hostname, allocated_at}
//   worktree-ports.mjs release  <worktree-path>   -> {released: bool}
//   worktree-ports.mjs list                       -> JSON of all allocations
//   worktree-ports.mjs gc                         -> {removed: [...]} for entries whose dirs are gone
//   worktree-ports.mjs --help

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, openSync, closeSync, unlinkSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { adapter } from '../core/drivers.mjs';

// Config home: $COGYARD_HOME overrides, default ~/.cogyard/ — same resolution
// rule as core/paths.mjs (keep in sync).
const COGYARD_HOME = process.env.COGYARD_HOME || join(homedir(), '.cogyard');
const REGISTRY = join(COGYARD_HOME, 'ports.json');
const LOCKFILE = REGISTRY + '.lock';
const DEFAULT_RANGES = { backend: [4900, 4999], frontend: [9300, 9399] };

// Track whether we currently hold the lock so fail() can release it on exit.
let _holdingLock = false;
function fail(msg, code = 1) {
  process.stderr.write(`worktree-ports.mjs: ${msg}\n`);
  if (_holdingLock) {
    try { unlinkSync(LOCKFILE); } catch {}
  }
  process.exit(code);
}

// Belt-and-braces: release on any unexpected exit (uncaught throw, signals).
process.on('exit', () => { if (_holdingLock) { try { unlinkSync(LOCKFILE); } catch {} } });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => process.exit(130));
}

function ensureRegistryDir() {
  const dir = dirname(REGISTRY);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadRegistry() {
  ensureRegistryDir();
  if (!existsSync(REGISTRY)) {
    return { ranges: DEFAULT_RANGES, allocations: {} };
  }
  const raw = readFileSync(REGISTRY, 'utf8');
  const data = JSON.parse(raw);
  if (!data.ranges) data.ranges = DEFAULT_RANGES;
  if (!data.allocations) data.allocations = {};
  return data;
}

function saveRegistry(data) {
  ensureRegistryDir();
  const tmp = REGISTRY + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, REGISTRY);
}

// Sleep without busy-waiting. Atomics.wait on a SharedArrayBuffer is the only
// synchronous-blocking sleep in node without spawning a subprocess.
function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// Acquire an exclusive lock via O_EXCL on a sentinel file. Removes lockfiles
// older than STALE_LOCK_MS (presumed crashed holder).
const STALE_LOCK_MS = 30_000;
function acquireLock() {
  ensureRegistryDir();
  const start = Date.now();
  let backoff = 20;
  while (Date.now() - start < 5000) {
    try {
      const fd = openSync(LOCKFILE, 'wx');
      closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale-lock recovery.
      try {
        const age = Date.now() - statSync(LOCKFILE).mtimeMs;
        if (age > STALE_LOCK_MS) {
          unlinkSync(LOCKFILE);
          continue; // retry immediately
        }
      } catch { /* file disappeared between EEXIST and stat — fine, retry */ }
      sleepMs(backoff);
      backoff = Math.min(backoff * 2, 200);
    }
  }
  fail(`could not acquire lock on ${LOCKFILE} within 5s`);
}

function releaseLock() {
  try { unlinkSync(LOCKFILE); } catch {}
  _holdingLock = false;
}

function withLock(fn) {
  acquireLock();
  _holdingLock = true;
  try { return fn(); } finally { releaseLock(); }
}

function parsePlanet(planetPath) {
  const env = {};
  for (const line of readFileSync(planetPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

// Walk up from worktreePath until we find a parent identifier:
//   1) a .planet file (planet-style multi-clone projects), OR
//   2) a .claude/worktree-config.json (projects with full env wiring), OR
//   3) the active driver's worktree layout — allocation is universal, no
//      opt-in; the repo root is identity enough. The agent-specific positional
//      fallback (the path regex) lives in the adapter's worktree.detect
//      (drivers/<agent>/adapter.mjs), not here.
// Returns { parentDir, parentName } or null (null only for non-worktree paths
// with no marker at all).
// Exported: worktree-session.mjs uses this as the SINGLE project-discovery
// routine (no parallel walk in the hook).
export function findParentMarker(worktreePath) {
  let dir = worktreePath;
  while (dir && dir !== '/' && dir !== dirname(dir)) {
    if (dir !== worktreePath) {
      const planetPath = join(dir, '.planet');
      if (existsSync(planetPath)) {
        const env = parsePlanet(planetPath);
        return { parentDir: dir, parentName: env.PLANET_NAME || basename(dir) };
      }
      const cfgPath = join(dir, '.claude', 'worktree-config.json');
      if (existsSync(cfgPath)) {
        let projectName = basename(dir);
        try {
          const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
          if (cfg.project_name) projectName = cfg.project_name;
        } catch { /* fall through with basename */ }
        return { parentDir: dir, parentName: projectName };
      }
    }
    dir = dirname(dir);
  }
  // Universal fallback: the active driver identifies the project root from
  // the worktree path positionally even when no marker file exists (the layout
  // regex lives in the adapter). No-op adapter → null here.
  const wt = adapter.worktree.detect(worktreePath);
  if (wt) return { parentDir: wt.parentRepo, parentName: basename(wt.parentRepo) };
  return null;
}

// Liveness check: is anything listening on this TCP port?
function isPortInUse(port) {
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function nextFreePort(range, taken, isBackend) {
  const [lo, hi] = range;
  for (let p = lo; p <= hi; p++) {
    if (taken.has(p)) continue;
    if (isPortInUse(p)) continue;
    return p;
  }
  return null;
}

function gcInternal(data) {
  const removed = [];
  for (const [path, entry] of Object.entries(data.allocations)) {
    if (!existsSync(path)) {
      removed.push({ path, entry });
      delete data.allocations[path];
    }
  }
  return removed;
}

function deriveHostname(parentName, worktreeName) {
  // Strip trailing random hex suffix if present (Claude Code uses names like "keen-mayer-c3ead5").
  const stripped = worktreeName.replace(/-[a-f0-9]{4,8}$/i, '');
  return `${stripped}.${parentName}.told`;
}

function cmdAllocate(worktreePath) {
  if (!worktreePath || !worktreePath.startsWith('/')) fail(`allocate requires an absolute path; got: ${worktreePath}`);

  return withLock(() => {
    const data = loadRegistry();

    // Idempotent: return existing entry.
    if (data.allocations[worktreePath]) {
      return data.allocations[worktreePath];
    }

    // Recycle dead allocations before picking ports.
    gcInternal(data);

    const parent = findParentMarker(worktreePath);
    if (!parent) fail(`could not find a parent .planet or .claude/worktree-config.json by walking up from ${worktreePath}`);
    const parentName = parent.parentName;

    const taken = new Set();
    for (const e of Object.values(data.allocations)) {
      taken.add(e.backend);
      taken.add(e.frontend);
    }

    const backend = nextFreePort(data.ranges.backend, taken, true);
    if (backend === null) fail(`no free backend port in range ${data.ranges.backend.join('-')}`);
    taken.add(backend);
    const frontend = nextFreePort(data.ranges.frontend, taken, false);
    if (frontend === null) fail(`no free frontend port in range ${data.ranges.frontend.join('-')}`);

    const worktreeName = basename(worktreePath);
    const entry = {
      parent_planet: parentName,
      worktree_name: worktreeName,
      backend,
      frontend,
      hostname: deriveHostname(parentName, worktreeName),
      allocated_at: new Date().toISOString(),
    };
    data.allocations[worktreePath] = entry;
    saveRegistry(data);
    return entry;
  });
}

function cmdRelease(worktreePath) {
  return withLock(() => {
    const data = loadRegistry();
    const had = !!data.allocations[worktreePath];
    delete data.allocations[worktreePath];
    if (had) saveRegistry(data);
    return { released: had };
  });
}

function cmdList() {
  const data = loadRegistry();
  return data;
}

function cmdGc() {
  return withLock(() => {
    const data = loadRegistry();
    const removed = gcInternal(data);
    if (removed.length) saveRegistry(data);
    return { removed };
  });
}

function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(`Usage:
  worktree-ports.mjs allocate <worktree-path>
  worktree-ports.mjs release <worktree-path>
  worktree-ports.mjs list
  worktree-ports.mjs gc
`);
    process.exit(sub ? 0 : 1);
  }
  let result;
  switch (sub) {
    case 'allocate':  result = cmdAllocate(rest[0]);  break;
    case 'release':   result = cmdRelease(rest[0]);   break;
    case 'list':      result = cmdList();             break;
    case 'gc':        result = cmdGc();               break;
    default: fail(`unknown subcommand: ${sub}`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Run the CLI only when executed directly — this file is also imported by
// worktree-session.mjs for findParentMarker.
let _isMain = false;
try { _isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* argv[1] unreadable → not main */ }
if (_isMain) main();
