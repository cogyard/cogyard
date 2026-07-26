// core/task-chats.mjs — the task → chats lookup (task 30).
//
// Given a task id, which chats CREATED it, IMPLEMENTED it, and merely MENTIONED
// it — so the owner can FIND and READ the transcript (not resume it). Durable
// across chat archiving AND worktree removal, because the answer is sourced from
// the banked usage-dir ledgers (claims.jsonl + activity.jsonl), never the live
// worktree dir (worktrees get culled — tasks 103/106 — which would blank the
// answer for exactly the finished tasks the owner cares about).
//
// This is core/usage.mjs's sessionTaskIds ladder run the OTHER direction — task
// → sessions instead of session → task. Ranking of the IMPLEMENTED bucket,
// strongest first: claimed (claims.jsonl) → committed (activity commitTasks).
// MENTIONED is the tasks-only touch (`_tasks/N-` referenced without claiming or
// committing). CREATED is the stamped author session, else a best-effort,
// clearly-marked git-time inference.
//
// Agent-agnostic: transcript path, chat label, and archived flag all come
// through the adapter seams (adapter.transcripts / adapter.sessions); this
// module carries no Claude literal (docs/DRIVERS.md).

import { join, basename } from 'node:path';
import { claimWindows, readActivityLedger, readUsageLedger } from './usage.mjs';
import { adapter } from './drivers.mjs';
import { discoverProjects } from './registry.mjs';
import { loadTasks } from './frontmatter.mjs';
import { tryExec } from './exec.mjs';

// A ledger `project` value matches the wanted slug when it equals it or is one
// of its per-clone keys (`slug__clone`). A null want (the --everywhere case)
// matches everything.
function projectMatcher(want) {
  if (!want) return () => true;
  return (p) => p === want || String(p || '').startsWith(want + '__');
}

// slug → repo path (for the created-side task-file read + git backfill).
function repoPathForProject(slug) {
  if (!slug) return null;
  try {
    for (const p of discoverProjects()) {
      if (p.error) continue;
      if (p.slug === slug || String(p.slug).startsWith(slug + '__')) return p.path;
    }
  } catch {}
  return null;
}

// Per-session metadata assembled ONCE from the durable sources: usage rows give
// the active-time span; the agent's session store gives title + archived flag.
function buildIndex() {
  const times = new Map(); // sid → {first, last}
  for (const row of readUsageLedger()) {
    if (!row.sessionId) continue;
    let m = times.get(row.sessionId);
    if (!m) { m = { first: null, last: null }; times.set(row.sessionId, m); }
    if (row.firstTs && (!m.first || row.firstTs < m.first)) m.first = row.firstTs;
    if (row.lastTs && (!m.last || row.lastTs > m.last)) m.last = row.lastTs;
  }
  const desktop = new Map(); // sid → {title, isArchived, lastActivityAt}
  const sess = adapter.sessions && adapter.sessions.supported ? adapter.sessions : null;
  if (sess) {
    for (const s of sess.list()) {
      if (s.sessionId && !desktop.has(s.sessionId)) desktop.set(s.sessionId, s);
    }
  }
  return { times, desktop };
}

// One session id + its role → the chat entry the surfaces render. transcriptPath
// is the durable handle any surface hands to a reader (`bencc show <id>` or
// Claude's Read tool); it survives archiving — archiving is a UI flag, the
// .jsonl stays on disk (task 106).
function chatEntry(sid, role, idx, inferred = false) {
  const files = adapter.transcripts.findBySession(sid);
  const transcriptPath = files.length ? files[0] : null;
  const d = idx.desktop.get(sid) || {};
  const t = idx.times.get(sid) || {};
  const fromTranscript = transcriptPath && adapter.transcripts.firstHumanLabel
    ? adapter.transcripts.firstHumanLabel(transcriptPath) : null;
  return {
    sessionId: sid,
    role,
    label: fromTranscript || d.title || null,
    startedAt: t.first || null,
    lastActiveAt: t.last || d.lastActivityAt || null,
    transcriptPath,
    archived: !!d.isArchived,
    inferred,
  };
}

// --- created-side inference --------------------------------------------------

