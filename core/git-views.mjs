// core/git-views.mjs — read-only git views for the portal: commit log (with
// [#NN] task tags) and the SmartGit-style lane DAG.

import { tryExec, gitP, defaultBranch } from './exec.mjs';
import { memoize } from './memo.mjs';
import { worktreesForProject } from './worktrees.mjs';

// The /commit skill stamps a leading [#NN] task tag on commit subjects. This is
// the ONE place that convention is parsed: it returns the referenced task ids and
// the subject with the tag(s) stripped. Every consumer — the CLI, the portal API
// (commit log, the lane DAG, the per-task worktree annotation), and the SPA via
// the fields these projections SERVE — goes through here instead of re-writing the
// regex in its own layer (no client-side re-derivation of a domain fact).
// A task id is DIGITS. `\w+` matched any word characters, so a commit subject
// carrying a literal placeholder — "[#N]", as this repo's own docs and commit
// templates do — produced a "task id" of N, which the portal then rendered as a
// #N chip that resolves to no task. mergesPerDay already filtered to /^\d+$/ on
// its way past, which is the same judgement made one layer too late; it is made
// here now, once, for every consumer.
function parseTaskTags(subject) {
  const s = subject || '';
  return {
    taskIds: [...s.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]),
    // The STRIP still takes \w+: a "[#N]" placeholder is not an id, but it is
    // still a tag, and leaving it glued to the front of the subject would put it
    // back on screen — which is what the chip was doing.
    cleanSubject: s.replace(/\s*\[#\w+\]\s*/g, ' ').trim(),
  };
}

// Commits per local day for the activity heatmap — GitHub-graph
// semantics: author-dated, merge commits excluded, every local branch counted
// (worktree-branch work is work; git walks each commit once however many refs
// reach it). Memoized on the branch-tip OIDs — the portal polls, tips rarely move.
function commitsPerDay(proj, days = 366) {
  const repo = proj.path;
  return memoize('commitsPerDay', `${repo}|${days}`,
    () => gitP(['rev-parse', '--branches'], repo),
    async () => {
      const raw = await gitP(['log', '--branches', '--no-merges', `--since=${days} days ago`, '--date=format-local:%Y-%m-%d', '--pretty=%ad'], repo);
      const byDay = {};
      for (const d of (raw || '').split('\n').filter(Boolean)) byDay[d] = (byDay[d] || 0) + 1;
      return byDay;
    });
}

// Task ids a merge-day commit carries. The workhorse is the agent-agnostic
// [#NN] tag (parseTaskTags — the same SSOT the commit log/DAG use); it lands on
// main whether a task was squashed, rebased, or merged --no-ff (the merge
// commit subject keeps the tag). The supplementary regex catches OLD-style
// merge commits from before the /commit-tag convention — "Merge task NNN:" or
// "Merge worktree-task-NNN-…" — without hardcoding any agent-specific branch
// literal (`worktree-`/`claude/` are tolerated as surrounding text, never
// required). "task-cost", "Tasks tab" etc. don't match — a digit must follow.
function mergeTaskIds(subject) {
  // No local digit filter: parseTaskTags only yields digits now.
  const ids = new Set(parseTaskTags(subject).taskIds);
  for (const m of (subject || '').matchAll(/\btask[- ]0*(\d+)/gi)) ids.add(m[1]);
  return [...ids];
}

// Per local day, the task ids that LANDED on the default branch that day —
// feeds the Stats-tab month calendar's #NN merge badges. "When it
// merged" is the commit's date on the trunk's first-parent line (unlike the
// commits heatmap, which is author-dated across every branch). NOTE: this repo
// (like most cogyard projects) lands work via squash/rebase into a LINEAR main,
// so the reliable signal is the [#NN] tag on first-parent commits, not
// `git log --merges` (which would miss every squashed landing). Memoized on the
// branch tips like commitsPerDay. → { 'YYYY-MM-DD': [taskId, …] }
function mergesPerDay(proj, days = 366) {
  const repo = proj.path;
  return memoize('mergesPerDay', `${repo}|${days}`,
    () => gitP(['rev-parse', '--branches'], repo),
    async () => {
      const base = (await defaultBranch(repo)) || 'main';
      const raw = await gitP(['log', base, '--first-parent', `--since=${days} days ago`, '--date=format-local:%Y-%m-%d', '--pretty=%ad%x1f%s'], repo);
      const sets = {};
      for (const line of (raw || '').split('\n').filter(Boolean)) {
        const [day, subject] = line.split('\x1f');
        const ids = mergeTaskIds(subject);
        if (!ids.length) continue;
        (sets[day] ||= new Set());
        for (const id of ids) sets[day].add(id);
      }
      const out = {};
      for (const [day, set] of Object.entries(sets)) out[day] = [...set].sort((a, b) => Number(a) - Number(b));
      return out;
    });
}

// Recent commits for a project, with [#NN] task tags (stamped by the /commit
// skill) parsed out so the viewer can cross-link commit -> task.
// opts.all: span every ref (worktree branches included), not just HEAD's history.
function gitCommits(repoPath, limit = 50, opts = {}) {
  // Unit-separator (\x1f) delimited fields; subject last (can't contain \x1f).
  const fmt = '%H%x1f%h%x1f%an%x1f%ar%x1f%aI%x1f%s';
  const raw = tryExec(`git log ${opts.all ? '--all ' : ''}-n ${limit} --no-merges --pretty=format:${JSON.stringify(fmt)}`, { cwd: repoPath });
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, shortHash, author, relDate, isoDate, subject] = line.split('\x1f');
    return { hash, shortHash, author, relDate, isoDate, subject, taskIds: parseTaskTags(subject).taskIds };
  });
}

