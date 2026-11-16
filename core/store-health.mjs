// core/store-health.mjs — the task-storage report: where each project's task directory
// actually lives, and whether that storage is healthy. Pure data, no printing.
//
//   storeHealth() -> {
//     rows:  [{ slug, path, link, storePath, remote, worktrees, flags, … }],
//     drift: { projects: [{ slug, errorCount, warningCount, errorFiles }], totalErrors },
//   }
//
// storeHealth({ onlyPaths: ['<repo path>', …] }) returns the same shape with just
// those projects' rows — the per-project settings tab's Location-on-disk section
// (task 135).
//
// `cogyard tasks doctor` renders it as a table; GET /api/storage serves it to the
// portal's Settings page. ONE implementation: until task 132 this logic lived
// inline in the CLI, so no API could reach it and the store's health was invisible
// in the portal — which is the whole problem the task set out to fix.
//
// NOT core/doctor.mjs. That is the INSTALL preflight (`cogyard doctor` — node
// version, git on PATH, writable config home). This is the storage report
// (`cogyard tasks doctor`). Two different questions; deliberately two surfaces.
//
// `flags` is the CLI's long-standing FLAGS column, string-for-string and in the
// same order it has always emitted. Facts added by task 132 (branch, dirty,
// unpushed, last commit, task count, the link) get their own fields rather
// than joining that array, so the table stays byte-stable while the portal gets
// more than the table ever showed.

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tryExec } from './exec.mjs';
import { HOME } from './paths.mjs';
import { readRegistry } from './registry.mjs';
import { gitWorktrees } from './worktrees.mjs';
import { loadTasks } from './frontmatter.mjs';
import { validateTasks } from './validate.mjs';
import { storeFacts, storeWindow, LEFTOVER_INDEX } from './store-audit.mjs';
import { tasksDirOf, oldTasksDir, oldTasksDirProblem } from './tasks-dir.mjs';

// The store's own git facts — the repo the task link points into. Asked only
// when the link is ok: a folder at the link's place would answer with the
// project repo's facts, which are not a store's.
function storeGitFacts(storePath) {
  const dirty = tryExec('git status --porcelain', { cwd: storePath });
  // Quoted: unquoted, the shell splits the format at the space and git reads
  // `%cr` as a revision, so the call fails and every store reports no commit.
  const last = tryExec('git log -1 --format="%h %cr"', { cwd: storePath });
  // Split at the FIRST space only — the relative date is several words of its
  // own ("3 days ago"), and a plain split keeps only the first.
  const cut = last ? last.indexOf(' ') : -1;
  const short = cut > 0 ? last.slice(0, cut) : null;
  const relDate = cut > 0 ? last.slice(cut + 1) : null;
  // No upstream (a local-only store, or a branch never pushed) → null, not 0.
  // Zero means "nothing to push"; null means "the question doesn't apply".
  const ahead = tryExec('git rev-list --count @{u}..HEAD', { cwd: storePath });
  return {
    storeDirty: dirty === null ? null : dirty.length > 0,
    unpushed: ahead === null ? null : Number(ahead),
    lastCommit: short ? { short, relDate: relDate || null } : null,
  };
}

// Where a project's task store canonically lives, using only filesystem calls —
// THE one place that answers "where is this project's task store" (task 191:
// the portal's store view resolves through it too, so task 160's link rename
// changes this function and nothing else). null when the link is missing or
// broken, or a folder sits in its place.
//
// no git, no task loading. The `only` path below needs this for every project
// even when it reports on one, because "is this store shared with another
// project" is not answerable from the one project's own row.
function canonicalStore(projectPath) {
  const td = tasksDirOf(projectPath);
  try {
    if (!lstatSync(td).isSymbolicLink() || !existsSync(td)) return null;
    return realpathSync(td);
  } catch { return null; }
}

// The state of a project's task link, `.cogyard/tasks` (tasks 217, 169) —
// canonicalStore() alone answers null for three of them, and each needs its own
// words. One answer for `cogyard tasks doctor`'s LINK column, GET /api/storage's
// rows and GET /api/graph's store view (all as `link`):
//   ok       a link to a store that exists      (target = the link's text)
//   broken   a link to a folder that doesn't    (target = the link's text)
//   missing  no task link at all
//   folder   a real folder in the link's place — a fault: nothing makes one
//            (tasks are only ever kept in a store), and convert refuses it
// Filesystem only.
function storeLinkState(projectPath) {
  const td = tasksDirOf(projectPath);
  let l;
  try { l = lstatSync(td); } catch { return { state: 'missing', target: null }; }
  if (!l.isSymbolicLink()) return { state: 'folder', target: null };
  const target = readlinkSync(td);
  return { state: existsSync(td) ? 'ok' : 'broken', target };
}

// The FLAGS entry for a folder in the link's place: what it is and the fix.
const FOLDER_FLAG = 'folder, not a link to a task store — rename it to _tasks/ and run `cogyard tasks convert`';

// The other registered projects whose task link resolves to `store` — the
// storage report's sharedWith, for one store without the whole report.
function storeSharedWith(slug, store) {
  return readRegistry().filter((p) => p.slug !== slug && canonicalStore(p.path) === store).map((p) => p.slug);
}

