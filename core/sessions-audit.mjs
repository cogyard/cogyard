// core/sessions-audit.mjs — the archived-chat × worktree join (task 106).
//
// READ-ONLY. This module computes the audit report: for every ARCHIVED agent
// chat (via the driver's `sessions` seam), which live worktree it maps to and
// whether that worktree is safe to remove. It never writes, removes, or locks
// anything — the cleanup action lives in cli/sessions.mjs behind the trust
// model's interactive gates, and even there this module only supplies verdicts.
//
// Verdict ladder (first failing check wins; ordered by blast radius):
//   LIVE       lock names a pid that is still running — someone is IN there
//   LOCKED     locked (stale or reason-less) — removal would need an unlock
//   DIRTY      uncommitted changes — the one true data-loss vector
//   UNMERGED   branch has commits the default branch lacks
//   REMOVABLE  clean + merged + unlocked — safe; report carries remove+undo cmds
//   NO_WORKTREE / NO_REPO / UNKNOWN — nothing to act on / unreadable state
//
// The chat→worktree join is deliberately conservative: a task id mined from the
// chat TITLE ("Pick up 74", "task 74", "#74") or the task file whose recorded
// env.worktree matches. No fuzzy matching — a wrong join here could point the
// cleanup gate at the wrong checkout.

import { join, basename } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { adapter } from './drivers.mjs';
import { tryExec, findRepoRoot, defaultBranchSync } from './exec.mjs';
import { loadTasks } from './frontmatter.mjs';
import { resolveProjectForPath } from './usage.mjs';

// `git worktree list --porcelain`, keeping the LOCK REASON (core/worktrees.mjs
// drops it; the pid inside it is how we detect a live session).
function worktreesWithLocks(repoPath) {
  const raw = tryExec('git worktree list --porcelain', { cwd: repoPath });
  if (!raw) return [];
  const entries = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) { if (cur) entries.push(cur); cur = { path: line.slice(9) }; }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'locked') cur.locked = true;
    else if (line.startsWith('locked ')) { cur.locked = true; cur.lockReason = line.slice(7); }
  }
  if (cur) entries.push(cur);
  return entries;
}

// Task id from a chat title — the same conservative patterns the by-hand audit
// used. Returns a number or null; never guesses from bare digits mid-sentence.
function taskIdFromTitle(title) {
  const t = String(title || '');
  const m = t.match(/\bpick\s*up\s*0*(\d{1,4})\b/i)
    || t.match(/\btask\s*0*(\d{1,4})\b/i)
    || t.match(/#0*(\d{1,4})\b/);
  return m ? Number(m[1]) : null;
}

// pid embedded in a Claude worktree lock reason, e.g.
// "claude session foo (pid 20880 start Sat Jul 18 …)". Agent-agnostic parse.
function pidFromLockReason(reason) {
  const m = String(reason || '').match(/\bpid\s+(\d+)\b/);
  return m ? Number(m[1]) : null;
}

function pidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync('ps', ['-p', String(pid)], { stdio: 'ignore' });
  return r.status === 0;
}

// task id → recorded env.worktree name, from the repo's task files.
function recordedWorktreeByTask(repoPath) {
  const map = new Map();
  try {
    for (const t of loadTasks(join(repoPath, '_tasks'))) {
      const fm = t.frontmatter || {};
      if (fm.id != null && fm.env && fm.env.worktree) map.set(Number(fm.id), fm.env.worktree);
    }
  } catch {}
  return map;
}

// Verdict for one worktree entry (never the main checkout — callers exclude it).
function verdictFor(entry, base, repoPath) {
  const pid = pidFromLockReason(entry.lockReason);
  if (entry.locked && pidAlive(pid)) return { verdict: 'LIVE', detail: `locked by running pid ${pid}` };
  if (entry.locked) return { verdict: 'LOCKED', detail: entry.lockReason ? `lock: ${entry.lockReason}` : 'locked (no reason recorded)' };
  const st = tryExec('git status --porcelain', { cwd: entry.path });
  if (st == null) return { verdict: 'UNKNOWN', detail: 'worktree dir unreadable — refusing to judge' };
  const dirtyCount = st ? st.split('\n').filter(Boolean).length : 0;
  if (dirtyCount > 0) return { verdict: 'DIRTY', detail: `${dirtyCount} uncommitted change(s) — would be destroyed` };
  if (!entry.branch) return { verdict: 'UNKNOWN', detail: 'detached HEAD — refusing to judge' };
  if (!base) return { verdict: 'UNKNOWN', detail: 'no default branch resolved' };
  const merged = spawnSync('git', ['merge-base', '--is-ancestor', entry.branch, base], { cwd: repoPath, stdio: 'ignore' });
  if (merged.status !== 0) {
    const n = tryExec(`git rev-list --count ${base}..${entry.branch}`, { cwd: repoPath });
    return { verdict: 'UNMERGED', detail: `${n || '?'} commit(s) not on ${base}` };
  }
  return { verdict: 'REMOVABLE', detail: `clean, merged to ${base}, unlocked` };
}

