#!/usr/bin/env node
// cli/tasks.mjs — the cogyard CLI: the single command surface for skills,
// hooks, and humans; the data layer lives in ../core/index.mjs. (Extracted from
// the old ~/.claude engine; every adapter points here now and the old copy is
// dormant. The lockstep rule is OVER: edit only this file.)
//
// Subcommands: init / sync / projects / next-id / current / analyze /
//              convert / mount / doctor / default-branch / staleness / drift /
//              (default = generate INDEX.md)
//   --backfill            Walk unknown-frontmatter files in $EDITOR

import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, lstatSync, realpathSync, unlinkSync, readlinkSync, symlinkSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, relative, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_PATH,
  tryExec, execLoud, findRepoRoot, findTasksDir, defaultBranchSync,
  loadTasks, computeDerived, generateIndexMd,
  readRegistry, registerProject, unregisterProject, discoverProjects, makeProjectEntry, findProject,
  gitWorktrees, worktreesForProject,
  inferStatus,
  validateTasks,
  convertToSharedStore, joinSharedStore,
} from '../core/index.mjs';

const HOME = homedir();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fail(msg, code = 1) {
  process.stderr.write(`tasks.mjs: ${msg}\n`);
  process.exit(code);
}

// --- Subcommands -------------------------------------------------------------

function cmdInit() {
  // Low-level primitive: mkdir _tasks/ + register. NOT the project-creation front
  // door — that's `cogyard init <name>` (greenfield) / `cogyard onboard [path]`
  // (adopt an existing folder), which orchestrate git, store, version stamping,
  // and worktree wiring. This stays for the bare "register an
  // already-set-up repo" case.
  process.stderr.write('note: `cogyard tasks init` is a low-level primitive. To create or adopt a\n      full project, use `cogyard init <name>` or `cogyard onboard [path]`.\n');
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = join(repoRoot, '_tasks');

  // Symlink model: _tasks/ is either a normal directory in this repo, or a symlink
  // to a shared canonical location (e.g., for planet-style multi-clone projects).
  // No orphan branches, no worktree mounts.

  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
    process.stdout.write(`Created empty _tasks/ at ${tasksDir}\n`);
  }

  let isSymlink = false;
  try { isSymlink = lstatSync(tasksDir).isSymbolicLink(); } catch {}

  const entry = registerProject(repoRoot);
  process.stdout.write(`Registered ${entry.slug} -> ${entry.path}\n`);

  if (isSymlink) {
    const target = tryExec(`readlink "${tasksDir}"`);
    process.stdout.write(`_tasks/ is a symlink to ${target} (shared canonical dir).\n`);
  } else {
    process.stdout.write(`_tasks/ is a normal directory in this repo.\n`);
    process.stdout.write(`To share across multiple clones (planet system), set up a canonical dir + symlinks manually:\n`);
    process.stdout.write(`  - Move _tasks/ contents to a shared location (e.g., parent dir)\n`);
    process.stdout.write(`  - Replace this _tasks/ with a symlink: ln -s <canonical-path> _tasks\n`);
    process.stdout.write(`  - Add _tasks to .gitignore in this repo\n`);
  }
}

function cmdSync(args) {
  const sub = args[0];
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = join(repoRoot, '_tasks');
  if (!existsSync(tasksDir)) fail('_tasks/ does not exist — run `tasks.mjs init` first');

  if (sub === 'pull') {
    // Same local-only tolerance as push.
    const remotes = (tryExec('git remote', { cwd: tasksDir }) || '').split('\n');
    if (!remotes.includes('origin')) { process.stdout.write('No remote configured — nothing to pull (local-only).\n'); return; }
    try { execLoud(`git pull --rebase origin tasks`, { cwd: tasksDir }); }
    catch { fail('pull failed (rebase conflict?). Investigate manually in _tasks/.'); }
  } else if (sub === 'push') {
    const message = args.slice(1).join(' ') || `tasks: update ${new Date().toISOString()}`;
    execLoud(`git add .`, { cwd: tasksDir });
    const status = tryExec(`git status --porcelain`, { cwd: tasksDir });
    if (!status) { process.stdout.write(`Nothing to commit.\n`); return; }
    execLoud(`git commit -m ${JSON.stringify(message)}`, { cwd: tasksDir });
    // Local-only tolerance: push only when the store actually has an
    // origin AND a tasks branch. Local-only shared stores and normal-dir
    // projects (where _tasks rides the project repo) commit locally + notice —
    // they must NOT fail(), or every skill sync errors on them.
    const remotes = (tryExec('git remote', { cwd: tasksDir }) || '').split('\n');
    const hasTasksBranch = !!tryExec('git rev-parse --verify --quiet refs/heads/tasks', { cwd: tasksDir });
    if (!remotes.includes('origin') || !hasTasksBranch) {
      const why = !remotes.includes('origin') ? 'no remote configured' : 'no tasks branch (normal-dir project — tasks ride the project repo)';
      process.stdout.write(`Committed locally; skipping push (${why}).\n`);
      return;
    }
    try { execLoud(`git push origin tasks`, { cwd: tasksDir }); }
    catch {
      process.stdout.write(`Push failed; pulling and retrying...\n`);
      try {
        execLoud(`git pull --rebase origin tasks`, { cwd: tasksDir });
        execLoud(`git push origin tasks`, { cwd: tasksDir });
      } catch { fail('push retry failed. Investigate manually in _tasks/.'); }
    }
  } else {
    fail('usage: tasks.mjs sync pull | tasks.mjs sync push <message>');
  }
}

