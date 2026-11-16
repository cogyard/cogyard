#!/usr/bin/env node
// cli/sessions.mjs — `cogyard sessions`: READ-ONLY reports over chats and
// worktrees. Every disposal action moved to cli/cleanup.mjs (task 117); this
// file now writes nothing at all, which makes trust rule 1 structural rather
// than a promise.
//
// The disposal commands this file used to carry — `audit --cleanup`,
// `audit --cleanup --all`, and `retire` — are now `cogyard cleanup worktrees`
// and `cogyard cleanup chat`, and task 106's trust model travels with them (see
// the header of cli/cleanup.mjs). What remains here is reports only:
//   audit       archived chats × their worktrees, with the safety verdict
//   audit --all every worktree of this repo with its verdict
//   archivable  every non-archived chat, bucketed by whether archiving is safe
//   chats <id>  the chats that created / implemented / mentioned a task
//   find        the chat finder + gate verdicts, as JSON for agents
//   show <id>   one chat printed as readable turns (task 215)
//   search "…"  chat text search, one row per chat (task 215)
//
// Rule 1 ("the default invocation is a pure read-only report") is now
// structural: this file imports nothing that can write.

import { sessionsAudit, findChats, resolveChat, allWorktreeCandidates, archiveBucketOf } from '../core/sessions-audit.mjs';
import { chatsForTask } from '../core/task-chats.mjs';
import { readChat, searchChats } from '../core/chat-read.mjs';
import { HOME } from '../core/paths.mjs';
import { adapter } from '../core/drivers.mjs';
import { currentScope, inScope, scopeNote } from './scope.mjs';

function help() {
  process.stdout.write(`cogyard sessions — READ-ONLY reports over chats × worktrees

Usage:
  cogyard sessions archivable        every NON-archived chat, bucketed by
                                     whether archiving is safe — the
                                     UI-archiving shopping list
  cogyard sessions chats <taskId>    the chats that CREATED, IMPLEMENTED, and
                                     MENTIONED a task — durable across archiving
                                     and worktree removal. Each carries the
                                     \`cogyard sessions show <id>\` that prints it.
                                     --everywhere crosses projects; --json feeds
                                     /task-chats
  cogyard sessions show <id> [--archive] [--json]
                                     one chat printed as readable turns — your
                                     prompts and the agent's replies, no tool
                                     output. <id> may be the start of the chat
                                     id (8 characters is plenty). A chat kept
                                     in two folders (it moved into a worktree)
                                     is read from the fuller copy
  cogyard sessions search "<text>" [--days N] [--project <slug>] [--limit N]
                                     [--archive] [--json]
                                     case-insensitive search over chat text and
                                     titles, newest chat first (default limit
                                     25), every project unless --project. Each
                                     row ends with the \`sessions show\` that
                                     opens it. JSON mode feeds the /lookup-chat
                                     slash command.
                                     --archive (show, search): read the
                                     chat-archive add-on's copy instead of the
                                     agent's folder, so a chat the agent has
                                     deleted can still be read
  cogyard sessions audit             report over ARCHIVED chats and the
                                     worktrees they left behind
  cogyard sessions audit --json      the same report as JSON
  cogyard sessions audit --all       EVERY worktree of the current repo with its
                                     safety verdict (chat state ignored)
  cogyard sessions find [--json] "<query>"
                                     the chat finder + gate verdicts. JSON mode
                                     feeds the /cleanup-chat slash command.

Every command here is read-only. To ACT on any of it:
  cogyard cleanup                    what is hanging around, and what to do
  cogyard cleanup worktrees          gated, verified worktree removal
  cogyard cleanup chat "<query>"     archive a chat + remove its worktree
`);
}

