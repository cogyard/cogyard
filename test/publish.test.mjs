// test/publish.test.mjs — the publish declaration and the checks a publish
// makes (task 170): reading .cogyard/publish.json, the code preflight, the
// health match, the tag, and the per-project lock.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-publish-home-')));
process.env.COGYARD_HOME = HOME;
const {
  readPublishConfig, publishPlan, publishPreflight, healthMatches, compareVersions,
  tagRelease, takePublishLock, prePushHook, publishInventory, resolvePublishProject,
  publishStatus, recordPublish,
} = await import('../core/publish.mjs');

const dirs = [HOME];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function tmp(prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function repo() {
  const d = tmp('cogyard-publish-');
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'T');
  return d;
}
let seq = 0;
function commit(d, version, msg = `v${version}`) {
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(d, 'change.txt'), String(++seq));
  git(d, 'add', 'package.json', 'change.txt');
  git(d, 'commit', '-q', '-m', msg);
  return git(d, 'rev-parse', 'HEAD');
}
// A project with a bare origin, main pushed.
function published(version = '1.0.0') {
  const origin = tmp('cogyard-origin-');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const d = repo();
  git(d, 'remote', 'add', 'origin', origin);
  const sha = commit(d, version);
  git(d, 'push', '-q', '-u', 'origin', 'main');
  return { d, origin, sha };
}
function declare(dir, body) {
  mkdirSync(join(dir, '.cogyard'), { recursive: true });
  writeFileSync(join(dir, '.cogyard', 'publish.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

// --- the declaration ------------------------------------------------------------

test('no file → undeclared, never a guess', () => {
  assert.deepEqual(readPublishConfig(repo()), { declared: false });
});

test('a full declaration reads back trimmed, tag on by default', () => {
  const d = repo();
  declare(d, { deploysOnPush: false, command: ' x ', manual: [' press Deploy '], health: 'https://a.example/health' });
  assert.deepEqual(readPublishConfig(d), {
    declared: true, deploysOnPush: false, command: 'x', manual: ['press Deploy'],
    health: 'https://a.example/health', tag: true, requires: [], checks: [],
  });
});

test('an unusable file is declared-with-an-error — including an unknown field', () => {
  const cases = [
    ['{nope', /not valid JSON/],
    ['[]', /JSON object/],
    [{ command: 'x' }, /deploysOnPush/],
    [{ deploysOnPush: 'no' }, /deploysOnPush/],
    [{ deploysOnPush: false, command: '' }, /"command" must be/],
    [{ deploysOnPush: false, manual: [] }, /"manual" must be/],
    [{ deploysOnPush: false, manual: ['ok', ' '] }, /"manual" must be/],
    [{ deploysOnPush: false, health: 'example.com/health' }, /http\(s\) URL/],
    [{ deploysOnPush: false, tag: 'yes' }, /"tag" must be/],
    [{ deploysOnPush: false, comand: 'x' }, /unknown field.*"comand"/],
    [{ deploysOnPush: false, how: 'prose' }, /unknown field.*"how"/],
    [{ deploysOnPush: false, requires: [] }, /"requires" must be/],
    [{ deploysOnPush: false, checks: [] }, /"checks" must be/],
    [{ deploysOnPush: false, checks: ['npm test', ''] }, /"checks" must be/],
    [{ deploysOnPush: false, requires: ['DO TOKEN'] }, /"requires" must be/],
  ];
  for (const [body, re] of cases) {
    const d = repo();
    declare(d, body);
    const r = readPublishConfig(d);
    assert.equal(r.declared, true, JSON.stringify(body));
    assert.match(r.error, re, JSON.stringify(body));
  }
});

test('publishPlan: needs a declared, off-push command or manual steps', () => {
  const base = { declared: true, deploysOnPush: false, command: null, manual: [] };
  assert.match(publishPlan({ declared: false }).reason, /has not declared/);
  assert.match(publishPlan({ declared: true, error: 'bad' }).reason, /bad/);
  assert.match(publishPlan({ ...base, deploysOnPush: true, command: 'x' }).reason, /every push/);
  assert.match(publishPlan(base).reason, /neither a "command" nor "manual"/);
  assert.equal(publishPlan({ ...base, command: 'x' }).ok, true);
  assert.equal(publishPlan({ ...base, manual: ['press Deploy'] }).ok, true);
});

test('publishPlan: a missing required credential is refused by name, before anything runs', () => {
  const base = { declared: true, deploysOnPush: false, command: 'x', manual: [] };
  delete process.env.COGYARD_TEST_PUBLISH_TOKEN;
  const r = publishPlan({ ...base, requires: ['COGYARD_TEST_PUBLISH_TOKEN'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing credential\(s\) COGYARD_TEST_PUBLISH_TOKEN\. Add COGYARD_TEST_PUBLISH_TOKEN to .*secrets\.env/);
  process.env.COGYARD_TEST_PUBLISH_TOKEN = 'set';
  try { assert.equal(publishPlan({ ...base, requires: ['COGYARD_TEST_PUBLISH_TOKEN'] }).ok, true); }
  finally { delete process.env.COGYARD_TEST_PUBLISH_TOKEN; }
});

// --- the code preflight -----------------------------------------------------------

test('preflight: the clean, pushed main commit and its new tag', () => {
  const { d, sha } = published('1.2.0');
  const p = publishPreflight(d);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.sha, sha);
  assert.equal(p.remote, 'origin');
  assert.equal(p.tag, 'v1.2.0');
  assert.equal(p.tagHere, false);
  assert.equal(p.previous, null);
});

test('preflight refuses: wrong branch, uncommitted change, ahead, behind', () => {
  const { d, origin } = published();
  git(d, 'checkout', '-q', '-b', 'feature');
  assert.match(publishPreflight(d).reason, /on 'feature', not 'main'/);
  git(d, 'checkout', '-q', 'main');

  writeFileSync(join(d, 'package.json'), '{"version":"9.9.9"}');
  assert.match(publishPreflight(d).reason, /uncommitted changes/);
  git(d, 'checkout', '--', 'package.json');

  commit(d, '1.1.0');
  assert.match(publishPreflight(d).reason, /1 ahead \/ 0 behind origin\/main/);
  git(d, 'push', '-q', 'origin', 'main');
  git(d, 'reset', '-q', '--hard', 'HEAD~1');
  assert.match(publishPreflight(d).reason, /0 ahead \/ 1 behind origin\/main/);
  assert.ok(origin);
});

test('preflight refuses: a version already released elsewhere, or not newer', () => {
  const { d } = published('1.0.0');
  git(d, 'tag', '-a', 'v1.0.0', '-m', 'r');
  commit(d, '1.0.0', 'no bump');
  git(d, 'push', '-q', 'origin', 'main');
  assert.match(publishPreflight(d).reason, /v1\.0\.0 already marks .* needs a new version/);

  commit(d, '0.9.0', 'went backwards');
  git(d, 'push', '-q', 'origin', 'main');
  assert.match(publishPreflight(d).reason, /0\.9\.0 is not newer than the last release v1\.0\.0/);

  commit(d, '1.1.0');
  git(d, 'push', '-q', 'origin', 'main');
  const p = publishPreflight(d);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.previous, 'v1.0.0');
});

test('preflight: the tag already on this commit is a re-run, not a refusal', () => {
  const { d } = published('2.0.0');
  git(d, 'tag', '-a', 'v2.0.0', '-m', 'r');
  const p = publishPreflight(d);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.tagHere, true);
});

test('preflight: no version → refused unless "tag": false', () => {
  const d = repo();
  writeFileSync(join(d, 'x'), 'x');
  git(d, 'add', 'x');
  git(d, 'commit', '-q', '-m', 'x');
  assert.match(publishPreflight(d).reason, /no "version" in package\.json/);
  const p = publishPreflight(d, { tag: false });
  assert.equal(p.ok, true);
  assert.equal(p.tag, null);
});

test('preflight refuses a version that is not plain x.y.z, and a last release that is not vX.Y.Z', () => {
  const { d } = published('1.0.0-beta.1');
  assert.match(publishPreflight(d).reason, /"1\.0\.0-beta\.1" .* is not plain x\.y\.z/);
  assert.equal(publishPreflight(d, { tag: false }).ok, true, 'untagged projects do not care');

  const p = published('2.0.0');
  git(p.d, 'tag', '-a', 'v1.0.0-rc', '-m', 'odd');
  commit(p.d, '2.0.1');
  git(p.d, 'push', '-q', 'origin', 'main');
  assert.match(publishPreflight(p.d).reason, /last release tag v1\.0\.0-rc is not plain vX\.Y\.Z/);
});

test('compareVersions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), null);
});

// --- live and tag -----------------------------------------------------------------

test('healthMatches: exactly this commit, by full or ≥7-char prefix', () => {
  const sha = 'b91d4839abcdef0123456789abcdef0123456789';
  assert.equal(healthMatches({ commit: sha }, sha), true);
  assert.equal(healthMatches({ commitShort: 'b91d483' }, sha), true);
  assert.equal(healthMatches({ commit: 'b91d48' }, sha), false, 'too short to be sure');
  assert.equal(healthMatches({ commit: 'a79ea11' }, sha), false);
  assert.equal(healthMatches({ status: 'ok' }, sha), false);
  assert.equal(healthMatches(null, sha), false);
});

test('tagRelease: annotated tag, pushed, and read back from origin', () => {
  const { d, origin, sha } = published('3.0.0');
  const t = tagRelease(d, { tag: 'v3.0.0', sha, remote: 'origin', label: 'p' });
  assert.deepEqual(t, { ok: true, pushed: true });
  assert.equal(git(origin, 'rev-parse', 'v3.0.0^{commit}'), sha);
  assert.equal(git(d, 'cat-file', '-t', 'v3.0.0'), 'tag', 'annotated');
  assert.deepEqual(tagRelease(d, { tag: 'v3.0.0', sha, remote: 'origin', label: 'p' }), { ok: true, pushed: true }, 'idempotent');
});

test('tagRelease: reports a push the remote never received', () => {
  const { d, sha } = published('3.1.0');
  git(d, 'remote', 'set-url', 'origin', join(tmpdir(), 'no-such-remote-cogyard'));
  const t = tagRelease(d, { tag: 'v3.1.0', sha, remote: 'origin', label: 'p' });
  assert.equal(t.ok, false);
  assert.match(t.error, /set locally but origin does not have it/);
});

// --- the lock -----------------------------------------------------------------------

test('lock: one publish per project; a dead holder is taken over', () => {
  const a = takePublishLock('proj');
  assert.equal(a.ok, true);
  const b = takePublishLock('proj');
  assert.equal(b.ok, false);
  assert.match(b.reason, /another publish of this project is running/);
  assert.equal(takePublishLock('other').ok, true, 'per project');
  a.release();
  const c = takePublishLock('proj');
  assert.equal(c.ok, true);
  c.release();

  writeFileSync(join(HOME, 'run', 'publish', 'proj.lock'), '999999');
  const d = takePublishLock('proj');
  assert.equal(d.ok, true, 'stale lock from a dead pid');
  d.release();
});

// --- the settings card's read ---------------------------------------------------------

test('publishStatus: declaration, tip vs live, last release + unreleased, history, defaults — read-only', async () => {
  const { d, sha } = published('1.0.0');
  git(d, 'tag', '-a', 'v1.0.0', '-m', 'r');
  commit(d, '1.1.0');
  commit(d, '1.2.0');
  git(d, 'push', '-q', 'origin', 'main');
  const tip = git(d, 'rev-parse', 'HEAD');

  const http = await import('node:http');
  const srv = http.createServer((q, r) => r.end(JSON.stringify({ commit: sha })));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    declare(d, { deploysOnPush: false, manual: ['press Deploy'], health: `http://127.0.0.1:${srv.address().port}/health`, requires: ['COGYARD_TEST_NOT_SET'] });
    recordPublish({ project: 'p-status', ok: true, sha, tag: 'v1.0.0' });
    recordPublish({ project: 'someone-else', ok: true });
    recordPublish({ project: 'p-status', ok: false, sha: tip, failedAt: 'Verify', reason: 'x' });

    const s = await publishStatus({ slug: 'p-status', path: d });
    assert.equal(s.declaration.declared, true);
    assert.deepEqual(s.credentials, [{ name: 'COGYARD_TEST_NOT_SET', set: false }]);
    assert.deepEqual(s.tip, { ref: 'origin/main', short: tip.slice(0, 7), version: '1.2.0' });
    assert.equal(s.lastRelease.tag, 'v1.0.0');
    assert.equal(s.lastRelease.short, sha.slice(0, 7));
    assert.equal(s.lastRelease.unreleased, 2);
    assert.deepEqual({ ...s.live, url: null }, { url: null, reachable: true, commit: sha.slice(0, 7), servesTip: false });
    assert.deepEqual(s.history.map((h) => h.failedAt ?? 'ok'), ['Verify', 'ok'], 'this project only, newest first');
    assert.equal(s.defaults.verifyTimeoutMinutes, 10);
    assert.equal(s.defaults.branch, 'main');
    assert.equal(git(d, 'status', '--porcelain', '--untracked-files=no'), '', 'nothing written');
  } finally { srv.close(); }
});

