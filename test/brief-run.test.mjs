// test/brief-run.test.mjs — the nightly run END TO END, against a real git repo
// and a real task store, with a COUNTING FAKE AGENT.
//
// brief-silence.test.mjs proves each input signal in isolation. This one proves
// the thing the owner actually cares about: on a quiet night nobody is billed.
// The assertion that matters in every case below is `agent.calls` — the run's
// summary can say whatever it likes, but a call that happened was paid for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-run-home-'));
process.env.COGYARD_HOME = HOME;
mkdirSync(join(HOME, 'usage'), { recursive: true });
writeFileSync(join(HOME, 'usage', 'activity.jsonl'), '');

const { manifest } = await import('../extras/addons/project-brief/addon.mjs');
const { newestBrief, listBriefs, readBrief } = await import('../extras/addons/project-brief/store.mjs');
const { readHeartbeats } = await import('../core/briefs.mjs');

const PARA = 'This is a paragraph of ordinary narrative prose about the project and what happened in it lately, long enough to pass the usability bar the parser applies.';
const THREE = [PARA, PARA, PARA].join('\n\n');

function git(repo, args) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

// A project the job can actually look at: a git repo with one commit and a task
// store with one task in it. Each gets its own slug, because since task 187 the
// job's output is keyed by slug under HOME — two tests sharing 'demo' would read
// each other's briefs.
let seq = 0;
function project(slug = `demo-${++seq}`) {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-run-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  mkdirSync(join(dir, '.cogyard', 'tasks'), { recursive: true });
  writeFileSync(join(dir, '.cogyard', 'tasks', '001-a-task.md'), '---\nid: 1\nstatus: OPEN\ntitle: A task\n---\n\nbody\n');
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'seed']);
  return { slug, label: slug, path: dir };
}

// Counts every call. `calls` is the whole point of this file.
function fakeAgent(text = THREE) {
  const a = {
    supported: true,
    calls: 0,
    async run() {
      a.calls += 1;
      return { ok: true, text, cost: 0.05, model: 'test-model' };
    },
  };
  return a;
}

async function run(projects, agent, cfg = {}) {
  const lines = [];
  const res = await manifest.runScheduled(
    { detail: false, ...cfg },
    { projects, agent, log: (l) => lines.push(l), bounds: manifest.bounds },
  );
  return { res, lines };
}

test('the first night writes a brief — there is a story to tell', async () => {
  const p = project();
  const agent = fakeAgent();
  const { res } = await run([p], agent);
  assert.equal(agent.calls, 1);
  assert.match(res.summary, /1 written/);
  assert.equal(newestBrief(p.slug)?.meta?.status, 'ok');
  rmSync(p.path, { recursive: true, force: true });
});

// Task 187: the night's output goes to HOME, never into the project's task store
// — where nothing committed it and an unrelated sync push swept it up.
test('a night writes its brief and heartbeat under HOME and leaves the task store untouched', async () => {
  const p = project();
  const before = readdirSync(join(p.path, '.cogyard', 'tasks')).sort();
  await run([p], fakeAgent());
  assert.deepEqual(readdirSync(join(p.path, '.cogyard', 'tasks')).sort(), before, 'nothing new in the store');
  assert.ok(existsSync(join(HOME, 'briefs', p.slug)), 'the brief is under HOME/briefs/<slug>');
  assert.ok(existsSync(join(HOME, 'heartbeats', p.slug, 'project-brief.md')), 'the heartbeat is under HOME/heartbeats/<slug>');
  rmSync(p.path, { recursive: true, force: true });
});

test('the SECOND night, with nothing changed, calls no agent and costs nothing', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);
  assert.equal(agent.calls, 1, 'first night writes');

  const { res, lines } = await run([p], agent);
  assert.equal(agent.calls, 1, 'the second night must not call the agent at all');
  assert.equal(res.cost, 0);
  assert.match(res.summary, /1 unchanged/);
  assert.ok(lines.some((l) => /carried forward, no agent call/.test(l)), lines.join('\n'));
  assert.equal(listBriefs(p.slug).length, 1, 'and writes no second file');
  rmSync(p.path, { recursive: true, force: true });
});

