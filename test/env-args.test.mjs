// test/env-args.test.mjs — `cogyard env` argument handling (task 209):
// `<subcommand> --help` prints usage before any argument is used, a missing
// task file is a one-line error, and port-owner refuses a non-port.
//
// Runs in a throwaway directory with a throwaway $COGYARD_HOME; no task file
// is ever claimed or released.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'env.mjs');
const root = mkdtempSync(join(tmpdir(), 'cogyard-env-args-'));
after(() => rmSync(root, { recursive: true, force: true }));
const run = (...args) => spawnSync('node', [ENV, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: join(root, 'home') } });

for (const args of [['release', '--help'], ['claim', '--help'], ['claim', '--help', 'sess-1'], ['port-owner', '--help'], ['ports', '--help'], ['where', '-h'], ['detect', '-h']]) {
  test(`env ${args.join(' ')} prints usage and exits 0`, () => {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^env\.mjs — environment detection/);
    assert.equal(r.stderr, '');
  });
}

const missing = join(root, 'does-not-exist.md');
for (const args of [['release', missing], ['claim', missing, 'sess-1'], ['where', missing]]) {
  test(`env ${args[0]} with a task file that does not exist fails in one line naming it`, () => {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `env.mjs: no such task file: ${missing}\n`);
    assert.equal(r.stdout, '');
  });
}

for (const port of ['abc', '0', '70000', '1; true']) {
  test(`env port-owner "${port}" fails with its usage line`, () => {
    const r = run('port-owner', port);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^env\.mjs: usage: env\.mjs port-owner <port>/);
    assert.equal(r.stdout, '');
  });
}
