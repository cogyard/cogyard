// core/plan.mjs — the plan view (task 179): what's left in a project, laid out
// in the order it can run. ONE source of truth for `cogyard tasks plan`,
// GET /api/plan and the portal's Plan tab, so they can never disagree.
//
// Everything here is DERIVED from what the task files and git already record —
// never a stored priority, never age (owner, 2026-10-06: priorities shift too
// often to maintain by hand, and age is no proxy for importance).
//
// Each open task lands in exactly ONE group, by one plain rule (the Plan tab's
// tooltips use the same words, so the page can always say why a card is where
// it is):
//
//   progress  OPEN and claimed — whether or not its worktree still exists (a
//             claim is valid only on an OPEN task: a closed task with more work
//             is reopened first, and a claim left on a closed or parked task is
//             a validator error, task 222). A claim is
//             the owner's word that the task is held; a removed worktree is
//             flagged on the card (worktreeMissing), never a reason to move the
//             task (owner, 2026-10-07, task 189)
//   look      PARKED, and built — its branch has commits not on main, or 80%+
//             of its checkboxes are ticked
//   other     its depends_on lists an unfinished task in ANOTHER project
//   dep       its depends_on lists an unfinished task here
//   can       nothing in its depends_on is unfinished (the task more others wait
//             on first; then the lower number)
//   parked    every other PARKED task (the Plan tab's last group)
//
// ONLY depends_on makes a task wait — the Tasks tab's rule (core/status.mjs
// bucketOf), so the two tabs never disagree. Sharing a file or a resource with
// another task answers a different question: can the two run AT THE SAME TIME?
// Either may go first. That is each task's `clash` list — every other active
// task it shares a file (touches_paths) or a name (resources: a production
// database, DNS, a device…) with — read by autopilot's batches and the Plan
// tab's Autopilot filter, never shown as a wait. (Owner, 2026-10-21 and
// 2026-11-02, task 239: an inferred file hold read as a dependency nobody
// recorded, and put a task the Tasks tab called ready under "waiting on #N".
// Until then a free task sharing code with a running or chosen task sat in a
// "code" group behind it.)
//
// A task whose status is none of the known ones lands in no group and is listed
// in `problems` instead (kind unknown-status), so nothing open disappears.
//
// Plus, per task: who waits on it (waitedOnBy — the card's "frees"), which other
// project's tasks wait on it, and the steps only the owner can do (checkboxes
// marked `(you: …)`, core/frontmatter.mjs checkboxSteps).
//
// And where each task's CODE is (task 251) — `code` and, per counted box in file
// order, `boxes` (the card's squares):
//
//   none    no branch (or it is gone) and no `[#N]` commit on main — nothing to say
//   merged  main has a `[#N]` commit, and the branch is gone or has nothing main
//           lacks. 0 ahead alone is not a merge: a branch never committed to has
//           0 ahead too, so the `[#N]` commit (the commit skill's prefix) decides
//   ahead   the branch has commits main lacks. If main also has `[#N]` commits
//           (merged, then worked on again), each ticked box is on main when it
//           was ticked at or before the last merge (+ MERGE_GRACE_MS), else not
//
// A box's `onMain` is null for an unticked box and for every box of a `none`
// task; otherwise true / false by the rules above.
//
// computePlan() is pure (plain inputs, no fs/git) so the rules are testable;
// planFor() gathers the inputs for a registered project.

import { join, basename, dirname } from 'node:path';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { gitP, defaultBranch } from './exec.mjs';
import { loadTasks, computeDerived, taskLabels, checkboxSteps, countedBoxes } from './frontmatter.mjs';
import { isOpen, isValidStatus } from './status.mjs';
import { normalizeTaskId } from './validate.mjs';
import { gitWorktrees } from './worktrees.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { liveForTask, claimedByOther, cachedUser } from './live-state.mjs';
import { whoAmI } from './close.mjs';