test('publishStatus: an unreachable health URL and an undeclared project', async () => {
  const { d } = published('1.0.0');
  declare(d, { deploysOnPush: false, manual: ['x'], health: 'http://127.0.0.1:9/health' });
  const s = await publishStatus({ slug: 'p-down', path: d });
  assert.deepEqual({ reachable: s.live.reachable, commit: s.live.commit, servesTip: s.live.servesTip }, { reachable: false, commit: null, servesTip: false });
  assert.equal(s.lastRelease, null);

  const u = await publishStatus({ slug: 'p-none', path: published().d });
  assert.equal(u.declaration.declared, false);
  assert.equal(u.live, null);
  assert.deepEqual(u.credentials, []);
});

// --- the card's "ready" line (task 259) -------------------------------------------------

test('publishStatus.ready: a declared, current project is ready; refusals are the CLI\'s own sentences', async () => {
  const { d } = published('1.0.0');
  declare(d, { deploysOnPush: false, manual: ['press Deploy'] });
  assert.deepEqual((await publishStatus({ slug: 'r-ok', path: d })).ready, { ok: true, reason: null });

  declare(d, { deploysOnPush: true, command: 'deploy.sh' });
  const onPush = (await publishStatus({ slug: 'r-push', path: d })).ready;
  assert.equal(onPush.ok, false);
  assert.equal(onPush.reason, publishPlan(readPublishConfig(d)).reason);

  declare(d, { deploysOnPush: false });
  assert.match((await publishStatus({ slug: 'r-none', path: d })).ready.reason, /neither a "command" nor "manual"/);

  assert.equal((await publishStatus({ slug: 'r-undeclared', path: published().d })).ready, null);
  const bad = published().d;
  declare(bad, '{nope');
  assert.equal((await publishStatus({ slug: 'r-bad', path: bad })).ready, null);
});