function cmdGenerate(opts) {
  const repoRoot = findRepoRoot();
  const tasksDir = repoRoot ? join(repoRoot, '_tasks') : findTasksDir();
  if (!tasksDir || !existsSync(tasksDir)) fail('no _tasks/ found');
  const project = repoRoot ? basename(repoRoot) : basename(dirname(tasksDir));
  const tasks = loadTasks(tasksDir);
  for (const t of tasks) t.derived = computeDerived(t, tasks, repoRoot);
  const indexMd = generateIndexMd(tasks, project);
  writeFileSync(join(tasksDir, 'INDEX.md'), indexMd);
  if (!opts.quiet) process.stdout.write(`Wrote ${join(tasksDir, 'INDEX.md')}\n`);
  return { tasks, project, tasksDir };
}

function cmdProjects(args) {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const projects = readRegistry();
    if (!projects.length) { process.stdout.write('(registry empty — run `tasks.mjs init` in a project to register it)\n'); return; }
    for (const p of projects) {
      const status = existsSync(join(p.path, '_tasks')) ? '  ' : ' ⚠';
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

// --- Shared-store model: convert · mount · doctor ------------------
// convert: relocate a project's tracked _tasks/ into its own git repo (the
// "store", branch `tasks`) and replace it with an ABSOLUTE symlink, so every
// git worktree of the project shares one physical _tasks/ (mounted via `mount`).
// Absolute because worktrees are not siblings (unlike multi-clone "planets",
// which use a relative ../_tasks). Copy-first: originals are never removed
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
    process.stdout.write(`_tasks is already a symlink → ${r.store} (shared store). Nothing to do.\n`);
    return;
  }
  process.stdout.write(`\nConverted. _tasks → ${r.store} (branch tasks). Worktrees: run \`cogyard tasks mount\` inside each (the SessionStart hook does this automatically).\n`);
}

// join: member-#2 onboarding for a TEAM store. The lead ran
// `convert --remote <url>`; a fresh clone of the project repo has a dangling
// gitignored _tasks symlink. This clones the store, mounts the symlink,
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
  process.stdout.write(`\nJoined: ${r.slug} — _tasks → ${r.store}. Doctor audit:\n\n`);
  cmdDoctor();
}

function cmdMount() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = join(repoRoot, '_tasks');
  let l = null;
  try { l = lstatSync(tasksDir); } catch {}
  if (l) {
    if (l.isSymbolicLink() && !existsSync(tasksDir)) {
      fail(`_tasks is a BROKEN symlink → ${readlinkSync(tasksDir)} — fix or remove it, then re-run mount`);
    }
    process.stdout.write('_tasks already present — nothing to mount.\n');
    return;
  }
  const raw = tryExec('git worktree list --porcelain', { cwd: repoRoot });
  const mainPath = (raw || '').split('\n').find((x) => x.startsWith('worktree '))?.slice('worktree '.length);
  if (!mainPath) fail('cannot determine the main worktree');
  if (resolve(mainPath) === resolve(repoRoot)) {
    process.stdout.write('This is the main worktree and it has no _tasks — run `tasks.mjs init` (or `convert`).\n');
    return;
  }
  const baseTasks = join(mainPath, '_tasks');
  let bl = null;
  try { bl = lstatSync(baseTasks); } catch {}
  if (!bl) { process.stdout.write(`Base worktree (${mainPath}) has no _tasks — nothing to mount.\n`); return; }
  if (!bl.isSymbolicLink()) { process.stdout.write('Base _tasks is a normal directory (not a shared store) — nothing to mount.\n'); return; }
  let target = readlinkSync(baseTasks);
  if (!isAbsolute(target)) target = resolve(mainPath, target); // tolerate planet-style relative links
  if (!existsSync(target)) fail(`base _tasks symlink is broken → ${target} — fix the store before mounting`);
  symlinkSync(target, tasksDir);
  process.stdout.write(`Mounted _tasks → ${target}\n`);
}

