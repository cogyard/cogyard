#!/usr/bin/env node
// cli/tasks.mjs — the cogyard CLI: the single command surface for skills,
// hooks, and humans; the data layer lives in ../core/index.mjs. (Extracted from
// the old ~/.claude engine; every adapter points here now and the old copy is
// dormant. The lockstep rule is OVER: edit only this file.)
//
// Subcommands: sync / projects / next-id / current / analyze /
//              convert / mount / doctor / default-branch / staleness / drift /
//              (no command = help)
//   --backfill            Walk unknown-frontmatter files in $EDITOR

import { execFileSync, execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, lstatSync, realpathSync, unlinkSync, readlinkSync, symlinkSync, cpSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, relative, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_PATH,
  tryExec, execLoud, gitIdentityArgs, gitIdentityFlags, findRepoRoot, findTasksDir, defaultBranchSync,
  loadTasks,
  readRegistry, registerProject, unregisterProject, discoverProjects, makeProjectEntry, findProject,
  gitWorktrees, worktreesForProject,
  inferStatus,
  validateTasks, introducedErrors, taskFromContent, normalizeTaskId,
  closeability, closeableTasks, doneWithLeftovers, markerText, markerProblemsByFile, whoAmI, rewriteStatusLine, isClosed,
  liveParkNotes, describePark, cleanParkReason, writeParkNote, endParkNotes,
  convertToSharedStore, joinSharedStore,
  auditProcess, describeAudit, auditReservedNames, describeReservedNames,
  resolveAxes, axisLookup, registeredLabels,
  resolveSwitches, switchProblems,
  storeHealth, classifyStorePath, taskIdOfPath,
  localClaim, recordReservation, clearReservation, currentSessionId, agentSession,
  currentOwnerTurns, checkOwnerWords,
  TASKS_DIR, locateTasksDir, tasksDirOf, excludeTasksLink,
  planFor, resolveProjectForPath, addTouchesPaths, outsideList, branchChangedFiles, runningClashesFor, branchConflicts,
} from '../core/index.mjs';

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// git with an ARGUMENT LIST — no shell. Anything a caller typed (a commit
// message, a path) reaches git as itself: through a shell, inside the double
// quotes JSON.stringify adds, `$VAR` still expands and backticks or $(…) RUN
// (task 196 — task 187's "moved to $COGYARD_HOME" commits landed as "moved to  ").
// gitQuiet mirrors tryExec (trimmed stdout, null on a non-zero exit); gitLoud
// mirrors execLoud (inherits stdio, throws on failure).
function gitQuiet(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
function gitLoud(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'inherit' });
}

function fail(msg, code = 1) {
  process.stderr.write(`tasks.mjs: ${msg}\n`);
  process.exit(code);
}

// --- Subcommands -------------------------------------------------------------

// Synchronous sleep (no busy loop) — used only to back off while waiting on the
// store lock. Atomics.wait blocks the thread for `ms` without spinning.
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }

// --- Shared-store write lock (task 101) -------------------------------------
// The shared store has ONE working tree, symlinked into the main checkout AND
// every worktree, so two sessions' `sync push` runs race on the SAME git index.
// Serialize the stage→commit→push sequence with an O_EXCL sentinel (the same
// primitive next-id already uses). Non-blocking with a short deadline so a push
// never hangs; a sentinel older than STALE_MS is swept so a holder that crashed
// between lock and release can't wedge every future session.
function withStoreLock(canonical, fn) {
  const lock = join(canonical, '.sync-push.lock');
  const STALE_MS = 60 * 1000;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Sweep a stale lock (crashed holder), else back off and retry to the deadline.
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS) { unlinkSync(lock); continue; } }
      catch { continue; } // lock vanished between EEXIST and stat — loop to grab it
      if (Date.now() > deadline) fail('another `sync push` holds the store lock (waited 5s). Retry shortly.');
      sleepMs(100);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

