// test/claude-install.test.mjs — `cogyard claude install` never hides or
// replaces someone else's command or skill (task 218).
//
// cogyard's personal names are `cogyard-<name>` (the `cogyard` command keeps
// its own), so a person's own skill, a project's or Claude Code's is never
// taken; install still refuses a name that is in use anyway.
//
// Every run uses a throwaway HOME, COGYARD_HOME and Claude config dir, so the
// real ~/.claude (the owner's live links) is never touched. Registered projects
// are fake repos in the throwaway home.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = JSON.parse(readFileSync(join(ROOT, 'drivers', 'claude', 'builtin-names.json'), 'utf8'));
const SKILLS = ['autopilot', 'commit', 'debt-cleanup', 'handoff', 'merge-to-main', 'pickup-task', 'write-task'];
const COMMANDS = ['cleanup-chat', 'lookup-chat', 'task-chats'];

// A fake machine: home, cogyard config (with the driver logo already there, so
// install downloads nothing), Claude config dir, and registered projects.
// projects: { '<label>': { '<rel path>': '<text>' } }
function machine(projects = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cy-claudeinst-'));
  const cy = join(home, '.cogyard');
  const claude = join(home, '.claude');
  mkdirSync(join(cy, 'drivers', 'claude'), { recursive: true });
  writeFileSync(join(cy, 'drivers', 'claude', 'logo.svg'), '<svg/>');
  const registry = [];
  for (const [label, files] of Object.entries(projects)) {
    const path = join(home, 'gitroot', label);
    mkdirSync(path, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(path, rel)), { recursive: true });
      writeFileSync(join(path, rel), text);
    }
    registry.push({ slug: label.replace(/[^a-zA-Z0-9_-]/g, '__'), path, label });
  }
  writeFileSync(join(cy, 'projects.json'), JSON.stringify(registry, null, 2));
  return { home, cy, claude };
}

