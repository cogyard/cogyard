#!/usr/bin/env node
// PreToolUse(Bash) guard: the main working tree is the home of the default
// branch, and nothing may move it off.
//
// THE FAILURE THIS EXISTS FOR. Two agent sessions rooted at the same directory
// share ONE working copy. Git has no per-process notion of "which branch am I
// on" — the branch is one file, `.git/HEAD`, and any `git checkout` rewrites it
// for every process at once. Session A read the branch as the default branch,
// session B switched the shared checkout to a feature branch, and session A's
// merge — issued a minute later — landed on session B's branch. Linked
// worktrees are already safe (each has its own HEAD, and a branch may be
// checked out in only one place), so the main working tree is the whole hole.
//
// THE RULE. In a REGISTERED project's MAIN working tree, a command that moves
// HEAD is refused unless it moves HEAD to the default branch. Moving home is
// always allowed and is idempotent, which matters because the merge sequence
// re-asserts `git checkout <base>` on every run; a guard that blocked that
// would break every merge.
//
// WHAT IT IS NOT. A seatbelt, not a wall. It sees the agent's Bash tool and
// nothing else — a human terminal or an editor can still switch the branch, and
// no git mechanism can stop them: there is no `pre-checkout` hook, and a
// `reference-transaction` hook does not fire on a branch switch (verified).
// That escape is deliberate; it is how a human deliberately overrides.
//
// Fail-open everywhere. Anything unparseable, unresolvable, or merely exotic
// exits 0 (allow). A guard that crashes closed would block every merge, which
// is far worse than missing a switch that `git branch --show-current` still
// reveals a second later.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

function allow() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// --- read stdin ------------------------------------------------------------
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { allow(); }
let input;
try { input = JSON.parse(raw); } catch { allow(); }

if (input?.tool_name !== 'Bash') allow();
const command = input?.tool_input?.command;
if (typeof command !== 'string' || !command.trim()) allow();
const cwd = input?.cwd || process.cwd();

// --- shell surface ---------------------------------------------------------
// Split on the operators that separate commands. Deliberately crude: this only
// has to FIND git invocations, and anything it mis-splits fails open below.
function segments(cmd) {
  return cmd.split(/\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

// Tokenize honouring simple quoting. Unbalanced quotes → null (fail open).
function tokenize(seg) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started || cur) { out.push(cur); cur = ''; started = false; } continue; }
    cur += ch;
    started = true;
  }
  if (quote) return null;
  if (started || cur) out.push(cur);
  return out;
}

// A `cd` anywhere in the command means a later `git checkout` may not run where
// this hook thinks it does. Rather than guess wrong and refuse a legitimate
// switch in another directory, stand down for the whole command.
const segs = segments(command);
if (segs.some((s) => /^(cd|pushd|popd)\b/.test(s))) allow();

// --- git invocation parsing ------------------------------------------------
// Global options that take a separate value; their value must not be mistaken
// for the subcommand.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--exec-path', '--namespace', '--work-tree', '--git-dir', '--super-prefix']);

// Returns {dirs, sub, args} for a git invocation, or null when the segment is
// not one (or is too exotic to reason about).
function parseGit(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;   // FOO=bar git …
  if (tokens[i] !== 'git') return null;
  i++;
  const dirs = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    // A rewritten repo or work tree is outside what this guard models.
    if (t === '--git-dir' || t === '--work-tree' || t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) return null;
    if (t === '-C') { if (i + 1 >= tokens.length) return null; dirs.push(tokens[i + 1]); i += 2; continue; }
    if (GIT_OPTS_WITH_VALUE.has(t)) { i += 2; continue; }
    i++;
  }
  if (i >= tokens.length) return null;
  return { dirs, sub: tokens[i], args: tokens.slice(i + 1) };
}

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

// The main working tree is the one whose git dir IS the common git dir; a
// linked worktree's git dir is `<common>/worktrees/<name>`. This is git's own
// distinction, so it holds for any agent's worktree layout and needs no path
// convention.
function mainWorktreeRoot(dir) {
  const out = git(dir, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!out) return null;
  const [gitDir, commonDir, top] = out.split('\n').map((s) => s.trim());
  if (!gitDir || !commonDir || !top) return null;
  const abs = (p) => { try { return realpathSync(resolve(dir, p)); } catch { return resolve(dir, p); } };
  if (abs(gitDir) !== abs(commonDir)) return null;      // linked worktree — already safe
  try { return realpathSync(top); } catch { return top; }
}

