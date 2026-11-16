// core/job-output.mjs — WHERE the nightly jobs' output lives (task 187).
//
// Three kinds of file, all machine-level, all under $COGYARD_HOME:
//
//   briefs/<slug>/YYYY-MM-DD.md      the project-brief add-on (task 120)
//   heartbeats/<slug>/<job-id>.md    any job that watches the project (134, 139)
//   drift/<slug>.md                  the doc-drift add-on (task 119)
//
// They used to live INSIDE each project's task store, next to the task files.
// Nothing ever committed them (task 120 forbade the job from committing), so
// they sat pending until an unrelated `sync push` swept them into its commit —
// twice (tasks 176, 186). None of them is task data, and a heartbeat is a fact
// about ONE machine, which is wrong in a shared team store. So they moved here,
// beside jobs.json and pricing.json. The accepted cost: no git history of
// briefs and no cross-machine sync.
//
// NOT <project>/.cogyard/ — that is the per-project folder (tasks 159/160), and
// every worktree has its own copy of the project folder, so job output there
// would split per worktree. Same folder NAME, different folder.
//
// This module is the one place core spells the layout. The add-ons that WRITE
// these files install outside the repo and cannot import core synchronously, so
// each carries a second spelling of the same three lines — docs/ADDONS.md is the
// contract, and test/briefs.test.mjs + test/doc-drift-addon.test.mjs assert the
// writers land exactly where these readers look.
//
// A project whose slug changed (task 195): a checkout that moves is
// re-registered under a new slug, with its old paths kept as `aliases`, so the
// output written before the move sits under the OLD slug. The readers take a
// project's current slug and also look under each former one (outputSlugs);
// the writers keep writing only under the current slug. Nothing is moved.

import { join } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { readRegistry, formerSlugs } from './registry.mjs';

const BRIEFS_ROOT = join(COGYARD_HOME, 'briefs');
const HEARTBEATS_ROOT = join(COGYARD_HOME, 'heartbeats');
const DRIFT_ROOT = join(COGYARD_HOME, 'drift');

// A slug becomes a path segment, so anything that could climb out of the root
// (a separator, `..`) reads as "no such project" rather than a path elsewhere.
// Registry slugs never look like that; this is the guard, not the rule.
function safeSlug(slug) {
  const s = String(slug ?? '');
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..' ? s : null;
}

function briefsDir(slug) {
  const s = safeSlug(slug);
  return s ? join(BRIEFS_ROOT, s) : null;
}

function heartbeatsDir(slug) {
  const s = safeSlug(slug);
  return s ? join(HEARTBEATS_ROOT, s) : null;
}

function driftPath(slug) {
  const s = safeSlug(slug);
  return s ? join(DRIFT_ROOT, `${s}.md`) : null;
}

// Every slug a project's output may sit under: the current one first, then the
// slug each of its aliases was registered under. A slug the registry doesn't
// know is just itself. Reads the registry, so callers ask once per answer.
function outputSlugs(slug) {
  const s = safeSlug(slug);
  if (!s) return [];
  const entry = readRegistry().find((p) => p.slug === s);
  return [s, ...(entry ? formerSlugs(entry) : []).filter((f) => safeSlug(f) && f !== s)];
}

export { BRIEFS_ROOT, HEARTBEATS_ROOT, DRIFT_ROOT, safeSlug, outputSlugs, briefsDir, heartbeatsDir, driftPath };
