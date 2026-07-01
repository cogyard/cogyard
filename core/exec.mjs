// core/exec.mjs — process/git execution helpers + repo/_tasks discovery.

import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

function tryExec(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); }
  catch { return null; }
}
function execLoud(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
}
function findRepoRoot(start = process.cwd()) {
  return tryExec('git rev-parse --show-toplevel', { cwd: start });
}

function findTasksDir(start = process.cwd()) {
  let dir = resolve(start);
  while (dir && dir !== '/') {
    const candidate = join(dir, '_tasks');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (existsSync(join(dir, '.git'))) return join(dir, '_tasks');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Async git via execFile (no shell) — args as an array. Returns trimmed stdout
// or null on error. Used in the read-only views so per-repo / per-worktree git
// calls can be fanned out with Promise.all instead of running sequentially.
const execFileP = promisify(execFile);
async function gitP(args, cwd) {
  try { const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 1 << 24 }); return stdout.trim(); }
  catch { return null; }
}

// A repo's default branch: 'main', then 'master', else null. THE single source of
// truth — the portal views, the CLI, and (via the CLI) the skills all resolve the
// trunk through here instead of hardcoding 'main', so a 'master' repo Just Works.
async function defaultBranch(repo) {
  if (await gitP(['rev-parse', '--verify', '--quiet', 'refs/heads/main'], repo)) return 'main';
  if (await gitP(['rev-parse', '--verify', '--quiet', 'refs/heads/master'], repo)) return 'master';
  return null;
}
function defaultBranchSync(repo) {
  const opts = { cwd: repo };
  if (tryExec('git rev-parse --verify --quiet refs/heads/main', opts) != null) return 'main';
  if (tryExec('git rev-parse --verify --quiet refs/heads/master', opts) != null) return 'master';
  return null;
}

export { tryExec, execLoud, findRepoRoot, findTasksDir, gitP, defaultBranch, defaultBranchSync };
