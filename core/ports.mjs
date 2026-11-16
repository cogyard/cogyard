// core/ports.mjs — which ports should a dev server in THIS directory bind, and
// what does this project call them? (task 131)
//
// THE REGISTRY IS THE ONLY SOURCE (task 121). `~/.cogyard/ports.json` is where a
// worktree's ports exist. Ports used to reach a dev server through a COPY the
// SessionStart hook wrote into .env.worktree, and the copy could rot: on
// 2026-08-18 a worktree's file said 30000/31000 while its real allocation was
// 30045/31046, so the server bound the wrong ports and the portal's link to it
// was dead, with nobody noticing. A copy that is right almost always is worse
// than none, because everyone stops checking it.
//
// NEVER GUESS — NOT THE NUMBER, NOT THE NAME. In a linked worktree an
// unreadable allocation is a hard error: falling back to a default there is
// exactly what puts two worktrees on one port. The same applies to the variable
// NAMES, which differ per project (PORT/FRONTEND_PORT here, BACKEND_PORT
// elsewhere, a single PLANET_PORT in another) — printing an assignment under a
// name the project does not read binds nothing and looks like it worked. Both
// come from declarations: the number from ports.json, the name from the
// project's worktree config `port_vars` (`.cogyard/worktree.json`).
//
// Outside a worktree there is nothing to collide with, so the repo's own
// defaults are correct and this module deliberately answers with NO assignments
// — the caller keeps whatever it already had.
//
// WHY IN core/. This is the rule a dev script in ANY project asks about, via
// `cogyard env ports`. It lived in scripts/dev-ports.sh, a file only this repo
// could run; every other project would have needed a copy of it, which is the
// duplication task 121 removed from the launch-entry logic.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tryExec } from './exec.mjs';
import { loadPortAllocations } from './worktrees.mjs';
import { findWorktreeConfig, WORKTREE_CONFIG } from './worktree-config.mjs';

// Git's own distinction: a linked worktree's git dir is <common>/worktrees/<name>,
// while the main working tree's git dir IS the common dir. No path convention,
// so this holds for every project's layout.
function gitFacts(cwd) {
  const gitDir = tryExec('git rev-parse --git-dir', { cwd });
  if (!gitDir) return null;
  const commonDir = tryExec('git rev-parse --git-common-dir', { cwd });
  const toplevel = tryExec('git rev-parse --show-toplevel', { cwd });
  if (!commonDir || !toplevel) return null;
  const abs = (p) => (p.startsWith('/') ? p : resolve(cwd, p));
  const inWorktree = abs(gitDir) !== abs(commonDir);
  // The project root is the main checkout: the common git dir's parent. That is
  // where the committed worktree config lives.
  return { inWorktree, worktreePath: toplevel, projectRoot: inWorktree ? dirname(abs(commonDir)) : toplevel };
}

// The project's declared variable names: { NAME: 'backend' | 'frontend' }.
// Returns { vars } or { error } — a config that exists but declares nothing
// usable is an error, never a silent fallback to this repo's own names.
function readPortVars(projectRoot) {
  const found = findWorktreeConfig(projectRoot);
  if (!found) return { error: `${join(projectRoot, WORKTREE_CONFIG)} does not exist, so the ports have no names in this project` };
  const { path } = found;
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return { error: `${path} is not readable JSON (${e.message})` }; }
  const vars = cfg?.port_vars;
  if (!vars || typeof vars !== 'object' || !Object.keys(vars).length) {
    return { error: `${path} declares no port_vars, so the ports have no names in this project` };
  }
  for (const [name, side] of Object.entries(vars)) {
    if (side !== 'backend' && side !== 'frontend') {
      return { error: `${path}: port_vars[${name}] must be 'backend' or 'frontend'; got '${side}'` };
    }
  }
  return { vars };
}

// `.`, not "$PWD": run from inside the worktree. The worktree-isolation sandbox
// refuses a "$PWD" argument as too complex to verify, and the hook resolves a
// relative path itself.
const FIX_ALLOCATION = 'cogyard hook session-start .';

// The one answer. Shape:
//   { inWorktree, worktreePath, projectRoot, allocation, assignments, problem }
// `assignments` is [{ name, side, port }] — empty outside a worktree, where the
// caller's own defaults are the right answer. `problem` set means the caller
// must NOT print anything a dev script could bind to; it carries the message.
function devPorts(cwd = process.cwd()) {
  const facts = gitFacts(cwd);
  const base = {
    inWorktree: false, worktreePath: null, projectRoot: null,
    allocation: null, assignments: [], problem: null,
  };
  // Not a git repo at all: nothing to collide with, nothing to say.
  if (!facts) return base;
  const { inWorktree, worktreePath, projectRoot } = facts;
  if (!inWorktree) return { ...base, worktreePath, projectRoot };

  const allocation = loadPortAllocations()[worktreePath] || null;
  if (!allocation || !allocation.backend || !allocation.frontend) {
    return {
      ...base, inWorktree, worktreePath, projectRoot,
      problem: {
        reason: 'no-allocation',
        message: `this is a worktree, but its port allocation could not be read.
Ports come from ~/.cogyard/ports.json; guessing one here would collide with another worktree.
Fix — run this from inside the worktree:
  ${FIX_ALLOCATION}`,
      },
    };
  }

  const { vars, error } = readPortVars(projectRoot);
  if (error) {
    return {
      ...base, inWorktree, worktreePath, projectRoot, allocation,
      problem: {
        reason: 'no-names',
        message: `${error}.
This worktree's allocation is backend=${allocation.backend} frontend=${allocation.frontend}; naming those
by guess is how a dev server exports a variable nothing reads. Declare port_vars —
see docs/WORKTREE-PORTS.md.`,
      },
    };
  }

  const assignments = Object.entries(vars).map(([name, side]) => ({ name, side, port: allocation[side] }));
  return { inWorktree, worktreePath, projectRoot, allocation, assignments, problem: null };
}

// Shell rendering lives here so the CLI stays a printer. `export` is deliberate:
// the consumer is `eval "$(cogyard env ports --shell)"` in a dev script whose
// server runs as a CHILD process, and a bare assignment is a shell variable the
// child never sees.
function shellLines(assignments) {
  return assignments.map((a) => `export ${a.name}=${a.port}`);
}

export { devPorts, shellLines };
