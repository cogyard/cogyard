// `cogyard publish` end to end (task 170). Each fixture is a real project with
// a bare origin, a "platform" that is a file the deploy command writes, and a
// /health server (its own process) that reports whatever commit that file
// holds — so every step of the sequence runs for real: owner, lock, code,
// live-now, confirm, deploy, verify, tag, record.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'cogyard.mjs');
const dirs = [];
const servers = [];
after(() => {
  for (const s of servers) s.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

// The /health server: reports the commit in `liveFile`, as a commit-stamped service does.
async function healthServer(liveFile) {
  const src = `
    const http = require('http'), fs = require('fs');
    const s = http.createServer((q, r) => {
      let c = ''; try { c = fs.readFileSync(${JSON.stringify(liveFile)}, 'utf8').trim(); } catch {}
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ status: 'ok', commit: c, commitShort: c.slice(0, 7) }));
    });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`;
  const p = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(p);
  const [chunk] = await once(p.stdout, 'data');
  return `http://127.0.0.1:${String(chunk).trim()}/health`;
}

async function fixture({ declaration, version = '1.0.0' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-publish-cli-')));
  dirs.push(root);
  const home = join(root, 'home');
  const origin = join(root, 'origin.git');
  const path = join(root, 'proj');
  const live = join(root, 'live.txt'); // what "production" is serving
  mkdirSync(home);
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(join(path, '.cogyard', 'tasks'), { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 't@example.com');
  git(path, 'config', 'user.name', 'T');
  git(path, 'remote', 'add', 'origin', origin);
  writeFileSync(live, 'a79ea11ce2f94137b4f96c3404b508f98f603cc7');
  const health = await healthServer(live);
  const decl = declaration ?? {
    deploysOnPush: false,
    command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`,
    health,
  };
  writeFileSync(join(path, '.cogyard', 'publish.json'), JSON.stringify(typeof decl === 'function' ? decl({ live, health, root }) : decl));
  writeFileSync(join(path, '.gitignore'), '.cogyard/tasks\n');
  writeFileSync(join(path, 'package.json'), JSON.stringify({ version }));
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'init');
  git(path, 'push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(home, 'projects.json'), JSON.stringify([{ slug: 'proj', label: 'proj', path }]));
  return { root, home, origin, path, live, health, sha: git(path, 'rev-parse', 'HEAD') };
}

// A human's shell (no agent variables), the fixture's cogyard home, fast polling.
function run(f, args, extraEnv = {}) {
  const env = { ...process.env, COGYARD_HOME: f.home, COGYARD_PUBLISH_POLL_MS: '50', COGYARD_PUBLISH_TIMEOUT_MS: '1500', ...extraEnv };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR']) if (!(k in extraEnv)) delete env[k];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'publish', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
// The same, in a terminal: a publish that must ask the owner refuses to start
// without one. Python's pty module gives the CLI a real pseudo-terminal (Node
// has none built in); `answers` are [pattern, reply] pairs, each reply typed
// once its pattern has been printed. Colour off, and the terminal wide, so the
// output reads as plain lines.
const PTY = `
import os, pty, sys, json, re, select, time, fcntl, termios, struct
answers = json.loads(sys.argv[1]); argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 500, 0, 0))
buf = b''; i = 0; deadline = time.time() + 60
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try: data = os.read(fd, 4096)
        except OSError: break
        if not data: break
        sys.stdout.buffer.write(data); sys.stdout.flush(); buf += data
    if i < len(answers) and re.search(answers[i][0].encode(), buf):
        os.write(fd, answers[i][1].encode()); buf = b''; i += 1
else:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
function runInTerminal(f, args, answers, extraEnv = {}) {
  const env = { ...process.env, COGYARD_HOME: f.home, COGYARD_PUBLISH_POLL_MS: '50', COGYARD_PUBLISH_TIMEOUT_MS: '1500', NO_COLOR: '1', ...extraEnv };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR']) if (!(k in extraEnv)) delete env[k];
  return new Promise((resolve) => {
    const p = spawn('python3', ['-I', '-c', PTY, JSON.stringify(answers), process.execPath, CLI, 'publish', ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    p.stdout.on('data', (d) => { output += d; });
    p.on('close', (status) => resolve({ status, output: output.replace(/\r\n/g, '\n') }));
  });
}
const log = (f) => readFileSync(join(f.home, 'publishes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const remoteTag = (f, tag) => { try { return git(f.origin, 'rev-parse', `${tag}^{commit}`); } catch { return null; } };

test('a publish runs all ten steps: deploys the commit, sees it live, tags it on origin, records it', async () => {
  const f = await fixture({ version: '1.4.0' });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const s of ['1. Owner', '2. Lock', '3. Code', '4. Live now', '5. Checks', '6. Confirm', '7. Deploy', '8. Verify', '9. Tag', '10. Record']) {
    assert.match(r.stdout, new RegExp(`^${s.replace('.', '\\.')}$`, 'm'), `step "${s}" shown`);
  }
  // Confirm says what "yes" sets in motion, in order, before any of it runs.
  assert.match(r.stdout, /You are about to publish proj as v1\.4\.0\. That is commit [0-9a-f]{7}\./);
  assert.match(r.stdout, /If you answer yes, these things happen in this order:\n\s+First, cogyard runs this command for you: printf[^\n]*\n\s+Then, cogyard waits up to \d+ minutes for http[^\n]* to show commit [0-9a-f]{7}\.\n\s+Last, cogyard tags commit [0-9a-f]{7} as v1\.4\.0 and pushes the tag to origin\./);
  assert.equal(readFileSync(f.live, 'utf8'), f.sha, 'the platform got exactly this commit');
  assert.equal(remoteTag(f, 'v1.4.0'), f.sha, 'origin has the tag on this commit');
  assert.match(r.stdout, /Published proj v1\.4\.0\./);
  assert.doesNotMatch(r.stdout + r.stderr, /\x1b\[/, 'no colour codes when the output is not a terminal');
  const [entry] = log(f);
  assert.equal(entry.ok, true);
  assert.equal(entry.sha, f.sha);
  assert.equal(entry.tag, 'v1.4.0');
});

test('re-running a finished publish is safe: already live, deploy skipped, tag kept', async () => {
  const f = await fixture({ version: '1.5.0' });
  assert.equal((await run(f, ['proj', '--yes'])).status, 0);
  writeFileSync(join(f.root, 'marker'), '');
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already live — checks and deploy are skipped/);
  assert.match(r.stdout, /v1\.5\.0 is already on this commit/);
  assert.equal(remoteTag(f, 'v1.5.0'), f.sha);
});

test('a deploy that never serves this commit is NOT tagged', async () => {
  const f = await fixture({ declaration: ({ live, health }) => ({
    deploysOnPush: false, command: `printf deadbeefdeadbeef > ${JSON.stringify(live)}`, health,
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ Verify: .* never went live — still serving deadbee/);
  assert.equal(remoteTag(f, 'v1.0.0'), null);
  assert.throws(() => git(f.path, 'rev-parse', 'v1.0.0'), 'no local tag either');
  const [entry] = log(f);
  assert.equal(entry.ok, false);
  assert.equal(entry.failedAt, 'Verify');
});

test('a failing deploy command stops before Verify and Tag', async () => {
  const f = await fixture({ declaration: ({ health }) => ({ deploysOnPush: false, command: 'exit 7', health }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 7);
  assert.match(r.stderr, /✗ Deploy: the command exited 7/);
  assert.doesNotMatch(r.stdout, /^8\. Verify$/m, 'step 8 never started');
  assert.equal(remoteTag(f, 'v1.0.0'), null);
});

test('refused inside an agent, before anything is read or run', async () => {
  const f = await fixture();
  const r = await run(f, ['proj', '--yes'], { CLAUDECODE: '1' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /started by claude/);
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha);
  assert.equal(existsSync(join(f.home, 'publishes.jsonl')), false);
});

test('refused when main is not what origin has — the platform would build something else', async () => {
  const f = await fixture();
  writeFileSync(join(f.path, 'more.txt'), 'x');
  git(f.path, 'add', 'more.txt');
  git(f.path, 'commit', '-q', '-m', 'unpushed');
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /✗ Code: main is 1 ahead \/ 0 behind origin\/main/);
  assert.notEqual(readFileSync(f.live, 'utf8').slice(0, 7), git(f.path, 'rev-parse', '--short', 'HEAD'));
});

test('refused while another publish of the project holds the lock', async () => {
  const f = await fixture();
  mkdirSync(join(f.home, 'run', 'publish'), { recursive: true });
  writeFileSync(join(f.home, 'run', 'publish', 'proj.lock'), String(process.pid));
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /✗ Lock: another publish of this project is running/);
});

test('steps that need the owner are refused up front when nobody can be asked', async () => {
  const manual = await fixture({ declaration: ({ health }) => ({ deploysOnPush: false, manual: ['Press Deploy'], health }) });
  const m = await run(manual, ['proj', '--yes']);
  assert.equal(m.status, 2);
  assert.match(m.stderr, /manual steps for you to confirm, and there is no terminal/);

  const noHealth = await fixture({ declaration: ({ live }) => ({ deploysOnPush: false, command: `printf x > ${JSON.stringify(live)}` }) });
  const h = await run(noHealth, ['proj', '--yes']);
  assert.equal(h.status, 2);
  assert.match(h.stderr, /no health URL or live check is declared, so you must confirm it is live — and there is no terminal/);
  assert.equal(readFileSync(noHealth.live, 'utf8').trim().length, 40, 'the deploy never ran');
});

test('checks: all pass on the commit, then the deploy runs', async () => {
  const f = await fixture({ declaration: ({ live, root, health }) => ({
    deploysOnPush: false,
    checks: [`git rev-parse HEAD > ${JSON.stringify(join(root, 'checked.txt'))}`, 'true'],
    command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`,
    health,
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(f.root, 'checked.txt'), 'utf8').trim(), f.sha, 'checked the exact commit');
  assert.match(r.stdout, /the checkout is still exactly/);
  assert.match(r.stdout, /→ true\n\s+✓ true/, 'each check is shown, then its result');
  assert.equal(remoteTag(f, 'v1.0.0'), f.sha);
});

test('checks: a failing check stops it before the deploy — nothing ships, nothing is tagged', async () => {
  const f = await fixture({ declaration: ({ live, health }) => ({
    deploysOnPush: false, checks: ['true', 'echo check says hello; exit 4'],
    command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`, health,
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ Checks: `echo check says hello; exit 4` failed \(exit 4\) — nothing was deployed/);
  assert.match(r.stdout, /→ true\n   ✓ true\n   → echo check says hello; exit 4\n   check says hello\n/, "a check's own output is shown, indented under it");
  assert.doesNotMatch(r.stdout, /^7\. Deploy$/m, 'step 7 never started');
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha);
  assert.equal(remoteTag(f, 'v1.0.0'), null);
});

test('checks: npm logged out stops it at step 5, before you are asked to confirm anything (task 267)', async () => {
  // cogyard's own declaration checks `npm whoami`. An empty npm user config is
  // npm with nobody logged in; `npm whoami` then fails at once, offline.
  const f = await fixture({ declaration: ({ live, health }) => ({
    deploysOnPush: false, checks: ['npm whoami'],
    command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`, health,
  }) });
  const empty = join(f.root, 'empty-npmrc');
  writeFileSync(empty, '');
  // No --yes: had it reached step 6, it would stop there ("no terminal to ask in").
  // Both spellings: under `npm test`, npm passes its own config down as
  // lowercase npm_config_userconfig (the real ~/.npmrc), which would win.
  const r = await run(f, ['proj'], { NPM_CONFIG_USERCONFIG: empty, npm_config_userconfig: empty });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /✗ Checks: `npm whoami` failed \(exit 1\) — nothing was deployed/);
  assert.doesNotMatch(r.stdout, /^6\. Confirm$/m, 'step 6 never started');
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha);
});

test('checks: a check that changes a tracked file stops it — the checked code is not the committed code', async () => {
  const f = await fixture({ declaration: ({ live, health }) => ({
    deploysOnPush: false, checks: ['echo "{\\"version\\":\\"1.0.0\\",\\"x\\":1}" > package.json'],
    command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`, health,
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /✗ Checks: the checks changed tracked files:[\s\S]*package\.json/);
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha);
});

test('requires: a missing credential stops it before step 2; a present one reaches the deploy command', async () => {
  const f = await fixture({ declaration: ({ live, health }) => ({
    deploysOnPush: false,
    requires: ['COGYARD_TEST_DEPLOY_TOKEN'],
    // Checks the value arrived (by length) without the value appearing in the command.
    command: `test "\${#COGYARD_TEST_DEPLOY_TOKEN}" = 6 && printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`,
    health,
  }) });
  const missing = await run(f, ['proj', '--yes']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /✗ Declaration: missing credential\(s\) COGYARD_TEST_DEPLOY_TOKEN/);
  assert.doesNotMatch(missing.stdout, /2\. Lock/);

  writeFileSync(join(f.home, 'secrets.env'), 'COGYARD_TEST_DEPLOY_TOKEN=s3cret\n', { mode: 0o600 });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(f.live, 'utf8'), f.sha);
  assert.doesNotMatch(r.stdout + r.stderr, /s3cret/, 'the value is never printed');
});

test('no --yes and no terminal → nothing runs', async () => {
  const f = await fixture();
  const r = await run(f, ['proj']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /✗ Confirm: no terminal to ask in/);
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha);
});

// --- a declared live check instead of a health URL (task 267) -------------------------

test('liveCheck: one that passes already makes step 4 report "already live" — checks and deploy skipped, tag set', async () => {
  // The releases form with a prefixed tag: the check is told the version
  // WITHOUT the prefix, as cogyard's own "npm serves cogyard@<version>" needs.
  const f = await fixture({ version: '1.4.0', declaration: ({ live }) => ({
    releases: { npm: {
      label: 'npm', tag: 'pkg/v<version>', deploysOnPush: false,
      checks: ['exit 9'],
      command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`,
      liveCheck: 'test "$COGYARD_PUBLISH_VERSION" = 1.4.0 && echo "the registry serves 1.4.0"',
    } },
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^4\. Live now\n   → test "\$COGYARD_PUBLISH_VERSION" = 1\.4\.0[^\n]*\n   the registry serves 1\.4\.0\n   ✓ the live check passes: proj npm pkg\/v1\.4\.0 is already live — checks and deploy are skipped$/m);
  assert.match(r.stdout, /^5\. Checks\n   ✓ skipped — already live$/m, 'the failing check never ran');
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha, 'nothing was deployed');
  assert.match(r.stdout, /✓ live ✓ — proj npm pkg\/v1\.4\.0 passes the live check/);
  assert.equal(remoteTag(f, 'pkg/v1.4.0'), f.sha);
});

test('liveCheck: one that passes only after the deploy makes step 8 wait, then pass — no question asked', async () => {
  const f = await fixture({ version: '1.2.0', declaration: ({ root }) => ({
    deploysOnPush: false,
    // The "platform" takes a moment: the marker appears 0.4 s after the deploy.
    command: `printf %s "$COGYARD_PUBLISH_VERSION" > ${JSON.stringify(join(root, 'deployed-version'))}; (sleep 0.4; touch ${JSON.stringify(join(root, 'marker'))}) >/dev/null 2>&1 &`,
    liveCheck: `if [ -f ${JSON.stringify(join(root, 'marker'))} ]; then echo "serving $COGYARD_PUBLISH_VERSION"; else echo "not serving $COGYARD_PUBLISH_VERSION yet"; exit 1; fi`,
  }) });
  const r = await run(f, ['proj', '--yes'], { COGYARD_PUBLISH_TIMEOUT_MS: '10000' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(readFileSync(join(f.root, 'deployed-version'), 'utf8'), '1.2.0', 'the deploy command got COGYARD_PUBLISH_VERSION');
  // Step 4 found it not live; step 6 said what step 8 would run.
  assert.match(r.stdout, /not serving 1\.2\.0 yet\n   ✓ not live yet \(the live check exits 1\) — step 8 runs it again after the deploy/);
  assert.match(r.stdout, /Then, cogyard runs this live check every 50 ms, up to \d+ minutes, until it passes: if \[ -f /);
  assert.match(r.stdout, /^8\. Verify\n   running the live check every 50 ms \(up to \d+ min\) until it passes:\n   → if \[ -f [^\n]*\n\s+\d\d:\d\d:\d\d  not serving 1\.2\.0 yet\n\s+\d\d:\d\d:\d\d  serving 1\.2\.0\n   ✓ live ✓ — proj v1\.2\.0 passes the live check$/m);
  assert.doesNotMatch(r.stdout, /\[y\/N\]/, 'nothing was asked');
  assert.equal(remoteTag(f, 'v1.2.0'), f.sha);
});

test('liveCheck: one that never passes stops at Verify with what it last printed — nothing tagged', async () => {
  const f = await fixture({ declaration: ({ live }) => ({
    deploysOnPush: false,
    command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`,
    liveCheck: 'echo "checking the registry"; echo "npm does not serve it yet" >&2; exit 1',
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /✗ Verify: the live check did not pass within \d+ min — it last printed: npm does not serve it yet/);
  assert.equal(readFileSync(f.live, 'utf8'), f.sha, 'it was deployed');
  assert.equal(remoteTag(f, 'v1.0.0'), null, 'but not tagged');
  const [entry] = log(f);
  assert.equal(entry.failedAt, 'Verify');
});

test('neither health nor liveCheck: step 8 asks about the version, tag, commit and the hand step just done', async () => {
  const f = await fixture({ version: '1.3.0', declaration: { deploysOnPush: false, manual: ['Press Deploy on the dashboard'] } });
  const short = f.sha.slice(0, 7);
  const r = await runInTerminal(f, ['proj', '--yes'], [['Have you done it\\? \\[y/N\\]', 'y\r'], ['live, after .*\\? \\[y/N\\]', 'n\r']]);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Then, cogyard asks you whether commit [0-9a-f]{7} is live, because nothing declared lets it check\./);
  assert.match(r.output, /Nothing in \.cogyard\/publish\.json lets cogyard check this itself \(no "health" URL or "liveCheck" command\), so you decide\./);
  assert.ok(r.output.includes(`Is proj v1.3.0 (commit ${short}) live, after you did the hand step "Press Deploy on the dashboard"? [y/N]`), r.output);
  assert.doesNotMatch(r.output, /Have you seen/, 'never the bare question');
  assert.match(r.output, /✗ Verify: you did not confirm it is live/);
  assert.equal(remoteTag(f, 'v1.3.0'), null);
});

// --- a project naming its releases (task 264) ---------------------------------------

const twoReleases = ({ live, health }) => ({
  releases: {
    website: { label: 'Website', tag: 'web/v<version>', deploysOnPush: false, command: `printf %s "$COGYARD_PUBLISH_SHA" > ${JSON.stringify(live)}`, health },
    device: { label: 'Device', tag: 'v<version>', deploysOnPush: false, manual: ['Flash the meter by USB'] },
  },
});

test('releases: one is published by name — its own command, its own tag, recorded with its name', async () => {
  const f = await fixture({ version: '1.4.0', declaration: ({ live, health }) => {
    const d = twoReleases({ live, health });
    // Also note which release the deploy command was told it is publishing.
    d.releases.website.command += `; printf %s "$COGYARD_PUBLISH_RELEASE" > ${JSON.stringify(live + '.release')}`;
    return d;
  } });
  const r = await run(f, ['proj', 'website', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /release: Website \(website\)/);
  assert.match(r.stdout, /You are about to publish proj Website as web\/v1\.4\.0\. That is commit [0-9a-f]{7}\./);
  assert.match(r.stdout, /Published proj Website web\/v1\.4\.0\./);
  assert.equal(remoteTag(f, 'web/v1.4.0'), f.sha, 'the release\'s own tag, on origin');
  assert.equal(remoteTag(f, 'v1.4.0'), null, 'the other release\'s tag is untouched');
  assert.equal(readFileSync(f.live + '.release', 'utf8'), 'website', 'the deploy command is told which release');
  const [entry] = log(f);
  assert.equal(entry.release, 'website');
  assert.equal(entry.tag, 'web/v1.4.0');
});

test('releases: a label works as the name, any case', async () => {
  const f = await fixture({ version: '1.6.0', declaration: twoReleases });
  const r = await run(f, ['proj', 'WEBSITE']);
  assert.match(r.stdout, /release: Website \(website\)/, 'resolved before anything asks');
  assert.match(r.stderr, /✗ Confirm: no terminal to ask in/);
});

test('releases: no name, or a name it doesn\'t have, is refused before anything runs', async () => {
  const f = await fixture({ declaration: twoReleases });
  const none = await run(f, ['proj', '--yes']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /✗ Declaration: this project declares 2 releases \(website, device\) — name the one to publish/);
  const wrong = await run(f, ['proj', 'ios', '--yes']);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /no release called "ios" — this project's releases are website, device/);
  assert.notEqual(readFileSync(f.live, 'utf8'), f.sha, 'nothing deployed');
  const extra = await run(f, ['proj', 'website', 'device', '--yes']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /at most one release — "device" is left over/);
});

test('releases: a file with one release publishes with no name, under its own tag', async () => {
  const f = await fixture({ version: '1.8.0', declaration: ({ live, health }) => ({
    releases: { website: twoReleases({ live, health }).releases.website },
  }) });
  const r = await run(f, ['proj', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /release: Website \(website\)/);
  assert.match(r.stdout, /Published proj Website web\/v1\.8\.0\./);
  assert.equal(remoteTag(f, 'web/v1.8.0'), f.sha);
});

test('the flat form takes no release name', async () => {
  const f = await fixture();
  const r = await run(f, ['proj', 'website', '--yes']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /declares one release, so it takes no release name — leave out "website"/);
});

test('list: a project naming its releases gets a line per release', async () => {
  const f = await fixture({ declaration: twoReleases });
  git(f.path, 'tag', 'v0.9.0');
  const r = await run(f, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^proj · Website \(website\)\s+no\s+—\s+—\s+run `printf/m);
  assert.match(r.stdout, /^proj · Device \(device\)\s+no\s+v0\.9\.0\s+—\s+Flash the meter by USB — live check: you confirm/m);
});

test('list: declaration, last release, how it publishes', async () => {
  const f = await fixture({ version: '2.0.0' });
  await run(f, ['proj', '--yes']);
  const r = await run(f, ['list']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^proj\s+no\s+v2\.0\.0\s+—\s+run `printf/m);
  assert.match(r.stdout, /live check: http:\/\/127\.0\.0\.1:\d+\/health/);
});
