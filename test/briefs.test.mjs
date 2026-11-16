// test/briefs.test.mjs — the brief FILE FORMAT, which is a contract between two
// pieces of code that never import each other:
//
//   WRITER — extras/addons/project-brief/store.mjs (an add-on, installed outside
//            the repo at ~/.cogyard/addons/, and deliberately standalone: its
//            status() is called synchronously by the loader, so it cannot reach
//            core through an async import).
//   READER — core/briefs.mjs (the portal, which renders whatever is there and
//            nothing when there isn't).
//
// Two parsers for one format is exactly the shape that silently drifts, so these
// tests drive the real writer and assert the real reader agrees. If someone adds
// a field to one side, this file is what fails.
//
// Also covers the reader's degradation: no briefs dir, an unsafe slug, a junk
// file — all of which must produce null rather than an exception, because the
// portal calls this on every project on every poll.
//
// Since task 187 both sides place files under $COGYARD_HOME by project slug
// (core/job-output.mjs; the add-on spells the same layout itself), so HOME is a
// throwaway dir set BEFORE either module loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-brief-home-'));
process.env.COGYARD_HOME = HOME;

const jobOutput = await import('../core/job-output.mjs');
const { newestBrief, briefSummary, listBriefFiles, leadParagraph, readHeartbeats } = await import('../core/briefs.mjs');
const store = await import('../extras/addons/project-brief/store.mjs');
const { writtenBrief, failedBrief } = await import('../extras/addons/project-brief/render.mjs');
const { parseProse, MIN_PROSE_CHARS } = await import('../extras/addons/project-brief/prompt.mjs');
const { commitsSince } = await import('../extras/addons/project-brief/inputs.mjs');

const PARA = 'word '.repeat(40).trim();
const THREE = [PARA, PARA, PARA].join('\n\n');

// A fresh project SLUG per test — the files are keyed by slug, not by checkout.
let seq = 0;
function project() { return `demo-${++seq}`; }

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test('a project with no briefs reads as no brief, not an error', () => {
  const dir = project();
  assert.equal(newestBrief(dir), null);
  assert.equal(briefSummary(dir), null);
  assert.deepEqual(listBriefFiles(dir), []);
});

test('the writer and the reader place files at the same paths, under HOME', () => {
  assert.equal(store.briefsDir('demo'), jobOutput.briefsDir('demo'));
  assert.equal(store.heartbeatsDir('demo'), jobOutput.heartbeatsDir('demo'));
  assert.equal(jobOutput.briefsDir('demo'), join(HOME, 'briefs', 'demo'));
  assert.equal(jobOutput.heartbeatsDir('demo'), join(HOME, 'heartbeats', 'demo'));
  // Written where it is read, and nowhere near a task store.
  const file = store.writeBrief('demo', '2026-08-14', { meta: { date: '2026-08-14', status: 'ok' }, body: '# t\n\nHere.' });
  assert.equal(file, join(HOME, 'briefs', 'demo', '2026-08-14.md'));
  assert.equal(newestBrief('demo').lead, 'Here.');
});

test('a slug that could climb out of HOME is refused on both sides', () => {
  for (const bad of ['..', '.', 'a/b', '../x', '', null]) {
    assert.equal(jobOutput.briefsDir(bad), null, `core briefsDir(${bad})`);
    assert.equal(jobOutput.heartbeatsDir(bad), null, `core heartbeatsDir(${bad})`);
    assert.equal(jobOutput.driftPath(bad), null, `core driftPath(${bad})`);
    assert.equal(store.briefsDir(bad), null, `add-on briefsDir(${bad})`);
    assert.deepEqual(listBriefFiles(bad), []);
    assert.deepEqual(readHeartbeats(bad), []);
  }
  assert.throws(() => store.writeBrief('../x', '2026-08-14', { meta: {}, body: '' }), /not a usable project slug/);
  assert.equal(store.writeHeartbeat('../x', 'project-brief', { date: 'd', outcome: 'written', note: 'n' }), null);
});