// The commit gate (task 222): each STAGED task file under `paths`, compared
// with its version in the store's HEAD by core/validate.mjs introducedErrors —
// the same rule the Edit/Write hook applies at an agent's edit. A deletion is
// never refused (that is a cleanup); a new file must be clean. Returns
// [{ file, errors }] for each file that would gain errors, [] when all pass.
function stagedRegressions(canonical, paths) {
  const show = (spec) => {
    try { return execFileSync('git', ['show', spec], { cwd: canonical, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return null; }
  };
  const staged = (gitQuiet(['diff', '--cached', '--name-only', '--relative', '--diff-filter=d', '--', ...paths], canonical) || '')
    .split('\n').filter((rel) => rel && classifyStorePath(rel) === 'task');
  if (!staged.length) return [];
  let all = [];
  try { all = loadTasks(canonical); } catch { all = []; }
  const out = [];
  for (const rel of staged) {
    const abs = join(canonical, rel);
    const now = show(`:./${rel}`);
    if (now == null) continue;
    const was = show(`HEAD:./${rel}`);
    const errors = introducedErrors(all.filter((t) => t.path !== abs),
      was == null ? null : taskFromContent(abs, was), taskFromContent(abs, now));
    if (errors.length) out.push({ file: rel, errors });
  }
  return out;
}

// Split the store's pending files into "mine" (this push should commit them),
// "foreign" (another chat claims them), "unowned" (nobody claims them and this
// chat did not reserve them) and "notTask" (not a task file at all). Only `mine`
// is committed; the rest are reported, never absorbed and never silently
// skipped. Dotfiles (lock sentinels, .git internals) are ignored entirely.
//
// Who owns a file is decided by its task's claim (an attachment `files/<id>/…`
// belongs to task <id>), by SESSION, not branch (task 225): two chats in one
// checkout share a branch, and the branch rule let one chat's push sweep the
// other's edits into its commit.
//   - claimed, session recorded → mine only when it is `me`, the chat pushing.
//     `me` unknown (a human's shell) → foreign: some chat holds it.
//   - claimed, no session recorded (another machine's claim, or one written
//     before claims.json) → the old branch rule: foreign when its named branch
//     is not ours.
//   - unclaimed → mine only when `me` reserved its id with `next-id`; else
//     unowned. A new task file has no claim, so "unclaimed" used to mean
//     "anyone's" and a different chat's push took it. With `me` unknown, an
//     unclaimed file is still the pusher's: the owner at a terminal is not a chat.
function classifyPending(tasksDir, currentBranch, me) {
  // Column-free plumbing: `diff --name-only HEAD` (all uncommitted tracked
  // changes, staged or not) ∪ `ls-files --others` (untracked). Avoids parsing
  // porcelain's XY status columns — tryExec trims output, which would strip the
  // leading space off the first porcelain line and misalign a fixed slice.
  //
  // `--relative` on the diff call matters: git reports diff paths relative to
  // the REPO ROOT, not cwd. That's invisible in the shared-store model (tasksDir
  // IS its own repo root, so root-relative == tasksDir-relative), but breaks the
  // normal-directory model (a task folder inside the project repo) — without
  // it this returns "<folder>/NNN-foo.md" while every caller below (and `git add`/
  // `git commit`, run with cwd: tasksDir) expects tasksDir-relative "NNN-foo.md".
  // `ls-files` doesn't need the flag — it's cwd-relative by default already.
  const changed = tryExec('git diff --name-only --relative HEAD', { cwd: tasksDir }) || '';
  const untracked = tryExec('git ls-files --others --exclude-standard', { cwd: tasksDir }) || '';
  const pending = [...new Set([...changed.split('\n'), ...untracked.split('\n')])]
    .map((p) => p.trim())
    .filter((p) => p && !basename(p).startsWith('.'));
  const taskById = new Map();
  for (const t of loadTasks(tasksDir)) {
    const id = taskIdOfPath(basename(t.path));
    if (id != null) taskById.set(id, { path: t.path, env: (t.frontmatter || {}).env || {} });
  }
  const isSet = (v) => v != null && v !== '' && v !== 'null';
  const mine = [], foreign = [], unowned = [], notTask = [];
  for (const rel of pending) {
    // Only task files, their attachments (files/<id>/…) and the store's
    // allowed files (axes.json, switches.json …) are a session's to commit by default — the same rule the portal's store view
    // flags by (core/store-audit.mjs). Job output (briefs/, heartbeats/,
    // drift.md) and anything else stays pending: it used to be swept into the
    // next "add task" commit under a message that said nothing about it (task
    // 187). An explicit `sync push -- <path>` still commits whatever it names.
    if (!['task', 'attachment', 'allowed'].includes(classifyStorePath(rel))) { notTask.push(rel); continue; }
    const id = taskIdOfPath(rel);
    const task = id != null ? taskById.get(id) : null;
    const env = task ? task.env : {};
    if (isSet(env.claimed_at)) {
      const holder = { path: rel, session: isSet(env.claimed_by_session) ? env.claimed_by_session : null,
        worktree: isSet(env.worktree) ? env.worktree : null, branch: isSet(env.branch) ? env.branch : null };
      const theirs = holder.session
        ? holder.session !== me
        : !!(holder.branch && currentBranch && holder.branch !== currentBranch);
      (theirs ? foreign : mine).push(theirs ? holder : rel);
      continue;
    }
    // Unclaimed. Looked up by store + id, not by a loaded task: a just-reserved
    // file is empty until written, and its attachments may arrive first.
    const reservedBy = id != null ? ((localClaim(join(tasksDir, basename(rel)), id) || {}).reservedBy || null) : null;
    if (!me || reservedBy === me) mine.push(rel);
    else unowned.push({ path: rel, reservedBy });
  }
  return { mine, foreign, unowned, notTask };
}

// Turn one `sync push -- <path>` argument into the store-relative name git
// expects (task 161). git runs with cwd = the store, so only a store-relative or
// absolute path used to work; the repo-relative `.cogyard/tasks/NNN-foo.md` a caller
// naturally types died as a bare `fatal: pathspec`. A relative path is tried
// against each base in turn (the caller's cwd, the repo root, the store itself —
// the last keeps the bare-filename form working) and the first that EXISTS
// decides: inside the store it is used, outside it is refused. Only when no base
// finds the file (a deletion to commit) does the first missing candidate inside
// the store win, resolved through its nearest EXISTING ancestor — the file's
// folder may be gone too (task 196: job output's emptied `briefs/` folder was
// removed with its files, and the deletions could not be named). realpath
// collapses whatever link points at the store, so no link name is hardcoded here.
export function resolveStorePath(p, { canonical, bases }) {
  const real = (abs) => {
    const missing = [];
    for (let dir = abs; ; dir = dirname(dir)) {
      try { return join(realpathSync(dir), ...missing); } catch {}
      if (dirname(dir) === dir) return null;
      missing.unshift(basename(dir));
    }
  };
  const inStore = (abs) => {
    const r = abs && relative(canonical, abs);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r : null;
  };
  const candidates = (isAbsolute(p) ? [p] : bases.map((b) => resolve(b, p)))
    .map(real).filter(Boolean).map((abs) => ({ abs, rel: inStore(abs) }));
  const existing = candidates.find((c) => existsSync(c.abs));
  const hit = existing || candidates.find((c) => c.rel);
  if (!hit || !hit.rel) throw new Error(
    `${p} is not inside the task store (${canonical}). Pass a file in the store: ` +
    'its bare filename, the path `cogyard tasks find` prints, or a path through the ' +
    "project's link to the store.");
  return hit.rel;
}

async function cmdSync(args) {
  const sub = args[0];
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = tasksDirOf(repoRoot);
  if (!existsSync(tasksDir)) fail('no task directory (.cogyard/tasks) — set the project up with `cogyard onboard` first');

  if (sub === 'pull') {
    // Same local-only tolerance as push.
    const remotes = (tryExec('git remote', { cwd: tasksDir }) || '').split('\n');
    if (!remotes.includes('origin')) { process.stdout.write('No remote configured — nothing to pull (local-only).\n'); return; }
    try { execLoud(`git ${gitIdentityFlags(tasksDir)}pull --rebase origin tasks`, { cwd: tasksDir }); }
    catch { fail('pull failed (rebase conflict?). Investigate manually in the task store (`cogyard tasks doctor` shows where it is).'); }
  } else if (sub === 'push') {
    // `sync push "<msg>"` scopes to this session's own pending edits (default),
    // or `sync push "<msg>" -- <path> [<path>...]` to commit exactly named paths.
    const rest = args.slice(1);
    const dashIdx = rest.indexOf('--');
    const message = (dashIdx === -1 ? rest : rest.slice(0, dashIdx)).join(' ')
      || `tasks: update ${new Date().toISOString()}`;
    const canonical = realpathSync(tasksDir);
    // Normalised once, here, so `git add` and `git commit` below both get the
    // store-relative form — they share one pathspec.
    let explicit;
    try {
      explicit = (dashIdx === -1 ? [] : rest.slice(dashIdx + 1))
        .map((p) => resolveStorePath(p, { canonical, bases: [process.cwd(), repoRoot, canonical] }));
    } catch (e) { fail(e.message); }
    // A name inside the store that is neither on disk nor tracked (a typo) would
    // otherwise reach git as a bare `fatal: pathspec`.
    for (const rel of explicit) {
      if (!existsSync(join(canonical, rel)) && gitQuiet(['ls-files', '--error-unmatch', '--', rel], canonical) === null) {
        fail(`${rel} does not exist in the task store (${canonical}) and is not tracked there.`);
      }
    }
    // Naming a path no longer commits anything at all (task 190): a file the
    // store rule does not allow is refused even when named — that is how most of
    // the stray files task 190 cleaned up got in. Its DELETION may still be
    // committed (that is the cleanup), and a folder is judged by what a file
    // inside it would be (`files/179` is a task's attachment folder).
    for (const rel of explicit) {
      const abs = join(canonical, rel);
      if (!existsSync(abs)) continue;
      const probe = statSync(abs).isDirectory() ? `${rel.replace(/\/+$/, '')}/x` : rel;
      if (!['task', 'attachment', 'allowed'].includes(classifyStorePath(probe))) {
        fail(`${rel} is not something a task store holds — a store commits task files (NNN-<slug>.md), ` +
          `axes.json, switches.json, and each task's attachments under files/<task id>/. Move it into the folder of the ` +
          `task it belongs to (git mv in the store), or out of the store. Committing its deletion is allowed.`);
      }
    }
    const currentBranch = tryExec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot }) || '';
    const me = explicit.length ? null : await currentSessionId();
    const remotes = (tryExec('git remote', { cwd: tasksDir }) || '').split('\n');
    const hasTasksBranch = !!tryExec('git rev-parse --verify --quiet refs/heads/tasks', { cwd: tasksDir });
    const remoteBacked = remotes.includes('origin') && hasTasksBranch;
    const identity = gitIdentityFlags(tasksDir);

    const refused = withStoreLock(canonical, () => {
      // Team stores: pull before write so the scoped commit lands on current
      // origin/tasks (mirrors env.mjs's claim path). --autostash tolerates other
      // sessions' pending edits in the shared tree.
      if (remoteBacked) tryExec(`git ${identity}pull --rebase --autostash origin tasks`, { cwd: tasksDir });

      const { mine, foreign, unowned, notTask } = explicit.length
        ? { mine: explicit, foreign: [], unowned: [], notTask: [] }
        : classifyPending(tasksDir, currentBranch, me);
      const reportForeign = () => {
        const who = (f) => [f.session && `session ${f.session}`, f.worktree ? `worktree ${f.worktree}` : f.branch && `branch ${f.branch}`]
          .filter(Boolean).join(', ') || 'another checkout';
        if (foreign.length) process.stdout.write(
          `${foreign.length} file(s) claimed by another chat — left pending, not committed by this push:\n` +
          foreign.map((f) => `  ${f.path} — claimed by ${who(f)}`).join('\n') + '\n');
        if (unowned.length) process.stdout.write(
          `${unowned.length} file(s) left pending — not claimed or reserved by this chat (commit one with \`sync push "<msg>" -- <path>\`):\n` +
          unowned.map((f) => `  ${f.path} — ${f.reservedBy ? `reserved by session ${f.reservedBy}` : 'unclaimed'}`).join('\n') + '\n');
        if (notTask.length) process.stdout.write(
          `${notTask.length} file(s) left pending — not a task file (job output or other; commit one with \`sync push "<msg>" -- <path>\`):\n` +
          notTask.map((f) => `  ${f}`).join('\n') + '\n');
      };

      if (!mine.length) { reportForeign(); if (!foreign.length && !unowned.length) process.stdout.write('Nothing to commit.\n'); return; }

      // Scope BOTH halves: a pathspec-less `git commit` would still absorb
      // whatever another session left staged, so add AND commit take the paths.
      // Argument lists, never a shell string — see gitQuiet.
      gitLoud(['add', '--', ...mine], tasksDir);
      if (gitQuiet(['diff', '--cached', '--quiet', '--', ...mine], tasksDir) !== null) {
        // Non-null (exit 0) => nothing staged for the named paths.
        process.stdout.write('Nothing to commit for this session.\n');
        reportForeign();
        return;
      }
      // The commit gate (task 222): no store commit adds a validator error.
      // The Edit/Write hook sees only an agent's edit tool; a shell or human
      // edit reaches the store only through here. Nothing is committed when
      // any staged task file is refused, and the staging is undone.
      const bad = stagedRegressions(canonical, mine);
      if (bad.length) {
        if (gitQuiet(['reset', '-q', '--', ...mine], tasksDir) === null) gitQuiet(['rm', '-q', '-r', '--cached', '--', ...mine], tasksDir);
        return bad;
      }
      gitLoud([...gitIdentityArgs(tasksDir), 'commit', '-m', message, '--', ...mine], tasksDir);
      reportForeign();

      // Local-only tolerance: push only when the store has an origin AND a tasks
      // branch. Local-only shared stores and normal-dir projects (where the task dir
      // rides the project repo) commit locally + notice — they must NOT fail(),
      // or every skill sync errors on them.
      if (!remoteBacked) {
        const why = !remotes.includes('origin') ? 'no remote configured' : 'no tasks branch (normal-dir project — tasks ride the project repo)';
        process.stdout.write(`Committed locally; skipping push (${why}).\n`);
        return;
      }
      if (tryExec(`git push origin tasks`, { cwd: tasksDir }) === null) {
        process.stdout.write(`Push failed; pulling and retrying...\n`);
        tryExec(`git ${identity}pull --rebase --autostash origin tasks`, { cwd: tasksDir });
        if (tryExec(`git push origin tasks`, { cwd: tasksDir }) === null) fail('push retry failed. Investigate manually in the task store (`cogyard tasks doctor` shows where it is).');
      }
    });
    if (refused?.length) {
      fail(`nothing committed — this commit would add validator errors to ${refused.length} task file(s):\n`
        + refused.map(({ file, errors }) => `  ${file}\n${errors.map((e) => `    • ${e}`).join('\n')}`).join('\n')
        + `\nFix them (\`cogyard tasks validate <id>\` shows each file's errors), then push again. `
        + `Errors a file already had in the store are allowed through — only new ones are refused.`);
    }
  } else {
    fail('usage: tasks.mjs sync pull | tasks.mjs sync push <message> [-- <path>...]');
  }
}

// `labels` — the anti-duplicate reference the write-task skill checks BEFORE
// proposing labels for a new task (task 096). Prints the curated registry (the
// resolved shared + per-project axes) grouped by axis, with how many current
// tasks use each label, then the in-use-but-unregistered labels (the Ungrouped
// candidates that risk spawning synonyms). Read-only — never edits anything; it
// is emphatically NOT a merge/rename "broom" (that stays out of scope).
function cmdLabels(flags) {
  const repoRoot = findRepoRoot();
  const tasksDir = repoRoot ? tasksDirOf(repoRoot) : findTasksDir();
  const axes = resolveAxes(repoRoot);
  const registered = registeredLabels(axes);

  // In-use labels across this project's tasks, with counts.
  const inUse = new Map();
  if (tasksDir && existsSync(tasksDir)) {
    for (const t of loadTasks(tasksDir)) {
      const ls = Array.isArray(t.frontmatter?.labels) ? t.frontmatter.labels : [];
      for (const l of ls) inUse.set(l, (inUse.get(l) || 0) + 1);
    }
  }
  const unregisteredInUse = [...inUse.keys()].filter((l) => !registered.has(l)).sort();

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      axes: axes.map((a) => ({ name: a.name, color: a.color, labels: a.labels })),
      registered: [...registered].sort(),
      inUse: [...inUse.keys()].sort(),
      unregisteredInUse,
    }, null, 2) + '\n');
    return;
  }

  if (!axes.length) {
    process.stdout.write('No axis map ($COGYARD_HOME/axes.json or <repo>/.cogyard/tasks/axes.json). All labels are Ungrouped.\n');
  }
  for (const ax of axes) {
    process.stdout.write(`\n${ax.name}\n`);
    for (const l of ax.labels) {
      const n = inUse.get(l) || 0;
      process.stdout.write(`  ${l}${n ? ` (${n})` : ''}\n`);
    }
  }
  if (unregisteredInUse.length) {
    process.stdout.write('\nUngrouped (in use, not in any axis — reuse one of the above instead of minting a synonym):\n');
    for (const l of unregisteredInUse) process.stdout.write(`  ${l} (${inUse.get(l)})\n`);
  }
}

// `switches` — this project's switches (task 246), resolved: each value from
// <task store>/switches.json, else its default. What the merge-to-main and
// pickup-task skills read; they never read the file, so the defaults live in
// core/switches.mjs only. Read-only.
function cmdSwitches(flags) {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const s = resolveSwitches(repoRoot);
  if (flags.json) { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); return; }
  const tag = (x) => (x.set ? 'set' : 'default');
  const versionText = typeof s.version.value === 'object'
    ? `own command: ${s.version.value.command} (version kept in ${s.version.value.file})`
    : s.version.value;
  process.stdout.write(`rebase   ${s.rebase.value}  (${tag(s.rebase)})\n`);
  process.stdout.write(`version  ${versionText}  (${tag(s.version)})\n`);
  const problems = switchProblems(repoRoot);
  if (problems.length) {
    process.stdout.write('\nIgnored in switches.json:\n');
    for (const p of problems) process.stdout.write(`  ${p}\n`);
  }
  let store = tasksDirOf(repoRoot);
  try { store = realpathSync(store); } catch { /* no store yet: name where it would be */ }
  process.stdout.write(`\nSet in ${join(store, 'switches.json')}, or on the project's settings page.\n`);
}

