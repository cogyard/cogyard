// core/addons/jobs.mjs — scheduled add-on jobs: run state and the guarded runner.
// The schedule vocabulary and slot arithmetic live in ./schedule.mjs (pure leaf).
//
// The add-on contract has two USER-TRIGGERED execution tiers (./index.mjs):
// 'safe' runs server-side via run(), 'manual' never executes and only renders a
// copy-paste command. A scheduled job is a THIRD thing — it runs UNATTENDED, on a
// timer, with nobody watching — so it gets its own entry point (runScheduled) and
// its own rules. An add-on opts in by declaring `schedule`; everything without one
// is untouched by this module.
//
// What core owns (here) vs what the add-on owns:
//   core     — when a job is due, its last/next run, the run log, the rolling
//              cost, the timeout, and the never-two-at-once guard.
//   the job  — what it actually does, and honouring the bounds it declared.
// An add-on author writes runScheduled() and nothing else.

import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { COGYARD_HOME, JOB_RUN_ROOT } from '../paths.mjs';
import { readConfig, writeConfig } from '../config.mjs';
import { loadAddons, supportedHere, providesEnabled } from './index.mjs';
import { driverCredential } from '../drivers.mjs';
import { formerSlugs } from '../registry.mjs';
import { whereToSet } from '../secrets.mjs';
import { normalizeSchedule, normalizeBounds, nextSlot, isDue } from './schedule.mjs';

const JOBS_PATH = join(COGYARD_HOME, 'jobs.json');

// Per-job log lines kept on disk. Enough to see last night and the night before;
// small enough that the file stays hand-readable.
const LOG_CAP = 40;

// --- persisted state ----------------------------------------------------------