// ISO author time of the commit that first ADDED the task file, read from the
// store repo (the _tasks dir, which may be a symlink into the shared store —
// git -C follows it). null when the file/history isn't resolvable.
function taskAddTime(tasksDir, taskFile) {
  if (!taskFile) return null;
  const name = basename(taskFile);
  const out = tryExec(`git log --diff-filter=A --follow --format=%aI -- ${name}`, { cwd: tasksDir });
  if (!out) return null;
  const lines = out.split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null; // oldest add
}

// How far the creation moment may sit outside a candidate session's active span
// before we refuse to call it the creator (a git commit lands shortly AFTER the
// authoring session's last prompt, so 0 is too strict; days apart is noise).
const CREATE_WINDOW_MS = 2 * 86400000;

// Best-effort creator: among the sessions that ACTUALLY REFERENCED this task
// (candidates — write-task's authoring session emits `_tasks/N-` into its own
// transcript, so the real creator is in this set), the one whose human-prompt
// activity sits closest to the task file's git add time. Restricting to
// referencing sessions is what keeps an unrelated long-running session from
// bracketing the add-time and being mislabelled the creator. Conservative: a
// match more than CREATE_WINDOW_MS outside every candidate's span → null (better
// no creator than a wrong one). Culled transcripts (no activity row) → null.
function inferCreator(addTime, candidates, matchProject) {
  if (!addTime || !candidates || !candidates.size) return null;
  const addMs = new Date(addTime).getTime();
  if (Number.isNaN(addMs)) return null;
  const spans = new Map(); // sid → {min, max}
  for (const row of readActivityLedger()) {
    if (!row.sessionId || !candidates.has(row.sessionId) || !matchProject(row.project)) continue;
    for (const ts of row.prompts || []) {
      const ms = new Date(ts).getTime();
      if (Number.isNaN(ms)) continue;
      let s = spans.get(row.sessionId);
      if (!s) { s = { min: ms, max: ms }; spans.set(row.sessionId, s); }
      else { if (ms < s.min) s.min = ms; if (ms > s.max) s.max = ms; }
    }
  }
  let best = null; // smallest distance from the add-time to the session's span
  for (const [sid, s] of spans) {
    const dist = addMs >= s.min && addMs <= s.max ? 0 : Math.min(Math.abs(addMs - s.min), Math.abs(addMs - s.max));
    if (dist > CREATE_WINDOW_MS) continue;
    if (!best || dist < best.dist) best = { sid, dist };
  }
  return best ? best.sid : null;
}

function createdChat(project, taskId, idx, matchProject, candidates) {
  const repo = repoPathForProject(project);
  if (!repo) return null;
  const tasksDir = join(repo, '_tasks');
  let fm = null;
  let taskFile = null;
  try {
    for (const t of loadTasks(tasksDir)) {
      if (t.frontmatter && String(t.frontmatter.id) === String(taskId)) { fm = t.frontmatter; taskFile = t.path; break; }
    }
  } catch {}
  // Forward path (exact): write-task stamps created_by_session into the file it
  // authors. env-block or top-level — accept either.
  const stamped = fm && (fm.created_by_session || (fm.env && fm.env.created_by_session));
  if (stamped) return chatEntry(String(stamped), 'created', idx, false);
  // Backfill path (best-effort, inferred): git add-time × the referencing
  // sessions' activity.
  const sid = inferCreator(taskAddTime(tasksDir, taskFile), candidates, matchProject);
  return sid ? chatEntry(sid, 'created', idx, true) : null;
}

// --- the primitive -----------------------------------------------------------

