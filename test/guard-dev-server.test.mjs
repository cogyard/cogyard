// Tests for the PreToolUse dev-server guard (hooks/pretooluse-guard-dev-server.mjs).
//
// Integration-style, like guard-branch-switch.test.mjs: real throwaway git repos
// with a real linked worktree, a real registry under a temp COGYARD_HOME, and the
// hook run as the separate process it is, fed real PreToolUse JSON on stdin.
//
// The two halves matter equally, and the second half matters MORE. Refusing the
// hand-rolled server is the point; allowing npm install, the test run, the build,
// and one-shot scripts is what stops the guard being ripped out the first week it
// blocks something ordinary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pretooluse-guard-dev-server.mjs');

let ROOT, HOME, REGISTERED, UNREGISTERED, WORKTREE, UNREG_WORKTREE;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

function repo(name) {
  const dir = join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b.c', '-c', 'user.name=x',
    'commit', '-q', '--allow-empty', '-m', 'init']);
  return realpathSync(dir);
}

function worktree(repoRoot, name) {
  const wt = join(repoRoot, '.claude', 'worktrees', name);
  mkdirSync(dirname(wt), { recursive: true });
  git(repoRoot, 'worktree', 'add', '-q', '-b', `wtb-${name}`, wt);
  return realpathSync(wt);
}

// Run the hook exactly as Claude Code does: JSON in, decision out.
function decide(command, cwd) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const parsed = JSON.parse(out);
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision || 'allow',
    reason: parsed.hookSpecificOutput?.permissionDecisionReason || '',
  };
}

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-devguard-')));
  HOME = join(ROOT, 'home');
  mkdirSync(HOME, { recursive: true });
  REGISTERED = repo('registered');
  UNREGISTERED = repo('unregistered');
  WORKTREE = worktree(REGISTERED, 'task-1-thing');
  UNREG_WORKTREE = worktree(UNREGISTERED, 'task-1-thing');
  // The registry is a bare ARRAY (core/registry.mjs), not an object with a
  // `projects` key — seeding the wrong shape makes every deny case silently pass.
  writeFileSync(join(HOME, 'projects.json'),
    JSON.stringify([{ slug: 'registered', path: REGISTERED, label: 'registered' }], null, 2));
});

after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

// --- what must be refused ---------------------------------------------------

test('refuses the exact command that caused this guard to exist', () => {
  const { decision, reason } = decide('PORT=30045 node server/index.mjs &', WORKTREE);
  assert.equal(decision, 'deny');
  assert.match(reason, /preview_start name="wt-task-1-thing"/);
});

test('an env prefix does not hide the server behind it', () => {
  assert.equal(decide('COGYARD_HOME=/tmp/x PORT=1 node server/index.mjs', WORKTREE).decision, 'deny');
});

test('refuses the server entry point however node is spelled', () => {
  for (const c of [
    'node server/index.js',
    'node ./server/index.mjs',
    'node --watch server/index.mjs',
    'nodemon server/index.mjs',
    // Arguments after the file are the server's own argv, not node options.
    'node server/index.mjs --test',
  ]) {
    assert.equal(decide(c, WORKTREE).decision, 'deny', c);
  }
});

test('refuses the serving package scripts', () => {
  for (const c of ['npm run dev', 'npm start', 'npm run serve', 'pnpm run dev']) {
    assert.equal(decide(c, WORKTREE).decision, 'deny', c);
  }
});

test('refuses the dev script and the framework server directly', () => {
  assert.equal(decide('bash scripts/dev.sh', WORKTREE).decision, 'deny');
  assert.equal(decide('ng serve', WORKTREE).decision, 'deny');
});

test('the refusal says how to re-register when the entry is missing', () => {
  assert.match(decide('npm run dev', WORKTREE).reason, /cogyard hook session-start/);
});

