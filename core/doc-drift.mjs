// core/doc-drift.mjs — which project docs the tasks left behind.
//
// The candidate query, and ONLY the candidate query: a cheap, agent-free read
// over `touches_paths` and git history that says "this doc looks stale". It
// never decides that a doc IS wrong — plenty of code changes don't invalidate
// the prose describing them, and that judgement is the expensive half (the
// doc-drift add-on asks an agent). Keeping the query here means it stands on
// its own: no add-on, no scheduler, no credential, no cost.
//
// How a doc gets associated with code, without a new frontmatter field:
// task files already declare `touches_paths`, and a task that reshapes an area
// AND its doc lists both. So a task saying "I touch docs/ADDONS.md and
// core/addons/" is what tells us ADDONS.md describes core/addons/. Docs no task
// has ever declared touching have no area and are never candidates — an
// association we'd have to guess at is not evidence.
//
// Which tasks then contradict a doc comes from the commit convention: cogyard
// commits are subject-prefixed `[#NN]`, so the commits in the doc's area since
// the doc last changed name their own tasks. Commits without a prefix are
// counted and reported, but never satisfy the threshold on their own.

import { gitP } from './exec.mjs';
import { loadTasks } from './frontmatter.mjs';
import { tasksDirOf, TASKS_DIR } from './tasks-dir.mjs';

// Right more often than wrong (owner's call, 2026-08-14). Prose that records
// decisions is the target; the task directory is excluded ALWAYS and not by this list —
// task files are the record of intent and are supposed to reflect the moment
// they were written, so they can never be "stale".
const DEFAULT_DOC_GLOBS = ['CLAUDE.md', 'docs/**/*.md', '_docs/**/*.md'];

// The loudness gate (owner's call, 2026-08-14). A report that fires on every
// project every night is a report you stop reading, so the default is quiet:
// sustained churn (>= 2 tasks) AND a real age gap. Both are tunable per machine
// via the add-on's config; neither is derived, so raising them is free.
const DEFAULT_THRESHOLD = { minTasks: 2, minAgeDays: 30 };

// Cap on the git work one project can cause: docs examined, and commits read
// per doc. A repo with 400 docs must not turn the nightly job into a git storm.
const MAX_DOCS = 200;
const MAX_COMMITS_PER_DOC = 200;
const GIT_POOL = 8;

// Two filters on what a declaration is allowed to contribute, both learned from
// running the query against this repo (2026-08-14) and finding it flagged 10 of
// 17 docs:
//
// SWEEPS — a task declaring more than this many code paths is describing a pass
// over the whole repo, not an area. Its declaration says nothing about which
// code a doc it happened to name is about. (cogyard's worst: 21 paths + 6 docs.)
const MAX_TASK_PATHS = 12;
// HUBS — a path declared by a large share of all tasks (`server/index.mjs`,
// `frontend/src/app/`, `package.json`) is where everything lands. Left in an
// area it makes the doc permanently a candidate, because SOMETHING always
// touches it. The share, not a fixed count, so it scales with a project's
// history; the floor keeps it sane on a young project with six tasks.
const HUB_SHARE = 0.04;
const HUB_FLOOR = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// --- path matching ------------------------------------------------------------

// Minimal glob → RegExp: `**` spans separators, `*` and `?` do not. Deliberately
// not a dependency — these patterns are ours (three defaults plus whatever a
// machine configures), and the whole engine ships zero runtime deps.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `a/**/b` must also match `a/b` — swallow the slash with the star.
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matchesGlob(path, glob) {
  return globToRe(glob).test(path);
}

