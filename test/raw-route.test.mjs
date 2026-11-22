// test/raw-route.test.mjs — GET /api/raw/<key>/<slug>/<worktree>/<path> (task
// 262): serves a worktree file's bytes with the sandbox header on every
// response, keeps the path inside the worktree, refuses an address without the
// server's key (what keeps other websites from pulling files in), hands the key
// out at /api/raw-key, and inlines a Babel `src` script so a page built that
// way renders without CORS.
//
// COGYARD_HOME points at a throwaway dir BEFORE core is imported, so the
// registry and the project are scratch ones.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-raw-home-')));
process.env.COGYARD_HOME = HOME;
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-raw-proj-')));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-raw-outside-')));
execFileSync('git', ['init', '-q', PROJ]);
mkdirSync(join(PROJ, '.cogyard', 'tasks'), { recursive: true }); // what makes it a registered project
mkdirSync(join(PROJ, 'docs', 'site'), { recursive: true });
writeFileSync(join(PROJ, 'docs', 'site', 'styles.css'), 'body { color: red }\n');
writeFileSync(join(PROJ, 'docs', 'site', 'ui.jsx'), 'const App = () => <p>hi</p>; // </script> inside\n');
const PAGE = '<!doctype html><link rel="stylesheet" href="styles.css">'
  + '<script type="text/babel" src="ui.jsx"></script>'
  + '<script type="text/babel" src="https://cdn.example/x.jsx"></script>'
  + '<script type="text/babel" src="../../../escape.jsx"></script>'
  + '<script src="plain.js"></script>';
writeFileSync(join(PROJ, 'docs', 'site', 'index.html'), PAGE);
writeFileSync(join(OUTSIDE, 'secret.txt'), 'outside\n');
symlinkSync(join(OUTSIDE, 'secret.txt'), join(PROJ, 'docs', 'link.txt'));
writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'team/raw', label: 'raw', path: PROJ }]));
after(() => {
  for (const d of [HOME, PROJ, OUTSIDE]) rmSync(d, { recursive: true, force: true });
});

const core = await import('../core/index.mjs');
const route = await import('../server/routes/files.mjs');
const MAIN = basename(PROJ);
const SLUG = encodeURIComponent('team/raw');

function fakeRes() {
  const r = { code: null, headers: {}, body: null };
  r.writeHead = (code, headers = {}) => { r.code = code; r.headers = headers; };
  r.end = (b) => { r.body = Buffer.isBuffer(b) ? b.toString('utf8') : JSON.parse(b); };
  return r;
}
async function get(path, headers = {}) {
  const res = fakeRes();
  const handled = await route.handleRaw(path.split('?')[0], new URL(path, 'http://x'), { headers }, core.discoverProjects(), res);
  return { handled, ...res };
}
const KEY = route.rawKey();
const url = (rel, wt = MAIN, key = KEY) => `/api/raw/${key}/${SLUG}/${encodeURIComponent(wt)}/${rel}`;

test('/api/raw-key hands out the key, not cached', async () => {
  const res = fakeRes();
  assert.equal(await route.handleRaw('/api/raw-key', new URL('http://x/api/raw-key'), { headers: {} }, [], res), true);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { key: KEY });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok(KEY.length >= 20);
});

test('other paths are not this route', async () => {
  const r = await get('/api/file');
  assert.equal(r.handled, false);
});

test('serves a file with its type and the sandbox header', async () => {
  const r = await get(url('docs/site/styles.css'));
  assert.equal(r.code, 200);
  assert.equal(r.body, 'body { color: red }\n');
  assert.equal(r.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal(r.headers['Content-Security-Policy'], 'sandbox allow-scripts');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(r.headers['Content-Security-Policy'], /allow-same-origin/);
});

test('?scripts=0 makes the sandbox stricter (no allow-scripts); nothing makes it looser', async () => {
  const off = await get(url('docs/site/index.html') + '?scripts=0');
  assert.equal(off.code, 200);
  assert.equal(off.headers['Content-Security-Policy'], 'sandbox');
  const other = await get(url('docs/site/index.html') + '?scripts=1&sandbox=allow-same-origin');
  assert.equal(other.headers['Content-Security-Policy'], 'sandbox allow-scripts');
});

test('the main checkout is reachable by an empty worktree name too', async () => {
  const r = await get(url('docs/site/styles.css', ''));
  assert.equal(r.code, 200);
});

test('an HTML page gets its relative Babel src inlined, and nothing else changes', async () => {
  const r = await get(url('docs/site/index.html'));
  assert.equal(r.code, 200);
  assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(r.body, /<script type="text\/babel" data-inlined-from="ui.jsx">\nconst App = \(\) => <p>hi<\/p>; \/\/ <\\\/script> inside\n\n<\/script>/);
  // A CDN src and one that climbs out of the worktree are left as they were.
  assert.ok(r.body.includes('<script type="text/babel" src="https://cdn.example/x.jsx"></script>'));
  assert.ok(r.body.includes('<script type="text/babel" src="../../../escape.jsx"></script>'));
  // A plain script tag and the stylesheet link are untouched.
  assert.ok(r.body.includes('<script src="plain.js"></script>'));
  assert.ok(r.body.includes('<link rel="stylesheet" href="styles.css">'));
  // The file on disk is never changed.
  assert.equal(readFileSync(join(PROJ, 'docs', 'site', 'index.html'), 'utf8'), PAGE);
});

test('refuses a path that climbs out, a symlink that escapes, and bad names', async () => {
  assert.equal((await get(url('docs/../../x'))).code, 400);
  assert.equal((await get(url('docs/link.txt'))).code, 403);
  assert.equal((await get(url('docs/nope.css'))).code, 404);
  assert.equal((await get(url('docs/site'))).code, 404);
  assert.equal((await get(`/api/raw/${KEY}/nope/${MAIN}/a.css`)).code, 404);
  assert.equal((await get(url('a.css', 'no-such-wt'))).code, 404);
  assert.equal((await get(url('a.css', '../x'))).code, 400);
  assert.equal((await get(`/api/raw/${KEY}/${SLUG}`)).code, 400);
  assert.equal((await get('/api/raw/%E0%A4%A/x/y/z')).code, 400);
});

test('an address without the right key is refused before anything is read', async () => {
  assert.equal((await get(`/api/raw/${SLUG}/${MAIN}/docs/site/styles.css`)).code, 403);
  assert.equal((await get(url('docs/site/styles.css', MAIN, 'x'.repeat(KEY.length)))).code, 403);
  assert.equal((await get(url('docs/site/styles.css', MAIN, KEY.slice(1)))).code, 403);
  assert.equal((await get(url('docs/site/styles.css', MAIN, ''))).code, 403);
});
