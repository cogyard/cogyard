// test/scaffold-kind-dev-entries.test.mjs — a kind names its dev entry (task 164).
//
// Task 162 let a kind name its dev COMMAND; the launch entry's name and the port
// its preview tab opens on stayed fixed in core/scaffold.mjs ('dev',
// 'FRONTEND_PORT'), so a preview server that binds $PORT could not be described.
// `launchName` and `previewPortVar` close that gap. Their defaults are the old
// fixed values, so every built-in kind still writes the same file. Runs the real
// wiring engine against throwaway dirs with their own COGYARD_HOME and
// COGYARD_PROJECTS_ROOT, set BEFORE import (the registry resolves at import).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-kind-dev-entries-')));
const HOME = join(ROOT, 'home');
const PROJECTS = join(ROOT, 'projects');
mkdirSync(PROJECTS, { recursive: true });
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = PROJECTS;

function install(kind, body) {
  mkdirSync(join(HOME, 'scaffolds', kind), { recursive: true });
  writeFileSync(join(HOME, 'scaffolds', kind, 'scaffold.mjs'), `export const scaffold = {
  kind: '${kind}', description: '${kind}', worktreePorts: true, versionStamp: false,
  pkgJson(slug) { return { name: slug, version: '0.1.0' }; },
  skeletonFiles(slug) { return { 'README.md': '# ' + slug }; },
  ${body}
};
`);
}
install('backend-preview', "devScript: 'npm run preview', launchName: 'preview', previewPortVar: 'PORT',");
install('bad-launch-name', "launchName: 'has space',");
install('bad-port-var', "previewPortVar: 'API_PORT',");
install('two-servers', `devScript: 'npm run preview', launchName: 'preview', previewPortVar: 'PORT',
  extraDevScripts: [{ devScript: 'npm run site', launchName: 'site', previewPortVar: 'FRONTEND_PORT' },
                    { devScript: 'npm run docs', launchName: 'docs' }],`);
install('extra-same-name', "launchName: 'preview', extraDevScripts: [{ devScript: 'npm run x', launchName: 'preview' }],");
install('extra-no-name', "extraDevScripts: [{ devScript: 'npm run x' }],");
install('extra-no-dev', "devScript: null, extraDevScripts: [{ devScript: 'npm run x', launchName: 'x' }],");
install('extra-not-list', "extraDevScripts: 'npm run x',");

const { ensureProjectWiring } = await import('../core/scaffold.mjs');
const { KINDS } = await import('../core/scaffolds/index.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

function wire(kind, name = `demo-${kind}`) {
  const dir = join(PROJECTS, name);
  mkdirSync(dir, { recursive: true });
  ensureProjectWiring({ path: dir, kind, scaffold: true });
  return readFileSync(join(dir, '.cogyard', 'worktree.json'), 'utf8');
}

test('a kind naming its launch entry and preview port gets both in the config', () => {
  const cfg = JSON.parse(wire('backend-preview'));
  assert.equal(cfg.dev_script, 'npm run preview');
  assert.equal(cfg.launch_name, 'preview');
  assert.equal(cfg.preview_port_var, 'PORT');
  assert.equal(cfg.port_vars[cfg.preview_port_var], 'backend', 'the preview resolves to the backend port');
});

test('the built-in kinds still write the old file, byte for byte', () => {
  for (const k of ['single', 'fullstack', 'static']) {
    const slug = `bytes-${k}`;
    const expected = JSON.stringify({
      _comment: "Worktree port wiring (cogyard). Every worktree gets its own reserved ports, and ~/.cogyard/ports.json is the ONLY place they exist. Your `npm run dev` MUST ask for them at runtime — eval \"$(cogyard env ports --shell || echo 'exit 1')\" — and must never read a copy out of a file: a copy rots, and a rotted copy is how two worktrees silently bind one port. The `|| echo 'exit 1'` is load-bearing, because eval reports its own status and not the command's. See docs/PROJECT-INIT.md.",
      project_name: slug,
      dev_script: 'npm run dev',
      launch_name: 'dev',
      port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
      preview_port_var: 'FRONTEND_PORT',
    }, null, 2) + '\n';
    assert.equal(wire(k, slug), expected, k);
  }
});

test('a kind naming further commands gets one extra_dev_scripts entry each, after the first', () => {
  const cfg = JSON.parse(wire('two-servers'));
  assert.equal(cfg.dev_script, 'npm run preview');
  assert.deepEqual(cfg.extra_dev_scripts, [
    { dev_script: 'npm run site', launch_name: 'site', preview_port_var: 'FRONTEND_PORT' },
    { dev_script: 'npm run docs', launch_name: 'docs', preview_port_var: 'FRONTEND_PORT' },
  ], 'an omitted preview port is FRONTEND_PORT, as for the first command');
  assert.match(cfg._comment, /Your `npm run preview`, `npm run site` and `npm run docs` MUST ask/);
  assert.deepEqual(Object.keys(cfg), ['_comment', 'project_name', 'dev_script', 'launch_name', 'port_vars', 'preview_port_var', 'extra_dev_scripts']);
});

test('a kind with one command writes no extra_dev_scripts key at all', () => {
  assert.equal('extra_dev_scripts' in JSON.parse(wire('backend-preview', 'one-command')), false);
});

test('a drop-in whose further commands are malformed is skipped as broken', () => {
  for (const k of ['extra-same-name', 'extra-no-name', 'extra-no-dev', 'extra-not-list']) {
    assert.equal(KINDS.includes(k), false, k);
  }
});

test('a drop-in with a launch name that cannot name a launch entry is skipped as broken', () => {
  assert.equal(KINDS.includes('bad-launch-name'), false);
});

test('a drop-in whose preview port is not one of the two port variables is skipped as broken', () => {
  assert.equal(KINDS.includes('bad-port-var'), false);
});