test('what the add-on writes is what core reads — written brief', () => {
  const dir = project();
  store.writeBrief(dir, '2026-08-14', {
    meta: {
      date: '2026-08-14', project: 'demo', status: 'ok', head: 'abc1234',
      generated_at: '2026-08-14T05:00:12.000Z', cost_usd: 0.0413, model: 'claude-opus-5',
    },
    body: writtenBrief({
      project: 'demo', date: '2026-08-14',
      prose: 'The importer landed.\n\nIt is half migrated.\n\nNext is the backfill.',
      detail: '**Commits (1)**\n\n- abc1234 seed', cost: 0.0413, model: 'claude-opus-5',
    }),
  });

  const b = newestBrief(dir);
  assert.equal(b.date, '2026-08-14');
  assert.equal(b.status, 'ok');
  assert.equal(b.cost, 0.0413);
  assert.equal(b.model, 'claude-opus-5');
  assert.equal(b.failures, 0);
  assert.equal(b.error, null);
  // The lead is the first PARAGRAPH, not the file's H1.
  assert.equal(b.lead, 'The importer landed.');
  assert.match(b.markdown, /# demo — 14 Aug 2026/);
  // The evidence block travels with the body — collapsed by the browser, not
  // stripped here, because it is what you open when the paragraph isn't enough.
  assert.match(b.markdown, /<details>/);
});

test('what the add-on writes is what core reads — failed brief, with its escalation', () => {
  const dir = project();
  store.writeBrief(dir, '2026-08-14', {
    meta: {
      date: '2026-08-14', project: 'demo', status: 'failed', generated_at: '2026-08-14T05:00:12.000Z',
      cost_usd: 0, failures: 3, error: JSON.stringify('Not logged in · Please run /login'), last_good: '2026-08-11',
    },
    body: failedBrief({ project: 'demo', date: '2026-08-14', error: 'Not logged in · Please run /login', nights: 3, lastGood: null }),
  });

  const b = newestBrief(dir);
  assert.equal(b.status, 'failed');
  assert.equal(b.failures, 3);
  assert.equal(b.error, 'Not logged in · Please run /login');
  assert.equal(b.lastGood, '2026-08-11');
});

test('the newest brief wins, and dates sort as dates', () => {
  const dir = project();
  for (const d of ['2026-08-09', '2026-08-14', '2026-08-11']) {
    store.writeBrief(dir, d, { meta: { date: d, status: 'ok' }, body: `# demo\n\n${d} paragraph.` });
  }
  assert.equal(newestBrief(dir).date, '2026-08-14');
  assert.equal(listBriefFiles(dir).length, 3);
});

test('a carry-forward stamp is readable as a date range, and never duplicates the file', () => {
  const dir = project();
  store.writeBrief(dir, '2026-08-09', { meta: { date: '2026-08-09', status: 'ok' }, body: '# demo\n\nQuiet since.' });
  store.carryForward(dir, '2026-08-14');
  store.carryForward(dir, '2026-08-14'); // idempotent — twice in one day changes nothing

  assert.equal(listBriefFiles(dir).length, 1);
  const b = newestBrief(dir);
  assert.equal(b.date, '2026-08-09');
  assert.equal(b.carriedThrough, '2026-08-14');
});

test('a junk file in the briefs dir is ignored, not parsed', () => {
  const dir = project();
  store.writeBrief(dir, '2026-08-14', { meta: { date: '2026-08-14', status: 'ok' }, body: '# demo\n\nReal.' });
  writeFileSync(join(HOME, 'briefs', dir, 'notes.md'), 'not a brief');
  writeFileSync(join(HOME, 'briefs', dir, '2026-8-1.md'), 'wrong shape');

  assert.equal(listBriefFiles(dir).length, 1);
  assert.equal(newestBrief(dir).lead, 'Real.');
});

test('leadParagraph skips the heading and a failed brief\'s alarm blockquote', () => {
  assert.equal(leadParagraph('# demo — 14 Aug\n\nFirst para.\n\nSecond.'), 'First para.');
  assert.equal(leadParagraph('# demo\n\n> ### No brief\n> why\n\nThe last one said this.'), 'The last one said this.');
  assert.equal(leadParagraph(''), '');
});

test('proseOf strips the heading, the evidence block and the cost footer', () => {
  const dir = project();
  store.writeBrief(dir, '2026-08-14', {
    meta: { date: '2026-08-14', status: 'ok' },
    body: writtenBrief({ project: 'demo', date: '2026-08-14', prose: 'One.\n\nTwo.\n\nThree.', detail: '- evidence', cost: 0.02, model: 'm' }),
  });
  const prose = store.proseOf(store.newestBrief(dir));
  assert.equal(prose, 'One.\n\nTwo.\n\nThree.');
  assert.doesNotMatch(prose, /details|Nightly brief|# demo/);
});

// --- the silence guarantee ---------------------------------------------------
// Most projects most nights produce nothing, and a night with nothing new must
// cost NOTHING. The bug this pins (caught in the sandbox 2026-08-19): an empty
// range is the ANSWER, not a failure — but it fell through to a
// `--since=<timestamp>` fallback, and git's `--since` is second-granular and
// inclusive, so the boundary commit came back. Every quiet night then looked
// like a night with a commit and paid for an agent call.
//
// The boundary is now the recorded FRONTIER (`sinceTips`) rather than a single
// sha — see brief-run.test.mjs for why one sha could not do the job.

test('a repo with no new commits since the last brief reports none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-brief-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one');
  git('add', '-A');
  git('commit', '-qm', 'first');
  const head = git('rev-parse', 'HEAD');

  // The boundary commit was made in this same second, which is exactly what
  // made the old fallback re-report it.
  assert.deepEqual(commitsSince(dir, { sinceTips: [head], sinceTime: new Date().toISOString() }), []);

  writeFileSync(join(dir, 'b.txt'), 'two');
  git('add', '-A');
  git('commit', '-qm', 'second');
  const after = commitsSince(dir, { sinceTips: [head], sinceTime: new Date().toISOString() });
  assert.equal(after.length, 1);
  assert.equal(after[0].subject, 'second');
  rmSync(dir, { recursive: true, force: true });
});