function cmdProjects(args) {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const projects = readRegistry();
    if (!projects.length) { process.stdout.write('(registry empty — `cogyard init <name>` creates a project, `cogyard onboard [path]` adds an existing one)\n'); return; }
    for (const p of projects) {
      const status = existsSync(tasksDirOf(p.path)) ? '  ' : ' ⚠';
      process.stdout.write(`${status} ${p.slug.padEnd(40)} ${p.path}\n`);
    }
    return;
  }
  if (sub === 'remove') {
    const target = args[1];
    if (!target) fail('usage: tasks.mjs projects remove <slug-or-path>');
    const removed = unregisterProject(target);
    if (removed) process.stdout.write(`Removed ${removed} entry from registry.\n`);
    else process.stdout.write('Not in registry.\n');
    return;
  }
  if (sub === 'register') {
    const repoRoot = findRepoRoot();
    if (!repoRoot) fail('not in a git repo');
    const entry = registerProject(repoRoot);
    process.stdout.write(`Registered: ${entry.slug} -> ${entry.path}\n`);
    return;
  }
  fail('usage: tasks.mjs projects [list | remove <slug> | register]');
}

// --- The task store: convert · mount · doctor ------------------
// convert: give a project its own store repo (branch `tasks`) — adopting an
// in-repo `_tasks/` folder if it has one, else empty — and an ABSOLUTE symlink, so every
// git worktree of the project shares one store through its .cogyard/tasks link (mounted via `mount`).
// Absolute because worktrees are not siblings of the main checkout, so a
// relative link would not resolve from inside one. Copy-first: originals are never removed
// until the copy is verified file-by-file.
//
// The conversion logic itself lives in core/scaffold.mjs (convertToSharedStore),
// so `cogyard init`/`onboard` and this command share ONE implementation.

function cmdConvert(flags) {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  let r;
  try {
    r = convertToSharedStore({
      repoRoot, store: flags.store, remote: flags.remote,
      log: (m) => process.stdout.write(m + '\n'),
    });
  } catch (e) { fail(e.message); }
  if (!r.converted && r.reason === 'already-symlink') {
    process.stdout.write(`The task directory is already a link → ${r.store} (shared store). Nothing to do.\n`);
    return;
  }
  process.stdout.write(`\nConverted. ${TASKS_DIR} → ${r.store} (branch tasks). Worktrees: run \`cogyard tasks mount\` inside each (the SessionStart hook does this automatically).\n`);
}

// join: member-#2 onboarding for a TEAM store. The lead ran
// `convert --remote <url>`; a fresh clone of the project repo has a dangling
// gitignored task link. This clones the store, mounts .cogyard/tasks,
// registers the project, then runs the doctor audit so the result is verified.
function cmdJoin(flags, positional) {
  const remote = positional[1];
  if (!remote) fail('usage: tasks.mjs join <remote-url> [--slug <s>] [--store <path>]');
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  let r;
  try {
    r = joinSharedStore({
      repoRoot, remote, store: flags.store, slug: flags.slug,
      log: (m) => process.stdout.write(m + '\n'),
    });
  } catch (e) { fail(e.message); }
  process.stdout.write(`\nJoined: ${r.slug} — task link → ${r.store}. Doctor audit:\n\n`);
  cmdDoctor();
}

// mount: give a worktree the same link to the store its main checkout has. The
// worktree's link always takes the new name `.cogyard/tasks` (task 160),
// whichever name the main checkout still uses. A worktree whose branch predates
// the project's `.cogyard/.gitignore` would show that link as untracked, so the
// worktree-shared `info/exclude` covers it whenever the checkout does not.
function cmdMount() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const found = locateTasksDir(repoRoot);
  if (found) {
    const name = relative(repoRoot, found.path);
    if (lstatSync(found.path).isSymbolicLink() && !existsSync(found.path)) {
      fail(`${name} is a BROKEN symlink → ${readlinkSync(found.path)} — fix or remove it, then re-run mount`);
    }
    process.stdout.write(`${name} already present — nothing to mount.\n`);
    return;
  }
  const raw = tryExec('git worktree list --porcelain', { cwd: repoRoot });
  const mainPath = (raw || '').split('\n').find((x) => x.startsWith('worktree '))?.slice('worktree '.length);
  if (!mainPath) fail('cannot determine the main worktree');
  if (resolve(mainPath) === resolve(repoRoot)) {
    process.stdout.write('This is the main worktree and it has no task directory — run `cogyard onboard` here.\n');
    return;
  }
  const base = locateTasksDir(mainPath);
  if (!base) { process.stdout.write(`Base worktree (${mainPath}) has no task directory — nothing to mount.\n`); return; }
  const baseName = relative(mainPath, base.path);
  if (!lstatSync(base.path).isSymbolicLink()) { process.stdout.write(`Base ${baseName} is a folder, not a link to a task store — nothing to mount. Fix the main checkout first (\`cogyard tasks doctor\` names it).\n`); return; }
  const target = readlinkSync(base.path);
  // The link must be absolute: a worktree is not a sibling of the main
  // checkout, so a relative target means something else from inside one.
  // cogyard only ever writes absolute links (task 169 removed the tolerance).
  if (!isAbsolute(target)) {
    const abs = resolve(dirname(base.path), target);
    fail(`base ${baseName} is a relative link (→ ${target}); cogyard needs an absolute one. In ${mainPath}, replace it:\n  ln -sfn ${JSON.stringify(abs)} ${TASKS_DIR}\nthen re-run mount`);
  }
  if (!existsSync(target)) fail(`base ${baseName} symlink is broken → ${target} — fix the store before mounting`);
  const linkPath = join(repoRoot, TASKS_DIR);
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
  if (gitQuiet(['check-ignore', '-q', TASKS_DIR], repoRoot) === null) {
    const common = gitQuiet(['rev-parse', '--git-common-dir'], repoRoot);
    if (common) excludeTasksLink(resolve(repoRoot, common));
  }
  process.stdout.write(`Mounted ${TASKS_DIR} → ${target}\n`);
}

