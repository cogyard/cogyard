// test/cli-help.test.mjs — `cogyard <command> <subcommand> --help` prints help
// and exits 0 for EVERY command, before the subcommand runs (task 209). Several
// used to do the action instead: `tunnel disable --help` stopped the tunnel,
// `cleanup disk --help` deleted build folders, `claude install --help`
// installed the skills.
//
// The command list is read from `cogyard --help`, so a command added there is
// covered without editing this file. Everything runs with a throwaway HOME,
// $COGYARD_HOME and $CLAUDE_CONFIG_DIR, in a throwaway non-repo directory, so a
// regression cannot touch this machine's real state.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COGYARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'cogyard.mjs');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-cli-help-')));
after(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home'), claudeDir = join(root, 'claude'), cwd = join(root, 'cwd');
mkdirSync(home); mkdirSync(cwd);
const run = (...args) => spawnSync('node', [COGYARD, ...args], {
  cwd, encoding: 'utf8',
  env: { ...process.env, HOME: home, COGYARD_HOME: join(home, '.cogyard'), CLAUDE_CONFIG_DIR: claudeDir, PORT: '1' },
});

// "  <name>   …" lines in the top-level usage list.
const COMMANDS = [...run('--help').stdout.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]);

test('the command list was read from cogyard --help', () => {
  for (const c of ['tasks', 'env', 'tunnel', 'usage', 'sessions', 'cleanup', 'claude', 'doctor', 'publish', 'init', 'onboard', 'serve', 'hook']) {
    assert.ok(COMMANDS.includes(c), `${c} missing from ${COMMANDS.join(', ')}`);
  }
});

// Every command, with a made-up subcommand and both spellings of the flag.
const cases = COMMANDS.flatMap((c) => [[c, 'any-subcommand', '--help'], [c, 'any-subcommand', '-h']]);
// The real subcommands that used to perform their action, named so the record is explicit.
cases.push(
  ['tunnel', 'disable', '--help'], ['tunnel', 'here', '--help'], ['tunnel', 'status', '--help'], ['tunnel', 'enable', '--help'],
  ['cleanup', 'disk', '--help'], ['cleanup', 'worktrees', '--help'], ['cleanup', 'chat', '--help'],
  ['claude', 'install', '--help'], ['claude', 'uninstall', '--help'],
  ['usage', 'collect', '--help'], ['usage', 'backfill', '--help'], ['usage', 'reprice', '--help'],
  ['usage', 'pricing', '--help'], ['usage', 'report', '--help'],
  ['sessions', 'archivable', '--help'], ['sessions', 'chats', '--help'], ['sessions', 'find', '--help'],
  ['hook', 'session-start', '--help'], ['serve', '--help'], ['doctor', '--help'],
);

for (const args of cases) {
  test(`cogyard ${args.join(' ')} prints help and exits 0`, () => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(args[0]), `help should name "${args[0]}":\n${r.stdout}`);
    assert.equal(r.stderr, '');
  });
}

test('cogyard doctor --help prints its usage, not the doctor report', () => {
  const r = run('doctor', '--help');
  assert.match(r.stdout, /^Usage: cogyard doctor$/m);
  assert.doesNotMatch(r.stdout, /\d+ ok · \d+ warn · \d+ fail/);
});

test('cogyard --version and -v print the package version', () => {
  const { version } = JSON.parse(readFileSync(join(dirname(COGYARD), '..', 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const r = run(flag);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `cogyard ${version}\n`);
  }
});

test('nothing was installed or written while asking for help', () => {
  assert.deepEqual(readdirSync(home).filter((f) => f !== '.cogyard'), []);
  assert.throws(() => readdirSync(claudeDir), /ENOENT/, 'claude install --help must not create the skills folder');
});
