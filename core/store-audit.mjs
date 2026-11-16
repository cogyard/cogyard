// core/store-audit.mjs — what belongs in a task store, and what the portal's
// store view flags when a commit or the store's working tree breaks that
// (task 191).
//
// A task store (~/gitroot/_tasks/<slug>, branch `tasks`) is its own git repo,
// and agents commit into it constantly. Until this module nothing showed what
// they committed: nightly job output swept into "add task" commits, one task's
// edits credited to another, notes and prototypes dropped in beside the tasks.
//
// THE ONE DEFINITION of "task file / job output / allowed store file". The
// store view's flags read it, the Settings storage table reads it, and
// `sync push` (task 187) must import it rather than keep a list of its own —
// two lists is how "what sync push refuses" and "what the view flags" drift
// apart. Task 190 later widens `allowed` (attachments) here, in one place.
//
// Read-only. Nothing here writes to a store.

import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitP } from './exec.mjs';
import { parseTaskTags, gitDag, DAG_DATE } from './git-views.mjs';
import { normalizeTaskId } from './validate.mjs';
import { parseNameStatusLine, parsePorcelainZ } from './git-file-status.mjs';

// A task file sits at the store root: digits, an optional dotted sub-id
// (`013.5-…`, from before ids were standardized — task 190), an optional letter
// suffix (`028b-…` is a real split task), a dash, a name, `.md` — the same id
// grammar as core/validate.mjs. `044email-…md` is NOT a task file and is flagged.
const TASK_FILE = /^(\d+(?:\.\d+)?[a-z]?)-[^/]+\.md$/;
const JOB_DIRS = /^(briefs|heartbeats)\//;
const JOB_FILES = new Set(['drift.md']);
// switches.json: the project's switches (task 246, core/switches.mjs).
const ALLOWED = new Set(['axes.json', 'switches.json', '.gitkeep']);
// A file attached to a task (a mockup, a script, an audit): `files/<task id>/…`,
// any file type, any depth. The folder is the task's id as its filename spells
// it (`files/019/`, `files/044e/`, `files/013.5/`) — any spelling that
// normalizes to the same id is the same task's folder (owner, 2026-10-12, task 190).
const ATTACHMENT = /^files\/(\d+(?:\.\d+)?[a-z]?)\/.+/;
// INDEX.md was generated and committed by every `sync push` until task 190
// removed it. It keeps its own class so the hundreds of past commits that
// carried it are not flagged; a store that still HAS one gets a single
// store-level flag instead (storeFacts), until the file is deleted.
const RETIRED_INDEX = 'INDEX.md';

// → 'task' | 'attachment' | 'index' | 'job' | 'allowed' | 'other'
function classifyStorePath(path) {
  const p = String(path || '');
  if (TASK_FILE.test(p)) return 'task';
  if (ATTACHMENT.test(p)) return 'attachment';
  if (p === RETIRED_INDEX) return 'index';
  if (JOB_DIRS.test(p) || JOB_FILES.has(p)) return 'job';
  if (ALLOWED.has(p) || p.endsWith('/.gitkeep')) return 'allowed';
  return 'other';
}

// The task a path belongs to — a task file or one of its attachments —
// canonical so it compares with a `[#NN]` tag: `028b-x.md` → `28b`,
// `159-x.md` → `159`, `013.5-x.md` → `13.5`, `files/019/a.html` → `19`. null
// for any other path.
function taskIdOfPath(path) {
  const p = String(path || '');
  const m = p.match(TASK_FILE) || p.match(ATTACHMENT);
  return m ? normalizeTaskId(m[1]) : null;
}
const normTag = (id) => normalizeTaskId(id) ?? String(id);

const plural = (n, one, many) => (n === 1 ? one : many);

