// test/driver-plugin.test.mjs — the Claude driver as a PLUGIN user gets it
// (`/plugin marketplace add cogyard/cogyard`, `/plugin install cogyard@cogyard`).
// The owner never installs it that way, so nothing in daily use notices when the
// plugin's files drift from the engine: a hooks file Claude Code can't load, a
// hook the engine no longer dispatches, a skill folder the descriptions forget,
// an install line naming a package that isn't on npm. Each of those shipped once.
//
// The manual route (`cogyard claude install`) is covered by test/clean-machine.sh,
// which needs Docker; everything here is plain file reads plus, when `claude` is
// on PATH, Claude Code's own validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = join(REPO, 'drivers', 'claude');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const hooksFile = readJson(join(DRIVER, 'hooks', 'hooks.json'));
const pluginJson = readJson(join(DRIVER, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(join(REPO, '.claude-plugin', 'marketplace.json'));
const skillDirs = readdirSync(join(DRIVER, 'skills'))
  .filter((d) => statSync(join(DRIVER, 'skills', d)).isDirectory());

// Same oracle as test/clean-machine.sh: `cogyard hook <unknown>` lists what the
// engine actually dispatches.
function knownHooks() {
  const r = spawnSync(process.execPath, [join(REPO, 'cli', 'cogyard.mjs'), 'hook', '__no_such_hook__'], { encoding: 'utf8' });
  const m = /Known: (.*)/.exec(r.stderr);
  assert.ok(m, `cogyard hook <unknown> printed no hook list: ${r.stderr}`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

function allCommands(events) {
  const out = [];
  for (const groups of Object.values(events)) {
    for (const g of groups) for (const h of g.hooks ?? []) if (h.command) out.push(h.command);
  }
  return out;
}

test('hooks.json wraps its events in a top-level "hooks" key (else Claude Code loads none of them)', () => {
  const stray = Object.keys(hooksFile).filter((k) => k !== 'hooks' && k !== '//');
  assert.deepEqual(stray, [], `event(s) declared outside "hooks": ${stray.join(', ')}`);
  assert.equal(typeof hooksFile.hooks, 'object');
  assert.ok(Object.keys(hooksFile.hooks).length > 0, '"hooks" is empty');
});

test('every `cogyard hook <name>` the plugin wires is one the engine dispatches', () => {
  const known = new Set(knownHooks());
  const named = allCommands(hooksFile.hooks ?? {})
    .map((c) => /^cogyard hook (\S+)/.exec(c)?.[1])
    .filter(Boolean);
  assert.ok(named.length > 0, 'the plugin wires no `cogyard hook` at all');
  const unknown = [...new Set(named)].filter((n) => !known.has(n));
  assert.deepEqual(unknown, [], `not dispatchable by \`cogyard hook\`: ${unknown.join(', ')}`);
});

test("the marketplace's plugin source exists and its name matches plugin.json", () => {
  const entry = marketplace.plugins.find((p) => p.name === pluginJson.name);
  assert.ok(entry, `marketplace.json has no entry named "${pluginJson.name}"`);
  assert.ok(existsSync(join(REPO, entry.source, '.claude-plugin', 'plugin.json')),
    `marketplace source ${entry.source} has no .claude-plugin/plugin.json`);
});

// No `name:` line: Claude Code then names a skill by its folder — the link's
// name for a personal install (`cogyard-<name>`), the source folder under the
// plugin (`cogyard:<name>`). A `name:` would claim the bare name personally.
test('every skill folder has a SKILL.md with no frontmatter name, so the folder names it', () => {
  assert.ok(skillDirs.length > 0);
  for (const d of skillDirs) {
    const f = join(DRIVER, 'skills', d, 'SKILL.md');
    assert.ok(existsSync(f), `${relative(REPO, f)} is missing`);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(f, 'utf8'))?.[1];
    assert.ok(fm, `${relative(REPO, f)} has no frontmatter`);
    assert.doesNotMatch(fm, /^name:/m, `${relative(REPO, f)} has a name: line — remove it`);
    assert.match(fm, /^description:/m, `${relative(REPO, f)} has no description`);
    assert.match(d, /^[a-z][a-z0-9-]*$/, `${d} is not a plain lower-case name`);
  }
});

test('plugin.json and marketplace.json descriptions name every shipped skill', () => {
  const entry = marketplace.plugins.find((p) => p.name === pluginJson.name);
  for (const [where, text] of [['plugin.json', pluginJson.description], ['marketplace.json', entry.description]]) {
    const missing = skillDirs.filter((d) => !text.includes(d));
    assert.deepEqual(missing, [], `${where} description omits: ${missing.join(', ')}`);
  }
});

test('every `npm i -g` install line names the real package', () => {
  const pkg = readJson(join(REPO, 'package.json')).name;
  const files = [join(REPO, 'README.md'), join(REPO, 'cli', 'claude-install.mjs'), join(REPO, '.claude-plugin', 'marketplace.json')];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(DRIVER);
  const wrong = [];
  for (const f of files) {
    // \s+ spans a line break (drivers/claude/instructions.md wraps mid-command),
    // `// ` a wrapped JS comment, and `\`` an escaped backtick in a template string.
    for (const m of readFileSync(f, 'utf8').matchAll(/npm (?:i|install) -g\s+(?:\/\/\s+)?\\?`?([^\s`'"\\)]+)/g)) {
      if (m[1] !== pkg) wrong.push(`${relative(REPO, f)}: npm i -g ${m[1]}`);
    }
  }
  assert.deepEqual(wrong, [], `install line(s) not naming "${pkg}"`);
});

test('`claude plugin validate` passes on the plugin and the marketplace', (t) => {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error) return t.skip('`claude` is not on PATH — Claude Code\'s own plugin validator not run');
  for (const dir of [DRIVER, REPO]) {
    const r = spawnSync('claude', ['plugin', 'validate', dir], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `claude plugin validate ${relative(REPO, dir) || '.'} failed:\n${r.stdout}${r.stderr}`);
  }
});
