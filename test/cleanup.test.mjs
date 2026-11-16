// test/cleanup.test.mjs — task 117: the cleanup service's decisions.
//
// The report walks live git and the driver's metadata, so it's exercised
// against this machine's real backlog. What belongs HERE is the pure judgement
// the surface exists to make: IS THIS CHAT READY TO ARCHIVE?
//
// Task 152 changed the rule: a chat waits only on tasks it WORKED on
// (committed for, claimed, ran in the worktree of, created, or edited the file
// of). Tasks it only looked up never hold it — a foundational task read from
// many chats used to hold them all until it closed. It is also held while ANY
// worktree it ran in is still on disk: archiving a Desktop-managed worktree's
// chat force-removes the checkout. READY is advice only; cogyard never archives.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The removal tests below run core against throwaway git repos. Point
// COGYARD_HOME at an empty temp dir BEFORE core is imported (paths.mjs resolves
// it at import), so nothing here reads or writes the real ~/.cogyard. The Node
// test runner gives each file its own process, so this never leaks.
const COGYARD_TMP = mkdtempSync(join(tmpdir(), 'cy-cleanup-home-'));
process.env.COGYARD_HOME = COGYARD_TMP;
after(() => rmSync(COGYARD_TMP, { recursive: true, force: true }));

const { chatArchiveReadiness, workedTasks, actionFor, rankChatsForTask, chatForWorktree, removeWorktree } = await import('../core/cleanup.mjs');
const { allWorktreeCandidates, worktreeCandidate } = await import('../core/sessions-audit.mjs');

const done = { status: 'DONE', done: true };
const open = { status: 'OPEN', done: false };
const parked = { status: 'PARKED', done: false };
const statuses = (o) => new Map(Object.entries(o));
const noLiveWorktrees = new Set();
// A chat that worked on `ids` (by commit), plus whatever it only looked up.
const chat = (worked, lookedUp = [], extra = {}) => ({
  taskIds: [...worked, ...lookedUp],
  worked: Object.fromEntries(worked.map((id) => [id, ['committed']])),
  ...extra,
});