// --- Commit graph (read-only) ------------------------------------------------
// Scoped to the shape these repos actually have: a `main` spine with per-agent
// worktree branches hanging off it. Returns main's recent commits plus, per
// branch, the commits it has ahead of main and where it forked (merge-base).
// Rendered client-side with @gitgraph/js. Not a general arbitrary-DAG renderer.
function parseGraphLog(raw) {
  return (raw || '').split('\n').filter(Boolean).map((l) => {
    const [hash, shortHash, subject, relDate] = l.split('\x1f');
    const { taskIds, cleanSubject } = parseTaskTags(subject);
    return { hash, shortHash, subject: cleanSubject, relDate, taskIds };
  });
}

// Ahead/behind of `ref` relative to `base`: returns {ahead, behind} (commits the
// ref has that base lacks, and vice-versa), or null on error.
async function aheadBehind(repo, base, ref) {
  const c = await gitP(['rev-list', '--left-right', '--count', `${base}...${ref}`], repo);
  if (!c) return null;
  const [behind, ahead] = c.split(/\s+/).map(Number);
  return { ahead, behind };
}

// Associate a branch with the task it belongs to — the SSOT for that mapping
// (the portal's Branches tab used to re-derive this client-side). The
// /commit + worktree conventions leave several traces; check them strongest-first:
// the [#NN] or <task dir>/NNN tag (.cogyard/tasks or _tasks) in the branch tip's subject, the NNN- branch-name
// prefix, then the branch name matching a task's slug or recorded env.branch.
// `name` may be local or origin/<x>; `tasks` is loadTasks() output; `mainName` is
// the trunk (never a task branch). Returns the task id (string) or null.
function matchBranchTask(name, subject, mainName, tasks) {
  const bare = (name || '').replace(/^origin\//, '');
  if (!bare || bare === mainName) return null;
  const tag = (subject || '').match(/\[#(\d+)\]/) || (subject || '').match(/(?:_tasks|\.cogyard\/tasks)\/0*(\d+)/) || bare.match(/^(\d+)-/);
  if (tag) return tag[1];
  for (const t of tasks) {
    const fm = t.frontmatter;
    if (!fm || fm.id == null) continue;
    if (fm.slug === bare || (fm.env && fm.env.branch === bare)) return String(fm.id);
  }
  return null;
}

// --- Commit DAG (SmartGit-style lane graph) ----------------------------------
// git log --all with parent links, run through a lane-assignment pass so the
// client can draw dots + connecting lines per commit. Each lane keeps its column
// for its whole life (no compaction) so pass-through lines stay vertical and only
// merges/branch-points produce diagonals.
// The DAG is a pure function of the branch/tag/remote tips (those drive both the
// `--branches --tags --remotes` walk and the `rev-list main` colouring). So memoize
// it keyed by those ref OIDs: a poll where no ref moved reuses the cached lanes
// instead of re-walking + re-assigning. `git rev-parse --branches --tags --remotes`
// is the cheap signal (one spawn) vs. the 250-commit log + lane pass it guards.
// Volatile overlays (dirty checkouts, stashes) are NOT cached here — they're
// spliced fresh by gitDagWithStashesAndWorktrees, so neither goes stale.
//
// FOCUS (task 175). The window is the newest `limit` commits across every ref,
// so an old branch's head — the very commit a Worktrees/Branches link points
// at — can sit entirely outside it and the graph had no row to show. `focus`
// (a commit sha or a ref name, from GET /api/graph?focus=) asks for that
// commit's history IN ADDITION to the window: its commits not on the default
// branch, back to the fork point, appended after the window rows. No focus →
// exactly the old code path, same rows in the same order.
// The resolved focus sha goes into the cache SIGNAL rather than the key: the
// key carries only a "focused" marker, so at most one focused DAG per repo is
// held (a distinct focus is a miss that replaces it) instead of one cache entry
// per commit anybody ever clicked, for the life of the portal process. The
// result is still a pure function of (refs, focus sha), so it never goes stale.
async function gitDag(proj, limit = 250, focus = null) {
  const repo = proj.path;
  const refsSignal = () => gitP(['rev-parse', '--branches', '--tags', '--remotes'], repo);
  const focusSha = focus ? await resolveFocus(repo, focus) : null;
  if (!focusSha) {
    return memoize('dag', `${repo}|${limit}`, refsSignal, () => computeDag(repo, limit));
  }
  return memoize('dag', `${repo}|${limit}|focused`,
    async () => { const s = await refsSignal(); return s == null ? null : `${s}\n${focusSha}`; },
    () => computeDag(repo, limit, focusSha));
}

// A caller-supplied focus is untrusted query-string text. It reaches git only
// as one execFile argument (never a shell), and only after it has passed a
// conservative ref/sha character set, cannot be read as an option (no leading
// '-', plus --end-of-options), and resolves to a COMMIT. Anything else → null,
// which the caller treats as "no focus": the default window, no error.
const FOCUS_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,199}$/;
async function resolveFocus(repo, focus) {
  const f = String(focus);
  if (!FOCUS_RE.test(f) || f.includes('..')) return null;
  const sha = await gitP(['rev-parse', '--verify', '--quiet', '--end-of-options', `${f}^{commit}`], repo);
  return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const DAG_FMT = ['%H', '%h', '%P', '%D', '%s', '%an', '%ad'].join('%x1f');
const DAG_DATE = '--date=format:%m/%d/%Y %I:%M %p';

async function computeDag(repo, limit, focusSha = null) {
  // --topo-order keeps a branch's commits contiguous (parent right after child),
  // so merges/branches read clearly instead of being stretched across date-sorted rows.
  // Explicit ref globs instead of bare --all: --all also traverses refs/stash,
  // dragging each stash's 2-3 plumbing commits (On/index/untracked on <branch>)
  // into the walk as ordinary rows. Stashes are surfaced separately as collapsed
  // synthetic rows by spliceStashRows.
  const base = await defaultBranch(repo);
  const [raw, mainRaw, focusRaw] = await Promise.all([
    gitP(['log', '--branches', '--tags', '--remotes', '--topo-order', DAG_DATE, '-n', String(limit), '--pretty=format:' + DAG_FMT], repo),
    base ? gitP(['rev-list', base], repo) : Promise.resolve(''),
    focusSha ? focusLog(repo, focusSha, base, limit) : Promise.resolve(''),
  ]);
  if (!raw && !focusRaw) return { rows: [], laneCount: 0 };
  const mainSet = new Set((mainRaw || '').split('\n').filter(Boolean));
  return dagFromLog(focusSha ? mergeFocusLog(raw || '', focusRaw) : raw, mainSet);
}

// The focused commit's own history, in the same line format as the window:
// `<sha> --not <base>` (the branch's commits not on the default branch, newest
// first — the focus itself is always the first line), capped at `limit` so a
// long-lived branch cannot turn one click into a full-history walk, then the
// fork point (merge-base) when the walk reached it. A focus that IS on the
// default branch has no such commits; it contributes just itself.
async function focusLog(repo, sha, base, limit) {
  const one = (rev) => gitP(['log', '--no-walk', DAG_DATE, '--pretty=format:' + DAG_FMT, rev], repo);
  if (!base) return (await one(sha)) || '';
  const own = await gitP(['log', '--topo-order', DAG_DATE, '-n', String(limit), '--pretty=format:' + DAG_FMT, sha, '--not', base], repo);
  if (!own) return (await one(sha)) || '';
  const truncated = own.split('\n').length >= limit;
  const fork = truncated ? null : await gitP(['merge-base', sha, base], repo);
  const forkLine = fork && /^[0-9a-f]{40,64}$/.test(fork) ? await one(fork) : null;
  return forkLine ? `${own}\n${forkLine}` : own;
}

// Window lines first, unchanged and in order; then the focus lines the window
// does not already hold. That concatenation is still a valid child-before-parent
// order: the window is a PREFIX of the full --topo-order walk over every ref, so
// a commit outside it can never be the child of one inside it (that would put a
// child after its parent in the full walk). Pure — exported for the tests.
function mergeFocusLog(raw, focusRaw) {
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  const seen = new Set(lines.map((l) => l.slice(0, l.indexOf('\x1f'))));
  for (const l of (focusRaw || '').split('\n')) {
    if (!l) continue;
    const h = l.slice(0, l.indexOf('\x1f'));
    if (seen.has(h)) continue;
    seen.add(h);
    lines.push(l);
  }
  return lines.join('\n');
}

// Pure half of gitDag: parse the \x1f-delimited `git log` output and run the
// lane-assignment pass. No git, no I/O — unit-testable with canned input.
function dagFromLog(raw, mainSet) {
  const SEP = '\x1f';
  const commits = raw.split('\n').filter(Boolean).map((line) => {
    const [hash, shortHash, parentStr, refStr, subject, author, date] = line.split(SEP);
    const refs = (refStr || '').split(', ').map((r) => r.trim()).filter(Boolean)
      .map((r) => r.replace(/^HEAD -> /, '').replace(/^tag: /, 'tag: ')).filter((r) => r !== 'HEAD');
    // taskIds + cleanSubject computed here (core) so the SPA consumes them off the
    // row instead of re-parsing the [#NN] tag itself.
    const { taskIds, cleanSubject } = parseTaskTags(subject);
    return { hash, shortHash, parents: parentStr ? parentStr.split(' ') : [], refs, subject, cleanSubject, taskIds, author, date };
  });

  // Lane assignment. `lanes[i]` = the hash that column i is currently waiting for.
  // `laneMain[i]` tracks whether that lane is main's TRUNK — i.e. it was opened by
  // a main commit heading toward a main parent. Black is reserved for the trunk: a
  // segment is main only when BOTH its endpoints are main commits. This is why a
  // feature branch's line descending to its fork point on main stays lane-colored
  // (the child is not main) even though the parent it targets is — and it holds no
  // matter where main's tip lands in the topo walk.
  const lanes = [];
  const laneMain = [];
  const rows = [];
  for (const c of commits) {
    const cOnMain = mainSet.has(c.hash);
    const incoming = lanes.slice();
    const incomingMain = laneMain.slice();
    const trackingCols = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) trackingCols.push(i);
    let col;
    if (trackingCols.length) col = trackingCols[0];
    else { col = lanes.indexOf(null); if (col === -1) { col = lanes.length; lanes.push(null); laneMain.push(false); } }
    for (const tc of trackingCols) { lanes[tc] = null; laneMain[tc] = false; }

    if (c.parents.length > 0) {
      // If another lane already waits for this parent, merge into it (one diagonal
      // at this row) instead of tracking it twice — two lanes holding the same hash
      // makes every later row redraw the merge diagonal with a dangling top end.
      // On a convergence the SURVIVING lane is the lower-numbered column, so main's
      // first-parent spine (which starts at col 0) keeps col 0 past fork points
      // instead of inheriting a merged feature branch's higher column. Not
      // compaction: only this single convergence row's survivor choice changes.
      const par0 = c.parents[0];
      const trunk0 = cOnMain && mainSet.has(par0); // this row continues the trunk
      const existing = lanes.indexOf(par0);
      if (existing === -1) { lanes[col] = par0; laneMain[col] = trunk0; }
      else if (existing > col) { lanes[col] = par0; laneMain[col] = trunk0 || laneMain[existing]; lanes[existing] = null; laneMain[existing] = false; }
      else { lanes[col] = null; laneMain[col] = false; if (trunk0) laneMain[existing] = true; }
      for (let p = 1; p < c.parents.length; p++) {
        const trunkP = cOnMain && mainSet.has(c.parents[p]);
        let pc = lanes.indexOf(c.parents[p]);
        if (pc === -1) { pc = lanes.indexOf(null); if (pc === -1) { pc = lanes.length; lanes.push(null); laneMain.push(false); } lanes[pc] = c.parents[p]; laneMain[pc] = trunkP; }
        else if (trunkP) laneMain[pc] = true;
      }
    } else {
      lanes[col] = null; laneMain[col] = false;
    }
    const outgoing = lanes.slice();

    // Build drawable segments for this row. A segment is "main" (drawn black) only
    // when it is part of main's trunk — i.e. both endpoints are main commits.
    const segs = [];
    // pass-through lanes (a different commit flows straight past this row)
    for (let L = 0; L < incoming.length; L++) {
      if (incoming[L] && incoming[L] !== c.hash) {
        let M = outgoing.indexOf(incoming[L]); if (M === -1) M = L;
        segs.push({ from: L, to: M, half: 'full', color: M, main: incomingMain[L] });
      }
    }
    // incoming lanes that were waiting for THIS commit converge into the dot (top half)
    for (let L = 0; L < incoming.length; L++) {
      if (incoming[L] === c.hash) segs.push({ from: L, to: col, half: 'top', color: col, main: incomingMain[L] });
    }
    // dot diverges down to each parent (bottom half)
    for (const par of c.parents) {
      const P = outgoing.indexOf(par);
      if (P !== -1) segs.push({ from: col, to: P, half: 'bottom', color: P, main: cOnMain && mainSet.has(par) });
    }

    rows.push({ ...c, col, segs, onMain: cOnMain });
  }

  return { rows, laneCount: lanes.length };
}

// --- Stash rows (collapsed) --------------------------------------------------
// A `git stash` is stored as a little cluster of commits on refs/stash (the stash
// commit, its index parent, and — with `-u` — an untracked-files parent). Now that
// gitDag no longer traverses refs/stash, enumerate stashes here and emit ONE row
// per entry instead of the 2-3 raw plumbing commits.
async function listStashes(repo) {
  // %gd = stash@{N}, %H = stash sha, %P = parents (first = base commit), %s = subject.
  const raw = await gitP(['stash', 'list', '--format=%gd%x1f%H%x1f%P%x1f%s'], repo);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    const [ref, sha, parentStr, subject] = line.split('\x1f');
    const base = parentStr ? parentStr.split(' ')[0] : null;
    // Strip git's "On <branch>:" / "WIP on <branch>:" prefix to the human message.
    const message = String(subject || '').replace(/^(?:WIP on|On) [^:]+:\s*/, '').trim() || String(subject || '');
    return { ref, sha, base, message };
  });
}

