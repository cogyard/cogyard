// core/usage.mjs — token/cost usage ledger.
//
// Harvests the active agent's session transcripts into a durable append-only
// ledger under $COGYARD_HOME/usage/. WHERE transcripts live and HOW a line parses
// into token rows is the active driver's job (the `transcripts`
// adapter seam; see core/drivers.mjs + docs/DRIVERS.md). This module
// owns the agent-agnostic half: cursors, aggregation, the claim↔session join, and
// the ledger. With the no-op adapter (no agent) harvesting is a no-op and the
// usage tab degrades gracefully. Cost is locked in at collection time via
// core/pricing.mjs. Transcripts get pruned by agent retention; the ledger is forever.
//
// Files:
//   usage.jsonl   — one row per (sessionId, model, taskId) aggregate per collection.
//                   A scheduled job's call carries `job: <id>` and a null
//                   `project` (jobForPath; task 130) — in activity.jsonl too.
//   claims.jsonl  — claim/release events appended by cli/env.mjs (task↔session join)
//   cursors.json  — per-transcript byte offset + recent dedupe keys (idempotency)
//   activity.jsonl        — attention/labor rows: per collection, per
//                           session — exact HUMAN prompt timestamps + per-UTC-hour
//                           assistant message counts. Derived counts, never priced.
//   cursors-activity.json — activity's OWN cursor namespace, deliberately separate
//                           from cursors.json: its first run walks every on-disk
//                           transcript from byte 0, retro-filling hour-level data
//                           for history the usage cursors already consumed (the
//                           "rebucket"; pruned transcripts stay
//                           approximated from usage rows' firstTs/lastTs).

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  statSync, renameSync, realpathSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { COGYARD_HOME, JOB_RUN_ROOT } from './paths.mjs';
import { readRegistry, ledgerSlugResolver } from './registry.mjs';
import { priceFor, syncPricing } from './pricing.mjs';
import { adapter } from './drivers.mjs';

const USAGE_DIR = join(COGYARD_HOME, 'usage');
const LEDGER_PATH = join(USAGE_DIR, 'usage.jsonl');
const CLAIMS_PATH = join(USAGE_DIR, 'claims.jsonl');
const CURSORS_PATH = join(USAGE_DIR, 'cursors.json');
const ACTIVITY_PATH = join(USAGE_DIR, 'activity.jsonl');
const ACTIVITY_CURSORS_PATH = join(USAGE_DIR, 'cursors-activity.json');

// Transcript location + per-session lookup come from the active driver.
function transcriptsRoot() { return adapter.transcripts.root(); }
function findTranscriptsForSession(sessionId) { return adapter.transcripts.findBySession(sessionId); }

function ensureUsageDir() { mkdirSync(USAGE_DIR, { recursive: true }); }

