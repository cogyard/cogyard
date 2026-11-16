// test/commit-tags.test.mjs — task 152: `[#NN]` commit credit comes only from
// `git commit` commands the chat actually RAN.
//
// It used to be any transcript line containing both "git commit" and "[#NN]".
// A loaded skill is one line, and the /commit skill's own example reads
// `git commit -m "… [#37] fix(viewer): …"`, so every chat that loaded it was
// credited with committing #37 and #40 — 20 of where-is-maya's 63 open chats,
// and $187.65 of Stats cost moved onto #37.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { harvestTaskRefs } = await import('../core/usage.mjs');

const harvest = (line, commands) => {
  const tasks = {}, commitTasks = {};
  harvestTaskRefs(line, commands ? { commands } : null, tasks, commitTasks);
  return commitTasks;
};

test('text that merely contains "git commit" and a tag earns nothing', () => {
  const skillText = 'Pass the message via a HEREDOC:\n```bash\ngit commit -m "$(cat <<\'EOF\'\n[#37] fix(viewer): dim DONE rows\nEOF\n)"\n```';
  assert.deepEqual(harvest(JSON.stringify({ message: { content: skillText } }), []), {});
});

test("the /commit skill's own heredoc shape, actually run, is credited", () => {
  const cmd = 'git commit -m "$(cat <<\'EOF\'\n[#152] fix(cleanup): wait only on worked tasks\n\n- body line [#999]\nEOF\n)"';
  assert.deepEqual(harvest('{}', [cmd]), { 152: 1, 999: 1 });
});

test('git -C <path> commit, and a commit after && or ;, count', () => {
  assert.deepEqual(harvest('{}', ['git -C /r/.claude/worktrees/task-037-x commit -m "[#37] fix: y"']), { 37: 1 });
  assert.deepEqual(harvest('{}', ['cd /r && git add a.swift && git commit -q -F - <<\'EOF\'\n[#037] fix(ios): z\nEOF']), { 37: 1 });
});

test('a command that only QUOTES `git commit` (a grep, a script) is not a commit', () => {
  assert.deepEqual(harvest('{}', ["grep -n 'git commit' SKILL.md # [#37]"]), {});
  assert.deepEqual(harvest('{}', ["python3 - <<'PY'\n# the `git commit` example [#37]\nPY"]), {});
});

test('tags on OTHER commands in the same call are not commit credit', () => {
  // The message is the commit's own line (plus its heredoc body), not the
  // whole command string.
  assert.deepEqual(harvest('{}', ['git commit -m "[#5] a"\necho "[#6] unrelated"']), { 5: 1 });
});