// Task 195: a checkout that moves is re-registered under a new slug, and core
// hands the job the old one as `formerSlugs`. The brief written under the old
// slug is still the previous brief — a quiet night stays free.
test('the first night after a slug change finds the old slug\'s brief and calls no agent', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);
  assert.equal(agent.calls, 1, 'written under the old slug');

  const moved = { ...p, slug: `${p.slug}-moved`, formerSlugs: [p.slug] };
  const { res } = await run([moved], agent);
  assert.equal(agent.calls, 1, 'the move must not buy a "first" brief');
  assert.match(res.summary, /1 unchanged/);
  assert.equal(listBriefs(moved.slug).length, 1, 'the carried-forward copy lands under the new slug');
  assert.equal(newestBrief(p.slug).meta.carried_through, undefined, 'the old slug\'s file is left as it was');
  rmSync(p.path, { recursive: true, force: true });
});

test('a quiet night stamps the previous brief as still current', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);
  await run([p], agent);
  const b = newestBrief(p.slug);
  assert.ok(b.meta.carried_through, 'the carry-forward stamp is the quiet night\'s record');
  rmSync(p.path, { recursive: true, force: true });
});

test('claiming and releasing a task — a byte-identical rewrite — is still a quiet night', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);

  // What `cogyard env claim` + `env release` leaves behind: same bytes, new mtime.
  const f = join(p.path, '.cogyard', 'tasks', '001-a-task.md');
  writeFileSync(f, readFileSync(f));

  await run([p], agent);
  assert.equal(agent.calls, 1, 'mtime moved, content did not — nothing happened');
  rmSync(p.path, { recursive: true, force: true });
});

test('a regenerated INDEX.md is not a reason to write a brief', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);

  writeFileSync(join(p.path, '.cogyard', 'tasks', 'INDEX.md'), '# Index\n\nregenerated by a sync push in another project\n');

  await run([p], agent);
  assert.equal(agent.calls, 1);
  rmSync(p.path, { recursive: true, force: true });
});

test('a real commit is news and buys a brief', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);

  writeFileSync(join(p.path, 'README.md'), 'seed\nand a real change\n');
  git(p.path, ['add', '-A']);
  git(p.path, ['commit', '-qm', 'a real change']);

  const { res } = await run([p], agent);
  assert.equal(agent.calls, 2, 'work landed — that is what a brief is for');
  assert.match(res.summary, /1 written/);
  rmSync(p.path, { recursive: true, force: true });
});

test('a real task-file edit is news and buys a brief', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);

  const f = join(p.path, '.cogyard', 'tasks', '001-a-task.md');
  writeFileSync(f, '---\nid: 1\nstatus: OPEN\ntitle: A task\n---\n\nbody, meaningfully rewritten\n');
  // Date the edit a second after the brief, explicitly (task 184). The job
  // names an edited file only when its mtime is LATER than the brief's
  // `generated_at`, and this write lands 1–2ms after that stamp. Linux stamps
  // file times from a coarse kernel clock that can trail Date.now() by a few
  // ms, so on CI the edit read as older than the brief, the night as quiet,
  // and this failed on most runs. A real edit is never milliseconds after a
  // nightly run, so the product's rule stays; only the test's clock is pinned.
  const later = new Date(new Date(newestBrief(p.slug).meta.generated_at).getTime() + 1000);
  utimesSync(f, later, later);

  const { res } = await run([p], agent);
  assert.equal(agent.calls, 2);
  assert.match(res.summary, /1 written/);
  rmSync(p.path, { recursive: true, force: true });
});

test('a brief that FAILED is retried, never carried forward', async () => {
  const p = project();
  // An agent that answers with something that is not a brief: a failed night.
  const bad = { supported: true, calls: 0, async run() { bad.calls += 1; return { ok: true, text: 'no.', cost: 0.01, model: 'test-model' }; } };
  await run([p], bad);
  assert.equal(newestBrief(p.slug)?.meta?.status, 'failed');

  // Nothing has happened in the project since. It must STILL try again: a failed
  // brief means the state is unknown, and unknown is not the same as unchanged.
  await run([p], bad);
  assert.equal(bad.calls, 2, 'a failure is retried even on a quiet night');
  rmSync(p.path, { recursive: true, force: true });
});

