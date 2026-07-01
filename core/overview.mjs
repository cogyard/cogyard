// core/overview.mjs — cross-project overview (read-only). Live replacement for
// the stale static tasks-all.html: one row per project with task counts + a
// lightweight git summary (latest commit, worktree count + stale, dirty count
// of the main worktree). Kept git-light: no per-worktree `status`.

import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { gitP } from './exec.mjs';
import { memoize } from './memo.mjs';
import { readState, keyOf } from './refs.mjs';
import { loadTasks } from './frontmatter.mjs';
import { gitWorktrees } from './worktrees.mjs';
import { gitCommits, parseTaskTags } from './git-views.mjs';
import { satisfiesDeps } from './status.mjs';
import { projectUnmerged } from './unmerged.mjs';

const execFileP = promisify(execFile);

// Project size = lines of actual SOURCE code, to answer "how big is this
// codebase" (notepad vs. Windows). Counts only tracked files with a known
// source/markup/style extension — so data (airports.json, *.csv, *.eml),
// lockfiles, minified bundles, binaries, docs, and build output are all
// excluded. Measured on the given checkout's HEAD (the registry path = the
// MAIN checkout; per-worktree dirs are gitignored, so they're never counted).
// Cached per HEAD sha so the pipeline runs once per commit, not every 7s.
const SOURCE_EXTS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'swift', 'scala', 'sh', 'bash',
  'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'lua', 'dart', 'gradle', 'groovy', 'pl', 'pm', 'r', 'ex', 'exs', 'clj',
];
const SOURCE_PATHSPECS = SOURCE_EXTS.map((e) => `*.${e}`);
const sizeCache = new Map(); // repoPath -> { sha, loc, files }
async function projectSize(repoPath) {
  const sha = await gitP(['rev-parse', 'HEAD'], repoPath);
  if (!sha) return { loc: null, files: 0 };
  const hit = sizeCache.get(repoPath);
  if (hit && hit.sha === sha) return { loc: hit.loc, files: hit.files };
  const filesOut = await gitP(['ls-files', '--', ...SOURCE_PATHSPECS], repoPath);
  const files = filesOut ? filesOut.split('\n').filter(Boolean).length : 0;
  let loc = null;
  try {
    const specs = SOURCE_PATHSPECS.map((s) => `'${s}'`).join(' ');
    const { stdout } = await execFileP('bash',
      ['-c', `git ls-files -z -- ${specs} | xargs -0 cat 2>/dev/null | wc -l`],
      { cwd: repoPath });
    loc = parseInt(stdout.trim(), 10);
    if (Number.isNaN(loc)) loc = null;
  } catch { loc = null; }
  sizeCache.set(repoPath, { sha, loc, files });
  return { loc, files };
}

async function lightWorktreeStats(repoPath) {
  const entries = gitWorktrees(repoPath);
  if (!entries.length) return { count: 0, stale: 0 };
  const base = entries[0].branch || entries[0].head;
  const aheadCounts = await Promise.all(entries.map((e, i) => {
    if (i === 0) return Promise.resolve(null);
    const ref = e.branch || e.head;
    return base && ref ? gitP(['rev-list', '--left-right', '--count', `${base}...${ref}`], repoPath) : Promise.resolve(null);
  }));
  let stale = 0;
  for (const c of aheadCounts) { if (c && Number(c.split(/\s+/)[1]) === 0) stale++; }
  return { count: entries.length, stale };
}

// Count tasks from frontmatter only — NO per-task git (the staleness check in
// computeDerived is what makes loadProject slow). Mirrors the viewer's bucket
// logic closely enough for at-a-glance counts.
function taskCountsFromFrontmatter(tasks) {
  const counts = { total: tasks.length, ready: 0, claimed: 0, open: 0, blocked: 0, parked: 0, enough: 0, done: 0 };
  const isDone = (t) => t.frontmatter && t.frontmatter.status === 'DONE';
  for (const t of tasks) {
    const fm = t.frontmatter || {};
    const status = fm.status || 'UNKNOWN';
    if (status === 'DONE') { counts.done++; continue; }
    // ENOUGH is closed (visible, but not active backlog) — don't count it as work to do.
    if (status === 'ENOUGH') { counts.enough++; continue; }
    if (status === 'OBSOLETE') continue;
    const claimed = !!(fm.env && fm.env.claimed_at);
    if (claimed) counts.claimed++;
    const deps = Array.isArray(fm.depends_on) ? fm.depends_on : fm.depends_on == null ? [] : [fm.depends_on];
    const depsMet = deps.every((d) => tasks.some((x) => x.frontmatter && Number(x.frontmatter.id) === Number(d) && satisfiesDeps(x.frontmatter.status)));
    if (status === 'PARKED') counts.parked++;
    else if (status === 'BLOCKED_ON' || !depsMet) counts.blocked++;
    else if (status === 'OPEN' && depsMet && !claimed) counts.ready++;
    else if (status === 'OPEN') counts.open++;
  }
  return counts;
}

