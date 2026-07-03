// core/usage.mjs — token/cost usage ledger (task 026).
//
// Harvests the active agent's session transcripts into a durable append-only
// ledger under $COGYARD_HOME/usage/. WHERE transcripts live and HOW a line parses
// into token rows is the active integration's job (task 038 — the `transcripts`
// adapter seam; see core/integrations.mjs + docs/INTEGRATIONS.md). This module
// owns the agent-agnostic half: cursors, aggregation, the claim↔session join, and
// the ledger. With the no-op adapter (no agent) harvesting is a no-op and the
// usage tab degrades gracefully. Cost is locked in at collection time via
// core/pricing.mjs. Transcripts get pruned by agent retention; the ledger is forever.
//
// Files:
//   usage.jsonl   — one row per (sessionId, model, taskId) aggregate per collection
//   claims.jsonl  — claim/release events appended by cli/env.mjs (task↔session join)
//   cursors.json  — per-transcript byte offset + recent dedupe keys (idempotency)
//   activity.jsonl        — attention/labor rows (task 064): per collection, per
//                           session — exact HUMAN prompt timestamps + per-UTC-hour
//                           assistant message counts. Derived counts, never priced.
//   cursors-activity.json — activity's OWN cursor namespace, deliberately separate
//                           from cursors.json: its first run walks every on-disk
//                           transcript from byte 0, retro-filling hour-level data
//                           for history the usage cursors already consumed (the
//                           task-064 "rebucket"; pruned transcripts stay
//                           approximated from usage rows' firstTs/lastTs).

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { readRegistry } from './registry.mjs';
import { priceFor } from './pricing.mjs';
import { adapter } from './integrations.mjs';

const USAGE_DIR = join(COGYARD_HOME, 'usage');
const LEDGER_PATH = join(USAGE_DIR, 'usage.jsonl');
const CLAIMS_PATH = join(USAGE_DIR, 'claims.jsonl');
const CURSORS_PATH = join(USAGE_DIR, 'cursors.json');
const ACTIVITY_PATH = join(USAGE_DIR, 'activity.jsonl');
const ACTIVITY_CURSORS_PATH = join(USAGE_DIR, 'cursors-activity.json');

// Transcript location + per-session lookup come from the active integration.
function transcriptsRoot() { return adapter.transcripts.root(); }
function findTranscriptsForSession(sessionId) { return adapter.transcripts.findBySession(sessionId); }

function ensureUsageDir() { mkdirSync(USAGE_DIR, { recursive: true }); }

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
  for (const ev of readJsonl(CLAIMS_PATH)) {
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
      // The active integration owns the transcript format: a line → {sessionId,
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
      const project = resolveProjectForPath(cwd);
      const worktree = worktreeForPath(cwd);
      for (const agg of aggregates.values()) {
        const { costUSD, pricingVersion } = priceFor(agg.model, agg.tokens);
        if (costUSD === null) skippedModels.add(agg.model);
        newRows.push({
          capturedAt,
          sessionId: sessionId || basename(file, '.jsonl'),
          project,
          worktree,
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

// --- activity collection (task 064) ------------------------------------------

// UTC hour bucket key for an ISO timestamp: "2026-07-02T14".
function hourKey(ts) { return String(ts).slice(0, 13); }

// Task-file references in raw transcript text (task 064): `_tasks/NNN-…` is the
// cogyard task-file naming convention, so counting matches per task id tells us
// which task a session was actually working — far better coverage than the
// claims join (most sessions never formally claim). Format-agnostic: it greps
// the raw line, not an agent-specific field.
const TASK_REF_RE = /_tasks\/0*(\d+)-/g;
// Stronger still: `[#NN]` tags in the session's OWN `git commit` invocations
// (the /commit skill stamps them). Scoped to lines containing 'git commit' so
// `git log` output echoing OTHER commits' historical tags never counts.
const COMMIT_TAG_RE = /\[#0*(\d+)\]/g;

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
      for (const m of line.matchAll(TASK_REF_RE)) tasks[m[1]] = (tasks[m[1]] || 0) + 1;
      if (line.includes('git commit')) {
        for (const m of line.matchAll(COMMIT_TAG_RE)) commitTasks[m[1]] = (commitTasks[m[1]] || 0) + 1;
      }
      const parsed = adapter.transcripts.parseLine(line);
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
      newRows.push({
        capturedAt,
        sessionId: sessionId || basename(file, '.jsonl'),
        project: resolveProjectForPath(cwd),
        worktree: worktreeForPath(cwd),
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

function readActivityLedger() { return readJsonl(ACTIVITY_PATH); }

// --- queries (for the API + CLI report) --------------------------------------

function readUsageLedger() { return readJsonl(LEDGER_PATH); }

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

// Cross-project rollup: [{project, models: {<model>: bucket}, total bucket fields}]
function usageRollup() {
  const projects = new Map();
  for (const row of readUsageLedger()) {
    const slug = row.project || '(unknown)';
    if (!projects.has(slug)) projects.set(slug, newBucket({ project: slug, models: {}, sessions: new Set() }));
    const p = projects.get(slug);
    foldRow(p, row);
    p.sessions.add(row.sessionId);
    if (!p.models[row.model]) p.models[row.model] = newBucket();
    foldRow(p.models[row.model], row);
  }
  return [...projects.values()]
    .map((p) => round2({ ...p, sessions: p.sessions.size, models: Object.fromEntries(Object.entries(p.models).map(([m, b]) => [m, round2(b)])) }))
    .sort((a, b) => b.costUSD - a.costUSD);
}

// One project: per-model breakdown + per-task + per-worktree rollups. Matches
// the collapsed project slug OR any per-clone ledger slug (e.g. `proj` ↔
// `proj__clone`).
function projectUsage(slug) {
  const inProject = (row) => { const p = row.project || '(unknown)'; return p === slug || p.startsWith(slug + '__'); };
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
    const tkey = row.taskId ?? '(no task)';
    if (!tasks.has(tkey)) tasks.set(tkey, newBucket({ taskId: row.taskId, models: {} }));
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
  const models = {};
  const total = newBucket({ sessions: new Set() });
  for (const row of readUsageLedger()) {
    if ((row.project || '(unknown)') !== slug) continue;
    if (String(row.taskId) !== want) continue;
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
  appendClaimEvent, claimWindows, resolveProjectForPath,
  collectUsage, collectActivity, readUsageLedger, readActivityLedger, usageRollup, projectUsage, taskUsage,
};