// A ledger read for QUERIES: each row's `project` mapped to the project that
// owns that slug now (registry aliases — see ledgerSlugResolver). The files are
// never rewritten with it; anything that writes a ledger back reads it raw.
function readResolved(path) {
  const resolve = ledgerSlugResolver();
  return readJsonl(path).map((r) => (r.project == null ? r : { ...r, project: resolve(r.project) }));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

// --- claims ledger ----------------------------------------------------------

// event: {event: 'claim'|'release', project, taskId, sessionId, ts}
// Append-only; failures must never break the claim itself (caller catches).
function appendClaimEvent(event) {
  ensureUsageDir();
  appendFileSync(CLAIMS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

// → Map sessionId → [{taskId, project, start, end|null}], windows sorted by start.
function claimWindows() {
  const bySession = new Map();
  for (const ev of readResolved(CLAIMS_PATH)) {
    if (!ev.sessionId) continue;
    if (!bySession.has(ev.sessionId)) bySession.set(ev.sessionId, []);
    const windows = bySession.get(ev.sessionId);
    if (ev.event === 'claim') {
      windows.push({ taskId: ev.taskId, project: ev.project, start: ev.ts, end: null });
    } else if (ev.event === 'release') {
      // Close the most recent open window for this task (or any open one).
      const open = [...windows].reverse().find((w) => !w.end && (w.taskId === ev.taskId || !ev.taskId));
      if (open) open.end = ev.ts;
    }
  }
  return bySession;
}

function taskForTimestamp(windows, ts) {
  if (!windows || !ts) return null;
  for (const w of windows) {
    if (ts >= w.start && (!w.end || ts <= w.end)) return w.taskId;
  }
  return null;
}

// --- project resolution -----------------------------------------------------

// A transcript's cwd → the scheduled job that made the call, or null. Each job's
// agent call runs in its own folder, `$COGYARD_HOME/run/<job-id>` (core/addons/
// jobs.mjs), so a transcript recorded there is that job's and nobody else's.
// Checked BEFORE any project rule: a job that scans every project belongs to
// none of them, and the folder's own basename would otherwise become a junk
// project slug (task 130 — the `T` slug was exactly that, from tmpdir()).
// Both spellings of the root are tried, because the agent records its cwd
// with symlinks resolved and $COGYARD_HOME may sit under one.
function jobForPath(p) {
  if (!p) return null;
  const roots = [JOB_RUN_ROOT];
  try { const real = realpathSync(JOB_RUN_ROOT); if (real !== JOB_RUN_ROOT) roots.push(real); } catch { /* no job has run yet */ }
  for (const root of roots) {
    if (p.startsWith(root + '/')) return p.slice(root.length + 1).split('/')[0] || null;
  }
  return null;
}

// Where a transcript's rows are filed: `{ job }` for a scheduled job's call,
// else `{ project, worktree }` from the path rules below. A job row carries no
// project at all, so nothing keyed by project can ever absorb it.
function fileForPath(p) {
  const job = jobForPath(p);
  if (job) return { project: null, worktree: null, job };
  return { project: resolveProjectForPath(p), worktree: worktreeForPath(p) };
}

// A transcript's cwd → registry project slug. Agent worktrees resolve to the
// parent repo (the active adapter knows that layout). Unregistered paths get a
// best-effort slug from the basename.
function resolveProjectForPath(p) {
  if (!p) return null;
  const wt = adapter.worktree.detect(p);
  let root = wt ? wt.parentRepo : p;
  let best = null;
  for (const entry of readRegistry()) {
    for (const base of [entry.path, ...(entry.aliases || [])]) {
      if (root === base || root.startsWith(base + '/')) {
        if (!best || base.length > best.len) best = { slug: entry.slug, len: base.length };
      }
    }
  }
  return best ? best.slug : basename(root);
}

// A transcript's cwd → the worktree it ran in, named to match the Worktrees
// tab (basename of the checkout dir). Agent worktrees → the adapter's `<name>`;
// the main checkout → the repo dir basename.
function worktreeForPath(p) {
  if (!p) return null;
  const wt = adapter.worktree.detect(p);
  if (wt) return wt.name;
  for (const entry of readRegistry()) {
    if (p === entry.path || p.startsWith(entry.path + '/')) return basename(entry.path);
  }
  return basename(p);
}

// --- collection -------------------------------------------------------------

function addTokens(a, b) {
  for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k];
}

// Collect new transcript content into the ledger. Idempotent: cursors.json
// remembers how far into each file we've read; running twice appends nothing.
// opts: {files?: [abs paths], backfilled?: bool}
// → {rows: <appended count>, files: <files with new content>, skippedModels: [...]}
function collectUsage(opts = {}) {
  ensureUsageDir();
  // No agent transcripts (no-op adapter) → nothing to harvest. The ledger keeps
  // whatever's already there; the usage tab degrades gracefully.
  if (!adapter.transcripts.supported) return { rows: 0, files: 0, skippedModels: [] };
  const files = opts.files && opts.files.length ? opts.files : adapter.transcripts.list();
  let cursors = {};
  if (existsSync(CURSORS_PATH)) {
    try { cursors = JSON.parse(readFileSync(CURSORS_PATH, 'utf8')); } catch { cursors = {}; }
  }
  const windows = claimWindows();
  const capturedAt = new Date().toISOString();
  const newRows = [];
  const skippedModels = new Set();
  let touchedFiles = 0;

  for (const file of files) {
    let size;
    try { size = statSync(file).size; } catch { continue; }
    const cur = cursors[file] || { offset: 0, recent: [] };
    if (size <= cur.offset) continue;

    const buf = readFileSync(file);
    let chunk = buf.subarray(cur.offset);
    // Don't consume a torn final line (live session mid-write).
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) continue;
    chunk = chunk.subarray(0, lastNl + 1);
    const newOffset = cur.offset + lastNl + 1;

    const seen = new Set(cur.recent || []);
    const aggregates = new Map(); // key model|taskId
    let cwd = null;
    let sessionId = null;

    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      // The active driver owns the transcript format: a line → {sessionId,
      // cwd, usage}, where usage (or null) is the billable turn.
      const parsed = adapter.transcripts.parseLine(line);
      if (!parsed) continue;
      if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
      if (!cwd && parsed.cwd) cwd = parsed.cwd;
      const u = parsed.usage;
      if (!u) continue;
      if (seen.has(u.dedupeKey)) continue; // streaming repeats the same message id
      seen.add(u.dedupeKey);

      const sid = parsed.sessionId || sessionId;
      const taskId = taskForTimestamp(windows.get(sid), u.timestamp);
      const aggKey = `${u.model}|${taskId ?? ''}`;
      if (!aggregates.has(aggKey)) {
        aggregates.set(aggKey, {
          model: u.model, taskId,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
          firstTs: u.timestamp, lastTs: u.timestamp, messages: 0,
        });
      }
      const agg = aggregates.get(aggKey);
      addTokens(agg.tokens, u.tokens);
      agg.messages += 1;
      if (u.timestamp) {
        if (!agg.firstTs || u.timestamp < agg.firstTs) agg.firstTs = u.timestamp;
        if (!agg.lastTs || u.timestamp > agg.lastTs) agg.lastTs = u.timestamp;
      }
    }

    if (aggregates.size) {
      const { project, worktree, job } = fileForPath(cwd);
      for (const agg of aggregates.values()) {
        const { costUSD, pricingVersion } = priceFor(agg.model, agg.tokens);
        if (costUSD === null) skippedModels.add(agg.model);
        newRows.push({
          capturedAt,
          sessionId: sessionId || basename(file, '.jsonl'),
          project,
          worktree,
          ...(job ? { job } : {}),
          taskId: agg.taskId,
          model: agg.model,
          tokens: agg.tokens,
          costUSD,
          pricingVersion,
          backfilled: !!opts.backfilled,
          firstTs: agg.firstTs,
          lastTs: agg.lastTs,
          messages: agg.messages,
        });
      }
      touchedFiles += 1;
    }
    cursors[file] = { offset: newOffset, recent: [...seen].slice(-100) };
  }

  if (newRows.length) {
    appendFileSync(LEDGER_PATH, newRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  writeFileSync(CURSORS_PATH, JSON.stringify(cursors, null, 1) + '\n');
  const activity = collectActivity(opts);
  return { rows: newRows.length, files: touchedFiles, skippedModels: [...skippedModels], activity };
}

// --- repricing --------------------------------------------------------------

// Fill in cost for ledger rows that were collected while their model was missing
// from the price table (costUSD: null — a model released after the table was
// last updated). Priced rows are NEVER touched: cost stays locked in at the
// version it was collected with. The tokens on an unpriced row are exact, so
// the fill-in is exact arithmetic, not an estimate — but it uses the price
// version in effect NOW rather than when the work ran, so repriced rows are
// flagged `backfilled` like any other after-the-fact pricing.
// Rewrites the ledger atomically (tmp + rename). Runs across every project.
// → {scanned, repriced, byModel: {<model>: n}, stillUnpriced: {<model>: n}}
function repriceLedger(opts = {}) {
  const rows = readJsonl(LEDGER_PATH); // raw: this rewrites the file
  const byModel = {};
  const stillUnpriced = {};
  let repriced = 0;

  for (const row of rows) {
    if (row.costUSD !== null && row.costUSD !== undefined) continue;
    const { costUSD, pricingVersion } = priceFor(row.model, row.tokens || {});
    if (costUSD === null) {
      stillUnpriced[row.model] = (stillUnpriced[row.model] || 0) + 1;
      continue;
    }
    row.costUSD = costUSD;
    row.pricingVersion = pricingVersion;
    row.backfilled = true;
    byModel[row.model] = (byModel[row.model] || 0) + 1;
    repriced += 1;
  }

  const result = { scanned: rows.length, repriced, byModel, stillUnpriced };
  if (opts.dryRun || !repriced) return result;

  const tmp = LEDGER_PATH + '.reprice.tmp';
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  renameSync(tmp, LEDGER_PATH);
  return result;
}

// Refresh the price table from upstream, then heal what it unblocks: rows a
// missing model left unpriced get their cost filled in. This pairing is the
// whole point of the sync — a new model that ships mid-week no longer needs a
// human to notice the $0 and hand-edit a table.
//
// Lives here rather than in core/pricing.mjs because pricing.mjs cannot import
// usage.mjs (usage already imports pricing — that's the cycle). Never throws:
// the portal calls it on a timer.
// → {sync: <syncPricing result>, reprice: <repriceLedger result | null>}
async function refreshPricing() {
  let sync;
  try { sync = await syncPricing(); }
  catch (err) { return { sync: { ok: false, changed: false, reason: err.message }, reprice: null }; }
  if (!sync.changed) return { sync, reprice: null };
  let reprice = null;
  try { reprice = repriceLedger(); }
  catch (err) { reprice = { error: err.message }; }
  return { sync, reprice };
}

// --- activity collection ------------------------------------------

// UTC hour bucket key for an ISO timestamp: "2026-07-02T14".
function hourKey(ts) { return String(ts).slice(0, 13); }

// Task-file references in raw transcript text: `.cogyard/tasks/NNN-…` (or the
// older `_tasks/NNN-…`, task 160) is the
// cogyard task-file naming convention, so counting matches per task id tells us
// which task a session was actually working — far better coverage than the
// claims join (most sessions never formally claim). Format-agnostic: it greps
// the raw line, not an agent-specific field.
const TASK_REF_RE = /(?:_tasks|\.cogyard\/tasks)\/0*(\d+)-/g;
// Stronger still: `[#NN]` tags in the session's OWN `git commit` invocations
// (the /commit skill stamps them). Read ONLY from the shell commands the chat
// actually ran (the driver's `parsed.commands`), and only from the part after
// `git commit`. It used to be any transcript LINE containing both strings —
// and a loaded skill, a task file or a pasted note is one line: the /commit
// skill's own `[#37]` example credited every chat that loaded it with #37 and
// #40 (task 152).
const COMMIT_TAG_RE = /\[#0*(\d+)\]/g;
// `git commit` at a COMMAND position — start of the command, or after a shell
// separator — so a script or note that merely quotes "`git commit`" is not a
// commit. The message is the rest of that line, plus a heredoc body when the
// line opens one (the /commit skill's own `-m "$(cat <<'EOF' … EOF)"` shape).
const GIT_COMMIT_RE = /(?:^|[;&|(\n])\s*git(?:\s+-C\s+\S+)*\s+commit\b/;
function commitMessageText(cmd) {
  const m = cmd.match(GIT_COMMIT_RE);
  if (!m) return null;
  const rest = cmd.slice(m.index + m[0].length);
  const nl = rest.indexOf('\n');
  const first = nl === -1 ? rest : rest.slice(0, nl);
  const doc = first.match(/<<-?\s*['"]?(\w+)['"]?/);
  if (!doc || nl === -1) return first;
  const end = rest.indexOf('\n' + doc[1], nl);
  return first + rest.slice(nl, end === -1 ? undefined : end);
}

// One transcript line's task signals, folded into the two counters. The line-
// level rule in one place so the swept ledger (collectActivity) and the live
// reader (chatSignals) can never disagree about what counts as a reference.
// `parsed` is the driver's parseLine result for the same line (null allowed).
function harvestTaskRefs(line, parsed, tasks, commitTasks) {
  for (const m of line.matchAll(TASK_REF_RE)) tasks[m[1]] = (tasks[m[1]] || 0) + 1;
  for (const cmd of (parsed && parsed.commands) || []) {
    const msg = commitMessageText(cmd);
    if (msg == null) continue;
    for (const m of msg.matchAll(COMMIT_TAG_RE)) commitTasks[m[1]] = (commitTasks[m[1]] || 0) + 1;
  }
}

// --- live chat signals — read the SOURCE, not the ledger ---------------------
// "Which task / which worktree did this chat work on?" has one source of truth:
// the transcript. The activity ledger below is a swept CACHE of those same
// files — written at server boot, at session end, and on the Stats tab's
// Refresh — and any chat still open, or ended since the last sweep, is simply
// not in it. The Cleanup tab's worktree↔chat join used to read the cache and
// said "no chat found" for chats sitting right there in the sidebar (owner,
// 2026-09-16; the ledger was a day stale on a server two days up).
//
// So this reads the files. Memoized per file on (size, mtime): a transcript is
// parsed once and re-read only when it has grown — every read cheap, work done
// only when the state actually moved. In-process, so the long-running portal
// pays once; a CLI run pays once per invocation.
//
// It also keeps which worktrees the chat OPERATED ON, two ways, both counted:
//   · every cwd the transcript passed through — not just the first one the
//     ledger records. A chat launched in the main checkout that then entered
//     a task worktree has hundreds of lines in that worktree.
//   · every worktree the chat's OWN tool calls name (the driver reports these
//     per line as `worktreesTouched`). An orchestrator that creates worktrees
//     with `git worktree add` and drives them with `git -C …` never changes
//     directory into them, so it leaves no cwd trace at all — this is the
//     only evidence such a chat leaves, and it is direct: those are its
//     commands.
// Together this is the most direct evidence there is of which worktree a chat
// drove, and the ONLY evidence for worktrees not named task-NNN.
const signalCache = new Map(); // file → { size, mtimeMs, signals }
function fileSignals(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const hit = signalCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.signals;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const tasks = {}, commitTasks = {}, cwds = {}, touched = {}, written = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parsed = adapter.transcripts.parseLine(line);
    harvestTaskRefs(line, parsed, tasks, commitTasks);
    if (!parsed) continue;
    if (parsed.cwd) cwds[parsed.cwd] = (cwds[parsed.cwd] || 0) + 1;
    for (const w of parsed.worktreesTouched || []) touched[w] = (touched[w] || 0) + 1;
    for (const f of parsed.filesWritten || []) written[f] = (written[f] || 0) + 1;
  }
  const signals = { tasks, commitTasks, cwds, touched, written };
  signalCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, signals });
  return signals;
}

// A chat's signals across all of its transcript files, plus the worktrees it
// operated on — names matched to the Worktrees tab (worktreeForPath for a cwd;
// the driver already reports a touched worktree by name), each carrying how
// many lines ran there or named it. The launch dir usually dominates by count,
// so a consumer wants the whole ranked set, not a single "the" worktree.
function chatSignals(sessionId) {
  const tasks = {}, commitTasks = {}, cwds = {}, worktrees = {}, filesWritten = {};
  // The chat's own log(s) plus its helper agents' (task 152): a helper's
  // commits, worktrees and task-file edits are this chat's work. Stats
  // collection already reads them (list() walks every file).
  const helpers = adapter.transcripts.findHelpersBySession ? adapter.transcripts.findHelpersBySession(sessionId) : [];
  for (const f of [...findTranscriptsForSession(sessionId), ...helpers]) {
    const s = fileSignals(f);
    if (!s) continue;
    for (const [k, n] of Object.entries(s.written)) filesWritten[k] = (filesWritten[k] || 0) + n;
    for (const [k, n] of Object.entries(s.tasks)) tasks[k] = (tasks[k] || 0) + n;
    for (const [k, n] of Object.entries(s.commitTasks)) commitTasks[k] = (commitTasks[k] || 0) + n;
    for (const [k, n] of Object.entries(s.cwds)) cwds[k] = (cwds[k] || 0) + n;
    for (const [k, n] of Object.entries(s.touched)) worktrees[k] = (worktrees[k] || 0) + n;
  }
  // ranIn: only the worktrees the chat's own lines RAN in (its cwd), not ones
  // it merely named in a command. Task 152's readiness reads this: a chat that
  // ran in a worktree is held while that worktree is on disk (archiving a
  // Desktop-managed one force-removes it), and running in `task-NNN-*` counts
  // as working on NNN. Naming a worktree in `ls` or `git worktree list` is
  // neither.
  const ranIn = {};
  for (const [p, n] of Object.entries(cwds)) {
    const w = worktreeForPath(p);
    if (w) {
      worktrees[w] = (worktrees[w] || 0) + n;
      ranIn[w] = (ranIn[w] || 0) + n;
    }
  }
  return { tasks, commitTasks, cwds, worktrees, ranIn, filesWritten };
}

// Harvest attention/labor time data into activity.jsonl: exact human-prompt
// timestamps (the attention signal) + per-hour assistant message counts (labor,
// and the weights that let queries spread a usage row's locked-in cost across
// hours/days). Same incremental walk as collectUsage but on its OWN cursor file —
// see the header comment for why. Idempotent the same way.
function collectActivity(opts = {}) {
  ensureUsageDir();
  if (!adapter.transcripts.supported) return { rows: 0, files: 0 };
  const files = opts.files && opts.files.length ? opts.files : adapter.transcripts.list();
  let cursors = {};
  if (existsSync(ACTIVITY_CURSORS_PATH)) {
    try { cursors = JSON.parse(readFileSync(ACTIVITY_CURSORS_PATH, 'utf8')); } catch { cursors = {}; }
  }
  const capturedAt = new Date().toISOString();
  const newRows = [];
  let touchedFiles = 0;

  for (const file of files) {
    let size;
    try { size = statSync(file).size; } catch { continue; }
    const cur = cursors[file] || { offset: 0, recent: [] };
    if (size <= cur.offset) continue;

    const buf = readFileSync(file);
    let chunk = buf.subarray(cur.offset);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) continue;
    chunk = chunk.subarray(0, lastNl + 1);
    const newOffset = cur.offset + lastNl + 1;

    const seen = new Set(cur.recent || []);
    const prompts = [];
    const hours = {};
    const tasks = {};
    const commitTasks = {};
    let cwd = null;
    let sessionId = null;
    let sawHours = false;

    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const parsed = adapter.transcripts.parseLine(line);
      harvestTaskRefs(line, parsed, tasks, commitTasks);
      if (!parsed) continue;
      if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
      if (!cwd && parsed.cwd) cwd = parsed.cwd;
      if (parsed.prompt && !seen.has(parsed.prompt.dedupeKey)) {
        seen.add(parsed.prompt.dedupeKey);
        prompts.push(parsed.prompt.timestamp);
      }
      const u = parsed.usage;
      if (u && u.timestamp && !seen.has('h:' + u.dedupeKey)) {
        seen.add('h:' + u.dedupeKey);
        const k = hourKey(u.timestamp);
        hours[k] = (hours[k] || 0) + 1;
        sawHours = true;
      }
    }

    if (prompts.length || sawHours) {
      const { project, worktree, job } = fileForPath(cwd);
      newRows.push({
        capturedAt,
        sessionId: sessionId || basename(file, '.jsonl'),
        project,
        worktree,
        ...(job ? { job } : {}),
        prompts,
        hours,
        ...(Object.keys(tasks).length ? { tasks } : {}),
        ...(Object.keys(commitTasks).length ? { commitTasks } : {}),
        backfilled: !!opts.backfilled,
      });
      touchedFiles += 1;
    }
    cursors[file] = { offset: newOffset, recent: [...seen].slice(-200) };
  }

  if (newRows.length) {
    appendFileSync(ACTIVITY_PATH, newRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  writeFileSync(ACTIVITY_CURSORS_PATH, JSON.stringify(cursors, null, 1) + '\n');
  return { rows: newRows.length, files: touchedFiles };
}

function readActivityLedger() { return readResolved(ACTIVITY_PATH); }

// --- task attribution fallback (task 103) ------------------------------------

// Dominant task id in a {id: count} map: the top-count id. `floor` is the minimum
// count the top id must clear (1 for commit tags — an own `[#NN]` commit is a
// definitive signal; 2 for text refs — one passing `<task dir>/NNN-` mention must not
// tag). Ties resolve to the numerically lower id for determinism.
function dominantTaskId(counts, floor) {
  const entries = Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  if (!entries.length) return null;
  const [id, n] = entries[0];
  return n >= floor ? id : null;
}

// Fallback task attribution for usage rows carrying no claim-based taskId.
//
// The claim window (taskForTimestamp, applied at collection time → row.taskId) is
// the precise, per-turn signal and stays AUTHORITATIVE. But most sessions never
// run `cogyard env claim`, so their cost lands with taskId:null. This recovers it
// from the SAME banked signals the Stats calendar's #NN chips use
// (core/activity.mjs sessionTaskIds), MINUS the ephemeral worktree-name rung
// (task 103): a session's own `[#NN]` commit tags (commitTasks), else its dominant
// `<task dir>/NNN-` references (tasks). Both are mined into activity.jsonl at
// collection time and BANKED — so attribution survives transcript culling
// (activity.jsonl is ledger data, not a transcript). Git is deliberately NOT a
// source here: git can't tie a commit to a session, so a git/time-window join was
// measured at only ~52% accuracy vs this banked signal (task 103 Phase 2).
//
// Session-level: exactly one id per session (claims already handle anything finer;
// a session touching several tasks without claiming attributes to its top signal).
// Ids are NUMBERS, matching the taskId type everywhere else (claims.jsonl,
// usage.jsonl rows, task frontmatter `id`, the SPA's `t.id`) — the mined signal
// keys are digit strings only because JSON object keys are strings.
// → Map sessionId → taskId number
function sessionTaskFallback() {
  const bySession = new Map();
  for (const row of readActivityLedger()) {
    if (!row.sessionId) continue;
    let s = bySession.get(row.sessionId);
    if (!s) { s = { commitTasks: {}, tasks: {} }; bySession.set(row.sessionId, s); }
    for (const [id, n] of Object.entries(row.commitTasks || {})) s.commitTasks[id] = (s.commitTasks[id] || 0) + n;
    for (const [id, n] of Object.entries(row.tasks || {})) s.tasks[id] = (s.tasks[id] || 0) + n;
  }
  const out = new Map();
  for (const [sid, s] of bySession) {
    const id = dominantTaskId(s.commitTasks, 1) ?? dominantTaskId(s.tasks, 2);
    if (id != null) out.set(sid, Number(id));
  }
  return out;
}

// A row's effective task id: the claim-window id if collection stamped one (kept
// in its ledger type — a number), else the banked session fallback. Null when
// neither fires (the `(no task)` bucket).
function effectiveTaskId(row, fallback) {
  if (row.taskId != null) return row.taskId;
  return fallback.get(row.sessionId) ?? null;
}

// --- queries (for the API + CLI report) --------------------------------------

function readUsageLedger() { return readResolved(LEDGER_PATH); }

function emptyTokens() { return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }; }

function foldRow(bucket, row) {
  addTokens(bucket.tokens, row.tokens);
  if (row.costUSD !== null) {
    bucket.costUSD = (bucket.costUSD || 0) + row.costUSD;
    if (row.backfilled) bucket.backfilledCostUSD = (bucket.backfilledCostUSD || 0) + row.costUSD;
  } else bucket.unpricedRows = (bucket.unpricedRows || 0) + 1;
}

function newBucket(extra = {}) {
  return { tokens: emptyTokens(), costUSD: 0, backfilledCostUSD: 0, unpricedRows: 0, ...extra };
}

function round2(o) {
  o.costUSD = Math.round((o.costUSD || 0) * 100) / 100;
  o.backfilledCostUSD = Math.round((o.backfilledCostUSD || 0) * 100) / 100;
  return o;
}

// The three places a ledger row can belong on the cross-project views (task 130):
//   'project' — a registered project (alias slugs already mapped by the reader)
//   'job'     — a scheduled job's own agent call (row.job)
//   'outside' — anything else: sessions run outside every registered project,
//               a project since unregistered, rows from before job attribution
// Every row lands in exactly one, so the three totals always add up to the
// ledger's — nothing is dropped for having no project to show it under.
// → (row) → { kind, key }
function ledgerPlacement() {
  const registered = new Set(readRegistry().map((e) => e.slug));
  return (row) => {
    if (row.job) return { kind: 'job', key: row.job };
    if (row.project && registered.has(row.project)) return { kind: 'project', key: row.project };
    return { kind: 'outside', key: row.project || '(unknown)' };
  };
}

// Cross-project rollup, one bucket per project / job / outside slug:
//   { projects: [{project, …}], jobs: [{job, …}], outside: [{project, …}] }
// each entry {sessions, models: {<model>: bucket}, …total bucket fields},
// sorted by cost. `outside` keeps its original slugs so a view can fold them
// into one line and still say what is in it.
function usageRollup() {
  const place = ledgerPlacement();
  const groups = { project: new Map(), job: new Map(), outside: new Map() };
  for (const row of readUsageLedger()) {
    const { kind, key } = place(row);
    const m = groups[kind];
    if (!m.has(key)) m.set(key, newBucket({ [kind === 'job' ? 'job' : 'project']: key, models: {}, sessions: new Set() }));
    const b = m.get(key);
    foldRow(b, row);
    b.sessions.add(row.sessionId);
    if (!b.models[row.model]) b.models[row.model] = newBucket();
    foldRow(b.models[row.model], row);
  }
  const out = (m) => [...m.values()]
    .map((p) => round2({ ...p, sessions: p.sessions.size, models: Object.fromEntries(Object.entries(p.models).map(([k, b]) => [k, round2(b)])) }))
    .sort((a, b) => b.costUSD - a.costUSD);
  return { projects: out(groups.project), jobs: out(groups.job), outside: out(groups.outside) };
}

// One project: per-model breakdown + per-task + per-worktree rollups. Rows
// under the project's alias slugs are already mapped to it by the reader.
function projectUsage(slug) {
  const inProject = (row) => (row.project || '(unknown)') === slug;
  const fallback = sessionTaskFallback();
  const models = {};
  const tasks = new Map();
  const worktrees = new Map();
  const total = newBucket({ sessions: new Set() });
  for (const row of readUsageLedger()) {
    if (!inProject(row)) continue;
    foldRow(total, row);
    total.sessions.add(row.sessionId);
    if (!models[row.model]) models[row.model] = newBucket();
    foldRow(models[row.model], row);
    const taskId = effectiveTaskId(row, fallback);
    const tkey = taskId ?? '(no task)';
    if (!tasks.has(tkey)) tasks.set(tkey, newBucket({ taskId, models: {} }));
    const t = tasks.get(tkey);
    foldRow(t, row);
    if (!t.models[row.model]) t.models[row.model] = newBucket();
    foldRow(t.models[row.model], row);
    const wkey = row.worktree || '(unknown)';
    if (!worktrees.has(wkey)) worktrees.set(wkey, newBucket({ worktree: row.worktree || null, sessions: new Set() }));
    const w = worktrees.get(wkey);
    foldRow(w, row);
    w.sessions.add(row.sessionId);
  }
  return {
    project: slug,
    ...round2(total),
    sessions: total.sessions.size,
    models: Object.fromEntries(Object.entries(models).map(([m, b]) => [m, round2(b)])),
    tasks: [...tasks.values()]
      .map((t) => round2({ ...t, models: Object.fromEntries(Object.entries(t.models).map(([m, b]) => [m, round2(b)])) }))
      .sort((a, b) => b.costUSD - a.costUSD),
    worktrees: [...worktrees.values()]
      .map((w) => round2({ ...w, sessions: w.sessions.size }))
      .sort((a, b) => b.costUSD - a.costUSD),
  };
}

function taskUsage(slug, taskId) {
  const want = String(taskId);
  const fallback = sessionTaskFallback();
  const models = {};
  const total = newBucket({ sessions: new Set() });
  for (const row of readUsageLedger()) {
    if ((row.project || '(unknown)') !== slug) continue;
    const eff = effectiveTaskId(row, fallback);
    if (eff == null || String(eff) !== want) continue;
    foldRow(total, row);
    total.sessions.add(row.sessionId);
    if (!models[row.model]) models[row.model] = newBucket();
    foldRow(models[row.model], row);
  }
  return {
    project: slug, taskId,
    ...round2(total),
    sessions: total.sessions.size,
    models: Object.fromEntries(Object.entries(models).map(([m, b]) => [m, round2(b)])),
  };
}

export {
  USAGE_DIR, LEDGER_PATH, CLAIMS_PATH, ACTIVITY_PATH, transcriptsRoot, findTranscriptsForSession,
  appendClaimEvent, claimWindows, resolveProjectForPath, worktreeForPath, jobForPath, chatSignals,
  collectUsage, collectActivity, repriceLedger, refreshPricing, readUsageLedger, readActivityLedger, ledgerPlacement, usageRollup, projectUsage, taskUsage,
  sessionTaskFallback, effectiveTaskId, harvestTaskRefs,
};