test('an unknown tip falls back to the timestamp instead of reporting nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-brief-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), 'one');
  git('add', '-A');
  git('commit', '-qm', 'rebased away');

  // A sha that never existed here — a rebased or pruned branch. The commit is
  // real news, so the timestamp path must still find it.
  const gone = '0'.repeat(40);
  const rows = commitsSince(dir, { sinceTips: [gone], sinceTime: '2000-01-01T00:00:00.000Z' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'rebased away');
  rmSync(dir, { recursive: true, force: true });
});

// --- an answer that is not a brief -------------------------------------------
// The lesson task 119 paid for on 2026-08-19: a tool-less agent picks up the
// machine's CLAUDE.md and obeys it, and what comes back can be a tool call, a
// question, or a confident invention. Scoring any of those as a result made a
// run that judged nothing look like a clean night — for real money. Here the
// equivalent mistake is worse: an unusable answer written up as a brief reads
// as TRUE. So it must never become one.

test('three paragraphs of prose are usable', () => {
  const r = parseProse(THREE);
  assert.equal(r.usable, true);
  assert.equal(r.prose, THREE);
});

test('a model that merges or splits one paragraph is still a brief', () => {
  assert.equal(parseProse([PARA, PARA].join('\n\n')).usable, true);
  assert.equal(parseProse([PARA, PARA, PARA, PARA].join('\n\n')).usable, true);
});

test('the sanctioned decline is read as a decline, not as a brief', () => {
  const r = parseProse('CANNOT BRIEF: the material carries no commits or sessions');
  assert.equal(r.usable, false);
  assert.match(r.reason, /declined: the material carries no commits/);
});

test('a tool call is never written up as a brief', () => {
  const r = parseProse('**Tool: read** {"file_path": "CLAUDE.md"}');
  assert.equal(r.usable, false);
  assert.match(r.reason, /tool call/);
});

test('asking for access or for more input is not a brief', () => {
  assert.match(parseProse(`I do not have access to the repository. ${PARA}`).reason, /could not access/);
  assert.match(parseProse(`Could you please provide the task files? ${PARA}`).reason, /asked for more input/);
});

test('a document or a list is not three paragraphs', () => {
  assert.match(parseProse(`## Status report\n\n${PARA}\n\n${PARA}`).reason, /list or a document/);
  assert.match(parseProse(`- one\n- two\n\n${PARA}\n\n${PARA}`).reason, /list or a document/);
  assert.match(parseProse([PARA, PARA, PARA, PARA, PARA].join('\n\n')).reason, /got 5/);
});

test('an answer too short to be three paragraphs is rejected', () => {
  assert.equal(parseProse('x'.repeat(MIN_PROSE_CHARS - 1)).usable, false);
  assert.equal(parseProse('').reason, 'the agent returned nothing');
});

test('the two failure kinds read differently, and core reports which', () => {
  const dir = project();
  const write = (kind, error) => store.writeBrief(dir, '2026-08-19', {
    meta: {
      date: '2026-08-19', project: 'demo', status: 'failed', failure_kind: kind,
      failures: 3, error: JSON.stringify(error),
    },
    body: failedBrief({ project: 'demo', date: '2026-08-19', error, nights: 3, kind, lastGood: null }),
  });

  write('error', 'Not logged in - please run login');
  let b = newestBrief(dir);
  assert.equal(b.failureKind, 'error');
  assert.match(b.markdown, /No brief could be written/);
  assert.match(b.markdown, /credential is dead/);

  write('unusable', 'the agent replied with a tool call');
  b = newestBrief(dir);
  assert.equal(b.failureKind, 'unusable');
  assert.match(b.markdown, /did not write a brief/);
  // The credential is the one thing NOT to send the owner to fix here.
  assert.doesNotMatch(b.markdown, /credential is dead|setup-token/);
});

