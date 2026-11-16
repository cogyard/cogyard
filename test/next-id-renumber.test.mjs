// test/next-id-renumber.test.mjs — on a TEAM store, `tasks next-id` re-numbers
// its reservation when a teammate's push took the same id, and amends its own
// reservation commit to record the rename.
//
// The bug this exists to prevent (task 225): that amend named no files, so it
// also took whatever another chat had staged in the shared store at that moment
// — the same "one chat's commit holds another chat's edit" failure as a plain
// `sync push`. The amend now names only the old and new reservation file.
//
// Fixtures: a bare `origin`, the store under test (A, branch `tasks`) and a
// teammate's clone (B). Two git hooks in A stage the race deterministically:
//   - pre-push, first run only: B pushes its own id 002, and A's push is refused,
//     so next-id pulls, finds the clash and re-numbers;
//   - post-rewrite (fires after that pull's rebase): another chat stages an edit
//     to 001-one.md — the file the amend must NOT take.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'tasks.mjs');
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const ident = (d) => { git(d, ['config', 'user.email', 'test@example.com']); git(d, ['config', 'user.name', 'Test']); };
const taskText = (id, slug) => `---\nid: ${id}\nslug: ${slug}\ntitle: ${slug}\nstatus: OPEN\ntype: bug\nenv:\n  claimed_at: null\n---\n`;

function hook(store, name, body) {
  const p = join(store, '.git', 'hooks', name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

test('a re-numbered reservation\'s amended commit holds only the reservation, not a file another chat staged', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-renumber-')));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const a = join(root, 'a');
  const b = join(root, 'b');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  mkdirSync(home);

  git(root, ['init', '-q', '--bare', '-b', 'tasks', origin]);
  mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'tasks']); ident(seed);
  writeFileSync(join(seed, '001-one.md'), taskText(1, 'one'));
  git(seed, ['add', '-A']); git(seed, ['commit', '-qm', 'seed']);
  git(seed, ['remote', 'add', 'origin', origin]); git(seed, ['push', '-q', 'origin', 'tasks']);
  git(root, ['clone', '-q', '-b', 'tasks', origin, a]); ident(a);
  git(root, ['clone', '-q', '-b', 'tasks', origin, b]); ident(b);

  // The teammate's id 002, committed in B and pushed from A's pre-push hook.
  writeFileSync(join(b, '002-theirs.md'), taskText(2, 'theirs'));
  git(b, ['add', '-A']); git(b, ['commit', '-qm', 'reserve id 002 (theirs)']);
  const once = join(root, 'pushed-once');
  hook(a, 'pre-push', [
    `[ -e "${once}" ] && exit 0`,
    `touch "${once}"`,
    'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
    `git -C "${b}" push -q origin tasks`,
    'exit 1',
  ].join('\n'));
  hook(a, 'post-rewrite', 'echo "another chat\'s edit" >> 001-one.md && git add 001-one.md');

  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']); ident(repo);
  writeFileSync(join(repo, '.gitignore'), '.cogyard/tasks\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'seed']);
  mkdirSync(join(repo, '.cogyard'));
  symlinkSync(a, join(repo, '.cogyard', 'tasks'));

  const env = { ...process.env, COGYARD_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [CLI, 'next-id', 'mine'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.padded, '003', 'the clash with the teammate\'s 002 re-numbered the reservation');
  assert.equal(out.pushed, true);

  const files = git(a, ['show', '--name-status', '--format=', 'HEAD']).split('\n').filter(Boolean);
  assert.deepEqual(files, ['A\t003-mine.md'], 'the amended reservation commit holds only the reservation');
  assert.equal(git(a, ['log', '-1', '--format=%s']), 'reserve id 003 (mine)');
  // The other chat's staged edit is still staged, still uncommitted.
  assert.equal(git(a, ['diff', '--cached', '--name-only']), '001-one.md');
});