function cmdDoctor() {
  const projects = readRegistry();
  if (!projects.length) { process.stdout.write('(registry empty)\n'); return; }
  // canonical store -> slugs, to show intentional sharing (planets) at a glance
  const byCanon = new Map();
  const rows = projects.map((p) => {
    const td = join(p.path, '_tasks');
    const flags = [];
    let model = 'normal', storePath = '—', remote = '—', wt = '—';
    if (!tryExec('git rev-parse --show-toplevel', { cwd: p.path })) flags.push('not a git repo');
    let l = null;
    try { l = lstatSync(td); } catch {}
    if (!l) { model = 'MISSING'; flags.push('no _tasks'); }
    else if (l.isSymbolicLink()) {
      const target = readlinkSync(td);
      if (!existsSync(td)) { model = 'BROKEN'; storePath = target; flags.push(`broken symlink → ${target}`); }
      else {
        model = 'shared';
        storePath = realpathSync(td);
        if (!isAbsolute(target)) flags.push('relative symlink (worktrees need absolute)');
        const storeGit = tryExec('git rev-parse --show-toplevel', { cwd: storePath });
        if (!storeGit) flags.push('store is not a git repo');
        else {
          const branch = tryExec('git branch --show-current', { cwd: storePath });
          if (branch !== 'tasks') flags.push(`store on branch ${branch || '?'} (expected tasks)`);
          remote = (tryExec('git remote', { cwd: storePath }) || '').split('\n').includes('origin') ? 'origin' : 'local-only';
        }
        byCanon.set(storePath, [...(byCanon.get(storePath) || []), p.slug]);
      }
    } else {
      storePath = '(in repo)';
    }
    // Worktrees: total beyond main, and (for shared) how many are unmounted.
    const wts = tryExec('git rev-parse --show-toplevel', { cwd: p.path }) ? gitWorktrees(p.path) : [];
    if (wts.length > 1) {
      const extra = wts.slice(1);
      if (model === 'shared') {
        const unmounted = extra.filter((e) => { try { lstatSync(join(e.path, '_tasks')); return false; } catch { return true; } });
        wt = `${extra.length - unmounted.length}/${extra.length} mounted`;
        if (unmounted.length) flags.push(`${unmounted.length} worktree(s) unmounted — run mount`);
      } else {
        wt = `${extra.length}`;
        if (model === 'normal') flags.push('convertible (worktrees + normal _tasks)');
      }
    }
    return { slug: p.slug, model, storePath, remote, wt, flags };
  });
  for (const r of rows) {
    const shared = r.model === 'shared' && byCanon.get(r.storePath)?.length > 1;
    if (shared) r.flags.unshift(`store shared with: ${byCanon.get(r.storePath).filter((s) => s !== r.slug).join(', ')}`);
  }
  const W = { slug: 28, model: 8, store: 52, remote: 11, wt: 14 };
  process.stdout.write(['PROJECT'.padEnd(W.slug), 'MODEL'.padEnd(W.model), 'STORE'.padEnd(W.store), 'REMOTE'.padEnd(W.remote), 'WORKTREES'.padEnd(W.wt), 'FLAGS'].join('') + '\n');
  for (const r of rows) {
    process.stdout.write([
      r.slug.padEnd(W.slug), r.model.padEnd(W.model),
      String(r.storePath).padEnd(W.store), r.remote.padEnd(W.remote), String(r.wt).padEnd(W.wt),
      r.flags.length ? r.flags.join('; ') : 'ok',
    ].join('') + '\n');
  }

  // Schema drift — a storage audit should also surface frontmatter the validator
  // rejects. Compact: one line per project, error files listed (run `validate`
  // for the full per-file detail incl. warnings).
  process.stdout.write('\nSchema drift (run `tasks.mjs validate [--all]` for detail):\n');
  let totalErrors = 0;
  for (const p of projects) {
    const td = join(p.path, '_tasks');
    if (!existsSync(td)) continue;
    let tasks;
    try { tasks = loadTasks(td); } catch { continue; }
    if (!tasks.length) continue;
    const { results, errorCount, warningCount } = validateTasks(tasks);
    totalErrors += errorCount;
    const flag = errorCount ? '✗' : warningCount ? '⚠' : '✓';
    process.stdout.write(`  ${flag} ${p.slug.padEnd(26)} ${errorCount} error(s), ${warningCount} warning(s)\n`);
    for (const r of results.filter((x) => x.errors.length)) {
      process.stdout.write(`      ${r.file}: ${r.errors.join('; ')}\n`);
    }
  }
  process.stdout.write(`  ${totalErrors ? '✗' : '✓'} ${totalErrors} schema error(s) total.\n`);
}

