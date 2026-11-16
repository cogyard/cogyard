// test/addon-jobs.test.mjs — scheduled add-on jobs (the third execution tier).
// Covers the schedule vocabulary and slot arithmetic (pure), discovery of
// scheduled add-ons, the seed that stops a fresh install firing immediately, and
// the runner's guarantees: single-flight, timeout-aborted, state recorded, and
// NEVER throwing — a job that blows up at 05:00 must not take the portal down.
//
// No agent is involved anywhere here: the fixtures need none, which is the whole
// point of testing the scheduler with a fixture rather than a real job.
//
// COGYARD_HOME is pointed at a throwaway temp dir BEFORE importing the modules
// (same pattern as addons.test.mjs; the Node test runner isolates each file in
// its own process, so this never touches the real ~/.cogyard).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-jobs-'));
process.env.COGYARD_HOME = HOME;
const DIR = join(HOME, 'addons');

const { normalizeSchedule, normalizeBounds, prevSlot, nextSlot, isDue, DEFAULT_BOUNDS } =
  await import('../core/addons/schedule.mjs');
const { listAddons, resetAddons } = await import('../core/addons/index.mjs');
const { listScheduledJobs, dueJobs, runScheduledJob, readJobs, writeJobs, seedJob, setScheduleOverride } =
  await import('../core/addons/jobs.mjs');

// A well-behaved nightly job. Reports a summary and a cost, and logs a line.
const NIGHTLY = `
export const manifest = {
  id: 'nightly',
  label: 'Nightly Fixture',
  schedule: { every: 'day', at: '05:00' },
  bounds: { timeoutMs: 2000, maxUnits: 3, maxCostUsd: 1 },
  status() { return { enabled: true, summary: 'fixture' }; },
  async runScheduled(cfg, ctx) {
    ctx.log('looked at ' + ctx.projects.length + ' projects');
    return { ok: true, summary: 'did the thing', cost: 0.25 };
  },
};
`;

// Declares a schedule but throws. The runner must catch it and report.
const EXPLODER = `
export const manifest = {
  id: 'exploder',
  label: 'Exploding Fixture',
  schedule: { every: 'day', at: '05:00' },
  async runScheduled() { throw new Error('boom'); },
};
`;

// Honours the abort signal, so the timeout path resolves promptly.
const HANGER = `
export const manifest = {
  id: 'hanger',
  label: 'Hanging Fixture',
  schedule: { every: 'day', at: '05:00' },
  bounds: { timeoutMs: 40 },
  async runScheduled(cfg, ctx) {
    await new Promise((res) => ctx.signal.addEventListener('abort', res, { once: true }));
    return { ok: true, summary: 'should be ignored — the signal aborted' };
  },
};
`;

// No schedule at all: the existing kind of add-on, which must be untouched.
const PLAIN = `
export const manifest = {
  id: 'plain',
  label: 'Plain Add-on',
  status() { return { enabled: true, summary: 'no schedule here' }; },
  actions: [{ id: 'go', label: 'Go', tier: 'safe' }],
  run() { return { ok: true, message: 'went' }; },
};
`;

// Declares a schedule but forgot runScheduled() — an add-on bug the row shows.
const FORGETFUL = `
export const manifest = {
  id: 'forgetful',
  label: 'Forgetful Fixture',
  schedule: { every: 'week', at: '06:30', weekday: 3 },
};
`;

// A schedule core cannot make sense of → not a scheduled job (never a
// different schedule than the author wrote).
const GARBLED = `
export const manifest = {
  id: 'garbled',
  label: 'Garbled Fixture',
  schedule: { every: 'fortnight', at: '25:99' },
  async runScheduled() { return { ok: true }; },
};
`;

function install(id, src) {
  mkdirSync(join(DIR, id), { recursive: true });
  writeFileSync(join(DIR, id, 'addon.mjs'), src);
}

// Scheduled work is a CAPABILITY an add-on provides (task 127): without an
// installed, switched-on `provides: 'scheduled-jobs'` add-on, nothing is ever
// due. The fixture installs one so the rest of this file exercises the runner
// rather than the gate; the gate has its own test below.
const GATE = `
export const manifest = { id: 'gate', label: 'Scheduled tasks', provides: 'scheduled-jobs' };
`;

before(() => {
  for (const [id, src] of [
    ['nightly', NIGHTLY], ['exploder', EXPLODER], ['hanger', HANGER],
    ['plain', PLAIN], ['forgetful', FORGETFUL], ['garbled', GARBLED],
    ['gate', GATE],
  ]) install(id, src);
  resetAddons();
});