// A folder entry that says nothing about WHICH files: top-level (docs/, core/,
// cli/ …) or covering more tracked files than this. Ignored for clashes.
const BROAD_FOLDER_FILES = 40;
// "Done once you look": a parked task this far through its boxes is built.
const REVIEW_RATIO = 0.8;
// Size bands on unticked boxes (the mockup's Quick / Long pull filters).
const QUICK_MAX = 7;
const LONG_MIN = 15;
// Boxes are usually ticked a minute or two AFTER the merge that shipped them
// (#239: merged 13:30, its boxes committed 13:31), so a box ticked this soon
// after a task's last merge still counts as on main. Longer than a merge's
// tidy-up, shorter than a real round of follow-up work.
const MERGE_GRACE_MS = 30 * 60 * 1000;

// Task ids are TEXT — `40`, `40.1` (a sub-task) and `40e` (a letter suffix) are
// all valid (core/validate.mjs normalizeTaskId) — so they are never Number()ed:
// another project's `040e` crashed the page when it was.
// `slug#N` → { slug, id } ; `N` / N → { slug: null, id }, id normalized.
function parseDep(d) {
  const m = String(d).trim().match(/^(?:([A-Za-z0-9._-]+)#)?(\d+(?:[._]\d+)?[a-z]?)$/);
  const id = m ? normalizeTaskId(m[2]) : null;
  return id ? { slug: m[1] || null, id } : null;
}
// Ids sort the way people read them: 9 < 40 < 40e < 133.
const idCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const isLocal = (d) => !String(d).includes('#');

// A short display name: the title up to its first " — " / ":" , capped.
function shortTitle(title) {
  const s = String(title || '').split(/\s+—\s+|:\s+/)[0].trim();
  return s.length > 48 ? s.slice(0, 46).trimEnd() + '…' : s;
}

// The opening of a task's "What this is" section, as plain words: prose
// paragraphs only (no headings, quotes, tables, lists or code), taken until
// there is enough to read — a one-line opener alone says little.
function whatThisIs(body) {
  // No "What this is" section (older tasks)? Then the first prose of the body.
  const parts = String(body || '').split(/^## What this is\s*$/m);
  const sec = parts.length > 1 ? parts[1].split(/^## /m)[0] : parts[0];
  const paras = sec.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^(#|>|\||[-*] |\d+\. |```|<)/.test(p));
  let what = '';
  for (const p of paras) { what += (what ? ' ' : '') + p; if (what.length >= 220) break; }
  what = what.replace(/\s+/g, ' ').replace(/\*\*|`/g, '').trim();
  return what.length > 320 ? what.slice(0, 317).replace(/\s+\S*$/, '') + '…' : what;
}

// Split a task's touches_paths into specific entries (files, or narrow folders
// ending in '/') and ignored broad folders. `tracked` = repo-relative files.
function classifyPaths(paths, tracked, isDir) {
  const files = [], broad = [], outside = [];
  for (const raw of paths || []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const p = raw.trim();
    if (p.startsWith('~/') || p.startsWith('/')) { outside.push(p); continue; }
    const dir = p.endsWith('/') || isDir(p);
    if (!dir) { files.push(p); continue; }
    const pre = p.replace(/\/?$/, '/');
    const n = tracked.filter((f) => f.startsWith(pre)).length;
    if (pre.split('/').length <= 2 || n > BROAD_FOLDER_FILES) broad.push(pre);
    else files.push(pre);
  }
  return { files, broad, outside };
}

const covers = (p, q) => p === q || (p.endsWith('/') && q.startsWith(p)) || (q.endsWith('/') && p.startsWith(q));
const overlap = (a, b) => a.files.filter((p) => b.files.some((q) => covers(p, q)));
// A shared code file is a clash (the two shouldn't run at once); a shared
// Markdown doc merges easily, so it is a soft clash — shown, never counted.
const hardOverlap = (a, b) => overlap(a, b).filter((p) => !p.endsWith('.md'));
const softOverlap = (a, b) => overlap(a, b).filter((p) => p.endsWith('.md'));
// A resource is a short name for something live that isn't a file (task 239).
const resourcesOf = (fm) => (Array.isArray(fm.resources) ? fm.resources : fm.resources == null ? [] : [fm.resources])
  .filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
const sharedResources = (a, b) => a.resources.filter((r) => b.resources.includes(r));

// Where a task's code is (task 251; the rules in the header). `branch` is the
// name only while the branch still exists.
function codeState({ id, branch, branchAhead, branchBehind, lastMerge }) {
  const exists = !!branch && branchAhead.has(branch);
  const ahead = exists ? branchAhead.get(branch) || 0 : 0;
  const behind = exists ? branchBehind.get(branch) || 0 : 0;
  const state = ahead > 0 ? 'ahead' : lastMerge.has(id) ? 'merged' : 'none';
  return { state, ahead, behind, branch: exists ? branch : null };
}

// One entry per counted box, in file order: { done, onMain } (rules in the header).
function boxesOf(body, code, mergedAt, ticks, now) {
  return countedBoxes(checkboxSteps(body || '')).map((s) => {
    if (!s.done || code.state === 'none') return { done: s.done, onMain: null };
    if (code.state === 'merged') return { done: true, onMain: true };
    if (mergedAt == null) return { done: true, onMain: false }; // ahead, never merged
    const at = ticks?.get(s.line) ?? now;
    return { done: true, onMain: at <= mergedAt + MERGE_GRACE_MS };
  });
}

/**
 * @param {object} input
 *   slug          this project's registry slug
 *   tasks         [{ frontmatter, body, derived }] — this project's task files,
 *                 `derived` from computeDerived (box counts)
 *   tracked       repo-relative tracked file paths (git ls-files)
 *   isDir(p)      is repo-relative p a directory?
 *   liveWorktrees Set of worktree NAMES that exist (basename of their path)
 *   branchAhead   Map<branchName, commitsNotOnDefaultBranch> — a branch missing
 *                 from it doesn't exist (task 251)
 *   branchBehind  Map<branchName, defaultBranchCommitsNotOnIt>
 *   lastMerge     Map<taskId, ms> — the newest `[#N]` commit time on the default
 *                 branch per task id (task 251)
 *   tickTimes     Map<taskId, Map<bodyLine, ms>> — when each box line was last
 *                 changed (git blame); only for ahead-and-merged-before tasks.
 *                 A line missing from it counts as `now` (not committed yet)
 *   now           ms, for tick times (default Date.now())
 *   dependents    [{ project, id, title, status, dep: <id in THIS project> }] —
 *                 other projects' open tasks that depend on one of ours
 *   liveOf(fm)    what the agent on a claimed task is doing now, or null
 *                 (core/live-state.mjs liveForTask; task 202)
 *   otherOf(fm)   true when someone other than this machine's user claimed it
 */
function computePlan(input) {
  const { slug, tasks: raw, tracked = [], isDir = () => false, liveWorktrees = new Set(),
    branchAhead = new Map(), branchBehind = new Map(), lastMerge = new Map(), tickTimes = new Map(), now = Date.now(),
    dependents = [], liveOf = () => null, otherOf = () => false } = input;
  const problems = [];

  const all = [];
  for (const t of raw) {
    const fm = t.frontmatter || {};
    const id = normalizeTaskId(fm.id);
    // A status the plan doesn't know (missing, misspelt, retired) can't be
    // placed in any group — say so rather than letting the task vanish (task 186).
    if (id != null && !isValidStatus(fm.status)) {
      problems.push({ id, kind: 'unknown-status', text: `status "${fm.status ?? ''}" isn't one the plan knows — it appears in no group` });
      continue;
    }
    if (id == null || !isOpen(fm.status)) continue;
    const done = t.derived?.checkedCount ?? 0, total = t.derived?.totalCount ?? 0; // computeDerived's count — one checkbox rule
    const left = total - done;
    const deps = (Array.isArray(fm.depends_on) ? fm.depends_on : fm.depends_on == null ? [] : [fm.depends_on])
      .map(parseDep).filter(Boolean);
    // Which deps are unmet is computeDerived's call (it also resolves `slug#N`
    // through the registry) — one rule for the task list and the plan.
    const unmet = (t.derived?.unmetDeps || []).map(parseDep).filter(Boolean)
      .map((d) => (d.slug && d.slug !== slug ? `${d.slug}#${d.id}` : d.id));
    const env = fm.env || {};
    const claimed = !!env.claimed_at;
    const live = !!(env.worktree && liveWorktrees.has(env.worktree));
    const ahead = env.branch ? (branchAhead.get(env.branch) || 0) : 0;
    const code = codeState({ id, branch: env.branch, branchAhead, branchBehind, lastMerge });
    const boxList = boxesOf(t.body, code, lastMerge.get(id), tickTimes.get(id), now);
    const paths = classifyPaths(fm.touches_paths, tracked, isDir);
    // Owner steps come from computeDerived too — one checkbox rule everywhere.
    const youNext = t.derived?.youNext || null;
    const youSteps = t.derived?.youOpen || [];
    const youLater = [...new Set(youSteps.slice(youNext ? 1 : 0).flatMap((s) => s.kinds))];
    all.push({
      id, title: String(fm.title || ''), name: shortTitle(fm.title), status: fm.status,
      type: fm.type || null, labels: taskLabels(fm), what: whatThisIs(t.body),
      done, total, left, size: left <= QUICK_MAX ? 'quick' : left >= LONG_MIN ? 'long' : 'mid',
      deps, unmet, claimed, claimedBy: env.claimed_by || null, claimedAt: env.claimed_at || null,
      claimedByOther: otherOf(fm), agent: claimed ? liveOf(fm) : null, live, ahead, code, boxes: boxList,
      ...paths, filesUnknown: paths.files.length === 0, resources: resourcesOf(fm),
      youNext, youLater, youSteps, blocksOther: [], touchesOther: paths.outside.length > 0,
    });
    if (claimed && !live) problems.push({ id, kind: 'stale-claim', text: `claimed since ${String(env.claimed_at).slice(0, 10)} but its worktree is missing` });
    if (paths.broad.length) problems.push({ id, kind: 'broad-paths', text: `lists whole folders (${paths.broad.join(', ')}) — ignored for clashes` });
    if (!(fm.touches_paths || []).length) problems.push({ id, kind: 'no-paths', text: 'lists no files — clashes cannot be checked' });
  }
  const T = new Map(all.map((t) => [t.id, t]));
  for (const d of dependents) {
    const t = T.get(normalizeTaskId(d.dep));
    if (t) t.blocksOther.push({ project: d.project, id: d.id, title: d.title, status: d.status });
  }

  // ---- buckets -------------------------------------------------------------
  const running = all.filter((t) => t.status === 'OPEN' && t.claimed);
  const review = all.filter((t) => t.status === 'PARKED' && (t.ahead > 0 || (t.total > 0 && t.done / t.total >= REVIEW_RATIO)));
  const parked = all.filter((t) => t.status === 'PARKED' && !review.includes(t));
  const todo = all.filter((t) => t.status === 'OPEN' && !running.includes(t));

  // Clashes are computed among the tasks that can actually run (todo + running
  // + review, whose branches are real code) — a parked-by-choice task holds
  // nothing back.
  const active = [...todo, ...running, ...review];
  for (const t of all) {
    t.clash = active.filter((u) => u !== t)
      .map((u) => ({ id: u.id, files: hardOverlap(t, u), resources: sharedResources(t, u) }))
      .filter((c) => c.files.length || c.resources.length);
    t.softClash = active.filter((u) => u !== t && !hardOverlap(t, u).length && softOverlap(t, u).length)
      .map((u) => ({ id: u.id, files: softOverlap(t, u) }));
    t.unblocks = all.filter((u) => u.deps.some((d) => (!d.slug || d.slug === slug) && d.id === t.id)).map((u) => u.id);
  }

  // ---- groups (rules in the header) --------------------------------------
  for (const t of all) t.waitedOnBy = [];
  const other = [], dep = [];
  for (const t of todo) {
    if (t.unmet.some((d) => !isLocal(d))) { other.push(t); t.waitsFor = t.unmet.filter((d) => !isLocal(d)); }
    else if (t.unmet.length) {
      dep.push(t); t.waitsFor = t.unmet;
      for (const d of t.unmet) T.get(d)?.waitedOnBy.push(t.id);
    }
  }
  // Every free task can start — the one more others wait on first. What it
  // shares with another task is in its `clash` list, never a reason to wait.
  const can = todo.filter((t) => !t.unmet.length)
    .sort((a, b) => b.waitedOnBy.length - a.waitedOnBy.length || idCmp(a.id, b.id));

  // A dep on a task that will never run (parked, or missing) can't clear by
  // itself — say so rather than leaving the task waiting silently.
  for (const t of dep) {
    const stuck = t.unmet.filter((d) => !T.get(d) || parked.some((p) => p.id === d));
    if (stuck.length) problems.push({ id: t.id, kind: 'blocked-by-unscheduled', text: `waits on ${stuck.map((d) => '#' + d).join(', ')}, which is parked or missing` });
  }

  // Waiting groups come in boxes, one per thing waited for.
  const boxes = (list) => {
    const m = new Map();
    for (const t of list) {
      const k = t.waitsFor.join(',');
      if (!m.has(k)) m.set(k, { after: t.waitsFor, tasks: [] });
      m.get(k).tasks.push(t.id);
    }
    return [...m.values()].map((g) => ({ ...g, tasks: g.tasks.sort(idCmp) })).sort((x, y) => idCmp(x.after[0], y.after[0]));
  };

  const out = (t) => ({
    id: t.id, title: t.title, name: t.name, type: t.type, labels: t.labels, what: t.what, status: t.status,
    done: t.done, total: t.total, left: t.left, size: t.size, boxes: t.boxes, code: t.code,
    unmet: t.unmet, unblocks: t.unblocks, waitedOnBy: t.waitedOnBy.slice().sort(idCmp), blocksOther: t.blocksOther,
    clash: t.clash, softClash: t.softClash, filesUnknown: t.filesUnknown, resources: t.resources,
    // Entries the clash check can't use — whole folders and paths outside the
    // repo — so autopilot asks before running it beside others (task 239).
    skippedPaths: [...t.broad, ...t.outside],
    youNext: t.youNext, youLater: t.youLater, youSteps: t.youSteps,
    touchesOther: t.touchesOther || t.blocksOther.length > 0,
    startNow: can.includes(t), claimedBy: t.claimedBy, worktreeMissing: t.claimed && !t.live,
    claimedAt: t.claimedAt, claimedByOther: t.claimedByOther, agent: t.agent,
  });
  const ids = (list) => list.map((t) => t.id);
  return {
    slug,
    groups: {
      progress: ids(running.slice().sort((a, b) => idCmp(a.id, b.id))),
      can: ids(can),
      dep: boxes(dep),
      other: boxes(other),
      look: ids(review.slice().sort((a, b) => idCmp(a.id, b.id))),
    },
    parked: ids(parked.slice().sort((a, b) => idCmp(a.id, b.id))),
    tasks: Object.fromEntries(all.map((t) => [t.id, out(t)])),
    problems,
  };
}

// Gather the inputs for a registered project and compute its plan.
// `projects` = discoverProjects() (for cross-project deps both ways).
async function planFor(proj, projects = []) {
  const tasks = loadTasks(tasksDirOf(proj.path));
  for (const t of tasks) t.derived = computeDerived(t, tasks, proj.path, false);
  const tracked = ((await gitP(['ls-files'], proj.path)) || '').split('\n').filter(Boolean);
  const isDir = (p) => { try { return statSync(join(proj.path, p)).isDirectory(); } catch { return false; } };
  const liveWorktrees = new Set(gitWorktrees(proj.path).map((w) => basename(w.path)));

  // Where each open task's code is (task 251; also the "built, waiting on you"
  // signal for a parked task): commits ahead of and behind the default branch on
  // its recorded branch — one git call per OPEN or PARKED task with a branch; a
  // failing call means the branch is gone — and the newest `[#N]` commit per
  // task id on the default branch, from one scan of its log.
  const branchAhead = new Map(), branchBehind = new Map(), lastMerge = new Map(), tickTimes = new Map();
  const trunk = await defaultBranch(proj.path);
  if (trunk) {
    const withBranch = tasks.filter((t) => isOpen(t.frontmatter?.status) && t.frontmatter?.env?.branch);
    const [log] = await Promise.all([
      gitP(['log', trunk, '--format=%ct%x01%s'], proj.path),
      ...withBranch.map(async (t) => {
        const b = t.frontmatter.env.branch;
        const lr = await gitP(['rev-list', '--left-right', '--count', `${trunk}...${b}`], proj.path);
        const m = lr && lr.match(/^(\d+)\s+(\d+)$/);
        if (m) { branchBehind.set(b, Number(m[1])); branchAhead.set(b, Number(m[2])); }
      }),
    ]);
    for (const [id, at] of lastMergeByTask(log)) lastMerge.set(id, at);
    // Tick times only where they decide a colour: ahead AND merged before (rare).
    await Promise.all(withBranch.map(async (t) => {
      const id = normalizeTaskId(t.frontmatter.id);
      if (!(branchAhead.get(t.frontmatter.env.branch) > 0 && lastMerge.has(id))) return;
      const ticks = await blameBodyLines(t.path);
      if (ticks) tickTimes.set(id, ticks);
    }));
  }

  // Other projects' open tasks that depend on ours (`<slug>#N`) — what we block.
  const storeCache = new Map();
  const storeOf = (slug) => {
    if (storeCache.has(slug)) return storeCache.get(slug);
    const p = projects.find((x) => x.slug === slug && !x.error);
    const list = p && existsSync(tasksDirOf(p.path)) ? loadTasks(tasksDirOf(p.path)) : [];
    storeCache.set(slug, list);
    return list;
  };
  const dependents = [];
  for (const p of projects) {
    if (p.error || p.slug === proj.slug) continue;
    for (const t of storeOf(p.slug)) {
      const fm = t.frontmatter || {};
      if (!isOpen(fm.status)) continue;
      for (const d of (Array.isArray(fm.depends_on) ? fm.depends_on : []).map(parseDep).filter(Boolean)) {
        if (d.slug === proj.slug) dependents.push({ project: p.slug, id: normalizeTaskId(fm.id), title: String(fm.title || ''), status: fm.status, dep: d.id });
      }
    }
  }

  const user = cachedUser(whoAmI);
  return computePlan({ slug: proj.slug, tasks, tracked, isDir, liveWorktrees, branchAhead, branchBehind, lastMerge, tickTimes, dependents,
    liveOf: (fm) => liveForTask(fm, { user }), otherOf: (fm) => claimedByOther(fm, user) });
}

// The newest `[#N]` commit time per task id, from `git log --format=%ct%x01%s`
// (newest first, so the first hit per id is its last merge): Map<id, ms>. The
// id is read whole from the brackets, so `[#23]` never counts for 239. With the
// rebase switch on, /merge-to-main rebases before merging, so a commit's
// committer time is when it reached main; without it, it is the task's last
// commit time — close enough for "ticked before or after the merge".
function lastMergeByTask(log) {
  const out = new Map();
  for (const line of String(log || '').split('\n')) {
    const [ct, subject = ''] = line.split('\x01');
    const id = normalizeTaskId(subject.match(/^\[#([^\]\s]+)\]/)?.[1]);
    if (id != null && !out.has(id)) out.set(id, Number(ct) * 1000);
  }
  return out;
}

// When each line of a task file's BODY last changed, from `git blame` in its
// task store (a git repo): Map<bodyLine, ms>, body lines counted the way
// taskFromContent splits the file. A line not committed yet blames to now; a
// line reworded after its tick counts from the rewording (accepted, task 251).
// null when the file can't be blamed (not in a repo, never committed).
async function blameBodyLines(taskPath) {
  let file;
  try { file = realpathSync(taskPath); } catch { return null; }
  const out = await gitP(['blame', '--line-porcelain', '--', basename(file)], dirname(file));
  return out ? bodyLineTimes(out) : null;
}
// `git blame --line-porcelain` output → Map<bodyLine, ms> (author time).
function bodyLineTimes(porcelain) {
  const lines = []; // [{ at, text }] in file order
  let at = null;
  for (const l of porcelain.split('\n')) {
    if (l.startsWith('author-time ')) at = Number(l.slice(12)) * 1000;
    else if (l.startsWith('\t')) lines.push({ at, text: l.slice(1) });
  }
  // The body starts after the closing `---` (taskFromContent's split).
  let start = 0;
  if (lines[0]?.text === '---') {
    const end = lines.findIndex((x, i) => i > 1 && x.text === '---'); // taskFromContent searches from offset 4
    if (end > 0) start = end + 1;
  }
  return new Map(lines.slice(start).map((x, i) => [i, x.at]));
}

export { computePlan, planFor, parseDep, lastMergeByTask, bodyLineTimes, BROAD_FOLDER_FILES, QUICK_MAX, LONG_MIN, MERGE_GRACE_MS };