// Every keyword a report can print, decoded — so the report reads without
// opening the code. Printed at the top of archivable / audit / --all output.
function legend() {
  return `KEY
  wt:<name>     the chat's leftover worktree (a checked-out copy of the repo) on disk
  REMOVABLE     worktree is clean + merged + unlocked — cleanup can delete it safely
  LOCKED        worktree carries a lock left by a DEAD session — harmless, but run the
                printed 'git worktree unlock' before cleanup will touch it
  LIVE          a RUNNING session owns the worktree — hands off entirely
  DIRTY         worktree has uncommitted changes — deleting it would destroy them
  PUSHED        worktree is clean + unlocked, NOT merged, but origin/<branch> is at the
                same commit — cleanup can remove it (after checking origin); the
                branch is kept locally and on origin. Work still not landed.
  UNMERGED      branch has commits not on the default branch, and origin does not hold
                this exact commit — work not landed and not backed up
  NO_WORKTREE   chat has no worktree on disk — archiving the chat is the whole job
  NO_REPO       the folder the chat worked in no longer exists — nothing to clean
  UNKNOWN       state unreadable — treated as unsafe, never offered for cleanup
  TRANSCRIPT MISSING   the chat's transcript file was deleted (e.g. the old cull);
                the chat metadata survives but its content is unrecoverable

`;
}

function fmtBytes(n) {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + 'M';
  if (n >= 1024) return Math.round(n / 1024) + 'K';
  return n + 'B';
}

function printReport(audit) {
  if (!audit.supported) {
    process.stdout.write(`no agent driver with session metadata is active (driver: ${audit.driver}) — nothing to audit\n`);
    return;
  }
  if (!audit.rows.length) { process.stdout.write('no archived chats found\n'); return; }
  process.stdout.write(legend());
  process.stdout.write(`${audit.rows.length} archived chat(s) [driver: ${audit.driver}]\n\n`);
  for (const r of audit.rows) {
    const when = r.lastActivityAt ? r.lastActivityAt.slice(0, 10) : '?';
    const task = r.taskId != null ? `task ${r.taskId}` : 'no task';
    const tr = r.transcript ? (r.transcript.count ? `transcript ${fmtBytes(r.transcript.bytes)}` : 'TRANSCRIPT MISSING') : '';
    process.stdout.write(`${r.verdict.padEnd(11)} ${when}  "${r.title}"  [${r.project || '?'} · ${task} · ${tr}]\n`);
    if (r.worktree) process.stdout.write(`            worktree ${r.worktree.name} @ ${r.worktree.head || '?'} (${r.worktree.branch || 'detached'})\n`);
    if (r.detail) process.stdout.write(`            ${r.detail}\n`);
    if (r.removeCmd) {
      process.stdout.write(`            remove: ${r.removeCmd}\n`);
      process.stdout.write(`            undo:   ${r.undoCmd}\n`);
    }
  }
  const n = audit.rows.filter((r) => r.verdict === 'REMOVABLE').length;
  process.stdout.write(`\n${n} REMOVABLE — run the printed commands yourself, or \`cogyard cleanup worktrees\` for gated interactive removal.\n`);
}

// `chats <taskId>` output. Three buckets, each chat: short id · (role) · date ·
// title · label · archived marker · the `cogyard sessions show` that prints it.
function printChats(res) {
  const line = (c) => {
    const id = c.sessionId ? c.sessionId.slice(0, 8) : '????????';
    const when = c.lastActiveAt ? c.lastActiveAt.slice(0, 10) : (c.startedAt ? c.startedAt.slice(0, 10) : '?');
    const arch = c.archived ? ' [archived]' : '';
    const inf = c.inferred ? ' (inferred)' : '';
    // Agent-app title first, then the quoted first-prompt snippet (task 165).
    const snippet = c.label ? `"${c.label}"` : (c.transcriptPath ? (c.title ? '' : '(no label)') : 'TRANSCRIPT MISSING');
    const label = [c.title, snippet].filter(Boolean).join('  ');
    const show = c.sessionId ? `\n              cogyard sessions show ${id}` : '';
    return `  ${id}  ${when}${arch}${inf}  ${label}${show}`;
  };
  const section = (title, list) => {
    process.stdout.write(`\n== ${title} (${list.length}) ==\n`);
    if (!list.length) { process.stdout.write('  (none)\n'); return; }
    for (const c of list) process.stdout.write(line(c) + '\n');
  };
  process.stdout.write(`task ${res.taskId} chats${res.project ? ` [${res.project}]` : ' [all projects]'}\n`);
  process.stdout.write('  read one with: cogyard sessions show <id>   (or hand its transcript path to the agent)\n');
  section('CREATED', res.created ? [res.created] : []);
  section('IMPLEMENTED — claimed or committed, strongest first', res.implemented);
  section('MENTIONED — referenced without claiming/committing', res.mentioned);
  process.stdout.write('\narchiving never loses a chat — the transcript stays on disk; this lookup finds it by task id.\n');
}

