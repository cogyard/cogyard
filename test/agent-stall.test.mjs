// test/agent-stall.test.mjs — SUPERVISION BY SILENCE (task 138).
//
// The owner's complaint, in his words: "blindly aborting something based on the
// time seems weird and wrong, since different projects have different sizes and
// the summary will take different amounts." He was right, and the flat 240s cap
// killed a night's briefs five projects at a time — every cause reaching him as
// the same word, "aborted".
//
// The evidence that settled the design (jobs.json, 2026-09-04): the night was
// BIMODAL with nothing in between. Written at 11s, 28s, 29s; aborted at 361s,
// 416s, 672s, 902s, 1038s. A small project wrote in 29 seconds and another small
// project hung for seventeen minutes, and the same project succeeded one night
// and hung the next — so size was never the variable. A call either answers
// quickly or it never answers at all, which is exactly the distribution a
// silence timeout suits: the quick ones stream continuously and are never
// touched, and a call that has produced nothing for N seconds is already in the
// failed mode.
//
// Everything here uses HOSTILE FAKE AGENTS — one that streams forever, one that
// says nothing, one that stops mid-answer. They are deterministic, instant, and
// free, unlike waiting for a bad night.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The brief job writes under $COGYARD_HOME by slug (task 187), so the fake runs
// below must not reach the real ~/.cogyard — they did, leaving `ok-one`,
// `ok-two` and `stalls` briefs beside the owner's. Set BEFORE any module loads.
const HOME = mkdtempSync(join(tmpdir(), 'cogyard-stall-home-'));
process.env.COGYARD_HOME = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

const { loadAdapter } = await import('../core/drivers.mjs');
const claude = await loadAdapter('claude');

// --- fake agents --------------------------------------------------------------
//
// The adapter starts its silence clock at spawn, so everything between spawn
// and a fake's first byte counts as silence — correctly, for a real agent. Two
// costs sat in that gap, and under full-suite load they outlasted the 400–600ms
// windows below, failing three tests as `no-response` (task 184):
//
//   * The FIRST run of a newly written executable. macOS checks a new file
//     before it lets it run, once: measured 2026-10-11 at 143–178ms for a
//     two-line shell script on an idle machine, then 4–5ms every run after.
//     Every test here writes a fresh fake, so every test paid it, and the
//     check is a system service that every test file writing scripts queues
//     on. So fakeBin runs each fake once, with `--warm`, before handing it over.
//   * Booting node: ~30ms warm on an idle machine, more under load. So the fakes
//     that must SPEAK on time are /bin/sh scripts, whose first byte is a fork
//     and a printf. The mute fake stays node: it produces nothing however long
//     it takes to boot, and its SIGTERM refusal needs a real handler.
//
// That keeps the windows measuring the adapter, not the machine, and as short as
// the assertions need. Raising them instead would have made the "never killed"
// test run for many multiples of a longer window, and still raced a slow check.

// Writes a stand-in `claude` binary, runs it once so the adapter's spawn is not
// its first, and returns its path. `lines` are the script after the shebang;
// they own what the fake puts on stdout and when.
function fakeBin(shebang, lines) {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-stall-'));
  const bin = join(dir, 'claude');
  const warm = shebang.endsWith('node')
    ? "if (process.argv[2] === '--warm') process.exit(0);"
    : '[ "$1" = --warm ] && exit 0';
  writeFileSync(bin, [shebang, warm, ...lines].join('\n') + '\n');
  chmodSync(bin, 0o755);
  spawnSync(bin, ['--warm'], { stdio: 'ignore', timeout: 30000 });
  return { bin, dir };
}

// One stream-json line as a shell word. JSON never contains a single quote here.
const say = (o) => `printf '%s\\n' '${JSON.stringify(o)}'`;
const EVENT = { type: 'stream_event', event: {} };
const RESULT = { type: 'result', is_error: false, result: 'DONE', total_cost_usd: 0.01, modelUsage: { m: { outputTokens: 9 } } };

