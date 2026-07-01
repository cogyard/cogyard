// core/git-views.mjs — read-only git views for the portal: commit log (with
// [#NN] task tags), branch divergence vs main, and the SmartGit-style lane DAG.

import { join, basename } from 'node:path';
import { tryExec, gitP, defaultBranch } from './exec.mjs';
import { memoize } from './memo.mjs';
import { loadTasks } from './frontmatter.mjs';
import { worktreesForProject } from './worktrees.mjs';

// The /commit skill stamps a leading [#NN] task tag on commit subjects. This is
// the ONE place that convention is parsed: it returns the referenced task ids and
// the subject with the tag(s) stripped. Every consumer — the CLI, the portal API
// (commit log, the lane DAG, the per-task worktree annotation), and the SPA via
// the fields these projections SERVE — goes through here instead of re-writing the
// regex in its own layer (task 47: no client-side re-derivation of a domain fact).
function parseTaskTags(subject) {
  const s = subject || '';
  return {
    taskIds: [...s.matchAll(/\[#(\w+)\]/g)].map((m) => m[1]),
    cleanSubject: s.replace(/\s*\[#\w+\]\s*/g, ' ').trim(),
  };
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
// (task 47: the portal's Branches tab used to re-derive this client-side). The
// /commit + worktree conventions leave several traces; check them strongest-first:
// the [#NN] or _tasks/NNN tag in the branch tip's subject, the NNN- branch-name
// prefix, then the branch name matching a task's slug or recorded env.branch.
// `name` may be local or origin/<x>; `tasks` is loadTasks() output; `mainName` is
// the trunk (never a task branch). Returns the task id (string) or null.
function matchBranchTask(name, subject, mainName, tasks) {
  const bare = (name || '').replace(/^origin\//, '');
  if (!bare || bare === mainName) return null;
  const tag = (subject || '').match(/\[#(\d+)\]/) || (subject || '').match(/_tasks\/0*(\d+)/) || bare.match(/^(\d+)-/);
  if (tag) return tag[1];
  for (const t of tasks) {
    const fm = t.frontmatter;
    if (!fm || fm.id == null) continue;
    if (fm.slug === bare || (fm.env && fm.env.branch === bare)) return String(fm.id);
  }
  return null;
}

// Divergence of every branch (local + origin) from main — the "where is main,
// where is everything else" view. Pairs each logical branch's local head with
// its origin/<name> counterpart, and reports main vs origin/main too.
async function branchDivergence(proj) {
  const repo = proj.path;
  const base = (await defaultBranch(repo)) || 'main';

  const claimMap = {};
  try {
    for (const t of loadTasks(join(repo, '_tasks'))) {
      const s = t.frontmatter && t.frontmatter.env && t.frontmatter.env.claimed_by_session;
      const id = t.frontmatter && t.frontmatter.id;
      if (s && id != null) claimMap[String(s).replace(/-\d+$/, '')] = id;
    }
  } catch {}

  const current = await gitP(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  const localRaw = await gitP(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repo);
  const remoteRaw = await gitP(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repo);
  const locals = new Set((localRaw || '').split('\n').filter(Boolean));
  const remotes = new Set((remoteRaw || '').split('\n').filter(Boolean).filter((r) => !r.endsWith('/HEAD')));

  // Logical branch names: every local head, plus every origin/<x> with the
  // "origin/" stripped. main is handled separately as the spine.
  const names = new Set();
  for (const l of locals) if (l !== base) names.add(l);
  for (const r of remotes) { const m = r.match(/^origin\/(.+)$/); if (m && m[1] !== base) names.add(m[1]); }

  const rows = await Promise.all([...names].map(async (name) => {
    const hasLocal = locals.has(name);
    const originRef = 'origin/' + name;
    const hasOrigin = remotes.has(originRef);
    const [local, origin, pushPull] = await Promise.all([
      hasLocal ? aheadBehind(repo, base, name) : Promise.resolve(null),
      hasOrigin ? aheadBehind(repo, base, originRef) : Promise.resolve(null),
      (hasLocal && hasOrigin) ? aheadBehind(repo, originRef, name) : Promise.resolve(null),
    ]);
    return {
      name, hasLocal, hasOrigin,
      taskId: claimMap[basename(name)] != null ? claimMap[basename(name)] : (claimMap[name] != null ? claimMap[name] : null),
      isCurrent: name === current,
      local, origin, pushPull,
    };
  }));

  // main spine: main vs origin/main
  const mainVsOrigin = remotes.has('origin/' + base) ? await aheadBehind(repo, base, 'origin/' + base) : null;

  // sort: current first, then most-diverged, then name
  rows.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const dev = (r) => (r.local ? r.local.ahead + r.local.behind : 0) + (r.origin ? r.origin.ahead + r.origin.behind : 0);
    return dev(b) - dev(a) || a.name.localeCompare(b.name);
  });

  return { base, current, mainVsOrigin, hasOrigin: remotes.has('origin/' + base), branches: rows };
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
// Volatile worktree/stash overlays are NOT cached here — they're spliced fresh by
// gitDagWithWorktrees, so dirty/stash state never goes stale.
async function gitDag(proj, limit = 250) {
  const repo = proj.path;
  return memoize('dag', `${repo}|${limit}`,
    () => gitP(['rev-parse', '--branches', '--tags', '--remotes'], repo),
    () => computeDag(repo, limit));
}

async function computeDag(repo, limit) {
  const fmt = ['%H', '%h', '%P', '%D', '%s', '%an', '%ad'].join('%x1f');
  // --topo-order keeps a branch's commits contiguous (parent right after child),
  // so merges/branches read clearly instead of being stretched across date-sorted rows.
  // Explicit ref globs instead of bare --all: --all also traverses refs/stash,
  // dragging each stash's 2-3 plumbing commits (On/index/untracked on <branch>)
  // into the walk as ordinary rows. Stashes are surfaced separately as collapsed
  // synthetic rows by spliceStashRows.
  const base = await defaultBranch(repo);
  const [raw, mainRaw] = await Promise.all([
    gitP(['log', '--branches', '--tags', '--remotes', '--topo-order', '--date=format:%m/%d/%Y %I:%M %p', '-n', String(limit), '--pretty=format:' + fmt], repo),
    base ? gitP(['rev-list', base], repo) : Promise.resolve(''),
  ]);
  if (!raw) return { rows: [], laneCount: 0 };
  const mainSet = new Set((mainRaw || '').split('\n').filter(Boolean));
  return dagFromLog(raw, mainSet);
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
    // row instead of re-parsing the [#NN] tag itself (task 47).
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

// --- Working-tree pseudo-rows (SmartGit-style) -------------------------------
// Post-pass over gitDag rows: each DIRTY checkout (main's plus every worktree)
// becomes a `kind: 'worktree'` row spliced directly above its HEAD commit's row,
// in that row's lane. Pseudo-rows do not participate in lane assignment — they
// borrow the anchor's col and replay the anchor's incoming lanes as straight
// verticals so pass-through lines don't visually break. Checkouts whose HEAD is
// outside the row window are skipped (the Worktrees tab still shows them).
function spliceWorktreeRows(dag, worktrees) {
  const rows = dag.rows;
  if (!rows.length) return dag;
  const byAnchor = new Map(); // row index -> worktree entries anchored there
  for (const wt of worktrees) {
    if (!wt.dirtyCount) continue; // clean (0) or unknown (null) → no node
    const head = wt.headFull || wt.head;
    if (!head) continue;
    const i = rows.findIndex((r) => r.hash === head || r.hash.startsWith(head));
    if (i === -1) continue; // HEAD beyond the DAG's -n window
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
          clone: wt.clone || null,
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

// Post-pass mirroring spliceWorktreeRows: each stash becomes a `kind: 'stash'` row
// spliced directly above its base commit's row, borrowing that row's lane and
// replaying its incoming lanes as straight verticals so pass-through lines don't
// break. A dotted connector ties the stash dot to the base commit's dot. Stashes
// whose base commit is outside the row window are skipped.
function spliceStashRows(dag, stashes) {
  const rows = dag.rows;
  if (!rows.length || !stashes.length) return dag;
  const byAnchor = new Map(); // row index -> stash entries anchored there
  for (const st of stashes) {
    if (!st.base) continue;
    const i = rows.findIndex((r) => r.kind !== 'worktree' && r.kind !== 'stash' && (r.hash === st.base || r.hash.startsWith(st.base)));
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

// The DAG the portal's Graph tab renders: commit rows + working-tree pseudo-rows
// + collapsed stash rows.
async function gitDagWithWorktrees(proj, limit = 250) {
  const [dag, wts, stashes] = await Promise.all([gitDag(proj, limit), worktreesForProject(proj), listStashes(proj.path)]);
  return spliceStashRows(spliceWorktreeRows(dag, wts), stashes);
}

export { parseTaskTags, matchBranchTask, gitCommits, parseGraphLog, aheadBehind, branchDivergence, gitDag, dagFromLog, listStashes, spliceWorktreeRows, spliceStashRows, gitDagWithWorktrees };
