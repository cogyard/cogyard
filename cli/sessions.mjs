#!/usr/bin/env node
// cli/sessions.mjs — `cogyard sessions audit` (task 106).
//
// THE TRUST MODEL (owner-confirmed 2026-07-18; these are hard rules, and a
// future session that "improves" them away has failed task 106):
//   1. Default invocation is a pure READ-ONLY report. Zero writes, ever.
//   2. Cleanup requires --cleanup AND a typed y/n per worktree at a real TTY.
//      There is NO --yes, NO --force, NO bulk mode — unknown flags are an
//      ERROR, not ignored, so such flags cannot even be passed uneventfully.
//   3. NEVER run this from hooks, cron, LaunchAgents, portal routes, autopilot,
//      or any script something else calls. Human-typed invocation only.
//   4. Cleanup refuses (loudly, nonzero) anything not REMOVABLE.
//   5. Never archives chats, never touches transcripts.
//   6. Every removal prints its undo command BEFORE the y/n, and verifies
//      after: branch still resolves, task cost unchanged. Verify failure stops
//      the whole run.

import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { sessionsAudit, findChats, resolveChat, allWorktreeCandidates } from '../core/sessions-audit.mjs';
import { chatsForTask } from '../core/task-chats.mjs';
import { adapter } from '../core/drivers.mjs';
import { taskUsage, resolveProjectForPath } from '../core/usage.mjs';
import { tryExec, findRepoRoot } from '../core/exec.mjs';

function help() {
  process.stdout.write(`cogyard sessions — chat × worktree audit + gated retirement

Usage:
  cogyard sessions archivable        read-only: every NON-archived chat,
                                     bucketed by whether archiving is safe —
                                     the UI-archiving shopping list
  cogyard sessions chats <taskId>    read-only: the chats that CREATED,
                                     IMPLEMENTED, and MENTIONED a task —
                                     durable across archiving + worktree
                                     removal. Each carries a \`bencc show <id>\`
                                     to read its transcript. --everywhere
                                     crosses projects; --json feeds /task-chats
  cogyard sessions audit             read-only report over ARCHIVED chats
  cogyard sessions audit --json      the same report as JSON
  cogyard sessions audit --cleanup   offer REMOVABLE leftover worktrees for
                                     removal, ONE AT A TIME, typed y/n each
  cogyard sessions audit --all       read-only: EVERY worktree of the current
                                     repo with its safety verdict (chat state
                                     ignored)
  cogyard sessions audit --cleanup --all
                                     checkbox-select from all REMOVABLE
                                     worktrees of the current repo, one typed
                                     confirm for the set, verified removals
                                     that stop on first failure
  cogyard sessions retire "<query>"  find a chat like /bd-chats (title +
                                     transcript text), then — behind a typed
                                     y/n — archive it AND remove its worktree,
                                     IF AND ONLY IF the branch is merged and
                                     the worktree is clean. Refuses loudly
                                     otherwise. Never touches transcripts.
  cogyard sessions retire --dry-run "<query>"
                                     the same flow, but stops before acting:
                                     shows the pick, the gate verdict, and
                                     exactly what a real run would do. The
                                     only flag retire accepts.
  cogyard sessions find [--json] "<query>"
                                     the finder + gate verdicts alone, read-
                                     only. JSON mode feeds the /retire-chat
                                     slash command.

NOTE: retire's archive write cannot stick while the desktop app is running
(the app overwrites it) — retire refuses in that case. With the app open,
use /retire-chat inside a Claude session instead: the app archives via its
own tool, and the worktree removal runs with the same verification.

This command is MANUAL-ONLY by design (task 106 trust model): never wire it
into hooks, cron, autopilot, or any automation. The default report never
writes anything. There is no --yes and no bulk mode, deliberately. Transcripts
are never touched; the only metadata write is retire's gated isArchived flip.
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
  UNMERGED      branch has commits not on the default branch — work not landed yet
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
  process.stdout.write(`\n${n} REMOVABLE — run the printed commands yourself, or \`cogyard sessions audit --cleanup\` for gated interactive removal.\n`);
}