// --- Working-tree pseudo-rows (SmartGit-style) -------------------------------
// Post-pass over gitDag rows: each DIRTY checkout (main's plus every worktree)
// becomes a `kind: 'worktree'` row spliced directly above its HEAD commit's row,
// in that row's lane. Pseudo-rows do not participate in lane assignment — they
// borrow the anchor's col and replay the anchor's incoming lanes as straight
// verticals so pass-through lines don't visually break. Checkouts whose HEAD is
// outside the row window are skipped (the Worktrees tab still shows them) —
// EXCEPT the one a link asked for: a focused request (gitDag's `focus`, task
// 175) puts that HEAD commit into the rows, so the checkout anchors normally.
//
// A CLEAN checkout gets no row: the dirty gate is the whole point of the feature.
// This is not a second rendering of a branch — a branch chip says where a ref
// points; this row says the files on disk differ from it. (Task 115 restored
// this after task 110 deleted it on the mistaken reading that it duplicated a
// branch chip. Do not re-delete it without reading _tasks/115-*.md; if the graph
// ever gets too dense, the answer is a density control, not removal.)
function spliceWorktreeRows(dag, worktrees) {
  const rows = dag.rows;
  if (!rows.length) return dag;
  const byAnchor = new Map(); // row index -> worktree entries anchored there
  for (const wt of worktrees) {
    if (!wt.dirtyCount) continue; // clean (0) or unknown (null) → no node
    const head = wt.headFull || wt.head;
    if (!head) continue;
    const i = rows.findIndex((r) => r.hash === head || r.hash.startsWith(head));
    if (i === -1) continue; // HEAD beyond the DAG's -n window and not the focus
    if (!byAnchor.has(i)) byAnchor.set(i, []);
    byAnchor.get(i).push(wt);
  }
  if (!byAnchor.size) return dag;

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const anchor = rows[i];
    const group = byAnchor.get(i);
    if (group) {
      group.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
      // Lanes entering the anchor row also cross every pseudo-row above it.
      const passSegs = anchor.segs
        .filter((s) => s.half === 'full' || s.half === 'top')
        .map((s) => ({ from: s.from, to: s.from, half: 'full', color: s.color, main: s.main }));
      group.forEach((wt, j) => {
        const segs = passSegs.slice();
        // Connector into the anchor's dot. The topmost node starts at its own dot
        // (bottom half); stacked nodes below it carry the line full-height.
        segs.push({ from: anchor.col, to: anchor.col, half: j === 0 ? 'bottom' : 'full', color: anchor.col, main: anchor.onMain, wt: true });
        out.push({
          kind: 'worktree',
          hash: 'wt:' + wt.path, // unique row key; doubles as the ?commit= deep-link value
          col: anchor.col,
          segs,
          onMain: anchor.onMain,
          wtPath: wt.path,
          wtName: wt.name,
          branch: wt.branch,
          dirtyCount: wt.dirtyCount,
          isMain: !!wt.isMain,
          // Same [#NN] chip a commit row carries, so "which task is this
          // uncommitted work?" is answerable from the graph alone. Sourced from
          // the checkout's claim, falling back to the task file that records
          // this worktree — so it survives a released claim. On the main
          // checkout only a live claim counts (worktreesForProject, task 180):
          // the record there names whichever task last worked on main, not the
          // one whose files are uncommitted today.
          taskIds: wt.claimedByTaskId != null ? [String(wt.claimedByTaskId)] : [],
        });
      });
      // A tip commit draws nothing in its top half-row, which would leave the
      // connector dangling half a row above the dot — extend it to the dot.
      if (!anchor.segs.some((s) => s.half === 'top' && s.to === anchor.col)) {
        out.push({ ...anchor, segs: [...anchor.segs, { from: anchor.col, to: anchor.col, half: 'top', color: anchor.col, main: anchor.onMain, wt: true }] });
        continue;
      }
    }
    out.push(anchor);
  }
  return { ...dag, rows: out };
}