function cmdDoctor() {
  // Renderer only — the report itself is core/store-health.mjs, so the portal's
  // GET /api/storage answers from the same code that prints this table (task 132).
  const { rows, drift } = storeHealth();
  if (!rows.length) { process.stdout.write('(registry empty)\n'); return; }

  // A working link reports mounted-of-total (an unmounted worktree cannot see
  // the store at all); anything else just counts worktrees.
  const wtCell = (r) => !r.worktrees ? '—'
    : r.link.state === 'ok' ? `${r.worktrees.mounted}/${r.worktrees.total} mounted`
    : `${r.worktrees.total}`;

  // LINK: the project's task link — ok / broken / missing / folder (task 169).
  const W = { slug: 28, link: 8, store: 52, remote: 11, wt: 14 };
  process.stdout.write(['PROJECT'.padEnd(W.slug), 'LINK'.padEnd(W.link), 'STORE'.padEnd(W.store), 'REMOTE'.padEnd(W.remote), 'WORKTREES'.padEnd(W.wt), 'FLAGS'].join('') + '\n');
  for (const r of rows) {
    process.stdout.write([
      r.slug.padEnd(W.slug), r.link.state.padEnd(W.link),
      String(r.storePath).padEnd(W.store), r.remote.padEnd(W.remote), wtCell(r).padEnd(W.wt),
      r.flags.length ? r.flags.join('; ') : 'ok',
    ].join('') + '\n');
  }

  // Schema drift — a storage audit should also surface frontmatter the validator
  // rejects. Compact: one line per project, error files listed (run `validate`
  // for the full per-file detail incl. warnings).
  process.stdout.write('\nSchema drift (run `tasks.mjs validate [--all]` for detail):\n');
  for (const d of drift.projects) {
    const flag = d.errorCount ? '✗' : d.warningCount ? '⚠' : '✓';
    process.stdout.write(`  ${flag} ${d.slug.padEnd(26)} ${d.errorCount} error(s), ${d.warningCount} warning(s)\n`);
    for (const f of d.errorFiles) {
      process.stdout.write(`      ${f.file}: ${f.errors.join('; ')}\n`);
    }
  }
  process.stdout.write(`  ${drift.totalErrors ? '✗' : '✓'} ${drift.totalErrors} schema error(s) total.\n`);

  // Finished work still sitting OPEN (task 171). Listed, never closed: the
  // owner decides, then runs the command printed beside each one.
  const ready = closeableTasks();
  process.stdout.write(`\nLook closeable — every box ticked or settled, branch merged or none, claim yours or free (${ready.length}):\n`);
  if (!ready.length) process.stdout.write('  (none)\n');
  const mergeNote = { merged: 'merged', 'no-branch': 'no branch', 'no-commits': 'branch had no commits' };
  for (const r of ready) {
    const s = r.boxes.settled;
    const settled = Object.entries(s).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
    process.stdout.write(`  ${r.slug}#${r.id}  ${r.title}\n      ${r.boxes.done}/${r.boxes.counted} ticked${settled ? `, ${settled}` : ''}; ${mergeNote[r.merge.state] || r.merge.state}` +
      ` — to close: cd ${r.path} && cogyard tasks close ${r.id}\n`);
  }

  // DONE tasks that still hold open boxes (task 238). DONE means nothing is left
  // to see: each box is ticked, (dropped: why) or (moved: <id>), or the task is
  // really ENOUGH. One line per project; under it, the boxes that already say in
  // prose how they were settled, with the marker that prose reads as, and the
  // tasks whose leftovers are already marked (optional) — those are
  // the owner's to reopen and close as ENOUGH. The rest are the owner's call.
  const leftover = doneWithLeftovers();
  const boxes = leftover.reduce((n, r) => n + r.open.length, 0);
  process.stdout.write(`\nDONE but still holding open boxes — tick or mark each (dropped: why) / (moved: <id>), or reopen and close as ENOUGH (${leftover.length} task(s), ${boxes} box(es)):\n`);
  if (!leftover.length) process.stdout.write('  (none)\n');
  const bySlug = new Map();
  for (const r of leftover) bySlug.set(r.slug, [...(bySlug.get(r.slug) || []), r]);
  for (const [slug, rows] of bySlug) {
    const n = rows.reduce((a, r) => a + r.open.length, 0);
    const proposed = rows.flatMap((r) => r.open.filter((o) => o.proposal).map((o) => ({ r, o })));
    const marked = rows.filter((r) => r.open.some((o) => o.kind));
    process.stdout.write(`  ${slug.padEnd(28)} ${rows.length} task(s), ${n} box(es)${proposed.length ? `, ${proposed.length} already say how they were settled:` : ''}\n`);
    for (const { r, o } of proposed) {
      const text = o.text.length > 70 ? o.text.slice(0, 67) + '…' : o.text;
      process.stdout.write(`      #${r.id}  ${markerText(o.proposal).padEnd(28)} ${text}\n`);
    }
    if (marked.length) process.stdout.write(`      leftovers already marked (optional) — ENOUGH, not DONE: ${marked.map((r) => `#${r.id}`).join(', ')}\n`);
  }
  // A project's own merge or commit process beside cogyard's skill (task 133):
  // a doc no skill reads, a project skill named like cogyard's (it never runs,
  // or runs beside it), or a replacing skill older than cogyard's last change.
  // Every registered project's main checkout, so projects onboarded before the
  // check existed are audited too. Reported, never fixed: the owner decides.
  // Also every project command a cogyard skill or command hides, and any of
  // cogyard's names the agent keeps for a built-in command (task 218) — so
  // this one section lists every name clash.
  const procRows = [];
  try {
    const lines = describeReservedNames(auditReservedNames());
    if (lines.length) procRows.push({ slug: '(this machine)', lines });
  } catch (e) { procRows.push({ slug: '(this machine)', lines: [`could not check built-in names: ${e.message}`] }); }
  for (const p of readRegistry()) {
    if (!p.path || !existsSync(p.path)) continue;
    let lines;
    try { lines = describeAudit(auditProcess(p.path, { slug: p.slug })); } catch (e) { lines = [`could not audit: ${e.message}`]; }
    if (lines.length) procRows.push({ slug: p.slug, lines });
  }
  const procCount = procRows.reduce((n, r) => n + r.lines.length, 0);
  process.stdout.write(`\nProcess docs, project skills and commands, name clashes — one process, one place (docs/PROJECT-INIT.md) (${procRows.length} project(s), ${procCount} finding(s)):\n`);
  if (!procRows.length) process.stdout.write('  (none)\n');
  for (const r of procRows) {
    process.stdout.write(`  ⚠ ${r.slug}\n`);
    for (const l of r.lines) process.stdout.write(`      ${l}\n`);
  }
}

// --- Next-id picker (atomic, race-safe across checkouts sharing a store) ----

async function cmdNextId(slug) {
  if (!slug || /^[0-9]/.test(slug)) fail('usage: tasks.mjs next-id <slug>   (slug: kebab-case, no leading digit)');
  // Which chat reserved the id (task 225): a plain `sync push` from any other
  // chat leaves the new file alone until it is claimed or named.
  const me = await currentSessionId();
  const cleanSlug = String(slug).replace(/[^a-zA-Z0-9._-]/g, '-');
  const repoRoot = findRepoRoot();
  const localTasksDir = repoRoot ? tasksDirOf(repoRoot) : findTasksDir();
  if (!localTasksDir || !existsSync(localTasksDir)) fail('no task directory found (.cogyard/tasks)');
  // Resolve to canonical so every checkout of the store serializes on the same dir via O_EXCL.
  let canonical;
  try { canonical = realpathSync(localTasksDir); } catch { canonical = localTasksDir; }

  // Team stores: the O_EXCL sentinel serializes same-machine callers
  // only — two MACHINES cloning the same store can both reserve the same id. When
  // the store is remote-backed (origin + tasks branch), sync with the remote:
  // pull before scanning, then commit+push the reservation (re-allocating on a
  // clash a competitor pushed first). Local-only stores skip all of this.
  const storeRemotes = (tryExec('git remote', { cwd: canonical }) || '').split('\n');
  const remoteBacked = storeRemotes.includes('origin')
    && !!tryExec('git rev-parse --verify --quiet refs/heads/tasks', { cwd: canonical });
  if (remoteBacked) tryExec(`git ${gitIdentityFlags(canonical)}pull --rebase --autostash origin tasks`, { cwd: canonical });

  // Sweep stale sentinels: a `.id-NNN.lock` older than 5 min is considered abandoned
  // (the creator process crashed between locking and writing the real file). Without
  // this sweep, a single crash burns an id forever.
  const STALE_LOCK_MS = 5 * 60 * 1000;
  for (const f of readdirSync(canonical)) {
    if (!/^\.id-\d+\.lock$/.test(f)) continue;
    const p = join(canonical, f);
    try {
      const st = statSync(p);
      if (Date.now() - st.mtimeMs > STALE_LOCK_MS) unlinkSync(p);
    } catch { /* ignore */ }
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const files = readdirSync(canonical);
    const idsInUse = new Set();
    for (const f of files) {
      let m = f.match(/^(\d+)/);
      if (m) idsInUse.add(parseInt(m[1], 10));
      m = f.match(/^\.id-(\d+)\.lock$/);
      if (m) idsInUse.add(parseInt(m[1], 10));
    }
    let maxId = 0;
    for (const id of idsInUse) if (id > maxId) maxId = id;
    const nextId = maxId + 1;
    const padded = String(nextId).padStart(3, '0');
    const sentinel = join(canonical, `.id-${padded}.lock`);
    try {
      writeFileSync(sentinel, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    const filename = `${padded}-${cleanSlug}.md`;
    const filepath = join(canonical, filename);
    try {
      writeFileSync(filepath, '', { flag: 'wx' });
    } catch (e) {
      try { unlinkSync(sentinel); } catch {}
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try { unlinkSync(sentinel); } catch {}
    if (!remoteBacked) {
      recordReservation(filepath, me);
      process.stdout.write(JSON.stringify({ id: nextId, padded, file: filepath, canonical }) + '\n');
      return;
    }
    publishReservation(canonical, cleanSlug, nextId, me);
    return;
  }
  fail('next-id: too many collisions (gave up after 100 attempts)');
}

// Remote-backed reservation: commit the placeholder and push it,
// re-allocating the id when a competitor's file arrives with the same number.
// Offline is tolerated: the reservation stays as a local commit (a warning says
// so) and the next `sync push` publishes it — never block task creation.
function publishReservation(canonical, cleanSlug, id, me) {
  const scanIds = (excludeFile) => {
    const used = new Set();
    for (const f of readdirSync(canonical)) {
      if (f === excludeFile) continue;
      const m = f.match(/^(\d+)/) || f.match(/^\.id-(\d+)\.lock$/);
      if (m) used.add(parseInt(m[1], 10));
    }
    return used;
  };
  let padded = String(id).padStart(3, '0');
  let filename = `${padded}-${cleanSlug}.md`;
  const msg = () => `reserve id ${padded} (${cleanSlug})`;
  const identity = gitIdentityFlags(canonical);
  tryExec(`git add -- ${JSON.stringify(filename)}`, { cwd: canonical });
  tryExec(`git ${identity}commit -m ${JSON.stringify(msg())} -- ${JSON.stringify(filename)}`, { cwd: canonical });
  let pushed = false;
  for (let i = 0; i < 20; i++) {
    // A competitor's same-id file may have arrived on the last pull — even when
    // our push WOULD succeed (different filenames never conflict in git, which
    // is exactly how silent duplicate ids happen). Re-id before pushing.
    if (scanIds(filename).has(id)) {
      const used = scanIds(filename);
      let next = id;
      while (used.has(next)) next++;
      const newPadded = String(next).padStart(3, '0');
      const newFilename = `${newPadded}-${cleanSlug}.md`;
      tryExec(`git mv ${JSON.stringify(filename)} ${JSON.stringify(newFilename)}`, { cwd: canonical });
      const oldFilename = filename;
      id = next; padded = newPadded; filename = newFilename;
      // Both names, so the rename is recorded — and ONLY them (task 225): a
      // pathspec-less amend would also take whatever another chat has staged
      // in this shared store.
      gitQuiet([...gitIdentityArgs(canonical), 'commit', '--amend', '-m', msg(), '--', oldFilename, newFilename], canonical);
      continue; // re-check before pushing (mv target could clash again after another pull)
    }
    if (tryExec('git push origin tasks', { cwd: canonical }) !== null) { pushed = true; break; }
    if (tryExec(`git ${identity}pull --rebase --autostash origin tasks`, { cwd: canonical }) === null) break; // offline/unreachable
  }
  if (!pushed) process.stderr.write('tasks.mjs: warning — id reserved locally but not pushed (remote unreachable?); it publishes on the next sync push\n');
  recordReservation(join(canonical, filename), me); // the FINAL id, after any re-numbering
  process.stdout.write(JSON.stringify({ id, padded, file: join(canonical, filename), canonical, pushed }) + '\n');
}

// --- Currently-claimed task (used by the /commit skill to tag commits) -------

function cmdCurrent() {
  const repoRoot = findRepoRoot();
  const tasksDir = repoRoot ? tasksDirOf(repoRoot) : findTasksDir();
  if (!tasksDir || !existsSync(tasksDir)) {
    process.stdout.write(JSON.stringify({ count: 0, tasks: [] }) + '\n');
    return;
  }
  const tasks = loadTasks(tasksDir);
  const claimed = tasks
    .map((t) => {
      const fm = t.frontmatter || {};
      const env = fm.env || {};
      const claimedAt = env.claimed_at;
      // Treat `null` (YAML null parsed as JS null) and the literal string 'null' as unclaimed.
      if (!claimedAt || claimedAt === 'null') return null;
      // A claim counts only on an OPEN task (task 222) — the same set as the
      // plan's "In progress". A claim left on a closed or parked task is a
      // validator error (`tasks validate`), not work in progress.
      if (fm.status !== 'OPEN') return null;
      return {
        id: fm.id != null ? fm.id : null,
        file: basename(t.path),
        claimed_at: claimedAt,
        claimed_by: env.claimed_by || null,
        claimed_by_session: env.claimed_by_session || null,
      };
    })
    .filter(Boolean);
  // Most-recently-claimed first
  claimed.sort((a, b) => String(b.claimed_at).localeCompare(String(a.claimed_at)));
  process.stdout.write(JSON.stringify({ count: claimed.length, tasks: claimed }) + '\n');
}

// --- Default-branch-aware git gates (skills call these instead of hardcoding
// `..main`, so a master repo Just Works and there is no branch name to interpret).

// Print the repo's default branch (main/master) — the name skills capture into a
// variable so the merge flow targets the right trunk without hardcoding it.
// Prints nothing and exits 1 when there is no main/master.
function cmdDefaultBranch() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const base = defaultBranchSync(repoRoot);
  if (!base) process.exit(1);
  process.stdout.write(base + '\n');
}

// The FRESHEST trunk ref to compare a checkout against. Local `main` is only as
// current as the last pull — another worktree or clone can push origin/main and
// leave THIS repo's local main behind, so comparing against the local branch
// under-reports staleness. When an `origin` remote exists we fetch the base
// branch (non-destructive: `git fetch` updates the remote-tracking ref only,
// never the working tree or local branch) and compare against `origin/<base>`.
// Falls back to the local branch when there's no remote, and reports `stale:
// true` when we wanted origin but the fetch failed (offline) so callers can warn
// rather than silently trust a possibly-behind remote-tracking ref.
function freshBaseRef(repoRoot, base) {
  const hasOrigin = (tryExec('git remote', { cwd: repoRoot }) || '').split('\n').includes('origin');
  if (!hasOrigin) return { ref: base, scope: 'local', stale: false };
  const fetched = tryExec(`git fetch --quiet origin ${base}`, { cwd: repoRoot }) != null;
  const hasRemoteRef = tryExec(`git rev-parse --verify --quiet refs/remotes/origin/${base}`, { cwd: repoRoot }) != null;
  if (!hasRemoteRef) return { ref: base, scope: 'local', stale: !fetched };
  return { ref: `origin/${base}`, scope: 'remote', stale: !fetched };
}

// Staleness gate: is this checkout behind the repo's (fetched) default branch?
// Prints a human line and exits 1 when behind (so a skill can gate on the exit
// code), 0 when up to date or when there's no main/master to compare against.
function cmdStaleness() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const base = defaultBranchSync(repoRoot);
  if (!base) { process.stdout.write('no main/master branch — staleness check skipped\n'); process.exit(0); }
  const { ref, stale } = freshBaseRef(repoRoot, base);
  if (stale) process.stdout.write(`⚠ could not fetch origin/${base} (offline?) — comparing against possibly-stale ${ref}\n`);
  const behind = tryExec(`git log --oneline HEAD..${ref}`, { cwd: repoRoot });
  if (!behind) { process.stdout.write(`up to date with ${ref}\n`); process.exit(0); }
  const n = behind.split('\n').filter(Boolean).length;
  process.stdout.write(`${n} commit${n === 1 ? '' : 's'} behind ${ref}:\n${behind}\n`);
  process.exit(1);
}

// The one place an id/filename/slug turns into an actual task file. Every
// command that takes a task reference (find, drift, ...) goes through this —
// so "how do I look up a task" always has ONE true answer, not a filename
// convention in a skill doc that can drift from what the code really does.
// Zero-padding is NOT part of a task's identity: `033`, `33`, and `_tasks/33-x.md`
// all name the same task, and stores disagree on which spelling they write into
// frontmatter. Every numeric comparison here goes through normalizeTaskId, and the
// filename's own id token counts as a match, so a leading zero can never be the
// reason a lookup fails.
//
// Exported for test/task-lookup.test.mjs. The CLI dispatch below is behind an
// __isCLI guard, so importing this module runs no commands.
export function resolveTask(tasksDir, idArg) {
  const want = String(idArg).replace(/\.md$/, '');
  const wantId = normalizeTaskId(want);
  return loadTasks(tasksDir).find((t) => {
    const fm = t.frontmatter || {};
    const stem = basename(t.path).replace(/\.md$/, '');
    if (stem === want || String(fm.slug) === want) return true;
    if (wantId == null) return false;
    if (normalizeTaskId(fm.id) === wantId) return true;
    const m = stem.match(/^(\d+(?:[._]\d+)?[a-z]?)(?:-|$)/);
    return m != null && normalizeTaskId(m[1]) === wantId;
  });
}

// find: resolve an id/filename/slug to its file path. The lookup primitive
// other tooling (and the pickup-task skill) should call instead of guessing
// `.cogyard/tasks/NNN-<slug>.md`.
//
// The path is the REAL one — through the task link to the shared store, not
// `<repo>/.cogyard/tasks/…` (task 158). Sessions edit whatever path this prints, and
// Claude Code treats a write whose link resolves outside the working directory
// as out of bounds: a permission prompt in the main checkout, a hard refusal in
// a worktree.
// Exported for test/task-lookup.test.mjs.
export function findTaskFile(repoRoot, idArg) {
  const task = resolveTask(tasksDirOf(repoRoot), idArg);
  return task ? realpathSync(task.path) : null;
}

function cmdFind(idArg) {
  if (!idArg) fail('usage: tasks.mjs find <task-id-or-file-or-slug>');
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  if (!existsSync(tasksDirOf(repoRoot))) fail('no task directory in this repo (.cogyard/tasks)');
  const file = findTaskFile(repoRoot, idArg);
  if (!file) fail(`task not found: ${idArg}`);
  process.stdout.write(file + '\n');
}

// Drift gate: commits on the (fetched) default branch touching a task's
// `touches_paths` since its `last_reviewed_at_commit`. Prints the offending
// commits (empty = no drift). Resolves the branch internally — no `..main` in
// the skill prose — and compares against origin so a push from another worktree
// is seen even before this checkout pulls.
function cmdDrift(idArg) {
  if (!idArg) fail('usage: tasks.mjs drift <task-id-or-file>');
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = tasksDirOf(repoRoot);
  if (!existsSync(tasksDir)) fail('no task directory in this repo (.cogyard/tasks)');
  // A file argument is usually the full path `find` printed (task 158) —
  // resolve it by its filename, since that path may be the store's, not the link's.
  const task = resolveTask(tasksDir, basename(idArg));
  if (!task) fail(`task not found: ${idArg}`);
  const fm = task.frontmatter || {};
  const since = fm.last_reviewed_at_commit;
  if (!since || since === 'null') { process.stdout.write('no last_reviewed_at_commit — drift check skipped\n'); process.exit(0); }
  const base = defaultBranchSync(repoRoot);
  if (!base) { process.stdout.write('no main/master branch — drift check skipped\n'); process.exit(0); }
  const { ref, stale } = freshBaseRef(repoRoot, base);
  if (stale) process.stdout.write(`⚠ could not fetch origin/${base} (offline?) — comparing against possibly-stale ${ref}\n`);
  const paths = Array.isArray(fm.touches_paths) ? fm.touches_paths.filter(Boolean) : [];
  const pathArg = paths.length ? ' -- ' + paths.map((p) => JSON.stringify(p)).join(' ') : '';
  const drift = tryExec(`git log --oneline ${since}..${ref}${pathArg}`, { cwd: repoRoot });
  if (!drift) { process.stdout.write(`no drift on ${ref} since ${String(since).slice(0, 8)}\n`); process.exit(0); }
  process.stdout.write(`drift on ${ref} since ${String(since).slice(0, 8)}${paths.length ? ' (over touches_paths)' : ''}:\n${drift}\n`);
  process.exit(1);
}

// --- Close (task 171) ----------------------------------------------------------
// The three steps /merge-to-main used to describe in prose, as one command:
// status + done_date, release the claim, commit. Whether the task MAY close is
// core/close.mjs's call (the same rule `tasks doctor` suggests from); this only
// runs when the owner types it — cogyard never closes a task on its own.

// Set (or insert after `status:`) one top-level frontmatter key, leaving every
// other line exactly as written.
function setTopLevelKey(fmText, key, value) {
  const lines = fmText.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^${key}:(\\s|$)`).test(l));
  if (i !== -1) { lines[i] = `${key}: ${value}`; return lines.join('\n'); }
  const at = lines.findIndex((l) => /^status:(\s|$)/.test(l));
  lines.splice(at === -1 ? lines.length : at + 1, 0, `${key}: ${value}`);
  return lines.join('\n');
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The owner's own calls (task 228). Overruling a refused close overrides the
// owner's sign-off, so an agent may not do it on its own judgment — the same
// way `cogyard publish` refuses (task 170). Asked of EVERY driver, not the
// active one: whether an agent started this process is a fact about the
// process, not a setting.
//
// But the owner TELLING the agent to run it counts as the owner running it
// (task 237). The agent passes the owner's exact words (`--asked "…"`); they
// must be in a message the owner typed in this chat and say "close" plus
// `word` ("enough" / "done") — core/owner-words.mjs. Returns null for the
// owner's own shell, or the quote the agent was cleared on; refuses otherwise.
async function ownerOnly(what, repoRoot, command, { word, asked }) {
  const said = await currentOwnerTurns();
  if (!said.agent) return null;
  const check = asked === undefined
    ? { ok: false, reason: null }
    : checkOwnerWords({ quote: asked, word, turns: said.turns });
  if (check.ok) return String(asked);
  process.stderr.write(
    `${what} is the owner's call, and this was started by ${said.agent}. Nothing changed.\n`
    + (check.reason ? `Not cleared by the owner's words: ${check.reason}.\n` : '')
    + `If the owner told you to in this chat, run it again with their exact words: --asked "<what they typed>" `
    + `(their words must say "close" and "${word}"). Otherwise hand the owner this command to run from their own terminal:\n\n`
    + `  cd ${repoRoot} && ${command}\n`);
  process.exit(1);
}

// Resolve <id-or-file> to a task with frontmatter in this repo's task directory.
function taskForStatusChange(idArg, usage) {
  if (!idArg) fail(usage);
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = tasksDirOf(repoRoot);
  if (!existsSync(tasksDir)) fail('no task directory in this repo (.cogyard/tasks)');
  const task = resolveTask(tasksDir, basename(idArg));
  if (!task) fail(`task not found: ${idArg}`);
  if (!task.hasFrontmatter) fail(`${basename(task.path)} has no frontmatter`);
  return { repoRoot, task, abs: realpathSync(task.path), id: task.frontmatter.id };
}

// Write status + done_date (+ the body's status line) atomically. Returns the
// file's previous contents, so a later step that fails can put it back.
// `doneDate` undefined leaves done_date as written; `editBody` (task 244) is
// applied to the body before the status line is rewritten — park and unpark
// write their note through it.
function writeStatus(abs, status, doneDate, editBody = (b) => b) {
  const before = readFileSync(abs, 'utf8');
  const end = before.indexOf('\n---\n', 4);
  if (!before.startsWith('---\n') || end === -1) fail(`${basename(abs)} frontmatter not terminated`);
  let fm = setTopLevelKey(before.slice(4, end), 'status', status);
  if (doneDate !== undefined) fm = setTopLevelKey(fm, 'done_date', doneDate);
  const tmp = `${abs}.status-${process.pid}.tmp`;
  writeFileSync(tmp, `---\n${fm}\n---\n${rewriteStatusLine(editBody(before.slice(end + 5)), status)}`);
  renameSync(tmp, abs);
  return before;
}

async function cmdClose(idArg, flags) {
  const { repoRoot, task, abs, id } = taskForStatusChange(idArg, 'usage: tasks.mjs close <task-id-or-file> [--enough] [--force]');
  const target = flags.enough ? 'ENOUGH' : 'DONE';
  let ownerSaid = null;
  if (flags.enough || flags.force) {
    const flagText = [flags.enough && '--enough', flags.force && '--force'].filter(Boolean).join(' ');
    ownerSaid = await ownerOnly(`Closing #${id} with ${flagText}`, repoRoot, `cogyard tasks close ${id} ${flagText}`,
      { word: flags.enough ? 'enough' : 'done', asked: flags.asked });
  }

  // Badly written checkbox markers (task 238) block a close: checked against
  // the whole project, so a (moved: <id>) to a missing task counts.
  const markerProblems = markerProblemsByFile(loadTasks(tasksDirOf(repoRoot))).get(basename(task.path)) || [];
  const v = closeability(task, { repoRoot, me: whoAmI(repoRoot), markerProblems });
  if (v.alreadyClosed) {
    fail(`#${id} is already ${v.status}.`
      + (['DONE', 'ENOUGH'].includes(v.status) ? ` To undo that close: cogyard tasks reopen ${id} --why "<reason>"` : ''));
  }
  // A live park (task 244) refuses every form of close, --force included: a
  // closed task keeps only an ended park record. Nothing is written.
  if (v.park.live) {
    fail(`Not closing #${id}: ${v.park.reason}. `
      + `A closed task keeps only an ended park record, so --enough and --force don't override this. `
      + `Never set the status by hand to get past it.`);
  }
  const verdict = flags.enough ? v.enough : v.done;
  if (!verdict.ok && !flags.force) {
    process.stderr.write(`Not closing #${id} as ${target}:\n${verdict.reasons.map((r) => `  - ${r}`).join('\n')}\n`);
    // Only after-merge checks left (task 232): the agent's own work, so no
    // owner flags are offered — run them, tick them, close again.
    if (!flags.enough && v.done.onlyAfterMerge) {
      process.stderr.write(`Run each (after merge) check now, tick it with what you saw, then run \`cogyard tasks close ${id}\` again. This is not a question for the owner.\n`);
      process.exit(1);
    }
    // An agent is told to report, not to ask (task 236): the override flags are
    // the owner's, and offering ENOUGH at every refusal made it the normal way a
    // task closed. The owner, typing the command themself, still gets the hints.
    if (await agentSession()) {
      process.stderr.write(`Leave #${id} OPEN with its claim and tell the owner what's left. Don't ask them anything, and don't offer --enough or --force.\n`);
      process.exit(1);
    }
    const hints = [];
    if (!flags.enough && v.enough.ok) hints.push('`--enough` closes it as ENOUGH (partly done; the open and (optional) boxes are the leftovers you chose to leave)');
    hints.push(`\`--force\` closes it as ${target} anyway`);
    process.stderr.write(`Mark settled boxes (dropped: why) / (moved: <id>), or: ${hints.join('; ')}.\n`);
    process.exit(1);
  }

  // 1. status + done_date. Kept so a failed release can put the file back —
  //    a task closed but still claimed is exactly the half-close this replaces.
  const before = writeStatus(abs, target, localDate());

  // 2. Release through `env release` — the one place a claim is cleared (it also
  //    closes the claims-ledger window). --no-commit: the release is committed
  //    with the status change in step 3, as one "close #N" commit.
  if (v.claim.state !== 'none') {
    try { execFileSync(process.execPath, [join(SCRIPT_DIR, 'env.mjs'), 'release', abs, '--no-commit'], { stdio: ['ignore', 'ignore', 'inherit'] }); }
    catch { writeFileSync(abs, before); fail(`releasing the claim failed — #${id} left as it was (${v.status}, still claimed).`); }
  }

  // 3. Commit (and push, on a team store) the task file.
  const forced = !verdict.ok ? ' (--force)' : '';
  const told = ownerSaid ? ` — owner said: "${ownerSaid.replace(/\s+/g, ' ').trim()}"` : '';
  await cmdSync(['push', `close #${id} as ${target}${forced}${told}`, '--', abs]);
  // 4. The id reservation `next-id` recorded is spent: nothing about a closed
  //    task is left for the reserving chat's unnamed `sync push` to commit.
  try { clearReservation(abs, id); } catch { /* claims.json busy — the record is advisory */ }
  process.stdout.write(`#${id} closed as ${target} (done_date ${localDate()})${v.claim.state !== 'none' ? ', claim released' : ''}.\n`);
}

// --- Reopen (task 228) ---------------------------------------------------------
// The way back from a close: DONE or ENOUGH → OPEN, done_date cleared, the
// body's status line rewritten, committed through `sync push`. Before this
// existed, `close` refusing an already-closed task left a hand edit or raw git
// in the store as the only way to undo a wrong close — and that is what an
// agent did. Open to agents (task 237): reopening only makes a task LESS done,
// and the owner decided it follows from context — more work that belongs to a
// closed task reopens it, through pickup-task. The commit says why and, when
// an agent ran it, which chat. It does not claim the task; whoever works it
// next claims it as usual.
async function cmdReopen(idArg, flags = {}) {
  const { abs, id, task } = taskForStatusChange(idArg, 'usage: tasks.mjs reopen <task-id-or-file> [--why "<reason>"]');
  const was = task.frontmatter.status;
  if (!['DONE', 'ENOUGH'].includes(was)) fail(`#${id} is ${was || 'missing a status'} — reopen takes a DONE or ENOUGH task.`);
  // A closed task still carrying a live park note (closed before task 244)
  // would come back OPEN while its text says PARKED — the contradiction 244
  // flags. Whoever ends the wait says what they saw; reopen can't, so it stops.
  const notes = liveParkNotes(task.body || '');
  if (notes.length) {
    fail(`#${id} is ${was} but its text still has a live park note ("${describePark(notes[0])}"). `
      + `Reopening would leave an OPEN task saying it is parked. End the wait first — `
      + `\`cogyard tasks unpark ${id} "<what was seen that ended it>" --on <the day it ended>\` — then reopen. Nothing changed.`);
  }
  const why = typeof flags.why === 'string' && flags.why.trim() ? ` — ${flags.why.replace(/\s+/g, ' ').trim()}` : '';
  const chat = (await agentSession()) ? await currentSessionId() : null;
  writeStatus(abs, 'OPEN', 'null');
  await cmdSync(['push', `reopen #${id} (was ${was})${why}${chat ? ` [chat ${chat}]` : ''}`, '--', abs]);
  process.stdout.write(`#${id} reopened (was ${was}); done_date cleared.\n`);
}

// --- Park / unpark (task 244) --------------------------------------------------
// A park is recorded twice — `status: PARKED`, and the text's live
// `> **PARKED <date> — <reason>**` note (core/park.mjs) — and these two commands
// are the only writers of either, the way close / reopen own DONE. Each sets
// the status, writes the note, keeps the `> **Status: X**` line true, and
// commits; park also releases the claim (a claim is valid only on an OPEN task).
// The Edit/Write hook refuses a hand edit of either half and names these.
//
// Two forms exist to repair what the validator flags, so a contradiction is
// always fixed with a command, never a hand edit:
//   park <id>               an OPEN task whose text already has a live note:
//                           status catches up, the note is kept.
//   park <id> "<reason>"    on a PARKED task with no note: records what it waits for.
//   unpark … on a task that isn't PARKED but still has a live note (closed with
//   one, before close refused that): ends the note; the status stays.
// `--on <YYYY-MM-DD>` dates the park or its end when it happened earlier than
// today — a missing record written late, or a wait that ended long ago.

function parkDate(flags, label) {
  const today = localDate();
  if (flags.on === undefined) return today;
  const d = String(flags.on);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok) fail(`--on ${d}: expected a date YYYY-MM-DD (${label}).`);
  if (d > today) fail(`--on ${d} is in the future — ${label} can't be later than today (${today}).`);
  return d;
}

