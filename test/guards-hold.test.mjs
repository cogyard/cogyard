// test/guards-hold.test.mjs — every rule that protects the task process is
// enforced by a hook, and this file proves each one still refuses (task 260).
//
// WHY THIS FILE EXISTS. Task 247 (2026-11-09) moved rules out of the owner's
// always-loaded CLAUDE.md. Some went into hooks, which Claude Code runs on every
// action and no chat can skip. Others went into skill descriptions, which take
// effect only when the model chooses that skill, and one — "edit task files at
// the path `cogyard tasks find` prints" — was dropped as "already in the skills".
// Nothing failed when that happened, so nobody noticed until a chat edited a
// task through the link and the owner got a permission prompt (task 260).
//
// So: one row per forbidden action. Each row runs the real hook script as its
// own process, fed the PreToolUse JSON Claude Code would send, against a
// throwaway registered project, and expects a refusal. A cleanup that removes
// or weakens a protection fails here. A second test checks that every hook used
// below is wired in the plugin's hooks.json for the tool it guards, so a
// protection can't quietly lose its wiring either.
//
// Adding a protection: add its row. Removing one: delete its row in the same
// commit, on purpose, where a reviewer sees it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPath } from '../core/launch.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = {
  edit: join(REPO_ROOT, 'hooks', 'pretooluse-validate-frontmatter.mjs'),
  taskStore: join(REPO_ROOT, 'hooks', 'pretooluse-guard-task-store.mjs'),
  devServer: join(REPO_ROOT, 'hooks', 'pretooluse-guard-dev-server.mjs'),
  branchSwitch: join(REPO_ROOT, 'hooks', 'pretooluse-guard-branch-switch.mjs'),
  worktree: join(REPO_ROOT, 'drivers', 'claude', 'hooks', 'pretooluse-guard-worktree.mjs'),
};

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const task = (id, envLines) => `---
id: ${id}
slug: t${id}
title: Task ${id}
status: OPEN
type: feature
created: 2026-01-01
done_date: null
depends_on: []
related: []
touches_paths: []
out_of_scope: []
env:
${envLines}
---

# ${id}: Task ${id}

- [ ] a box

Body.
`;
const UNCLAIMED = (id) => task(id, '  branch: null\n  claimed_at: null\n  claimed_by: null');
const CLAIMED = (id) => task(id, `  branch: worktree-task-${id}-t\n  claimed_at: 2026-11-17T00:00:00.000Z\n  claimed_by: Tester`);

let ROOT, HOME, STORE, REPO, WT;
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function decide(hook, payload) {
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: ME, ...payload }),
    encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const j = JSON.parse(out).hookSpecificOutput;
  return { decision: j.permissionDecision, reason: j.permissionDecisionReason };
}
const edit = (cwd, file_path, old_string, new_string) =>
  decide(H.edit, { tool_name: 'Edit', cwd, tool_input: { file_path, old_string, new_string } });
const bash = (hook, cwd, command) => decide(hook, { tool_name: 'Bash', cwd, tool_input: { command } });

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-guards-hold-')));
  HOME = join(ROOT, 'home'); mkdirSync(HOME);
  STORE = join(ROOT, '_tasks', 'demo'); mkdirSync(STORE, { recursive: true });
  git(STORE, ['init', '-q', '-b', 'tasks']);
  writeFileSync(join(STORE, '001-t1.md'), UNCLAIMED(1));
  writeFileSync(join(STORE, '002-t2.md'), CLAIMED(2));
  writeFileSync(join(STORE, '003-t3.md'), UNCLAIMED(3));

  REPO = join(ROOT, 'repo'); mkdirSync(REPO);
  git(REPO, ['init', '-q', '-b', 'main']);
  git(REPO, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  git(REPO, ['branch', 'feature']);
  mkdirSync(join(REPO, '.cogyard'));
  symlinkSync(STORE, join(REPO, '.cogyard', 'tasks'));
  writeFileSync(join(REPO, '.env.development'), 'A=1\n');

  WT = join(REPO, '.claude', 'worktrees', 'task-2-t');
  git(REPO, ['worktree', 'add', '-q', '-b', 'worktree-task-2-t', WT]);
  symlinkSync(join(REPO, '.env.development'), join(WT, '.env.development'));
  mkdirSync(dirname(launchPath(WT)), { recursive: true });
  writeFileSync(launchPath(WT), '{"version":"0.0.1","configurations":[]}\n');

  writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'demo', label: 'demo', path: REPO }]));
  // Task 2 is claimed by another chat, in worktree task-2-t.
  writeFileSync(join(HOME, 'claims.json'), JSON.stringify({ [`${STORE}#2`]: { worktree: 'task-2-t', session: OTHER, at: '2026-11-17T00:00:00.000Z' } }));
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

