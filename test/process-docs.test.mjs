// test/process-docs.test.mjs — one process, one place (task 133).
//
// core/process-docs.mjs against a fake agent (core may not know any real
// agent's file names), plus the Claude driver's skills seam against a throwaway
// Claude config dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { splitSections, auditProcess, reconcileProcess, describeAudit, ownSkillName, auditReservedNames, describeReservedNames } from '../core/process-docs.mjs';

// A real project's old CLAUDE.MERGE.md, trimmed: a merge sequence beside
// branch hygiene that is not one.
const OLD_MERGE_DOC = `# CLAUDE.MERGE.md

Streamlined branch creation and merging procedures.

## Branch Management

**Update Branch:**
\`\`\`bash
# Update local main first
git checkout main && git pull origin main
git checkout branch-name && git rebase main
\`\`\`

Inside a worktree, never \`git merge main\` — rebase instead.

## Streamlined Merge Process

### Phase 1: Quality Gates
\`\`\`bash
npm run check
npm test
\`\`\`

### Phase 5: Execute Merge (NO PUSH)
\`\`\`bash
git checkout main && git pull origin main
git merge --no-ff branch-name
# STOP - DO NOT PUSH TO MAIN
\`\`\`

**Push to main = Production Deployment**

## Rollback Procedures

\`\`\`bash
git revert -m 1 <merge-commit-hash>
git push origin main
\`\`\`
`;

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cy-procdocs-'));
  run('git init -q -b main', dir);
  run('git config user.name t && git config user.email t@t', dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  run('git add -A && git commit -q -m init --allow-empty', dir);
  return dir;
}

// A fake agent: instruction files AGENT*.md, skills in skills/<name>/SKILL.md,
// a skill turned off by a line in skills-off.txt.
// Commands in commands/<name>.md; the agent keeps `doctor` and `help`. A
// personal install is `cogyard-<name>`; `bare` = an older install linked them
// under the bare name instead (the default here, which the first tests assume).
const fakePersonalName = (n) => (n === 'cogyard' || n.startsWith('cogyard-') ? n : `cogyard-${n}`);
function fakeAdapter({ personal = true, bare = true, plugin = false, shipped, personalSkills, personalCommands = ['lookup'], commands = ['cogyard', 'lookup'], reserved = ['doctor', 'help'] } = {}) {
  const skillNames = (shipped || [{ name: 'merge-to-main' }, { name: 'commit' }]).map((s) => s.name);
  const ps = personal ? (personalSkills || skillNames) : [];
  const pc = personal ? personalCommands : [];
  return {
    skills: {
      supported: true,
      alwaysLoaded: 'AGENT.md',
      instructionFiles: (r) => readdirSync(r).filter((f) => /^AGENT.*\.md$/.test(f)).sort(),
      projectSkills: (r) => {
        try { return readdirSync(join(r, 'skills')).map((name) => ({ name, file: `skills/${name}/SKILL.md` })); } catch { return []; }
      },
      projectCommands: (r) => {
        try { return readdirSync(join(r, 'commands')).map((f) => ({ name: f.replace(/\.md$/, ''), file: `commands/${f}` })); } catch { return []; }
      },
      projectSkillFile: (n) => `skills/${n}/SKILL.md`,
      renderSkill: ({ name, description, body }) => `name: ${name}\ndescription: ${description}\n\n${body}\n`,
      invocation: (n, { cogyard, plugin: p } = {}) => (cogyard && p ? `/cogyard:${n}` : `/${cogyard ? fakePersonalName(n) : n}`),
      personalName: fakePersonalName,
      installCommand: 'agent-install',
      install: () => ({ personal, plugin, personalSkills: ps, personalCommands: pc, bareSkills: bare ? ps : [], bareCommands: bare ? pc.filter((n) => fakePersonalName(n) !== n) : [] }),
      shippedCommands: () => commands.map((name) => ({ name })),
      reservedNames: () => reserved.map((name) => ({ name, why: `the agent's built-in /${name}` })),
      shipped: () => shipped || [{ name: 'merge-to-main', changed: '2026-10-30' }, { name: 'commit', changed: '2026-10-10' }],
      isOff: (r, n) => {
        try { return readFileSync(join(r, 'skills-off.txt'), 'utf8').split('\n').includes(n) ? 'skills-off.txt' : null; } catch { return null; }
      },
      turnOff: (r, n) => {
        const f = join(r, 'skills-off.txt');
        const was = existsSync(f) ? readFileSync(f, 'utf8') : '';
        if (was.split('\n').includes(n)) return null;
        writeFileSync(f, was + n + '\n');
        return 'skills-off.txt';
      },
    },
  };
}

