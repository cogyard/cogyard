// Tests for the UserPromptSubmit routing hook
// (drivers/claude/hooks/userpromptsubmit-task-skill-guard.sh).
//
// The hook is run as Claude Code runs it: the prompt JSON on stdin, from a
// throwaway folder that has a `.cogyard/tasks` link (a cogyard project) or not.
// It prints the write-task routing text for a make-or-file-a-task request and
// stays silent for anything else — a pickup of an existing task above all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'drivers', 'claude', 'hooks', 'userpromptsubmit-task-skill-guard.sh');

let ROOT, PROJECT, PLAIN;

before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-routing-')));
  PROJECT = join(ROOT, 'project');
  mkdirSync(join(PROJECT, '.cogyard', 'tasks'), { recursive: true });
  PLAIN = join(ROOT, 'plain');
  mkdirSync(PLAIN, { recursive: true });
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

function routes(prompt, cwd = PROJECT) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ prompt, cwd }),
    encoding: 'utf8',
    env: { ...process.env, HOME: ROOT },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.includes('TASK-WRITING REQUEST DETECTED');
}

const ROUTED = [
  'make this a task',
  'Make it into a task please',
  'this is a new task',
  'That is a task for later',
  'make a task for all of this',
  'file the task',
  'ok, file a task for the reload bug',
  // shapes that already routed before task 247 — still do
  'write a task for this',
  'file this as a task',
  'park this',
  'spec this out',
];

for (const prompt of ROUTED) {
  test(`routes to write-task: "${prompt}"`, () => {
    assert.equal(routes(prompt), true);
  });
}

const SILENT = [
  'pick up 246',
  'pick up task 246',
  'do task 37',
  'what does this function do',
  "what's in tasks?",
  'tick item 3 in 247',
];

for (const prompt of SILENT) {
  test(`stays silent: "${prompt}"`, () => {
    assert.equal(routes(prompt), false);
  });
}

test('the routing text says a task request never starts a session', () => {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ prompt: 'make this a task', cwd: PROJECT }),
    encoding: 'utf8',
    env: { ...process.env, HOME: ROOT },
  });
  assert.match(r.stdout, /NEVER a request to start a new\s+session/);
});

test('stays silent outside a cogyard project', () => {
  assert.equal(routes('make this a task', PLAIN), false);
});