const chatNote = async () => ((await agentSession()) ? ` [chat ${await currentSessionId()}]` : '');

async function cmdPark(idArg, reasonArg, flags = {}) {
  const usage = 'usage: tasks.mjs park <task-id-or-file> "<what it waits for>" [--on <YYYY-MM-DD>]';
  const { task, abs, id } = taskForStatusChange(idArg, usage);
  const status = task.frontmatter.status;
  const reason = typeof reasonArg === 'string' ? cleanParkReason(reasonArg) : '';
  const notes = liveParkNotes(task.body || '');
  let mode;
  if (status === 'OPEN' && !notes.length) {
    if (!reason) fail(`${usage}\nSay what #${id} waits for — it goes in the park note and is what un-parking checks against.`);
    mode = 'park';
  } else if (status === 'OPEN') {
    if (reason) {
      fail(`#${id}'s text already has a live park note ("${describePark(notes[0])}") while its status is OPEN. Either:\n`
        + `  • it still waits for that → \`cogyard tasks park ${id}\` (no reason: sets PARKED, keeps the note), or\n`
        + `  • that wait is over → \`cogyard tasks unpark ${id} "<what was seen>"\`, then park it again with the new reason.\nNothing changed.`);
    }
    if (flags.on !== undefined) fail(`--on dates a new note; #${id} keeps its note of ${notes[0].date || '(undated)'}. Run it without --on.`);
    mode = 'adopt';
  } else if (status === 'PARKED' && !notes.length) {
    if (!reason) fail(`${usage}\n#${id} is PARKED with no note saying what it waits for — give the reason (and --on <the day it was parked>, if you know it).`);
    mode = 'record';
  } else if (status === 'PARKED') {
    fail(`#${id} is already PARKED ("${describePark(notes[0])}"). When the wait is over: \`cogyard tasks unpark ${id} "<what was seen>"\`.`);
  } else {
    fail(`#${id} is ${status || 'missing a status'} — park takes an OPEN task.`
      + (['DONE', 'ENOUGH'].includes(status) ? ` To park a closed task, reopen it first: \`cogyard tasks reopen ${id} --why "<reason>"\`.` : ''));
  }
  const date = mode === 'adopt' ? null : parkDate(flags, 'the day it was parked');

  // 1. status + the note (+ the status line). Kept so a failed release can put
  //    the file back — a parked task still claimed is a validator error.
  const before = writeStatus(abs, 'PARKED', undefined, (b) => (mode === 'adopt' ? b : writeParkNote(b, { date, reason })));

  // 2. Release the claim: nothing parked is ever held (task 222). Committed with
  //    the park in step 3, as one commit.
  const claimed = task.frontmatter.env?.claimed_at;
  const released = claimed != null && claimed !== '' && claimed !== 'null';
  if (released) {
    try { execFileSync(process.execPath, [join(SCRIPT_DIR, 'env.mjs'), 'release', abs, '--no-commit'], { stdio: ['ignore', 'ignore', 'inherit'] }); }
    catch { writeFileSync(abs, before); fail(`releasing the claim failed — #${id} left as it was (${status}, still claimed).`); }
  }

  // 3. Commit.
  const what = mode === 'adopt' ? `(keeps its note of ${notes[0].date || 'no date'}) — ${notes[0].reason}`
    : mode === 'record' ? `(records what it waits for, since ${date}) — ${reason}`
    : `— ${reason}${date !== localDate() ? ` (since ${date})` : ''}`;
  await cmdSync(['push', `park #${id} ${what}${await chatNote()}`, '--', abs]);
  const told = mode === 'adopt' ? `status set to PARKED; its note of ${notes[0].date || '(undated)'} kept`
    : mode === 'record' ? `park note written (since ${date}); status stays PARKED`
    : `parked (since ${date})`;
  process.stdout.write(`#${id} ${told}${released ? ', claim released' : ''}.\n`);
}

