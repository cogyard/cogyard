// core/live-state.mjs — what the agent working each claimed task is doing right
// now (task 202): running, waiting on you, idle, error — or that the owner
// archived or deleted its chat (task 226).
//
// DOCUMENTED SIGNALS ONLY (owner, 2026-10-13): every working state comes from a
// hook event the agent documents. Nothing here guesses — no "silent for N
// minutes means dead". A chat that is killed without its exit event keeps its
// last state, with its age showing.
//
// ARCHIVED / DELETED (owner, 2026-10-16) are the one exception, because they
// are the owner's own action in the agent app and the app's chat list is the
// only place that records it: the driver reads it (adapter.sessions.status).
// There is no "closed": the agent's exit event (Claude's SessionEnd) means the
// chat's PROCESS ended — the app does that by itself to idle chats — so the
// chat reads idle. A chat still in the app is never shown as gone.
//
// WRITER: the `live-state` engine hook (hooks/live-state.mjs). The agent's own
// hooks fire it on every event; the ACTIVE driver's adapter turns the raw hook
// input into a neutral event (adapter.liveState.parseHook — docs/DRIVERS.md),
// and recordEvent() below files it. Nothing here knows any agent's hook format.
//
// READER: liveForTask(), which /api/plan and /api/tasks call per claimed task.
//
// Layout — $COGYARD_HOME/live/, machine-level, never inside a task store:
//   <session>.json           the chat as a whole
//   <session>~<agent>.json   one worker (subagent) inside that chat
//   <session>~<agent>.task   that worker's task id, learned when the chat
//                            spawned it (autopilot names each worker "task NNN")
// A record: { driver, session, agent, state, since, at, ask?, needsBy?, error? }
//   state: working (running) | needs (waiting on you) | stopped (idle) | error
//          | background (idle, with a job it started still running — task 229)
//   error = the error type the agent reported (StopFailure's `error`).
//   since = when this state began; at = the last event. `ask` (chat file only)
//   = the last permission prompt a worker raised, so the agent-less prompt
//   notification that follows it is not pinned on the whole chat.
//
// One file per writer, written tmp+rename, so concurrent hooks from parallel
// workers never read-modify-write each other's file. When the chat's process
// ends, its records (the chat's and its workers') turn idle and stay; no
// record at all reads "no live signal". A record from before task 226 may say
// "closed": it reads as idle.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { adapter } from './drivers.mjs';

const LIVE_DIR = join(COGYARD_HOME, 'live');

// A prompt notification without an agent id this soon after a worker's own
// permission request is that same prompt: the docs say permission_prompt
// fires once the prompt "has waited about six seconds".
const ASK_ECHO_MS = 20 * 1000;

// A neutral event's state. 'ended' = the chat's process ended; it is filed as
// 'stopped' and never stored itself. 'background' = the turn ended but a job
// the chat started is still running (a dev server, a worker): idle, not
// working (task 229).
const STATES = new Set(['working', 'needs', 'stopped', 'background', 'error', 'ended']);
// The two idle states. Moving between them keeps when the chat went idle:
// the job finishing, or the process ending, does not make it idle any later.
const IDLE = new Set(['stopped', 'background']);
// A chat heard from this recently may not be in the app's list or have a
// transcript yet — a grace for being born, never an expiry.
const NEWBORN_MS = 10 * 60 * 1000;
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const normId = (id) => String(id ?? '').trim().replace(/^0+(?=\d)/, '').toLowerCase();

