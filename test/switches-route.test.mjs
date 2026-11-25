// test/switches-route.test.mjs — GET/POST /api/switches (task 246): reads the
// resolved switches, saves valid ones into the project's task store, refuses
// invalid ones with each reason and writes nothing, refuses a cross-origin
// POST, and 404s an unknown project.
//
// COGYARD_HOME points at a throwaway dir BEFORE core is imported, so the
// registry and the project are scratch ones.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-swroute-home-')));
process.env.COGYARD_HOME = HOME;
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-swroute-proj-')));
mkdirSync(join(PROJ, '.cogyard', 'tasks'), { recursive: true });
writeFileSync(join(PROJ, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'swr', label: 'swr', path: PROJ }]));
after(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(PROJ, { recursive: true, force: true }); });

const core = await import('../core/index.mjs');
const route = await import('../server/routes/switches.mjs');
const FILE = join(PROJ, '.cogyard', 'tasks', 'switches.json');

function fakeRes() {
  const r = { code: null, body: null };
  r.writeHead = (code) => { r.code = code; };
  r.end = (s) => { r.body = JSON.parse(s); };
  return r;
}
async function get(slug) {
  const res = fakeRes();
  await route.handle('/api/switches', new URL(`http://x/api/switches?p=${slug}`), [], res);
  return res;
}
async function post(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.headers = headers;
  const res = fakeRes();
  await route.handlePost('/api/switches', req, res);
  return res;
}

test('the registry fixture resolves to the scratch project', () => {
  assert.ok(core.discoverProjects().some((p) => p.slug === 'swr'));
});

test('GET with no file: every switch at its default, nothing stored, no problems', async () => {
  const r = await get('swr');
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, {
    slug: 'swr',
    switches: {
      rebase: { value: 'always', set: false },
      version: { value: 'minor', set: false, file: 'package.json' },
      decisions_log: { value: null, set: false },
    },
    stored: {},
    defaults: { rebase: 'always', version: 'minor', decisions_log: null },
    problems: [],
  });
});

test('POST keeps the decisions_log switch beside the others, and null turns it off', async () => {
  const r = await post({ slug: 'swr', switches: { rebase: 'ask', version: 'off', decisions_log: 'docs/DECISIONS.md' } });
  assert.equal(r.code, 200);
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), { rebase: 'ask', version: 'off', decisions_log: 'docs/DECISIONS.md' });
  assert.deepEqual(r.body.switches.decisions_log, { value: 'docs/DECISIONS.md', set: true });
  assert.equal((await post({ slug: 'swr', switches: { decisions_log: '../x.md' } })).code, 400);
  const off = await post({ slug: 'swr', switches: { rebase: 'ask', version: 'off', decisions_log: null } });
  assert.deepEqual(off.body.switches.decisions_log, { value: null, set: false });
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), { rebase: 'ask', version: 'off' });
});

test('POST saves into the task store; GET reads it back as set', async () => {
  const r = await post({ slug: 'swr', switches: { rebase: 'ask', version: 'off' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')), { rebase: 'ask', version: 'off' });
  const g = await get('swr');
  assert.deepEqual(g.body.switches.rebase, { value: 'ask', set: true });
  assert.deepEqual(g.body.switches.version, { value: 'off', set: true, file: null });
  assert.deepEqual(g.body.stored, { rebase: 'ask', version: 'off' });
});

test('POST with an invalid value: 400 with each reason, file unchanged', async () => {
  const before = readFileSync(FILE, 'utf8');
  const r = await post({ slug: 'swr', switches: { rebase: 'never', version: { command: 'x' } } });
  assert.equal(r.code, 400);
  assert.equal(r.body.errors.length, 2);
  assert.equal(readFileSync(FILE, 'utf8'), before);
});

test('POST from another site is refused; unknown project is 404', async () => {
  const r = await post({ slug: 'swr', switches: { rebase: 'always' } }, { origin: 'https://evil.example' });
  assert.equal(r.code, 403);
  assert.equal((await post({ slug: 'nope', switches: {} })).code, 404);
  assert.equal((await get('nope')).code, 404);
});

test('POST with nothing set writes {} — every switch back to its default', async () => {
  const r = await post({ slug: 'swr', switches: { rebase: null } });
  assert.equal(r.code, 200);
  assert.ok(existsSync(FILE));
  assert.deepEqual(r.body.switches.rebase, { value: 'always', set: false });
});
