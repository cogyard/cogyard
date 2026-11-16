// core/sessions-audit.mjs — the archived-chat × worktree join (task 106).
//
// READ-ONLY. This module computes the audit report: for every ARCHIVED agent
// chat (via the driver's `sessions` seam), which live worktree it maps to and
// whether that worktree is safe to remove. It never writes, removes, or locks
// anything — the cleanup action lives in core/cleanup.mjs, reached through
// cli/cleanup.mjs behind the trust model's interactive gates (task 117), and
// even there this module only supplies verdicts.
//
// Verdict ladder (first failing check wins; ordered by blast radius):
//   LIVE       lock names a pid that is still running — someone is IN there
//   LOCKED     locked (stale or reason-less) — removal would need an unlock
//   DIRTY      uncommitted changes — the one true data-loss vector
//   UNMERGED   branch has commits the default branch lacks, and origin does not
//              hold this exact commit (absent, behind, ahead or diverged)
//   PUSHED     clean + unlocked + NOT merged, but origin/<branch> is the local
//              branch head — removable: the checkout holds nothing that is not
//              on the branch (which removal keeps) and on origin (task 174)
//   REMOVABLE  clean + merged + unlocked — safe; report carries remove+undo cmds
//   NO_WORKTREE / NO_REPO / UNKNOWN — nothing to act on / unreadable state
//
// The chat→worktree join is deliberately conservative: a task id mined from the
// chat TITLE ("Pick up 74", "task 74", "#74") or the task file whose recorded
// env.worktree matches. No fuzzy matching — a wrong join here could point the
// cleanup gate at the wrong checkout.

import { join, basename, resolve as resolvePath } from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adapter } from './drivers.mjs';
import { tryExec, findRepoRoot, defaultBranchSync } from './exec.mjs';
import { loadTasks } from './frontmatter.mjs';
import { resolveProjectForPath } from './usage.mjs';
import { tasksDirOf } from './tasks-dir.mjs';

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

// The lock's pid is the process that CREATED the worktree. A chat that is
// restarted (app relaunch, session resume) keeps working in the same worktree
// under a NEW pid and never rewrites the lock — so a dead lock pid alone does
// not mean nobody is there. Judging it stale on that basis offered an unlock
// for a running chat's own worktree (task 148). The second signal: is any
// running process's working directory inside the worktree — the agent, its
// shell, a dev server. One `lsof` over every process (~0.4s), memoised briefly
// so a report judging dozens of worktrees pays for it once, and only reached
// when some lock's pid is already dead. null = lsof unavailable/failed.
let cwdMemo = { at: 0, cwds: null };
function processCwds() {
  if (Date.now() - cwdMemo.at < 5000) return cwdMemo.cwds;
  const r = spawnSync('lsof', ['-w', '-d', 'cwd', '-Fn'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // lsof exits 1 when it merely couldn't inspect some processes; its output is
  // still good. Only a failure to run at all (r.error) means "don't know".
  const cwds = r.error ? null
    : String(r.stdout || '').split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1));
  cwdMemo = { at: Date.now(), cwds };
  return cwds;
}
function inUseByAnyProcess(dir) {
  const cwds = processCwds();
  if (!cwds) return false;
  const root = resolvePath(dir);
  return cwds.some((c) => c === root || c.startsWith(root + '/'));
}

// task id → recorded env.worktree name, from the repo's task files.
function recordedWorktreeByTask(repoPath) {
  const map = new Map();
  try {
    for (const t of loadTasks(tasksDirOf(repoPath))) {
      const fm = t.frontmatter || {};
      if (fm.id != null && fm.env && fm.env.worktree) map.set(Number(fm.id), fm.env.worktree);
    }
  } catch {}
  return map;
}

const execFileP = promisify(execFile);

// tryExec's contract (trimmed stdout, null on any failure) without blocking the
// event loop — so N worktrees can be judged at once instead of one after another.
async function tryExecAsync(args, opts = {}) {
  try { return (await execFileP('git', args, { encoding: 'utf8', ...opts })).stdout.trim(); }
  catch { return null; }
}

