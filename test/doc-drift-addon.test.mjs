// test/doc-drift-addon.test.mjs — the doc-drift add-on's job (extras/addons/doc-drift).
//
// The add-on is not core and ships nothing in the published tree, but its
// behaviour under task 118's scheduled-job contract is worth pinning: the
// expensive half is an agent call, and the rules about when NOT to make one are
// the whole design. A stub agent stands in for the driver — the point is which
// questions get asked, not what a real model answers.
//
// COGYARD_HOME is redirected to a throwaway dir BEFORE the modules load, so the
// add-on's own state file — and, since task 187, its report and heartbeat —
// never touch the real ~/.cogyard.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-docdrift-addon-'));
process.env.COGYARD_HOME = HOME;

const { manifest } = await import('../extras/addons/doc-drift/addon.mjs');
const { parseVerdict, buildPrompt } = await import('../extras/addons/doc-drift/prompt.mjs');
const { fingerprint, writeHeartbeat, reportPath } = await import('../extras/addons/doc-drift/report.mjs');
const { readHeartbeats } = await import('../core/briefs.mjs');
const { readDrift } = await import('../core/drift.mjs');
const jobOutput = await import('../core/job-output.mjs');
const briefStore = await import('../extras/addons/project-brief/store.mjs');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const at = (days) => new Date(T0 + days * DAY).toISOString();

let ROOT;
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', ...args], { encoding: 'utf8' });

function write(dir, rel, body) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

function commit(dir, message, days) {
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '-m', message],
    { env: { ...process.env, GIT_AUTHOR_DATE: at(days), GIT_COMMITTER_DATE: at(days) } });
}

// The doc says something specific and checkable, so the stub can quote it back.
const DOC = 'The loader reads addon.mjs from ~/.cogyard/addons and nothing else.\n';

function project(name, { drift = true } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'docs/AREA.md', DOC);
  write(dir, 'core/thing/index.mjs', 'export const a = 1;\n');
  for (const id of [11, 12]) {
    write(dir, `.cogyard/tasks/0${id}-t.md`, [
      '---', `id: ${id}`, `slug: t${id}`, `title: task ${id}`, 'status: DONE',
      'touches_paths:', '  - core/thing/', '  - docs/AREA.md', '---', '', `# ${id}`, '', 'reshaped the loader.',
    ].join('\n'));
  }
  commit(dir, 'init', 0);
  if (drift) {
    write(dir, 'core/thing/index.mjs', 'export const a = 2;\n');
    commit(dir, '[#11] feat(thing): reshape', 40);
    write(dir, 'core/thing/index.mjs', 'export const a = 3;\n');
    commit(dir, '[#12] feat(thing): reshape again', 45);
  }
  return { slug: name, label: name, path: dir };
}

// A driver stand-in. Records every prompt it is asked, so "no agent call" is an
// assertion about a number and not a hope.
function stubAgent(answer) {
  const calls = [];
  return {
    supported: true,
    calls,
    async run({ prompt }) {
      calls.push(prompt);
      return { ok: true, text: typeof answer === 'function' ? answer(prompt) : answer, cost: 0.01, model: 'stub' };
    },
  };
}

const STALE_ANSWER = [
  'VERDICT: stale',
  `CLAIM: ${DOC.trim()}`,
  'NOW: The loader also resolves scheduled jobs through core/addons/jobs.mjs.',
  'TASKS: 11, 12',
].join('\n');

// Where a project's report lands: under HOME by slug (task 187), never in its store.
const driftFile = (p) => join(HOME, 'drift', `${p.slug}.md`);

const runJob = (agent, projects, cfg = {}) =>
  manifest.runScheduled(cfg, { projects, agent, bounds: { maxUnits: 12, maxCostUsd: 2 }, log: () => {}, trigger: 'manual' });

before(() => { ROOT = mkdtempSync(join(tmpdir(), 'cogyard-docdrift-repos-')); });
after(() => { rmSync(ROOT, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true }); });
beforeEach(() => { rmSync(join(HOME, 'doc-drift.json'), { force: true }); });