function run(m, sub, args = [], root = ROOT) {
  const env = { ...process.env, HOME: m.home, COGYARD_HOME: m.cy, CLAUDE_CONFIG_DIR: m.claude };
  delete env.COGYARD_DRIVER;
  const r = spawnSync(process.execPath, [join(root, 'cli', 'claude-install.mjs'), sub, ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const install = (m, ...args) => run(m, 'install', args);

// A copy of the package, for a driver tree that differs from the real one.
function fakePackage() {
  const pkg = mkdtempSync(join(tmpdir(), 'cy-fakepkg-'));
  spawnSync('cp', ['-R', join(ROOT, 'cli'), join(ROOT, 'core'), join(ROOT, 'drivers'), join(ROOT, 'package.json'), pkg]);
  return pkg;
}

const linked = (m, rel) => { try { return lstatSync(join(m.claude, rel)).isSymbolicLink(); } catch { return false; } };
const there = (m, rel) => { try { lstatSync(join(m.claude, rel)); return true; } catch { return false; } };

test('every skill and command is linked under its cogyard- name; /cogyard keeps its own', () => {
  const m = machine({ quiet: { 'README.md': 'x\n' } });
  const out = install(m);
  for (const s of SKILLS) {
    assert.ok(linked(m, `skills/cogyard-${s}`), s);
    assert.equal(there(m, `skills/${s}`), false, `${s} under its bare name`);
  }
  for (const c of COMMANDS) assert.ok(linked(m, `commands/cogyard-${c}.md`), c);
  assert.ok(linked(m, 'commands/cogyard.md'));
  assert.match(out, /\+ skills\/cogyard-commit {2}\(\/cogyard-commit\)/);
  assert.match(out, /never take a name your own skills, a project's, or Claude Code's use/);
  assert.doesNotMatch(out, /✗/);
});

test('a project\'s own commit skill is no clash any more — cogyard\'s is /cogyard-commit beside it', () => {
  const m = machine({ 'shop/site': { '.claude/skills/commit/SKILL.md': 'x\n', '.claude/commands/handoff.md': 'h\n' } });
  const out = install(m);
  assert.ok(linked(m, 'skills/cogyard-commit'));
  assert.ok(linked(m, 'skills/cogyard-handoff'));
  assert.doesNotMatch(out, /✗/);
});

test('a person\'s own skill under a bare name stays, and cogyard\'s goes beside it', () => {
  const m = machine();
  mkdirSync(join(m.claude, 'skills', 'commit'), { recursive: true });
  writeFileSync(join(m.claude, 'skills', 'commit', 'SKILL.md'), 'mine\n');
  install(m);
  assert.equal(readFileSync(join(m.claude, 'skills', 'commit', 'SKILL.md'), 'utf8'), 'mine\n');
  assert.ok(linked(m, 'skills/cogyard-commit'));
});

test('a name in use anyway is not linked, and the output says why and names the plugin route', () => {
  const m = machine({ odd: { '.claude/skills/cogyard-commit/SKILL.md': 'x\n', '.claude/commands/cogyard.md': 'c\n', '.claude/commands/cogyard-handoff.md': 'h\n' } });
  const out = install(m);
  assert.equal(linked(m, 'skills/cogyard-commit'), false);
  assert.equal(linked(m, 'commands/cogyard.md'), false);
  assert.equal(linked(m, 'skills/cogyard-handoff'), false);
  assert.ok(linked(m, 'skills/cogyard-merge-to-main'));
  assert.match(out, /✗ skills\/cogyard-commit — not linked: the name \/cogyard-commit is already in use/);
  assert.match(out, /odd: its own \.claude\/skills\/cogyard-commit\/SKILL\.md would never run — a personal skill wins over a project's/);
  assert.match(out, /odd: its own \.claude\/commands\/cogyard\.md would never run — a personal command wins over a project's/);
  assert.match(out, /odd: its own \.claude\/commands\/cogyard-handoff\.md would never run — a skill wins over a command file/);
  assert.match(out, /as \/cogyard:commit \(\/plugin marketplace add cogyard\/cogyard, then \/plugin install cogyard@cogyard\)/);
  assert.match(out, /cogyard claude install --link-anyway cogyard-commit/);
});

test('a Claude Code built-in name is not linked by default', () => {
  // None of cogyard's personal names is a built-in, so give a copy of the
  // package a list that reserves one.
  const m = machine();
  const pkg = fakePackage();
  const f = join(pkg, 'drivers', 'claude', 'builtin-names.json');
  const list = JSON.parse(readFileSync(f, 'utf8'));
  list.commands.push('cogyard-handoff');
  writeFileSync(f, JSON.stringify(list));
  const out = run(m, 'install', [], pkg);
  assert.equal(linked(m, 'skills/cogyard-handoff'), false);
  assert.match(out, /cogyard-handoff is Claude Code's built-in \/cogyard-handoff \(Claude Code's docs, checked \d{4}-\d{2}-\d{2}\) — a personal skill of that name would replace it/);
  assert.ok(linked(m, 'skills/cogyard-commit'));
});

test('--link-anyway links the named clash, by either name, and only that one', () => {
  const m = machine({ a: { '.claude/skills/cogyard-commit/SKILL.md': 'x\n', '.claude/skills/cogyard-merge-to-main/SKILL.md': 'x\n' } });
  const out = install(m, '--link-anyway', 'cogyard-commit');
  assert.ok(linked(m, 'skills/cogyard-commit'));
  assert.equal(linked(m, 'skills/cogyard-merge-to-main'), false);
  assert.match(out, /\+ skills\/cogyard-commit {2}\(\/cogyard-commit\) — linked anyway with --link-anyway/);
  const out2 = install(m, '--link-anyway=commit,merge-to-main');
  assert.ok(linked(m, 'skills/cogyard-merge-to-main'));
  assert.doesNotMatch(out2, /✗/);
});

test('an older install\'s bare-name links are moved to the new names', () => {
  const m = machine();
  mkdirSync(join(m.claude, 'skills'), { recursive: true });
  mkdirSync(join(m.claude, 'commands'), { recursive: true });
  symlinkSync(join(ROOT, 'drivers', 'claude', 'skills', 'commit'), join(m.claude, 'skills', 'commit'));
  symlinkSync(join(ROOT, 'drivers', 'claude', 'commands', 'lookup-chat.md'), join(m.claude, 'commands', 'lookup-chat.md'));
  symlinkSync(join(ROOT, 'drivers', 'claude', 'commands', 'cogyard.md'), join(m.claude, 'commands', 'cogyard.md'));
  const out = install(m);
  assert.equal(there(m, 'skills/commit'), false);
  assert.equal(there(m, 'commands/lookup-chat.md'), false);
  assert.ok(linked(m, 'skills/cogyard-commit'));
  assert.ok(linked(m, 'commands/cogyard-lookup-chat.md'));
  assert.ok(linked(m, 'commands/cogyard.md'));
  assert.match(out, /→ skills\/commit → skills\/cogyard-commit {2}\(type \/cogyard-commit instead of \/commit\)/);
  assert.match(out, /→ commands\/lookup-chat\.md → commands\/cogyard-lookup-chat\.md/);
});

test('a bare-name link into another cogyard checkout is left, and the output says where to move it', () => {
  const m = machine();
  mkdirSync(join(m.claude, 'skills'), { recursive: true });
  symlinkSync(join(ROOT, 'drivers', 'claude', 'skills', 'commit'), join(m.claude, 'skills', 'commit'));
  const out = run(m, 'install', [], fakePackage());
  assert.ok(linked(m, 'skills/commit'));
  assert.ok(linked(m, 'skills/cogyard-commit'));
  assert.match(out, new RegExp(`~ skills/commit — an older install's link into another cogyard checkout \\(${realpathSync(join(ROOT, 'drivers', 'claude', 'skills', 'commit')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\); left`));
});

test('an earlier link that now clashes stays in place, and the output says what it hides', () => {
  const m = machine();
  install(m);
  assert.ok(linked(m, 'skills/cogyard-commit'));
  const proj = join(m.home, 'gitroot', 'late');
  mkdirSync(join(proj, '.claude', 'skills', 'cogyard-commit'), { recursive: true });
  writeFileSync(join(proj, '.claude', 'skills', 'cogyard-commit', 'SKILL.md'), 'x\n');
  writeFileSync(join(m.cy, 'projects.json'), JSON.stringify([{ slug: 'late', path: proj, label: 'late' }]));
  const out = install(m);
  assert.ok(linked(m, 'skills/cogyard-commit'));
  assert.match(out, /! skills\/cogyard-commit — linked by an earlier install, and the name \/cogyard-commit is also used here/);
  assert.match(out, /late: its own \.claude\/skills\/cogyard-commit\/SKILL\.md would never run/);
});

test('uninstall removes cogyard\'s links under both names and leaves a person\'s own', () => {
  const m = machine();
  install(m);
  symlinkSync(join(ROOT, 'drivers', 'claude', 'skills', 'handoff'), join(m.claude, 'skills', 'handoff'));
  mkdirSync(join(m.claude, 'skills', 'commit'));
  writeFileSync(join(m.claude, 'skills', 'commit', 'SKILL.md'), 'mine\n');
  const out = run(m, 'uninstall');
  for (const s of SKILLS) assert.equal(there(m, `skills/cogyard-${s}`), false, s);
  assert.equal(there(m, 'commands/cogyard.md'), false);
  assert.equal(there(m, 'skills/handoff'), false);
  assert.equal(readFileSync(join(m.claude, 'skills', 'commit', 'SKILL.md'), 'utf8'), 'mine\n');
  assert.match(out, /skills\/handoff \(link, older install\)/);
  assert.match(out, /~ skills\/commit left: not a link, so it may be your own/);
});

test('the built-in list is well formed, and holds none of cogyard\'s names', () => {
  assert.match(BUILTINS.checked, /^\d{4}-\d{2}-\d{2}$/);
  const all = [...BUILTINS.commands, ...BUILTINS.aliases, ...BUILTINS.reserved];
  for (const n of all) assert.match(n, /^[a-z][a-z0-9-]*$/, n);
  assert.equal(new Set(all).size, all.length, 'no name twice');
  for (const n of ['cogyard', ...SKILLS.map((s) => `cogyard-${s}`), ...COMMANDS.map((c) => `cogyard-${c}`)]) {
    assert.ok(!all.includes(n), `${n} is now a Claude Code built-in — rename it or ship it only through the plugin`);
  }
});

// Claude Code adds commands; this compares the list with its live docs page.
// Network, so only on request: COGYARD_NET_TESTS=1 node --test test/claude-install.test.mjs
test('the built-in list matches Claude Code\'s commands page', { skip: process.env.COGYARD_NET_TESTS !== '1' && 'set COGYARD_NET_TESTS=1 to compare with the live docs' }, async () => {
  const html = await (await fetch(BUILTINS.sources[0])).text();
  const live = new Set();
  for (const row of html.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const cell = row[0].match(/<td[^>]*>([\s\S]*?)<\/td>/);
    if (!cell) continue;
    const text = cell[1].replace(/<[^>]+>/g, '');
    for (const m of text.matchAll(/^\s*\/([a-z][a-z0-9-]*)/g)) live.add(m[1]);
  }
  assert.ok(live.size > 50, `read only ${live.size} commands from the page — has its layout changed?`);
  const missing = [...live].filter((n) => !BUILTINS.commands.includes(n));
  assert.deepEqual(missing, [], `Claude Code's commands page has names the list lacks — add them to drivers/claude/builtin-names.json and move "checked"`);
});