test('publishStatus.ready: a version already released on another commit, and a main that is ahead', async () => {
  const { d } = published('1.0.0');
  declare(d, { deploysOnPush: false, manual: ['press Deploy'] });
  git(d, 'tag', '-a', 'v1.0.0', '-m', 'r');
  commit(d, '1.0.0', 'no bump');
  git(d, 'push', '-q', 'origin', 'main');
  const tagged = (await publishStatus({ slug: 'r-tagged', path: d })).ready;
  assert.equal(tagged.ok, false);
  assert.match(tagged.reason, /v1\.0\.0 already marks .* needs a new version/);

  commit(d, '1.1.0');
  assert.match((await publishStatus({ slug: 'r-ahead', path: d })).ready.reason, /1 ahead \/ 0 behind origin\/main/);
});

test('publishStatus.ready: "tag": false skips the version checks', async () => {
  const d = repo();
  writeFileSync(join(d, 'x'), 'x');
  git(d, 'add', 'x');
  git(d, 'commit', '-q', '-m', 'x');
  declare(d, { deploysOnPush: false, manual: ['paste it'], tag: false });
  assert.deepEqual((await publishStatus({ slug: 'r-notag', path: d })).ready, { ok: true, reason: null });
});

test('publishStatus.ready runs no fetch: it judges against origin/main as of the last fetch', async () => {
  const { d, origin } = published('1.0.0');
  declare(d, { deploysOnPush: false, manual: ['press Deploy'] });
  // Someone else pushes to origin; this checkout has not fetched it.
  const other = tmp('cogyard-other-');
  git(other, 'clone', '-q', origin, '.');
  git(other, 'config', 'user.email', 't@example.com');
  git(other, 'config', 'user.name', 'T');
  commit(other, '1.1.0');
  git(other, 'push', '-q', 'origin', 'main');
  const before = git(d, 'rev-parse', 'origin/main');

  const s = await publishStatus({ slug: 'r-nofetch', path: d });
  assert.deepEqual(s.ready, { ok: true, reason: null }, 'as of the last fetch, main matches');
  assert.equal(git(d, 'rev-parse', 'origin/main'), before, 'origin/main was not fetched');
  // The CLI's own preflight still fetches, and so sees the push.
  assert.match(publishPreflight(d).reason, /0 ahead \/ 1 behind origin\/main/);
});

