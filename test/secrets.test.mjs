// test/secrets.test.mjs — the credential store (task 127).
//
// Covers parsing (comments, quotes, blank lines, `export ` prefix), the
// absent-file no-op, an existing environment value winning over the file, and
// the loud refusal of a file other users can read.
//
// COGYARD_HOME is pointed at a throwaway temp dir BEFORE importing the module
// (same pattern as config.test.mjs / addons.test.mjs; the Node test runner
// isolates each file in its own process, so this never touches the real
// ~/.cogyard). Every credential here is an obviously-fake literal — nothing in
// this repo, fixtures included, may carry a real one.
//
// NOTE ON WHAT IS NOT TESTED HERE: no test asserts that a value round-trips
// through an API response, because no API response may ever carry one. The
// wire-side property — a secret field never leaks its value through
// /api/addons — is asserted in test/addons.test.mjs, where the manifest lives.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-secrets-'));
process.env.COGYARD_HOME = HOME;
const SECRETS = join(HOME, 'secrets.env');

const { SECRETS_PATH, parseSecretsEnv, loadSecrets, hasSecret, secretNames, secretsStatus, resetSecrets } =
  await import('../core/secrets.mjs');

// Names used across the tests, so cleanup can be exhaustive: a leaked
// process.env entry would make a later test pass for the wrong reason.
const NAMES = ['FAKE_TOKEN', 'FAKE_OTHER', 'FAKE_QUOTED', 'FAKE_SINGLE', 'FAKE_EXPORTED', 'FAKE_EMPTY', 'FAKE_SPACES', 'FAKE_HASH'];

function write(text, mode = 0o600) {
  writeFileSync(SECRETS, text);
  chmodSync(SECRETS, mode);
}

function clear() {
  if (existsSync(SECRETS)) rmSync(SECRETS);
  for (const n of NAMES) delete process.env[n];
  resetSecrets();
}

before(() => clear());
beforeEach(() => clear());
after(() => { clear(); rmSync(HOME, { recursive: true, force: true }); });

// --- paths --------------------------------------------------------------------

test('SECRETS_PATH resolves under the redirected COGYARD_HOME', () => {
  assert.equal(SECRETS_PATH, SECRETS);
});

// --- parsing ------------------------------------------------------------------

test('parse: KEY=value, comments, and blank lines', () => {
  const { entries, badLines } = parseSecretsEnv([
    '# the credential store',
    '',
    'FAKE_TOKEN=not-a-real-token',
    '   ',
    '# trailing comment line',
    'FAKE_OTHER=second',
  ].join('\n'));
  assert.deepEqual([...entries.keys()], ['FAKE_TOKEN', 'FAKE_OTHER']);
  assert.equal(entries.get('FAKE_TOKEN'), 'not-a-real-token');
  assert.deepEqual(badLines, []);
});

test('parse: quoted values keep spaces; double quotes unescape, single quotes are literal', () => {
  const { entries } = parseSecretsEnv([
    'FAKE_QUOTED="two words"',
    'FAKE_SINGLE=\'literal \\n stays\'',
    'FAKE_SPACES="line\\nbreak"',
  ].join('\n'));
  assert.equal(entries.get('FAKE_QUOTED'), 'two words');
  assert.equal(entries.get('FAKE_SINGLE'), 'literal \\n stays');
  assert.equal(entries.get('FAKE_SPACES'), 'line\nbreak');
});

test('parse: an `export ` prefix is accepted (a line copied out of a shell profile)', () => {
  const { entries } = parseSecretsEnv('export FAKE_EXPORTED=from-a-profile');
  assert.equal(entries.get('FAKE_EXPORTED'), 'from-a-profile');
});

test('parse: an unquoted value keeps everything after the `=`, including a `#`', () => {
  // Deliberate divergence from dotenv: truncating an opaque credential at a `#`
  // it happens to contain produces an auth failure nobody can explain.
  const { entries } = parseSecretsEnv('FAKE_HASH=abc#def');
  assert.equal(entries.get('FAKE_HASH'), 'abc#def');
});

test('parse: malformed lines are reported by NUMBER and skipped, never by content', () => {
  const { entries, badLines } = parseSecretsEnv([
    'FAKE_TOKEN=fine',
    'no-equals-sign-here',
    '9BAD_NAME=x',
    '=novalue',
  ].join('\n'));
  assert.deepEqual([...entries.keys()], ['FAKE_TOKEN']);
  assert.deepEqual(badLines, [2, 3, 4]);
});

// --- loading ------------------------------------------------------------------