// --- Next-id picker (atomic, race-safe across symlinked clones) -------------

function cmdNextId(slug) {
  if (!slug || /^[0-9]/.test(slug)) fail('usage: tasks.mjs next-id <slug>   (slug: kebab-case, no leading digit)');
  const cleanSlug = String(slug).replace(/[^a-zA-Z0-9._-]/g, '-');
  const repoRoot = findRepoRoot();
  const localTasksDir = repoRoot ? join(repoRoot, '_tasks') : findTasksDir();
  if (!localTasksDir || !existsSync(localTasksDir)) fail('no _tasks/ found');
  // Resolve to canonical so all sibling clones serialize on the same dir via O_EXCL.
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
  if (remoteBacked) tryExec('git pull --rebase --autostash origin tasks', { cwd: canonical });

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
      process.stdout.write(JSON.stringify({ id: nextId, padded, file: filepath, canonical }) + '\n');
      return;
    }
    publishReservation(canonical, cleanSlug, nextId);
    return;
  }
  fail('next-id: too many collisions (gave up after 100 attempts)');
}

// Remote-backed reservation: commit the placeholder and push it,
// re-allocating the id when a competitor's file arrives with the same number.
// Offline is tolerated: the reservation stays as a local commit (a warning says
// so) and the next `sync push` publishes it — never block task creation.
function publishReservation(canonical, cleanSlug, id) {
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
  tryExec(`git add -- ${JSON.stringify(filename)}`, { cwd: canonical });
  tryExec(`git commit -m ${JSON.stringify(msg())} -- ${JSON.stringify(filename)}`, { cwd: canonical });
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
      id = next; padded = newPadded; filename = newFilename;
      tryExec(`git commit --amend -m ${JSON.stringify(msg())}`, { cwd: canonical });
      continue; // re-check before pushing (mv target could clash again after another pull)
    }
    if (tryExec('git push origin tasks', { cwd: canonical }) !== null) { pushed = true; break; }
    if (tryExec('git pull --rebase --autostash origin tasks', { cwd: canonical }) === null) break; // offline/unreachable
  }
  if (!pushed) process.stderr.write('tasks.mjs: warning — id reserved locally but not pushed (remote unreachable?); it publishes on the next sync push\n');
  process.stdout.write(JSON.stringify({ id, padded, file: join(canonical, filename), canonical, pushed }) + '\n');
}

// --- Currently-claimed task (used by the /commit skill to tag commits) -------

