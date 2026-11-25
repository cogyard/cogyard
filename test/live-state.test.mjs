// test/live-state.test.mjs — what the agent on each claimed task is doing now
// (task 202): the Claude adapter's hook mapping, the live/ records, and the
// join from a task's claim to its record.
//
// $COGYARD_HOME is a throwaway folder, set before core is imported. The Claude
// adapter is loaded directly and the driver pinned to it, so the result never
// depends on whether this machine happens to have Claude installed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-live-')));
process.env.COGYARD_HOME = join(ROOT, 'home');
process.env.COGYARD_DRIVER = 'claude';
// The Claude adapter finds the app's chat list and the transcripts under HOME,
// so a throwaway HOME gives it a fake app to read (task 226).
const FAKE_HOME = join(ROOT, 'user');
process.env.HOME = FAKE_HOME;
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { loadAdapter, NOOP } = await import('../core/drivers.mjs');
const { recordEvent, liveForTask, liveSignature, pruneGone } = await import('../core/live-state.mjs');
const claude = await loadAdapter('claude');
const parse = (input) => claude.liveState.parseHook(input);

let n = 0;
const freshDir = () => join(ROOT, `live-${++n}`);
const S = 'sess-aaaa';
const claimed = (id, extra = {}) => ({ id, env: { claimed_at: '2026-10-13T00:00:00Z', claimed_by: 'Ben', claimed_by_session: S, ...extra } });
const feed = (dir, inputs, t0 = Date.now() - 60_000) => inputs.forEach((input, i) => recordEvent(parse(input), 'claude', { dir, now: t0 + i * 1000 }));
// What the app says about each chat; every chat is open unless a test says not.
const chats = (map = {}) => (s) => map[s] || 'open';
const open = chats();

// --- the adapter: Claude hook input → neutral event ---------------------------

test('no-op adapter: liveState is off', () => {
  assert.equal(NOOP.liveState.supported, false);
  assert.equal(NOOP.liveState.logo, null);
  assert.equal(NOOP.liveState.parseHook({ session_id: 's', hook_event_name: 'Stop' }), null);
});

test('Claude adapter maps each hook event to a state', () => {
  const ev = (hook_event_name, extra = {}) => parse({ session_id: S, hook_event_name, ...extra });
  assert.equal(ev('SessionStart').state, 'stopped');
  assert.equal(ev('UserPromptSubmit').state, 'working');
  assert.equal(ev('PreToolUse', { tool_name: 'Bash' }).state, 'working');
  assert.equal(ev('PermissionRequest', { agent_id: 'w1' }).state, 'needs');
  assert.equal(ev('PermissionRequest', { agent_id: 'w1' }).agent, 'w1');
  assert.equal(ev('Notification', { notification_type: 'permission_prompt' }).state, 'needs');
  assert.equal(ev('Notification', { notification_type: 'elicitation_dialog' }).state, 'needs');
  assert.equal(ev('Notification', { notification_type: 'idle_prompt' }), null);
  assert.equal(ev('Notification', { notification_type: 'elicitation_complete' }), null, 'a finished elicitation is not a wait');
  // Claude asking you something, or showing a plan to approve: "require user interaction".
  assert.equal(ev('PreToolUse', { tool_name: 'AskUserQuestion' }).state, 'needs');
  assert.equal(ev('PreToolUse', { tool_name: 'ExitPlanMode' }).state, 'needs');
  assert.equal(ev('PostToolUse', { tool_name: 'AskUserQuestion' }).state, 'working');
  assert.equal(ev('Elicitation').state, 'needs');
  assert.equal(ev('ElicitationResult').state, 'working');
  assert.deepEqual([ev('StopFailure', { error: 'rate_limit' }).state, ev('StopFailure', { error: 'rate_limit' }).error], ['error', 'rate_limit']);
  assert.equal(ev('Stop', { background_tasks: [] }).state, 'stopped');
  // The turn ended with a job still running: idle, never "running" (task 229).
  assert.equal(ev('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', command: 'npm run dev' }] }).state, 'background');
  assert.equal(ev('Stop', { background_tasks: [{ id: 'w1', type: 'subagent', status: 'running' }] }).state, 'background');
  assert.equal(ev('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'completed' }] }).state, 'stopped');
  assert.equal(ev('Stop').state, 'stopped', 'no list (registry unreachable) is plain idle, as before');
  assert.equal(ev('SubagentStop', { agent_id: 'w1' }).state, 'stopped');
  // A finished worker's list is the chat's: empty = nothing left running.
  assert.equal(ev('SubagentStop', { agent_id: 'w1', background_tasks: [] }).backgroundDone, true);
  assert.equal(ev('SubagentStop', { agent_id: 'w1', background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }).backgroundDone, undefined);
  assert.equal(ev('SubagentStop', { agent_id: 'w1' }).backgroundDone, undefined, 'no list says nothing');
  // The chat's process ended — the app does that by itself, so it says
  // nothing about whether the owner closed anything (task 226).
  assert.equal(ev('SessionEnd', { reason: 'other' }).state, 'ended');
  assert.equal(ev('SomethingNew'), null);
  assert.equal(parse({ hook_event_name: 'Stop' }), null); // no session id
  // The repo ships no Claude mark, only where a public copy lives.
  assert.equal(claude.liveState.logo, null);
  assert.match(claude.liveState.logoSource.url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/simple-icons@\d+\.\d+\.\d+\/icons\/claude\.svg$/);
});