// A flag is { kind, tone, text }. `tone` is one of the portal's app-flag tones;
// `kind` is stable for code to key on, `text` is what the chip says.
//
// files: [{ status, path, oldPath? }] — the commit's file list as
// core/git-file-status.mjs reads it (a rename's `path` is its NEW path, so a
// file is judged by where it now is). Returns the flags plus each file's class
// and, for a task file belonging to a task the subject does not tag, that
// task's id.
function auditCommit(subject, files) {
  const tagged = new Set(parseTaskTags(subject).taskIds.map(normTag));
  const out = (files || []).map((f) => {
    const now = String(f.path || '');
    const cls = classifyStorePath(now);
    const id = cls === 'task' || cls === 'attachment' ? taskIdOfPath(now) : null;
    return { ...f, cls, foreignTask: tagged.size && id && !tagged.has(id) ? id : null };
  });
  const job = out.filter((f) => f.cls === 'job').length;
  const other = out.filter((f) => f.cls === 'other').length;
  const foreign = [...new Set(out.map((f) => f.foreignTask).filter(Boolean))];
  const flags = [];
  if (job) flags.push({ kind: 'job', tone: 'bad', text: `took ${job} job ${plural(job, 'file', 'files')}` });
  if (other) flags.push({ kind: 'other', tone: 'warn', text: `${other} non-task ${plural(other, 'file', 'files')}` });
  if (foreign.length) {
    flags.push({
      kind: 'otherTasks', tone: 'review',
      text: foreign.length <= 3 ? `also changed ${foreign.join(', ')}` : `changed ${foreign.length} other tasks`,
    });
  }
  return { flags, files: out };
}
const commitFlags = (subject, files) => auditCommit(subject, files).flags;

// --- the store's working tree ------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const OLD_PENDING_DAYS = 7;

// Raw porcelain: the leading status columns are significant, and a trimming
// helper would eat the first entry's. -uall lists files inside new folders one
// by one, so a new briefs/ folder is counted as its files, not as one entry.
function pendingEntries(storeDir) {
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: storeDir, maxBuffer: 1 << 24 }).toString(); } catch { return []; }
  return parsePorcelainZ(out).map(({ x, y, path, untracked }) => {
    let mtimeMs = null;
    try { mtimeMs = statSync(join(storeDir, path)).mtimeMs; } catch { /* deleted */ }
    return { path, status: untracked ? '?' : (x !== ' ' ? x : y), cls: classifyStorePath(path), mtimeMs };
  });
}

// entries: pendingEntries() output. now: injectable for tests.
function pendingFlags(entries, now = Date.now()) {
  const byClass = { task: 0, attachment: 0, index: 0, job: 0, allowed: 0, other: 0 };
  for (const e of entries) byClass[e.cls] = (byClass[e.cls] || 0) + 1;
  const times = entries.map((e) => e.mtimeMs).filter((t) => t != null);
  const oldestMs = times.length ? Math.min(...times) : null;
  const oldestDays = oldestMs == null ? null : Math.floor((now - oldestMs) / DAY_MS);
  const flags = [];
  if (byClass.job) flags.push({ kind: 'job', tone: 'warn', text: 'job output' });
  if (byClass.other) flags.push({ kind: 'other', tone: 'bad', text: 'not a task file' });
  if (oldestDays != null && oldestDays > OLD_PENDING_DAYS) flags.push({ kind: 'old', tone: 'bad', text: `${oldestDays} days` });
  return { count: entries.length, byClass, oldestMs, oldestDays, flags };
}

// --- facts about the store itself ---------------------------------------------