function cmdCurrent() {
  const repoRoot = findRepoRoot();
  const tasksDir = repoRoot ? join(repoRoot, '_tasks') : findTasksDir();
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

// Drift gate: commits on the (fetched) default branch touching a task's
// `touches_paths` since its `last_reviewed_at_commit`. Prints the offending
// commits (empty = no drift). Resolves the branch internally — no `..main` in
// the skill prose — and compares against origin so a push from another worktree
// is seen even before this checkout pulls.
function cmdDrift(idArg) {
  if (!idArg) fail('usage: tasks.mjs drift <task-id-or-file>');
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');
  const tasksDir = join(repoRoot, '_tasks');
  if (!existsSync(tasksDir)) fail('no _tasks/ in this repo');
  const want = String(idArg).replace(/\.md$/, '');
  const task = loadTasks(tasksDir).find((t) => {
    const fm = t.frontmatter || {};
    return String(fm.id) === want || basename(t.path).replace(/\.md$/, '') === want || String(fm.slug) === want;
  });
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
    const tasksDir = join(proj.path, '_tasks');
    if (!existsSync(tasksDir)) continue;
    const tasks = loadTasks(tasksDir).filter((t) => !t.hasFrontmatter);
    if (!tasks.length) { process.stdout.write(`\n# ${proj.label} — no unknown-frontmatter tasks. Skipping.\n`); continue; }
    process.stdout.write(`\n# ${proj.label} — ${tasks.length} task(s) to analyze\n${'-'.repeat(80)}\n`);
    const repoSha = tryExec('git rev-parse --short HEAD', { cwd: proj.path }) || '';
    const today = new Date().toISOString().slice(0, 10);
    let writeCount = 0;
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
          'commit_policy: end', 'out_of_scope: []', 'parallel_safe: true', 'coordination: []',
          'env:', '  planet: null', '  ports:', '    backend: null', '    frontend: null',
          '  hostname: null', '  worktree: null', '  branch: null', '  db: development',
          '  claimed_at: null', '  claimed_by: null', '  claimed_by_session: null', '---', '',
        ].join('\n');
        writeFileSync(t.path, fm + (t.body || ''));
        writeCount++;
      }
    }
    if (apply && writeCount > 0) {
      process.stdout.write(`\n  ✓ Wrote frontmatter to ${writeCount} files in ${proj.label}.\n`);
      if (!noPush) {
        try {
          execSync(`git add .`, { cwd: tasksDir });
          execSync(`git commit -m "analyze: backfill frontmatter for ${writeCount} tasks (heuristic)"`, { cwd: tasksDir });
          execSync(`git push origin tasks`, { cwd: tasksDir });
          process.stdout.write(`  ✓ Pushed to origin/tasks.\n`);
        } catch (e) { process.stdout.write(`  ⚠ Push failed: ${e.message}\n`); }
      } else process.stdout.write(`  (skipped push — run \`tasks.mjs sync push\` from ${proj.label} to publish.)\n`);
    } else if (!apply) process.stdout.write(`\n  Dry run. Re-run with --apply to write frontmatter.\n`);
  }
}

function cmdValidate(opts) {
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
    const tasksDir = join(proj.path, '_tasks');
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
  const tasksDir = repoRoot ? join(repoRoot, '_tasks') : findTasksDir();
  if (!tasksDir || !existsSync(tasksDir)) fail('no _tasks/ found');
  const tasks = loadTasks(tasksDir);
  const unknown = tasks.filter((t) => !t.hasFrontmatter);
  if (!unknown.length) { process.stdout.write('No unknown-frontmatter tasks. Nothing to backfill.\n'); return; }
  const editor = process.env.EDITOR || 'vi';
  for (const t of unknown) {
    process.stdout.write(`Backfilling ${basename(t.path)}... opening in ${editor}\n`);
    const sha = tryExec('git rev-parse --short HEAD', { cwd: repoRoot }) || '';
    const template = `---\nid: ${basename(t.path).match(/^(\d+)/)?.[1] || '???'}\nslug: ${basename(t.path).replace(/^\d+[a-z]?-/, '').replace(/\.md$/, '')}\ntitle: \nstatus: OPEN\ncreated: ${new Date().toISOString().slice(0, 10)}\ncreated_at_commit: ${sha}\nlast_reviewed_at_commit: ${sha}\nlast_touched_commit: ${sha}\ndone_date: null\ndepends_on: []\nrelated: []\ntouches_paths: []\ncommit_policy: end\nout_of_scope: []\nparallel_safe: true\ncoordination: []\n---\n\n${t.body}`;
    writeFileSync(t.path, template);
    spawn(editor, [t.path], { stdio: 'inherit' });
  }
}

// --- inbox: low-ceremony bug capture + triage ----------------------
// `_tasks/INBOX.md` is an append-only sink: jot a one-line bug mid-flow in ~5s
// without writing a full task. A line is throwaway capture, not a tracked record
// — triage either fixes it inline (then `clear`), promotes it to a `category: bug`
// task via the write-task skill (then `clear`), or clusters related lines.
const INBOX_HEADER = `# INBOX — one-line bug/idea capture

Zero ceremony: \`cogyard tasks inbox add "<thing>"\`. Triage with the write-task
skill — fix inline, promote to a \`category: bug\` task, or cluster — then
\`cogyard tasks inbox clear <n>\`. Lines here are throwaway, not tracked records.
`;

