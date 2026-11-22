// test/in-progress.test.mjs — core/in-progress.mjs (task 265): the All tab's
// per-project boxes carry the Plan's own "in progress" tasks and the Recently
// done strip's newest 10, with no rules of their own.
//
// COGYARD_HOME is redirected to a throwaway dir BEFORE importing core, so the
// live agent state is read from there, never from the real ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-in-progress-'));
process.env.COGYARD_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const { inProgressAll, PROGRESS_FIELDS, RECENT_LIMIT } = await import('../core/in-progress.mjs');
const { planFor } = await import('../core/plan.mjs');
const { recentlyDone } = await import('../core/recently-done.mjs');

function project(slug) {
  const repo = join(HOME, slug);
  const store = join(repo, '.cogyard', 'tasks');
  mkdirSync(store, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, '.gitignore'), '.cogyard/\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=x', '-c', 'user.email=a@b.c', '-c', 'core.hooksPath=/dev/null', 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=x', '-c', 'user.email=a@b.c', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'init']);
  const task = (file, fm, body = '', at = 1) => {
    writeFileSync(join(store, file), `---\n${fm}\n---\n# t\n${body}`);
    utimesSync(join(store, file), at, at);
  };
  return { slug, label: slug, path: repo, task };
}

test('a box holds the Plan\'s in-progress tasks and the newest 10 closed — the same answers as the Plan tab', async () => {
  const p = project('alpha');
  p.task('001-a.md', 'id: 1\ntitle: Claimed\nstatus: OPEN\nenv:\n  claimed_at: 2026-11-20T10:00:00Z\n  claimed_by: Sam', '- [x] one\n- [ ] two\n');
  p.task('002-b.md', 'id: 2\ntitle: Not claimed\nstatus: OPEN');
  p.task('003-c.md', 'id: 3\ntitle: Parked\nstatus: PARKED');
  for (let i = 10; i < 22; i++) p.task(`0${i}-d.md`, `id: ${i}\ntitle: Done ${i}\nstatus: DONE\ndone_date: 2026-11-${i}`, '- [x] one\n', i);

  const [box] = await inProgressAll([p]);
  assert.equal(box.slug, 'alpha');
  assert.equal(box.label, 'alpha');
  assert.deepEqual(box.progress.map((t) => t.id), ['1']);
  assert.deepEqual(Object.keys(box.progress[0]).sort(), [...PROGRESS_FIELDS].sort());
  assert.equal(box.progress[0].title, 'Claimed');
  assert.equal(box.progress[0].claimedBy, 'Sam');
  assert.equal(box.recent.length, RECENT_LIMIT);
  assert.deepEqual(box.recent.map((t) => t.id), ['21', '20', '19', '18', '17', '16', '15', '14', '13', '12']);

  // No rules of its own: the same tasks as planFor's progress group and recentlyDone's list.
  const plan = await planFor(p, [p]);
  assert.deepEqual(box.progress.map((t) => t.id), plan.groups.progress);
  for (const t of box.progress) for (const k of PROGRESS_FIELDS) assert.deepEqual(t[k], plan.tasks[t.id][k] ?? null, `${t.id}.${k}`);
  assert.deepEqual(box.recent, await recentlyDone(p, RECENT_LIMIT));
});

test('a kept box is served until the project changes; a closed task shows on the next call', async () => {
  const p = project('gamma');
  p.task('001-a.md', 'id: 1\ntitle: A\nstatus: DONE\ndone_date: 2026-11-01', '', 10);
  const [first] = await inProgressAll([p]);
  const [again] = await inProgressAll([p]);
  assert.equal(again.recent, first.recent, 'nothing changed: the kept list itself comes back');
  p.task('002-b.md', 'id: 2\ntitle: B\nstatus: DONE\ndone_date: 2026-11-02', '', 20);
  const [after] = await inProgressAll([p]);
  assert.deepEqual(after.recent.map((t) => t.id), ['2', '1']);
});

test('a project that cannot be read gets an error row; the others still get their boxes', async () => {
  const ok = project('beta');
  ok.task('001-a.md', 'id: 1\ntitle: A\nstatus: DONE\ndone_date: 2026-11-01');
  const broken = { slug: 'gone', label: 'Gone', path: join(HOME, 'nowhere'), error: 'path missing' };
  const rows = await inProgressAll([broken, ok]);
  assert.deepEqual(rows[0], { slug: 'gone', label: 'Gone', error: 'path missing' });
  assert.deepEqual(rows[1].progress, []);
  assert.deepEqual(rows[1].recent.map((t) => t.id), ['1']);
});