async function projectOverview(proj) {
  // Broken-symlink projects (flagged by discoverProjects) render as error rows.
  if (proj.error) return { slug: proj.slug, label: proj.label, error: true, errorDetail: proj.error };
  const tasks = loadTasks(join(proj.path, '_tasks')); // file read only, no git
  const counts = taskCountsFromFrontmatter(tasks); // always fresh — claims change counts with no git change
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];

  // Memoize the GIT summary (latest commit / dirty / worktrees / size). The
  // change-signal is read entirely from ref files — ZERO git spawns on a hit —
  // so polling this endpoint (every 7s) costs a few stat/read calls per project
  // instead of ~2 git processes each. (Task counts above are NOT memoized: they
  // come from frontmatter and change, e.g. a claim, without any git change.)
  //
  // Signal = the ref snapshot (main + linked-worktree tips, via core/refs.mjs)
  // PLUS the `.git/index` mtime. So the summary recomputes on commit / checkout /
  // merge / worktree add-remove / staging. It does NOT recompute on a raw
  // unstaged edit to a tracked file — there is no cheap proxy for that (detecting
  // it is exactly what `git status` does, statting every tracked file), so the
  // `dirty` count is eventually-consistent: it refreshes when refs or the index
  // change, not on every keystroke-save (task 52, option (a)). For a cross-project
  // glance that's fine — the summary is already coarse (note the worktree
  // stale-count caveat below). The actual `git status --porcelain` now runs only
  // inside computeFn (on a miss), not on every poll.
  // Caveat: a sibling worktree committing moves its own tip (so the ref snapshot
  // DOES pick that up now — better than the old HEAD-only signal), but a poll
  // still reflects the state as of the last ref/index change.
  const gitSummary = await memoize('overview', proj.path,
    async () => {
      const state = readState(proj.path);
      if (!state.mainSha) return null; // not a git repo / unreadable → bypass cache
      let idxMtime = '';
      try { idxMtime = String(statSync(join(proj.path, '.git', 'index')).mtimeMs); } catch { /* no index yet */ }
      return keyOf(state) + '\x1f' + idxMtime;
    },
    async () => {
      const [latestRaw, statusOut, size, ...wtStats] = await Promise.all([
        gitP(['log', '-n', '1', '--no-merges', '--pretty=format:%h%x1f%ar%x1f%s%x1f%ad', '--date=short'], proj.path),
        gitP(['status', '--porcelain'], proj.path),
        projectSize(proj.path),
        ...clonePaths.map((cp) => lightWorktreeStats(cp)),
      ]);
      const wt = wtStats.reduce((acc, s) => ({ count: acc.count + s.count, stale: acc.stale + s.stale }), { count: 0, stale: 0 });
      const dirty = statusOut ? statusOut.split('\n').filter(Boolean).length : 0;
      let latestCommit = null;
      if (latestRaw) { const [shortHash, relDate, subject, date] = latestRaw.split('\x1f'); latestCommit = { shortHash, relDate, subject, date }; }
      return { worktrees: wt, dirty, size, latestCommit };
    });

  // Unmerged-worktree count: fresh + cheap (stat-cached, no git on a hit — see
  // unmerged.mjs), so it's NOT subject to the memoize's main-HEAD/status signal
  // lag. Same source the sidebar + badges read, so all surfaces agree.
  const unmerged = await projectUnmerged(proj);
  const worktrees = { ...(gitSummary.worktrees || { count: 0, stale: 0 }), unmerged };
  return { slug: proj.slug, label: proj.label, tasks: counts, ...gitSummary, worktrees };
}

// Set of real worktree names for a project (across clones) — used to validate
// task -> worktree links so a generic session id (e.g. "session-123") that isn't
// actually a worktree doesn't produce a dead link.
function worktreeNamesForProject(proj) {
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];
  const set = new Set();
  for (const cp of clonePaths) for (const e of gitWorktrees(cp)) set.add(basename(e.path));
  return set;
}

// Annotate each task with the git it drives: the branch/worktree it was worked
// in (live claim first, then the durable env.worktree record — claims release
// but worktrees/sessions live on as the feature's history) and the commits
// tagged [#<id>] across ALL refs, so unmerged task branches show their commits.
function annotateWorktree(taskData, proj) {
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];
  const wtBranch = {}; // worktree name -> branch
  for (const cp of clonePaths) for (const e of gitWorktrees(cp)) wtBranch[basename(e.path)] = e.branch || null;
  const byTask = {}; // task id -> [commits]
  for (const c of gitCommits(proj.path, 300, { all: true })) {
    for (const id of c.taskIds) {
      (byTask[id] = byTask[id] || []).push({ shortHash: c.shortHash, subject: parseTaskTags(c.subject).cleanSubject, relDate: c.relDate });
    }
  }
  for (const t of taskData) {
    const env = (t.fm && t.fm.env) || {};
    const live = env.claimed_by_session ? String(env.claimed_by_session).replace(/-\d+$/, '') : null;
    const recorded = env.worktree || null;
    t.worktreeName = (live && live in wtBranch) ? live : ((recorded && recorded in wtBranch) ? recorded : null);
    // Branch: prefer the worktree's current branch; fall back to the recorded one
    // (still meaningful when the worktree is gone but the branch ref survives).
    t.branch = t.worktreeName ? wtBranch[t.worktreeName] : (env.branch || null);
    t.commits = byTask[String(t.id)] || [];
  }
  return taskData;
}

export { lightWorktreeStats, taskCountsFromFrontmatter, projectSize, projectOverview, worktreeNamesForProject, annotateWorktree };