test('the written brief records the digest the next night compares against', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);
  const meta = newestBrief(p.slug).meta;
  assert.match(String(meta.tasks_digest), /^[0-9a-f]{16}$/);
  rmSync(p.path, { recursive: true, force: true });
});

test('a project with no task store is skipped, not failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-run-nostore-'));
  const agent = fakeAgent();
  const { res } = await run([{ slug: 'bare', label: 'bare', path: dir }], agent);
  assert.equal(agent.calls, 0);
  assert.match(res.summary, /without a task store/);
  rmSync(dir, { recursive: true, force: true });
});

// --- the heartbeat (task 134) -------------------------------------------------
//
// Once a quiet night correctly writes nothing, silence stops being evidence. The
// heartbeat is what keeps "quiet" and "dead" distinguishable, so the case that
// matters most here is that a QUIET night still leaves one.

test('a quiet night — the one that writes no brief — still leaves a heartbeat', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);
  await run([p], agent);
  assert.equal(agent.calls, 1, 'quiet, as established');

  const [hb] = readHeartbeats(p.slug);
  assert.equal(hb.job, 'project-brief');
  assert.equal(hb.outcome, 'unchanged');
  assert.match(hb.note, /Nothing had happened/);
  rmSync(p.path, { recursive: true, force: true });
});

test('a night that writes a brief also leaves a heartbeat', async () => {
  const p = project();
  await run([p], fakeAgent());
  assert.equal(readHeartbeats(p.slug)[0].outcome, 'written');
  rmSync(p.path, { recursive: true, force: true });
});

test('a night that FAILS leaves a heartbeat — the job is alive, it just cannot write', async () => {
  const p = project();
  const dead = { supported: true, calls: 0, async run() { dead.calls += 1; return { ok: false, text: '', cost: 0, error: 'credential expired' }; } };
  await run([p], dead);
  assert.equal(readHeartbeats(p.slug)[0].outcome, 'failed',
    'alive-but-failing and dead-and-silent send the owner to different repairs');
  rmSync(p.path, { recursive: true, force: true });
});

test('a project skipped by the run ceiling leaves NO heartbeat — it really was unobserved', async () => {
  const a = project('a');
  const b = project('b');
  await manifest.runScheduled({ detail: false }, {
    projects: [a, b], agent: fakeAgent(), log: () => {},
    bounds: { ...manifest.bounds, maxUnits: 1 },
  });
  assert.equal(readHeartbeats(a.slug).length, 1);
  assert.deepEqual(readHeartbeats(b.slug), [],
    'a project the run never reached must not claim to have been checked');
  rmSync(a.path, { recursive: true, force: true });
  rmSync(b.path, { recursive: true, force: true });
});

test('the heartbeat is overwritten each night, never accumulated', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);
  await run([p], agent);
  await run([p], agent);
  assert.equal(readHeartbeats(p.slug).length, 1);
  rmSync(p.path, { recursive: true, force: true });
});

// --- the stale-branch trap (task 134) ----------------------------------------
//
// The one that cost the most. `git log --all <sinceHead>..HEAD` reads as
// "everything reachable from ANY ref, minus what sinceHead reaches", so every
// commit on every branch that sinceHead cannot reach comes back as new — every
// night, forever. This repo works exactly like the projects that broke: a dozen
// task branches, most of them sitting still.

// A branch that diverged and then stopped — and main moving on past it, which
// is what makes them DIVERGE rather than one being an ancestor of the other.
// That divergence is the whole bug: if main can reach the branch, `--all
// main..HEAD` is empty and everything looks fine. Getting this fixture wrong is
// how a test for this can pass against the broken code.
function staleBranch(p, name, message) {
  git(p.path, ['checkout', '-q', '-b', name]);
  writeFileSync(join(p.path, `${name}.txt`), 'old work\n');
  git(p.path, ['add', '-A']);
  git(p.path, ['commit', '-qm', message]);
  git(p.path, ['checkout', '-q', 'main']);
  writeFileSync(join(p.path, `main-past-${name}.txt`), 'main moved on\n');
  git(p.path, ['add', '-A']);
  git(p.path, ['commit', '-qm', `main moves on past ${name}`]);
}