test('single finished worked task, worktree already gone → ready', () => {
  const r = chatArchiveReadiness(chat(['113']), statuses({ 113: done }), noLiveWorktrees);
  assert.equal(r.ready, true);
  assert.match(r.reason, /only worked on #113/);
});

test('every worked task finished → ready, and the reason names them all', () => {
  const r = chatArchiveReadiness(chat(['113', '118']), statuses({ 113: done, 118: done }), noLiveWorktrees);
  assert.equal(r.ready, true);
  assert.match(r.reason, /#113, #118/);
});

test('ONE open worked task in a multi-task chat holds it', () => {
  const r = chatArchiveReadiness(chat(['113', '118']), statuses({ 113: done, 118: open }), noLiveWorktrees);
  assert.equal(r.ready, false);
  assert.deepEqual(r.waitingOn.map((w) => w.taskId), ['118']);
  assert.match(r.reason, /waiting on #118/);
});

test('a task only looked up never holds the chat — "Pick up 102" and #33', () => {
  // The bug: "Pick up 102" finished #102, grepped #33's file a few times, and
  // was held until #33 (PARKED) closed.
  const r = chatArchiveReadiness(chat(['102'], ['33']), statuses({ 102: done, 33: parked }), noLiveWorktrees);
  assert.equal(r.ready, true);
  assert.deepEqual(r.waitingOn, []);
  const t33 = r.tasks.find((t) => t.id === '33');
  assert.equal(t33.worked, false);          // still listed, as a lookup
  assert.equal(r.tasks.find((t) => t.id === '102').worked, true);
});

test('a chat that worked on no task is READY — even if it looked some up', () => {
  const r = chatArchiveReadiness(chat([], ['4', '21']), statuses({ 4: open, 21: open }), noLiveWorktrees);
  assert.equal(r.ready, true);
  assert.match(r.reason, /worked on no task/);
  const r2 = chatArchiveReadiness({ taskIds: [] }, statuses({}), noLiveWorktrees);
  assert.equal(r2.ready, true);
});

test('a worked task whose worktree is still on disk holds the chat', () => {
  const r = chatArchiveReadiness(chat(['113']), statuses({ 113: done }), new Set(['113']));
  assert.equal(r.ready, false);
  assert.equal(r.waitingOn[0].why, 'worktree still on disk');
});

test('ANY worktree the chat ran in, task-named or not, holds it while on disk', () => {
  // A chat with no worked task ran in `website-copy`. Archiving it could
  // force-remove that checkout, uncommitted work included.
  const c = chat([], [], { ranIn: { 'where-is-maya': 40, 'website-copy': 300 } });
  const r = chatArchiveReadiness(c, statuses({}), noLiveWorktrees, new Set(['website-copy']));
  assert.equal(r.ready, false);
  assert.deepEqual(r.waitingOn, [{ worktree: 'website-copy', why: 'worktree still on disk' }]);
  assert.match(r.reason, /worktree website-copy/);
  // …and once it is removed, the chat is ready.
  assert.equal(chatArchiveReadiness(c, statuses({}), noLiveWorktrees, new Set()).ready, true);
});

test('a worktree only NAMED by the chat (not run in) does not hold it', () => {
  // `worktrees` counts names seen in commands (`git worktree list`, `ls`);
  // only `ranIn` (the chat's own cwd) is evidence archiving could touch it.
  const c = chat([], [], { worktrees: { 'task-117-cleanup-surface': 3 }, ranIn: {} });
  const r = chatArchiveReadiness(c, statuses({}), noLiveWorktrees, new Set(['task-117-cleanup-surface']));
  assert.equal(r.ready, true);
});

// --- ids that name no task in THIS project (task 144) ------------------------

test('an id that names no task here is dropped', () => {
  const r = chatArchiveReadiness(chat(['999']), statuses({}), noLiveWorktrees);
  assert.deepEqual(r.waitingOn, []);
  assert.deepEqual(r.tasks, []);
});

test('a foreign id is dropped, but a real open worked task still holds', () => {
  const r = chatArchiveReadiness(chat(['999', '118']), statuses({ 118: open }), noLiveWorktrees);
  assert.equal(r.ready, false);
  assert.deepEqual(r.waitingOn.map((w) => w.taskId), ['118']);
  assert.deepEqual(r.tasks.map((t) => t.id), ['118']);
});

test('every hold is reported, not just the first', () => {
  const r = chatArchiveReadiness(chat(['1', '2', '3']), statuses({ 1: done, 2: open, 3: open }), noLiveWorktrees);
  assert.deepEqual(r.waitingOn.map((w) => w.taskId), ['2', '3']);
});

// --- workedTasks: which signals count as WORK --------------------------------

test('workedTasks: commits, claims, worktree runs, creation and task-file edits', () => {
  const store = mkdtempSync(join(tmpdir(), 'cy-store-'));
  mkdirSync(join(store, 'sub'));
  writeFileSync(join(store, '007-x.md'), '');
  const c = {
    sessionId: 'S1',
    commitTasks: { 5: 2 },
    claims: [{ taskId: '6', project: 'proj' }, { taskId: '60', project: 'other-project' }],
    ranIn: { 'task-008-thing': 12, 'proj': 400 },
    worktrees: { 'task-099-named-only': 1 },           // named, never ran in
    filesWritten: [join(store, '007-x.md'), join(store, 'sub', '011-y.md'), '/elsewhere/_tasks/012-z.md'],
  };
  const st = statuses({ 5: open, 6: open, 8: open, 9: { ...open, createdBy: 'S1' }, 10: { ...open, createdBy: 'S2' } });
  const w = workedTasks(c, st, { slug: 'proj', storeDir: store });
  assert.deepEqual(w['5'], ['committed']);
  assert.deepEqual(w['6'], ['claimed']);
  assert.equal(w['60'], undefined, "another project's claim is not work here");
  assert.deepEqual(w['8'], ['worktree']);
  assert.equal(w['99'], undefined, 'naming a worktree is not running in it');
  assert.deepEqual(w['9'], ['created']);
  assert.equal(w['10'], undefined, 'created by another chat');
  assert.deepEqual(w['7'], ['edited']);
  assert.equal(w['11'], undefined, 'a file outside the store root is not a task file');
  assert.equal(w['12'], undefined, "another store's task file is not this project's task");
});

test('actionFor translates the verdict ladder without inventing safety', () => {
  assert.equal(actionFor('REMOVABLE'), 'remove');
  assert.equal(actionFor('PUSHED'), 'remove');   // unmerged, but origin holds this exact commit
  assert.equal(actionFor('LOCKED'), 'unlock');   // a dead session's lock: clearable
  for (const v of ['DIRTY', 'UNMERGED', 'LIVE', 'UNKNOWN', null]) {
    assert.equal(actionFor(v), null, `${v} must offer no action`);
  }
});

test('the driving chat outranks one that merely mentioned the task', () => {
  // taskIds arrives strongest-signal-first, so its index IS the signal: index 0
  // means this chat's own commits or claim named the task.
  const chats = [
    { sessionId: 'mention', taskIds: ['99', '54'], lastActivityAt: '2026-08-10' },
    { sessionId: 'driver', taskIds: ['54', '99'], lastActivityAt: '2026-08-01' },
  ];
  assert.equal(rankChatsForTask(chats, '54')[0].sessionId, 'driver');
});

test('equal signal breaks on recency, so the answer is stable', () => {
  const chats = [
    { sessionId: 'older', taskIds: ['54'], lastActivityAt: '2026-08-01' },
    { sessionId: 'newer', taskIds: ['54'], lastActivityAt: '2026-08-09' },
  ];
  assert.equal(rankChatsForTask(chats, '54')[0].sessionId, 'newer');
});

// --- the worktree ↔ chat join reads the transcript (2026-09-18) ----------------
// `worktrees` is the set of checkouts a chat's transcript ran in, each with a
// line count — read from the transcript file itself, not the swept ledger. It
// is the direct evidence of which chat drove a worktree, and the only evidence
// for a worktree not named task-NNN. The task-id ladder is the fallback.

test('a chat that ran inside the worktree drives it — over one that only names the task', () => {
  // "Pick up 99" launched in the main checkout, then entered task-099 and ran
  // 355 lines there. Another chat merely tagged a commit [#99]. The one that was
  // IN the worktree drove it.
  const chats = [
    { sessionId: 'tagged', taskIds: ['99'], worktrees: { 'where-is-maya': 40 }, lastActivityAt: '2026-09-17' },
    { sessionId: 'inside', taskIds: [], worktrees: { 'where-is-maya': 1473, 'task-099-nightly-database-backup': 355 }, lastActivityAt: '2026-09-16' },
  ];
  assert.equal(chatForWorktree(chats, 'task-099-nightly-database-backup', '99').sessionId, 'inside');
});

test('a worktree with no task in its name joins by visit alone', () => {
  // No task id to rank on — before this join existed such a row could only
  // ever say "no chat found".
  const chats = [
    { sessionId: 'other', taskIds: ['5'], worktrees: { 'where-is-maya': 10 }, lastActivityAt: '2026-09-17' },
    { sessionId: 'review', taskIds: [], worktrees: { 'owner-review-2026-09-06': 120 }, lastActivityAt: '2026-09-06' },
  ];
  assert.equal(chatForWorktree(chats, 'owner-review-2026-09-06', null).sessionId, 'review');
  assert.equal(chatForWorktree(chats, 'autopilot-integration', null), null);   // nobody ran there
});

test('no visit → the task-id ladder still decides, as before', () => {
  const chats = [
    { sessionId: 'mention', taskIds: ['99', '54'], worktrees: {}, lastActivityAt: '2026-08-10' },
    { sessionId: 'driver', taskIds: ['54', '99'], worktrees: {}, lastActivityAt: '2026-08-01' },
  ];
  assert.equal(chatForWorktree(chats, 'task-054-something', '54').sessionId, 'driver');
});

test('two chats ran in the same worktree — the one that ran there MORE drove it', () => {
  const chats = [
    { sessionId: 'glance', taskIds: [], worktrees: { 'task-012-x': 3 }, lastActivityAt: '2026-09-17' },
    { sessionId: 'worked', taskIds: [], worktrees: { 'task-012-x': 900 }, lastActivityAt: '2026-09-10' },
  ];
  assert.equal(chatForWorktree(chats, 'task-012-x', '12').sessionId, 'worked');
});

// --- PUSHED: clean, unmerged, on origin at this exact commit (task 174) -------
// Real git, throwaway repos: a bare repo plays "origin". The verdict reads the
// local remote-tracking ref (the report never fetches); removal must confirm
// against the remote itself with `git ls-remote` and refuse on any doubt.

// Hermetic git: no global/system config (hooks, templates, signing) and a fixed
// identity, for these children and for the git that core spawns in-process.
const GIT_CFG = join(COGYARD_TMP, 'gitconfig');
writeFileSync(GIT_CFG, '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: GIT_CFG, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const resolves = (cwd, ref) => {
  try { git(cwd, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; }
};

// A repo with main pushed to a bare origin. Realpath'd: macOS tmpdir is a
// symlink, and the ladder matches worktrees by path.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cy-pushed-')));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return { root, origin, repo };
}
// A clean worktree on a new branch carrying one commit main lacks.
function branchWorktree(fx, name) {
  const path = join(fx.root, name);
  git(fx.repo, 'worktree', 'add', '-q', '-b', name, path, 'main');
  writeFileSync(join(path, `${name}.txt`), 'work\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', `work on ${name}`);
  return path;
}
const verdictOf = async (fx, path) => (await worktreeCandidate(fx.repo, path)).verdict;
const rowFor = async (fx, path) => (await allWorktreeCandidates(fx.repo)).rows.find((r) => r.worktree.path === path);

test('clean + unmerged + pushed at the local head → PUSHED, in the batched report and the single check', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'feat');
  git(wt, 'push', '-q', 'origin', 'feat');

  const row = await rowFor(fx, wt);
  assert.equal(row.verdict, 'PUSHED');
  assert.equal(row.originRef, 'origin/feat');
  assert.match(row.detail, /not merged to main/);
  assert.ok(row.removeCmd && row.undoCmd, 'a PUSHED row carries the remove and undo commands');
  assert.equal(await verdictOf(fx, wt), 'PUSHED');   // per-branch fallback agrees
});

test('a merged worktree is still REMOVABLE, not PUSHED', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'done');
  git(wt, 'push', '-q', 'origin', 'done');
  git(fx.repo, 'merge', '-q', '--ff-only', 'done');
  assert.equal((await rowFor(fx, wt)).verdict, 'REMOVABLE');
});