// `chats <taskId>` output. Three buckets, each chat: short id · (role) · date ·
// label · archived marker · the `bencc show` command that reads its transcript.
function printChats(res) {
  const line = (c) => {
    const id = c.sessionId ? c.sessionId.slice(0, 8) : '????????';
    const when = c.lastActiveAt ? c.lastActiveAt.slice(0, 10) : (c.startedAt ? c.startedAt.slice(0, 10) : '?');
    const arch = c.archived ? ' [archived]' : '';
    const inf = c.inferred ? ' (inferred)' : '';
    const label = c.label ? `"${c.label}"` : (c.transcriptPath ? '(no label)' : 'TRANSCRIPT MISSING');
    const show = c.sessionId ? `\n              bencc show ${id}` : '';
    return `  ${id}  ${when}${arch}${inf}  ${label}${show}`;
  };
  const section = (title, list) => {
    process.stdout.write(`\n== ${title} (${list.length}) ==\n`);
    if (!list.length) { process.stdout.write('  (none)\n'); return; }
    for (const c of list) process.stdout.write(line(c) + '\n');
  };
  process.stdout.write(`task ${res.taskId} chats${res.project ? ` [${res.project}]` : ' [all projects]'}\n`);
  process.stdout.write('  read one with: bencc show <id>   (or hand its transcript path to Claude)\n');
  section('CREATED', res.created ? [res.created] : []);
  section('IMPLEMENTED — claimed or committed, strongest first', res.implemented);
  section('MENTIONED — referenced without claiming/committing', res.mentioned);
  process.stdout.write('\narchiving never loses a chat — the transcript stays on disk; this lookup finds it by task id.\n');
}

function ask(rl, q) {
  return new Promise((res) => rl.question(q, res));
}

// Default scope = the project you're standing in (matching the rest of the
// CLI: work commands are repo-scoped). --everywhere lifts it; outside any
// repo there is nothing to scope to, so everything shows.
function currentScope(rest) {
  if (rest.includes('--everywhere')) return null;
  const root = findRepoRoot(process.cwd());
  return root ? resolveProjectForPath(root) : null;
}
function inScope(scope) {
  return (r) => !scope || r.project === scope || String(r.project || '').startsWith(scope + '__');
}
function scopeNote(scope) {
  return scope ? `scope: ${scope} (use --everywhere for all projects)\n` : '';
}

// Zero-dependency checkbox picker (raw-mode TTY). Arrows/j/k move, space
// toggles, `a` toggles all, enter accepts, q/Esc/Ctrl-C aborts (→ null).
// Owner-amended trust model (2026-07-20): bulk SELECTION is allowed for
// --all; the actions still funnel through one typed confirm + per-item
// verification in the caller.
function checkboxPick(items, renderLine) {
  return new Promise((resolve) => {
    const checked = items.map(() => false);
    let cursor = 0;
    const out = process.stdout;
    const draw = (first) => {
      if (!first) out.write(`\x1b[${items.length + 1}A`);
      out.write('\x1b[J');
      out.write('  space: toggle · a: all · enter: accept · q: abort\n');
      items.forEach((it, i) => {
        out.write(`${i === cursor ? '›' : ' '} [${checked[i] ? 'x' : ' '}] ${renderLine(it)}\n`);
      });
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = (result) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKey);
      resolve(result);
    };
    const onKey = (buf) => {
      const k = buf.toString();
      if (k === 'q' || k === '\x1b' || k === '\x03') return done(null);
      if (k === '\r' || k === '\n') return done(items.filter((_, i) => checked[i]));
      if (k === ' ') checked[cursor] = !checked[cursor];
      else if (k === 'a') { const all = checked.every(Boolean); checked.fill(!all); }
      else if (k === '\x1b[A' || k === 'k') cursor = (cursor - 1 + items.length) % items.length;
      else if (k === '\x1b[B' || k === 'j') cursor = (cursor + 1) % items.length;
      draw(false);
    };
    process.stdin.on('data', onKey);
    draw(true);
  });
}

