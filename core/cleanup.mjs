// core/cleanup.mjs — THE cleanup service (task 117).
//
// One place knows the cleanup process. The CLI, the portal routes, and the
// driver command all consume this; none of them re-implement any of it.
// The cleanup process, in one place: enumerate what is hanging around, remove
// the finished worktrees, then name the chats that became safe to archive.
//
// The vocabulary is closed and this file uses no other words for these things:
//   ARCHIVED  a chat. Claude's own word for its own reversible flag; nothing is
//             deleted and the transcript survives. Happens ONLY in Claude's UI —
//             the desktop app clobbers external isArchived writes, so this
//             module never attempts one and never will.
//   REMOVED   a worktree. The checkout is deleted; the branch survives.
//   CLEANUP   the whole process.
//
// THE UNIT IS A FINISHED PIECE OF WORK — a task, the worktree it ran in, and
// the chat that drove it. Every earlier tool keyed on one axis (worktrees, or
// chats, or disk), which forces you to hold that join in your head while
// switching tools. Owning the join here is the point of this module.
//
// THE ARCHIVE-SAFETY RULE: a chat may cover several tasks. It is safe to
// archive only when EVERY task it covers is finished and none of them still has
// a worktree on disk. Archiving on one task's completion would bury a chat
// another open task still needs — so the ladder feeding this must be the
// UNCAPPED one (core/activity.mjs sessionTaskIdsAll); the capped display view
// would silently drop the tasks that should have blocked archiving.
//
// THE CHATS LIST IS A FULL MIRROR (task 144). `projectCleanup` used to keep
// only the chats that were already ready, so a chat being held back was simply
// absent — the owner had no way to tell "deliberately kept" from "stuck for a
// reason the app never showed." `row.chats` is now every open (non-archived)
// chat this project's Claude Code sidebar shows, ready or not, each carrying
// why it's held. It DUPLICATES a chat also attached to a worktree row's
// `.chat` — deliberate: the worktree table answers "what can I remove", this
// list answers "what can I archive", and a chat can be relevant to both at once.