after(() => { rmSync(HOME, { recursive: true, force: true }); });

// --- the schedule vocabulary (pure) -------------------------------------------

test('normalizeSchedule accepts the daily and weekly shapes', () => {
  assert.deepEqual(normalizeSchedule({ every: 'day', at: '05:00' }), {
    every: 'day', at: '05:00', hour: 5, minute: 0, weekday: null, catchUp: true,
  });
  const w = normalizeSchedule({ every: 'week', at: '6:30', weekday: 3, catchUp: false });
  assert.equal(w.at, '06:30');       // normalized to two digits
  assert.equal(w.weekday, 3);
  assert.equal(w.catchUp, false);
  // Weekly without a weekday is underspecified → Monday, not a crash.
  assert.equal(normalizeSchedule({ every: 'week', at: '00:00' }).weekday, 1);
});

test('normalizeSchedule rejects anything it cannot mean exactly', () => {
  for (const bad of [
    undefined, null, 'day', {}, { every: 'day' }, { at: '05:00' },
    { every: 'fortnight', at: '05:00' }, { every: 'day', at: '25:00' },
    { every: 'day', at: '5pm' }, { every: 'day', at: '05:60' },
  ]) assert.equal(normalizeSchedule(bad), null, `should reject ${JSON.stringify(bad)}`);
});

test('normalizeBounds fills defaults and rejects nonsense values', () => {
  assert.deepEqual(normalizeBounds(undefined), DEFAULT_BOUNDS);
  assert.deepEqual(normalizeBounds({ timeoutMs: -1, maxUnits: 0, maxCostUsd: 'lots' }), DEFAULT_BOUNDS);
  assert.equal(normalizeBounds({ timeoutMs: 500 }).timeoutMs, 500);
});

test('slot arithmetic: daily slots sit either side of now', () => {
  const s = normalizeSchedule({ every: 'day', at: '05:00' });
  const now = new Date(2026, 7, 12, 9, 0, 0);        // 09:00, after the slot
  assert.equal(prevSlot(s, now).getTime(), new Date(2026, 7, 12, 5, 0, 0).getTime());
  assert.equal(nextSlot(s, now).getTime(), new Date(2026, 7, 13, 5, 0, 0).getTime());

  const before = new Date(2026, 7, 12, 3, 0, 0);     // 03:00, before the slot
  assert.equal(prevSlot(s, before).getTime(), new Date(2026, 7, 11, 5, 0, 0).getTime());
  assert.equal(nextSlot(s, before).getTime(), new Date(2026, 7, 12, 5, 0, 0).getTime());
});

test('slot arithmetic: weekly lands on the declared weekday', () => {
  const s = normalizeSchedule({ every: 'week', at: '05:00', weekday: 3 }); // Wednesday
  const now = new Date(2026, 7, 12, 9, 0, 0);       // 2026-08-12 is a Wednesday
  assert.equal(prevSlot(s, now).getDay(), 3);
  assert.equal(nextSlot(s, now).getDay(), 3);
  assert.equal(nextSlot(s, now).getTime() - prevSlot(s, now).getTime(), 7 * 24 * 3600 * 1000);
});

test('isDue: a run after the slot satisfies it; a missed slot re-arms it', () => {
  const s = normalizeSchedule({ every: 'day', at: '05:00' });
  const now = new Date(2026, 7, 12, 9, 0, 0);
  assert.equal(isDue(s, new Date(2026, 7, 12, 5, 1, 0).toISOString(), now), false); // ran at 05:01
  assert.equal(isDue(s, new Date(2026, 7, 11, 5, 1, 0).toISOString(), now), true);  // ran yesterday
});

test('isDue: catchUp off skips a stale slot, on takes it', () => {
  const now = new Date(2026, 7, 12, 23, 0, 0);       // 18h after the 05:00 slot
  const since = new Date(2026, 7, 11, 5, 1, 0).toISOString();
  assert.equal(isDue(normalizeSchedule({ every: 'day', at: '05:00' }), since, now), true);
  assert.equal(isDue(normalizeSchedule({ every: 'day', at: '05:00', catchUp: false }), since, now), false);
  // …but catchUp off still runs inside the grace window.
  const justAfter = new Date(2026, 7, 12, 5, 30, 0);
  assert.equal(isDue(normalizeSchedule({ every: 'day', at: '05:00', catchUp: false }), since, justAfter), true);
});