// [what the forbidden action is, how it is run, the refusal's opening words]
const ROWS = [
  ['edit a task file through the .cogyard/tasks link (task 260)',
    () => edit(REPO, join(REPO, '.cogyard', 'tasks', '001-t1.md'), 'Body.', 'Body, noted.'), /^Task-link guard/],
  ['edit a worktree\'s env-file link, which is the main checkout\'s file (task 260)',
    () => edit(WT, join(WT, '.env.development'), 'A=1', 'A=2'), /^Worktree-link guard/],
  ['edit a task file another chat has claimed (task 260)',
    () => edit(REPO, join(STORE, '002-t2.md'), 'Body.', 'Body, noted.'), /^Claim guard: task 2 /],
  ['enter a task\'s worktree this chat has not claimed (task 260)',
    () => decide(H.worktree, { tool_name: 'EnterWorktree', cwd: REPO, tool_input: { path: WT } }), /^Worktree guard: .* task 2's worktree/],
  ['hand-set a claim field (task 247)',
    () => edit(REPO, join(STORE, '001-t1.md'), '  claimed_by: null', '  claimed_by: Someone'), /^Claim guard: `env\.claimed_by/],
  ['hand-close a task by editing status (task 228)',
    () => edit(REPO, join(STORE, '003-t3.md'), 'status: OPEN', 'status: DONE'), /^Task-status guard/],
  ['hand-park a task by editing status (task 244)',
    () => edit(REPO, join(STORE, '003-t3.md'), 'status: OPEN', 'status: PARKED'), /^Park guard: `status: OPEN` → `status: PARKED`/],
  ['hand-write a live park note (task 244)',
    () => edit(REPO, join(STORE, '003-t3.md'), '# 3: Task 3\n', '# 3: Task 3\n\n> **PARKED 2026-11-17 — waiting**\n'), /^Park guard: a change to the live/],
  ['hand-edit a worktree\'s launch file (task 247)',
    () => edit(WT, launchPath(WT), '"configurations":[]', '"configurations":[{}]'), /^Worktree-file guard/],
  ['write a stray file into a task store (task 190)',
    () => edit(REPO, join(STORE, 'NOTES.md'), '', '# notes'), /^Task-store guard/],
  ['git add on the task link (task 197)',
    () => bash(H.taskStore, REPO, 'git add .cogyard/tasks/001-t1.md'), /^Task-link guard: `git add/],
  ['a git write inside a task store (task 228)',
    () => bash(H.taskStore, STORE, 'git commit -am x'), /./],
  ['pkill / killall (task 197)',
    () => bash(H.devServer, REPO, 'pkill -f node'), /^Kill-by-name guard/],
  ['move the main checkout off main (git checkout <branch>)',
    () => bash(H.branchSwitch, REPO, 'git checkout feature'), /./],
];

for (const [what, act, opening] of ROWS) {
  test(`refused: ${what}`, () => {
    const r = act();
    assert.equal(r.decision, 'deny', `${what} — expected a refusal, got ${r.decision}`);
    assert.match(r.reason, opening);
  });
}

test('the same actions done the right way are not refused', () => {
  assert.equal(edit(REPO, join(STORE, '001-t1.md'), 'Body.', 'Body, noted.').decision, 'allow', 'task file at its real path');
  assert.equal(edit(REPO, join(REPO, '.env.development'), 'A=1', 'A=2').decision, 'allow', 'the main checkout\'s own env file');
  writeFileSync(join(HOME, 'claims.json'), JSON.stringify({ [`${STORE}#2`]: { worktree: 'task-2-t', session: ME, at: '2026-11-17T00:00:00.000Z' } }));
  try {
    assert.equal(edit(REPO, join(STORE, '002-t2.md'), 'Body.', 'Body, noted.').decision, 'allow', 'the claiming chat edits its task');
    assert.equal(decide(H.worktree, { tool_name: 'EnterWorktree', cwd: REPO, tool_input: { path: WT } }).decision, 'allow', 'the claiming chat enters');
  } finally {
    writeFileSync(join(HOME, 'claims.json'), JSON.stringify({ [`${STORE}#2`]: { worktree: 'task-2-t', session: OTHER, at: '2026-11-17T00:00:00.000Z' } }));
  }
  assert.equal(bash(H.branchSwitch, REPO, 'git checkout main').decision, 'allow', 'returning to main');
});

test('every hook above is wired in the plugin for the tool it guards', () => {
  const wiring = JSON.parse(readFileSync(join(REPO_ROOT, 'drivers', 'claude', 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  const wired = (matcher, needle) => wiring.some((g) => g.matcher === matcher && g.hooks.some((h) => h.command.includes(needle)));
  assert.ok(wired('Edit|Write|MultiEdit', 'validate-frontmatter'), 'Edit/Write → validate-frontmatter');
  assert.ok(wired('Bash', 'guard-task-store'), 'Bash → guard-task-store');
  assert.ok(wired('Bash', 'guard-dev-server'), 'Bash → guard-dev-server');
  assert.ok(wired('Bash', 'guard-branch-switch'), 'Bash → guard-branch-switch');
  assert.ok(wired('EnterWorktree|ExitWorktree', 'pretooluse-guard-worktree.mjs'), 'EnterWorktree → worktree guard');
});