test('splitSections: H2 under a lone H1 title; # lines inside code are not headings', () => {
  const { sections } = splitSections(OLD_MERGE_DOC);
  assert.deepEqual(sections.map((s) => s.heading), ['CLAUDE.MERGE.md', 'Branch Management', 'Streamlined Merge Process', 'Rollback Procedures']);
});

test('audit: flags the merge sequence, not branch hygiene, a prose mention or a rollback', () => {
  const dir = repo({ 'AGENT.MERGE.md': OLD_MERGE_DOC });
  const a = auditProcess(dir, { adapter: fakeAdapter(), slug: 'trip' });
  assert.deepEqual(a.collisions.map((c) => [c.file, c.heading, c.skill]), [['AGENT.MERGE.md', 'Streamlined Merge Process', 'merge-to-main']]);
  assert.deepEqual(a.outcomes, ['adopt', 'keep', 'facts']);
  assert.match(describeAudit(a)[0], /AGENT\.MERGE\.md \("Streamlined Merge Process"\) holds a merging process beside cogyard's merge-to-main/);
});

test('audit: docs/*.md is read too, and with no agent only "adopt" is offered', () => {
  const dir = repo({ 'docs/release.md': OLD_MERGE_DOC });
  const noop = { skills: { supported: false, alwaysLoaded: null, instructionFiles: () => [], projectSkills: () => [], invocation: (n) => n, install: () => ({ personal: false, plugin: false }), shipped: () => [], isOff: () => null } };
  const a = auditProcess(dir, { adapter: noop, slug: 'trip' });
  assert.deepEqual(a.collisions.map((c) => c.file), ['docs/release.md']);
  assert.deepEqual(a.outcomes, ['adopt']);
});

test('audit: a commit section counts only when its heading says commit', () => {
  const doc = '# Notes\n\n## Committing\n\n1. Stage with `git add -p`\n2. Run `git commit -s`\n\n## Release\n\n```\nnpm version minor\ngit commit -am bump\n```\n';
  const dir = repo({ 'AGENT.md': doc });
  const a = auditProcess(dir, { adapter: fakeAdapter(), slug: 'trip' });
  assert.deepEqual(a.collisions.map((c) => [c.heading, c.skill]), [['Committing', 'commit']]);
});

test('audit: a project skill named like cogyard\'s — never runs, runs beside, or neither runs', () => {
  const dir = repo({ 'skills/merge-to-main/SKILL.md': 'merge stuff\n' });
  const verdict = (opts) => auditProcess(dir, { adapter: fakeAdapter(opts), slug: 'Shared Travel' }).shadowed.map((s) => s.verdict);
  assert.deepEqual(verdict({ personal: true }), ['never-runs']);
  assert.deepEqual(verdict({ personal: false, plugin: true }), ['runs-beside']);
  assert.deepEqual(verdict({ personal: false, plugin: false }), []);
  writeFileSync(join(dir, 'skills-off.txt'), 'merge-to-main\n');
  assert.deepEqual(verdict({ personal: true }), ['neither-runs']);
  assert.match(auditProcess(dir, { adapter: fakeAdapter(), slug: 'Shared Travel' }).shadowed[0].fix, /rename it \(e\.g\. shared-travel-merge\)/);
});

test('audit: the older bare-name link that hides a project skill says re-running install moves it', () => {
  const dir = repo({ 'skills/merge-to-main/SKILL.md': 'merge stuff\n' });
  const s = auditProcess(dir, { adapter: fakeAdapter(), slug: 'trip' }).shadowed[0];
  assert.match(s.detail, /under its bare name by an older install/);
  assert.match(s.fix, /^re-run `agent-install` — it moves cogyard's to \/cogyard-merge-to-main, after which this one runs beside it — and rename it/);
});

test('audit: cogyard installed under its prefixed names — a same-named project skill runs beside it', () => {
  const dir = repo({ 'skills/merge-to-main/SKILL.md': 'merge stuff\n' });
  const a = auditProcess(dir, { adapter: fakeAdapter({ bare: false }), slug: 'trip' });
  assert.deepEqual(a.shadowed.map((s) => s.verdict), ['runs-beside']);
  assert.match(a.shadowed[0].detail, /runs beside cogyard's \/cogyard-merge-to-main/);
  // Turned off by its bare name: under prefixed names that touches only the project's own.
  writeFileSync(join(dir, 'skills-off.txt'), 'merge-to-main\n');
  assert.deepEqual(auditProcess(dir, { adapter: fakeAdapter({ bare: false }) }).shadowed.map((s) => s.verdict), ['runs-beside']);
});

test('audit: a project skill that took cogyard\'s prefixed name never runs', () => {
  const dir = repo({ 'skills/cogyard-commit/SKILL.md': 'x\n' });
  const a = auditProcess(dir, { adapter: fakeAdapter({ bare: false }) });
  assert.deepEqual(a.shadowed.map((s) => [s.name, s.verdict]), [['cogyard-commit', 'never-runs']]);
  assert.match(a.shadowed[0].fix, /names starting cogyard- are cogyard's/);
});

test('audit: a skill install left out is not reported as hiding anything', () => {
  const dir = repo({ 'skills/commit/SKILL.md': 'x\n' });
  const a = auditProcess(dir, { adapter: fakeAdapter({ personalSkills: ['merge-to-main'] }), slug: 'shop' });
  assert.deepEqual(a.shadowed, []);
});

test('audit: a project command and cogyard\'s skill or command of that name (task 218)', () => {
  const dir = repo({ 'commands/commit.md': 'c\n', 'commands/lookup.md': 'c\n', 'commands/deploy.md': 'd\n' });
  const a = auditProcess(dir, { adapter: fakeAdapter(), slug: 'shop' });
  assert.deepEqual(a.shadowed.map((s) => [s.file, s.verdict]), [['commands/commit.md', 'never-runs'], ['commands/lookup.md', 'never-runs']]);
  assert.match(a.shadowed[0].detail, /under its bare name by an older install, wins over a command file of the same name/);
  assert.match(a.shadowed[1].detail, /cogyard's \/lookup, installed as a personal command under its bare name by an older install, wins over a project command/);
  assert.match(a.shadowed[1].fix, /rename it \(e\.g\. shop-lookup\)/);
  const prefixed = auditProcess(dir, { adapter: fakeAdapter({ bare: false }) }).shadowed;
  assert.deepEqual(prefixed.map((s) => s.verdict), ['runs-beside', 'runs-beside']);
  assert.match(prefixed[1].detail, /beside cogyard's \/cogyard-lookup/);
  assert.deepEqual(auditProcess(dir, { adapter: fakeAdapter({ personal: false, plugin: true }) }).shadowed.map((s) => s.verdict), ['runs-beside', 'runs-beside']);
  assert.deepEqual(auditProcess(dir, { adapter: fakeAdapter({ personal: false }) }).shadowed, []);
});

test('audit: a project skill named like cogyard\'s bare-named command — only one runs', () => {
  const dir = repo({ 'skills/lookup/SKILL.md': 'x\n' });
  assert.deepEqual(auditProcess(dir, { adapter: fakeAdapter() }).shadowed.map((s) => s.verdict), ['one-runs']);
  assert.deepEqual(auditProcess(dir, { adapter: fakeAdapter({ bare: false }) }).shadowed.map((s) => s.verdict), []);
});

test('reserved names: the name cogyard\'s would be installed under, and an older bare one', () => {
  assert.deepEqual(auditReservedNames({ adapter: fakeAdapter() }), []);
  // The agent keeps cogyard-doctor (prefixed) and help (bare).
  const adapter = fakeAdapter({ shipped: [{ name: 'doctor' }, { name: 'commit' }], commands: ['help'], personalSkills: ['commit'], personalCommands: ['help'], reserved: ['cogyard-doctor', 'help'] });
  const found = auditReservedNames({ adapter });
  assert.deepEqual(found.map((f) => [f.name, f.as, f.kind, f.personal]), [['doctor', 'cogyard-doctor', 'skill', false], ['help', 'help', 'command', true]]);
  const lines = describeReservedNames(found, { adapter });
  assert.match(lines[0], /would be the personal skill cogyard-doctor, the name of the agent's built-in \/cogyard-doctor\. `agent-install` leaves it out; the cogyard plugin has it as \/cogyard:doctor/);
  assert.match(lines[1], /installed as the personal command help, the name of the agent's built-in \/help, so it replaces it/);
  // Prefixed, the bare `help` no longer matters.
  assert.deepEqual(auditReservedNames({ adapter: fakeAdapter({ bare: false, commands: ['help'], personalCommands: ['help'] }) }), []);
  const noop = { skills: { install: () => ({ personal: false, plugin: false }), shipped: () => [] } };
  assert.deepEqual(auditReservedNames({ adapter: noop }), []);
});

test('audit: a replacing skill reconciled before cogyard\'s last change is stale', () => {
  const dir = repo({ 'skills/trip-merge/SKILL.md': "Replaces cogyard's `merge-to-main`. Last reconciled against it: 2026-10-01.\n" });
  assert.deepEqual(auditProcess(dir, { adapter: fakeAdapter() }).stale.map((s) => [s.name, s.reconciled, s.changed]), [['trip-merge', '2026-10-01', '2026-10-30']]);
  const fresh = auditProcess(dir, { adapter: fakeAdapter({ shipped: [{ name: 'merge-to-main', changed: '2026-10-01' }] }) });
  assert.deepEqual(fresh.stale, []);
});

test('ownSkillName: lower-case kebab, never cogyard\'s name', () => {
  assert.equal(ownSkillName('TripPlanner', 'merge-to-main'), 'tripplanner-merge');
  assert.equal(ownSkillName('shop-clones__blue', 'commit'), 'shop-clones-blue-commit');
});

for (const outcome of ['adopt', 'keep', 'facts']) {
  test(`reconcile "${outcome}": one authority, one commit, and a re-run finds it already reconciled`, () => {
    const dir = repo({ 'AGENT.md': '# Agent\n\nRead AGENT.MERGE.md before merging.\n', 'AGENT.MERGE.md': OLD_MERGE_DOC, 'src/app.js': 'x\n' });
    const adapter = fakeAdapter();
    const a = auditProcess(dir, { adapter, slug: 'trip' });
    const r = reconcileProcess(dir, { skill: 'merge-to-main', outcome, collisions: a.collisions, adapter, slug: 'trip', day: '2026-11-02' });

    const doc = readFileSync(join(dir, 'AGENT.MERGE.md'), 'utf8');
    assert.match(doc, /<!-- cogyard:process merge-to-main=/);
    assert.doesNotMatch(doc, /git merge --no-ff/);
    assert.match(doc, /## Branch Management[\s\S]*## Streamlined Merge Process[\s\S]*## Rollback Procedures/);
    assert.match(r.removed[0].text, /git merge --no-ff branch-name/);

    const expected = { adopt: ['AGENT.MERGE.md'], keep: ['AGENT.MERGE.md', 'skills/trip-merge/SKILL.md', 'skills-off.txt'], facts: ['AGENT.MERGE.md', 'AGENT.md'] }[outcome];
    assert.deepEqual([...r.changed].sort(), [...expected].sort());
    assert.deepEqual(run('git show --name-only --format= HEAD', dir).split('\n').sort(), [...expected].sort());
    assert.equal(run('git status --porcelain', dir), '');

    if (outcome === 'keep') {
      const skill = readFileSync(join(dir, 'skills/trip-merge/SKILL.md'), 'utf8');
      assert.match(skill, /Replaces cogyard's `merge-to-main`\. Last reconciled against it: 2026-11-02\./);
      assert.match(skill, /git merge --no-ff branch-name/);
      assert.equal(adapter.skills.isOff(dir, 'merge-to-main'), 'skills-off.txt');
    }
    if (outcome === 'facts') {
      const agent = readFileSync(join(dir, 'AGENT.md'), 'utf8');
      assert.match(agent, /> git merge --no-ff branch-name/);
      assert.match(agent, /cogyard:process merge-to-main=facts/);
    }

    const again = auditProcess(dir, { adapter, slug: 'trip' });
    assert.deepEqual(again.collisions, []);
    assert.deepEqual(again.reconciled.map((x) => x.outcome).filter((o) => o === outcome).length > 0, true);
    assert.deepEqual(again.stale, []);
  });
}

test('reconcile "keep" under a plugin install: the always-loaded file names which skill to use', () => {
  const dir = repo({ 'AGENT.MERGE.md': OLD_MERGE_DOC });
  const adapter = fakeAdapter({ personal: false, plugin: true });
  const a = auditProcess(dir, { adapter, slug: 'trip' });
  const r = reconcileProcess(dir, { skill: 'merge-to-main', outcome: 'keep', collisions: a.collisions, adapter, slug: 'trip', day: '2026-11-02' });
  assert.match(readFileSync(join(dir, 'AGENT.md'), 'utf8'), /use this project's `trip-merge` skill \(`\/trip-merge`\), not cogyard's `\/cogyard:merge-to-main`/);
  assert.match(r.notes.join('\n'), /stays loaded/);
});

// --- the Claude driver's seam, against a throwaway Claude config dir ----------

test('claude skills seam: install, instruction files, project skills, turning a skill off', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'cy-claudecfg-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { default: claude } = await import(`../drivers/claude/adapter.mjs?cfg=${Date.now()}`);
    const dir = repo({ 'CLAUDE.md': 'x\n', 'CLAUDE.MERGE.md': 'y\n', '.claude/skills/merge-to-main/SKILL.md': '---\nname: merge-to-main\n---\n', '.claude/settings.json': '{\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n' });
    const s = claude.skills;
    assert.deepEqual(s.install(dir), { personal: false, personalSkills: [], personalCommands: [], bareSkills: [], bareCommands: [], plugin: false });

    // Personal names (task 218): cogyard-<name>, and `cogyard` keeps its own.
    assert.equal(s.personalName('commit'), 'cogyard-commit');
    assert.equal(s.personalName('cogyard'), 'cogyard');
    assert.equal(s.personalName('cogyard-x'), 'cogyard-x');
    assert.equal(s.invocation('commit', { cogyard: true }), '/cogyard-commit');
    assert.equal(s.invocation('commit'), '/commit');

    mkdirSync(join(cfg, 'skills'), { recursive: true });
    mkdirSync(join(cfg, 'commands'), { recursive: true });
    // An older install's bare-name link, a current prefixed link, and the
    // owner's own `handoff` (a plain folder — not cogyard's).
    symlinkSync(join(process.cwd(), 'drivers/claude/skills/commit'), join(cfg, 'skills', 'commit'));
    symlinkSync(join(process.cwd(), 'drivers/claude/skills/merge-to-main'), join(cfg, 'skills', 'cogyard-merge-to-main'));
    mkdirSync(join(cfg, 'skills', 'handoff'));
    writeFileSync(join(cfg, 'skills', 'handoff', 'SKILL.md'), 'mine\n');
    symlinkSync(join(process.cwd(), 'drivers/claude/commands/cogyard.md'), join(cfg, 'commands', 'cogyard.md'));
    symlinkSync(join(process.cwd(), 'drivers/claude/commands/lookup-chat.md'), join(cfg, 'commands', 'lookup-chat.md'));
    const inst = s.install(dir);
    assert.equal(inst.personal, true);
    assert.deepEqual(inst.personalSkills, ['commit', 'merge-to-main']);
    assert.deepEqual(inst.bareSkills, ['commit']);
    assert.deepEqual(inst.personalCommands, ['cogyard', 'lookup-chat']);
    assert.deepEqual(inst.bareCommands, ['lookup-chat']);

    // Commands (task 218): the project's own, cogyard's, and Claude Code's built-in names.
    mkdirSync(join(dir, '.claude/commands/sub'), { recursive: true });
    writeFileSync(join(dir, '.claude/commands/deploy.md'), 'deploy\n');
    writeFileSync(join(dir, '.claude/commands/sub/nested.md'), 'nested\n');
    assert.deepEqual(s.projectCommands(dir), [{ name: 'deploy', file: '.claude/commands/deploy.md' }]);
    assert.ok(s.shippedCommands().some((c) => c.name === 'cogyard'));
    const reserved = s.reservedNames();
    assert.ok(reserved.some((r) => r.name === 'doctor' && /built-in \/doctor/.test(r.why)));
    assert.ok(reserved.some((r) => r.name === 'quit' && /alias/.test(r.why)));
    assert.ok(reserved.some((r) => r.name === 'anthropic-skills'));

    mkdirSync(join(cfg, 'plugins'), { recursive: true });
    writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'cogyard@cogyard': [{ scope: 'local', projectPath: dir }] } }));
    assert.equal(s.install(dir).plugin, true);
    assert.equal(s.install(cfg).plugin, false);

    assert.deepEqual(s.instructionFiles(dir), ['CLAUDE.md', 'CLAUDE.MERGE.md']);
    assert.deepEqual(s.projectSkills(dir), [{ name: 'merge-to-main', file: '.claude/skills/merge-to-main/SKILL.md' }]);
    assert.ok(s.shipped().some((x) => x.name === 'merge-to-main' && /^\d{4}-\d{2}-\d{2}$/.test(x.changed)));

    // Turning cogyard's off writes its personal name, leaving the project's own on.
    assert.equal(s.isOff(dir, 'merge-to-main', { cogyard: true }), null);
    assert.equal(s.turnOff(dir, 'merge-to-main', { cogyard: true }), '.claude/settings.json');
    assert.equal(s.turnOff(dir, 'merge-to-main', { cogyard: true }), null);
    assert.equal(s.isOff(dir, 'merge-to-main', { cogyard: true }), '.claude/settings.json');
    assert.equal(s.isOff(dir, 'merge-to-main'), null);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')), { permissions: { allow: ['Bash(ls)'] }, skillOverrides: { 'cogyard-merge-to-main': 'off' } });
    // An older bare-name key still counts as cogyard's turned off.
    writeFileSync(join(dir, '.claude/settings.local.json'), JSON.stringify({ skillOverrides: { commit: 'off' } }));
    assert.equal(s.isOff(dir, 'commit', { cogyard: true }), '.claude/settings.local.json');
    assert.equal(s.invocation('merge-to-main', { cogyard: true, plugin: true }), '/cogyard:merge-to-main');
    assert.match(s.renderSkill({ name: 'trip-merge', description: 'a "b"', body: 'hi' }), /^---\nname: trip-merge\ndescription: "a \\"b\\""\n---\n\nhi\n$/);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