test('an ok brief carries no failure kind', () => {
  const dir = project();
  store.writeBrief(dir, '2026-08-19', { meta: { date: '2026-08-19', status: 'ok' }, body: '# demo\n\nFine.' });
  assert.equal(newestBrief(dir).failureKind, null);
});

test('consecutiveFailures counts back from the newest and stops at the last good one', () => {
  const dir = project();
  const put = (d, status) => store.writeBrief(dir, d, { meta: { date: d, status }, body: `# demo\n\n${d}` });
  put('2026-08-10', 'ok');
  put('2026-08-11', 'failed');
  put('2026-08-12', 'failed');
  assert.equal(store.consecutiveFailures(dir), 2);
  assert.equal(store.lastGoodBrief(dir).meta.date, '2026-08-10');

  put('2026-08-13', 'ok');
  assert.equal(store.consecutiveFailures(dir), 0);
});

// --- heartbeats (task 134) ----------------------------------------------------
//
// Same two-parsers-one-format hazard as the brief above: the add-on's store.mjs
// writes, core/briefs.mjs reads, and neither imports the other. These drive the
// real writer and assert the real reader agrees.

test('what the add-on writes as a heartbeat is what core reads', () => {
  const dir = project();
  store.writeHeartbeat(dir, 'project-brief', {
    date: '2026-08-25', outcome: 'unchanged',
    note: 'Looked at this project on 2026-08-25. Nothing had happened since the last brief, so none was written.',
  });

  const [hb] = readHeartbeats(dir);
  assert.equal(hb.job, 'project-brief');
  assert.equal(hb.checked, '2026-08-25');
  assert.equal(hb.outcome, 'unchanged');
  assert.match(hb.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(hb.note, /Nothing had happened/);
});

test('a project nothing watches has no heartbeats — and that is not an alarm', () => {
  const dir = project();
  assert.deepEqual(readHeartbeats(dir), []);
});

test('a project no job has ever written for reads no heartbeats rather than throwing', () => {
  assert.deepEqual(readHeartbeats('never-registered'), []);
});

test('each job keeps its own heartbeat, newest-checked first', () => {
  const dir = project();
  store.writeHeartbeat(dir, 'project-brief', { date: '2026-08-25', outcome: 'unchanged', note: 'a' });
  store.writeHeartbeat(dir, 'doc-drift', { date: '2026-08-20', outcome: 'written', note: 'b' });

  const rows = readHeartbeats(dir);
  assert.deepEqual(rows.map((r) => r.job), ['project-brief', 'doc-drift']);
});

test('a heartbeat is overwritten, not accumulated — one file per job', () => {
  const dir = project();
  store.writeHeartbeat(dir, 'project-brief', { date: '2026-08-24', outcome: 'written', note: 'a' });
  store.writeHeartbeat(dir, 'project-brief', { date: '2026-08-25', outcome: 'unchanged', note: 'b' });

  const rows = readHeartbeats(dir);
  assert.equal(rows.length, 1, 'a year of heartbeats is one file, not 365');
  assert.equal(rows[0].checked, '2026-08-25');
});

test('a heartbeat is never mistaken for a brief', () => {
  const dir = project();
  store.writeHeartbeat(dir, 'project-brief', { date: '2026-08-25', outcome: 'unchanged', note: 'a' });
  assert.equal(newestBrief(dir), null, 'a heartbeat must not appear in the run of days you read back through');
  assert.deepEqual(listBriefFiles(dir), []);
});

test('junk in the heartbeats dir is ignored rather than guessed at', () => {
  const dir = project();
  store.writeHeartbeat(dir, 'project-brief', { date: '2026-08-25', outcome: 'unchanged', note: 'a' });
  const hbDir = join(HOME, 'heartbeats', dir);
  writeFileSync(join(hbDir, 'notes.txt'), 'not a heartbeat');
  writeFileSync(join(hbDir, 'README.md'), 'nor this');

  assert.deepEqual(readHeartbeats(dir).map((r) => r.job), ['project-brief']);
});