test('load: no file is a no-op, not an error', () => {
  const r = loadSecrets();
  assert.equal(r.ok, true);
  assert.equal(r.present, false);
  assert.deepEqual(r.loaded, []);
  assert.equal(hasSecret('FAKE_TOKEN'), false);
});

test('load: values reach process.env, so a spawned child inherits them', () => {
  write('FAKE_TOKEN=not-a-real-token\n');
  const r = loadSecrets();
  assert.equal(r.ok, true);
  assert.deepEqual(r.loaded, ['FAKE_TOKEN']);
  assert.equal(process.env.FAKE_TOKEN, 'not-a-real-token');
  assert.equal(hasSecret('FAKE_TOKEN'), true);
});

test('load: an existing environment value wins over the file', () => {
  process.env.FAKE_TOKEN = 'from-the-shell';
  write('FAKE_TOKEN=from-the-file\n');
  const r = loadSecrets();
  assert.equal(process.env.FAKE_TOKEN, 'from-the-shell');
  assert.deepEqual(r.skipped, ['FAKE_TOKEN']);
  assert.deepEqual(r.loaded, []);
});

test('load: a name set to the empty string does NOT count as set', () => {
  // An accidental `export TOKEN=` must not shadow the real credential.
  process.env.FAKE_EMPTY = '';
  write('FAKE_EMPTY=real-value\n');
  loadSecrets();
  assert.equal(process.env.FAKE_EMPTY, 'real-value');
  assert.equal(hasSecret('FAKE_EMPTY'), true);
});

test('load: is cached — the second call does not re-read disk', () => {
  write('FAKE_TOKEN=first\n');
  loadSecrets();
  write('FAKE_OTHER=second\n');
  const again = loadSecrets();
  assert.deepEqual(again.loaded, ['FAKE_TOKEN']);
  assert.equal(process.env.FAKE_OTHER, undefined);
  // …and force re-reads.
  const forced = loadSecrets({ force: true });
  assert.deepEqual(forced.loaded, ['FAKE_OTHER']);
});

// --- the refusal --------------------------------------------------------------

test('load: a file other users can read is REFUSED, with the exact chmod fix', () => {
  write('FAKE_TOKEN=not-a-real-token\n', 0o644);
  const r = loadSecrets();
  assert.equal(r.ok, false);
  assert.match(r.error, /readable by other users/);
  assert.equal(r.fix, `chmod 600 ${SECRETS}`);
  // Refused means NOTHING loaded — not "warned and loaded anyway".
  assert.equal(process.env.FAKE_TOKEN, undefined);
  assert.equal(hasSecret('FAKE_TOKEN'), false);
});

test('load: a group-readable file is refused too (0640)', () => {
  write('FAKE_TOKEN=not-a-real-token\n', 0o640);
  assert.equal(loadSecrets().ok, false);
  assert.equal(process.env.FAKE_TOKEN, undefined);
});

test('status: reports the refusal so a card can explain WHY a credential reads as missing', () => {
  write('FAKE_TOKEN=not-a-real-token\n', 0o644);
  const bad = secretsStatus();
  assert.equal(bad.ok, false);
  assert.equal(bad.present, true);
  assert.match(bad.fix, /^chmod 600 /);
  assert.deepEqual(bad.names, []);

  // …and re-reads, so the printed fix takes effect without a restart.
  chmodSync(SECRETS, 0o600);
  const good = secretsStatus();
  assert.equal(good.ok, true);
  assert.deepEqual(good.names, ['FAKE_TOKEN']);
  assert.equal(hasSecret('FAKE_TOKEN'), true);
});

// --- the read surface ---------------------------------------------------------

test('secretNames: names only, sorted', () => {
  write('FAKE_OTHER=b\nFAKE_TOKEN=a\n');
  assert.deepEqual(secretNames(), ['FAKE_OTHER', 'FAKE_TOKEN']);
});

test('hasSecret: rejects a name that is not a legal environment-variable name', () => {
  assert.equal(hasSecret('not a name'), false);
  assert.equal(hasSecret(''), false);
  assert.equal(hasSecret(null), false);
});

test('no exported function returns a value', () => {
  // The module contract, asserted mechanically: everything the rest of cogyard
  // can call is a name, a boolean, or a report — a value only ever lands in
  // process.env. If a future export starts returning one, this fails.
  write('FAKE_TOKEN=not-a-real-token\n');
  const surfaces = [loadSecrets(), secretsStatus(), secretNames(), hasSecret('FAKE_TOKEN')];
  assert.ok(!JSON.stringify(surfaces).includes('not-a-real-token'));
});