import { basename, dirname, resolve, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { adapter } from './drivers.mjs';
import { tryExec, findRepoRoot } from './exec.mjs';
import { readRegistry } from './registry.mjs';
import { loadTasks } from './frontmatter.mjs';
import { isClosed } from './status.mjs';
import { allWorktreeCandidates, worktreeCandidate, isRemovableVerdict } from './sessions-audit.mjs';
import { usageSessions, sessionTaskIdsAll } from './activity.mjs';
import { taskUsage, resolveProjectForPath, chatSignals, claimWindows } from './usage.mjs';
import { sweepLaunchEntries } from './launch.mjs';
import { tasksDirOf } from './tasks-dir.mjs';

// --- the command strings, authored ONCE -------------------------------------
// Display and execution must never diverge, so both come from here. Before this
// existed the removal was hand-written in four places (three spawns in
// cli/sessions.mjs, one display string in core/sessions-audit.mjs) and they
// agreed only because each was typed correctly.
const removeArgs = (repoPath, worktreePath) => ['-C', repoPath, 'worktree', 'remove', worktreePath];
const removeCmd = (repoPath, worktreePath) => `git ${removeArgs(repoPath, worktreePath).join(' ')}`;
const undoCmd = (repoPath, worktreePath, branch) => `git -C ${repoPath} worktree add ${worktreePath} ${branch}`;
const unlockCmd = (repoPath, worktreePath) => `git -C ${repoPath} worktree unlock ${worktreePath}`;

// --- reading ----------------------------------------------------------------

// branch -> its tip's commit date (ISO). ONE `for-each-ref` per repo rather
// than a `git log` per worktree: this is the sort key for the whole list, and
// 89 extra git spawns would be paid on every page load.
//
// The branch tip is the honest reading of "when did I last touch this" — a
// worktree's directory mtime moves for reasons that aren't work (a build, an
// editor, a `find`), while a commit is something you did.
function branchDates(repoPath) {
  const map = new Map();
  const raw = tryExec("git for-each-ref --format='%(refname:short)|%(committerdate:iso-strict)' refs/heads/", { cwd: repoPath });
  if (!raw) return map;
  for (const line of raw.split('\n')) {
    const [name, date] = line.replace(/^'|'$/g, '').split('|');
    if (name && date) map.set(name, date);
  }
  return map;
}

// taskId -> {status, done} for one project, from the task files.
function taskStatuses(repoPath) {
  const map = new Map();
  try {
    for (const t of loadTasks(tasksDirOf(repoPath))) {
      const fm = t.frontmatter || {};
      if (fm.id == null) continue;
      // createdBy: the chat that filed this task (write-task stamps it) — a
      // "worked on" signal for that chat (task 152).
      const createdBy = fm.created_by_session || (fm.env && fm.env.created_by_session) || null;
      map.set(String(fm.id), { status: fm.status || null, done: isClosed(fm.status), createdBy });
    }
  } catch { /* no task store — every task reads as unknown, which blocks archiving */ }
  return map;
}

// Every NON-archived chat, with the UNCAPPED set of tasks it covers and the
// worktrees its transcript ran in. Archived chats are already dealt with and
// carry no action.
//
// READ FROM THE SOURCE. The task ids and worktrees come from the chat's own
// transcript (usage.mjs chatSignals), not from the swept activity ledger. The
// ledger is a cache refreshed at boot / session end / the Stats tab's Refresh,
// so every chat still open or ended since the last sweep was missing from it —
// and the worktree join below said "no chat found" for a chat sitting right
// there in the sidebar (owner, 2026-09-16). The usage ledger still supplies
// claims as a supplement: a stale claim list means fewer signals, never wrong
// ones. `slugs` scopes the transcript reads to the projects being reported —
// a chat's project is known from its launch dir before any file is opened.
//
// Claims come from claims.jsonl itself (claimWindows), which `cogyard env
// claim` appends to at claim time — the usage ledger only carries a claim on
// the usage rows that fell inside its window, and dropped most of a
// multi-claim chat's (task 152: 17 claims vs 1 on "Where-is-maya server audit").
function openChats(slugs = null) {
  if (!(adapter.sessions && adapter.sessions.supported)) return [];
  const usage = usageSessions();
  const claims = claimWindows();
  const inScope = (project) => !slugs || slugs.has(project);
  const out = [];
  for (const s of adapter.sessions.list()) {
    if (s.isArchived) continue;
    const project = s.cwd ? resolveProjectForPath(s.cwd) : null;
    if (!inScope(project)) continue;
    const live = chatSignals(s.sessionId);
    // The ladder's inputs, shaped as the ledger row would have been but from
    // the file. `worktree` is left null here and the worktrees visited are
    // appended after, so a chat that entered SEVERAL task worktrees credits
    // all of them — the ladder's own slot holds one.
    const chatClaims = (claims.get(s.sessionId) || [])
      .filter((w) => w.taskId != null)
      .map((w) => ({ taskId: String(w.taskId), project: w.project || null }));
    const u = usage.get(s.sessionId);
    const claimedTasks = new Set([...((u && u.claimedTasks) || []), ...chatClaims.map((c) => c.taskId)]);
    const taskIds = sessionTaskIdsAll({ commitTasks: live.commitTasks, tasks: live.tasks, worktree: null }, { claimedTasks, worktree: null });
    for (const name of Object.keys(live.worktrees)) {
      const m = name.match(/^task-0*(\d+)/);
      if (m && !taskIds.includes(m[1])) taskIds.push(m[1]);
    }
    out.push({
      sessionId: s.sessionId,
      title: s.title,
      lastActivityAt: s.lastActivityAt,
      cwd: s.cwd || null,
      project,
      taskIds,
      // worktree name → lines the transcript ran there. The direct join key.
      worktrees: live.worktrees,
      // The chat's own ACTIONS (task 152) — what workedTasks() reads to tell
      // a task it worked on from one it only looked up. `ranIn` is the
      // worktrees its lines ran in (cwd) — not ones it only named.
      ranIn: live.ranIn || {},
      commitTasks: live.commitTasks,
      claims: chatClaims,
      filesWritten: Object.keys(live.filesWritten || {}),
    });
  }
  return out;
}

// Which tasks did this chat WORK on (task 152)? Only its own actions count:
//   · committed  — a `git commit` it RAN carried `[#NN]` (chat.commitTasks)
//   · claimed    — it ran `cogyard env claim` on the task (chat.claims)
//   · worktree   — it ran in the task's `task-NNN-*` worktree
//   · created    — the task file's created_by_session is this chat
//   · edited     — it edited/wrote the task's own file in THIS project's store
// Everything else the chat mentions — a task file it read, a number it grepped
// — is a lookup, and a lookup never holds a chat: a foundational task read
// from many chats must not hold them all until it closes.
// → { [taskId]: ['committed', 'claimed', …] }
function workedTasks(chat, statuses, { slug = null, storeDir = null } = {}) {
  const out = {};
  const add = (id, why) => {
    const k = String(id).replace(/^0+(?=\d)/, '');
    if (!out[k]) out[k] = [];
    if (!out[k].includes(why)) out[k].push(why);
  };
  for (const id of Object.keys(chat.commitTasks || {})) add(id, 'committed');
  const inProject = (p) => !slug || !p || p === slug;
  for (const c of chat.claims || []) if (inProject(c.project)) add(c.taskId, 'claimed');
  for (const name of Object.keys(chat.ranIn || {})) {
    const m = name.match(/^task-0*(\d+)/);
    if (m) add(m[1], 'worktree');
  }
  for (const [id, st] of statuses) if (st.createdBy && st.createdBy === chat.sessionId) add(id, 'created');
  if (storeDir && (chat.filesWritten || []).length) {
    let store;
    try { store = realpathSync(storeDir); } catch { store = null; }
    for (const f of store ? chat.filesWritten : []) {
      const m = basename(f).match(/^0*(\d+)-.*\.md$/);
      if (!m) continue;
      let dir;
      try { dir = realpathSync(dirname(f)); } catch { continue; }
      if (dir === store) add(m[1], 'edited');
    }
  }
  return out;
}

// Is this chat ready to archive? READY is advice only — cogyard never
// archives; the owner decides (task 152). A chat is held while:
//   1. a task it WORKED on (workedTasks) is not finished, or has a task-named
//      worktree still on disk; or
//   2. ANY worktree it ran in is still on disk — task-named or not. Archiving
//      a Desktop-managed worktree's chat force-removes the checkout,
//      uncommitted work included, and a chat with no worked task (now READY)
//      can still have run in one, e.g. `website-copy`.
// Tasks it only looked up are listed (worked: false) but never hold it, and a
// chat with no worked task and no worktree on disk is READY.
//
// SCOPING THE IDS TO THIS PROJECT (task 144). `chat.taskIds` is mined from the
// chat's TEXT with no project scoping, so a chat can carry another project's
// id. `statuses` is the ground truth for which ids are real HERE; ids it
// doesn't recognize are dropped before anything is judged.
//
// `chat.worked` is workedTasks()'s map; `chat.ranIn` the worktrees the chat
// ran in; `liveWorktreeNames` is every non-main worktree on disk in this project.
function chatArchiveReadiness(chat, statuses, taskIdsWithLiveWorktree, liveWorktreeNames = new Set()) {
  const worked = chat.worked || {};
  const ids = [];
  for (const id of [...Object.keys(worked), ...(chat.taskIds || [])]) if (!ids.includes(id)) ids.push(id);
  const knownIds = ids.filter((id) => statuses.has(id));
  // Worked first (in the order found), then lookups — the chip order.
  const workedIds = knownIds.filter((id) => worked[id]);
  const lookedUp = knownIds.filter((id) => !worked[id]);

  const tasks = [];
  const waitingOn = [];
  for (const id of workedIds) {
    const st = statuses.get(id);
    const t = { id, worked: true, workedBy: worked[id], primary: true, done: false, status: st.status, why: null };
    if (!st.done) t.why = `status ${st.status || '?'}`;
    else if (taskIdsWithLiveWorktree.has(id)) t.why = 'worktree still on disk';
    else t.done = true;
    if (t.why) waitingOn.push({ taskId: id, why: t.why });
    tasks.push(t);
  }
  for (const id of lookedUp) {
    const st = statuses.get(id);
    tasks.push({ id, worked: false, workedBy: [], primary: false, done: !!st.done, status: st.status, why: null });
  }
  for (const name of Object.keys(chat.ranIn || {})) {
    if (liveWorktreeNames.has(name)) waitingOn.push({ worktree: name, why: 'worktree still on disk' });
  }

  const heldTasks = waitingOn.filter((w) => w.taskId).map((w) => `#${w.taskId}`);
  const heldTrees = waitingOn.filter((w) => w.worktree).map((w) => w.worktree);
  let reason;
  if (waitingOn.length) {
    reason = 'waiting on ' + [...heldTasks, ...heldTrees.map((n) => `worktree ${n}`)].join(', ');
  } else if (workedIds.length) {
    reason = workedIds.length === 1 ? `only worked on #${workedIds[0]}, and it's done` : `worked on #${workedIds.join(', #')} — all done`;
  } else {
    reason = lookedUp.length ? `worked on no task — only looked up #${lookedUp.join(', #')}` : 'worked on no task';
  }
  return { tasks, ready: waitingOn.length === 0, reason, waitingOn };
}

// Chats that touched `taskId`, best-driver-first. `taskIds` arrives from the
// ladder strongest-signal-first, so its INDEX is the signal strength: index 0
// means this chat's own commits or claim named the task, a later index means it
// was a passing reference. Ties break on recency (newest first) so repeated
// runs give the same answer.
function rankChatsForTask(chats, taskId) {
  return chats
    .filter((c) => c.taskIds.includes(taskId))
    .sort((a, b) => (a.taskIds.indexOf(taskId) - b.taskIds.indexOf(taskId))
      || String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
}

// The chat that DROVE a worktree. Two signals, strongest first:
//
// 1. Its transcript RAN INSIDE this worktree — lines with this checkout as
//    their cwd (`chat.worktrees[name]`, from openChats). Direct evidence, read
//    from the source, and the ONLY signal there is for a worktree not named
//    task-NNN (an autopilot run, a rehearsal). Ranked by how many lines ran
//    here, then recency.
// 2. Else the task-id ladder (rankChatsForTask): chats whose task set contains
//    this worktree's task, the one whose STRONGEST signal is this task first.
//    No fuzzy title matching, deliberately.
//
// Before 2026-09-18 only (2) existed, and it read a swept ledger — so a chat
// still open, or ended since the last sweep, matched nothing and the row said
// "no chat found" with the chat right there in the sidebar.
function chatForWorktree(chats, name, taskId) {
  const byVisit = chats
    .filter((c) => c.worktrees && c.worktrees[name])
    .sort((a, b) => (b.worktrees[name] - a.worktrees[name])
      || String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
  if (byVisit[0]) return byVisit[0];
  return (taskId ? rankChatsForTask(chats, taskId)[0] : null) || null;
}

// What can be done to a worktree, from the verdict ladder. No new safety logic
// here — task 117's out_of_scope forbids a second model, so this only TRANSLATES
// the existing verdict into an action.
function actionFor(verdict) {
  // REMOVABLE (merged) and PUSHED (unmerged, but origin holds this exact
  // commit — task 174). The two stay distinct verdicts so nothing reads
  // "backed up" as "merged"; they share the one removal path.
  if (isRemovableVerdict(verdict)) return 'remove';
  // A dead session's lock is harmless but blocks removal until cleared. Without
  // this the locked worktrees sit in the list forever looking un-cleanable.
  if (verdict === 'LOCKED') return 'unlock';
  return null;
}

// One project's cleanup items: one per non-main worktree, carrying all three
// faces (worktree state, the tasks it covers, the chat that drove it).
async function projectCleanup(proj, { chats, statusesByRepo }) {
  const repoPath = proj.path;
  const row = { slug: proj.slug, label: proj.label, items: [], chats: [], error: null };

  let candidates;
  try { candidates = await allWorktreeCandidates(repoPath); }
  catch (e) { row.error = String((e && e.message) || e); return row; }
  if (!candidates.repoPath) { row.error = 'not a git repo'; return row; }

  if (!statusesByRepo.has(repoPath)) statusesByRepo.set(repoPath, taskStatuses(repoPath));
  const statuses = statusesByRepo.get(repoPath);

  // Which tasks still have a worktree on disk — the archive rule needs this,
  // and it must be computed BEFORE any removal in this pass.
  const liveTaskIds = new Set();
  for (const c of candidates.rows) if (c.taskId != null) liveTaskIds.add(String(c.taskId));
  // Every non-main worktree on disk, by name — a chat that ran in any of them
  // is held (task 152).
  const liveNames = new Set(candidates.rows.map((c) => c.worktree.name));

  // Worked-on tasks need this project's store (created_by_session, edits to its
  // task files), so they are attached here rather than in openChats.
  const storeDir = tasksDirOf(repoPath);
  const projectChats = chats
    .filter((c) => c.project === proj.slug)
    .map((c) => ({ ...c, worked: workedTasks(c, statuses, { slug: proj.slug, storeDir }) }));
  const dates = branchDates(repoPath);

  for (const c of candidates.rows) {
    const taskId = c.taskId != null ? String(c.taskId) : null;
    const chat = chatForWorktree(projectChats, c.worktree.name, taskId);

    const action = actionFor(c.verdict);
    row.items.push({
      project: proj.slug,
      worktree: { name: c.worktree.name, path: c.worktree.path, branch: c.worktree.branch, head: c.worktree.head },
      repoPath,
      taskId,
      taskStatus: taskId && statuses.get(taskId) ? statuses.get(taskId).status : null,
      // When you last worked here — the list's sort key.
      lastCommitAt: (c.worktree.branch && dates.get(c.worktree.branch)) || null,
      verdict: c.verdict,
      verdictDetail: c.detail,
      // origin/<branch> when the verdict is PUSHED — the backup the removal
      // leans on, named so the row can say where the work still lives.
      originRef: c.originRef || null,
      action,                                   // 'remove' | 'unlock' | null
      removeCmd: action === 'remove' ? removeCmd(repoPath, c.worktree.path) : null,
      undoCmd: action === 'remove' ? undoCmd(repoPath, c.worktree.path, c.worktree.branch) : null,
      unlockCmd: action === 'unlock' ? unlockCmd(repoPath, c.worktree.path) : null,
      chat: chat && {
        sessionId: chat.sessionId,
        title: chat.title,
        taskIds: chat.taskIds,
        // Readiness is computed against CURRENT state: while this worktree is
        // still on disk the chat is never ready, which is correct — remove
        // first, archive after.
        ...chatArchiveReadiness(chat, statuses, liveTaskIds, liveNames),
      },
    });
  }

  // EVERY open chat in this project, ready or not — the full mirror of what
  // Claude Code's own sidebar shows here (task 144). This is independent of
  // whether the chat is also attached to a worktree row above: that column
  // answers "which chat drove THIS worktree", this list answers "what in
  // Claude Code can I act on" — the same chat legitimately appears in both.
  for (const ch of projectChats) {
    const readiness = chatArchiveReadiness(ch, statuses, liveTaskIds, liveNames);
    // lastActivityAt travels with the row because these are matched
    // against Claude Desktop's own list, which is ordered by recency — a title
    // alone is ambiguous when several chats share one ("Pick up 98").
    row.chats.push({
      sessionId: ch.sessionId, title: ch.title, taskIds: ch.taskIds,
      lastActivityAt: ch.lastActivityAt, ...readiness,
    });
  }

  // Newest first, oldest at the bottom. Sorted HERE rather
  // than in the client so the CLI and the portal agree, and so the checklist's
  // recency order is declared instead of inherited by luck from the adapter's
  // own sort (which it was until now — a change there would have silently
  // reordered this).
  const newestFirst = (a, b) => String(b || '').localeCompare(String(a || ''));
  row.items.sort((x, y) => newestFirst(x.lastCommitAt, y.lastCommitAt));
  // Chats: most recent activity first, nothing else — the same order as
  // Claude's own sidebar, so a chat is found in the same place in both. It
  // used to put every READY chat first, which sent the newest chat 32nd in a
  // 46-chat project (task 152 follow-up); the Status column carries readiness.
  row.chats.sort((x, y) => newestFirst(x.lastActivityAt, y.lastActivityAt));
  return row;
}

// The whole report: every registered project, or one when `slug` is given.
async function cleanupReport({ slug = null } = {}) {
  const all = readRegistry();
  const projects = slug ? all.filter((p) => p.slug === slug) : all;
  // Scoped, so a one-project report opens only that project's transcripts.
  const chats = openChats(new Set(projects.map((p) => p.slug)));
  const statusesByRepo = new Map();
  // Projects in parallel too — on the all-projects view each one is an
  // independent pile of git questions.
  const rows = await Promise.all(projects.map((p) => projectCleanup(p, { chats, statusesByRepo })));
  return {
    projects: rows,
    // Counts drive the rail badge — cheap, no `du`, computed from what's here.
    totalRemovable: rows.reduce((s, r) => s + r.items.filter((i) => i.action === 'remove').length, 0),
    // READY chats only — the rail badge is a count of things to DO, and
    // `row.chats` now carries every open chat, most of which are still held.
    totalArchivable: rows.reduce((s, r) => s + r.chats.filter((c) => c.ready).length, 0),
  };
}

// --- the one write ----------------------------------------------------------

// Is `branch` on the REMOTE itself at `head`? The report's PUSHED verdict reads
// the local remote-tracking ref, which is only as fresh as the last fetch — the
// branch may have been deleted or moved on origin since. So before removing a
// PUSHED worktree, ask origin directly. Read-only (`ls-remote` changes no ref,
// unlike a fetch), no credential prompt (an unattended portal process must not
// hang on one), bounded by a timeout. Anything but an exact match refuses.
const LS_REMOTE_TIMEOUT_MS = 30000;
function confirmOnOrigin(repoPath, branch) {
  const ref = `refs/heads/${branch}`;
  const rp = spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf8' });
  const head = rp.status === 0 ? String(rp.stdout || '').trim() : null;
  if (!head) return { ok: false, error: `branch ${branch} does not resolve locally` };
  const r = spawnSync('git', ['-C', repoPath, 'ls-remote', 'origin', ref], {
    encoding: 'utf8',
    timeout: LS_REMOTE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || r.status !== 0) {
    const why = r.error ? String(r.error.message || r.error) : String(r.stderr || `git exited ${r.status}`).trim();
    return { ok: false, error: `could not reach origin to confirm ${branch} is pushed (${why.split('\n')[0]})` };
  }
  // ls-remote matches patterns by tail, so keep only the exact ref.
  const line = String(r.stdout || '').split('\n').map((l) => l.split('\t')).find(([, name]) => name === ref);
  if (!line) return { ok: false, error: `origin no longer has branch ${branch} — its remote-tracking ref is stale` };
  if (line[0] !== head) {
    return { ok: false, error: `origin's ${branch} is at ${line[0].slice(0, 7)}, the local branch at ${head.slice(0, 7)} — not the same commit` };
  }
  return { ok: true, sha: head };
}

// Remove ONE worktree, verified. The single implementation — the CLI's three
// call sites and the portal route all land here.
//
// It never prompts, never prints, never exits: callers own their own UX, which
// is what lets a typed-y/n CLI gate and an HTTP route share one body. Gates stay
// with the callers (task 106's trust model is about the gates, not the
// mechanics).
//
// Verification, both mandatory and both from task 106 rule 6:
//   1. the branch ref still resolves — removal must not take the work with it
//   2. the task's attributed cost is unchanged — proves the usage ledger did
//      not lose history along with the checkout
// A failure returns ok:false WITH the undo command; it does not throw, because
// every caller needs to surface the undo rather than a stack trace.
async function removeWorktree({ repoPath, worktreePath, branch, project = null, taskId = null }) {
  if (!repoPath || !worktreePath) return { ok: false, stage: 'input', error: 'repoPath and worktreePath are required', undoCmd: null };
  const undo = branch ? undoCmd(repoPath, worktreePath, branch) : null;

  // Refuse anything the ladder does not currently call REMOVABLE or PUSHED.
  // Re-checked HERE rather than trusting a verdict the caller computed earlier:
  // between a page render and a button click, a worktree can go dirty or gain a
  // lock. Judges THIS worktree only — it used to judge all of them and then
  // find the one it cared about, which is the same answer for 30× the git.
  const fresh = await worktreeCandidate(repoPath, worktreePath);
  if (!fresh) return { ok: false, stage: 'precheck', error: 'no such worktree in this repo', undoCmd: undo };
  if (!isRemovableVerdict(fresh.verdict)) {
    return { ok: false, stage: 'precheck', error: `refusing: ${fresh.verdict} — ${fresh.detail}`, verdict: fresh.verdict, undoCmd: undo };
  }
  // PUSHED was judged from the local remote-tracking ref; confirm against the
  // remote itself before the checkout goes. The branch is the one git has
  // checked out in that worktree, not whatever the caller passed.
  if (fresh.verdict === 'PUSHED') {
    const onOrigin = confirmOnOrigin(repoPath, fresh.worktree.branch);
    if (!onOrigin.ok) {
      return { ok: false, stage: 'precheck', error: `refusing: PUSHED — ${onOrigin.error}`, verdict: fresh.verdict, undoCmd: undo };
    }
  }

  const costBefore = taskId != null && project ? taskUsage(project, taskId).costUSD : null;

  const rm = spawnSync('git', removeArgs(repoPath, worktreePath), { encoding: 'utf8' });
  if (rm.status !== 0) {
    return { ok: false, stage: 'remove', error: String(rm.stderr || `git exited ${rm.status}`).trim(), undoCmd: undo };
  }

  const branchOk = !branch || tryExec(`git -C ${repoPath} rev-parse --verify --quiet refs/heads/${branch}`) != null;
  if (!branchOk) {
    return { ok: false, stage: 'verify', error: `branch ${branch} no longer resolves`, undoCmd: undo };
  }
  const costAfter = taskId != null && project ? taskUsage(project, taskId).costUSD : null;
  if (costBefore !== costAfter) {
    return { ok: false, stage: 'verify', error: `task ${taskId} cost moved ($${costBefore} → $${costAfter})`, undoCmd: undo };
  }

  // De-register the worktree's preview entry as part of removing it. Before
  // this, nothing dropped the entry AT removal time: the SessionStart hook was
  // the only sweeper and it runs solely inside a worktree, so a removed
  // worktree's entry survived until some OTHER worktree session happened to
  // start — and if it was the last worktree, forever. `except` covers the case
  // where git left the directory behind (a `--force` removal of a dirty tree
  // still unregisters it), so the entry goes either way.
  // Best-effort: a launch.json problem must never fail a removal that already
  // succeeded, and the next hook run sweeps whatever this missed.
  let launchSwept = [];
  try { launchSwept = sweepLaunchEntries(repoPath, { except: worktreePath }); }
  catch { launchSwept = []; }

  return {
    ok: true, removed: worktreePath, branch, verdict: fresh.verdict, originRef: fresh.originRef || null,
    costUSD: costAfter, undoCmd: undo, gone: !existsSync(worktreePath), launchSwept,
  };
}

export {
  cleanupReport, projectCleanup, chatArchiveReadiness, workedTasks, actionFor, openChats, rankChatsForTask, chatForWorktree,
  removeWorktree, removeCmd, undoCmd, unlockCmd,
};