// `--flag value` pairs and bare words. Unknown flags error, like every other
// subcommand here. → { words, flags } | exits 2
function parseArgs(sub, rest, { bool = [], valued = [] }) {
  const words = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { words.push(a); continue; }
    if (bool.includes(a)) { flags[a] = true; continue; }
    if (valued.includes(a)) {
      const v = rest[i + 1];
      if (v == null || v.startsWith('--')) { process.stderr.write(`cogyard sessions ${sub}: ${a} needs a value\n`); process.exit(2); }
      flags[a] = v; i++; continue;
    }
    process.stderr.write(`cogyard sessions ${sub}: unknown flag ${a}\n`); process.exit(2);
  }
  return { words, flags };
}

function positiveInt(sub, flag, v) {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) { process.stderr.write(`cogyard sessions ${sub}: ${flag} takes a whole number above 0, got "${v}"\n`); process.exit(2); }
  return n;
}

const tilde = (p) => (p && p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const shortId = (sid) => sid.slice(0, 8);
// Local wall-clock "YYYY-MM-DD HH:MM" — the owner reads these, not a machine.
function localTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Write, then exit once stdout has drained — a long chat piped to `less` or a
// file must not be cut off by an early exit.
function finish(text, code = 0) { process.stdout.write(text, () => process.exit(code)); }

function showCmd(rest) {
  const { words, flags } = parseArgs('show', rest, { bool: ['--archive', '--json'] });
  if (words.length !== 1) { process.stderr.write('cogyard sessions show: give one chat id (or its start), e.g. cogyard sessions show 2346cc97\n'); process.exit(2); }
  const archive = !!flags['--archive'];
  const r = readChat(words[0], { archive });
  if (flags['--json']) return finish(JSON.stringify(r, null, 2) + '\n', r.ok ? 0 : 1);
  if (!r.ok) {
    process.stderr.write(`cogyard sessions show: ${r.error}\n`);
    const amb = r.ambiguous || [];
    for (const a of amb.slice(0, 10)) process.stderr.write(`  ${a.sessionId}  ${tilde(a.files[0])}\n`);
    if (amb.length > 10) process.stderr.write(`  …and ${amb.length - 10} more\n`);
    process.exit(1);
  }
  const out = [];
  out.push(`chat ${r.sessionId}${r.title ? `  "${r.title}"` : ''}  [${r.source}]`);
  out.push(`file ${tilde(r.file)}`);
  if (r.files.length > 1) out.push(`     (${r.files.length} copies of this chat, one per folder it worked in — this is the fuller one)`);
  if (!r.turns.length) out.push('\n(no readable turns in this transcript)');
  for (const t of r.turns) {
    out.push(`\n--- ${t.role === 'user' ? 'you' : 'agent'}  ${localTime(t.timestamp)} ---`);
    out.push(t.text);
  }
  finish(out.join('\n') + '\n');
}

function searchCmd(rest) {
  const { words, flags } = parseArgs('search', rest, { bool: ['--archive', '--json'], valued: ['--days', '--project', '--limit'] });
  const query = words.join(' ').trim();
  if (!query) { process.stderr.write('cogyard sessions search: give some text, e.g. cogyard sessions search "port allocation"\n'); process.exit(2); }
  const archive = !!flags['--archive'];
  const r = searchChats(query, {
    archive,
    days: positiveInt('search', '--days', flags['--days']),
    limit: positiveInt('search', '--limit', flags['--limit']),
    project: flags['--project'],
  });
  if (flags['--json']) return finish(JSON.stringify(r, null, 2) + '\n', r.ok ? 0 : 1);
  if (!r.ok) { process.stderr.write(`cogyard sessions search: ${r.error}\n`); process.exit(1); }
  const out = [];
  for (const row of r.rows) {
    out.push(`${localTime(row.lastActiveAt)}  ${shortId(row.sessionId)}  ${row.project || '?'}  ${tilde(row.cwd) || ''}`);
    if (row.title) out.push(`    title: ${row.title}`);
    out.push(`    first: ${row.firstPrompt || '(no typed prompt)'}`);
    out.push(`    match: ${row.snippet}${row.hits > 1 ? `   (${row.hits} matching turns)` : ''}`);
    out.push(`    cogyard sessions show ${shortId(row.sessionId)}${archive ? ' --archive' : ''}`);
  }
  out.push(r.rows.length
    ? `\n${r.rows.length} chat(s) match "${r.query}" [${r.source}]`
    : `no chat matches "${r.query}" [${r.source}]${archive ? '' : ' — a chat the agent has deleted may still be in the archive: add --archive'}`);
  finish(out.join('\n') + '\n');
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { help(); process.exit(cmd ? 0 : 1); }
  // `archivable` — CHAT-keyed, read-only: every non-archived chat bucketed by
  // whether archiving it is safe (work landed) or premature (work in flight).
  // The UI-archiving shopping list; `audit --all` and `cogyard cleanup
  // worktrees` are the WORKTREE lens on the same ladder.
  if (cmd === 'archivable') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--json' && f !== '--everywhere');
    if (unknown.length) { process.stderr.write(`cogyard sessions archivable: unknown flag(s): ${unknown.join(' ')}\n`); process.exit(2); }
    const scope = currentScope(rest);
    const cache = new Map();
    const open = ((adapter.sessions && adapter.sessions.supported) ? adapter.sessions.list() : [])
      .filter((s) => !s.isArchived);
    const rows = (await Promise.all(open.map((s) => resolveChat(s, cache)))).filter(inScope(scope));
    if (flags.includes('--json')) {
      process.stdout.write(JSON.stringify({ rows: rows.map((r) => ({ ...r, bucket: archiveBucketOf(r.verdict) })) }, null, 2) + '\n', () => process.exit(0));
      return;
    }
    process.stdout.write(scopeNote(scope));
    process.stdout.write(legend());
    const buckets = { safe: [], safe_stale_lock: [], in_flight: [], no_verdict: [] };
    for (const r of rows) buckets[archiveBucketOf(r.verdict)].push(r);
    const line = (r) => `  ${(r.lastActivityAt || '?').slice(0, 10)}  "${r.title}"  [${r.project || '?'}]` +
      (r.worktree ? `  wt:${r.worktree.name}` : '') + (r.verdict !== 'NO_WORKTREE' ? `  ${r.verdict}` : '');
    const section = (title, list) => { if (list.length) { process.stdout.write(`\n== ${title} (${list.length}) ==\n`); list.forEach((r) => process.stdout.write(line(r) + '\n')); } };
    section('SAFE TO ARCHIVE — work landed (worktree merged+clean, or none)', buckets.safe);
    section('SAFE TO ARCHIVE — but the worktree is stale-locked (unlock before cleanup)', buckets.safe_stale_lock);
    section('HOLD — work in flight (dirty / unmerged / live)', buckets.in_flight);
    section('NO VERDICT — repo gone; archive is harmless, nothing to clean', buckets.no_verdict);
    process.stdout.write(`\narchiving never deletes anything — it is a reversible UI flag; worktrees are cleaned separately (\`cogyard cleanup worktrees\` / \`cogyard cleanup worktrees --all\`).\n`);
    process.exit(0);
  }

  // `chats <taskId>` — the task-keyed chat lookup (task 30). Read-only, so agent
  // invocation is fine (trust rule 1); it's the durable sibling of `sessions
  // search`'s full-text search — this finds a task's chats by id, ledger-sourced so
  // archiving + worktree removal never blank the answer.
  if (cmd === 'chats') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--json' && f !== '--everywhere');
    if (unknown.length) { process.stderr.write(`cogyard sessions chats: unknown flag(s): ${unknown.join(' ')}\n`); process.exit(2); }
    const arg = rest.find((a) => !a.startsWith('--'));
    const taskId = arg != null ? Number(String(arg).replace(/^0+(?=\d)/, '')) : NaN;
    if (!Number.isInteger(taskId)) { process.stderr.write('cogyard sessions chats: give a task id, e.g. cogyard sessions chats 106\n'); process.exit(2); }
    const scope = currentScope(rest);
    const res = chatsForTask(scope, taskId);
    if (flags.includes('--json')) { process.stdout.write(JSON.stringify(res, null, 2) + '\n', () => process.exit(0)); return; }
    process.stdout.write(scopeNote(scope));
    printChats(res);
    process.exit(0);
  }

  // `find --json "<query>"` — the finder+gates as pure read-only JSON. This is
  // the agent-consumable surface the /retire-chat slash command reads; the
  // ACTIONS stay with the human (in-app archive confirmation + verified
  // removal steps). Read-only, so agent invocation is fine (trust rule 1).
  if (cmd === 'find') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--json' && f !== '--everywhere');
    if (unknown.length) { process.stderr.write(`cogyard sessions find: unknown flag(s): ${unknown.join(' ')}\n`); process.exit(2); }
    const query = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!query) { process.stderr.write('cogyard sessions find: give a search query\n'); process.exit(2); }
    const repoCache = new Map();
    const scope = currentScope(rest);
    const rows = (await Promise.all(findChats(query)
      .map(async (m) => ({ ...await resolveChat(m.session, repoCache), titleHit: m.titleHit, hits: m.hits }))))
      .filter(inScope(scope)).slice(0, 8);
    const out = { query, scope, appRunning: !!(adapter.sessions.appRunning && adapter.sessions.appRunning()), rows };
    if (flags.includes('--json')) { process.stdout.write(JSON.stringify(out, null, 2) + '\n', () => process.exit(0)); return; }
    rows.forEach((r, i) => process.stdout.write(`[${i + 1}] ${r.verdict.padEnd(11)} "${r.title}" [${r.project || '?'}]${r.worktree ? ' → ' + r.worktree.name : ''}\n`));
    process.exit(0);
  }

  if (cmd === 'show') return showCmd(rest);
  if (cmd === 'search') return searchCmd(rest);

  if (cmd !== 'audit') { process.stderr.write(`cogyard sessions: unknown subcommand '${cmd}'. Only: archivable, chats, audit, find, show, search. To ACT on any of it, use \`cogyard cleanup\`.\n`); process.exit(2); }

  // Unknown flags ERROR rather than being ignored — the same discipline the
  // gated commands use, kept here so a `--cleanup` cannot be quietly
  // reintroduced into a file that is now read-only by construction.
  const known = new Set(['--json', '--all', '--everywhere']);
  const unknown = rest.filter((a) => !known.has(a));
  if (unknown.length) {
    const moved = unknown.includes('--cleanup') ? ' — --cleanup moved: use `cogyard cleanup worktrees`' : '';
    process.stderr.write(`cogyard sessions audit: unknown flag(s): ${unknown.join(' ')}${moved}\n`);
    process.exit(2);
  }

  if (rest.includes('--all')) {
    const { repoPath, rows } = await allWorktreeCandidates(process.cwd());
    if (!repoPath) { process.stderr.write('not inside a git repo.\n'); process.exit(1); }
    if (rest.includes('--json')) { process.stdout.write(JSON.stringify({ repoPath, rows }, null, 2) + '\n', () => process.exit(0)); return; }
    process.stdout.write(legend());
    for (const r of rows) process.stdout.write(`${r.verdict.padEnd(11)} ${r.worktree.name}  (${r.worktree.branch || 'detached'}${r.taskId != null ? ` · task ${r.taskId}` : ''})  ${r.detail}\n`);
    process.stdout.write(`\n${rows.filter((r) => r.verdict === 'REMOVABLE').length} REMOVABLE of ${rows.length} — \`cogyard cleanup worktrees --all\` to select and remove.\n`);
    process.exit(0);
  }

  const scope = currentScope(rest);
  const audit = await sessionsAudit();
  audit.rows = audit.rows.filter(inScope(scope));
  if (scope && !rest.includes('--json')) process.stdout.write(scopeNote(scope));
  if (rest.includes('--json')) { process.stdout.write(JSON.stringify(audit, null, 2) + '\n', () => process.exit(0)); return; }
  printReport(audit);
  process.exit(0);
}

main();
