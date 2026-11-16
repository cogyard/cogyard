import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, ENGINE_HOOKS } from '../core/doctor.mjs';

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
  // A healthy machine has every engine hook wired. Registered in the CLI form
  // here; the absolute-path form is covered by its own test below.
  agentHookCommands: ENGINE_HOOKS.map((h) => `cogyard hook ${h.name}`),
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

test('a project with a problem (e.g. still on the old _tasks) warns and names it, not "no projects"', () => {
  const r = runDoctor({ ...healthy(), registry: [
    { slug: 'a', path: '/p/a', label: 'a' },
    { slug: 'old', path: '/p/old', label: 'old', error: 'old task folder _tasks/, which cogyard no longer reads — run `cogyard tasks convert` in the project to move it into a shared task store' },
  ] });
  const c = byId(r, 'registry');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /2 project\(s\), 1 with a problem: old — old task folder _tasks\//);
  assert.doesNotMatch(c.detail, /no projects registered/);
  assert.equal(r.ok, true, 'a project with a problem is a warning, not a broken machine');
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


// --- agent hooks ------------------------------------------------------------

test('a missing hook is named, not just counted', () => {
  const commands = ENGINE_HOOKS
    .filter((h) => h.name !== 'guard-dev-server')
    .map((h) => `cogyard hook ${h.name}`);
  const r = runDoctor({ ...healthy(), agentHookCommands: commands });
  const c = byId(r, 'hooks');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /dev-server guard/);
  assert.ok(c.fix, 'a warn must carry a fix line');
  assert.equal(r.ok, true, 'unwired hooks are incomplete, not unrunnable');
});

test('a machine missing the live-state hook is told so — the status line would stay "no live signal"', () => {
  const commands = ENGINE_HOOKS.filter((h) => h.name !== 'live-state').map((h) => `cogyard hook ${h.name}`);
  const c = byId(runDoctor({ ...healthy(), agentHookCommands: commands }), 'hooks');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /live agent state/);
  const byPath = [...commands, 'node /repo/hooks/live-state.mjs'];
  assert.equal(byId(runDoctor({ ...healthy(), agentHookCommands: byPath }), 'hooks').status, 'ok');
});

test('hooks registered by absolute path count as wired', () => {
  // A hand-wired install points straight at the files instead of the CLI. That
  // is a legitimate install and must not be reported as missing.
  const commands = ENGINE_HOOKS.map((h) => `/Users/someone/gitroot/cogyard/hooks/${h.file}.mjs`);
  const r = runDoctor({ ...healthy(), agentHookCommands: commands });
  assert.equal(byId(r, 'hooks').status, 'ok');
});

test('an unreadable settings file is reported as unverified, never as clean', () => {
  const r = runDoctor({ ...healthy(), agentHookCommands: null });
  const c = byId(r, 'hooks');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /couldn't read/);
});

test('no active agent means there is nothing to wire', () => {
  const r = runDoctor({
    ...healthy(),
    driver: { active: null, available: [] },
    agentHookCommands: null,
  });
  assert.equal(byId(r, 'hooks').status, 'ok');
});

test('every engine hook has a name, a file stem, and a human label', () => {
  for (const h of ENGINE_HOOKS) {
    assert.ok(h.name && h.file && h.label, `incomplete entry: ${JSON.stringify(h)}`);
  }
});
