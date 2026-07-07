import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../core/doctor.mjs';

// A fully-healthy injected context. Each test overrides one field to drive a check.
const healthy = () => ({
  nodeVersion: '22.4.0',
  gitVersion: () => 'git version 2.45.0',
  home: '/home/u/.cogyard',
  homeWritable: () => true,
  config: null,                       // absent config = all defaults = ok
  projectsRoot: '/home/u/gitroot',
  rootExists: () => true,
  registry: [{ slug: 'a', path: '/p/a', label: 'a' }],
  driver: { active: 'claude', available: ['claude'] },
  frontendBuilt: () => true,
  portFree: () => true,
});

const byId = (report, id) => report.checks.find((c) => c.id === id);

test('healthy machine: every check ok, report.ok, exit-0 semantics', () => {
  const r = runDoctor(healthy());
  assert.equal(r.ok, true);
  assert.equal(r.counts.fail, 0);
  assert.ok(r.checks.length >= 9);
  for (const c of r.checks) {
    assert.equal(c.status, 'ok', `${c.id} should be ok on a healthy machine`);
    assert.ok(['ok', 'warn', 'fail'].includes(c.status));
    assert.ok(typeof c.id === 'string' && typeof c.label === 'string');
  }
});

test('node below the engines floor fails', () => {
  const r = runDoctor({ ...healthy(), nodeVersion: '18.19.0' });
  assert.equal(byId(r, 'node').status, 'fail');
  assert.equal(r.ok, false);
  assert.ok(byId(r, 'node').fix, 'a fail must carry a fix line');
});

test('missing git fails', () => {
  const r = runDoctor({ ...healthy(), gitVersion: () => null });
  assert.equal(byId(r, 'git').status, 'fail');
  assert.equal(r.ok, false);
});

test('unwritable home fails', () => {
  const r = runDoctor({ ...healthy(), homeWritable: () => false });
  assert.equal(byId(r, 'home').status, 'fail');
  assert.equal(r.ok, false);
});

test('empty registry warns but does not fail', () => {
  const r = runDoctor({ ...healthy(), registry: [] });
  assert.equal(byId(r, 'registry').status, 'warn');
  assert.equal(r.ok, true, 'a fresh, unconfigured machine is runnable → no fail');
});

test('no driver detected warns (cost will be null), still runnable', () => {
  const r = runDoctor({ ...healthy(), driver: { active: null, available: [] } });
  assert.equal(byId(r, 'driver').status, 'warn');
  assert.equal(r.ok, true);
});

test('unbuilt frontend warns (first serve builds it)', () => {
  const r = runDoctor({ ...healthy(), frontendBuilt: () => false });
  assert.equal(byId(r, 'frontend').status, 'warn');
  assert.equal(r.ok, true);
});

test('missing projects-root warns (it is only a default), not a fail', () => {
  const r = runDoctor({ ...healthy(), rootExists: () => false });
  assert.equal(byId(r, 'projects-root').status, 'warn');
  assert.equal(r.ok, true);
});

test('busy serve port warns', () => {
  const r = runDoctor({ ...healthy(), portFree: () => false });
  assert.equal(byId(r, 'port').status, 'warn');
  assert.equal(r.ok, true);
});

test('unparseable / unknown-driver config warns', () => {
  const r = runDoctor({ ...healthy(), config: { driver: 'does-not-exist' } });
  assert.equal(byId(r, 'config').status, 'warn');
  assert.equal(r.ok, true);
});

test('multiple fails are all reported, counts are accurate', () => {
  const r = runDoctor({ ...healthy(), nodeVersion: '18.0.0', gitVersion: () => null });
  assert.equal(byId(r, 'node').status, 'fail');
  assert.equal(byId(r, 'git').status, 'fail');
  assert.equal(r.counts.fail, 2);
  assert.equal(r.ok, false);
});