const recPath = (dir, session, agent) => join(dir, agent ? `${session}~${agent}.json` : `${session}.json`);
const mapPath = (dir, session, agent) => join(dir, `${session}~${agent}.task`);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// File one neutral event from the adapter:
//   { session, agent|null, state, spawn?: { agent, task }, error?, backgroundDone? }
// backgroundDone (on a worker's 'stopped'): the driver knows the chat has
// nothing left running in the background.
// Returns what it did, for tests; throws only on a filesystem error, which the
// hook swallows.
function recordEvent(ev, driver, { dir = LIVE_DIR, now = Date.now() } = {}) {
  if (!ev || !SAFE.test(String(ev.session)) || !STATES.has(ev.state)) return { skipped: 'invalid' };
  const session = ev.session;
  const agent = ev.agent && SAFE.test(String(ev.agent)) ? ev.agent : null;
  mkdirSync(dir, { recursive: true });

  // The chat's process ended: nothing in it runs any more — the chat and every
  // worker in it are idle. The records stay (with the workers' task links), so
  // each task still shows its chat, idle, until the owner archives or deletes
  // it in the app (task 226). An already-idle record keeps when it went idle;
  // its background jobs ended with the process.
  if (ev.state === 'ended') {
    if (agent) return { skipped: 'a worker does not end the chat' };
    const idle = (path, a) => {
      const prev = readJson(path);
      const since = IDLE.has(prev?.state) && prev.since ? prev.since : now;
      writeAtomic(path, JSON.stringify({ driver: prev?.driver || driver, session, agent: a, state: 'stopped', since, at: now }) + '\n');
    };
    idle(recPath(dir, session, null), null);
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${session}~`) && f.endsWith('.json')) idle(join(dir, f), f.slice(session.length + 1, -5));
    }
    return { ended: session };
  }

  // The chat just started a worker for a task: remember which (write-once).
  if (ev.spawn && SAFE.test(String(ev.spawn.agent)) && /^[0-9][0-9a-z.]*$/i.test(String(ev.spawn.task))) {
    const mp = mapPath(dir, session, ev.spawn.agent);
    if (!existsSync(mp)) writeAtomic(mp, normId(ev.spawn.task) + '\n');
  }

  // `needsBy` = who raised a "needs you" (an agent id, or null for the chat's
  // main agent). Only that same asker's next event clears it: while a worker
  // waits on a prompt, the main agent or a helper carrying on does not mean
  // the prompt was answered (observed: a helper's tool call 50 s into an
  // unanswered prompt).
  const write = (a, state, extra = {}) => {
    const path = recPath(dir, session, a);
    const prev = readJson(path) || {};
    const rec = {
      driver, session, agent: a, state,
      since: (prev.state === state || (IDLE.has(prev.state) && IDLE.has(state))) && prev.since ? prev.since : now,
      at: now,
      ...(prev.ask ? { ask: prev.ask } : {}),
      ...(state === 'needs' ? { needsBy: prev.state === 'needs' ? (prev.needsBy ?? null) : agent } : {}),
      ...(state === 'error' ? { error: String(ev.error || 'unknown') } : {}),
      ...extra,
    };
    writeAtomic(path, JSON.stringify(rec) + '\n');
    return rec;
  };

  const mapped = agent ? existsSync(mapPath(dir, session, agent)) : false;
  const chat = readJson(recPath(dir, session, null));
  if (agent) write(agent, ev.state);
  // A worker or helper finished and the driver says nothing is left running
  // in the chat's background: a chat idling on background work is plain idle.
  const lastJobDone = agent && ev.state === 'stopped' && ev.backgroundDone === true && chat?.state === 'background';

  // A task's worker reports on its own task only. The chat keeps a note of a
  // prompt it raised so the agent-less notification that echoes it ~6 s later
  // is not pinned on the chat as a whole.
  if (mapped) {
    if (ev.state === 'needs' && chat) write(null, chat.state, { ask: { agent, at: now } });
    if (lastJobDone) write(null, 'stopped');
    return { worker: agent, mapped };
  }
  if (!agent && ev.state === 'needs') {
    if (chat?.state === 'needs') return { skipped: 'already needs you' };
    if (chat?.ask && now - chat.ask.at < ASK_ECHO_MS && existsSync(mapPath(dir, session, chat.ask.agent))) {
      return { skipped: 'echo of a worker prompt' };
    }
  }
  // Any other agent (a helper the chat runs, a subagent no task owns) is the
  // chat's own activity — except a helper finishing, which says nothing
  // unless it was the one the chat was waiting on.
  if (agent && ev.state === 'stopped') {
    if (chat?.state === 'needs' && chat.needsBy === agent) write(null, 'working');
    else if (lastJobDone) write(null, 'stopped');
    return { worker: agent, mapped };
  }
  if (chat?.state === 'needs' && ev.state !== 'needs' && ev.state !== 'error' && (chat.needsBy ?? null) !== agent) {
    return { skipped: 'needs you, raised by another agent' };
  }
  write(null, ev.state);
  return { chat: session, agent, mapped };
}

// Drop the records of chats that are GONE — never by age: the owner leaves
// chats for weeks and comes back to them, and a chat left alone must still
// read "idle 4w". Gone means its transcript no longer exists (the chat was
// deleted) — transcripts live where the agent documents them
// (adapter.transcripts). An ended chat keeps its idle record until then.
// Anything else is kept: nothing documented says it is over. A killed chat
// leaves its last state, shown only while a claim still names that chat.
// The check comes from the driver; it is passed in so tests need no agent.
function pruneGone({
  dir = LIVE_DIR,
  transcriptsOf = (s) => adapter.transcripts?.findBySession?.(s) || [],
  transcriptsKnown = !!adapter.transcripts?.supported,
} = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const sessions = new Set(names.filter((f) => f.endsWith('.json') || f.endsWith('.task')).map((f) => f.replace(/\.(json|task)$/, '').split('~')[0]));
  if (!sessions.size) return [];
  // A chat seconds old may not have written its transcript yet, so the
  // "deleted" test skips a chat heard from in the last 10 minutes. That is
  // a grace for being born, not an expiry: an old chat is never dropped for
  // being old.
  const recent = (s) => { const r = readJson(join(dir, `${s}.json`)); return !!(r && Date.now() - r.at < NEWBORN_MS); };
  const gone = [];
  for (const s of sessions) {
    let deleted = false;
    if (transcriptsKnown && !recent(s)) { try { deleted = transcriptsOf(s).length === 0; } catch {} }
    if (deleted) gone.push(s);
  }
  for (const s of gone) {
    for (const f of names) if (f === `${s}.json` || f.startsWith(`${s}~`)) { try { unlinkSync(join(dir, f)); } catch {} }
  }
  return gone;
}

// At most once a minute: the check looks for each chat's transcript.
let lastPrune = { at: 0, dir: null };
function pruneSometimes(dir) {
  if (lastPrune.dir === dir && Date.now() - lastPrune.at < 60 * 1000) return;
  lastPrune = { at: Date.now(), dir };
  try { pruneGone({ dir }); } catch {}
}

// One read of the folder per poll, re-done only when the folder changes (every
// write is a rename into it, which bumps its mtime).
let snap = { mtimeMs: null, dir: null, records: new Map(), workers: new Map() };
function snapshot(dir = LIVE_DIR) {
  if (dir === LIVE_DIR) pruneSometimes(dir);
  let mtimeMs = null;
  try { mtimeMs = statSync(dir).mtimeMs; } catch { return { records: new Map(), workers: new Map() }; }
  if (snap.dir === dir && snap.mtimeMs === mtimeMs) return snap;
  const records = new Map();
  const workers = new Map(); // session → Map(taskId → agent)
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.json')) {
      const rec = readJson(join(dir, f));
      // Written before task 226, when the process ending was called "closed".
      if (rec?.state === 'closed') rec.state = 'stopped';
      if (rec && rec.session) records.set(f.slice(0, -5), rec);
    } else if (f.endsWith('.task')) {
      const [session, agent] = f.slice(0, -5).split('~');
      let task = null;
      try { task = readFileSync(join(dir, f), 'utf8').trim(); } catch {}
      if (session && agent && task) {
        if (!workers.has(session)) workers.set(session, new Map());
        workers.get(session).set(task, agent);
      }
    }
  }
  snap = { mtimeMs, dir, records, workers };
  return snap;
}

// Whether the owner archived or deleted each claimed task's chat in the agent
// app (task 226): 'open' | 'archived' | 'deleted' | 'unknown', from the
// driver. Asked at most once a minute, all known chats in one call — the
// portal asks on every poll, and the driver reads the app's whole chat list.
// Holds only the chats a claimed task has asked about.
let chatCache = { at: 0, map: new Map() };
function chatStatus(session) {
  if (!session) return 'unknown';
  if (typeof adapter.sessions?.status !== 'function' || !adapter.sessions.supported) return 'unknown';
  if (Date.now() - chatCache.at > 60 * 1000 || !chatCache.map.has(session)) {
    const ids = [...new Set([session, ...chatCache.map.keys()])];
    let got = {};
    try { got = adapter.sessions.status(ids) || {}; } catch { /* the app's list is unreadable: unknown */ }
    chatCache = { at: Date.now(), map: new Map(ids.map((id) => [id, got[id] || 'unknown'])) };
  }
  return chatCache.map.get(session) || 'unknown';
}
// The known chats' statuses, refreshed by the same once-a-minute rule.
function knownChatStatuses() {
  const ids = [...chatCache.map.keys()].sort();
  return ids.map((id) => [id, chatStatus(id)]);
}

// What the portal's change check (core/versions.mjs, task 173) needs to know:
// a code that moves when any shown state would — a state change, a worker
// mapped to a task, a chat archived or deleted in the app — and NOT on
// every event. Every tool call rewrites a record's `at`; folding that in would
// refetch the task list on every check while any chat is busy. Times on screen
// ("working 4m") are counted by the browser from `since`, so they need no
// refetch.
function liveSignature({ dir = LIVE_DIR, chatStatuses = null } = {}) {
  const s = snapshot(dir);
  const parts = [];
  for (const [name, r] of [...s.records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    parts.push(`${name}:${r.state}:${r.since}`);
  }
  for (const [session, m] of [...s.workers].sort()) {
    for (const [task, agent] of [...m].sort()) parts.push(`${session}~${agent}=${task}`);
  }
  for (const [session, st] of chatStatuses ?? knownChatStatuses()) parts.push(`chat:${session}=${st}`);
  return parts.join('|');
}

// This machine's identity, resolved at most once a minute: the portal asks on
// every poll, and the resolver (core/close.mjs whoAmI) runs git. Passed in so
// the hook, which imports this module on every tool call, never loads it.
let me = { at: 0, name: null };
function cachedUser(resolve) {
  if (Date.now() - me.at > 60 * 1000) me = { at: Date.now(), name: resolve() };
  return me.name;
}

// Claimed, and by a named person who is not this machine's user.
function claimedByOther(fm, user) {
  const env = fm?.env && typeof fm.env === 'object' ? fm.env : {};
  return !!(env.claimed_at && env.claimed_by && user && env.claimed_by !== user);
}

// The live state for one task, from its frontmatter, or null when there is
// nothing to show: not claimed, no driver active, or claimed by someone else
// (their agent runs on their machine — the caller shows their name instead).
// `user` is this machine's identity — the caller passes core/close.mjs
// whoAmI(), the same resolution `env claim` records in env.claimed_by.
// `unknown` = nothing to go on: the driver cannot report (no liveState seam),
// or this chat has sent no event since the hook was installed.
// `archived` / `deleted` = the owner archived or deleted the chat in the app
// (task 226) — whatever it last reported; when it happened is not known, so
// `since` is null. A chat heard from in the last few minutes is never called
// deleted: the app may not have listed it yet. `chatStatus` is passed in tests.
//   → { driver, state: working|needs|stopped|error|archived|deleted|unknown, error?, since, at, autopilot }
function liveForTask(fm, { user = null, dir = LIVE_DIR, chatStatus: statusOf = chatStatus } = {}) {
  const env = fm?.env && typeof fm.env === 'object' ? fm.env : {};
  if (!env.claimed_at || adapter.name === 'none' || claimedByOther(fm, user)) return null;
  if (!adapter.liveState?.supported) return { driver: adapter.name, state: 'unknown', since: null, at: null, autopilot: false };

  const s = snapshot(dir);
  const claimed = env.claimed_by_session ? String(env.claimed_by_session) : null;
  const session = claimed;
  const agent = session ? s.workers.get(session)?.get(normId(fm.id)) : null;
  const rec = session ? s.records.get(agent ? `${session}~${agent}` : session) : null;
  const gone = session ? statusOf(session) : 'unknown';
  const chat = session ? s.records.get(session) : null;
  if (gone === 'archived' || (gone === 'deleted' && !(chat && Date.now() - chat.at < NEWBORN_MS))) {
    return { driver: rec?.driver || adapter.name, state: gone, since: null, at: rec?.at ?? null, autopilot: !!agent };
  }
  if (!rec) return { driver: adapter.name, state: 'unknown', since: null, at: null, autopilot: !!agent };
  return { driver: rec.driver || adapter.name, state: rec.state, ...(rec.state === 'error' ? { error: rec.error || 'unknown' } : {}),
    since: rec.since ?? null, at: rec.at ?? null, autopilot: !!agent };
}

export { LIVE_DIR, recordEvent, snapshot, pruneGone, liveForTask, liveSignature, claimedByOther, cachedUser };
