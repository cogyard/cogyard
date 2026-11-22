// Task 260: an edit through a link that leaves the project is refused, naming
// the real file, before Claude Code would ask the owner's permission for it.
//
// Claude Code prompts for any write whose path is inside the chat's folder but
// resolves through a link to somewhere outside it. Cogyard makes two such links
// itself: the project's task link (`.cogyard/tasks` → the shared store) and a
// worktree's env files (→ the main checkout's real files). A chat that edits
// through either stalls on a prompt; task 158 told chats to use the real path,
// and that held only while the instruction was loaded.
//
// The hook runs as the separate process it is, fed PreToolUse JSON with `cwd`
// set the way Claude Code sets it, against a throwaway project and store.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pretooluse-validate-frontmatter.mjs');

const TASK = `---
id: 42
slug: a-task
title: A task
status: OPEN
type: feature
created: 2026-01-01
done_date: null
depends_on: []
related: []
touches_paths: []
out_of_scope: []
---

# 42: A task

Body.
`;

let ROOT, HOME, STORE, REPO, WT, OUTSIDE;
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function run(cwd, tool_input) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', cwd, tool_input }),
    encoding: 'utf8',
    env: { ...process.env, COGYARD_HOME: HOME },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const j = JSON.parse(out).hookSpecificOutput;
  return { decision: j.permissionDecision, reason: j.permissionDecisionReason };
}
const edit = (file_path) => ({ file_path, old_string: 'Body.', new_string: 'Body, edited.' });

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-linkguard-')));
  HOME = join(ROOT, 'home'); mkdirSync(HOME);
  STORE = join(ROOT, '_tasks', 'demo'); mkdirSync(STORE, { recursive: true });   // the real layout: <root>/_tasks/<slug>
  writeFileSync(join(STORE, '042-a-task.md'), TASK);
  OUTSIDE = join(ROOT, 'elsewhere'); mkdirSync(OUTSIDE);
  writeFileSync(join(OUTSIDE, 'notes.txt'), 'x\n');

  REPO = join(ROOT, 'repo'); mkdirSync(REPO);
  git(REPO, ['init', '-q', '-b', 'main']);
  git(REPO, ['-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  mkdirSync(join(REPO, '.cogyard'));
  symlinkSync(STORE, join(REPO, '.cogyard', 'tasks'));
  symlinkSync(STORE, join(REPO, '_tasks'));                       // the older link form (task 160)
  symlinkSync(join(OUTSIDE, 'notes.txt'), join(REPO, 'notes.txt'));
  writeFileSync(join(REPO, '.env.development'), 'A=1\n');
  writeFileSync(join(REPO, 'plain.txt'), 'x\n');
  mkdirSync(join(REPO, 'src'));
  symlinkSync(join(REPO, 'plain.txt'), join(REPO, 'src', 'inner-link.txt'));  // a link that stays inside

  // A linked worktree whose env file links to the main checkout's, as the
  // session-start hook makes it.
  WT = join(REPO, '.claude', 'worktrees', 'task-042-a-task');
  git(REPO, ['worktree', 'add', '-q', '-b', 'worktree-task-042-a-task', WT]);
  symlinkSync(join(REPO, '.env.development'), join(WT, '.env.development'));
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

test('an edit through .cogyard/tasks is refused, naming the real store path', () => {
  const r = run(REPO, edit(join(REPO, '.cogyard', 'tasks', '042-a-task.md')));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^Task-link guard/);
  assert.ok(r.reason.includes(join(STORE, '042-a-task.md')), r.reason);
  assert.match(r.reason, /cogyard tasks find 042/);
});

test('a relative path through the link is refused the same way', () => {
  const r = run(REPO, edit('.cogyard/tasks/042-a-task.md'));
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes(join(STORE, '042-a-task.md')), r.reason);
});

test('a Write of a NEW task file through the link is refused with the real path it would have', () => {
  const r = run(REPO, { file_path: join(REPO, '.cogyard', 'tasks', '043-new.md'), content: TASK });
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes(join(STORE, '043-new.md')), r.reason);
});

test('an attachment written through the link is refused too', () => {
  const r = run(REPO, { file_path: join(REPO, '.cogyard', 'tasks', 'files', '042', 'mock.html'), content: '<p/>' });
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes(join(STORE, 'files', '042', 'mock.html')), r.reason);
});

test('the older _tasks link is refused the same way', () => {
  const r = run(REPO, edit(join(REPO, '_tasks', '042-a-task.md')));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^Task-link guard/);
});

test('the same edit at the real store path is not refused', () => {
  assert.equal(run(REPO, edit(join(STORE, '042-a-task.md'))).decision, 'allow');
});

test('from inside a worktree, its own task link is refused too', () => {
  mkdirSync(join(WT, '.cogyard'), { recursive: true });
  try { symlinkSync(STORE, join(WT, '.cogyard', 'tasks')); } catch {}
  const r = run(WT, edit(join(WT, '.cogyard', 'tasks', '042-a-task.md')));
  assert.equal(r.decision, 'deny');
  assert.ok(r.reason.includes(join(STORE, '042-a-task.md')), r.reason);
});