function inboxPath() {
  const repoRoot = findRepoRoot();
  const tasksDir = repoRoot ? join(repoRoot, '_tasks') : findTasksDir();
  if (!tasksDir || !existsSync(tasksDir)) fail('no _tasks/ found');
  return join(tasksDir, 'INBOX.md');
}

// Parse INBOX.md body into its capture lines (the `- [ ] ...` / `- [x] ...`
// bullets), preserving file order. Returns [{ lineIdx, checked, text }].
function inboxLines(content) {
  const out = [];
  content.split('\n').forEach((ln, i) => {
    const m = ln.match(/^- \[([ xX])\]\s?(.*)$/);
    if (m) out.push({ lineIdx: i, checked: m[1].toLowerCase() === 'x', text: m[2] });
  });
  return out;
}

function cmdInbox(args) {
  const sub = args[0] || 'list';
  const path = inboxPath();
  const read = () => (existsSync(path) ? readFileSync(path, 'utf8') : INBOX_HEADER);

  if (sub === 'add') {
    const text = args.slice(1).join(' ').trim();
    if (!text) fail('inbox add: give the bug text, e.g. inbox add "files tab 500s on empty repo"');
    const date = new Date().toISOString().slice(0, 10);
    let content = read();
    if (!content.endsWith('\n')) content += '\n';
    content += `- [ ] ${text} (${date})\n`;
    writeFileSync(path, content);
    process.stdout.write(`captured → ${path}\n`);
    return;
  }

  if (sub === 'list') {
    const items = inboxLines(read());
    const open = items.filter((it) => !it.checked);
    if (!open.length) { process.stdout.write('inbox empty (nothing to triage)\n'); return; }
    process.stdout.write(`INBOX — ${open.length} open:\n`);
    open.forEach((it, n) => process.stdout.write(`  ${n + 1}. ${it.text}\n`));
    process.stdout.write(`\nTriage with the write-task skill, then: cogyard tasks inbox clear <n>\n`);
    return;
  }

  if (sub === 'clear' || sub === 'done') {
    const n = Number(args[1]);
    if (!Number.isInteger(n) || n < 1) fail(`inbox ${sub}: give the line number from \`inbox list\``);
    const content = read();
    const open = inboxLines(content).filter((it) => !it.checked);
    const target = open[n - 1];
    if (!target) fail(`inbox ${sub}: no open line #${n} (run \`inbox list\`)`);
    const lines = content.split('\n');
    lines.splice(target.lineIdx, 1);           // remove the triaged line outright
    writeFileSync(path, lines.join('\n'));
    process.stdout.write(`cleared #${n}: ${target.text}\n`);
    return;
  }

  fail(`inbox: unknown action "${sub}" (use add | list | clear)`);
}

// --- cleanup: reclaim build/install dirs from MERGED, CLEAN worktrees -
// Worktrees share the parent repo's git objects, so the only heavy per-worktree
// thing is regenerable build/install output (DISPOSABLE_DIRS) once a build/install
// has run. The user keeps the worktrees (chat-archiving removes those) but wants
// the disk back once the work is in main — re-running `npm install` / a rebuild on
// a revisit is the accepted cost. Regenerable dirs ONLY: the worktree dir, branch,
// ports, git state, source, and local files (*.local.md) are untouched.
//
// Eligibility is "nothing unique left to lose", NOT a task-status lookup (a task
// can span several worktrees, so the worktree→task map is unreliable). A
// worktree is eligible iff it is STALE — fully merged into main
// (ahead === 0) AND its working tree is clean (no uncommitted changes). That alone
// proves every file is already in main, so deleting build dirs loses nothing, and
// it protects in-flight work for free: uncommitted edits (dirty) or unmerged
// commits (ahead > 0) both make a worktree non-stale.
//
// Hard exclusions (never clean): the main checkout (never stale), the currently-
// active worktree (this session — don't yank deps from a live build), and any
// worktree with a live claim (a session is actively holding it).

function dirSizeKb(p) {
  try { return parseInt(execSync(`du -sk ${JSON.stringify(p)}`).toString().trim().split(/\s+/)[0], 10) || 0; }
  catch { return 0; }
}
function fmtMb(kb) { return `${(kb / 1024).toFixed(1)} MB`; }