// → { taskId, project, created, implemented[], mentioned[] }. project is the
// scope slug (null = every project). See the chat-entry shape in chatEntry().
function chatsForTask(project, taskId) {
  const want = String(taskId);
  const matchProject = projectMatcher(project);
  const idx = buildIndex();

  // claimed — the strongest implemented signal (a formal `cogyard env claim`).
  const claimed = new Set();
  for (const [sid, windows] of claimWindows()) {
    for (const w of windows) {
      if (String(w.taskId) === want && matchProject(w.project)) { claimed.add(sid); break; }
    }
  }
  // committed / mentioned — from the banked activity rows, aggregated per
  // session first so the mentioned bucket can apply a RELEVANCE THRESHOLD. A
  // single incidental `_tasks/NN-` (from an `ls _tasks/`, a grep, or reading the
  // index) must NOT tag a whole chat as "mentioned" — that's the same trap
  // core/activity.mjs's sessionTaskIds guards against, and skipping it turned a
  // long-lived low-numbered task's list into ~every chat in the project.
  const agg = new Map(); // sid → { tasks:{id:count}, commit:{id:count} }
  for (const row of readActivityLedger()) {
    if (!row.sessionId || !matchProject(row.project)) continue;
    let a = agg.get(row.sessionId);
    if (!a) { a = { tasks: {}, commit: {} }; agg.set(row.sessionId, a); }
    for (const [id, n] of Object.entries(row.tasks || {})) a.tasks[id] = (a.tasks[id] || 0) + n;
    for (const [id, n] of Object.entries(row.commitTasks || {})) a.commit[id] = (a.commit[id] || 0) + n;
  }
  const committed = new Set();
  const mentionedRaw = new Set();
  // The banked commit/ref counts are collected per whole transcript RECORD, not
  // per git-commit command line (a `core/usage.mjs` limitation), so a record
  // holding git-log output or a doc lists several `[#NN]`/`_tasks/NN-` tags that
  // co-occur with identical counts — e.g. {37:4, 40:4, 89:4} where only 89 is
  // real. Proportional dominance can't separate a tie, so require want to be the
  // session's UNIQUE top signal; a tie means the ledger genuinely can't attribute.
  const uniqueTop = (counts) => {
    const vals = Object.values(counts);
    if (!vals.length) return null;
    const top = Math.max(...vals);
    const leaders = Object.keys(counts).filter((k) => counts[k] === top);
    return leaders.length === 1 ? leaders[0] : null; // null on a tie
  };
  for (const [sid, a] of agg) {
    // Own `[#NN]` commit — only when want is the session's UNIQUE top commit task.
    if (uniqueTop(a.commit) === want) committed.add(sid);
    // Text ref — only when want is the session's UNIQUE top ref AND clears floor 2
    // (a single incidental mention never tags).
    if (uniqueTop(a.tasks) === want && (a.tasks[want] || 0) >= 2) mentionedRaw.add(sid);
  }

  // implemented = claimed ∪ committed, deduped, claimed-before-committed, then
  // most-recent-first within each rank.
  const seen = new Set();
  const implemented = [];
  const recency = (a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || ''));
  const claimedEntries = [...claimed].map((sid) => { seen.add(sid); return chatEntry(sid, 'claimed', idx); }).sort(recency);
  const committedEntries = [...committed].filter((sid) => !seen.has(sid))
    .map((sid) => { seen.add(sid); return chatEntry(sid, 'committed', idx); }).sort(recency);
  implemented.push(...claimedEntries, ...committedEntries);

  // mentioned = tasks-only touches not already implemented.
  const mentioned = [...mentionedRaw].filter((sid) => !seen.has(sid))
    .map((sid) => chatEntry(sid, 'mentioned', idx)).sort(recency);

  // Creator search: use the LOOSE referencing set — any session that touched the
  // task at all (even a single incidental mention). The displayed committed/
  // mentioned buckets are tightly gated, but the creator is picked by nearest git
  // add-time within a 2-day window (inferCreator's own gate), so the wider net
  // recovers the real author (e.g. a grab-bag session whose ref never dominates)
  // without letting an unrelated session win.
  const referencing = new Set([...claimed]);
  for (const [sid, a] of agg) { if (a.commit[want] || a.tasks[want]) referencing.add(sid); }
  const created = createdChat(project, taskId, idx, matchProject, referencing);

  return { taskId: Number(taskId), project: project || null, created, implemented, mentioned };
}

// One chat's readable transcript, for the portal viewer (task 30 follow-up).
// Resolves the durable transcript path via the adapter and asks it to parse the
// conversation into turns — the read half the owner wanted IN the portal, not
// just a copyable `bencc show` command. Returns found:false when the transcript
// was culled (the chat metadata may survive, the .jsonl doesn't).
// → { sessionId, found, transcriptPath, turns:[{role,text,timestamp}], truncated }
function transcriptForChat(sessionId) {
  const files = sessionId ? adapter.transcripts.findBySession(sessionId) : [];
  const file = files.length ? files[0] : null;
  if (!file) return { sessionId, found: false, transcriptPath: null, turns: [], truncated: false };
  const { turns, truncated } = adapter.transcripts.readTurns
    ? adapter.transcripts.readTurns(file) : { turns: [], truncated: false };
  return { sessionId, found: true, transcriptPath: file, turns, truncated };
}

export { chatsForTask, transcriptForChat };
