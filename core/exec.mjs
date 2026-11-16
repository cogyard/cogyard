// core/exec.mjs — process/git execution helpers + repo/task-directory discovery.

import { execSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tasksDirOf } from './tasks-dir.mjs';

function tryExec(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim(); }
  catch { return null; }
}
function execLoud(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: 'inherit', ...opts });
}
// Anything that writes a commit (a commit, a rebase, an autostash) needs an
// author identity, and a fresh machine often has none: git then refuses, and a
// new user's first `sync push` died on a stack trace. Fill in whichever of name
// and email git can't find for `cwd` with a neutral cogyard value. Whatever the
// user has configured — globally or in that repo — is always used instead.
// gitIdentityArgs is for an argument list; gitIdentityFlags for a command string
// (ends in a space when non-empty, so it goes straight after `git `).
const IDENTITY_FALLBACK = [['user.name', 'cogyard'], ['user.email', 'cogyard@localhost']];
function gitIdentityArgs(cwd) {
  return IDENTITY_FALLBACK.flatMap(([key, value]) =>
    tryExec(`git config ${key}`, { cwd }) ? [] : ['-c', `${key}=${value}`]);
}
function gitIdentityFlags(cwd) {
  const args = gitIdentityArgs(cwd);
  return args.length ? args.join(' ') + ' ' : '';
}

function findRepoRoot(start = process.cwd()) {
  return tryExec('git rev-parse --show-toplevel', { cwd: start });
}

// Walk up from `start` to the nearest project's task directory. Which of the
// two link names a project uses is core/tasks-dir.mjs's call (task 160).
function findTasksDir(start = process.cwd()) {
  let dir = resolve(start);
  while (dir && dir !== '/') {
    const candidate = tasksDirOf(dir);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (existsSync(join(dir, '.git'))) return candidate;
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

export { tryExec, execLoud, gitIdentityArgs, gitIdentityFlags, findRepoRoot, findTasksDir, gitP, defaultBranch, defaultBranchSync };
