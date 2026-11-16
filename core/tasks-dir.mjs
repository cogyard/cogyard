// core/tasks-dir.mjs — where a project's task directory is (task 160). One
// answer for every reader in core, cli, server and hooks.
//
// THE LINK MOVED INTO COGYARD'S FOLDER. A project's tasks live in a shared store
// outside the repo (`<COGYARD_PROJECTS_ROOT>/_tasks/<slug>`, task 015); the repo
// only holds a gitignored link to it. That link used to be `_tasks` at the top
// of the project — the one piece of cogyard clutter visible in Finder and `ls`.
// New links are `.cogyard/tasks`. The task FILES never move.
//
// THE OLD NAME IS NOT READ. Every registered project was moved by task 183,
// which removed the `_tasks` fallback. The one place cogyard still looks for
// `_tasks` is IN_REPO_TASKS_DIR below: an existing repo that keeps its tasks in
// an in-repo `_tasks/` folder, which `convert` / `onboard` adopt into a shared
// store. Nothing else ever reads tasks from there. oldTasksDir() below only
// NAMES a leftover `_tasks`, so a project an older release set up is reported
// with its fix instead of looking like it has no tasks at all.
//
// "Present" is lstat, not stat: a BROKEN link is still the project's task
// directory (the registry reports it as broken rather than dropping the project).
//
// THE LINK IS IGNORED BY `.cogyard/.gitignore`, a committed file holding one
// line (`/tasks`), not by a line in the project's root `.gitignore`: what cogyard
// adds to a project stays inside cogyard's folder.
//
// Dependency-free on purpose: hooks import this and must stay cheap.

import { lstatSync, existsSync, readFileSync, writeFileSync, mkdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const TASKS_DIR = join('.cogyard', 'tasks');
// An in-repo task folder an existing repo may already have. Only `convert` /
// `onboard` look for it — as something to adopt into a shared store.
const IN_REPO_TASKS_DIR = '_tasks';
const TASKS_IGNORE = join('.cogyard', '.gitignore');
const IGNORE_LINE = '/tasks';

function present(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

// { path } — the absolute path of the task link (`.cogyard/tasks`), whatever is
// there (a broken link or a stray folder included; store-health says which) — or
// null when the project has none.
function locateTasksDir(projectRoot) {
  const path = join(projectRoot, TASKS_DIR);
  return present(path) ? { path } : null;
}

// The task directory path for a project — the one that exists, else the new
// location (callers that only read check existence themselves; callers that
// create use TASKS_DIR explicitly).
function tasksDirOf(projectRoot) {
  const found = locateTasksDir(projectRoot);
  return found ? found.path : join(projectRoot, TASKS_DIR);
}

// A top-level `_tasks` in a project that has no `.cogyard/tasks` — what a release
// before the move left behind: a link to a shared store, or a folder of task
// files tracked in the repo. Never read for tasks; found only so the registry and
// both doctors can say what is there and how to move it.
// → { path, kind: 'link' | 'folder', target } or null.
function oldTasksDir(projectRoot) {
  if (locateTasksDir(projectRoot)) return null;
  const path = join(projectRoot, IN_REPO_TASKS_DIR);
  let l;
  try { l = lstatSync(path); } catch { return null; }
  if (l.isSymbolicLink()) {
    let target = '';
    try { target = readlinkSync(path); } catch {}
    return { path, kind: 'link', target };
  }
  return l.isDirectory() ? { path, kind: 'folder', target: null } : null;
}

// One line naming what oldTasksDir() found and how to move it — the same words
// in the registry's error row, `cogyard doctor` and `cogyard tasks doctor`. A
// link has no one command (convert refuses it with these same steps); a folder
// is what `convert` adopts.
function oldTasksDirProblem(found) {
  return found.kind === 'link'
    ? `old task link ${IN_REPO_TASKS_DIR} → ${found.target}, which cogyard no longer reads — link ${TASKS_DIR} to the same target, add ${IGNORE_LINE} to ${TASKS_IGNORE}, then remove ${IN_REPO_TASKS_DIR}`
    : `old task folder ${IN_REPO_TASKS_DIR}/, which cogyard no longer reads — run \`cogyard tasks convert\` in the project to move it into a shared task store`;
}

// Make sure `.cogyard/.gitignore` ignores the link. Append-only: anything else
// in the file is kept. Returns true when it wrote (the caller stages and commits
// TASKS_IGNORE), false when the line was already there.
function ensureTasksLinkIgnored(projectRoot) {
  const p = join(projectRoot, TASKS_IGNORE);
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (text.split('\n').some((l) => ['/tasks', 'tasks', '/tasks/', 'tasks/'].includes(l.trim()))) return false;
  mkdirSync(join(projectRoot, '.cogyard'), { recursive: true });
  const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  writeFileSync(p, `${prefix}# the link to this project's shared task store (cogyard) — machine-local, never committed\n${IGNORE_LINE}\n`);
  return true;
}

// Add `/.cogyard/tasks` to a repo's shared `info/exclude` — one file for the
// main checkout and every worktree, never committed. For a worktree whose branch
// predates the project's `.cogyard/.gitignore`, where the link would otherwise
// show as untracked. `commonGitDir` is `git rev-parse --git-common-dir`,
// absolute. Append-only.
function excludeTasksLink(commonGitDir) {
  const p = join(commonGitDir, 'info', 'exclude');
  const line = `/${TASKS_DIR}`;
  const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === line)) return false;
  mkdirSync(join(commonGitDir, 'info'), { recursive: true });
  writeFileSync(p, `${text === '' || text.endsWith('\n') ? text : `${text}\n`}# cogyard: the link to the shared task store\n${line}\n`);
  return true;
}

export { TASKS_DIR, IN_REPO_TASKS_DIR, TASKS_IGNORE, locateTasksDir, tasksDirOf, oldTasksDir, oldTasksDirProblem, ensureTasksLinkIgnored, excludeTasksLink };
