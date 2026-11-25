#!/usr/bin/env node
// PreToolUse guard (Bash + EnterWorktree + ExitWorktree): a task worktree is
// made by Claude Code's EnterWorktree tool, never by hand, and never replaced.
//
// THE FAILURE THIS EXISTS FOR (2026-10-11). A pickup's new worktree came out
// behind local main: EnterWorktree branches from origin, and main held commits
// that were never pushed. The chat offered "a fresh worktree from local main",
// something the tool cannot make, and on a yes removed the app's worktree with
// ExitWorktree `remove`, made a replacement with `git worktree add -b`, and
// entered it with EnterWorktree `path=`. The chat moved to a different heading
// in the desktop sidebar, and undoing it took a dozen hand steps.
//
// THE RULES.
//   Bash — `git worktree add` with -b / -B / --orphan is refused, except ONE
//     shape: a task worktree cut from another task's unmerged branch, so one
//     task can build on another before it merges. EnterWorktree can't do that
//     (it always branches from origin), so it is made by hand from the main
//     checkout: `git worktree add .claude/worktrees/task-<id>-<slug>
//     -b worktree-task-<id>-<slug> <other task's branch>`. Allowed only when the
//     session's own folder is a main checkout (not a linked worktree), git runs
//     in a main checkout, the path is that checkout's
//     `.claude/worktrees/task-<id>-<slug>`, and the branch is `worktree-` plus
//     the same name — the names EnterWorktree would give it. Any base is
//     allowed. Re-attaching an existing branch (`git worktree add <path>
//     <branch>`, no -b) is always fine.
//   ExitWorktree `action: "remove"` — ask: it deletes the worktree and branch.
//   EnterWorktree `path=` — refused when the worktree is a task's recorded
//     worktree (cogyard's claims.json) and this chat does not hold that task's
//     claim (task 260): pickup-task claims first, then enters. Otherwise ask
//     when the worktree's branch is not `worktree-*` (the app's own naming), so
//     entering one that was made by hand is a decision someone approves.
//
// PLUGIN-LOCAL on purpose: every rule here is about Claude Code's own tools and
// its `.claude/worktrees/` layout, which the engine may not name. It imports
// nothing outside this plugin, so it judges every repo, registered or not.
//
// Fail-open where the guard cannot read the command (unbalanced quotes, a git
// invocation it does not model). Once a new-branch worktree is found, though,
// the exception has to be PROVEN; anything it cannot confirm is refused.

import { spawnSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { realpathSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

function allow() { process.exit(0); }
function decide(permissionDecision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
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

const tool = input?.tool_name;
const startCwd = input?.cwd || process.cwd();

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// The main working tree is the one whose git dir IS the common git dir; a
// linked worktree's git dir is `<common>/worktrees/<name>`. Returns the main
// checkout's root, or null for a linked worktree / not a repo.
function mainWorktreeRoot(dir) {
  const out = git(dir, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!out) return null;
  const [gitDir, commonDir, top] = out.split('\n').map((s) => s.trim());
  if (!gitDir || !commonDir || !top) return null;
  if (real(resolve(dir, gitDir)) !== real(resolve(dir, commonDir))) return null;
  return real(top);
}

// The claim record for the task whose worktree `wt` is, or null (task 260).
// cogyard's `env claim` writes this machine's half of every claim to
// <cogyard home>/claims.json, keyed `<store real path>#<task id>`, with the
// worktree's folder name and the claiming chat. The store is the one the
// worktree's main checkout links to as `.cogyard/tasks`. Read directly, not
// through cogyard's engine: this hook imports nothing outside the plugin.
// Anything unreadable → null, and the guard falls back to its other rules.
function taskClaimFor(wt) {
  const common = git(wt, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  let store;
  try { store = realpathSync(resolve(dirname(common), '.cogyard', 'tasks')); } catch { return null; }
  const home = process.env.COGYARD_HOME || resolve(homedir(), '.cogyard');
  let all;
  try { all = JSON.parse(readFileSync(resolve(home, 'claims.json'), 'utf8')); } catch { return null; }
  if (!all || typeof all !== 'object') return null;
  const name = basename(wt);
  const me = typeof input?.session_id === 'string' ? input.session_id : null;
  const hits = Object.entries(all)
    .filter(([k, v]) => k.startsWith(store + '#') && v && v.worktree === name)
    .map(([k, v]) => ({ id: k.slice(store.length + 1), session: v.session || null }));
  if (!hits.length) return null;
  return hits.find((h) => me && h.session === me) || hits[0];
}

// --- ExitWorktree ----------------------------------------------------------
if (tool === 'ExitWorktree') {
  if (input?.tool_input?.action !== 'remove') allow();
  decide('ask',
    'Worktree guard: ExitWorktree `remove` deletes this worktree AND its branch. '
    + 'Approve only if the user asked for exactly this. '
    + 'Never remove a worktree in order to replace it with another one: if it is behind main, '
    + 'rebase it onto main as the project\'s rebase switch says (`git rebase <base>`), '
    + 'or, when it has commits of its own and is not a task being resumed, report `git log --oneline HEAD..<base>` and stop.');
}

// --- EnterWorktree ---------------------------------------------------------
if (tool === 'EnterWorktree') {
  const p = input?.tool_input?.path;
  if (typeof p !== 'string' || !p.trim()) allow();         // name= (or neither) — the tool makes it
  const wt = resolve(startCwd, p);
  const branch = git(wt, ['branch', '--show-current']);
  if (branch === null) allow();                           // not a checkout — the tool refuses it itself
  // A task's recorded worktree is entered only by the chat holding that task's
  // claim (task 260). Entering one ad hoc skips pickup-task's staleness check,
  // rebase and claim, and puts two chats in one folder. The rule used to be one
  // line in the owner's CLAUDE.md, which task 247 dropped; it is enforced here.
  const rec = taskClaimFor(wt);
  if (rec) {
    const me = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
    if (me && rec.session !== me) {
      decide('deny',
        `Worktree guard: ${wt} is task ${rec.id}'s worktree, and this chat does not hold that task's claim `
        + `(${rec.session ? `held by chat ${rec.session}` : 'it is released'}). A task's worktree is entered only by the chat that `
        + `claimed it, through pickup-task:\n\n`
        + `  1. From the main checkout, claim it: cogyard env claim "$(cogyard tasks find ${rec.id})" <this chat's id>`
        + `${rec.session ? ' --force (only if the owner said to take it over, or that chat is finished)' : ''}\n`
        + `     (a DONE task is reopened first: cogyard tasks reopen ${rec.id} --why "<the owner's words>")\n`
        + `  2. Then EnterWorktree path=${wt}\n\n`
        + `If you only need to read its files, read them by path; entering is not needed.`);
    }
  }
  if (branch.startsWith('worktree-')) allow();
  decide('ask',
    `Worktree guard: EnterWorktree path=${wt} is on branch \`${branch || '(detached)'}\`, which the app did not create `
    + '(its branches are `worktree-<name>`). Approve only if this is a task\'s RECORDED worktree '
    + '(`cogyard env where <task-file>`) being re-entered by the pickup-task continuation flow. '
    + 'Never enter a worktree that was just made by hand.');
}

if (tool !== 'Bash') allow();
const command = input?.tool_input?.command;
if (typeof command !== 'string' || !/\bworktree\b/.test(command)) allow();

// --- shell surface (the same crude split the engine's Bash guards use) -------
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

const expandHome = (p) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p);

const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--exec-path', '--namespace', '--work-tree', '--git-dir', '--super-prefix']);

// {dirs, sub, args} for a git invocation, or null when the segment is not one.
function parseGit(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;   // FOO=bar git …
  if (tokens[i] !== 'git') return null;
  i++;
  const dirs = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    if (t === '-C') { if (i + 1 >= tokens.length) return null; dirs.push(expandHome(tokens[i + 1])); i += 2; continue; }
    if (GIT_OPTS_WITH_VALUE.has(t)) { i += 2; continue; }
    i++;
  }
  if (i >= tokens.length) return null;
  return { dirs, sub: tokens[i], args: tokens.slice(i + 1) };
}

// `worktree add` arguments → { newBranch, orphan, path } or null when no new
// branch is made. -b/-B take a value (also glued: -bname); --orphan is a flag.
function newBranchAdd(args) {
  let newBranch = null;
  let orphan = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-b' || a === '-B') { newBranch = args[i + 1] ?? ''; i++; continue; }
    if (/^-[bB]./.test(a)) { newBranch = a.slice(2); continue; }
    if (a === '--orphan') { orphan = true; continue; }
    if (a === '--reason') { i++; continue; }
    if (a === '--') { positional.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  if (newBranch === null && !orphan) return null;
  return { newBranch, orphan, path: positional[0] ?? null };
}

// Why this new-branch worktree is NOT the allowed task-worktree shape, or null
// when it is.
function notTaskWorktreeShape(add, gitDir) {
  if (add.orphan) return '--orphan is never allowed';
  if (!startCwd || !mainWorktreeRoot(startCwd)) return 'this session is not in a main checkout (it is inside a linked worktree, or the folder is unknown)';
  if (!gitDir) return 'the folder git runs in could not be followed';
  const top = mainWorktreeRoot(gitDir);
  if (!top) return 'git runs inside a linked worktree, not the main checkout';
  if (!add.path) return 'no worktree path was given';
  const target = resolve(gitDir, expandHome(add.path));
  const name = basename(target);
  if (real(dirname(target)) !== resolve(top, '.claude', 'worktrees')) return `the path is not under ${top}/.claude/worktrees/`;
  if (!/^task-[0-9][0-9A-Za-z.]*-[A-Za-z0-9._-]+$/.test(name)) return `the worktree name \`${name}\` is not task-<id>-<slug>`;
  if (add.newBranch !== `worktree-${name}`) return `the branch \`${add.newBranch}\` is not \`worktree-${name}\``;
  return null;
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
  if (tokens[0] === 'popd') { cwd = null; continue; }     // can't know where any more
  const inv = parseGit(tokens);
  if (!inv || inv.sub !== 'worktree' || inv.args[0] !== 'add') continue;
  const add = newBranchAdd(inv.args.slice(1));
  if (!add) continue;                                     // re-attaching an existing branch

  const gitDir = cwd ? inv.dirs.reduce((acc, d) => resolve(acc, d), cwd) : null;
  const why = notTaskWorktreeShape(add, gitDir);
  if (!why) continue;

  decide('deny',
    `Worktree guard: refused \`git worktree add ${inv.args.slice(1).join(' ')}\` — a worktree on a NEW branch is not made by hand.\n\n`
    + 'A task worktree is made by the EnterWorktree tool with name=. A hand-made one, entered with EnterWorktree path=, '
    + 'has moved a chat to the wrong heading in the Claude desktop sidebar and broken a pickup that took a dozen hand steps to undo.\n\n'
    + 'If the worktree EnterWorktree made is behind local main (it branches from origin, so commits never pushed are missing): '
    + 'it has no commits of its own yet, so rebase it onto local main (`git rebase <base>`) as the project\'s rebase switch says. '
    + 'Never offer "a fresh worktree from local main": the tool cannot make one.\n\n'
    + 'Allowed:\n'
    + '  • re-attach a branch that already exists → `git worktree add <path> <branch>` (no -b)\n'
    + '  • a task worktree cut from another task\'s unmerged branch, and only from the main checkout (never from inside a worktree) → '
    + '`git worktree add .claude/worktrees/task-<id>-<slug> -b worktree-task-<id>-<slug> <other task\'s branch>` '
    + '(path and branch carry the same name, as EnterWorktree would name them; any base)\n\n'
    + `This command is not that shape: ${why}.`);
}

allow();