// --- which project ----------------------------------------------------------------------

test('resolvePublishProject: exact slug, exact label, one partial match — never a guess between two', () => {
  const ps = [
    { slug: 'shopfront-clones__main', label: 'shopfront-clones/main', path: '/a' },
    { slug: 'ledger-app', label: 'ledger-app', path: '/b' },
    { slug: 'notes__alpha', label: 'notes/alpha', path: '/c' },
    { slug: 'notes__beta', label: 'notes/beta', path: '/d' },
    { slug: 'broken', label: 'broken', path: '/e', error: 'broken link' },
  ];
  assert.equal(resolvePublishProject(ps, 'ledger-app').project.path, '/b');
  assert.equal(resolvePublishProject(ps, 'shopfront-clones/main').project.path, '/a');
  assert.equal(resolvePublishProject(ps, 'shopfront').project.path, '/a');
  assert.match(resolvePublishProject(ps, 'notes').reason, /matches 2 projects \(notes__alpha, notes__beta\)/);
  assert.match(resolvePublishProject(ps, 'nope').reason, /no registered project matches 'nope'/);
  assert.match(resolvePublishProject(ps, 'broken').reason, /no registered project/);
});

// --- the listing ----------------------------------------------------------------------

test('prePushHook: the common git dir, core.hooksPath, and non-executable files', () => {
  const d = repo();
  assert.equal(prePushHook(d), null);
  const p = join(d, '.git', 'hooks', 'pre-push');
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
  assert.equal(prePushHook(d), p);
  mkdirSync(join(d, 'h'));
  git(d, 'config', 'core.hooksPath', 'h');
  assert.equal(prePushHook(d), null, 'hooksPath replaces .git/hooks');
});

test('publishInventory: declaration, hook and last release per project', () => {
  const { d } = published('1.0.0');
  git(d, 'tag', '-a', 'v1.0.0', '-m', 'r');
  declare(d, { deploysOnPush: false, manual: ['press Deploy'] });
  const rows = publishInventory([{ slug: 'a', path: d }, { slug: 'b', path: repo() }]);
  assert.equal(rows[0].lastRelease, 'v1.0.0');
  assert.deepEqual(rows[0].manual, ['press Deploy']);
  assert.equal(rows[1].declared, false);
  assert.equal(rows[1].lastRelease, null);
});