// Does a `touches_paths` entry cover this file? Entries are written loosely —
// `docs/ADDONS.md` (exact), `docs/` (a directory), `frontend/src/app/**` (a
// glob) — and all three have to work.
function entryCovers(entry, path) {
  const e = String(entry).trim().replace(/^\.\//, '');
  if (!e || e.startsWith('~/')) return false; // outside the repo: not ours to judge
  if (e === path) return true;
  if (e.endsWith('/') && path.startsWith(e)) return true;
  if (/[*?]/.test(e) && matchesGlob(path, e)) return true;
  // A bare directory entry (`core/addons`) is the common shorthand for "and
  // everything under it".
  return path.startsWith(`${e}/`);
}

// Associating a DOC with a task is stricter than covering a code path: the task
// must NAME the doc (exactly, or by a glob that only matches prose). A task
// listing `docs/` has said "I touched some docs" — reading that as "this task
// maintains every doc in the repo" is what made the first draft flag 10 of 17
// docs, most of them via a task that had never heard of them.
function entryNamesDoc(entry, doc) {
  const e = String(entry).trim().replace(/^\.\//, '');
  if (!e || e.startsWith('~/')) return false;
  if (e === doc) return true;
  return /[*?]/.test(e) && isProsePath(e) && matchesGlob(doc, e);
}

// Is this path specific enough to be a doc's "area"? A single-segment directory
// (`core/`, `test/`, `bin`) is not an area, it is the codebase — every commit
// lands in one, so any doc associated with one is permanently a candidate. Files
// are fine at any depth; directories need at least two segments.
function isSpecificArea(p) {
  const e = p.replace(/\/+$/, '');
  if (!e) return false;
  if (e.includes('/')) return true;
  return /\.[a-z0-9]+$/i.test(e); // a root-level file (package.json), not a root dir
}

// A doc is prose; a code path is what the prose describes. When a task lists
// both, only the non-prose half tells us WHERE the doc's subject lives.
function isProsePath(p) {
  return /\.(md|markdown|txt)$/i.test(p);
}

function inTasksDir(p) {
  return p === TASKS_DIR || p.startsWith(`${TASKS_DIR}/`);
}

// --- inputs -------------------------------------------------------------------

async function trackedDocs(repo, globs) {
  const out = await gitP(['ls-files', '-z', '--', '*.md', '*.markdown'], repo);
  if (!out) return [];
  return out.split('\0')
    .filter(Boolean)
    .filter((p) => !inTasksDir(p))
    .filter((p) => globs.some((g) => matchesGlob(p, g)))
    .sort()
    .slice(0, MAX_DOCS);
}

// Every task's declared paths, split into the prose it claims to maintain and
// the code that prose is about. Closed or open makes no difference here: a DONE
// task's declaration is exactly the historical record we want.
function taskDeclarations(tasksDir) {
  const rows = [];
  for (const t of loadTasks(tasksDir)) {
    const fm = t.frontmatter;
    if (!fm || !Array.isArray(fm.touches_paths)) continue;
    const paths = fm.touches_paths.filter((p) => typeof p === 'string' && p.trim() && !p.trim().startsWith('~/'));
    if (!paths.length) continue;
    rows.push({
      id: Number(fm.id),
      title: fm.title || '',
      status: fm.status || 'UNKNOWN',
      paths: paths.map((p) => p.trim().replace(/^\.\//, '')),
    });
  }
  return rows.filter((r) => Number.isFinite(r.id));
}

// Paths so widely declared they identify nothing. Returned as a Set so the
// caller computes it once per project rather than per doc.
function hubPaths(declarations) {
  const freq = new Map();
  for (const d of declarations) {
    for (const p of new Set(d.paths)) freq.set(p, (freq.get(p) || 0) + 1);
  }
  const limit = Math.max(HUB_FLOOR, Math.ceil(declarations.length * HUB_SHARE));
  return new Set([...freq.entries()].filter(([, n]) => n > limit).map(([p]) => p));
}

// The code paths a doc is about: contributed by every task that named the doc
// alongside them, minus sweeps and hubs. An empty area means "no evidence what
// this doc is about" — the doc is then never a candidate, which is the right
// answer rather than a guess.
function areaFor(doc, declarations, hubs = new Set()) {
  const area = new Set();
  const by = [];
  for (const d of declarations) {
    if (d.paths.length > MAX_TASK_PATHS) continue; // a sweep, not an area
    if (!d.paths.some((p) => entryNamesDoc(p, doc))) continue;
    const code = d.paths.filter((p) => !isProsePath(p) && !inTasksDir(p) && isSpecificArea(p) && !hubs.has(p));
    if (!code.length) continue;
    by.push(d.id);
    for (const p of code) area.add(p);
  }
  return { area: [...area].sort(), declaredBy: by.sort((a, b) => a - b) };
}

// --- the query ----------------------------------------------------------------

// Commits in `area` since the doc last changed, attributed to tasks by the
// `[#NN]` subject prefix the commit skill writes.
async function contradictingCommits(repo, sinceSha, area, ref) {
  const out = await gitP(
    ['log', `-n${MAX_COMMITS_PER_DOC}`, '--format=%H%x1f%cI%x1f%s', `${sinceSha}..${ref}`, '--', ...area],
    repo,
  );
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, date, subject = ''] = line.split('\x1f');
    const m = /^\[#(\d+)\]/.exec(subject);
    return { sha: sha.slice(0, 8), date, subject, taskId: m ? Number(m[1]) : null };
  });
}

async function docLastChange(repo, doc, ref) {
  const out = await gitP(['log', '-1', '--format=%H%x1f%cI', ref, '--', doc], repo);
  if (!out) return null;
  const [sha, date] = out.split('\x1f');
  return { sha, shortSha: sha.slice(0, 8), date };
}

function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / DAY_MS);
}

