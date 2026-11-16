// core/worktree-config.mjs — where a project's committed worktree config lives
// (task 159). One answer for every reader: the port hook, the allocator's
// project discovery, `cogyard env ports`, and the Stop-hook dev-server check.
//
// THE FILE IS COGYARD'S, SO IT LIVES IN COGYARD'S FOLDER: `.cogyard/worktree.json`.
// It used to sit at `.claude/worktree-config.json`, inside Claude Code's own
// folder — a Claude literal in an engine that must not hardcode one (task 038).
// Every registered project was moved by task 183, which also removed the
// fallback that read the old path; it is no longer read anywhere.
//
// Dependency-free on purpose: the Stop hook imports this and must stay cheap.

import { statSync } from 'node:fs';
import { join } from 'node:path';

const WORKTREE_CONFIG = join('.cogyard', 'worktree.json');

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// { path } — the absolute path of the file to read — or null when the project
// has no worktree config.
function findWorktreeConfig(projectRoot) {
  const path = join(projectRoot, WORKTREE_CONFIG);
  return isFile(path) ? { path } : null;
}

// The dev command a parsed config names, or null when it names none (task 162).
// A config with no `dev_script` is a project that reserves ports but has no dev
// server — an app built in Xcode, firmware flashed from PlatformIO — and every
// reader treats it that way: no preview entry, no "start your server" nag. It
// used to default to `npm run dev`, which handed such a project a command that
// does not exist.
function devScriptOf(cfg) {
  const s = cfg?.dev_script;
  return typeof s === 'string' && s.trim() ? s : null;
}

export { WORKTREE_CONFIG, findWorktreeConfig, devScriptOf };