// Task 230: the entry a chat in the worktree can reach is the worktree's own.
test('the refusal names the worktree\'s own launch.json, not the main checkout\'s', () => {
  const { reason } = decide('npm run dev', WORKTREE);
  assert.match(reason, /this worktree's \.claude\/launch\.json/);
  assert.doesNotMatch(reason, /registered in the main checkout/);
});

// --- what must NOT be refused ----------------------------------------------

test('ordinary worktree work is untouched', () => {
  for (const c of [
    'npm install',
    'npm test',
    'node --test',
    'node --test server/test/state.test.mjs',
    'node server/local-db.mjs ensure',
    'node server/migrate.mjs',
    'npm run build',
    'npm run lint:leaks',
    'node scripts/generate-version.mjs',
    'git status',
    'curl -s localhost:31047',
  ]) {
    assert.equal(decide(c, WORKTREE).decision, 'allow', c);
  }
});

test('a node command that tests, checks or evaluates is never a server', () => {
  // Regression (task 212): the guard matched any script under server/, so it
  // refused running one server test file and every one-shot server script.
  for (const c of [
    'node --test server/test/state.test.mjs',
    'node --test --test-name-pattern=state server/test/state.test.mjs',
    'node --eval="console.log(1)"',
    'node --check server/index.mjs',
    'node -c server/index.mjs',
    'node -e "console.log(1)"',
    'node --print 1+1',
    'node server/local-db.mjs status',
    'PORT=1 node server/app.mjs',
  ]) {
    assert.equal(decide(c, WORKTREE).decision, 'allow', c);
  }
});

test('text inside quotes or a heredoc is not a command', () => {
  // Regression: the splitter cut at every newline and separator, quoted or not,
  // so a commit message line that began with a server command read as a
  // command of its own and the whole `git commit` was refused (found while
  // committing task 212).
  for (const c of [
    'git commit -m "fix the guard\n\nnode server/index.mjs is still refused\nand so is npm run dev"',
    'git commit -m "say \\"hi\\"\nnpm run dev; npm start"',
    "echo 'one\nnpm run dev'",
    "git commit -m \"$(cat <<'EOF'\nfix: the \"dev\" script\n\nnode server/index.mjs &\nEOF\n)\"",
    "cat > notes.md <<'EOF'\nnpm run dev\nPORT=1 node server/index.mjs\nEOF",
    'cat <<-END\n\tnpm run dev\n\tEND',
  ]) {
    assert.equal(decide(c, WORKTREE).decision, 'allow', c);
  }
});

test('a server start outside the quotes is still caught', () => {
  for (const c of [
    'npm install && npm run dev',
    'npm install\nPORT=30045 node server/index.mjs &',
    'git commit -m "x; y" && npm run dev',
    'echo "a << b"\nnpm run dev',
    "cat > notes.md <<'EOF'\nhello\nEOF\nnode server/index.mjs",
    'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" && npm start',
  ]) {
    assert.equal(decide(c, WORKTREE).decision, 'deny', c);
  }
});

test('a script whose name merely starts with "dev" is not a server', () => {
  // Regression: the first version matched dev*.sh and so refused
  // scripts/dev-ports.sh — a script that prints two port numbers and exits.
  // It would have blocked the task whose whole job was editing that script.
  for (const c of [
    'bash scripts/dev-ports.sh',
    'sh scripts/dev-setup.sh',
    'bash scripts/devtools.sh',
  ]) {
    assert.equal(decide(c, WORKTREE).decision, 'allow', c);
  }
});

test('the real dev runner is still refused', () => {
  for (const c of ['bash scripts/dev.sh', 'sh ./start.sh']) {
    assert.equal(decide(c, WORKTREE).decision, 'deny', c);
  }
});

test('the main working tree is out of scope — its server is a different problem', () => {
  assert.equal(decide('node server/index.mjs', REGISTERED).decision, 'allow');
  assert.equal(decide('npm run dev', REGISTERED).decision, 'allow');
});

test('an unregistered project is none of this guard\'s business', () => {
  assert.equal(decide('npm run dev', UNREG_WORKTREE).decision, 'allow');
});

test('a cd anywhere stands the guard down rather than guessing where it runs', () => {
  assert.equal(decide('cd /tmp && npm run dev', WORKTREE).decision, 'allow');
});

test('unbalanced quotes fail open', () => {
  assert.equal(decide('npm run "dev', WORKTREE).decision, 'allow');
});

test('a non-Bash tool is ignored', () => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, cwd: WORKTREE }),
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME },
  });
  assert.equal((r.stdout || '').trim(), '');
});

// --- task 197: no kill by name, anywhere -------------------------------------
// pkill / killall cannot tell a worktree's dev server from the always-on
// portal, so every one is refused — in a worktree, the main checkout, an
// unregistered repo, after a cd. Text that only mentions them passes.

test('refuses pkill and killall everywhere, however they are spelled', () => {
  const places = [WORKTREE, REGISTERED, UNREG_WORKTREE, ROOT];
  const cmds = ['pkill -f server/index.mjs', 'killall node', '/usr/bin/pkill node', 'sudo pkill -9 node',
    'pgrep node | xargs pkill', 'npm test; pkill -f vite', 'cd /tmp && pkill node', 'timeout 5 killall node',
    'FOO=1 pkill node', 'echo $(pkill node)', '(pkill node)', 'nohup killall node &'];
  for (const cwd of places) {
    for (const c of cmds) assert.equal(decide(c, cwd).decision, 'deny', `${c} in ${cwd}`);
  }
});

test('the kill-by-name refusal names the safe ways: by port, by PID, preview_stop', () => {
  const { reason } = decide('pkill -f server/index.mjs', REGISTERED);
  assert.match(reason, /Kill-by-name guard: `pkill` is refused/);
  assert.match(reason, /lsof -ti:<port> \| xargs kill/);
  assert.match(reason, /kill <pid>/);
  assert.match(reason, /preview_stop/);
});

test('kill by PID or port, and text that only mentions pkill, pass', () => {
  for (const c of ['kill 12345', 'lsof -ti:30002 | xargs kill', 'git commit -m "never pkill the portal"',
    'echo "use pkill? no"', 'grep -n pkill hooks/*.sh', 'man pkill',
    "cat <<'EOF' > notes.md\npkill node\nEOF"]) {
    assert.equal(decide(c, REGISTERED).decision, 'allow', c);
  }
});