// Emits an event every `everyMs` for `count` events, then a result envelope.
// The first event goes out before the first sleep, so nothing but the shell's
// own start stands between spawn and the first byte.
const dribbler = (everyMs, count) => fakeBin('#!/bin/sh', [
  'i=0',
  `while [ "$i" -lt ${count} ]; do`,
  `  ${say(EVENT)}`,
  '  i=$((i + 1))',
  `  sleep ${everyMs / 1000}`,
  'done',
  say(RESULT),
]);

// Says nothing at all, ever, and refuses SIGTERM — the never-connected case,
// with the leak that made the old kill a polite request.
const mute = () => fakeBin('#!/usr/bin/env node', [
  "process.on('SIGTERM', () => {});",
  'setTimeout(() => process.exit(0), 60000);',
]);

// Emits a few events, then stops for good — the stall. `exec` so the SIGTERM
// lands on the sleep itself; a shell left waiting on it would die and leave the
// sleep holding stdout open for the full minute.
const stopper = (count = 3) => fakeBin('#!/bin/sh', [
  ...Array.from({ length: count }, () => say(EVENT)),
  'exec sleep 60',
]);

async function withBin(bin, fn) {
  const prev = process.env.CLAUDE_CODE_BIN;
  process.env.CLAUDE_CODE_BIN = bin;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_BIN;
    else process.env.CLAUDE_CODE_BIN = prev;
  }
}

// --- the acceptance test for the whole task ----------------------------------