function gitSync(args, cwd) {
  try { return execFileSync('git', args, { cwd, maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

// A store still holding the retired INDEX.md — on disk or tracked (a deleted
// but uncommitted one is still in the store's history tip).
const LEFTOVER_INDEX = `leftover ${RETIRED_INDEX}`;
function hasLeftoverIndex(storeDir) {
  return existsSync(join(storeDir, RETIRED_INDEX)) || !!gitSync(['ls-files', '--', RETIRED_INDEX], storeDir);
}

// Branch, remote, unpushed, last commit, and the uncommitted files — what the
// store view's toolbar and pending row show.
function storeFacts(storeDir) {
  const branch = gitSync(['symbolic-ref', '--short', '-q', 'HEAD'], storeDir);
  const remote = (gitSync(['remote'], storeDir) || '').split('\n').includes('origin');
  const ahead = remote ? gitSync(['rev-list', '--count', '@{u}..HEAD'], storeDir) : null;
  const unpushed = ahead == null ? null : Number(ahead);
  const last = gitSync(['log', '-1', '--format=%h%x1f%cr'], storeDir);
  const [short, relDate] = last ? last.split('\x1f') : [];
  const entries = pendingEntries(storeDir);
  const pending = pendingFlags(entries);
  const flags = [];
  if (branch !== 'tasks') flags.push({ kind: 'branch', tone: 'bad', text: branch ? `not on tasks (${branch})` : 'not on tasks (detached)' });
  if (unpushed) flags.push({ kind: 'unpushed', tone: 'warn', text: `${unpushed} unpushed` });
  if (hasLeftoverIndex(storeDir)) flags.push({ kind: 'leftoverIndex', tone: 'warn', text: LEFTOVER_INDEX });
  return {
    path: storeDir, branch: branch || null, remote, unpushed,
    lastCommit: short ? { short, relDate: relDate || null } : null,
    pending: { ...pending, files: entries.map(({ path, status, cls }) => ({ path, status, cls })) },
    flags,
  };
}

// --- history -------------------------------------------------------------------

// `git log --name-status` with a \x1e-led header per commit. Header fields are
// \x1f-separated (the subject cannot contain either). Each file line is read by
// core/git-file-status.mjs: one-letter status, NEW path, oldPath for a rename.
function parseNameStatusLog(raw, fields) {
  const commits = [];
  for (const rec of String(raw || '').split('\x1e')) {
    if (!rec.trim()) continue;
    const [head, ...lines] = rec.split('\n');
    const vals = head.split('\x1f');
    const c = {};
    fields.forEach((f, i) => { c[f] = vals[i] ?? ''; });
    c.files = lines.map(parseNameStatusLine).filter(Boolean);
    commits.push(c);
  }
  return commits;
}

const ALL_REFS = ['--branches', '--tags', '--remotes'];

// The store's commit graph for the Graph tab: the same lane DAG the code graph
// uses (same refs, same window, same order), with each row's flags, and one
// `kind: 'pending'` row above the HEAD commit when anything is uncommitted.
async function storeGraph(storeDir, { limit = 250, facts = null } = {}) {
  const [dag, raw] = await Promise.all([
    gitDag({ path: storeDir }, limit),
    gitP(['log', ...ALL_REFS, '--topo-order', '-n', String(limit), '--name-status', '--format=%x1e%H'], storeDir),
  ]);
  const filesBy = new Map(parseNameStatusLog(raw, ['hash']).map((c) => [c.hash, c.files]));
  const rows = dag.rows.map((r) => ({ ...r, flags: commitFlags(r.subject, filesBy.get(r.hash) || []) }));
  return { rows: splicePending(rows, facts || storeFacts(storeDir), await gitP(['rev-parse', 'HEAD'], storeDir)), laneCount: dag.laneCount };
}

// The uncommitted row sits directly above the HEAD commit, in its lane, with
// a dashed connector into its dot — the same placement the code graph gives a
// dirty checkout. A tip commit has no top half-line, so it gets one.
function splicePending(rows, facts, headSha) {
  if (!facts.pending.count) return rows;
  let i = rows.findIndex((r) => r.hash === headSha);
  if (i === -1) i = 0;
  const anchor = rows[i];
  const col = anchor ? anchor.col : 0;
  const pass = anchor ? anchor.segs.filter((s) => s.half === 'full' || s.half === 'top')
    .map((s) => ({ from: s.from, to: s.from, half: 'full', color: s.color, main: s.main })) : [];
  const pending = {
    kind: 'pending', hash: 'wt:store', col, onMain: false,
    segs: anchor ? [...pass, { from: col, to: col, half: 'bottom', color: col, main: false, wt: true }] : [],
    count: facts.pending.count, files: facts.pending.files.map((f) => f.path), flags: facts.pending.flags,
  };
  const out = rows.slice();
  if (anchor && !anchor.segs.some((s) => s.half === 'top' && s.to === col)) {
    out[i] = { ...anchor, segs: [...anchor.segs, { from: col, to: col, half: 'top', color: col, main: false, wt: true }] };
  }
  out.splice(i, 0, pending);
  return out;
}

// Flagged commits only, over the last `days` days — NOT the newest-250 window,
// so a mistake from three weeks ago in a busy store is still reachable. Each
// row says how many clean commits were hidden above it; `hiddenAfter` counts
// the clean ones below the last. Rows sit in one straight lane: with the clean
// commits removed the real topology means nothing.
const FLAG_FIELDS = ['hash', 'shortHash', 'parentStr', 'refStr', 'subject', 'author', 'date'];
async function storeFlagged(storeDir, { days = 30, facts = null } = {}) {
  const raw = await gitP(['log', ...ALL_REFS, '--topo-order', `--since=${days} days ago`, DAG_DATE, '--name-status',
    '--format=%x1e' + ['%H', '%h', '%P', '%D', '%s', '%an', '%ad'].join('%x1f')], storeDir);
  const commits = parseNameStatusLog(raw, FLAG_FIELDS);
  const rows = [];
  let hidden = 0;
  for (const c of commits) {
    const flags = commitFlags(c.subject, c.files);
    if (!flags.length) { hidden++; continue; }
    const { taskIds, cleanSubject } = parseTaskTags(c.subject);
    const refs = (c.refStr || '').split(', ').map((r) => r.trim()).filter(Boolean)
      .map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD');
    rows.push({
      hash: c.hash, shortHash: c.shortHash, parents: c.parentStr ? c.parentStr.split(' ') : [], refs,
      subject: c.subject, cleanSubject, taskIds, author: c.author, date: c.date,
      col: 0, onMain: false, flags, hiddenBefore: hidden,
    });
    hidden = 0;
  }
  // One straight lane: a line through every dot, open at the ends.
  rows.forEach((r, i) => {
    r.segs = [];
    if (i > 0) r.segs.push({ from: 0, to: 0, half: 'top', color: 0, main: false });
    if (i < rows.length - 1) r.segs.push({ from: 0, to: 0, half: 'bottom', color: 0, main: false });
  });
  const f = facts || storeFacts(storeDir);
  const out = f.pending.count ? splicePending(rows, f, rows[0]?.hash) : rows;
  return { rows: out, laneCount: 1, scanned: commits.length, flaggedCount: rows.length, hiddenAfter: hidden, days };
}

// Counts for a window — the Settings storage table's "this week" column. Sync:
// storeHealth() is sync, and this is one git call per store.
function storeWindow(storeDir, days = 7) {
  const raw = gitSync(['log', ...ALL_REFS, `--since=${days} days ago`, '--name-status', '--format=%x1e%H%x1f%s'], storeDir);
  const commits = parseNameStatusLog(raw, ['hash', 'subject']);
  const counts = { commits: commits.length, flagged: 0, job: 0, other: 0, otherTasks: 0 };
  for (const c of commits) {
    const flags = commitFlags(c.subject, c.files);
    if (flags.length) counts.flagged++;
    for (const f of flags) counts[f.kind]++;
  }
  return { days, ...counts };
}

export {
  classifyStorePath, taskIdOfPath, auditCommit, commitFlags,
  pendingEntries, pendingFlags, storeFacts, storeGraph, storeFlagged, storeWindow,
  parseNameStatusLog, OLD_PENDING_DAYS, LEFTOVER_INDEX,
};