// Run `jobs` through `fn` with a bounded pool — same posture as the staleness
// prefetch in core/project.mjs: enough concurrency to be fast, not enough to
// fork a process per doc.
async function pooled(jobs, fn, size = GIT_POOL) {
  const queue = [...jobs];
  const out = [];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      const r = await fn(j);
      if (r) out.push(r);
    }
  }));
  return out;
}

// Candidates for one project — docs that LOOK stale, ordered loudest first.
// Never touches a doc, never writes anything, and costs one `git ls-files` plus
// two `git log`s per associated doc.
async function docDriftCandidates(projectPath, opts = {}) {
  const {
    docGlobs = DEFAULT_DOC_GLOBS,
    minTasks = DEFAULT_THRESHOLD.minTasks,
    minAgeDays = DEFAULT_THRESHOLD.minAgeDays,
    ref = 'HEAD',
    now = new Date(),
  } = opts;

  const tasksDir = tasksDirOf(projectPath);
  const declarations = taskDeclarations(tasksDir);
  const docs = await trackedDocs(projectPath, docGlobs);
  const empty = {
    project: projectPath, docsExamined: docs.length, docsAssociated: 0,
    threshold: { minTasks, minAgeDays }, candidates: [],
  };
  if (!docs.length || !declarations.length) return empty;

  const hubs = hubPaths(declarations);
  const associated = docs
    .map((doc) => ({ doc, ...areaFor(doc, declarations, hubs) }))
    .filter((d) => d.area.length > 0);
  empty.docsAssociated = associated.length;
  if (!associated.length) return empty;

  const candidates = await pooled(associated, async ({ doc, area, declaredBy }) => {
    const last = await docLastChange(projectPath, doc, ref);
    if (!last) return null; // never committed on this ref — nothing to be stale against
    const commits = await contradictingCommits(projectPath, last.sha, area, ref);
    if (!commits.length) return null;

    const byTask = new Map();
    let unattributed = 0;
    for (const c of commits) {
      if (c.taskId == null) { unattributed++; continue; }
      if (!byTask.has(c.taskId)) byTask.set(c.taskId, []);
      byTask.get(c.taskId).push(c);
    }
    if (byTask.size < minTasks) return null;

    // The gap the threshold is about: how far the doc has fallen behind the
    // newest work in its own area (not "how old is the doc" — a doc whose area
    // stopped changing is not stale, it is finished).
    const newest = commits.reduce((a, c) => (c.date > a ? c.date : a), commits[0].date);
    const ageDays = daysBetween(last.date, newest);
    if (ageDays < minAgeDays) return null;

    const tasks = [...byTask.entries()]
      .map(([id, cs]) => {
        const d = declarations.find((x) => x.id === id);
        return {
          id,
          title: d?.title || '',
          status: d?.status || 'UNKNOWN',
          declaresDoc: !!d && declaredBy.includes(id),
          commits: cs.map(({ sha, subject, date }) => ({ sha, subject, date })),
        };
      })
      .sort((a, b) => a.id - b.id);

    return {
      doc,
      docLastCommit: { sha: last.shortSha, date: last.date },
      docAgeDays: daysBetween(last.date, now.toISOString()),
      ageDays,
      area,
      declaredBy,
      taskCount: tasks.length,
      commitCount: commits.length,
      unattributedCommits: unattributed,
      newestCommitAt: newest,
      tasks,
    };
  });

  candidates.sort((a, b) => b.taskCount - a.taskCount || b.ageDays - a.ageDays || a.doc.localeCompare(b.doc));
  return { ...empty, candidates };
}

export {
  DEFAULT_DOC_GLOBS, DEFAULT_THRESHOLD, MAX_DOCS, MAX_COMMITS_PER_DOC,
  globToRe, matchesGlob, entryCovers, entryNamesDoc, isSpecificArea, isProsePath,
  trackedDocs, taskDeclarations, hubPaths, areaFor, docDriftCandidates,
};
