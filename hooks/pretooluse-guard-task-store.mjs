#!/usr/bin/env node
// PreToolUse(Bash) guard: an agent changes a task store only through cogyard's
// own commands, never through raw git (task 228).
//
// THE FAILURE THIS EXISTS FOR. A store's history is the record of what happened
// to every task: who claimed it, when it closed, how. cogyard's commands keep
// that record honest — `sync push` commits only the files you name (task 225)
// and refuses what a store may not hold (task 190); `close` and `reopen` set
// status, done_date and the claim together and say what they did. On
// 2026-10-18 an agent repairing a close it had got wrong ran `git revert`
// twice inside a store, around all of it. Nothing stopped it.
//
// THE RULE. A git command that WRITES — commit, revert, reset, rebase, merge,
// checkout, stash, a branch or tag created or deleted, anything not on the
// read-only list below — is refused when it runs inside a registered project's
// task store: by `-C <store>`, by a `cd` into it earlier in the command, or from
// a cwd inside it. Reading (log, show, status, diff, blame, …) is always fine.
//
// A SECOND RULE, about the project repo rather than the store (task 197). A
// `git add` naming the task link (`.cogyard/tasks`, or a path through it) is
// refused when that repo's link is a symlink: the link is gitignored, so the add
// does nothing — and task edits "committed" that way land nowhere. The way to
// commit them is `cogyard tasks sync push`.
//
// WHAT IT IS NOT. A seatbelt for the agent's Bash tool. cogyard's own commands
// run git as child processes, which never reach this hook, and a human terminal
// is untouched — that is how the owner deliberately does something by hand.
//
// Fail-open everywhere. Anything unparseable, unresolvable or exotic exits 0
// (allow): a guard that crashes closed would block every shell command.

import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
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
if (typeof command !== 'string' || !/\bgit\b/.test(command)) allow();
const startCwd = input?.cwd || process.cwd();

// --- shell surface (the same crude split the branch-switch guard uses) --------
function segments(cmd) {
  return cmd.split(/\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

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

const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p);

const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--exec-path', '--namespace', '--work-tree', '--git-dir', '--super-prefix']);

// {dirs, sub, args} for a git invocation, or null when the segment is not one
// (or rewrites the repo/work tree, which this guard does not model).
function parseGit(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;   // FOO=bar git …
  if (tokens[i] !== 'git') return null;
  i++;
  const dirs = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    if (t === '--git-dir' || t === '--work-tree' || t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) return null;
    if (t === '-C') { if (i + 1 >= tokens.length) return null; dirs.push(expandHome(tokens[i + 1])); i += 2; continue; }
    if (GIT_OPTS_WITH_VALUE.has(t)) { i += 2; continue; }
    i++;
  }
  if (i >= tokens.length) return null;
  return { dirs, sub: tokens[i], args: tokens.slice(i + 1) };
}

// --- does this git subcommand write? ----------------------------------------
const READ_ONLY = new Set([
  'log', 'show', 'status', 'diff', 'blame', 'annotate', 'grep', 'rev-parse', 'rev-list', 'ls-files',
  'ls-tree', 'cat-file', 'describe', 'shortlog', 'whatchanged', 'show-ref', 'for-each-ref',
  'count-objects', 'help', 'version', 'name-rev', 'merge-base', 'var', 'check-ignore', 'show-branch',
  'fetch', 'diff-tree', 'diff-files', 'diff-index', 'range-diff', 'cherry',
]);
const BRANCH_WRITE_FLAGS = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force',
  '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-t', '--track']);
const LISTING_FLAGS = new Set(['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current']);