// Every local branch already contained in `base`, in ONE call. This replaces a
// `git merge-base --is-ancestor` per worktree: identical question (is the
// branch's tip an ancestor of base), 33 processes down to 1 — measured 394ms →
// 36ms on this machine. null means the call failed, and callers fall back to
// asking per branch rather than guessing "unmerged" and hiding a Remove button.
async function mergedBranchSet(repoPath, base) {
  if (!base) return null;
  const out = await tryExecAsync(['branch', '--merged', base, '--format=%(refname:short)'], { cwd: repoPath });
  if (out == null) return null;
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

// Every remote-tracking branch under origin → its commit, in ONE call — the
// "is this branch on origin at this exact commit" question batched the same way
// mergedBranchSet batches the merged one. Reads the LOCAL remote-tracking refs:
// as current as the last fetch, never more. The report must stay offline and
// fast, so it never fetches; the removal path asks the remote itself
// (core/cleanup.mjs, `git ls-remote`) before acting on a PUSHED verdict.
// An empty map means "no origin refs" (no remote, or never fetched); null means
// the call failed, and callers fall back to asking per branch.
async function originBranchMap(repoPath) {
  const out = await tryExecAsync(['for-each-ref', '--format=%(refname)|%(objectname)', 'refs/remotes/origin/'], { cwd: repoPath });
  if (out == null) return null;
  const map = new Map();
  for (const line of out.split('\n')) {
    const [ref, sha] = line.trim().split('|');
    if (!ref || !sha) continue;
    const name = ref.replace(/^refs\/remotes\/origin\//, '');
    if (name === 'HEAD') continue; // the symbolic origin/HEAD, not a branch
    map.set(name, sha);
  }
  return map;
}

// The commit origin/<branch> points at, from the batched map when there is one,
// else asked directly. null = origin has no such branch.
async function originShaFor(repoPath, branch, originMap) {
  if (originMap) return originMap.get(branch) || null;
  return tryExecAsync(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { cwd: repoPath });
}

// Verdict for one worktree entry (never the main checkout — callers exclude it).
//
// The ladder and its order are UNCHANGED — this is the same sequence of
// questions, asked without blocking: the lock checks stay synchronous (reading a
// porcelain field and one `ps`), and the two git questions that actually cost
// something are awaited, so a caller can have every worktree in flight at once.
// `mergedSet` is the batched answer to "is this branch merged"; passing null
// falls back to asking git per branch. `originMap` is the same for "where is
// origin/<branch>" (originBranchMap); null falls back to one rev-parse.
//
// PUSHED sits between UNMERGED and REMOVABLE (task 174): an unmerged branch
// whose origin copy is at exactly the local head. Only an exact match counts —
// origin behind means local commits exist nowhere else, and origin ahead or
// diverged means the two disagree about what the work is; both stay UNMERGED,
// with the detail saying which.
async function verdictFor(entry, base, repoPath, mergedSet = null, originMap = null) {
  const pid = pidFromLockReason(entry.lockReason);
  if (entry.locked && pidAlive(pid)) return { verdict: 'LIVE', detail: `locked by running pid ${pid}` };
  if (entry.locked && inUseByAnyProcess(entry.path)) {
    return { verdict: 'LIVE', detail: `locked; its recorded pid ${pid ?? '?'} is gone, but a running process is working inside it` };
  }
  if (entry.locked) return { verdict: 'LOCKED', detail: entry.lockReason ? `lock: ${entry.lockReason}` : 'locked (no reason recorded)' };
  const st = await tryExecAsync(['status', '--porcelain'], { cwd: entry.path });
  if (st == null) return { verdict: 'UNKNOWN', detail: 'worktree dir unreadable — refusing to judge' };
  const dirtyCount = st ? st.split('\n').filter(Boolean).length : 0;
  if (dirtyCount > 0) return { verdict: 'DIRTY', detail: `${dirtyCount} uncommitted change(s) — would be destroyed` };
  if (!entry.branch) return { verdict: 'UNKNOWN', detail: 'detached HEAD — refusing to judge' };
  if (!base) return { verdict: 'UNKNOWN', detail: 'no default branch resolved' };
  const merged = mergedSet
    ? mergedSet.has(entry.branch)
    : spawnSync('git', ['merge-base', '--is-ancestor', entry.branch, base], { cwd: repoPath, stdio: 'ignore' }).status === 0;
  if (!merged) {
    const [n, head, originSha] = await Promise.all([
      tryExecAsync(['rev-list', '--count', `${base}..${entry.branch}`], { cwd: repoPath }),
      tryExecAsync(['rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}^{commit}`], { cwd: repoPath }),
      originShaFor(repoPath, entry.branch, originMap),
    ]);
    const notOnBase = `${n || '?'} commit(s) not on ${base}`;
    const originRef = `origin/${entry.branch}`;
    if (!originSha) return { verdict: 'UNMERGED', detail: `${notOnBase}; not on origin` };
    if (head && originSha === head) {
      return { verdict: 'PUSHED', detail: `clean, not merged to ${base} (${notOnBase}); ${originRef} is at this commit`, originRef };
    }
    // How origin and the local branch differ: left = only on origin, right =
    // only local.
    const lr = await tryExecAsync(['rev-list', '--left-right', '--count', `${originSha}...refs/heads/${entry.branch}`], { cwd: repoPath });
    const [onlyOrigin, onlyLocal] = String(lr || '').split(/\s+/).map(Number);
    let why;
    if (lr == null || !Number.isFinite(onlyOrigin) || !Number.isFinite(onlyLocal)) why = `${originRef} differs from the local branch`;
    else if (onlyOrigin === 0) why = `origin is ${onlyLocal} behind`;
    else if (onlyLocal === 0) why = `origin is ${onlyOrigin} ahead`;
    else why = `origin has diverged (${onlyLocal} local, ${onlyOrigin} on origin)`;
    return { verdict: 'UNMERGED', detail: `${notOnBase}; ${why}` };
  }
  return { verdict: 'REMOVABLE', detail: `clean, merged to ${base}, unlocked` };
}

// The verdicts cleanup may remove: merged (REMOVABLE) or, unmerged but
// backed up at this exact commit on origin (PUSHED). One definition, read by
// the row builders here, core/cleanup.mjs actionFor/removeWorktree and the CLI.
const REMOVABLE_VERDICTS = new Set(['REMOVABLE', 'PUSHED']);
function isRemovableVerdict(verdict) { return REMOVABLE_VERDICTS.has(verdict); }

// One chat's metadata → the joined row (verdict, worktree, remove/undo cmds).
// Shared by the audit (archived chats) and retire (any chat found by query).
async function resolveChat(s, repoCache) {
  const row = {
    title: s.title, sessionId: s.sessionId, lastActivityAt: s.lastActivityAt,
    isArchived: !!s.isArchived,
    project: s.cwd ? resolveProjectForPath(s.cwd) : null,
    transcript: null, taskId: taskIdFromTitle(s.title), worktree: null,
    verdict: 'NO_WORKTREE', detail: null, originRef: null, removeCmd: null, undoCmd: null, repoPath: null,
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

  const v = await verdictFor(wt, repo.base, repoPath);
  row.worktree = { name: basename(wt.path), path: wt.path, branch: wt.branch || null, head: wt.head ? wt.head.slice(0, 7) : null };
  row.verdict = v.verdict;
  row.detail = v.detail;
  row.originRef = v.originRef || null;
  if (isRemovableVerdict(v.verdict)) {
    row.removeCmd = `git -C ${repoPath} worktree remove ${wt.path}`;
    row.undoCmd = `git -C ${repoPath} worktree add ${wt.path} ${wt.branch}`;
  }
  if (v.verdict === 'LOCKED') row.detail += ` — inspect, then: git -C ${repoPath} worktree unlock ${wt.path} (NOT run for you)`;
  return row;
}

// The audit: one row per archived chat. Pure computation over read-only inputs.
// Rows resolve concurrently — each one's verdict is two git questions, and
// asking them one chat at a time was most of this report's wall clock.
async function sessionsAudit() {
  const sessions = (adapter.sessions && adapter.sessions.supported) ? adapter.sessions.listArchived() : [];
  const repoCache = new Map();
  return {
    driver: adapter.name,
    supported: !!(adapter.sessions && adapter.sessions.supported),
    rows: await Promise.all(sessions.map((s) => resolveChat(s, repoCache))),
  };
}

// The chat finder for `retire`: case-insensitive query against chat
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
// Judged CONCURRENTLY, and the merge question asked once for the whole repo
// rather than once per worktree. On this machine, 33 worktrees: 1279ms → ~125ms.
// The old shape was a `for` loop of blocking git calls, which is fine for one
// worktree and quadratically annoying for a backlog of them — and this report is
// what the Cleanup tab waits on before it can render anything.
async function allWorktreeCandidates(startDir) {
  const repoPath = findRepoRoot(startDir || process.cwd());
  if (!repoPath) return { repoPath: null, rows: [] };
  const base = defaultBranchSync(repoPath);
  const recorded = recordedWorktreeByTask(repoPath);
  const nameToTask = new Map([...recorded].map(([id, name]) => [name, id]));
  const project = resolveProjectForPath(repoPath);
  const [mergedSet, originMap] = await Promise.all([mergedBranchSet(repoPath, base), originBranchMap(repoPath)]);
  const entries = worktreesWithLocks(repoPath).slice(1); // [0] = main checkout
  const rows = await Promise.all(entries.map(async (wt) => {
    const name = basename(wt.path);
    const m = name.match(/^task-0*(\d+)(?:-|$)/);
    const taskId = nameToTask.get(name) ?? (m ? Number(m[1]) : null);
    const v = await verdictFor(wt, base, repoPath, mergedSet, originMap);
    const canRemove = isRemovableVerdict(v.verdict);
    return {
      title: name, project, taskId,
      worktree: { name, path: wt.path, branch: wt.branch || null, head: wt.head ? wt.head.slice(0, 7) : null },
      verdict: v.verdict, detail: v.detail, originRef: v.originRef || null, repoPath,
      removeCmd: canRemove ? `git -C ${repoPath} worktree remove ${wt.path}` : null,
      undoCmd: canRemove ? `git -C ${repoPath} worktree add ${wt.path} ${wt.branch}` : null,
    };
  }));
  return { repoPath, rows };
}

// ONE worktree's candidate row, freshly judged. The removal precheck used to
// build the whole repo's list and then `.find()` the one it was about to
// remove — 33 worktrees' worth of git to answer a question about one of them,
// paid on every single removal.
async function worktreeCandidate(startDir, worktreePath) {
  const target = resolvePath(worktreePath);
  const repoPath = findRepoRoot(startDir || process.cwd());
  if (!repoPath) return null;
  const entry = worktreesWithLocks(repoPath).slice(1).find((w) => resolvePath(w.path) === target);
  if (!entry) return null;
  const base = defaultBranchSync(repoPath);
  const recorded = recordedWorktreeByTask(repoPath);
  const name = basename(entry.path);
  const m = name.match(/^task-0*(\d+)(?:-|$)/);
  const nameToTask = new Map([...recorded].map(([id, n]) => [n, id]));
  const v = await verdictFor(entry, base, repoPath);
  const canRemove = isRemovableVerdict(v.verdict);
  return {
    title: name, project: resolveProjectForPath(repoPath), taskId: nameToTask.get(name) ?? (m ? Number(m[1]) : null),
    worktree: { name, path: entry.path, branch: entry.branch || null, head: entry.head ? entry.head.slice(0, 7) : null },
    verdict: v.verdict, detail: v.detail, originRef: v.originRef || null, repoPath,
    removeCmd: canRemove ? `git -C ${repoPath} worktree remove ${entry.path}` : null,
    undoCmd: canRemove ? `git -C ${repoPath} worktree add ${entry.path} ${entry.branch}` : null,
  };
}

// The ladder read from the CHAT's side: is archiving this chat safe (its work
// landed), premature (work still in flight), or moot (no worktree to clean)?
// core/cleanup.mjs's `actionFor` reads the same ladder from the WORKTREE's side.
// Both readings live in core/ so the CLI and the portal cannot drift apart; this
// one lives HERE, beside the ladder that produces the verdicts, because its only
// consumers are read-only reports — core/cleanup.mjs also exports the removal.
//
// The four keys are load-bearing: they ship in `sessions archivable --json`.
function archiveBucketOf(verdict) {
  if (verdict === 'REMOVABLE' || verdict === 'NO_WORKTREE') return 'safe';
  if (verdict === 'LOCKED') return 'safe_stale_lock';
  // PUSHED is in flight too: backed up on origin, but the work has not landed,
  // so the chat that drove it may still be needed.
  if (verdict === 'DIRTY' || verdict === 'UNMERGED' || verdict === 'PUSHED' || verdict === 'LIVE') return 'in_flight';
  return 'no_verdict';
}

export { sessionsAudit, findChats, resolveChat, allWorktreeCandidates, worktreeCandidate, taskIdFromTitle, pidFromLockReason, worktreesWithLocks, archiveBucketOf, isRemovableVerdict, originBranchMap };