// Post-pass over gitDag rows: each stash becomes a `kind: 'stash'` row spliced
// directly above its base commit's row, borrowing that row's lane and replaying
// its incoming lanes as straight verticals so pass-through lines don't break. A
// dotted connector ties the stash dot to the base commit's dot. Stashes whose
// base commit is outside the row window are skipped.
function spliceStashRows(dag, stashes) {
  const rows = dag.rows;
  if (!rows.length || !stashes.length) return dag;
  const byAnchor = new Map(); // row index -> stash entries anchored there
  for (const st of stashes) {
    if (!st.base) continue;
    const i = rows.findIndex((r) => r.kind !== 'stash' && (r.hash === st.base || r.hash.startsWith(st.base)));
    if (i === -1) continue; // base beyond the DAG's -n window
    if (!byAnchor.has(i)) byAnchor.set(i, []);
    byAnchor.get(i).push(st);
  }
  if (!byAnchor.size) return dag;

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const anchor = rows[i];
    const group = byAnchor.get(i);
    if (group) {
      // Lanes entering the anchor row also cross every stash pseudo-row above it.
      const passSegs = anchor.segs
        .filter((s) => s.half === 'full' || s.half === 'top')
        .map((s) => ({ from: s.from, to: s.from, half: 'full', color: s.color, main: s.main }));
      group.forEach((st, j) => {
        const segs = passSegs.slice();
        // Dotted connector down into the anchor's dot (topmost starts at its own dot).
        segs.push({ from: anchor.col, to: anchor.col, half: j === 0 ? 'bottom' : 'full', color: anchor.col, main: anchor.onMain, stash: true });
        out.push({
          kind: 'stash',
          // hash = the stash's real commit sha: unique row key, and it flows through
          // the normal commit-diff path (a stash commit is a real object) so clicking
          // shows the stashed changes without any special-casing.
          hash: st.sha,
          stashRef: st.ref,
          message: st.message,
          sha: st.sha,
          base: st.base,
          col: anchor.col,
          segs,
          onMain: anchor.onMain,
        });
      });
      // Extend the anchor's top half to its dot when it has no incoming 'top' seg,
      // so the dotted connector doesn't dangle half a row above the dot.
      if (!anchor.segs.some((s) => s.half === 'top' && s.to === anchor.col)) {
        out.push({ ...anchor, segs: [...anchor.segs, { from: anchor.col, to: anchor.col, half: 'top', color: anchor.col, main: anchor.onMain, stash: true }] });
        continue;
      }
    }
    out.push(anchor);
  }
  return { ...dag, rows: out };
}