test('never pushed → UNMERGED, "not on origin"', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'local-only');
  const row = await rowFor(fx, wt);
  assert.equal(row.verdict, 'UNMERGED');
  assert.match(row.detail, /not on origin/);
  assert.equal(row.removeCmd, null);
});

test('pushed, then one more local commit → UNMERGED, "origin is 1 behind", and removal refuses', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'ahead');
  git(wt, 'push', '-q', 'origin', 'ahead');
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'not pushed yet');

  const row = await rowFor(fx, wt);
  assert.equal(row.verdict, 'UNMERGED');
  assert.match(row.detail, /origin is 1 behind/);
  const res = await removeWorktree({ repoPath: fx.repo, worktreePath: wt, branch: 'ahead' });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'precheck');
  assert.ok(existsSync(wt), 'the worktree is untouched');
});

test('origin and local disagree in both directions → UNMERGED, "origin has diverged"', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'split');
  git(wt, 'push', '-q', 'origin', 'split');
  git(wt, 'commit', '-q', '--amend', '-m', 'rewritten locally');
  const row = await rowFor(fx, wt);
  assert.equal(row.verdict, 'UNMERGED');
  assert.match(row.detail, /origin has diverged/);
});

test('PUSHED removal: worktree gone, local branch and origin/<branch> both still resolve', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'shipit');
  git(wt, 'push', '-q', 'origin', 'shipit');
  const head = git(fx.repo, 'rev-parse', 'refs/heads/shipit');

  const res = await removeWorktree({ repoPath: fx.repo, worktreePath: wt, branch: 'shipit' });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.verdict, 'PUSHED');
  assert.equal(res.originRef, 'origin/shipit');
  assert.equal(existsSync(wt), false);
  assert.equal(git(fx.repo, 'rev-parse', 'refs/heads/shipit'), head, 'the local branch survives at the same commit');
  assert.ok(resolves(fx.repo, 'refs/remotes/origin/shipit'));
  assert.equal(git(fx.origin, 'rev-parse', 'refs/heads/shipit'), head, 'and so does the branch on origin');
});