function readJobs() {
  try {
    const j = JSON.parse(readFileSync(JOBS_PATH, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

// Atomic tmp+rename: the scheduler writes this from a long-lived process while
// the portal may be reading it to render a Settings row.
function writeJobs(next) {
  mkdirSync(dirname(JOBS_PATH), { recursive: true });
  const tmp = `${JOBS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, JOBS_PATH);
  return next;
}

function patchJob(id, patch) {
  const all = readJobs();
  all[id] = { ...(all[id] || {}), ...patch };
  writeJobs(all);
  return all[id];
}

// First sight of a job: record WHEN we first saw it, so the due check has a
// floor. Without this, a job installed at 06:00 with `at: '05:00'` fires
// immediately — "never ran" would read as "missed every slot since the epoch".
//
// Patches `seededAt` and NOTHING ELSE. It used to also write `runs: 0`,
// `totalCost: 0`, `log: []` — which reads as harmless initialization and is not:
// seeding happens on the first listScheduledJobs() call, and a Run now on a
// freshly installed job beats it there. The seed then landed on top of a
// completed run and erased its count, its cost, and its whole log. (Found while
// verifying that a saved setting reaches a run — the log it records was empty.)
// Every reader already defaults a missing counter, so writing them here bought
// nothing.
function seedJob(id, now = new Date()) {
  const all = readJobs();
  if (all[id]?.seededAt) return all[id];
  return patchJob(id, { seededAt: new Date(now).toISOString() });
}

function capLog(log, line, at) {
  return [...(Array.isArray(log) ? log : []), { at, line }].slice(-LOG_CAP);
}

// --- schedule overrides -------------------------------------------------------
// The manifest declares the DEFAULT time; the owner can move it from /settings
// without editing an add-on's source ("run the brief at 6, not 5" is the one
// knob anyone actually touches). Overrides live in config.json alongside
// disabledAddons, so they survive reinstalling the add-on.
//
// An override adjusts WHEN a job runs — it can never make an add-on scheduled
// that didn't declare a schedule. Otherwise you could put the tunnel add-on on
// a timer and call runScheduled() it doesn't have.

function readOverrides() {
  const o = readConfig().jobSchedules;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

// Pass null to clear and fall back to the manifest. An unparseable override is
// dropped rather than stored, so config.json can't hold a schedule core would
// silently reinterpret.
function setScheduleOverride(id, schedule) {
  const all = { ...readOverrides() };
  if (schedule === null || schedule === undefined) {
    delete all[id];
  } else {
    const norm = normalizeSchedule(schedule);
    if (!norm) throw new Error('invalid schedule — expected { every: "day"|"week", at: "HH:MM" }');
    all[id] = { every: norm.every, at: norm.at, weekday: norm.weekday, catchUp: norm.catchUp };
  }
  writeConfig({ jobSchedules: all });
  return all[id] ?? null;
}

// The schedule a job actually runs on, plus what the manifest asked for, so the
// Settings row can show "05:00 (default 04:00)" and offer a reset.
function effectiveSchedule(id, manifest) {
  const declared = normalizeSchedule(manifest.schedule);
  if (!declared) return { schedule: null, declared: null, overridden: false };
  const override = normalizeSchedule(readOverrides()[id]);
  return { schedule: override || declared, declared, overridden: !!override };
}

// --- discovery ----------------------------------------------------------------

// Every installed add-on that declares a valid schedule, with its normalized
// schedule, bounds, and run state. `active`/`supported` are REPORTED, not
// filtered — a Settings row has to show a switched-off job as switched off.
// Callers that want only what should run filter on `due` (see dueJobs).
async function listScheduledJobs({ now = new Date(), disabled = new Set() } = {}) {
  const { ok } = await loadAddons();
  const agentCred = driverCredential();
  const out = [];
  for (const { id, manifest } of ok) {
    const { schedule, declared, overridden } = effectiveSchedule(id, manifest);
    if (!schedule) continue;
    const active = !disabled.has(id);
    const supported = supportedHere(manifest);
    if (active && supported) seedJob(id, now);
    const entry = readJobs()[id] || {};
    const since = entry.lastRunAt || entry.seededAt || null;
    out.push({
      id,
      label: manifest.label,
      icon: manifest.icon ?? null,
      description: manifest.description ?? '',
      schedule,
      declaredSchedule: declared,
      overridden,
      bounds: normalizeBounds(manifest.bounds),
      active,
      supported,
      runnable: typeof manifest.runScheduled === 'function',
      lastRunAt: entry.lastRunAt ?? null,
      lastOutcome: entry.lastOutcome ?? null,
      lastSummary: entry.lastSummary ?? '',
      lastError: entry.lastError ?? null,
      lastDurationMs: entry.lastDurationMs ?? null,
      runs: entry.runs ?? 0,
      totalCost: entry.totalCost ?? 0,
      nextRunAt: active && supported ? nextSlot(schedule, now).toISOString() : null,
      due: active && supported ? isDue(schedule, since, now) : false,
      log: Array.isArray(entry.log) ? entry.log : [],
      // The credential this job will need at its slot, and where to set it if it
      // is missing (task 127). It is SET in the credential store and USED here,
      // and this row is where someone looks in the morning — so the row carries
      // the pointer itself rather than leaving "it failed" as the whole story.
      //
      // Only for a job that DECLARED `needsAgent`. Core cannot tell whether a
      // given job calls the agent, and a job that only reads git and files needs
      // no credential at all — telling its owner otherwise would be a false alarm
      // on the one row they read in the morning. Null when the job doesn't need
      // one, or the active driver has none.
      credential: (manifest.needsAgent && agentCred)
        ? { env: agentCred.env, label: agentCred.label, set: agentCred.set, howTo: agentCred.howTo, whereToSet: whereToSet(agentCred.env) }
        : null,
    });
  }
  return out;
}

async function dueJobs(opts = {}) {
  // Nothing is due while the scheduled-jobs capability is switched off: that
  // switch is the owner saying "don't do work while I sleep", and it has to mean
  // it, not merely hide a section.
  if (!(await providesEnabled('scheduled-jobs', opts.disabled))) return [];
  return (await listScheduledJobs(opts)).filter((j) => j.due && j.runnable);
}

// --- the runner ---------------------------------------------------------------

// In-process guard: never two runs of the same job at once. A nightly job can
// overrun its own next slot (a slow night, twelve projects), and a second run on
// top of the first would double-write and double-spend.
const running = new Set();
function isRunning(id) { return running.has(id); }

// The folder a job's agent call runs in: `$COGYARD_HOME/run/<job-id>`, empty,
// created on demand. Its only purpose is identity — the agent's transcript
// records the folder it ran in, and core/usage.mjs files any transcript under
// this root to the job rather than to a project (task 130). A job that examines
// every registered project in one pass belongs to none of them.
function jobRunDir(id) {
  const dir = join(JOB_RUN_ROOT, id);
  try { mkdirSync(dir, { recursive: true }); } catch { /* the driver falls back to its own default */ }
  return dir;
}

// The agent a job receives: the driver's own, with the job's run folder pinned
// as the place it runs. Additive to the runScheduled contract — the job calls
// `ctx.agent.run({ prompt, ... })` exactly as before and never sees the folder.
function agentForJob(agent, id) {
  if (!agent || typeof agent.run !== 'function') return agent;
  const cwd = jobRunDir(id);
  return { ...agent, run: (opts = {}) => agent.run({ ...opts, cwd }) };
}

// Run one scheduled job under core's guarantees: single-flight, timeout-aborted,
// state recorded, exceptions turned into data. NEVER throws — a job that blows
// up at 05:00 must not take the portal with it, and the failure has to be
// visible on the Settings row in the morning.
//
// `deps` supplies what core hands the job in ctx: projects and agent come from
// the CALLER (the scheduler, or a run-now request), so this module never reaches
// for the registry or a driver itself — which is also what makes it testable
// with neither.
async function runScheduledJob(id, deps = {}) {
  const { now = new Date(), projects = [], agent = null, disabled = new Set(), trigger = 'schedule', cfg = {} } = deps;
  const startedAt = new Date(now).toISOString();
  const t0 = Date.now();
  const done = (o) => ({ id, startedAt, durationMs: Date.now() - t0, cost: 0, summary: '', ...o });

  // Claim the slot SYNCHRONOUSLY, before the first await. Registering the guard
  // after `await loadAddons()` looks equivalent and is not: two scheduler ticks
  // arriving in the same turn both sail past the check and run the job twice.
  // (Caught by the single-flight test, which failed exactly that way.)
  if (running.has(id)) return done({ ok: false, outcome: 'skipped', error: 'already running' });
  running.add(id);

  try {
    const { ok } = await loadAddons();
    const found = ok.find((a) => a.id === id);
    if (!found) return done({ ok: false, outcome: 'error', error: `unknown add-on: ${id}` });

    const { manifest } = found;
    const { schedule } = effectiveSchedule(id, manifest);
    const bounds = normalizeBounds(manifest.bounds);
    const fail = (error) => done({ ok: false, outcome: 'error', error });

    if (!schedule) return fail(`add-on '${id}' declares no schedule`);
    if (disabled.has(id)) return fail(`add-on '${id}' is switched off`);
    if (!supportedHere(manifest)) return fail(`add-on '${id}' is not available on ${process.platform}`);
    if (typeof manifest.runScheduled !== 'function') return fail(`add-on '${id}' has no runScheduled()`);

    const entry = readJobs()[id] || {};
    const lines = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), bounds.timeoutMs);

    let result = null;
    let error = null;
    try {
      result = await manifest.runScheduled(cfg, {
        // Each row also carries `formerSlugs`: the slugs the project was
        // registered under before its current one, where its older output
        // still sits (task 195; docs/ADDONS.md). Derived from the row itself.
        projects: projects.map((p) => ({ ...p, formerSlugs: formerSlugs(p) })),
        agent: agentForJob(agent, id),
        bounds,
        signal: ac.signal,
        lastRunAt: entry.lastRunAt ?? null,
        trigger,
        log: (line) => { lines.push({ at: new Date().toISOString(), line: String(line) }); },
      });
    } catch (e) {
      error = String((e && e.message) || e);
    } finally {
      clearTimeout(timer);
    }

    // An aborted run that swallowed its own AbortError still counts as a timeout —
    // trust the signal, not what the job chose to return.
    if (ac.signal.aborted) error = `timed out after ${bounds.timeoutMs}ms`;

    const v = result && typeof result === 'object' ? result : {};
    const cost = typeof v.cost === 'number' && Number.isFinite(v.cost) ? v.cost : 0;
    const summary = typeof v.summary === 'string' ? v.summary : '';
    if (!error && v.ok === false) error = typeof v.error === 'string' ? v.error : 'job reported failure';
    const outcome = error ? 'error' : (v.skipped ? 'skipped' : 'ok');

    const finishedAt = new Date().toISOString();
    let log = entry.log;
    for (const l of lines) log = capLog(log, l.line, l.at);
    log = capLog(log, error ? `${outcome}: ${error}` : `${outcome}: ${summary || 'no summary'}`, finishedAt);

    patchJob(id, {
      lastRunAt: finishedAt,
      lastOutcome: outcome,
      lastSummary: summary,
      lastError: error,
      lastDurationMs: Date.now() - t0,
      lastTrigger: trigger,
      runs: (entry.runs ?? 0) + 1,
      totalCost: Number(((entry.totalCost ?? 0) + cost).toFixed(6)),
      log,
    });

    return done({ ok: !error, outcome, summary, error, cost });
  } finally {
    running.delete(id);
  }
}

export {
  JOBS_PATH, LOG_CAP,
  readJobs, writeJobs, seedJob,
  readOverrides, setScheduleOverride, effectiveSchedule,
  listScheduledJobs, dueJobs, runScheduledJob, isRunning, jobRunDir,
};
