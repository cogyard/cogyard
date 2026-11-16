// cli/scope.mjs — project scoping, shared by the CLI groups that report on
// chats and worktrees (`cogyard sessions`, `cogyard cleanup`).
//
// Extracted when the disposal commands moved out of sessions.mjs into
// cleanup.mjs (task 117): both groups need the same "which project am I
// standing in" rule, and a second copy would drift the moment one of them
// learned a new flag.

import { findRepoRoot } from '../core/exec.mjs';
import { resolveProjectForPath } from '../core/usage.mjs';

// Default scope = the project you're standing in (matching the rest of the CLI:
// work commands are repo-scoped). --everywhere lifts it; outside any repo there
// is nothing to scope to, so everything shows.
export function currentScope(rest) {
  if (rest.includes('--everywhere')) return null;
  const root = findRepoRoot(process.cwd());
  return root ? resolveProjectForPath(root) : null;
}

// A row is in scope when its project is the scope's slug (alias slugs are
// mapped by the ledger reader).
export function inScope(scope) {
  return (r) => !scope || r.project === scope;
}

export function scopeNote(scope) {
  return scope ? `scope: ${scope} (use --everywhere for all projects)\n` : '';
}