// Only police repos this system knows about. An unrelated clone is none of its
// business, and silently changing git's behaviour everywhere would be worse
// than the collision it prevents.
//
// The RAW registry, not discoverProjects(): the latter drops any project whose
// task directory is not currently mounted, and a checkout with an unmounted task
// store is still a checkout worth protecting. Registered paths and their
// aliases both count — an alias is the same repo under an older path.
async function isRegisteredProject(repoRoot) {
  try {
    const { readRegistry } = await import(`${SELF}/../core/index.mjs`);
    const same = (p) => { try { return realpathSync(p) === repoRoot; } catch { return false; } };
    return (readRegistry() || []).some((p) => same(p.path) || (p.aliases || []).some(same));
  } catch { return false; }
}

async function baseBranchOf(repoRoot) {
  try {
    const { defaultBranchSync } = await import(`${SELF}/../core/index.mjs`);
    const b = defaultBranchSync(repoRoot);
    if (b) return b;
  } catch { /* fall through */ }
  return null;
}

// --- does this invocation MOVE HEAD, and where to? -------------------------
// Returns null when HEAD does not move (so: allowed), else the target as
// written — `{ target, creates }`.
const CHECKOUT_OPTS_WITH_VALUE = new Set(['-b', '-B', '--orphan', '--track', '-t', '--conflict', '--pathspec-from-file']);

function headMoveForCheckout(args) {
  if (args.includes('--help') || args.includes('-h')) return null;
  if (args.includes('-p') || args.includes('--patch')) return null;   // hunk restore
  const dashdash = args.indexOf('--');
  if (dashdash !== -1) return null;                                    // pathspec restore
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-b' || a === '-B' || a === '--orphan') {
      const name = args[i + 1];
      if (!name) return null;
      return { target: name, creates: true };
    }
    if (a === '--detach') return { target: 'HEAD (detached)', creates: false };
    if (CHECKOUT_OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a === '-') { positional.push('- (the previous branch)'); continue; }   // a ref, not an option
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  if (positional.length !== 1) return null;    // 0 = no-op · 2+ = ref + pathspec
  return { target: positional[0], creates: false };
}

function headMoveForSwitch(args) {
  if (args.includes('--help') || args.includes('-h')) return null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-C' || a === '--create' || a === '--force-create') {
      const name = args[i + 1];
      if (!name) return null;
      return { target: name, creates: true };
    }
    if (a === '--detach' || a === '-d') return { target: 'HEAD (detached)', creates: false };
    if (a === '--orphan') { const n = args[i + 1]; return n ? { target: n, creates: true } : null; }
    if (a === '-t' || a === '--track' || a === '--start-point') { i++; continue; }
    if (a === '-') { positional.push('- (the previous branch)'); continue; }   // a ref, not an option
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  if (positional.length !== 1) return null;
  return { target: positional[0], creates: false };
}

// --- walk the command ------------------------------------------------------
for (const seg of segs) {
  const tokens = tokenize(seg);
  if (!tokens) continue;                       // unbalanced quotes — fail open
  const inv = parseGit(tokens);
  if (!inv) continue;
  if (inv.sub !== 'checkout' && inv.sub !== 'switch') continue;

  const dir = inv.dirs.reduce((acc, d) => resolve(acc, d), cwd);
  const repoRoot = mainWorktreeRoot(dir);
  if (!repoRoot) continue;                     // not a repo, or a linked worktree

  if (!(await isRegisteredProject(repoRoot))) continue;

  const base = await baseBranchOf(repoRoot);
  if (!base) continue;                         // can't resolve home — fail open

  const move = inv.sub === 'checkout' ? headMoveForCheckout(inv.args) : headMoveForSwitch(inv.args);
  if (!move) continue;                         // HEAD does not move
  if (!move.creates && move.target === base) continue;   // going home — always fine

  const current = git(repoRoot, ['branch', '--show-current']) || '(detached)';
  deny(
    `Branch-switch guard: \`${repoRoot}\` is the permanent home of \`${base}\` and may not be moved off it.\n\n`
    + `Refused: \`git ${inv.sub} ${inv.args.join(' ')}\`  (would put this checkout on \`${move.target}\`; it is on \`${current}\`)\n\n`
    + `Why: this directory is ONE working copy, shared by every session working here and by anything that builds from it. `
    + `A branch switch here rewrites .git/HEAD for all of them at once — that is how a merge lands on the wrong branch.\n\n`
    + `Instead:\n`
    + `  • work on a branch → make a worktree (each has its own HEAD): \`git -C ${repoRoot} worktree add <path> <branch>\`, or the EnterWorktree tool\n`
    + `  • run a command against another branch → \`git -C <that worktree> …\`\n`
    + `  • return home → \`git checkout ${base}\` is always allowed here\n\n`
    + `This guard only sees the agent's shell; a human can still switch the branch from their own terminal.`,
  );
}

allow();
