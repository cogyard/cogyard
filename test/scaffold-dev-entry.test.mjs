// test/scaffold-dev-entry.test.mjs — a kind declares its dev command (task 162).
//
// `devScript` on a scaffold descriptor decides what .cogyard/worktree.json names:
// omitted = 'npm run dev' (what every kind got before), a string = that command,
// null = no dev server, so the config is written with NO dev_script and no
// preview fields. Runs the real wiring engine against throwaway dirs with its
// own COGYARD_HOME and COGYARD_PROJECTS_ROOT, set BEFORE import (the registry
// and paths resolve at import).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-dev-entry-')));
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
install('no-dev', 'devScript: null,');
install('preview-dev', "devScript: 'npm run preview',");
install('unset-dev', '');
install('bad-dev', 'devScript: 42,');

const { ensureProjectWiring } = await import('../core/scaffold.mjs');
const { KINDS } = await import('../core/scaffolds/index.mjs');

after(() => rmSync(ROOT, { recursive: true, force: true }));

function wire(kind) {
  const dir = join(PROJECTS, `demo-${kind}`);
  mkdirSync(dir, { recursive: true });
  ensureProjectWiring({ path: dir, kind, scaffold: true });
  return JSON.parse(readFileSync(join(dir, '.cogyard', 'worktree.json'), 'utf8'));
}

test('a kind declaring no dev server gets a config with no dev_script and no preview fields', () => {
  const cfg = wire('no-dev');
  assert.equal('dev_script' in cfg, false);
  assert.equal('launch_name' in cfg, false);
  assert.equal('preview_port_var' in cfg, false);
  assert.deepEqual(cfg.port_vars, { PORT: 'backend', FRONTEND_PORT: 'frontend' }, 'ports are still named');
  assert.doesNotMatch(cfg._comment, /npm run dev/);
});

test('a kind naming its dev command gets that command', () => {
  const cfg = wire('preview-dev');
  assert.equal(cfg.dev_script, 'npm run preview');
  assert.match(cfg._comment, /`npm run preview` MUST ask/);
});

test('a kind that says nothing keeps the old default', () => {
  assert.equal(wire('unset-dev').dev_script, 'npm run dev');
});

test('the built-in kinds with a dev server still name npm run dev', () => {
  for (const k of ['single', 'fullstack', 'static']) assert.equal(wire(k).dev_script, 'npm run dev', k);
});

test('a drop-in whose devScript is neither a string nor null is skipped as broken', () => {
  assert.equal(KINDS.includes('bad-dev'), false);
});
