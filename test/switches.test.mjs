// test/switches.test.mjs — a project's switches (task 246): defaults with no
// file, each valid value, invalid values dropped on read and refused on write,
// the package.json default for `version` both ways, and that a store holding
// switches.json is not flagged.
//
// Throwaway project dirs only; the task store is a plain .cogyard/tasks folder.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveSwitches, switchDefaults, readProjectSwitches, switchProblems, validateSwitches, writeProjectSwitches } from '../core/switches.mjs';
import { classifyStorePath, auditCommit, pendingFlags } from '../core/store-audit.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function project({ npm = false } = {}) {
  const p = mkdtempSync(join(tmpdir(), 'cogyard-switches-'));
  dirs.push(p);
  mkdirSync(join(p, '.cogyard', 'tasks'), { recursive: true });
  if (npm) writeFileSync(join(p, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  return p;
}
const fileOf = (p) => join(p, '.cogyard', 'tasks', 'switches.json');
const put = (p, body) => writeFileSync(fileOf(p), typeof body === 'string' ? body : JSON.stringify(body));

test('no file, root package.json → rebase always, version minor, decisions_log off, all defaults', () => {
  const p = project({ npm: true });
  assert.deepEqual(resolveSwitches(p), {
    rebase: { value: 'always', set: false },
    version: { value: 'minor', set: false, file: 'package.json' },
    decisions_log: { value: null, set: false },
  });
});

test('no file, no root package.json → version off, no counter file', () => {
  const p = project();
  assert.deepEqual(resolveSwitches(p).version, { value: 'off', set: false, file: null });
});

test('switchDefaults says what an unset switch is, whatever the file sets', () => {
  const npm = project({ npm: true });
  put(npm, { rebase: 'ask', version: 'off', decisions_log: 'docs/DECISIONS.md' });
  assert.deepEqual(switchDefaults(npm), { rebase: 'always', version: 'minor', decisions_log: null });
  assert.deepEqual(switchDefaults(project()), { rebase: 'always', version: 'off', decisions_log: null });
});

test('decisions_log: a path inside the repo is read back set (trimmed); anything else is dropped or refused', () => {
  const p = project();
  put(p, { decisions_log: ' docs/DECISIONS.local.md ' });
  assert.deepEqual(resolveSwitches(p).decisions_log, { value: 'docs/DECISIONS.local.md', set: true });
  assert.deepEqual(readProjectSwitches(p), { decisions_log: 'docs/DECISIONS.local.md' });
  for (const bad of ['', '   ', '/etc/DECISIONS.md', '../other/DECISIONS.md', 'docs/../../x.md', 7, true, { path: 'x' }]) {
    put(p, { decisions_log: bad });
    assert.deepEqual(resolveSwitches(p).decisions_log, { value: null, set: false }, JSON.stringify(bad));
    assert.equal(switchProblems(p).length, 1, JSON.stringify(bad));
    assert.equal(writeProjectSwitches(p, { decisions_log: bad }).ok, false, JSON.stringify(bad));
  }
  // null unsets it — the check goes back to off.
  writeProjectSwitches(p, { decisions_log: 'docs/DECISIONS.md' });
  assert.equal(resolveSwitches(p).decisions_log.value, 'docs/DECISIONS.md');
  writeProjectSwitches(p, { decisions_log: null });
  assert.deepEqual(resolveSwitches(p).decisions_log, { value: null, set: false });
});

test('each valid value is read back and marked set', () => {
  const p = project({ npm: true });
  for (const rebase of ['always', 'ask']) {
    put(p, { rebase });
    assert.deepEqual(resolveSwitches(p).rebase, { value: rebase, set: true });
  }
  for (const version of ['off', 'minor', 'patch']) {
    put(p, { version });
    const v = resolveSwitches(p).version;
    assert.equal(v.value, version);
    assert.equal(v.set, true);
    assert.equal(v.file, version === 'off' ? null : 'package.json');
  }
  put(p, { version: { command: 'poetry version minor', file: 'pyproject.toml' } });
  assert.deepEqual(resolveSwitches(p).version,
    { value: { command: 'poetry version minor', file: 'pyproject.toml' }, set: true, file: 'pyproject.toml' });
});

test('version off set explicitly in an npm project wins over the package.json default', () => {
  const p = project({ npm: true });
  put(p, { version: 'off' });
  assert.deepEqual(resolveSwitches(p).version, { value: 'off', set: true, file: null });
});

test('invalid values and unknown keys are dropped on read — the default applies, nothing throws', () => {
  const p = project({ npm: true });
  put(p, { rebase: 'sometimes', version: 'major', deploy: 'yes' });
  assert.deepEqual(resolveSwitches(p), {
    rebase: { value: 'always', set: false },
    version: { value: 'minor', set: false, file: 'package.json' },
    decisions_log: { value: null, set: false },
  });
  assert.deepEqual(readProjectSwitches(p), {});
  put(p, { version: { command: '', file: 'x' } });
  assert.equal(resolveSwitches(p).version.set, false);
  put(p, { version: { command: 'x', file: '../outside' } });
  assert.equal(resolveSwitches(p).version.set, false);
  for (const bad of ['{not json', '[1,2]', '"string"', 'null']) {
    put(p, bad);
    assert.equal(resolveSwitches(p).rebase.value, 'always', bad);
  }
  assert.deepEqual(resolveSwitches(null).rebase, { value: 'always', set: false });
});

test('switchProblems names each ignored entry, and nothing when the file is fine or absent', () => {
  const p = project({ npm: true });
  assert.deepEqual(switchProblems(p), []);
  put(p, { rebase: 'ask' });
  assert.deepEqual(switchProblems(p), []);
  put(p, { rebase: 'sometimes', deploy: 'yes' });
  const probs = switchProblems(p);
  assert.equal(probs.length, 2);
  assert.ok(probs.some((x) => x.startsWith('rebase must be one of')));
  assert.ok(probs.some((x) => x.startsWith('unknown switch: deploy')));
  put(p, '{not json');
  assert.match(switchProblems(p)[0], /not valid JSON/);
  put(p, '[1]');
  assert.match(switchProblems(p)[0], /not a JSON object/);
});

test('one good and one bad key: the good one is kept', () => {
  const p = project({ npm: true });
  put(p, { rebase: 'ask', version: 7 });
  const r = resolveSwitches(p);
  assert.deepEqual(r.rebase, { value: 'ask', set: true });
  assert.equal(r.version.set, false);
  assert.deepEqual(readProjectSwitches(p), { rebase: 'ask' });
});

test('write refuses an invalid entry with a reason and writes nothing', () => {
  const p = project();
  for (const bad of [
    { rebase: 'never' },
    { version: 'major' },
    { version: { command: 'x' } },
    { version: { command: 'x', file: '/etc/passwd' } },
    { merge: 'squash' },
    'not an object',
    [],
  ]) {
    const r = writeProjectSwitches(p, bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.length && r.errors.every((e) => typeof e === 'string' && e), JSON.stringify(bad));
    assert.equal(existsSync(fileOf(p)), false, JSON.stringify(bad));
  }
});

test('write keeps only set values; null unsets back to the default', () => {
  const p = project({ npm: true });
  const r = writeProjectSwitches(p, { rebase: 'ask', version: { command: ' cargo set-version --bump minor ', file: 'Cargo.toml' } });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(fileOf(p), 'utf8')),
    { rebase: 'ask', version: { command: 'cargo set-version --bump minor', file: 'Cargo.toml' } });
  writeProjectSwitches(p, { rebase: null });
  assert.deepEqual(JSON.parse(readFileSync(fileOf(p), 'utf8')), {});
  assert.deepEqual(resolveSwitches(p).rebase, { value: 'always', set: false });
  assert.deepEqual(validateSwitches({ rebase: null, version: null }), { ok: true, switches: {} });
});

test('a store holding switches.json is not flagged', () => {
  assert.equal(classifyStorePath('switches.json'), 'allowed');
  assert.deepEqual(auditCommit('[#246] switches', [{ status: 'A', path: 'switches.json' }]).flags, []);
  assert.deepEqual(pendingFlags([{ path: 'switches.json', status: '?', cls: classifyStorePath('switches.json'), mtimeMs: Date.now() }]).flags, []);
  assert.equal(classifyStorePath('files/switches.json'), 'other');
});