test('an Agent spawn whose description starts "task NNN" names the worker\'s task', () => {
  const spawn = (description) => parse({
    session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Agent',
    tool_input: { description, prompt: '…' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'a43acbe3245e22da0' },
  }).spawn;
  assert.deepEqual(spawn('task 203: phone alerts'), { agent: 'a43acbe3245e22da0', task: '203' });
  assert.deepEqual(spawn('Task #07b — fix it'), { agent: 'a43acbe3245e22da0', task: '07b' });
  assert.equal(spawn('Run shell commands and report output'), undefined);
});

// --- one chat on one task ------------------------------------------------------

test('a chat\'s states reach its claimed task, with since/at', () => {
  const dir = freshDir();
  feed(dir, [{ session_id: S, hook_event_name: 'SessionStart' }, { session_id: S, hook_event_name: 'UserPromptSubmit' }], 1_000_000);
  const live = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.equal(live.state, 'working');
  assert.equal(live.driver, 'claude');
  assert.equal(live.since, 1_001_000);
  assert.equal(live.autopilot, false);

  feed(dir, [{ session_id: S, hook_event_name: 'PreToolUse', tool_name: 'Bash' }], 1_005_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).since, 1_001_000, 'same state keeps its start');

  feed(dir, [{ session_id: S, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }], 1_010_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'needs');
  feed(dir, [{ session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, { session_id: S, hook_event_name: 'Stop', background_tasks: [] }], 1_020_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'stopped');

  feed(dir, [{ session_id: S, hook_event_name: 'SessionEnd', reason: 'other' }], 1_030_000);
  const ended = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.equal(ended.state, 'stopped', 'a chat still in the app is idle after its process ends, never closed');
  assert.equal(ended.since, 1_021_000, 'already idle (the Stop above): it keeps when it went idle');
  // A chat never heard from (open before the hook was installed) is not
  // assumed anything: there is nothing to go on.
  assert.equal(liveForTask(claimed(5, { claimed_by_session: 'never-heard' }), { dir, user: 'Ben', chatStatus: open }).state, 'unknown');
});

// --- a turn that ends with a job still running (task 229) ----------------------

const SERVER = { id: 'b1', type: 'shell', status: 'running', command: 'npm run verify-server' };

test('a reply that ends with a dev server running reads idle with a background job, not running', () => {
  const dir = freshDir();
  // The where-is-maya 139 sequence: a background server, the reply ends, then
  // one of Claude Code's own internal agents finishes 5 s later.
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    { session_id: S, hook_event_name: 'Stop', background_tasks: [SERVER] },
  ], 2_000_000);
  feed(dir, [{ session_id: S, hook_event_name: 'SubagentStop', agent_id: 'internal1', background_tasks: [SERVER] }], 2_007_000);
  const live = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([live.state, live.since], ['background', 2_002_000], 'idle since the reply ended; the server still runs');

  // The chat wakes (the owner writes, or the job wakes it): running again.
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }], 2_100_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'working');
});