// `--cleanup --all`: checkbox-select from every gate-passing worktree of the
// current repo, one typed confirm for the set, then verified removals that
// stop on first failure.
async function cleanupAll() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cogyard sessions audit --cleanup --all: refusing — not an interactive terminal.\n');
    process.exit(1);
  }
  const { repoPath, rows } = allWorktreeCandidates(process.cwd());
  if (!repoPath) { process.stderr.write('not inside a git repo — run from the project whose worktrees you want to clean.\n'); process.exit(1); }
  const refused = rows.filter((r) => r.verdict !== 'REMOVABLE');
  for (const r of refused) process.stderr.write(`SKIPPED  ${r.worktree.name}: ${r.verdict} — ${r.detail}\n`);
  const candidates = rows.filter((r) => r.verdict === 'REMOVABLE');
  if (!candidates.length) { process.stdout.write('no REMOVABLE worktrees in this repo.\n'); process.exit(refused.length ? 1 : 0); }

  process.stdout.write(`\n${candidates.length} REMOVABLE worktree(s) in ${repoPath}:\n\n`);
  const picked = await checkboxPick(candidates, (r) =>
    `${r.worktree.name}  (${r.worktree.branch}${r.taskId != null ? ` · task ${r.taskId}` : ''})`);
  if (picked === null || !picked.length) { process.stdout.write('aborted — nothing done.\n'); process.exit(0); }

  process.stdout.write(`\nselected ${picked.length}:\n`);
  for (const r of picked) process.stdout.write(`  ${r.worktree.name}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await ask(rl, `remove these ${picked.length} worktree(s)? Each is verified; the run stops on any failure. [y/N] `)).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') { process.stdout.write('aborted — nothing done.\n'); process.exit(0); }

  for (const r of picked) {
    const before = r.taskId != null && r.project ? taskUsage(r.project, r.taskId).costUSD : null;
    const rm = spawnSync('git', ['-C', r.repoPath, 'worktree', 'remove', r.worktree.path], { stdio: 'inherit' });
    if (rm.status !== 0) { process.stderr.write(`FAILED: ${r.worktree.name} — git exited ${rm.status}. Stopping.\n`); process.exit(1); }
    const branchOk = tryExec(`git -C ${r.repoPath} rev-parse --verify --quiet refs/heads/${r.worktree.branch}`) != null;
    const after = r.taskId != null && r.project ? taskUsage(r.project, r.taskId).costUSD : null;
    if (!branchOk) { process.stderr.write(`VERIFY FAILED: branch ${r.worktree.branch} gone. Undo: ${r.undoCmd}. Stopping.\n`); process.exit(1); }
    if (before !== after) { process.stderr.write(`VERIFY FAILED: task ${r.taskId} cost moved ($${before} → $${after}). Undo: ${r.undoCmd}. Stopping.\n`); process.exit(1); }
    process.stdout.write(`removed ${r.worktree.name} — branch intact${before != null ? `, task ${r.taskId} cost $${before} unchanged` : ''}\n`);
  }
  process.stdout.write(`\ndone: ${picked.length} removed, each verified.\n`);
  process.exit(0);
}

async function cleanup(audit) {
  // Trust rule 2: a real human at a real terminal, or nothing.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cogyard sessions audit --cleanup: refusing — not an interactive terminal.\n' +
      'This mode requires a human typing y/n per worktree (task 106 trust model). No piped/scripted use.\n');
    process.exit(1);
  }
  const candidates = audit.rows.filter((r) => r.verdict === 'REMOVABLE');
  const refused = audit.rows.filter((r) => ['DIRTY', 'UNMERGED', 'LOCKED', 'LIVE', 'UNKNOWN'].includes(r.verdict));
  for (const r of refused) {
    process.stderr.write(`REFUSED  ${r.worktree ? r.worktree.name : r.title}: ${r.verdict} — ${r.detail}\n`);
  }
  if (!candidates.length) {
    process.stdout.write('nothing REMOVABLE to offer.\n');
    process.exit(refused.length ? 1 : 0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let failed = false;
  for (const r of candidates) {
    const repoPath = r.removeCmd.match(/^git -C (\S+) /)[1];
    process.stdout.write(`\n"${r.title}" → worktree ${r.worktree.name} (${r.worktree.branch})\n`);
    process.stdout.write(`  ${r.detail}\n`);
    process.stdout.write(`  will run: ${r.removeCmd}\n`);
    process.stdout.write(`  undo:     ${r.undoCmd}\n`);
    const a = (await ask(rl, '  remove this worktree? [y/N] ')).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') { process.stdout.write('  skipped.\n'); continue; }

    // Cost baseline (trust rule 6) — attributed cost must not move.
    const before = r.taskId != null && r.project ? taskUsage(r.project, r.taskId).costUSD : null;
    const rm = spawnSync('git', ['-C', repoPath, 'worktree', 'remove', r.worktree.path], { stdio: 'inherit' });
    if (rm.status !== 0) { process.stderr.write(`  FAILED: git worktree remove exited ${rm.status} — stopping.\n`); failed = true; break; }

    const branchOk = tryExec(`git -C ${repoPath} rev-parse --verify --quiet refs/heads/${r.worktree.branch}`) != null;
    const after = r.taskId != null && r.project ? taskUsage(r.project, r.taskId).costUSD : null;
    if (!branchOk) { process.stderr.write(`  VERIFY FAILED: branch ${r.worktree.branch} no longer resolves — stopping. Undo: ${r.undoCmd}\n`); failed = true; break; }
    if (before !== after) { process.stderr.write(`  VERIFY FAILED: task ${r.taskId} cost moved ($${before} → $${after}) — stopping. Undo: ${r.undoCmd}\n`); failed = true; break; }
    process.stdout.write(`  removed. verified: branch ${r.worktree.branch} intact${before != null ? `, task ${r.taskId} cost unchanged ($${before})` : ''}. undo: ${r.undoCmd}\n`);
  }
  rl.close();
  process.exit(failed ? 1 : 0);
}

// `retire "<query>"` — find → gate → archive → clean up. Owner-ordered flow
// (task 106 amendment 2026-07-19). Gates: branch merged + worktree clean
// (verdict REMOVABLE), or NO_WORKTREE (archive only — nothing to clean).
// Everything else refuses loudly. TTY + typed y/n mandatory.
async function retire(query, dryRun, scope) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cogyard sessions retire: refusing — not an interactive terminal (task 106 trust model).\n');
    process.exit(1);
  }
  if (dryRun) process.stdout.write('DRY RUN — nothing will be archived or removed.\n\n');
  const matches = findChats(query);
  if (!matches.length) { process.stdout.write(`no non-archived chat matches "${query}"\n`); process.exit(1); }

  const repoCache = new Map();
  if (scope) process.stdout.write(scopeNote(scope));
  const rows = matches.map((m) => ({ ...resolveChat(m.session, repoCache), titleHit: m.titleHit, hits: m.hits })).filter(inScope(scope)).slice(0, 8);
  if (!rows.length) { process.stdout.write(`no match in this project — add --everywhere to search all projects\n`); process.exit(1); }
  process.stdout.write(`${matches.length} match(es) for "${query}"${matches.length > 8 ? ' (showing 8)' : ''}:\n\n`);
  rows.forEach((r, i) => {
    const when = r.lastActivityAt ? r.lastActivityAt.slice(0, 10) : '?';
    process.stdout.write(`  [${i + 1}] ${when}  "${r.title}"  [${r.project || '?'} · ${r.titleHit ? 'title match' : `${r.hits} hit(s)`}] → ${r.verdict}\n`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pickRaw = (await ask(rl, `\npick a chat to retire [1-${rows.length}, or q]: `)).trim().toLowerCase();
  if (pickRaw === 'q' || pickRaw === '') { rl.close(); process.stdout.write('aborted.\n'); process.exit(0); }
  const pick = Number(pickRaw);
  if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) { rl.close(); process.stderr.write(`not a valid pick: ${pickRaw}\n`); process.exit(2); }
  const r = rows[pick - 1];

  // The gates. REMOVABLE = merged + clean + unlocked + no live pid.
  if (r.verdict !== 'REMOVABLE' && r.verdict !== 'NO_WORKTREE') {
    rl.close();
    process.stderr.write(`REFUSED  "${r.title}": ${r.verdict} — ${r.detail}\n` +
      'retire requires: branch merged to the default branch AND a clean worktree.\n');
    process.exit(1);
  }

  process.stdout.write(`\n"${r.title}"  [${r.project || '?'}]\n`);
  if (r.worktree) {
    process.stdout.write(`  worktree: ${r.worktree.name} (${r.worktree.branch}) — ${r.detail}\n`);
    process.stdout.write(`  will: archive the chat, then run: ${r.removeCmd}\n`);
    process.stdout.write(`  undo worktree: ${r.undoCmd}  (unarchive: Claude Desktop → Archived list)\n`);
  } else {
    process.stdout.write(`  no worktree (${r.detail}) — will archive the chat only\n`);
  }
  if (dryRun) {
    rl.close();
    process.stdout.write('\nDRY RUN — gates passed; the steps above are what a real run would do. Nothing was changed.\n');
    process.exit(0);
  }

  // The app-running guard. While the desktop app runs, it clobbers external
  // isArchived writes with its in-memory state (proven live 2026-07-19 on
  // "Pick up 77": write verified on re-read, then overwritten to false).
  if (adapter.sessions.appRunning && adapter.sessions.appRunning()) {
    rl.close();
    process.stderr.write('\nREFUSED: the desktop app is running — it overwrites external archive flags,\n' +
      'so this retire would silently fail to archive. Either quit the app and rerun,\n' +
      'or run /retire-chat inside a Claude session (the app archives via its own tool).\n');
    process.exit(1);
  }

  const a = (await ask(rl, '  proceed? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') { process.stdout.write('aborted — nothing done.\n'); process.exit(0); }

  // 1. Archive (the seam's single sanctioned write), verified by re-read.
  let flag;
  try { flag = adapter.sessions.archive(r.sessionId); }
  catch (e) { process.stderr.write(`ARCHIVE FAILED: ${e.message} — nothing removed.\n`); process.exit(1); }
  if (!flag) { process.stderr.write('ARCHIVE FAILED: isArchived did not stick on re-read — nothing removed.\n'); process.exit(1); }
  process.stdout.write('  archived (flag verified on re-read; if the chat reappears in the app, the app overwrote it — rerun retire).\n');

  // 2. Remove the worktree with the same verification as cleanup mode.
  if (r.worktree) {
    const before = r.taskId != null && r.project ? taskUsage(r.project, r.taskId).costUSD : null;
    const rm = spawnSync('git', ['-C', r.repoPath, 'worktree', 'remove', r.worktree.path], { stdio: 'inherit' });
    if (rm.status !== 0) { process.stderr.write(`REMOVE FAILED: git exited ${rm.status}. Chat is archived; worktree untouched.\n`); process.exit(1); }
    const branchOk = tryExec(`git -C ${r.repoPath} rev-parse --verify --quiet refs/heads/${r.worktree.branch}`) != null;
    const after = r.taskId != null && r.project ? taskUsage(r.project, r.taskId).costUSD : null;
    if (!branchOk) { process.stderr.write(`VERIFY FAILED: branch ${r.worktree.branch} no longer resolves. Undo: ${r.undoCmd}\n`); process.exit(1); }
    if (before !== after) { process.stderr.write(`VERIFY FAILED: task ${r.taskId} cost moved ($${before} → $${after}). Undo: ${r.undoCmd}\n`); process.exit(1); }
    process.stdout.write(`  worktree removed. verified: branch ${r.worktree.branch} intact${before != null ? `, task ${r.taskId} cost unchanged ($${before})` : ''}.\n`);
  }
  process.stdout.write('retire complete.\n');
  process.exit(0);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { help(); process.exit(cmd ? 0 : 1); }
  // `archivable` — CHAT-keyed, read-only: every non-archived chat bucketed by
  // whether archiving it is safe (work landed) or premature (work in flight).
  // The UI-archiving shopping list; --all/--cleanup are the WORKTREE lens.
  if (cmd === 'archivable') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--json' && f !== '--everywhere');
    if (unknown.length) { process.stderr.write(`cogyard sessions archivable: unknown flag(s): ${unknown.join(' ')}\n`); process.exit(2); }
    const scope = currentScope(rest);
    const cache = new Map();
    const rows = ((adapter.sessions && adapter.sessions.supported) ? adapter.sessions.list() : [])
      .filter((s) => !s.isArchived).map((s) => resolveChat(s, cache)).filter(inScope(scope));
    const bucketOf = (r) =>
      (r.verdict === 'REMOVABLE' || r.verdict === 'NO_WORKTREE') ? 'safe'
        : r.verdict === 'LOCKED' ? 'safe_stale_lock'
          : (r.verdict === 'DIRTY' || r.verdict === 'UNMERGED' || r.verdict === 'LIVE') ? 'in_flight'
            : 'no_verdict';
    if (flags.includes('--json')) {
      process.stdout.write(JSON.stringify({ rows: rows.map((r) => ({ ...r, bucket: bucketOf(r) })) }, null, 2) + '\n', () => process.exit(0));
      return;
    }
    process.stdout.write(scopeNote(scope));
    process.stdout.write(legend());
    const buckets = { safe: [], safe_stale_lock: [], in_flight: [], no_verdict: [] };
    for (const r of rows) buckets[bucketOf(r)].push(r);
    const line = (r) => `  ${(r.lastActivityAt || '?').slice(0, 10)}  "${r.title}"  [${r.project || '?'}]` +
      (r.worktree ? `  wt:${r.worktree.name}` : '') + (r.verdict !== 'NO_WORKTREE' ? `  ${r.verdict}` : '');
    const section = (title, list) => { if (list.length) { process.stdout.write(`\n== ${title} (${list.length}) ==\n`); list.forEach((r) => process.stdout.write(line(r) + '\n')); } };
    section('SAFE TO ARCHIVE — work landed (worktree merged+clean, or none)', buckets.safe);
    section('SAFE TO ARCHIVE — but the worktree is stale-locked (unlock before cleanup)', buckets.safe_stale_lock);
    section('HOLD — work in flight (dirty / unmerged / live)', buckets.in_flight);
    section('NO VERDICT — repo gone; archive is harmless, nothing to clean', buckets.no_verdict);
    process.stdout.write(`\narchiving never deletes anything — it is a reversible UI flag; worktrees are cleaned separately (--cleanup / --cleanup --all).\n`);
    process.exit(0);
  }

  // `chats <taskId>` — the task-keyed chat lookup (task 30). Read-only, so agent
  // invocation is fine (trust rule 1); it's the durable sibling of /bd-chats's
  // full-text search — this finds a task's chats by id, ledger-sourced so
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
    const rows = findChats(query).map((m) => ({ ...resolveChat(m.session, repoCache), titleHit: m.titleHit, hits: m.hits })).filter(inScope(scope)).slice(0, 8);
    const out = { query, scope, appRunning: !!(adapter.sessions.appRunning && adapter.sessions.appRunning()), rows };
    if (flags.includes('--json')) { process.stdout.write(JSON.stringify(out, null, 2) + '\n', () => process.exit(0)); return; }
    rows.forEach((r, i) => process.stdout.write(`[${i + 1}] ${r.verdict.padEnd(11)} "${r.title}" [${r.project || '?'}]${r.worktree ? ' → ' + r.worktree.name : ''}\n`));
    process.exit(0);
  }

  if (cmd === 'retire') {
    // --dry-run is the ONLY flag; anything else is refused — no bulk, no yes.
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--dry-run' && f !== '--everywhere');
    if (unknown.length) { process.stderr.write(`cogyard sessions retire: unknown flag(s): ${unknown.join(' ')} (only --dry-run/--everywhere exist; no --yes/bulk mode, by design)\n`); process.exit(2); }
    const query = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!query) { process.stderr.write('cogyard sessions retire: give a search query, e.g. cogyard sessions retire --dry-run "Pick up 100"\n'); process.exit(2); }
    return retire(query, flags.includes('--dry-run'), currentScope(rest));
  }
  if (cmd !== 'audit') { process.stderr.write(`cogyard sessions: unknown subcommand '${cmd}'. Only: archivable, chats, audit, find, retire\n`); process.exit(2); }

  // Trust rule 2 enforcement: unknown flags ERROR — a --yes/--force can never
  // be "accepted silently" by a future refactor without tripping this gate.
  const known = new Set(['--json', '--cleanup', '--all', '--everywhere']);
  const unknown = rest.filter((a) => !known.has(a));
  if (unknown.length) { process.stderr.write(`cogyard sessions audit: unknown flag(s): ${unknown.join(' ')} (no --yes/--force exists, by design)\n`); process.exit(2); }
  if (rest.includes('--json') && rest.includes('--cleanup')) { process.stderr.write('cogyard sessions audit: --json and --cleanup are mutually exclusive\n'); process.exit(2); }

  if (rest.includes('--all')) {
    if (rest.includes('--cleanup')) return cleanupAll();
    // --all alone (or with --json): read-only listing of the same candidates.
    const { repoPath, rows } = allWorktreeCandidates(process.cwd());
    if (!repoPath) { process.stderr.write('not inside a git repo.\n'); process.exit(1); }
    if (rest.includes('--json')) { process.stdout.write(JSON.stringify({ repoPath, rows }, null, 2) + '\n', () => process.exit(0)); return; }
    process.stdout.write(legend());
    for (const r of rows) process.stdout.write(`${r.verdict.padEnd(11)} ${r.worktree.name}  (${r.worktree.branch || 'detached'}${r.taskId != null ? ` · task ${r.taskId}` : ''})  ${r.detail}\n`);
    process.stdout.write(`\n${rows.filter((r) => r.verdict === 'REMOVABLE').length} REMOVABLE of ${rows.length} — \`cogyard sessions audit --cleanup --all\` to select and remove.\n`);
    process.exit(0);
  }

  const scope = currentScope(rest);
  const audit = sessionsAudit();
  audit.rows = audit.rows.filter(inScope(scope));
  if (scope && !rest.includes('--json')) process.stdout.write(scopeNote(scope));
  if (rest.includes('--cleanup')) return cleanup(audit);
  if (rest.includes('--json')) { process.stdout.write(JSON.stringify(audit, null, 2) + '\n', () => process.exit(0)); return; }
  printReport(audit);
  process.exit(0);
}

main();