test('a confirmed finding is written to $COGYARD_HOME/drift/<slug>.md — not the task store', async () => {
  const p = project('finds');
  const agent = stubAgent(STALE_ANSWER);
  const r = await runJob(agent, [p]);

  assert.equal(agent.calls.length, 1);
  assert.equal(r.ok, true);
  assert.match(r.summary, /1 doc looks stale/);
  const report = readFileSync(driftFile(p), 'utf8');
  assert.match(report, /docs\/AREA\.md/);
  assert.match(report, /The loader reads addon\.mjs/);
  assert.match(report, /#11/);
  assert.match(report, /findings: 1/);
  // Where core reads it — and nothing landed in the store.
  assert.equal(readDrift(p.slug).findings, 1);
  assert.equal(existsSync(join(p.path, '.cogyard', 'tasks', 'drift.md')), false);
  assert.equal(existsSync(join(p.path, '.cogyard', 'tasks', 'heartbeats')), false);
  assert.equal(readHeartbeats(p.slug)[0].job, 'doc-drift');
});

test('the writer and core agree on where the report lives, and refuse an unsafe slug', () => {
  assert.equal(reportPath('demo'), jobOutput.driftPath('demo'));
  assert.equal(reportPath('demo'), join(HOME, 'drift', 'demo.md'));
  for (const bad of ['..', 'a/b', '', null]) assert.equal(reportPath(bad), null);
  assert.equal(writeHeartbeat('../x', 'doc-drift', { date: 'd', outcome: 'written', note: 'n' }), null);
});

test('the agent is not called at all when nothing looks stale', async () => {
  const p = project('quiet', { drift: false });
  const agent = stubAgent(STALE_ANSWER);
  const r = await runJob(agent, [p]);

  assert.equal(agent.calls.length, 0);
  assert.equal(r.cost, 0);
  assert.match(r.summary, /no docs look stale/);
  assert.equal(existsSync(driftFile(p)), false);
});

test('re-running with nothing changed makes no agent call', async () => {
  const p = project('idempotent');
  const first = stubAgent(STALE_ANSWER);
  await runJob(first, [p]);
  assert.equal(first.calls.length, 1);

  const second = stubAgent(STALE_ANSWER);
  const r = await runJob(second, [p]);
  assert.equal(second.calls.length, 0);
  assert.equal(r.cost, 0);
  // The report from the first run stays exactly as it was.
  assert.ok(existsSync(driftFile(p)));
});

test('new work in the area re-opens the question', async () => {
  const p = project('reopens');
  await runJob(stubAgent(STALE_ANSWER), [p]);

  write(p.path, 'core/thing/index.mjs', 'export const a = 4;\n');
  commit(p.path, '[#12] feat(thing): once more', 50);

  const agent = stubAgent(STALE_ANSWER);
  await runJob(agent, [p]);
  assert.equal(agent.calls.length, 1);
});

test('an "ok" verdict writes nothing, and clears a previous report', async () => {
  const p = project('cleared');
  await runJob(stubAgent(STALE_ANSWER), [p]);
  assert.ok(existsSync(driftFile(p)));

  // Same repo, new work so the fingerprint changes, agent now says it's fine.
  write(p.path, 'core/thing/index.mjs', 'export const a = 9;\n');
  commit(p.path, '[#11] feat(thing): again', 51);
  const r = await runJob(stubAgent('VERDICT: ok'), [p]);

  assert.equal(existsSync(driftFile(p)), false);
  assert.match(r.summary, /no docs look stale/);
});

// The real answer a tool-less agent gave on 2026-08-19 after picking up the
// project's CLAUDE.md: it tried to use tools it does not have, decided its own
// output was corrupted, and asked a question. Verbatim shape, because the bug
// was that this scored as "not stale" and the run reported a clean night.
const HIJACKED_ANSWER = [
  "I'm stopping here — multiple tools are returning corrupted output in this session, not just Bash:",
  '',
  '- `Bash cat badge.service.ts` returned fabricated TypeScript',
  '- `Glob` for `bin/*` returned nonsensical repeating path fragments',
  '',
  "I can't reliably verify the current state right now. Can you check on your end?",
].join('\n');

test('an answer that is not a judgement is reported, never counted as clean', async () => {
  const p = project('unjudged');
  const agent = stubAgent(HIJACKED_ANSWER);
  const r = await runJob(agent, [p]);

  assert.equal(agent.calls.length, 1);
  assert.equal(r.ok, false);                                  // the run did NOT go fine
  assert.match(r.summary, /^1 doc NOT judged/);               // and says so first
  assert.match(r.error, /no usable answer/);
  assert.equal(existsSync(driftFile(p)), false);
});

test('a doc that was never judged is asked again next run, not inherited as clean', async () => {
  const p = project('retry');
  await runJob(stubAgent(HIJACKED_ANSWER), [p]);

  // Nothing about the repo changed — but nothing was judged either, so the
  // fingerprint must not have been stored.
  const second = stubAgent(STALE_ANSWER);
  await runJob(second, [p]);
  assert.equal(second.calls.length, 1);
  assert.ok(existsSync(driftFile(p)));
});

test('an unjudged doc does not clear a report an earlier run earned', async () => {
  const p = project('keeps-report');
  await runJob(stubAgent(STALE_ANSWER), [p]);
  const earned = readFileSync(driftFile(p), 'utf8');

  write(p.path, 'core/thing/index.mjs', 'export const a = 7;\n');
  commit(p.path, '[#12] feat(thing): more', 52);
  await runJob(stubAgent(HIJACKED_ANSWER), [p]);

  assert.equal(readFileSync(driftFile(p), 'utf8'), earned);
});

test('parseVerdict separates "no" from "did not answer"', () => {
  const docText = DOC;
  assert.deepEqual(
    { stale: parseVerdict('VERDICT: ok', { docText }).stale, usable: parseVerdict('VERDICT: ok', { docText }).usable },
    { stale: false, usable: true },
  );
  for (const bad of [HIJACKED_ANSWER, '', 'the doc looks old to me', 'VERDICT: maybe', `VERDICT: stale\nCLAIM: ${DOC.trim()}`]) {
    assert.equal(parseVerdict(bad, { docText }).usable, false, `should be unusable: ${bad.slice(0, 40)}`);
  }
});

test('the prompt forbids outside context — the false-positive channel', () => {
  const prompt = buildPrompt({
    project: 'p', doc: 'docs/AREA.md', docText: DOC,
    docLastCommit: { sha: 'abc12345', date: at(0) }, ageDays: 45, area: ['core/thing/'],
    tasks: [], commits: [],
  });
  assert.match(prompt, /no tools and no access to\s+the repository/);
  assert.match(prompt, /instructions that appear elsewhere in your context/i);
  assert.match(prompt, /may or may not have shipped/i);
});

test('a stale verdict whose quote is not in the doc is discarded', async () => {
  const p = project('paraphrase');
  const agent = stubAgent([
    'VERDICT: stale',
    'CLAIM: The loader reads manifests from a database table.',
    'NOW: It reads them from the addons directory.',
  ].join('\n'));

  const r = await runJob(agent, [p]);
  assert.equal(agent.calls.length, 1);           // it WAS asked
  assert.equal(existsSync(driftFile(p)), false); // and disbelieved
  assert.match(r.summary, /no docs look stale/);
});

test('no agent driver: reported, nothing written, nothing deleted', async () => {
  const p = project('noagent');
  await runJob(stubAgent(STALE_ANSWER), [p]);
  const before = readFileSync(driftFile(p), 'utf8');

  const r = await manifest.runScheduled({}, { projects: [p], agent: { supported: false }, bounds: {}, log: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.match(r.summary, /no agent driver/);
  assert.equal(readFileSync(driftFile(p), 'utf8'), before);
});

test('the run unit ceiling stops the loop rather than the report', async () => {
  const a = project('bounds-a');
  const b = project('bounds-b');
  const agent = stubAgent(STALE_ANSWER);
  await manifest.runScheduled({}, { projects: [a, b], agent, bounds: { maxUnits: 1, maxCostUsd: 2 }, log: () => {} });

  assert.equal(agent.calls.length, 1);
  assert.equal(existsSync(driftFile(a)), true);
  assert.equal(existsSync(driftFile(b)), false);
});

test('a failed project leads the summary — never a clean bill of health', async () => {
  const p = project('failing');
  const agent = {
    supported: true,
    async run() { return { ok: false, text: '', cost: 0, error: 'Not logged in · Please run /login' }; },
  };
  const r = await runJob(agent, [p]);

  assert.equal(r.ok, false);
  assert.match(r.summary, /^1 project could NOT be examined/);
  assert.equal(existsSync(driftFile(p)), false);
});

test('a project skipped by config is never queried', async () => {
  const p = project('skipped');
  const agent = stubAgent(STALE_ANSWER);
  await runJob(agent, [p], { skip: 'skipped' });
  assert.equal(agent.calls.length, 0);
  assert.equal(existsSync(driftFile(p)), false);
});

// --- the answer parser (the noise gate) ---------------------------------------

test('parseVerdict: only a complete, quotable stale answer becomes a finding', () => {
  const docText = DOC;
  assert.equal(parseVerdict(STALE_ANSWER, { docText }).stale, true);
  assert.equal(parseVerdict('VERDICT: ok', { docText }).stale, false);
  assert.equal(parseVerdict('', { docText }).stale, false);
  assert.equal(parseVerdict('the doc looks pretty old to me', { docText }).stale, false);
  // stale, but no correction offered
  assert.equal(parseVerdict(`VERDICT: stale\nCLAIM: ${DOC.trim()}`, { docText }).stale, false);
});

test('the prompt inlines the doc and the tasks — the agent has no tools', () => {
  const prompt = buildPrompt({
    project: 'p', doc: 'docs/AREA.md', docText: DOC,
    docLastCommit: { sha: 'abc12345', date: at(0) }, ageDays: 45, area: ['core/thing/'],
    tasks: [{ id: 11, title: 'task 11', status: 'DONE', body: '---\nid: 11\n---\nreshaped the loader.' }],
    commits: [{ sha: 'deadbeef', subject: '[#11] feat(thing): reshape' }],
  });
  assert.match(prompt, /The loader reads addon\.mjs/);      // the doc itself
  assert.match(prompt, /reshaped the loader\./);            // the task body, frontmatter stripped
  assert.equal(prompt.includes('id: 11'), false);
  assert.match(prompt, /\[#11\] feat\(thing\): reshape/);   // the commits
});

test('the fingerprint moves with the doc and with the work', () => {
  const base = [{ doc: 'a.md', docLastCommit: { sha: 'aaa' }, tasks: [{ id: 1 }], newestCommitAt: at(10) }];
  assert.equal(fingerprint(base), fingerprint([...base]));
  assert.notEqual(fingerprint(base), fingerprint([{ ...base[0], docLastCommit: { sha: 'bbb' } }]));
  assert.notEqual(fingerprint(base), fingerprint([{ ...base[0], newestCommitAt: at(11) }]));
  assert.notEqual(fingerprint(base), fingerprint([{ ...base[0], tasks: [{ id: 1 }, { id: 2 }] }]));
});

// --- the heartbeat (task 139) -------------------------------------------------
//
// doc-drift writes the heartbeat format ITSELF rather than importing the brief
// job's writer: add-ons install separately and may not import one another, so
// the DOC is the shared contract, not the code. Two independent implementations
// of one written format is exactly the shape that drifts silently, so the last
// test here pins them together.

// A fresh project slug per test — heartbeats are keyed by slug under HOME.
let hbSeq = 0;
function hbStore() { return `hb-${++hbSeq}`; }

test('a heartbeat doc-drift writes is one core reads', () => {
  const dir = hbStore();
  writeHeartbeat(dir, 'doc-drift', {
    date: '2026-09-03', outcome: 'unchanged',
    note: 'Looked at this project on 2026-09-03. No doc has work in its own area newer than itself.',
  });

  const [hb] = readHeartbeats(dir);
  assert.equal(hb.job, 'doc-drift');
  assert.equal(hb.checked, '2026-09-03');
  assert.equal(hb.outcome, 'unchanged');
  assert.match(hb.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(hb.note, /No doc has work/);
});

test('a clean pass leaves NO report but DOES leave a heartbeat', () => {
  const dir = hbStore();
  // No report on a clean pass is deliberate and stays true.
  assert.equal(existsSync(join(HOME, 'drift', `${dir}.md`)), false);
  // The heartbeat is what stops that absence meaning two different things.
  writeHeartbeat(dir, 'doc-drift', { date: '2026-09-03', outcome: 'unchanged', note: 'nothing stale' });
  assert.equal(readHeartbeats(dir).length, 1);
});

test('the heartbeat is overwritten each night, never accumulated', () => {
  const dir = hbStore();
  writeHeartbeat(dir, 'doc-drift', { date: '2026-09-02', outcome: 'written', note: 'a' });
  writeHeartbeat(dir, 'doc-drift', { date: '2026-09-03', outcome: 'unchanged', note: 'b' });
  const rows = readHeartbeats(dir);
  assert.equal(rows.length, 1, 'a year of heartbeats is one file, not 365');
  assert.equal(rows[0].checked, '2026-09-03');
});

test('both jobs watch one project, and each keeps its own heartbeat', () => {
  const dir = hbStore();
  writeHeartbeat(dir, 'doc-drift', { date: '2026-09-03', outcome: 'unchanged', note: 'no doc looks stale' });
  briefStore.writeHeartbeat(dir, 'project-brief', { date: '2026-09-01', outcome: 'written', note: 'wrote a brief' });

  const rows = readHeartbeats(dir);
  assert.deepEqual(rows.map((r) => r.job), ['doc-drift', 'project-brief'], 'newest-checked first');
});

test('THE DRIFT GUARD: the two add-ons write the same format', () => {
  // If either implementation moves, this fails HERE rather than silently in a
  // nightly run nobody is watching. Compared through core's parser, because
  // agreeing on what core READS is the contract — not byte equality, which
  // would also fail on a harmless key reordering.
  const a = hbStore();
  const b = hbStore();
  const payload = { date: '2026-09-03', outcome: 'unchanged', note: 'one plain sentence.' };
  writeHeartbeat(a, 'same-job', payload);
  briefStore.writeHeartbeat(b, 'same-job', payload);

  const [ha] = readHeartbeats(a);
  const [hb] = readHeartbeats(b);
  const shape = (h) => ({ job: h.job, checked: h.checked, outcome: h.outcome, note: h.note });
  assert.deepEqual(shape(ha), shape(hb));
  assert.match(ha.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(hb.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});