// The disposable dirs: build/install output that's heavy and 100% regenerable.
// Matched by name at ANY depth (root, frontend/, extras/desktop/…) so workspaces and
// sub-packages are all caught — `node_modules` (install; desktop's holds the
// ~250 MB Electron binary), `dist`/`.angular`/`out-tsc`/`coverage` (build + cache),
// `release` (electron-builder's packaged .app/dmg). NOT a "delete everything
// gitignored" sweep — that net also catches *.local.md private notes and the
// _tasks symlink, which are irreplaceable. Names only; never files.
const DISPOSABLE_DIRS = ['node_modules', 'dist', '.angular', 'out-tsc', 'coverage', 'release'];

// `-prune` stops find descending INTO a match, so a package's own dist inside
// node_modules is never separately listed — each top-level disposable dir is
// returned once, and we don't walk the tens of thousands of files inside.
function findDisposable(root) {
  const names = DISPOSABLE_DIRS.map((n) => `-name ${JSON.stringify(n)}`).join(' -o ');
  try {
    const out = execSync(`find ${JSON.stringify(root)} -type d \\( ${names} \\) -prune`, { maxBuffer: 64 * 1024 * 1024 }).toString().trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}

async function cmdCleanup(opts) {
  const slug = opts.positional[1];
  const dryRun = !!opts.flags['dry-run'];
  const projects = slug
    ? (() => { const p = findProject(slug); if (!p) fail(`no registered project: ${slug} (see \`tasks.mjs projects list\`)`); return [p]; })()
    : readRegistry();
  if (!projects.length) fail('no registered projects (run init/onboard somewhere first)');

  // The active worktree = the checkout this process runs in. Never clean it.
  const activeRoot = (() => { const r = findRepoRoot(); return r ? resolve(r) : null; })();

  process.stdout.write(`${dryRun ? 'DRY RUN — ' : ''}cleanup: merged + clean worktrees${slug ? ` in ${slug}` : ' across all projects'}\n`);
  let totalKb = 0, count = 0;
  for (const proj of projects) {
    let wts;
    try { wts = await worktreesForProject(proj); }
    catch { continue; }
    for (const wt of wts) {
      if (wt.isMain) continue;                                    // portal builds from main
      if (activeRoot && resolve(wt.path) === activeRoot) continue; // this session — live build/preview
      if (wt.claimLive) continue;                                 // a session is actively holding it
      if (!wt.stale) continue;                                    // STALE = merged into main + clean tree; skips dirty/unmerged (in-flight)
      const dirs = findDisposable(wt.path);                        // node_modules/dist/.angular/release … any depth
      if (!dirs.length) continue;                                  // nothing regenerable left
      const kb = dirs.reduce((s, d) => s + dirSizeKb(d), 0);
      totalKb += kb; count++;
      const nDirs = dirs.length > 1 ? ` [${dirs.length} dirs]` : '';
      if (dryRun) {
        process.stdout.write(`  would clean  ${proj.slug}/${wt.name}  ${fmtMb(kb)}${nDirs}\n`);
      } else {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
        process.stdout.write(`  cleaned      ${proj.slug}/${wt.name}  ${fmtMb(kb)} reclaimed${nDirs}\n`);
      }
    }
  }
  if (!count) { process.stdout.write('  nothing to clean (no merged, clean worktree has build/install dirs).\n'); return; }
  process.stdout.write(`${dryRun ? 'Would reclaim' : 'Reclaimed'} ${fmtMb(totalKb)} across ${count} worktree(s).${dryRun ? ' Re-run without --dry-run to delete.' : ''}\n`);
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

if (opts.flags.help || opts.flags.h) {
  process.stdout.write(`tasks.mjs — task index, data layer, and orphan-branch manager.

Subcommands:
  init                                Low-level: mkdir _tasks/ + register an
                                      already-set-up repo. To CREATE or ADOPT a
                                      full project use \`cogyard init <name>\` /
                                      \`cogyard onboard [path]\` instead.
  sync pull                           Rebase _tasks/ from origin/tasks
  sync push <message>                 Commit and push _tasks/ to origin/tasks
  projects [list]                     Show registered projects
  projects register                   Register the current repo manually
  projects remove <slug-or-path>      Remove from registry (does not delete files)
  next-id <slug>                      Atomically reserve the next numeric id and
                                      create _tasks/<NNN>-<slug>.md (race-safe
                                      across symlinked sibling clones).
  current                             Print JSON of currently-claimed tasks in
                                      this repo (used by the /commit skill to
                                      auto-tag commits with the active task id).
  convert [--store <p>] [--remote <u>]  Convert this repo's tracked _tasks/ to a
                                      shared store: copy-first into
                                      <COGYARD_PROJECTS_ROOT>/_tasks/<slug> (or --store), own
                                      git repo on branch "tasks", absolute
                                      symlink + gitignore.
                                      Worktrees then share one _tasks.
  join <remote-url> [--slug <s>] [--store <p>]  Join an EXISTING team store
                                      (member onboarding): clone it (branch
                                      "tasks") to <COGYARD_PROJECTS_ROOT>/_tasks/<slug>
                                      (or --store), mount the absolute _tasks
                                      symlink, register the project, run doctor.
                                      Idempotent; never repoints at a different store.
  mount                               In a worktree: recreate the base checkout's
                                      _tasks symlink here. No-op when the base
                                      uses a normal _tasks dir.
  doctor                              Audit every registered project: storage
                                      model, store health, remote, worktree
                                      mounts, flags.
  default-branch                      Print the repo's default branch (main or
                                      master); exit 1 if neither exists.
  staleness                           Is this checkout behind the repo's default
                                      branch (main/master)? Prints the gap and
                                      exits 1 when behind. Used by the pickup/
                                      write-task drift gates.
  drift <task-id-or-file>             Commits on the default branch touching a
                                      task's touches_paths since its
                                      last_reviewed_at_commit. Exits 1 on drift.
  analyze                             Heuristic-classify unknown-frontmatter tasks (dry-run)
    --apply                           Actually write the inferred frontmatter
    --no-push                         Skip pushing to origin/tasks after --apply
    --all                             Analyze every registered project (else: current repo only)
  validate                            Check task frontmatter against the v2 schema (drift audit)
    --all                             Validate every registered project (else: current repo only)
    --errors-only                     Suppress warnings; show only schema errors
  inbox add "<text>"                  Append a one-line bug/idea to _tasks/INBOX.md
  inbox [list]                        List open INBOX lines awaiting triage
  inbox clear <n>                     Remove INBOX line <n> after triage (fix/promote/cluster)
  cleanup [slug] [--dry-run]          Reclaim build/install dirs (node_modules,
                                      dist, .angular, out-tsc, coverage, release —
                                      any depth) from worktrees that are MERGED
                                      into main AND clean (no uncommitted changes).
                                      Skips main, the active worktree, live-claimed
                                      ones, and anything in-flight (dirty or
                                      unmerged). Regenerable dirs ONLY — worktree
                                      dir, branch, ports, git state, source
                                      untouched. Default: all registered projects;
                                      pass a slug for one.
  (no command)                        Generate _tasks/INDEX.md
    --backfill                        Walk unknown-frontmatter files in $EDITOR

Project visibility: only what you've explicitly registered (via init) is visible to
analyze --all. No filesystem scanning.

Files:
  Script:        ${SCRIPT_DIR}/
  Registry:      ${REGISTRY_PATH}
`);
  process.exit(0);
}

switch (cmd) {
  case 'init': cmdInit(); break;
  case 'sync': cmdSync(opts.positional.slice(1)); break;
  case 'analyze': cmdAnalyze(opts.flags); break;
  case 'projects': cmdProjects(opts.positional.slice(1)); break;
  case 'next-id': cmdNextId(opts.positional[1]); break;
  case 'current': cmdCurrent(); break;
  case 'convert': cmdConvert(opts.flags); break;
  case 'join': cmdJoin(opts.flags, opts.positional); break;
  case 'mount': cmdMount(); break;
  case 'doctor': cmdDoctor(); break;
  case 'default-branch': cmdDefaultBranch(); break;
  case 'staleness': cmdStaleness(); break;
  case 'drift': cmdDrift(opts.positional[1]); break;
  case 'validate': cmdValidate(opts.flags); break;
  case 'inbox': cmdInbox(opts.positional.slice(1)); break;
  case 'cleanup': cmdCleanup(opts).catch((e) => fail(e.message)); break;
  case undefined:
    if (opts.flags.backfill) cmdBackfill();
    else cmdGenerate({});
    break;
  default:
    fail(`unknown subcommand: ${cmd}. Run tasks.mjs --help`);
}
}