async function cmdUnpark(idArg, seenArg, flags = {}) {
  const usage = 'usage: tasks.mjs unpark <task-id-or-file> "<what was seen that ends the wait>" [--on <YYYY-MM-DD>]';
  const { abs, id, task } = taskForStatusChange(idArg, usage);
  const status = task.frontmatter.status;
  const seen = typeof seenArg === 'string' ? seenArg.replace(/\s+/g, ' ').trim() : '';
  const notes = liveParkNotes(task.body || '');
  if (status !== 'PARKED' && !notes.length) {
    fail(`#${id} is ${status || 'missing a status'} and its text has no live park note — unpark takes a PARKED task.`);
  }
  if (!seen) fail(`${usage}\nSay what was seen that ends the wait${notes.length ? ` ("${describePark(notes[0])}")` : ''} — it is recorded as the un-park line.`);
  const end = parkDate(flags, 'the day the wait ended');
  const started = notes.map((n) => n.date).filter(Boolean).sort()[0];
  if (started && end < started) fail(`--on ${end} is before the park began (${started}).`);

  // PARKED → OPEN; any other status (a task closed with a live note) stays.
  const next = status === 'PARKED' ? 'OPEN' : status;
  writeStatus(abs, next, undefined, (b) => endParkNotes(b, { end, seen }));
  const change = status === 'PARKED' ? 'PARKED → OPEN' : `ends the park note; status stays ${status}`;
  await cmdSync(['push', `unpark #${id} (${change}) — ${seen}${await chatNote()}`, '--', abs]);
  process.stdout.write(`#${id} un-parked (${change}); recorded "Un-parked ${end}: ${seen}".\n`);
}