test('a call that keeps producing is NEVER killed, however long it runs', async () => {
  // THE owner's complaint, as a test. This fake runs for ~3s in steady dribble
  // — six times a silence window of 500ms, so a duration-based cap of any
  // comparable size would have killed it. It must finish.
  //
  // The window has to comfortably exceed the fake's OWN startup too: silence is
  // measured from spawn, so a binary that has not booted yet is correctly
  // indistinguishable from one that will never answer. That is why this fake
  // is warmed and is a shell script — see "fake agents" above.
  const { bin, dir } = dribbler(50, 60);
  try {
    const r = await withBin(bin, () => claude.agent.run({
      prompt: 'hello', silenceMs: 500, ceilingMs: 30000,
    }));
    assert.equal(r.ok, true, `killed a working call: ${r.error}`);
    assert.equal(r.text, 'DONE');
    assert.equal(r.failure, null);
    assert.ok(r.elapsedMs > 1000, `elapsed ${r.elapsedMs}ms should far exceed the silence window`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a call that produces nothing at all is failed promptly, as no-response', async () => {
  const { bin, dir } = mute();
  try {
    const t0 = Date.now();
    const r = await withBin(bin, () => claude.agent.run({
      prompt: 'hello', silenceMs: 500, ceilingMs: 30000,
    }));
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    // Nothing ever arrived: the agent was never reached. Not "stalled" — that
    // would send the owner looking for a wedged model instead of a dead
    // credential or an unreachable server.
    assert.equal(r.failure, 'no-response');
    assert.equal(r.ttfbMs, null, 'no first byte, so no time-to-first-byte');
    // This fake refuses SIGTERM, so the wait includes the kill grace — the call
    // does not come back until the child is genuinely gone. Still two orders of
    // magnitude inside the old 240s cap.
    assert.ok(took < 10000, `failed in ${took}ms — must be well inside the old 240s cap`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a call that starts and then stops is failed after the silence window, as stalled', async () => {
  const { bin, dir } = stopper();
  try {
    const t0 = Date.now();
    const r = await withBin(bin, () => claude.agent.run({
      prompt: 'hello', silenceMs: 400, ceilingMs: 30000,
    }));
    const took = Date.now() - t0;
    assert.equal(r.ok, false);
    // Output began, so the agent was reachable and the credential is fine. The
    // call wedged. Different diagnosis, different word.
    assert.equal(r.failure, 'stalled');
    assert.ok(typeof r.ttfbMs === 'number', 'it did produce a first byte');
    assert.ok(took >= 400, `failed after ${took}ms — must wait out the silence window`);
    assert.ok(took < 10000, `failed after ${took}ms — must not wait for the ceiling`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the absolute ceiling stops a stream that dribbles forever', async () => {
  // Never silent, never finished: the one case silence alone cannot catch, and
  // the only reason a ceiling exists at all.
  const { bin, dir } = dribbler(30, 100000);
  try {
    const r = await withBin(bin, () => claude.agent.run({
      prompt: 'hello', silenceMs: 5000, ceilingMs: 600,
    }));
    assert.equal(r.ok, false);
    assert.equal(r.failure, 'stalled');
    assert.match(r.error, /ceiling/);
    assert.ok(r.elapsedMs < 5000, 'the ceiling fired, not the silence window');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a killed child actually dies — SIGTERM is escalated, not merely sent', async () => {
  // The leak this closes, measured 2026-09-04: Node's spawn(signal) sent one
  // SIGTERM, reported AbortError in 10ms, and left the child alive holding this
  // process's stdio pipes. In the always-on portal that accumulates.
  const { bin, dir } = mute();          // ignores SIGTERM on purpose
  try {
    const before = new Set(pids(bin));
    const r = await withBin(bin, () => claude.agent.run({
      prompt: 'hello', silenceMs: 200, ceilingMs: 30000,
    }));
    assert.equal(r.failure, 'no-response');
    // The kill grace is 2s and run() already waited out the child's close;
    // give it a moment more, then insist nothing is left.
    await new Promise((res) => setTimeout(res, 1000));
    const after = pids(bin).filter((p) => !before.has(p));
    assert.deepEqual(after, [], `left ${after.length} process(es) alive: ${after.join(', ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Every live pid whose command line mentions this fake binary.
function pids(bin) {
  const r = spawnSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  return String(r.stdout || '').split('\n')
    .filter((l) => l.includes(bin))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// --- the run keeps going ------------------------------------------------------

test('one stalled project does not consume the run — the rest still get their calls', async () => {
  // The nightly failure mode this protects: five aborted projects at 240s+ each
  // ate the whole run, so the projects after them went unobserved entirely.
  const { manifest } = await import('../extras/addons/project-brief/addon.mjs');
  const PARA = 'This is a paragraph of ordinary narrative prose about the project and what happened in it lately, long enough to pass the usability bar the parser applies.';

  let call = 0;
  const agent = {
    supported: true,
    calls: 0,
    async run() {
      agent.calls += 1;
      // The first project stalls; every one after it answers normally.
      if (++call === 1) {
        return { ok: false, text: '', cost: null, model: null,
          error: 'the agent went silent', failure: 'stalled', elapsedMs: 91000, ttfbMs: 800 };
      }
      return { ok: true, text: [PARA, PARA, PARA].join('\n\n'), cost: 0.05, model: 'm',
        error: null, failure: null, elapsedMs: 12000, ttfbMs: 700 };
    },
  };

  const projects = [makeProject('stalls'), makeProject('ok-one'), makeProject('ok-two')];
  const lines = [];
  const res = await manifest.runScheduled(
    { detail: false },
    { projects, agent, log: (l) => lines.push(l), bounds: manifest.bounds },
  );

  assert.equal(agent.calls, 3, 'the stall must not stop the projects behind it');
  assert.match(res.summary, /1 FAILED/);
  assert.match(res.summary, /2 written/);
  // And the failure says WHAT, not just that it failed.
  assert.ok(lines.some((l) => /stopped mid-answer/.test(l)), lines.join('\n'));
  for (const p of projects) rmSync(p.path, { recursive: true, force: true });
});

// A project the brief job can look at: a git repo with a commit and a task store.
function makeProject(slug) {
  const dir = mkdtempSync(join(tmpdir(), `cogyard-stall-${slug}-`));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(dir, '.cogyard', 'tasks'), { recursive: true });
  writeFileSync(join(dir, '.cogyard', 'tasks', '001-a-task.md'), '---\nid: 1\nstatus: OPEN\ntitle: A task\n---\n\nbody\n');
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'seed']);
  return { slug, label: slug, path: dir };
}