// --- discovery ----------------------------------------------------------------

test('the catalog reports a schedule without disturbing unscheduled add-ons', async () => {
  const { addons } = await listAddons();
  const byId = Object.fromEntries(addons.map((a) => [a.id, a]));
  assert.equal(byId.nightly.schedule.at, '05:00');
  assert.equal(byId.nightly.runnable, true);
  assert.equal(byId.nightly.bounds.maxUnits, 3);
  // A plain add-on is untouched: no schedule, no bounds, actions intact.
  assert.equal(byId.plain.schedule, null);
  assert.equal(byId.plain.bounds, null);
  assert.equal(byId.plain.actions[0].id, 'go');
  // A garbled schedule is NOT a schedule.
  assert.equal(byId.garbled.schedule, null);
  // Declared a schedule, forgot the entry point — both facts reported.
  assert.equal(byId.forgetful.schedule.weekday, 3);
  assert.equal(byId.forgetful.runnable, false);
});

test('listScheduledJobs returns only the scheduled ones, with state', async () => {
  const jobs = await listScheduledJobs({ now: new Date(2026, 7, 12, 9, 0, 0) });
  const ids = jobs.map((j) => j.id).sort();
  assert.deepEqual(ids, ['exploder', 'forgetful', 'hanger', 'nightly']);
  const n = jobs.find((j) => j.id === 'nightly');
  assert.equal(n.active, true);
  assert.equal(n.runs, 0);
  assert.ok(n.nextRunAt);
});

test('a freshly seen job does not fire immediately — the seed is the floor', async () => {
  // Seeded at 09:00, asked at 09:05: the 05:00 slot is in the past but predates
  // the seed, so it is not "missed" — the job waits for tomorrow.
  const jobs = await listScheduledJobs({ now: new Date(2026, 7, 12, 9, 5, 0) });
  assert.equal(jobs.find((j) => j.id === 'nightly').due, false);
});

test('a switched-off job is listed but never due', async () => {
  const jobs = await listScheduledJobs({ now: new Date(2030, 0, 1, 9, 0), disabled: new Set(['nightly']) });
  const n = jobs.find((j) => j.id === 'nightly');
  assert.equal(n.active, false);
  assert.equal(n.due, false);
  assert.equal(n.nextRunAt, null);
  assert.equal((await dueJobs({ now: new Date(2030, 0, 1, 9, 0), disabled: new Set(['nightly']) }))
    .some((j) => j.id === 'nightly'), false);
});

test('nothing is due while the scheduled-jobs capability is switched off', async () => {
  // The switch means "don't do work while I sleep", so it has to stop the RUNNER
  // and not merely hide a section.
  writeJobs({ ...readJobs(), nightly: { ...readJobs().nightly, lastRunAt: new Date(2030, 0, 1, 5, 1).toISOString() } });
  const off = await dueJobs({ now: new Date(2030, 0, 3, 9, 0), disabled: new Set(['gate']) });
  assert.deepEqual(off, []);
});

test('dueJobs picks up a slot missed since the last run', async () => {
  // Backdate the last run so the most recent 05:00 slot counts as missed.
  writeJobs({ ...readJobs(), nightly: { ...readJobs().nightly, lastRunAt: new Date(2030, 0, 1, 5, 1).toISOString() } });
  const due = await dueJobs({ now: new Date(2030, 0, 3, 9, 0) });
  assert.ok(due.some((j) => j.id === 'nightly'));
  // forgetful declares a schedule but has no runScheduled → never "due to run".
  assert.equal(due.some((j) => j.id === 'forgetful'), false);
});

// --- the runner ---------------------------------------------------------------

test('a good job runs, and its outcome + cost + log are recorded', async () => {
  const r = await runScheduledJob('nightly', { projects: [{ slug: 'a' }, { slug: 'b' }], trigger: 'manual' });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'ok');
  assert.equal(r.summary, 'did the thing');
  assert.equal(r.cost, 0.25);

  const state = readJobs().nightly;
  assert.equal(state.lastOutcome, 'ok');
  assert.equal(state.lastTrigger, 'manual');
  assert.equal(state.totalCost, 0.25);
  assert.ok(state.log.some((l) => l.line.includes('looked at 2 projects')));

  // Cost accumulates across runs rather than being overwritten.
  await runScheduledJob('nightly', {});
  assert.equal(readJobs().nightly.totalCost, 0.5);
  assert.equal(readJobs().nightly.runs, 2);
});

