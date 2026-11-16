// test/git-identity.test.mjs — store commits on a machine where git has no
// author identity.
//
// The bug this exists to prevent (task 245): a fresh machine with no git
// user.name / user.email ran `cogyard init` fine (it had its own fallback) and
// then died on its first `sync push` with git's "Author identity unknown" and a
// Node stack trace. Every store commit now fills in only what git can't find,
// with a neutral cogyard value, and an identity the user configured always wins.
//
// "No identity" is made the same way on every machine: no global or system
// config, an empty HOME, and user.useConfigOnly so git never guesses one from
// the hostname (a container has no domain name, so it can't guess either).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// A human's shell with no git identity anywhere: never the chat running the
// tests (a plain push decides what to commit by which chat is pushing).
function noIdentityEnv(home) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_PROJECT_DIR'].includes(k)
      && !/^GIT_(AUTHOR|COMMITTER)_/.test(k)));
  return {
    ...env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true',
  };
}

// A store (its own repo, no commits yet) holding one task file, and a project
// whose `.cogyard/tasks` links to it: the shared-store shape a new user gets.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-identity-')));
  dirs.push(root);
  const home = join(root, 'home'), store = join(root, 'store'), repo = join(root, 'repo');
  for (const d of [home, store, repo]) mkdirSync(d);
  const env = noIdentityEnv(home);
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(store, ['init', '-q', '-b', 'tasks']);
  git(repo, ['init', '-q', '-b', 'main']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(store, join(repo, '.cogyard', 'tasks'));
  writeFileSync(join(store, '001-one.md'),
    ['---', 'id: 1', 'slug: one', 'title: one', 'status: OPEN', 'type: bug', '---', '', '# 1', ''].join('\n'));
  const push = () => spawnSync('node', [CLI, 'sync', 'push', 'add one', '--', '.cogyard/tasks/001-one.md'],
    { cwd: repo, env, encoding: 'utf8' });
  const author = () => git(store, ['log', '-1', '--format=%an <%ae>']);
  return { store, env, git, push, author };
}

test('sync push with no git identity commits as cogyard, with no stack trace', () => {
  const f = fixture();
  const r = f.push();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Author identity unknown|^\s+at /m);
  assert.equal(f.author(), 'cogyard <cogyard@localhost>');
});

test('an identity the user configured is used, never the fallback', () => {
  const f = fixture();
  f.git(f.store, ['config', 'user.name', 'Pat Example']);
  f.git(f.store, ['config', 'user.email', 'pat@example.com']);
  assert.equal(f.push().status, 0);
  assert.equal(f.author(), 'Pat Example <pat@example.com>');
});

test('only the missing half is filled in', () => {
  const f = fixture();
  f.git(f.store, ['config', 'user.name', 'Pat Example']);
  assert.equal(f.push().status, 0);
  assert.equal(f.author(), 'Pat Example <cogyard@localhost>');
});