// The DAG the portal's Graph tab renders: commit rows plus the two volatile
// overlays — a row per dirty checkout and a collapsed row per stash. Splice
// order matters: worktree rows go in first, then stash rows anchor on the same
// commit row (they skip `kind === 'stash'` rows and never match a `wt:` hash),
// so a commit carrying both ends up worktree rows on top, stashes beneath them,
// commit last. Which checkouts EXIST is still the Worktrees tab's job; what this
// adds to the timeline is which of them have uncommitted work.
// `focus` (optional) is passed straight to gitDag: a focused commit beyond the
// window becomes a real row, so a dirty worktree whose HEAD it is gets its row
// spliced above it instead of being dropped as "beyond the window".
async function gitDagWithStashesAndWorktrees(proj, limit = 250, focus = null) {
  const [dag, wts, stashes] = await Promise.all([gitDag(proj, limit, focus), worktreesForProject(proj), listStashes(proj.path)]);
  return spliceStashRows(spliceWorktreeRows(dag, wts), stashes);
}

export { DAG_DATE, parseTaskTags, matchBranchTask, commitsPerDay, mergesPerDay, gitCommits, parseGraphLog, aheadBehind, gitDag, dagFromLog, mergeFocusLog, resolveFocus, listStashes, spliceWorktreeRows, spliceStashRows, gitDagWithStashesAndWorktrees };
