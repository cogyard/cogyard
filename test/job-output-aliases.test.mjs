// test/job-output-aliases.test.mjs — a project whose slug changed keeps its
// nightly-job output (task 195).
//
// Job output lives under $COGYARD_HOME by registry slug (task 187). A project
// re-registered under a new slug keeps its old checkout paths as `aliases`, and
// each alias's slug is where the output written before the move still sits. The
// readers follow those old slugs; the writers keep writing only under the
// current one. The setup: project `earth`, once registered at `mars`, with a
// brief, a heartbeat and a drift report all under `mars`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-job-aliases-'));
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = HOME;

// A registered project with a task store, so discoverProjects() lists it.
function makeProject(slug, aliases = []) {
  const repo = join(HOME, slug);
  mkdirSync(join(repo, '.cogyard', 'tasks'), { recursive: true });
  return { slug, path: repo, label: slug, ...(aliases.length ? { aliases: aliases.map((a) => join(HOME, a)) } : {}) };
}
const EARTH = makeProject('earth', ['mars']);
const VENUS = makeProject('venus', ['pluto']);
writeFileSync(join(HOME, 'projects.json'), JSON.stringify([EARTH, VENUS], null, 2));

const put = (rel, text) => {
  const p = join(HOME, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const brief = (date, para, extra = '') => `---\ndate: ${date}\nstatus: ok\n${extra}---\n\n# earth\n\n${para}\n`;
const heartbeat = (job, date) => `---\njob: ${job}\nchecked: ${date}\noutcome: written\n---\n\nLooked on ${date}.\n`;

put('briefs/mars/2026-09-01.md', brief('2026-09-01', 'Written while the checkout was mars.'));
put('briefs/mars/2026-09-02.md', brief('2026-09-02', 'The last brief before the move.'));
put('heartbeats/mars/project-brief.md', heartbeat('project-brief', '2026-09-02'));
const MARS_DRIFT = put('drift/mars.md', '---\nfindings: 1\nexamined: 3\n---\n\n# Doc drift — mars\n\nOne finding.\n');

const core = await import('../core/index.mjs');
const project = await import('../server/routes/project.mjs');
const store = await import('../extras/addons/project-brief/store.mjs');

test.after(() => rmSync(HOME, { recursive: true, force: true }));

async function daily(slug) {
  const proj = core.discoverProjects().find((p) => p.slug === slug);
  const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body = b ?? ''; } };
  await project.handle('/api/daily', new URL(`http://localhost/api/daily?p=${slug}`), proj, res);
  assert.equal(res.code, 200, res.body);
  return JSON.parse(res.body);
}

test('the Daily answer shows the briefs, heartbeat and drift report kept under an old slug', async () => {
  const d = await daily('earth');
  assert.deepEqual(d.briefs.map((b) => b.date), ['2026-09-02', '2026-09-01']);
  assert.deepEqual(d.heartbeats.map((h) => [h.job, h.checked]), [['project-brief', '2026-09-02']]);
  assert.equal(d.drift?.findings, 1);
  assert.equal(core.briefCount('earth'), 2);
  assert.equal(core.hasDrift('earth'), true);
  assert.equal(core.briefSummary('earth')?.lead, 'The last brief before the move.');
});

test('a scheduled job is handed each project\'s former slugs', () => {
  const rows = core.discoverProjects();
  assert.deepEqual(core.formerSlugs(rows.find((p) => p.slug === 'earth')), ['mars']);
  assert.deepEqual(core.formerSlugs({ slug: 'x', path: join(HOME, 'x') }), []);
});

test('the brief job finds its previous brief under the old slug, so the move does not buy a "first" brief', () => {
  assert.equal(store.newestBrief('earth', ['mars'])?.meta.date, '2026-09-02');
  assert.equal(store.lastGoodBrief('earth', ['mars'])?.meta.date, '2026-09-02');
  assert.equal(store.consecutiveFailures('earth', ['mars']), 0);
  // Without the former slugs it finds nothing — the bug.
  assert.equal(store.newestBrief('earth'), null);
});

test('carrying an old-slug brief forward writes under the current slug and leaves the old file alone', () => {
  const old = join(HOME, 'briefs', 'mars', '2026-09-02.md');
  const before = readFileSync(old, 'utf8');
  const file = store.carryForward('earth', '2026-09-05', ['mars']);
  assert.equal(file, join(HOME, 'briefs', 'earth', '2026-09-02.md'));
  assert.equal(readFileSync(old, 'utf8'), before);
  // The stamped copy is the one read back, once, not beside the original.
  const b = core.newestBrief('earth');
  assert.equal(b.date, '2026-09-02');
  assert.equal(b.carriedThrough, '2026-09-05');
  assert.equal(core.briefCount('earth'), 2);
});

test('output under the current slug wins over the same file under an old one', async () => {
  put('briefs/earth/2026-09-03.md', brief('2026-09-03', 'The first brief after the move.'));
  put('heartbeats/earth/project-brief.md', heartbeat('project-brief', '2026-09-03'));
  const d = await daily('earth');
  assert.deepEqual(d.briefs.map((b) => b.date), ['2026-09-03', '2026-09-02', '2026-09-01']);
  assert.deepEqual(d.heartbeats.map((h) => [h.job, h.checked]), [['project-brief', '2026-09-03']]);
});

test('an old slug\'s drift report stops counting once a job has looked under the current slug', async () => {
  // earth now has a heartbeat of its own (previous test): a job has looked
  // since the move, and a doc-drift run under the new slug removes only
  // drift/earth.md — so mars.md must not keep reading as a live finding.
  assert.equal((await daily('earth')).drift, null);
  assert.equal(core.hasDrift('earth'), false);
  assert.ok(existsSync(MARS_DRIFT), 'the old report is not deleted, only no longer read');
  // A report under the current slug is read as always.
  put('drift/earth.md', '---\nfindings: 2\n---\n\n# Doc drift — earth\n');
  assert.equal((await daily('earth')).drift?.findings, 2);
});

test('a slug that is only another project\'s alias reads nothing of that project', async () => {
  put('briefs/pluto/2026-09-01.md', brief('2026-09-01', 'venus, back when it was pluto.'));
  assert.deepEqual((await daily('earth')).briefs.map((b) => b.lead).filter((l) => /pluto/.test(l)), []);
  assert.equal(core.briefCount('venus'), 1);
});