function writes(sub, args) {
  if (args.includes('--help') || args.includes('-h')) return false;
  if (READ_ONLY.has(sub)) return false;
  const first = args[0];
  switch (sub) {
    case 'branch':
    case 'tag': {
      if (args.some((a) => BRANCH_WRITE_FLAGS.has(a) || a.startsWith('--set-upstream-to='))) return true;
      if (sub === 'tag' && args.some((a) => a === '-a' || a === '-s' || a === '-m')) return true;
      const positional = args.some((a) => !a.startsWith('-'));
      return positional && !args.some((a) => LISTING_FLAGS.has(a));
    }
    case 'stash': return !(first === 'list' || first === 'show');
    case 'config': return !args.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin'].includes(a));
    case 'remote': return !(args.length === 0 || first === '-v' || first === 'show' || first === 'get-url');
    case 'reflog': return !(args.length === 0 || first === 'show');
    case 'worktree': return first !== 'list';
    case 'notes': return !(first === 'list' || first === 'show');
    default: return true;
  }
}

// --- which directories are task stores? -------------------------------------
// The registered projects' stores, located by canonicalStore — the one place a
// store's location is defined. The RAW registry, as the branch-switch guard
// uses: a store is worth protecting whether or not its project is mounted.
let storesCache = null;
async function stores() {
  if (storesCache) return storesCache;
  try {
    const { readRegistry, canonicalStore } = await import(`${SELF}/../core/index.mjs`);
    storesCache = new Set((readRegistry() || []).map((p) => canonicalStore(p.path)).filter(Boolean));
  } catch { storesCache = new Set(); }
  return storesCache;
}

function topLevel(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const top = (r.stdout || '').trim();
  try { return realpathSync(top); } catch { return top || null; }
}

// Does this `git add` name the repo's task link, when that link is a symlink?
// The link's name comes from core/tasks-dir.mjs, the one place it is defined.
let linkName = null;
async function addsTaskLink(top, args) {
  try {
    if (linkName == null) ({ TASKS_DIR: linkName } = await import(`${SELF}/../core/tasks-dir.mjs`));
    if (!args.some((a) => !a.startsWith('-') && a.includes(linkName))) return false;
    return lstatSync(join(top, linkName)).isSymbolicLink();
  } catch { return false; }
}

// --- walk the command, following cd -------------------------------------------
let cwd = startCwd;
for (const seg of segments(command)) {
  const tokens = tokenize(seg);
  if (!tokens) continue;                                  // unbalanced quotes — fail open
  if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
    cwd = cwd && resolve(cwd, expandHome(tokens[1] || '~'));
    continue;
  }
  if (tokens[0] === 'popd') { cwd = null; continue; }     // can't know where — stop judging
  const inv = parseGit(tokens);
  if (!inv || !cwd) continue;
  if (!writes(inv.sub, inv.args)) continue;

  const dir = inv.dirs.reduce((acc, d) => resolve(acc, d), cwd);
  const top = topLevel(dir);
  if (!top) continue;                                     // not a repo — git will say so

  if (inv.sub === 'add' && (await addsTaskLink(top, inv.args))) {
    deny(
      `Task-link guard: \`git add ${inv.args.join(' ')}\` names the task link, which is a gitignored symlink to the task store — `
      + `git adds nothing through it, so these task edits would land nowhere.\n\n`
      + `Commit task edits in the store instead:\n`
      + `  cogyard tasks sync push "<message>" -- <file>…   (name every task file you changed, at the path \`cogyard tasks find <id>\` prints)`,
    );
  }
  if (!(await stores()).has(top)) continue;

  deny(
    `Task-store guard: \`git ${inv.sub}${inv.args.length ? ' ' + inv.args.join(' ') : ''}\` would change the task store at \`${top}\` behind cogyard's back.\n\n`
    + `A store's history is the record of every task — who claimed it, when and how it closed. Change it only through cogyard:\n`
    + `  • commit task edits → \`cogyard tasks sync push "<message>" -- <file>…\` (name every file)\n`
    + `  • close a task → \`cogyard tasks close <id>\`; undo a close → \`cogyard tasks reopen <id> --why "<reason>"\`\n`
    + `  • claim / release → \`cogyard env claim <file> <session-id>\` / \`cogyard env release <file>\`\n`
    + `  • pull from another machine → \`cogyard tasks sync pull\`\n\n`
    + `Reading the store with git (log, show, status, diff, blame) is always allowed. `
    + `If something truly needs raw git here, tell the owner what and why; they can run it from their own terminal.`,
  );
}

allow();