// One chat's metadata → the joined row (verdict, worktree, remove/undo cmds).
// Shared by the audit (archived chats) and retire (any chat found by query).
function resolveChat(s, repoCache) {
  const row = {
    title: s.title, sessionId: s.sessionId, lastActivityAt: s.lastActivityAt,
    isArchived: !!s.isArchived,
    project: s.cwd ? resolveProjectForPath(s.cwd) : null,
    transcript: null, taskId: taskIdFromTitle(s.title), worktree: null,
    verdict: 'NO_WORKTREE', detail: null, removeCmd: null, undoCmd: null, repoPath: null,
  };

  const files = s.sessionId ? adapter.transcripts.findBySession(s.sessionId) : [];
  row.transcript = {
    count: files.length,
    bytes: files.reduce((n, f) => { try { return n + statSync(f).size; } catch { return n; } }, 0),
  };

  const repoPath = s.cwd && existsSync(s.cwd) ? findRepoRoot(s.cwd) : null;
  if (!repoPath) { row.verdict = 'NO_REPO'; row.detail = 'chat cwd is gone or not a git repo'; return row; }
  row.repoPath = repoPath;

  if (!repoCache.has(repoPath)) {
    const all = worktreesWithLocks(repoPath);
    repoCache.set(repoPath, {
      worktrees: all.slice(1), // [0] is the main checkout — never a candidate
      base: defaultBranchSync(repoPath),
      recorded: recordedWorktreeByTask(repoPath),
    });
  }
  const repo = repoCache.get(repoPath);

  // Join: recorded env.worktree for the title's task id, else task-NNN-* name.
  let wt = null;
  if (row.taskId != null) {
    const recName = repo.recorded.get(row.taskId);
    if (recName) wt = repo.worktrees.find((w) => basename(w.path) === recName) || null;
    if (!wt) {
      const re = new RegExp(`^task-0*${row.taskId}(?:-|$)`);
      wt = repo.worktrees.find((w) => re.test(basename(w.path))) || null;
    }
  }
  if (!wt) { row.detail = row.taskId != null ? `no live worktree for task ${row.taskId}` : 'no task id derivable from title'; return row; }

  const v = verdictFor(wt, repo.base, repoPath);
  row.worktree = { name: basename(wt.path), path: wt.path, branch: wt.branch || null, head: wt.head ? wt.head.slice(0, 7) : null };
  row.verdict = v.verdict;
  row.detail = v.detail;
  if (v.verdict === 'REMOVABLE') {
    row.removeCmd = `git -C ${repoPath} worktree remove ${wt.path}`;
    row.undoCmd = `git -C ${repoPath} worktree add ${wt.path} ${wt.branch}`;
  }
  if (v.verdict === 'LOCKED') row.detail += ` — inspect, then: git -C ${repoPath} worktree unlock ${wt.path} (NOT run for you)`;
  return row;
}

// The audit: one row per archived chat. Pure computation over read-only inputs.
function sessionsAudit() {
  const sessions = (adapter.sessions && adapter.sessions.supported) ? adapter.sessions.listArchived() : [];
  const repoCache = new Map();
  return {
    driver: adapter.name,
    supported: !!(adapter.sessions && adapter.sessions.supported),
    rows: sessions.map((s) => resolveChat(s, repoCache)),
  };
}

// /bd-chats-style finder for `retire`: case-insensitive query against chat
// TITLES and transcript FULL TEXT, over NON-archived chats (retire's targets).
// Title hits rank above content hits; then by hit count; then recency.
function findChats(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const sessions = (adapter.sessions && adapter.sessions.supported) ? adapter.sessions.list() : [];
  const out = [];
  for (const s of sessions) {
    if (s.isArchived) continue;
    const titleHit = String(s.title || '').toLowerCase().includes(q);
    let hits = 0;
    for (const f of s.sessionId ? adapter.transcripts.findBySession(s.sessionId) : []) {
      try {
        const text = readFileSync(f, 'utf8').toLowerCase();
        let i = -1;
        while ((i = text.indexOf(q, i + 1)) !== -1 && hits < 500) hits += 1;
      } catch {}
    }
    if (titleHit || hits > 0) out.push({ session: s, titleHit, hits });
  }
  out.sort((a, b) => (b.titleHit - a.titleHit) || (b.hits - a.hits)
    || String(b.session.lastActivityAt).localeCompare(String(a.session.lastActivityAt)));
  return out;
}

// `--all` candidates: EVERY worktree of one repo (chat state ignored), each
// with the same verdict ladder. For the checkbox cleanup over the whole
// backlog — the archived-chats join above only sees chats that were archived,
// which is not where most dead worktrees live (owner finding, 2026-07-20).
function allWorktreeCandidates(startDir) {
  const repoPath = findRepoRoot(startDir || process.cwd());
  if (!repoPath) return { repoPath: null, rows: [] };
  const base = defaultBranchSync(repoPath);
  const recorded = recordedWorktreeByTask(repoPath);
  const nameToTask = new Map([...recorded].map(([id, name]) => [name, id]));
  const project = resolveProjectForPath(repoPath);
  const rows = [];
  for (const wt of worktreesWithLocks(repoPath).slice(1)) { // [0] = main checkout
    const name = basename(wt.path);
    const m = name.match(/^task-0*(\d+)(?:-|$)/);
    const taskId = nameToTask.get(name) ?? (m ? Number(m[1]) : null);
    const v = verdictFor(wt, base, repoPath);
    rows.push({
      title: name, project, taskId,
      worktree: { name, path: wt.path, branch: wt.branch || null, head: wt.head ? wt.head.slice(0, 7) : null },
      verdict: v.verdict, detail: v.detail, repoPath,
      removeCmd: v.verdict === 'REMOVABLE' ? `git -C ${repoPath} worktree remove ${wt.path}` : null,
      undoCmd: v.verdict === 'REMOVABLE' ? `git -C ${repoPath} worktree add ${wt.path} ${wt.branch}` : null,
    });
  }
  return { repoPath, rows };
}

export { sessionsAudit, findChats, resolveChat, allWorktreeCandidates, taskIdFromTitle, pidFromLockReason, worktreesWithLocks };
