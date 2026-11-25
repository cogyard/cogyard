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
  readPublishConfig, publishReleases, pickRelease, publishPlan, publishPreflight, healthMatches, compareVersions,
  tagRelease, takePublishLock, prePushHook, publishInventory, resolvePublishProject,
  publishStatus, recordPublish, labelReleaseTags,
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
    health: 'https://a.example/health', liveCheck: null, tag: true, requires: [], checks: [],
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
    // Task 267: a live check is a non-empty command, and one way of proving
    // the release is live, not a second one beside the health URL.
    [{ deploysOnPush: false, command: 'x', liveCheck: '' }, /"liveCheck" must be a non-empty string/],
    [{ deploysOnPush: false, command: 'x', liveCheck: '  ' }, /"liveCheck" must be a non-empty string/],
    [{ deploysOnPush: false, command: 'x', liveCheck: ['npm view x'] }, /"liveCheck" must be a non-empty string/],
    [{ deploysOnPush: false, command: 'x', liveCheck: 'true', health: 'https://a.example/health' }, /"health" and "liveCheck" both prove the release is live — declare one of them, not both/],
  ];
  for (const [body, re] of cases) {
    const d = repo();
    declare(d, body);
    const r = readPublishConfig(d);
    assert.equal(r.declared, true, JSON.stringify(body));
    assert.match(r.error, re, JSON.stringify(body));
  }
});

test('liveCheck: a command proving the release is live reads back trimmed (task 267)', () => {
  const d = repo();
  declare(d, { deploysOnPush: false, manual: ['Run the release script'], liveCheck: ' test "$(npm view x@$COGYARD_PUBLISH_VERSION version)" = "$COGYARD_PUBLISH_VERSION" ' });
  const r = readPublishConfig(d);
  assert.equal(r.error, undefined);
  assert.equal(r.liveCheck, 'test "$(npm view x@$COGYARD_PUBLISH_VERSION version)" = "$COGYARD_PUBLISH_VERSION"');
  assert.equal(r.health, null);
});

// --- several releases (task 264) -------------------------------------------------

const TWO = {
  releases: {
    website: { label: ' Website ', tag: 'web/v<version>', paths: ['site/', ' wrangler.jsonc '], deploysOnPush: false, command: 'npx wrangler deploy', health: 'https://a.example/version.json' },
    device: { label: 'Device', tag: 'v<version>', paths: ['firmware/'], deploysOnPush: false, manual: ['Flash it by USB'] },
  },
};

test('releases: two named releases read back, each with its label, tag pattern and paths', () => {
  const d = repo();
  declare(d, TWO);
  assert.deepEqual(readPublishConfig(d), {
    declared: true,
    releases: [
      { name: 'website', label: 'Website', tagFormat: 'web/v<version>', paths: ['site/', 'wrangler.jsonc'], deploysOnPush: false, command: 'npx wrangler deploy', manual: [], health: 'https://a.example/version.json', liveCheck: null, tag: true, requires: [], checks: [] },
      { name: 'device', label: 'Device', tagFormat: 'v<version>', paths: ['firmware/'], deploysOnPush: false, command: null, manual: ['Flash it by USB'], health: null, liveCheck: null, tag: true, requires: [], checks: [] },
    ],
  });
});

test('releases: a release can declare its own liveCheck, and not together with health (task 267)', () => {
  const d = repo();
  declare(d, { releases: {
    npm: { label: 'npm', tag: 'v<version>', deploysOnPush: false, manual: ['Run the release script'], liveCheck: 'npm view x version' },
    website: { label: 'Website', tag: 'web/v<version>', deploysOnPush: false, command: 'x', health: 'https://a.example/version.json' },
  } });
  const [npm, website] = readPublishConfig(d).releases;
  assert.equal(npm.liveCheck, 'npm view x version');
  assert.equal(npm.health, null);
  assert.equal(website.liveCheck, null);

  declare(d, { releases: { npm: { label: 'npm', tag: 'v<version>', deploysOnPush: false, manual: ['x'], liveCheck: 'true', health: 'https://a.example/h' } } });
  assert.match(readPublishConfig(d).error, /release "npm": "health" and "liveCheck" both prove the release is live/);
  declare(d, { releases: { npm: { label: 'npm', tag: 'v<version>', deploysOnPush: false, manual: ['x'], liveCheck: '' } } });
  assert.match(readPublishConfig(d).error, /release "npm": "liveCheck" must be a non-empty string/);
});