test('a branch that has sat still for months is not news, ever', async () => {
  const p = project();
  staleBranch(p, 'task-007-old', 'work that landed long before the first brief');

  const agent = fakeAgent();
  await run([p], agent);
  assert.equal(agent.calls, 1, 'the first brief always writes');

  // Nothing has happened since. The stale branch is still there, still still.
  await run([p], agent);
  assert.equal(agent.calls, 1, 'a motionless branch must not read as new work');

  // And it must not come back on the third night either — the old bug reported
  // it forever, not once.
  await run([p], agent);
  assert.equal(agent.calls, 1);
  rmSync(p.path, { recursive: true, force: true });
});

test('work on a task BRANCH is news — that is why --all is there at all', async () => {
  const p = project();
  const agent = fakeAgent();
  await run([p], agent);

  // The normal shape of work here: a commit on a worktree branch, never on main.
  git(p.path, ['checkout', '-q', '-b', 'task-042-real']);
  writeFileSync(join(p.path, 'feature.txt'), 'real work\n');
  git(p.path, ['add', '-A']);
  git(p.path, ['commit', '-qm', 'a real commit on a task branch']);
  git(p.path, ['checkout', '-q', 'main']);

  await run([p], agent);
  assert.equal(agent.calls, 2, 'a brief that only watched main would miss almost everything');
  rmSync(p.path, { recursive: true, force: true });
});

test('the written brief records the frontier, reduced to independent tips', async () => {
  const p = project();
  staleBranch(p, 'task-007-old', 'old work');   // leaves main and the branch divergent
  await run([p], fakeAgent());

  const refs = String(newestBrief(p.slug).meta.refs || '').split(/\s+/).filter(Boolean);
  assert.equal(refs.length, 2, 'two divergent branches are two independent tips');
  for (const sha of refs) assert.match(sha, /^[0-9a-f]{7,40}$/);
  rmSync(p.path, { recursive: true, force: true });
});

test('the frontier is REDUCED — a branch main can reach earns no sha of its own', async () => {
  const p = project();
  // Branch, commit, and leave main where it is: main is now an ancestor of the
  // branch, so the frontier is one sha, not two. This is the reduction that
  // takes 136 refs to 8 on the real repo and keeps the line readable.
  git(p.path, ['checkout', '-q', '-b', 'task-009-ahead']);
  writeFileSync(join(p.path, 'ahead.txt'), 'work\n');
  git(p.path, ['add', '-A']);
  git(p.path, ['commit', '-qm', 'ahead of main']);
  git(p.path, ['checkout', '-q', 'main']);

  await run([p], fakeAgent());

  const refs = String(newestBrief(p.slug).meta.refs || '').split(/\s+/).filter(Boolean);
  assert.equal(refs.length, 1);
  rmSync(p.path, { recursive: true, force: true });
});

test('a brief written before the frontier existed still detects a quiet night', async () => {
  // Back-compat: every brief on disk today has `head` but no `refs`. Such a
  // night falls back to committer date, which must not resurrect old commits.
  const p = project();
  staleBranch(p, 'task-007-old', 'old work');
  const agent = fakeAgent();
  await run([p], agent);

  // Strip the frontier, leaving the brief shaped like the ones already written.
  const file = newestBrief(p.slug).file;
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^refs: .*\n/m, ''));

  await run([p], agent);
  assert.equal(agent.calls, 1, 'the time fallback must not report months-old commits as new');
  rmSync(p.path, { recursive: true, force: true });
});

test('no agent driver at all writes nothing and alarms nobody', async () => {
  const p = project();
  const { res } = await run([p], { supported: false });
  assert.equal(res.skipped, true);
  assert.equal(listBriefs(p.slug).length, 0, 'a machine with no agent is configuration, not failure');
  assert.deepEqual(readHeartbeats(p.slug), [], 'nothing looked, so nothing claims to have looked');
  rmSync(p.path, { recursive: true, force: true });
});