test('a worktree\'s env-file link is refused: it would change the main checkout\'s own file', () => {
  const r = run(WT, { file_path: join(WT, '.env.development'), old_string: 'A=1', new_string: 'A=2' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^Worktree-link guard/);
  assert.ok(r.reason.includes(join(REPO, '.env.development')), r.reason);
});

test('an env-file link that goes on through the main checkout into a secrets folder is still the worktree-link refusal', () => {
  const secrets = join(ROOT, 'secrets'); mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, '.env.production'), 'S=1\n');
  symlinkSync(join(secrets, '.env.production'), join(REPO, '.env.production'));
  symlinkSync(join(REPO, '.env.production'), join(WT, '.env.production'));
  const r = run(WT, { file_path: join(WT, '.env.production'), old_string: 'S=1', new_string: 'S=2' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^Worktree-link guard/);
  assert.ok(r.reason.includes(join(REPO, '.env.production')), r.reason);
  assert.ok(r.reason.includes(join(secrets, '.env.production')), r.reason);
  assert.match(r.reason, /only if the owner asked/);
});

test('the main checkout\'s own env file, from the main checkout, is not refused', () => {
  assert.equal(run(REPO, { file_path: join(REPO, '.env.development'), old_string: 'A=1', new_string: 'A=2' }).decision, 'allow');
});

test('any other link out of the project is refused, naming where it leads', () => {
  const r = run(REPO, { file_path: join(REPO, 'notes.txt'), old_string: 'x', new_string: 'y' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^Link guard/);
  assert.ok(r.reason.includes(join(OUTSIDE, 'notes.txt')), r.reason);
});

test('a link that stays inside the project is not refused', () => {
  assert.equal(run(REPO, { file_path: join(REPO, 'src', 'inner-link.txt'), old_string: 'x', new_string: 'y' }).decision, 'allow');
});

test('an ordinary file in the project is not refused', () => {
  assert.equal(run(REPO, { file_path: join(REPO, 'plain.txt'), old_string: 'x', new_string: 'y' }).decision, 'allow');
});

test('a file outside the project is not this rule\'s business', () => {
  assert.equal(run(REPO, { file_path: join(OUTSIDE, 'notes.txt'), old_string: 'x', new_string: 'y' }).decision, 'allow');
});

// --- another chat's claimed task (task 260) -----------------------------------
// The chat holding a claim is claims.json's record; the editing chat is the
// hook input's session_id. Both known and different → refused.

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLAIMED = TASK.replace('out_of_scope: []\n', 'out_of_scope: []\nenv:\n  branch: worktree-task-044-c\n  claimed_at: 2026-11-17T00:00:00.000Z\n  claimed_by: Tester\n')
  .replace('id: 42', 'id: 44').replace('# 42', '# 44');

function runAs(session_id, tool_input, cwd = REPO) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', cwd, session_id, tool_input }),
    encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME },
  });
  const out = (r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  const j = JSON.parse(out).hookSpecificOutput;
  return { decision: j.permissionDecision, reason: j.permissionDecisionReason };
}
function claimRecord(file, session) {
  writeFileSync(join(HOME, 'projects.json'), JSON.stringify([{ slug: 'demo', label: 'demo', path: REPO }]));
  writeFileSync(join(HOME, 'claims.json'), JSON.stringify({ [`${STORE}#44`]: { worktree: 'task-044-c', session, at: '2026-11-17T00:00:00.000Z' } }));
}
const tick = (f) => ({ file_path: f, old_string: 'Body.', new_string: 'Body, ticked.' });

test('an edit to a task file another chat has claimed is refused, saying how to hand it over', () => {
  const f = join(STORE, '044-c.md');
  writeFileSync(f, CLAIMED);
  claimRecord(f, OTHER);
  const r = runAs(ME, tick(f));
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /^Claim guard: task 44/);
  assert.ok(r.reason.includes(OTHER), r.reason);
  assert.match(r.reason, /cogyard env claim .* --force/);
});

test('the chat holding the claim edits its own task file', () => {
  const f = join(STORE, '044-c.md');
  writeFileSync(f, CLAIMED);
  claimRecord(f, ME);
  assert.equal(runAs(ME, tick(f)).decision, 'allow');
});

test('a released claim, an unclaimed task, or an unknown chat id is not refused', () => {
  const f = join(STORE, '044-c.md');
  writeFileSync(f, CLAIMED);
  claimRecord(f, null);
  assert.equal(runAs(ME, tick(f)).decision, 'allow', 'released: no session in the record');
  claimRecord(f, OTHER);
  assert.equal(runAs(undefined, tick(f)).decision, 'allow', 'no session_id in the hook input');
  writeFileSync(f, CLAIMED.replace('claimed_at: 2026-11-17T00:00:00.000Z', 'claimed_at: null'));
  assert.equal(runAs(ME, tick(f)).decision, 'allow', 'the file says unclaimed');
  writeFileSync(f, CLAIMED);
  claimRecord(f, 'desktop-task-078-97c39f17');
  assert.equal(runAs(ME, tick(f)).decision, 'allow', 'a made-up id from before env claim recorded the real one');
  rmSync(join(HOME, 'claims.json'));
  rmSync(join(HOME, 'projects.json'));
});

test('fail-open: no cwd, or a cwd that is not a repo, says nothing', () => {
  const noCwd = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: edit(join(REPO, '.cogyard', 'tasks', '042-a-task.md')) }),
    encoding: 'utf8', env: { ...process.env, COGYARD_HOME: HOME },
  });
  assert.doesNotMatch(noCwd.stdout || '', /Task-link guard/);
  assert.equal(run(OUTSIDE, { file_path: join(OUTSIDE, 'notes.txt'), old_string: 'x', new_string: 'y' }).decision, 'allow');
});
