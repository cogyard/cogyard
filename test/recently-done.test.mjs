// test/recently-done.test.mjs — core/recently-done.mjs (task 198): which closed
// tasks the Plan tab's Recently done strip shows, and in what order.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { recentlyDone } from '../core/recently-done.mjs';

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function project() {
  const repo = mkdtempSync(join(tmpdir(), 'cogyard-recent-'));
  roots.push(repo);
  const store = join(repo, '.cogyard', 'tasks');
  mkdirSync(store, { recursive: true });
  // `at` sets the file's modified time (seconds), the order's fallback.
  const task = (file, fm, body = '', at = 1) => {
    writeFileSync(join(store, file), `---\n${fm}\n---\n# t\n${body}`);
    utimesSync(join(store, file), at, at);
  };
  return { repo, store, task };
}

test('DONE tasks with a date only, newest date first; same day, the one saved last first', async () => {
  const { repo, task } = project();
  task('001-a.md', 'id: 1\ntitle: A\nstatus: DONE\ndone_date: 2026-10-05', '- [x] one\n- [ ] two\n');
  task('002-b.md', 'id: 2\ntitle: B\nstatus: DONE\ndone_date: 2026-10-09', '', 2000); // closed after 3
  task('003-c.md', 'id: 3\ntitle: C\nstatus: DONE\ndone_date: 2026-10-09', '', 1000);
  task('004-d.md', 'id: 4\ntitle: D\nstatus: ENOUGH\ndone_date: 2026-10-09');
  task('005-e.md', 'id: 5\ntitle: E\nstatus: OBSOLETE\ndone_date: 2026-10-09');
  task('006-f.md', 'id: 6\ntitle: F\nstatus: DONE\ndone_date: null');
  task('007-g.md', 'id: 7\ntitle: G\nstatus: OPEN');
  task('008-h.md', 'id: 8\ntitle: H\nstatus: DONE\ndone_date: 2026-07-03  # shipped in the cleanup session');
  const r = await recentlyDone({ path: repo });
  assert.deepEqual(r.map((t) => t.id), ['2', '3', '1', '8']);
  assert.deepEqual(r[2], { id: '1', title: 'A', type: null, labels: [], doneDate: '2026-10-05', done: 1, total: 2,
    boxes: [{ done: true, onMain: null }, { done: false, onMain: null }] });
  assert.equal(r[3].doneDate, '2026-07-03');
  assert.deepEqual((await recentlyDone({ path: repo }, 2)).map((t) => t.id), ['2', '3']);
});

test('each done task carries its type and labels, so its card matches the Plan card (task 227)', async () => {
  const { repo, task } = project();
  task('001-a.md', 'id: 1\ntitle: A\ntype: bug\nlabels: [frontend, store]\nstatus: DONE\ndone_date: 2026-10-05');
  const [t] = await recentlyDone({ path: repo });
  assert.equal(t.type, 'bug');
  assert.deepEqual(t.labels, ['frontend', 'store']);
});

test('each done task carries its boxes in file order, settled ones left out, length = total (task 251)', async () => {
  const { repo, task } = project();
  task('001-a.md', 'id: 1\ntitle: A\nstatus: DONE\ndone_date: 2026-10-05',
    '- [ ] (optional) first\n- [x] second\n- [ ] (dropped: moot) gone\n- [x] third\n- [ ] (moved: 9) elsewhere\n');
  const [t] = await recentlyDone({ path: repo });
  assert.deepEqual(t.boxes.map((b) => b.done), [false, true, true]);
  assert.equal(t.boxes.length, t.total);
  assert.ok(t.boxes.every((b) => b.onMain === null), 'a finished task has no code state');
});

test('in a store with history, same-day order is the order of the commits that closed them', async () => {
  const { repo, store, task } = project();
  const env = { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'a@b.c' };
  const git = (when, ...args) => execFileSync('git', ['-C', store, '-c', 'core.hooksPath=/dev/null', ...args],
    { stdio: 'ignore', env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
  git('2026-10-01T00:00:00Z', 'init', '-q');
  task('160-a.md', 'id: 160\nstatus: OPEN\ndone_date: null');
  task('196-b.md', 'id: 196\nstatus: OPEN\ndone_date: null');
  git('2026-10-01T00:00:00Z', 'add', '-A');
  git('2026-10-01T00:00:00Z', 'commit', '-qm', 'add');
  // 196 closes first, 160 last — the files' saved times say the opposite, and
  // a later edit to 196 that leaves its done_date alone must not move it.
  task('196-b.md', 'id: 196\nstatus: DONE\ndone_date: 2026-10-09', '', 5000);
  git('2026-10-09T00:52:00Z', 'commit', '-qam', 'close 196');
  task('160-a.md', 'id: 160\nstatus: DONE\ndone_date: 2026-10-09', '', 1000);
  git('2026-10-09T02:28:00Z', 'commit', '-qam', 'close 160');
  task('196-b.md', 'id: 196\nstatus: DONE\ndone_date: 2026-10-09', 'a note\n', 6000);
  git('2026-10-09T03:00:00Z', 'commit', '-qam', 'note on 196');
  assert.deepEqual((await recentlyDone({ path: repo })).map((t) => t.id), ['160', '196']);
});