test('the last background job finishing leaves the chat plain idle, still idle since the reply ended', () => {
  const dir = freshDir();
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'h1' },
    { session_id: S, hook_event_name: 'Stop', background_tasks: [{ id: 'h1', type: 'subagent', status: 'running' }] },
  ], 3_000_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'background');
  feed(dir, [{ session_id: S, hook_event_name: 'SubagentStop', agent_id: 'h1', background_tasks: [] }], 3_060_000);
  const live = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([live.state, live.since], ['stopped', 3_002_000]);
});

test('an autopilot worker finishing last also leaves the chat plain idle; its own task reads done', () => {
  const dir = freshDir();
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'wA' },
    { session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'task 201: go' }, tool_response: { agentId: 'wA' } },
    { session_id: S, hook_event_name: 'Stop', background_tasks: [{ id: 'wA', type: 'subagent', status: 'running' }] },
    { session_id: S, hook_event_name: 'SubagentStop', agent_id: 'wA', background_tasks: [] },
  ], 4_000_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'stopped');
  assert.deepEqual([liveForTask(claimed(201), { dir, user: 'Ben', chatStatus: open }).state], ['stopped']);
});

test('the process ending turns background into idle, keeping when it went idle', () => {
  const dir = freshDir();
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'Stop', background_tasks: [SERVER] },
  ], 5_000_000);
  feed(dir, [{ session_id: S, hook_event_name: 'SessionEnd', reason: 'other' }], 5_600_000);
  const live = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([live.state, live.since], ['stopped', 5_001_000]);
});

test('waiting on you still wins over a reply ending with a job running', () => {
  const dir = freshDir();
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'w1' },
    { session_id: S, hook_event_name: 'PermissionRequest', agent_id: 'w1', tool_name: 'Bash' },
    { session_id: S, hook_event_name: 'Stop', background_tasks: [{ id: 'w1', type: 'subagent', status: 'running' }] },
  ]);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'needs');
});

// --- archived / deleted: the owner's action in the app (task 226) --------------

test('the app ending a chat mid-turn leaves it idle, and its autopilot workers too — their task links kept', () => {
  const dir = freshDir();
  const t0 = Date.now() - 3 * 3600_000;
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'wA' },
    { session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'task 201: go' }, tool_response: { agentId: 'wA' } },
    { session_id: S, hook_event_name: 'PreToolUse', agent_id: 'wA', tool_name: 'Bash' },
  ], t0);
  feed(dir, [{ session_id: S, hook_event_name: 'SessionEnd', reason: 'other' }], t0 + 60_000);
  const chat = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  const worker = liveForTask(claimed(201), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([chat.state, chat.since], ['stopped', t0 + 60_000]);
  assert.deepEqual([worker.state, worker.autopilot], ['stopped', true]);
  assert.ok(readdirSync(dir).includes(`${S}~wA.task`), 'the worker\'s task link survives');
});

test('an archived chat reads archived, a deleted one deleted — whatever it was last doing', () => {
  const dir = freshDir();
  const t0 = Date.now() - 3 * 3600_000;
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }, { session_id: S, hook_event_name: 'Stop', background_tasks: [] }], t0);
  const a = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: chats({ [S]: 'archived' }) });
  assert.deepEqual([a.state, a.since], ['archived', null]);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: chats({ [S]: 'deleted' }) }).state, 'deleted');
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: chats({ [S]: 'unknown' }) }).state, 'stopped', 'the app cannot say: show what the chat reported');
  // Archived before cogyard ever heard from it: still archived.
  assert.equal(liveForTask(claimed(5, { claimed_by_session: 'quiet' }), { dir, user: 'Ben', chatStatus: chats({ quiet: 'archived' }) }).state, 'archived');
});