// `touches` (task 239) — keep a task's touches_paths true, because the plan's
// parallel check (`clash`) is only as good as that list. core/touches.mjs says
// why and when each form runs.
//   touches <id>                 print the list
//   touches <id> --add <path>…   add paths (committed); names, for information,
//                                any task IN PROGRESS that also lists one
//   touches <id> --check         files this branch changed that the list doesn't
//                                cover (Markdown left out); exit 1 when any
async function cmdTouches(idArg, flags, rest) {
  const usage = 'usage: tasks.mjs touches <task-id-or-file> [--add <path>… | --check]';
  const { repoRoot, task, abs, id } = taskForStatusChange(idArg, usage);
  const list = Array.isArray(task.frontmatter.touches_paths) ? task.frontmatter.touches_paths : [];

  if (flags.check) {
    const changed = await branchChangedFiles(repoRoot);
    if (changed == null) fail('no default branch (main/master) to compare this branch with');
    const out = outsideList({ changed, touches: list });
    if (!out.length) { process.stdout.write(`#${id}: every file this branch changed is in its touches_paths.\n`); return; }
    process.stdout.write(`#${id}: this branch changed ${out.length} file(s) its touches_paths doesn't list:\n${out.map((f) => `  ${f}`).join('\n')}\n`
      + `Add them: cogyard tasks touches ${id} --add ${out.join(' ')}\n`);
    process.exit(1);
  }

  if (flags.add) {
    const paths = [...(typeof flags.add === 'string' ? [flags.add] : []), ...rest].map(String);
    if (!paths.length) fail(usage);
    const before = readFileSync(abs, 'utf8');
    const { text, added } = addTouchesPaths(before, paths);
    if (added.length) {
      const tmp = `${abs}.touches-${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, abs);
      await cmdSync(['push', `[#${id}] touches: add ${added.join(', ')}`, '--', abs]);
    }
    const slug = resolveProjectForPath(repoRoot);
    const plan = await planFor({ slug, path: repoRoot }, discoverProjects());
    const hits = runningClashesFor(plan, id, paths);
    process.stdout.write(added.length ? `#${id}: added ${added.join(', ')} to touches_paths.\n` : `#${id}: already listed.\n`);
    // Sharing a file is not a collision (owner, 2026-11-13): say so, never stop.
    // `conflicts` is what says whether the edits actually collide.
    if (hits.length) {
      process.stdout.write(`For information — a task in progress also lists ${hits.length === 1 ? 'one of these' : 'these'}:\n`
        + hits.map((h) => `  #${h.id}: ${h.files.join(', ')}`).join('\n') + '\n'
        + `Whether the edits actually collide: cogyard tasks conflicts ${id}, after your next commit.\n`);
    }
    return;
  }

  process.stdout.write(list.length ? list.map((p) => `${p}\n`).join('') : `#${id} lists no files.\n`);
}

// `conflicts` (task 239) — would this task's branch actually conflict with
// another task's in progress, or with the default branch? A dry-run merge each
// (core/touches.mjs dryMerge); nothing is merged or changed. Exit 1 when any
// would conflict — the working chat stops and asks. A recorded branch that is
// gone is reported and skipped, never a reason to stop.
async function cmdConflicts(idArg) {
  const { repoRoot, task, id } = taskForStatusChange(idArg, 'usage: tasks.mjs conflicts <task-id-or-file>');
  const branch = task.frontmatter.env?.branch;
  if (!branch || branch === 'null') fail(`#${id} has no branch recorded — claim it from its worktree first`);
  const others = loadTasks(tasksDirOf(repoRoot))
    .filter((t) => t.hasFrontmatter && t.frontmatter.status === 'OPEN' && normalizeTaskId(t.frontmatter.id) !== normalizeTaskId(id))
    .map((t) => ({ id: normalizeTaskId(t.frontmatter.id), env: t.frontmatter.env || {} }))
    .filter((t) => t.env.claimed_at && t.env.claimed_at !== 'null' && t.env.branch && t.env.branch !== 'null' && t.env.branch !== branch)
    .map((t) => ({ id: t.id, branch: t.env.branch }));
  const results = await branchConflicts(repoRoot, branch, others);
  const name = (r) => (r.id == null ? r.branch : `#${r.id} (${r.branch})`);
  const lines = results.map((r) => r.error ? `  ${name(r)}: skipped — ${r.error}`
    : r.conflict ? `  ${name(r)}: CONFLICTS in ${r.files.join(', ')}` : `  ${name(r)}: merges cleanly`);
  const bad = results.filter((r) => r.conflict);
  process.stdout.write(`#${id} (${branch}) against ${results.length ? results.map(name).join(', ') : 'nothing in progress'}:\n${lines.join('\n')}\n`);
  if (!bad.length) return;
  process.stdout.write(`${bad.length} would conflict — stop and ask before going on.\n`);
  process.exit(1);
}

// --- Heuristic analyzer (for unknown-frontmatter tasks) ----------------------

function cmdAnalyze(opts) {
  const projects = opts.all ? discoverProjects() : (() => {
    const repoRoot = findRepoRoot();
    if (!repoRoot) fail('not in a git repo (or pass --all)');
    return [makeProjectEntry(repoRoot)];
  })();
  if (!projects.length) fail('no projects to analyze');
  const apply = !!opts.apply;
  const noPush = !!opts['no-push'];

  for (const proj of projects) {
    const tasksDir = tasksDirOf(proj.path);
    if (!existsSync(tasksDir)) continue;
    const tasks = loadTasks(tasksDir).filter((t) => !t.hasFrontmatter);
    if (!tasks.length) { process.stdout.write(`\n# ${proj.label} — no unknown-frontmatter tasks. Skipping.\n`); continue; }
    process.stdout.write(`\n# ${proj.label} — ${tasks.length} task(s) to analyze\n${'-'.repeat(80)}\n`);
    const repoSha = tryExec('git rev-parse --short HEAD', { cwd: proj.path }) || '';
    const today = new Date().toISOString().slice(0, 10);
    let writeCount = 0;
    const writtenFiles = [];
    for (const t of tasks) {
      const inferred = inferStatus(t);
      const file = basename(t.path);
      const idMatch = file.match(/^(\d+(?:\.\d+)?[a-z]?)/);
      const id = idMatch ? idMatch[1] : '?';
      const slug = file.replace(/^\d+(?:\.\d+)?[a-z]?-/, '').replace(/\.md$/, '');
      const title = inferred.title || slug;
      process.stdout.write(`\n  #${id.padStart(4)}  ${file}\n    title:   ${title}\n    status:  ${inferred.status}${inferred.doneDate ? `  (done_date: ${inferred.doneDate})` : ''}\n`);
      if (inferred.totalCount > 0) process.stdout.write(`    progress: ${inferred.checkedCount}/${inferred.totalCount}\n`);
      process.stdout.write(`    reasons: ${inferred.reasons.join('; ')}\n`);
      if (inferred.paths.length) process.stdout.write(`    paths:   ${inferred.paths.slice(0, 3).join(', ')}${inferred.paths.length > 3 ? ` (+${inferred.paths.length - 3} more)` : ''}\n`);
      if (apply) {
        const fm = [
          '---', `id: ${id.replace('.', '_')}`, `slug: ${slug}`,
          `title: ${title.replace(/[:#]/g, '').trim()}`, `status: ${inferred.status}`,
          `created: ${today}`, `created_at_commit: ${repoSha}`, `last_reviewed_at_commit: ${repoSha}`, `last_touched_commit: ${repoSha}`,
          `done_date: ${inferred.doneDate || 'null'}`, 'depends_on: []', 'related: []', 'touches_paths:',
          ...inferred.paths.map((p) => `  - ${p}`),
          'commit_policy: per-phase', 'out_of_scope: []', 'resources: []',
          // The shared claim only — a worktree and a session are this machine's
          // and live in $COGYARD_HOME/claims.json (task 190).
          'env:', '  branch: null', '  claimed_at: null', '  claimed_by: null', '---', '',
        ].join('\n');
        writeFileSync(t.path, fm + (t.body || ''));
        writtenFiles.push(basename(t.path));
        writeCount++;
      }
    }
    if (apply && writeCount > 0) {
      process.stdout.write(`\n  ✓ Wrote frontmatter to ${writeCount} files in ${proj.label}.\n`);
      if (!noPush) {
        // Scope to ONLY the files analyze rewrote (task 101) — the store's one
        // working tree may hold another session's unrelated pending edits, and a
        // `git add .` would sweep them into this commit under the wrong message.
        const pathspec = writtenFiles.map((p) => JSON.stringify(p)).join(' ');
        try {
          withStoreLock(realpathSync(tasksDir), () => {
            execSync(`git add -- ${pathspec}`, { cwd: tasksDir });
            execSync(`git ${gitIdentityFlags(tasksDir)}commit -m "analyze: backfill frontmatter for ${writeCount} tasks (heuristic)" -- ${pathspec}`, { cwd: tasksDir });
            execSync(`git push origin tasks`, { cwd: tasksDir });
          });
          process.stdout.write(`  ✓ Pushed to origin/tasks.\n`);
        } catch (e) { process.stdout.write(`  ⚠ Push failed: ${e.message}\n`); }
      } else process.stdout.write(`  (skipped push — run \`tasks.mjs sync push\` from ${proj.label} to publish.)\n`);
    } else if (!apply) process.stdout.write(`\n  Dry run. Re-run with --apply to write frontmatter.\n`);
  }
}

function cmdValidate(opts, idArg) {
  // One task (task 238): its file's errors and warnings, checked against the
  // whole project; exit 1 on an error. /merge-to-main runs this before merging.
  if (idArg) {
    const repoRoot = findRepoRoot();
    if (!repoRoot) fail('not in a git repo');
    const tasksDir = tasksDirOf(repoRoot);
    if (!existsSync(tasksDir)) fail('no task directory in this repo (.cogyard/tasks)');
    const task = resolveTask(tasksDir, basename(idArg));
    if (!task) fail(`task not found: ${idArg}`);
    const r = validateTasks(loadTasks(tasksDir)).results.find((x) => x.file === basename(task.path));
    const flag = r.errors.length ? '✗' : r.warnings.length ? '⚠' : '✓';
    process.stdout.write(`${flag} ${r.file} — ${r.errors.length} error(s), ${r.warnings.length} warning(s)\n`);
    for (const e of r.errors) process.stdout.write(`    ✗ ${e}\n`);
    if (!opts['errors-only']) for (const w of r.warnings) process.stdout.write(`    ⚠ ${w}\n`);
    if (r.errors.length) process.exitCode = 1;
    return;
  }
  const projects = opts.all ? discoverProjects() : (() => {
    const repoRoot = findRepoRoot();
    if (!repoRoot) fail('not in a git repo (or pass --all)');
    return [makeProjectEntry(repoRoot)];
  })();
  if (!projects.length) fail('no projects to validate');
  const errorsOnly = !!opts['errors-only'];

  let totalErrors = 0;
  let totalWarnings = 0;
  for (const proj of projects) {
    const tasksDir = tasksDirOf(proj.path);
    if (!existsSync(tasksDir)) continue;
    const tasks = loadTasks(tasksDir);
    if (!tasks.length) continue;
    const { results, errorCount, warningCount } = validateTasks(tasks);
    totalErrors += errorCount;
    totalWarnings += warningCount;
    const dirty = results.filter((r) => r.errors.length || (!errorsOnly && r.warnings.length));
    const flag = errorCount ? '✗' : warningCount ? '⚠' : '✓';
    process.stdout.write(`\n${flag} ${proj.label} — ${tasks.length} task(s), ${errorCount} error(s), ${warningCount} warning(s)\n`);
    for (const r of dirty) {
      process.stdout.write(`  ${r.file}\n`);
      for (const e of r.errors) process.stdout.write(`    ✗ ${e}\n`);
      if (!errorsOnly) for (const w of r.warnings) process.stdout.write(`    ⚠ ${w}\n`);
    }
  }
  process.stdout.write(`\n${'-'.repeat(80)}\nTotal: ${totalErrors} error(s), ${totalWarnings} warning(s) across ${projects.length} project(s).\n`);
  if (totalErrors) process.exitCode = 1;
}

function cmdBackfill() {
  const repoRoot = findRepoRoot();
  const tasksDir = repoRoot ? tasksDirOf(repoRoot) : findTasksDir();
  if (!tasksDir || !existsSync(tasksDir)) fail('no task directory found (.cogyard/tasks)');
  const tasks = loadTasks(tasksDir);
  const unknown = tasks.filter((t) => !t.hasFrontmatter);
  if (!unknown.length) { process.stdout.write('No unknown-frontmatter tasks. Nothing to backfill.\n'); return; }
  const editor = process.env.EDITOR || 'vi';
  for (const t of unknown) {
    process.stdout.write(`Backfilling ${basename(t.path)}... opening in ${editor}\n`);
    const sha = tryExec('git rev-parse --short HEAD', { cwd: repoRoot }) || '';
    const template = `---\nid: ${basename(t.path).match(/^(\d+)/)?.[1] || '???'}\nslug: ${basename(t.path).replace(/^\d+[a-z]?-/, '').replace(/\.md$/, '')}\ntitle: \nstatus: OPEN\ncreated: ${new Date().toISOString().slice(0, 10)}\ncreated_at_commit: ${sha}\nlast_reviewed_at_commit: ${sha}\nlast_touched_commit: ${sha}\ndone_date: null\ndepends_on: []\nrelated: []\ntouches_paths: []\ncommit_policy: per-phase\nout_of_scope: []\nresources: []\n---\n\n${t.body}`;
    writeFileSync(t.path, template);
    spawn(editor, [t.path], { stdio: 'inherit' });
  }
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opts.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('-')) opts.flags[a.slice(2)] = args[++i];
      else opts.flags[a.slice(2)] = true;
    } else opts.positional.push(a);
  }
  return opts;
}