test('releases: a release with "tag": false has no tag pattern', () => {
  const d = repo();
  declare(d, { releases: { app: { label: 'App', tag: false, deploysOnPush: false, manual: ['x'] } } });
  const [r] = readPublishConfig(d).releases;
  assert.equal(r.tagFormat, null);
  assert.equal(r.tag, false);
  assert.deepEqual(r.paths, []);
});

test('releases: every way the form can be wrong is an error naming the release', () => {
  const ok = { label: 'Web', tag: 'web/v<version>', deploysOnPush: false, command: 'x' };
  const cases = [
    [{ releases: {} }, /at least one release/],
    [{ releases: [] }, /at least one release/],
    [{ releases: { web: ok }, command: 'x' }, /unknown field.*"command".*inside a release/],
    [{ releases: { Web: ok } }, /release "Web": a release's name is lowercase/],
    [{ releases: { web: 'x' } }, /release "web" must be a JSON object/],
    [{ releases: { web: { ...ok, label: '' } } }, /release "web" needs a "label"/],
    [{ releases: { web: { ...ok, tag: undefined } } }, /release "web" needs a "tag"/],
    [{ releases: { web: { ...ok, tag: true } } }, /release "web": "tag" must be a pattern/],
    [{ releases: { web: { ...ok, tag: 'web/v' } } }, /release "web": "tag" must be a pattern/],
    [{ releases: { web: { ...ok, tag: '<version>' } } }, /must start with a letter/],
    [{ releases: { web: { ...ok, tag: 'web2<version>' } } }, /not end in a digit/],
    [{ releases: { web: { ...ok, tag: 'web v<version>' } } }, /must start with a letter, use only/],
    [{ releases: { web: { ...ok, paths: [] } } }, /release "web": "paths" must be/],
    [{ releases: { web: { ...ok, paths: ['../other'] } } }, /"paths" must be/],
    [{ releases: { web: { ...ok, paths: ['/abs'] } } }, /"paths" must be/],
    [{ releases: { web: { ...ok, comand: 'x' } } }, /release "web": unknown field.*"comand"/],
    [{ releases: { web: { ...ok, deploysOnPush: 'no' } } }, /release "web": needs "deploysOnPush"/],
    [{ releases: { web: ok, ios: { ...ok, label: 'iOS', tag: 'web/v<version>' } } }, /"web" and "ios" have overlapping tags/],
    [{ releases: { web: { ...ok, tag: 'v<version>' }, ios: { ...ok, label: 'iOS', tag: 'v-ios/<version>' } } }, /overlapping tags/],
  ];
  for (const [body, re] of cases) {
    const d = repo();
    declare(d, body);
    const r = readPublishConfig(d);
    assert.equal(r.declared, true, JSON.stringify(body));
    assert.match(r.error ?? '', re, JSON.stringify(body));
  }
});

test('publishReleases: the flat form is one unnamed release, tagged v<version> unless "tag": false', () => {
  const d = repo();
  declare(d, { deploysOnPush: false, command: 'x' });
  assert.deepEqual(publishReleases(readPublishConfig(d)), [
    { name: null, label: null, tagFormat: 'v<version>', paths: [], deploysOnPush: false, command: 'x', manual: [], health: null, liveCheck: null, tag: true, requires: [], checks: [] },
  ]);
  declare(d, { deploysOnPush: false, command: 'x', tag: false });
  assert.equal(publishReleases(readPublishConfig(d))[0].tagFormat, null);
  assert.deepEqual(publishReleases({ declared: false }), []);
  assert.deepEqual(publishReleases({ declared: true, error: 'bad' }), []);
});

test('pickRelease: a name or label picks one release; the flat form takes no name', () => {
  const d = repo();
  declare(d, TWO);
  const cfg = readPublishConfig(d);
  assert.equal(pickRelease(cfg, 'device').release.name, 'device');
  assert.equal(pickRelease(cfg, 'WEBSITE').release.name, 'website', 'a label, any case');
  assert.match(pickRelease(cfg, null).reason, /declares 2 releases \(website, device\) — name the one/);
  assert.match(pickRelease(cfg, 'ios').reason, /no release called "ios" — this project's releases are website, device/);
  assert.match(publishPlan(cfg).reason, /declares 2 releases/);
  assert.equal(publishPlan(pickRelease(cfg, 'device').release).ok, true);
  const flat = repo();
  declare(flat, { deploysOnPush: false, command: 'x' });
  const f = readPublishConfig(flat);
  assert.equal(pickRelease(f, null).release.name, null);
  assert.match(pickRelease(f, 'website').reason, /declares one release, so it takes no release name/);
});

test('pickRelease: a releases file with ONE entry needs no name; a name must still be its own', () => {
  const d = repo();
  declare(d, { releases: { website: { label: 'Website', tag: 'web/v<version>', deploysOnPush: false, command: 'x' } } });
  const cfg = readPublishConfig(d);
  assert.equal(pickRelease(cfg, null).release.name, 'website', 'no name → its one release');
  assert.equal(pickRelease(cfg, 'Website').release.name, 'website');
  assert.equal(pickRelease(cfg, 'device').reason, 'no release called "device" — this project\'s release is website');
  assert.equal(publishPlan(cfg).reason, 'this project declares 1 release — a publish is of one of them');
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

test('preflight with a release prefix: only that release\'s tags count (task 264)', () => {
  const { d, sha } = published('1.0.0');
  git(d, 'tag', 'v1.0.0', sha);                       // the other release's tag
  commit(d, '1.1.0');
  git(d, 'push', '-q', 'origin', 'main');
  const p = publishPreflight(d, { prefix: 'web/v' });
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.tag, 'web/v1.1.0');
  assert.equal(p.previous, null, 'v1.0.0 is not a website release');
  assert.equal(publishPreflight(d).previous, 'v1.0.0', 'the flat form still sees its own v tags');
  git(d, 'tag', 'web/v1.1.0', sha);                   // 1.1.0 already released, on another commit
  assert.match(publishPreflight(d, { prefix: 'web/v' }).reason, /web\/v1\.1\.0 already marks .* needs a new version/);
  const off = publishPreflight(repo(), { prefix: 'web/v', tagOff: 'set "tag": false for the "website" release' });
  assert.equal(off.ok, false);
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

// A project with two releases (task 264): a website in site/ and a device in
// firmware/, sharing package.json's version, each with its own tags.
function twoReleases() {
  const { d, sha } = published('1.0.0');
  const touch = (dir) => {
    mkdirSync(join(d, dir), { recursive: true });
    writeFileSync(join(d, dir, 'f.txt'), String(++seq));
    git(d, 'add', dir);
    git(d, 'commit', '-q', '-m', `change ${dir}`);
    return git(d, 'rev-parse', 'HEAD');
  };
  git(d, 'tag', '-a', 'v1.0.0', '-m', 'device', sha);
  git(d, 'tag', '-a', 'web/v1.0.0', '-m', 'website', sha);
  const web1 = touch('site');
  git(d, 'tag', '-a', 'web/v1.1.0', '-m', 'website', web1);
  touch('firmware');
  touch('site');
  git(d, 'push', '-q', 'origin', 'main');
  declare(d, {
    releases: {
      website: { label: 'Website', tag: 'web/v<version>', paths: ['site/'], deploysOnPush: false, command: 'deploy-it' },
      device: { label: 'Device', tag: 'v<version>', paths: ['firmware/'], deploysOnPush: false, manual: ['flash it'] },
    },
  });
  return { d, sha, web1 };
}

test('publishStatus with releases: each its own last tag, counting only its own paths', async () => {
  const { d, sha, web1 } = twoReleases();
  const s = await publishStatus({ slug: 'p-two', path: d });
  assert.deepEqual(s.releases.map((r) => [r.name, r.label]), [['website', 'Website'], ['device', 'Device']]);
  const [web, dev] = s.releases;
  assert.equal(web.lastRelease.tag, 'web/v1.1.0');
  assert.equal(web.lastRelease.short, web1.slice(0, 7));
  assert.equal(web.lastRelease.unreleased, 1, 'one later commit touched site/');
  assert.deepEqual(web.lastRelease.paths, ['site/']);
  assert.equal(dev.lastRelease.tag, 'v1.0.0', 'web/ tags are not the device\'s');
  assert.equal(dev.lastRelease.short, sha.slice(0, 7));
  assert.equal(dev.lastRelease.unreleased, 1, 'three commits since, one of them in firmware/');
  assert.equal(web.live, null);
  assert.match(web.ready.reason, /web\/v1\.0\.0 already marks/, 'its own tag, its own refusal');
  assert.equal(dev.declaration.manual[0], 'flash it');
  assert.equal(s.lastRelease, null, 'no project-wide last release');
  assert.equal(s.ready, null);
  assert.deepEqual(s.credentials, []);
});

test('publishStatus: the flat form lists itself as one release too', async () => {
  const { d } = published('1.0.0');
  declare(d, { deploysOnPush: false, command: 'x' });
  const s = await publishStatus({ slug: 'p-one', path: d });
  assert.equal(s.releases.length, 1);
  assert.equal(s.releases[0].name, null);
  assert.deepEqual(s.releases[0].ready, s.ready);
});

test('labelReleaseTags: a named release\'s tags get its label and version; the flat form is left alone', () => {
  const { d } = twoReleases();
  const rows = [
    { hash: 'a', refs: ['HEAD -> main', 'tag: web/v1.1.0'] },
    { hash: 'b', refs: ['tag: v1.0.0', 'tag: web/v1.0.0'] },
    { hash: 'c', refs: ['tag: vnext', 'tag: other'] },
    { hash: 'd', refs: [] },
  ];
  const out = labelReleaseTags(d, rows);
  assert.deepEqual(out[0].releaseTags, [{ tag: 'web/v1.1.0', release: 'website', label: 'Website', version: '1.1.0' }]);
  assert.deepEqual(out[1].releaseTags, [
    { tag: 'v1.0.0', release: 'device', label: 'Device', version: '1.0.0' },
    { tag: 'web/v1.0.0', release: 'website', label: 'Website', version: '1.0.0' },
  ]);
  assert.equal(out[2].releaseTags, undefined, 'v must be followed by a digit');
  assert.equal(out[3], rows[3], 'an untagged row is passed through');
  assert.equal(rows[0].releaseTags, undefined, 'the input rows are not changed');
  const flat = repo();
  declare(flat, { deploysOnPush: false, command: 'x' });
  assert.equal(labelReleaseTags(flat, rows), rows);
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

test('publishInventory: a project naming its releases lists each one\'s last release (task 264)', () => {
  const { d } = twoReleases();
  const [row] = publishInventory([{ slug: 'two', path: d }]);
  assert.equal(row.lastRelease, null);
  assert.deepEqual(row.releases.map((r) => [r.name, r.lastRelease]), [['website', 'web/v1.1.0'], ['device', 'v1.0.0']]);
});