test('a chat heard from in the last few minutes is never called deleted — the app may not have listed it yet', () => {
  const dir = freshDir();
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }], Date.now() - 30_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: chats({ [S]: 'deleted' }) }).state, 'working');
});

test('a "closed" record written before task 226 reads idle', () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${S}.json`), JSON.stringify({ driver: 'claude', session: S, agent: null, state: 'closed', since: 1_000, at: 1_000 }) + '\n');
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'stopped');
});

test('Claude adapter: whether each chat is open, archived or deleted, from the app\'s own chat list', () => {
  const store = join(FAKE_HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct');
  const projects = join(FAKE_HOME, '.claude', 'projects', '-repo');
  mkdirSync(store, { recursive: true });
  mkdirSync(projects, { recursive: true });
  const row = (file, d) => writeFileSync(join(store, file), JSON.stringify(d));
  const transcript = (id, entrypoint) => writeFileSync(join(projects, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, entrypoint }) + '\n');
  row('a.json', { cliSessionId: 'open-1', isArchived: false, title: 'Pick up 1' });
  row('b.json', { cliSessionId: 'arch-1', isArchived: true, title: 'Pick up 2' });
  row('c.json', { cliSessionId: 'rewound-now', priorCliSessionIds: ['rewound-was'], isArchived: false });
  transcript('gone-from-app', 'claude-desktop'); // the app's chat, no longer in its list
  transcript('terminal-chat', 'cli');            // a terminal chat: never in the app's list
  assert.deepEqual(claude.sessions.status(['open-1', 'arch-1', 'rewound-was', 'gone-from-app', 'terminal-chat', 'no-trace']), {
    'open-1': 'open', 'arch-1': 'archived', 'rewound-was': 'open',
    'gone-from-app': 'deleted', 'terminal-chat': 'open', 'no-trace': 'deleted',
  });
  assert.deepEqual(NOOP.sessions.status(['x']), { x: 'unknown' });
});

// A click on the logo (Plan, All, Tasks): the driver sends the app's own link
// for the chat, by the app's id for it, or says in plain words why it did not.
test('Claude adapter: open() sends the app link for a chat in the app, and only then', () => {
  const store = join(FAKE_HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct2');
  mkdirSync(store, { recursive: true });
  const row = (file, d) => writeFileSync(join(store, file), JSON.stringify(d));
  row('local_aaaa-1111.json', { sessionId: 'local_aaaa-1111', cliSessionId: 'cli-open', priorCliSessionIds: ['cli-before'], isArchived: false });
  row('local_bbbb-2222.json', { sessionId: 'local_bbbb-2222', cliSessionId: 'cli-archived', isArchived: true });
  row('odd.json', { sessionId: 'not an app id', cliSessionId: 'cli-odd', isArchived: false });
  const sent = [];
  const launch = (url) => sent.push(url);
  const mac = { launch, platform: 'darwin' };

  assert.deepEqual(claude.sessions.open('cli-open', mac), { ok: true });
  assert.deepEqual(claude.sessions.open('cli-before', mac), { ok: true }, 'a rewound chat is found by its earlier id');
  assert.deepEqual(sent, [
    'claude://code/continue?session=local_aaaa-1111&source=url_external',
    'claude://code/continue?session=local_aaaa-1111&source=url_external',
  ]);
  sent.length = 0;
  assert.deepEqual(claude.sessions.open('cli-archived', mac), { ok: false, reason: 'chat is archived' });
  assert.deepEqual(claude.sessions.open('terminal-chat', mac), { ok: false, reason: 'not a chat in the Claude app' });
  assert.equal(claude.sessions.open('cli-odd', mac).ok, false, 'an id the app\'s links refuse is never sent');
  assert.deepEqual(claude.sessions.open('cli-open', { launch, platform: 'linux' }), { ok: false, reason: 'needs the Claude app on a Mac' });
  assert.deepEqual(sent, [], 'nothing sent for any refusal');
  const broken = claude.sessions.open('cli-open', { platform: 'darwin', launch: () => { throw new Error('boom'); } });
  assert.deepEqual(broken, { ok: false, reason: 'could not reach the Claude app: boom' }, 'a failed launch is a reason, not a throw');
  assert.equal(NOOP.sessions.open, undefined, 'no driver: nothing to open');
});

test('a claimed task carries its chat and whether the logo can open it', () => {
  const dir = freshDir();
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }]);
  const live = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([live.session, live.canOpen], [S, true]);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: chats({ [S]: 'archived' }) }).canOpen, false, 'an archived chat: nothing to show');
  const quiet = freshDir(); // last heard from an hour ago, so "deleted" is believed
  feed(quiet, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }, { session_id: S, hook_event_name: 'Stop', background_tasks: [] }], Date.now() - 3600_000);
  const gone = liveForTask(claimed(5), { dir: quiet, user: 'Ben', chatStatus: chats({ [S]: 'deleted' }) });
  assert.deepEqual([gone.state, gone.canOpen], ['deleted', false], 'a deleted chat: nothing to show');
  const noChat = liveForTask(claimed(5, { claimed_by_session: null }), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([noChat.session, noChat.canOpen], [null, false], 'a claim with no chat recorded');
});

test('an API error ends the turn as error, with its type, until the next prompt; a chat silent for months keeps its state', () => {
  const dir = freshDir();
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }, { session_id: S, hook_event_name: 'StopFailure', error: 'overloaded' }], 0);
  const e = liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open });
  assert.deepEqual([e.state, e.error], ['error', 'overloaded']);
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }]);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'working');
  const old = freshDir();
  feed(old, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }], 0); // 1970: nothing has happened since
  assert.equal(liveForTask(claimed(5), { dir: old, user: 'Ben', chatStatus: open }).state, 'working', 'no guessing from silence');
});

test('who sees what: unclaimed → null; someone else\'s claim → null; a claim with no claimed_by counts as mine', () => {
  const dir = freshDir();
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }]);
  assert.equal(liveForTask({ id: 5, env: {} }, { dir, user: 'Ben', chatStatus: open }), null);
  assert.equal(liveForTask(claimed(5, { claimed_by: 'Sam Rivera' }), { dir, user: 'Ben', chatStatus: open }), null);
  assert.equal(liveForTask(claimed(5, { claimed_by: null }), { dir, user: 'Ben', chatStatus: open }).state, 'working');
});

test('a prompt raised by a helper agent is not cleared by other activity, only by that helper', () => {
  const dir = freshDir();
  // The observed sequence: a subagent asks, ~6 s later the agent-less
  // notification echoes it, 50 s later an unrelated helper runs a tool.
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'w1' },
    { session_id: S, hook_event_name: 'PermissionRequest', agent_id: 'w1', tool_name: 'Bash' },
    { session_id: S, hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { session_id: S, hook_event_name: 'PreToolUse', agent_id: 'h9', tool_name: 'Bash' },
    { session_id: S, hook_event_name: 'Stop', background_tasks: [{ id: 'w1', status: 'running' }] },
  ]);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'needs');
  feed(dir, [{ session_id: S, hook_event_name: 'PostToolUse', agent_id: 'w1', tool_name: 'Bash' }], Date.now() - 10_000);
  assert.equal(liveForTask(claimed(5), { dir, user: 'Ben', chatStatus: open }).state, 'working');
});

// --- autopilot: one chat, a worker per task ------------------------------------

test('autopilot: each worker\'s state lands on its own task; its prompt does not stall the others', () => {
  const dir = freshDir();
  const spawn = (agentId, task) => ({ session_id: S, hook_event_name: 'PostToolUse', tool_name: 'Agent',
    tool_input: { description: `task ${task}: do it` }, tool_response: { agentId, status: 'async_launched' } });
  feed(dir, [
    { session_id: S, hook_event_name: 'UserPromptSubmit' },
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'wA' },
    spawn('wA', 201),
    { session_id: S, hook_event_name: 'SubagentStart', agent_id: 'wB' },
    spawn('wB', '0203'),
    { session_id: S, hook_event_name: 'PreToolUse', agent_id: 'wA', tool_name: 'Bash' },
    { session_id: S, hook_event_name: 'PermissionRequest', agent_id: 'wB', tool_name: 'Bash' },
    { session_id: S, hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { session_id: S, hook_event_name: 'SubagentStop', agent_id: 'wA' },
  ]);
  const a = liveForTask(claimed(201), { dir, user: 'Ben', chatStatus: open });
  const b = liveForTask(claimed(203), { dir, user: 'Ben', chatStatus: open });
  const c = liveForTask(claimed(204), { dir, user: 'Ben', chatStatus: open }); // claimed by the run, no worker yet
  assert.deepEqual([a.state, a.autopilot], ['stopped', true]);
  assert.deepEqual([b.state, b.autopilot], ['needs', true]);
  assert.equal(c.state, 'working', 'the worker prompt\'s echo is not pinned on the chat');
  assert.equal(c.autopilot, false);
});

// --- dropping the records of chats that are gone -------------------------------

test('a chat\'s records go when its transcript is deleted — never for being old', () => {
  const dir = freshDir();
  const old = Date.now() - 90 * 24 * 3600 * 1000; // three months untouched
  for (const s of ['kept-old', 'deleted', 'terminal']) recordEvent({ session: s, agent: null, state: 'stopped' }, 'claude', { dir, now: old });
  recordEvent({ session: 'deleted', agent: 'w1', state: 'stopped' }, 'claude', { dir, now: old });
  recordEvent({ session: 'newborn', agent: null, state: 'stopped' }, 'claude', { dir, now: Date.now() });
  const gone = pruneGone({
    dir,
    transcriptsOf: (s) => (s === 'deleted' || s === 'newborn' ? [] : [`/t/${s}.jsonl`]),
    transcriptsKnown: true,
  });
  assert.deepEqual(gone, ['deleted']);
  assert.deepEqual(readdirSync(dir).sort(), ['kept-old.json', 'newborn.json', 'terminal.json']);
});

// --- the portal's change check -----------------------------------------------

test('the change code moves on a new state, not on another event in the same state', () => {
  const dir = freshDir();
  const t0 = Date.now() - 60_000;
  feed(dir, [{ session_id: S, hook_event_name: 'UserPromptSubmit' }], t0);
  const a = liveSignature({ dir });
  feed(dir, [{ session_id: S, hook_event_name: 'PreToolUse', tool_name: 'Bash' }], t0 + 5000);
  assert.equal(liveSignature({ dir }), a, 'a tool call while working changes nothing shown');
  feed(dir, [{ session_id: S, hook_event_name: 'Stop', background_tasks: [] }], t0 + 9000);
  assert.notEqual(liveSignature({ dir }), a);
  const b = liveSignature({ dir });
  feed(dir, [{ session_id: S, hook_event_name: 'StopFailure', error: 'server_error' }]);
  assert.notEqual(liveSignature({ dir }), b, 'an error moves it');
  const c = liveSignature({ dir, chatStatuses: [[S, 'open']] });
  assert.notEqual(liveSignature({ dir, chatStatuses: [[S, 'archived']] }), c, 'archiving the chat moves it (task 226)');
});

// --- the hook entrypoint -------------------------------------------------------

test('the hook exits 0 and stays quiet on bad input and an unwritable live folder', () => {
  const hook = fileURLToPath(new URL('../hooks/live-state.mjs', import.meta.url));
  const run = (input, home) => spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env: { ...process.env, COGYARD_HOME: home } });
  for (const r of [
    run('not json', join(ROOT, 'h1')),
    run(JSON.stringify({ session_id: S, hook_event_name: 'UserPromptSubmit' }), '/dev/null/nope'),
  ]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  const ok = run(JSON.stringify({ session_id: S, hook_event_name: 'UserPromptSubmit' }), join(ROOT, 'h2'));
  assert.equal(ok.status, 0);
  assert.deepEqual(readdirSync(join(ROOT, 'h2', 'live')), [`${S}.json`]);
});