test('a throwing job is caught, reported, and never propagates', async () => {
  const r = await runScheduledJob('exploder', {});
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'error');
  assert.equal(r.error, 'boom');
  assert.equal(readJobs().exploder.lastError, 'boom');
});

test('a job that overruns its bound is aborted and recorded as a timeout', async () => {
  const r = await runScheduledJob('hanger', {});
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'error');
  assert.match(r.error, /timed out after 40ms/);
});

test('the same job never runs twice at once', async () => {
  const first = runScheduledJob('hanger', {});          // holds the slot until its 40ms abort
  const second = await runScheduledJob('hanger', {});
  assert.equal(second.outcome, 'skipped');
  assert.equal(second.error, 'already running');
  await first;
});

// --- schedule overrides -------------------------------------------------------

test('an override moves the time and reports the manifest default alongside', async () => {
  const at = (js) => js.find((j) => j.id === 'nightly');
  assert.equal(at(await listScheduledJobs({})).overridden, false);

  setScheduleOverride('nightly', { every: 'day', at: '06:30' });
  const moved = at(await listScheduledJobs({}));
  assert.equal(moved.schedule.at, '06:30');       // what it now runs on
  assert.equal(moved.declaredSchedule.at, '05:00'); // what the add-on asked for
  assert.equal(moved.overridden, true);

  // …and the override drives the actual due arithmetic, not just the display.
  const beforeSix = at(await listScheduledJobs({ now: new Date(2030, 5, 1, 6, 0) }));
  const afterSeven = at(await listScheduledJobs({ now: new Date(2030, 5, 1, 7, 0) }));
  assert.ok(new Date(beforeSix.nextRunAt).getHours() === 6);
  assert.ok(new Date(afterSeven.nextRunAt).getDate() > new Date(beforeSix.nextRunAt).getDate() - 1);

  setScheduleOverride('nightly', null);
  const reset = at(await listScheduledJobs({}));
  assert.equal(reset.schedule.at, '05:00');
  assert.equal(reset.overridden, false);
});

test('an override core cannot parse is refused, not stored', async () => {
  assert.throws(() => setScheduleOverride('nightly', { every: 'fortnight', at: '05:00' }), /invalid schedule/);
  assert.throws(() => setScheduleOverride('nightly', { every: 'day', at: '99:99' }), /invalid schedule/);
  assert.equal((await listScheduledJobs({})).find((j) => j.id === 'nightly').overridden, false);
});

test('an override cannot make an unscheduled add-on into a job', async () => {
  setScheduleOverride('plain', { every: 'day', at: '05:00' });
  const jobs = await listScheduledJobs({});
  assert.equal(jobs.some((j) => j.id === 'plain'), false);
  assert.match((await runScheduledJob('plain', {})).error, /declares no schedule/);
  setScheduleOverride('plain', null);
});

test('the runner refuses the cases the contract forbids — without throwing', async () => {
  const off = await runScheduledJob('nightly', { disabled: new Set(['nightly']) });
  assert.match(off.error, /switched off/);
  const noEntry = await runScheduledJob('forgetful', {});
  assert.match(noEntry.error, /has no runScheduled/);
  const unscheduled = await runScheduledJob('plain', {});
  assert.match(unscheduled.error, /declares no schedule/);
  const unknown = await runScheduledJob('nope', {});
  assert.match(unknown.error, /unknown add-on/);
});

// --- where a job's agent call runs (task 130) ----------------------------------

// Calls the agent it is handed, the way a real job does — and nothing more.
const CALLER = `
export const manifest = {
  id: 'caller',
  label: 'Calling Fixture',
  schedule: { every: 'day', at: '05:00' },
  async runScheduled(cfg, ctx) {
    const r = await ctx.agent.run({ prompt: 'hello', model: 'm' });
    return { ok: true, summary: r.text, cost: 0 };
  },
};
`;

test("a job's agent call runs in that job's own folder under the run root", async () => {
  install('caller', CALLER);
  resetAddons();
  const seen = [];
  const agent = { credential: { env: 'X' }, async run(opts) { seen.push(opts); return { ok: true, text: 'hi' }; } };
  const r = await runScheduledJob('caller', { agent });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  // The job's own arguments pass through untouched; only the folder is added.
  assert.equal(seen[0].prompt, 'hello');
  assert.equal(seen[0].model, 'm');
  assert.equal(seen[0].cwd, join(HOME, 'run', 'caller'));
  assert.ok(existsSync(seen[0].cwd), 'the folder exists before the agent is spawned in it');
});