test('remote branch deleted after the last fetch → still PUSHED in the report, but removal refuses via ls-remote', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'gone');
  git(wt, 'push', '-q', 'origin', 'gone');
  git(fx.origin, 'branch', '-q', '-D', 'gone');   // deleted on the remote; the local tracking ref is now stale

  assert.equal((await rowFor(fx, wt)).verdict, 'PUSHED', 'the report reads the local ref and never fetches');
  const res = await removeWorktree({ repoPath: fx.repo, worktreePath: wt, branch: 'gone' });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'precheck', 'a refusal — the portal route answers 409 for this stage');
  assert.match(res.error, /origin no longer has branch gone/);
  assert.ok(existsSync(wt));
  assert.ok(resolves(fx.repo, 'refs/heads/gone'));
});

test('remote branch moved to another commit after the last fetch → removal refuses', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'moved');
  git(wt, 'push', '-q', 'origin', 'moved');
  git(fx.origin, 'update-ref', 'refs/heads/moved', git(fx.origin, 'rev-parse', 'refs/heads/main'));

  const res = await removeWorktree({ repoPath: fx.repo, worktreePath: wt, branch: 'moved' });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'precheck');
  assert.match(res.error, /not the same commit/);
  assert.ok(existsSync(wt));
});

test('origin unreachable → removal refuses, nothing removed', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'offline');
  git(wt, 'push', '-q', 'origin', 'offline');
  git(fx.repo, 'remote', 'set-url', 'origin', join(fx.root, 'no-such-remote.git'));

  assert.equal((await rowFor(fx, wt)).verdict, 'PUSHED');
  const res = await removeWorktree({ repoPath: fx.repo, worktreePath: wt, branch: 'offline' });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'precheck');
  assert.match(res.error, /could not reach origin/);
  assert.ok(existsSync(wt));
});

test('a dirty worktree on a pushed branch stays DIRTY — PUSHED never loosens the earlier gates', async (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const wt = branchWorktree(fx, 'dirty');
  git(wt, 'push', '-q', 'origin', 'dirty');
  writeFileSync(join(wt, 'scratch.txt'), 'uncommitted\n');
  assert.equal((await rowFor(fx, wt)).verdict, 'DIRTY');
  const res = await removeWorktree({ repoPath: fx.repo, worktreePath: wt, branch: 'dirty' });
  assert.equal(res.ok, false);
  assert.ok(existsSync(wt));
});