// Only run the CLI when this file is executed directly (node tasks.mjs ...), NOT
// when imported. realpath compare is robust to symlinked invocation paths.
const __isCLI = process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (__isCLI) {
const opts = parseArgs(process.argv);
const cmd = opts.positional[0];

function printHelp() {
  process.stdout.write(`tasks.mjs — task index, data layer, and orphan-branch manager.

Subcommands:
  sync pull                           Rebase the task store from origin/tasks
  sync push <message>                 Commit and push the task store to origin/tasks
  projects [list]                     Show registered projects
  projects register                   Register the current repo manually
  projects remove <slug-or-path>      Remove from registry (does not delete files)
  next-id <slug>                      Atomically reserve the next numeric id and
                                      create <NNN>-<slug>.md in the store (race-safe
                                      across worktrees sharing the store).
  current                             Print JSON of currently-claimed tasks in
                                      this repo (used by the /commit skill to
                                      auto-tag commits with the active task id).
  convert [--store <p>] [--remote <u>]  Give this repo a shared store (adopting
                                      an in-repo _tasks/ folder if any): copy-first into
                                      <COGYARD_PROJECTS_ROOT>/_tasks/<slug> (or --store), own
                                      git repo on branch "tasks", absolute
                                      .cogyard/tasks link + .cogyard/.gitignore.
                                      Worktrees then share one store.
  join <remote-url> [--slug <s>] [--store <p>]  Join an EXISTING team store
                                      (member onboarding): clone it (branch
                                      "tasks") to <COGYARD_PROJECTS_ROOT>/_tasks/<slug>
                                      (or --store), mount the absolute .cogyard/tasks
                                      link, register the project, run doctor.
                                      Idempotent; never repoints at a different store.
  mount                               In a worktree: link .cogyard/tasks to the
                                      base checkout's store. No-op when the base
                                      has no task link; refuses a relative one.
  doctor                              Audit every registered project: its task
                                      link (ok / broken / missing / folder), store
                                      health, remote, worktree mounts, flags.
  default-branch                      Print the repo's default branch (main or
                                      master); exit 1 if neither exists.
  staleness                           Is this checkout behind the repo's default
                                      branch (main/master)? Prints the gap and
                                      exits 1 when behind. Used by the pickup/
                                      write-task drift gates.
  find <task-id-or-file-or-slug>      Resolve an id/filename/slug to its file
                                      path. THE lookup primitive — matches
                                      frontmatter id, filename stem, or slug
                                      (same rule drift/claim/release use
                                      internally). Prefer this over guessing
                                      .cogyard/tasks/NNN-<slug>.md.
  drift <task-id-or-file>             Commits on the default branch touching a
                                      task's touches_paths since its
                                      last_reviewed_at_commit. Exits 1 on drift.
  close <task-id-or-file>             Close a task: status DONE + today's done_date,
                                      release the claim, commit. Refuses, listing why,
                                      unless every box is ticked or settled
                                      ((dropped: why) / (moved: <id>) / ~~struck~~),
                                      the branch is merged (or there is none), and
                                      the claim is yours. Exits 1 on refusal.
    --enough                          Close as ENOUGH — shipped enough, leftovers
                                      ((optional) or open boxes) recorded
    --force                           Close even though the check fails
                                      (--enough and --force are the owner's: an
                                      agent runs them only with --asked)
    --asked "<owner's words>"         For an agent the owner told to: the owner's
                                      exact words from this chat, which must say
                                      "close" and "enough" (--enough) or "done"
                                      (--force). Recorded in the commit. Without
                                      them an agent is refused and gets the
                                      command for the owner.
  reopen <task-id-or-file>            Undo a close: DONE or ENOUGH → OPEN, done_date
                                      cleared, committed. Does not claim the task.
                                      Refuses while the text has a live park note.
    --why "<reason>"                  Recorded in the commit (an agent's commit also
                                      names its chat)
  park <task-id-or-file> "<reason>"   Park a task: OPEN → PARKED, writes the live note
                                      "> **PARKED <date> — <reason>**" at the top of the
                                      text, keeps the Status line true, releases the
                                      claim, commits. Refuses a task that isn't OPEN.
                                      Repairs: with no reason, an OPEN task whose text
                                      already has a live note becomes PARKED, note kept;
                                      a PARKED task with no note gets one written.
  unpark <task-id-or-file> "<seen>"   End a park: PARKED → OPEN, the live note becomes
                                      "> Parked <date> – <date>: <reason>." plus
                                      "> Un-parked <date>: <what was seen>.", commits.
                                      Refuses a task that isn't PARKED. Repair: a task
                                      closed with a live note keeps its status and the
                                      note is ended.
    --on <YYYY-MM-DD>                 (park, unpark) The day it was parked, or the
                                      wait ended, when that was before today
                                      (close refuses a parked task or one whose text
                                      still says PARKED — un-park it first)
  touches <task-id-or-file>           Print the task's touches_paths — the files it edits,
                                      which the plan's parallel check reads.
    --add <path>…                     Add paths to it (committed) BEFORE editing a file it
                                      doesn't list; names any task in progress that also
                                      lists one, for information.
    --check                           Files this branch changed that the list doesn't
                                      cover (Markdown left out); exits 1 when any.
                                      What /merge-to-main runs before merging.
  conflicts <task-id-or-file>         Would this task's branch conflict with another task's
                                      branch in progress, or with main? A dry-run merge each
                                      (nothing is changed); exits 1 naming the files when
                                      any would. The working chat runs it after each commit.
  analyze                             Heuristic-classify unknown-frontmatter tasks (dry-run)
    --apply                           Actually write the inferred frontmatter
    --no-push                         Skip pushing to origin/tasks after --apply
    --all                             Analyze every registered project (else: current repo only)
  validate [<task-id-or-file>]        Check task frontmatter and checkbox markers against the
                                      v2 schema (drift audit); exits 1 on any error. With a
                                      task, checks only that file (against its whole project,
                                      so a (moved: <id>) to a missing task counts) — what
                                      /merge-to-main runs before merging
    --all                             Validate every registered project (else: current repo only)
    --errors-only                     Suppress warnings; show only schema errors
  labels                              List the curated label registry (resolved shared +
                                      per-project axes) grouped by axis, with in-use counts,
                                      then in-use-but-unregistered labels. Read-only reference
                                      the write-task skill checks before minting new labels.
    --json                            Machine-readable (axes, registered, inUse, unregisteredInUse)
  switches                            This project's switches — rebase (always | ask) and
                                      version (off | minor | patch | own command) — each
                                      marked set (from the task store's switches.json) or
                                      default. What merge-to-main and pickup-task read.
    --json                            { rebase: {value, set}, version: {value, set, file} }
  plan                               What's left, in the order it can run: in progress, can
                                      start, waiting for a task (depends_on) or another
                                      project, built and waiting on you, parked. A task that
                                      shares a file or resource with one in progress says so.
                                      Same data as the portal's Plan tab.
    --json                            The full plan as JSON (each task's \`clash\`: every
                                      active task it shares a file or resource with)
    --problems                        List the task-data problems that make it less accurate
  (no command)                        This help
    --backfill                        Walk unknown-frontmatter files in $EDITOR

Project visibility: only what you've explicitly registered (\`cogyard init\` /
\`cogyard onboard\`) is visible to analyze --all. No filesystem scanning.

Files:
  Script:        ${SCRIPT_DIR}/
  Registry:      ${REGISTRY_PATH}
`);
}

if (opts.flags.help || opts.flags.h) { printHelp(); process.exit(0); }

switch (cmd) {
  // Raw argv tail (not opts.positional) so `sync push "<msg>" -- <path>...`
  // keeps its `--` separator — the generic parseArgs swallows a bare `--`.
  case 'sync': await cmdSync(process.argv.slice(2).slice(process.argv.slice(2).indexOf('sync') + 1)); break;
  case 'analyze': cmdAnalyze(opts.flags); break;
  case 'projects': cmdProjects(opts.positional.slice(1)); break;
  case 'next-id': await cmdNextId(opts.positional[1]); break;
  case 'current': cmdCurrent(); break;
  case 'convert': cmdConvert(opts.flags); break;
  case 'join': cmdJoin(opts.flags, opts.positional); break;
  case 'mount': cmdMount(); break;
  case 'doctor': cmdDoctor(); break;
  case 'default-branch': cmdDefaultBranch(); break;
  case 'staleness': cmdStaleness(); break;
  case 'find': cmdFind(opts.positional[1]); break;
  case 'drift': cmdDrift(opts.positional[1]); break;
  case 'close': await cmdClose(opts.positional[1], opts.flags); break;
  case 'reopen': await cmdReopen(opts.positional[1], opts.flags); break;
  case 'park': await cmdPark(opts.positional[1], opts.positional[2], opts.flags); break;
  case 'unpark': await cmdUnpark(opts.positional[1], opts.positional[2], opts.flags); break;
  case 'touches': await cmdTouches(opts.positional[1], opts.flags, opts.positional.slice(2)); break;
  case 'conflicts': await cmdConflicts(opts.positional[1]); break;
  case 'validate': cmdValidate(opts.flags, opts.positional[1]); break;
  case 'labels': cmdLabels(opts.flags); break;
  case 'switches': cmdSwitches(opts.flags); break;
  case 'plan': await (await import('./plan.mjs')).cmdPlan(opts.flags); break;
  // `tasks cleanup` moved to `cogyard cleanup disk` (task 117) — disposal is
  // one group now. Kept as an explicit redirect rather than an unknown-command
  // error, because muscle memory outlives a rename.
  case 'cleanup': fail('`tasks cleanup` moved — use `cogyard cleanup disk [slug] [--dry-run]`');
  case undefined:
    if (opts.flags.backfill) cmdBackfill();
    else printHelp();
    break;
  default:
    fail(`unknown subcommand: ${cmd}. Run tasks.mjs --help`);
}
}