// `onlyPaths` is a list of project checkout paths: report on those alone. Every
// other project is still resolved to its canonical store (cheap — filesystem
// only) so the shared-store detection stays correct, but the git calls, worktree
// scan and task load that dominate the runtime happen for the reported project
// only. The full report shells git per project and takes seconds; a per-project
// settings tab waiting on all of that reads as broken.
//
// PATHS, not a slug: this report is keyed by registry entry, and the caller
// already holds the project's path from discoverProjects().
function storeHealth({ onlyPaths } = {}) {
  const projects = readRegistry();
  const only = onlyPaths ? new Set(onlyPaths) : null;
  const byCanon = new Map(); // canonical store -> slugs, to surface two projects sharing one store
  const drift = { projects: [], totalErrors: 0 };

  const rows = projects.map((p) => {
    if (only && !only.has(p.path)) {
      const canon = canonicalStore(p.path);
      if (canon) byCanon.set(canon, [...(byCanon.get(canon) || []), p.slug]);
      return null;
    }
    const td = tasksDirOf(p.path);
    const flags = [];
    const link = storeLinkState(p.path);
    let storePath = '—', remote = '—';
    let storeBranch = null, storeDirty = null, unpushed = null, lastCommit = null, audit = null;

    if (!tryExec('git rev-parse --show-toplevel', { cwd: p.path })) flags.push('not a git repo');

    if (link.state === 'missing') {
      flags.push('no task directory');
      // An older release's top-level `_tasks` still there: say so and how to move it.
      const old = oldTasksDir(p.path);
      if (old) flags.push(oldTasksDirProblem(old));
    } else if (link.state === 'folder') {
      flags.push(FOLDER_FLAG);
    } else {
      const target = link.target;
      if (link.state === 'broken') { storePath = target; flags.push(`broken symlink → ${target}`); }
      else {
        storePath = realpathSync(td);
        if (!isAbsolute(target)) flags.push('relative symlink (worktrees need absolute)');
        const storeGit = tryExec('git rev-parse --show-toplevel', { cwd: storePath });
        if (!storeGit) flags.push('store is not a git repo');
        else {
          storeBranch = tryExec('git branch --show-current', { cwd: storePath });
          if (storeBranch !== 'tasks') flags.push(`store on branch ${storeBranch || '?'} (expected tasks)`);
          remote = (tryExec('git remote', { cwd: storePath }) || '').split('\n').includes('origin') ? 'origin' : 'local-only';
          ({ storeDirty, unpushed, lastCommit } = storeGitFacts(storePath));
          // Task 191: what is uncommitted (by kind, and how old) and how many of
          // this week's commits broke the store rules — the Settings table's
          // view into the store view. Separate field: the CLI's FLAGS column
          // stays byte-stable.
          const f = storeFacts(storePath);
          const { files, ...pending } = f.pending;
          // Task 190: INDEX.md is no longer written; one still in the store is
          // cleanup to do, so it is a real flag (CLI doctor + Settings).
          if (f.flags.some((x) => x.kind === 'leftoverIndex')) flags.push(LEFTOVER_INDEX);
          audit = { pending, week: storeWindow(storePath, 7) };
        }
        byCanon.set(storePath, [...(byCanon.get(storePath) || []), p.slug]);
      }
    }

    // Worktrees beyond the main checkout, and (when the link is ok) how many of
    // them have the task-store link mounted. An unmounted worktree is a session
    // that cannot see the task store at all.
    let worktrees = null;
    const wts = tryExec('git rev-parse --show-toplevel', { cwd: p.path }) ? gitWorktrees(p.path) : [];
    if (wts.length > 1) {
      const extra = wts.slice(1);
      if (link.state === 'ok') {
        const unmounted = extra.filter((e) => { try { lstatSync(tasksDirOf(e.path)); return false; } catch { return true; } });
        worktrees = { total: extra.length, mounted: extra.length - unmounted.length };
        if (unmounted.length) flags.push(`${unmounted.length} worktree(s) unmounted — run mount`);
      } else {
        worktrees = { total: extra.length, mounted: null };
      }
    }

    // One task load per project, feeding both the file count and the schema-drift
    // block below — the report used to load them twice.
    let tasks = null;
    if (existsSync(td)) { try { tasks = loadTasks(td); } catch { tasks = null; } }
    if (tasks && tasks.length) {
      const { results, errorCount, warningCount } = validateTasks(tasks);
      drift.totalErrors += errorCount;
      drift.projects.push({
        slug: p.slug,
        errorCount,
        warningCount,
        errorFiles: results.filter((x) => x.errors.length).map((x) => ({ file: x.file, errors: x.errors })),
      });
    }

    return {
      slug: p.slug,
      path: p.path,
      label: p.label,
      // The task link's path (`.cogyard/tasks` in the project). The settings tab
      // names the link by it, so the literal stays in core/tasks-dir.mjs (task 217).
      tasksDir: td,
      link,
      storePath,
      remote,
      worktrees,
      flags,
      storeBranch,
      storeDirty,
      unpushed,
      lastCommit,
      audit,
      taskCount: tasks ? tasks.length : null,
      sharedWith: [],
    };
  }).filter(Boolean);

  // Sharing is only knowable once every project has been resolved to a canonical
  // store, so it lands after the pass — as the first flag, where the CLI has
  // always printed it.
  for (const r of rows) {
    const slugs = r.link.state === 'ok' ? byCanon.get(r.storePath) : null;
    if (slugs && slugs.length > 1) {
      r.sharedWith = slugs.filter((s) => s !== r.slug);
      r.flags.unshift(`store shared with: ${r.sharedWith.join(', ')}`);
    }
  }

  // `home` is for display only: every store path starts with it, so a table that
  // prints them absolute truncates all rows to the same useless prefix. The
  // caller abbreviates the head to `~` and keeps the absolute path in the title.
  return { rows, drift, home: HOME };
}

export { storeHealth, canonicalStore, storeLinkState, storeSharedWith };
