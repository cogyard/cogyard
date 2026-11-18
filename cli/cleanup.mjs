#!/usr/bin/env node
// cli/cleanup.mjs — `cogyard cleanup`: the disposal process, end to end.
//
// ONE group, because it IS one thing. Before this, disposal
// was split across two unrelated groups — `tasks cleanup` reclaimed disk while
// `sessions retire` archived a chat and removed its worktree — so nothing
// represented the process and there was no single word for it.
//
// THE VOCABULARY IS CLOSED. Chats are ARCHIVED (Claude's own word; it happens
// only in Claude's UI), worktrees are REMOVED, the whole thing is CLEANUP.
// "Retire" is banned — it implies something survives diminished, which
// describes neither half. Do not reintroduce it.
//
// THE TRUST MODEL (task 106, confirmed 2026-07-18) moved here WITH the
// commands, unchanged:
//   1. Reports are read-only. Zero writes, ever.
//   2. Removal requires a typed y/n per worktree at a real TTY. No --yes, no
//      --force, no bulk; unknown flags are an ERROR, not ignored.
//   3. NEVER run these from hooks, cron, LaunchAgents, autopilot, or any script
//      something else calls. Human-typed invocation only. (Clarified
//      2026-08-07: the subject is UNATTENDED callers — the portal may act
//      behind a dialog, and it does so through core/cleanup.mjs, never by
//      shelling out to this file.)
//   4. Removal refuses (loudly, nonzero) anything not REMOVABLE or PUSHED.
//      PUSHED (amended 2026-10-05, task 174) is clean + unlocked + NOT merged,
//      with origin/<branch> at exactly the local head. It is safe because the
//      checkout then holds nothing that is not also on the local branch (which
//      removal never deletes, and rule 6 verifies still resolves) AND on
//      origin. Its report reads the local remote-tracking ref, so removal first
//      asks origin itself (`git ls-remote`) and refuses if it is unreachable or
//      disagrees. Every prompt says "unmerged" — backed up is not landed.
//   5. Transcripts are never touched.
//   6. Every removal prints its undo command BEFORE the y/n, and verifies
//      after: branch resolves, task cost unchanged. Verify failure stops the run.
//
// The removal and its verifications live in core/cleanup.mjs — the same body the
// portal route runs. This file owns the GATES, not the mechanics.

import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { sessionsAudit, findChats, resolveChat, allWorktreeCandidates, isRemovableVerdict } from '../core/sessions-audit.mjs';
import { removeWorktree, cleanupReport } from '../core/cleanup.mjs';
import { reclaimReport } from '../core/reclaim.mjs';
import { readRegistry, findProject } from '../core/registry.mjs';
import { adapter } from '../core/drivers.mjs';
import { currentScope, inScope, scopeNote } from './scope.mjs';

function help() {
  process.stdout.write(`cogyard cleanup — remove finished worktrees, and find the chats to archive

Usage:
  cogyard cleanup                  read-only: what is hanging around in this
                                   project — each worktree's state, the chat
                                   that drove it, and whether that chat is safe
                                   to archive yet
  cogyard cleanup --everywhere     the same, across every registered project
  cogyard cleanup --json           the report as JSON

  cogyard cleanup worktrees        offer removable worktrees for removal, ONE AT
                                   A TIME, typed y/n each
  cogyard cleanup worktrees --all  checkbox-select from all removable worktrees
                                   of this repo, one typed confirm for the set

  Removable = REMOVABLE (clean, merged) or PUSHED (clean, NOT merged, and
  origin/<branch> is at the same commit — confirmed against origin before
  removal). Either way the branch is kept; nothing is ever deleted from origin.

  cogyard cleanup disk [slug]      reclaim regenerable build/install dirs
                                   (node_modules, dist, .angular…) from merged,
                                   clean worktrees you are KEEPING.
                                   --dry-run shows what it would free.

  cogyard cleanup chat "<query>"   find a chat, then — behind a typed y/n —
                                   archive it AND remove its worktree, IF AND
                                   ONLY IF the branch is merged and the worktree
                                   is clean. --dry-run stops before acting.

NOTE: the archive write cannot stick while the Claude desktop app is running
(the app owns the flag and overwrites external writes) — \`cleanup chat\` refuses
in that case. With the app open, archive from the app's own UI; the portal's
Cleanup tab tells you exactly which chats are ready.

MANUAL-ONLY by design: never wire these into hooks, cron, or automation.
`);
}

function ask(rl, q) {
  return new Promise((res) => rl.question(q, res));
}

// The verdicts removal accepts — one definition, shared with core.
const removable = (r) => isRemovableVerdict(r.verdict);

// What survives a removal, in words. PUSHED says "unmerged" first, plainly:
// the work is backed up, not landed, and the prompt must not let anyone read
// one as the other.
function keptNote(r) {
  const b = r.worktree.branch;
  return r.verdict === 'PUSHED'
    ? `unmerged — kept on branch ${b} and ${r.originRef || `origin/${b}`}`
    : `merged — branch ${b} kept`;
}

// How a failed removal is reported. A PRECHECK refusal (the fresh re-judge,
// or origin not confirming a PUSHED branch) removed nothing, so it is REFUSED
// and has nothing to undo; only a failure after git ran prints the undo.
const failWord = (res) => (res.stage === 'precheck' ? 'REFUSED' : res.stage === 'remove' ? 'FAILED' : 'VERIFY FAILED');
const afterFail = (res) => (res.stage === 'precheck' ? 'Nothing was removed' : `Undo: ${res.undoCmd}`);

// Every removal in this file goes through here, and this is the ONLY place that
// knows how an audit row maps onto the core call. The removal itself and its
// two verifications (branch resolves, attributed cost unchanged — trust rule 6)
// live in core/cleanup.mjs, shared with the portal route, so there is one body
// rather than the three near-identical copies this code used to carry.
//
// The GATES stay in this file, untouched: TTY refusal, unknown-flag error,
// typed y/n, the checkbox picker, stop-on-first-failure. Task 106's trust model
// is about those; it is not about where the git spawn lives.
async function doRemove(r) {
  return removeWorktree({
    repoPath: r.repoPath,
    worktreePath: r.worktree.path,
    branch: r.worktree.branch,
    project: r.project,
    taskId: r.taskId,
  });
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

// `worktrees --all`: checkbox-select from every gate-passing worktree of the
// current repo, one typed confirm for the set, then verified removals that
// stop on first failure.
async function cleanupAll() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cogyard cleanup worktrees --all: refusing — not an interactive terminal.\n');
    process.exit(1);
  }
  const { repoPath, rows } = await allWorktreeCandidates(process.cwd());
  if (!repoPath) { process.stderr.write('not inside a git repo — run from the project whose worktrees you want to clean.\n'); process.exit(1); }
  const refused = rows.filter((r) => !removable(r));
  for (const r of refused) process.stderr.write(`SKIPPED  ${r.worktree.name}: ${r.verdict} — ${r.detail}\n`);
  const candidates = rows.filter(removable);
  if (!candidates.length) { process.stdout.write('no removable worktrees in this repo.\n'); process.exit(refused.length ? 1 : 0); }

  const nPushed = candidates.filter((r) => r.verdict === 'PUSHED').length;
  process.stdout.write(`\n${candidates.length} removable worktree(s) in ${repoPath}` +
    `${nPushed ? ` (${candidates.length - nPushed} merged, ${nPushed} pushed but NOT merged)` : ''}:\n\n`);
  const picked = await checkboxPick(candidates, (r) =>
    `${r.worktree.name}  (${r.worktree.branch}${r.taskId != null ? ` · task ${r.taskId}` : ''})` +
    `${r.verdict === 'PUSHED' ? `  PUSHED: ${keptNote(r)}` : ''}`);
  if (picked === null || !picked.length) { process.stdout.write('aborted — nothing done.\n'); process.exit(0); }

  process.stdout.write(`\nselected ${picked.length}:\n`);
  for (const r of picked) process.stdout.write(`  ${r.worktree.name}  — ${keptNote(r)}\n`);
  const pickedPushed = picked.filter((r) => r.verdict === 'PUSHED').length;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await ask(rl, `remove these ${picked.length} worktree(s)?` +
    `${pickedPushed ? ` ${pickedPushed} of them ${pickedPushed === 1 ? 'is' : 'are'} unmerged — kept on their branch and on origin, as listed above.` : ''}` +
    ' Each is verified; the run stops on any failure. [y/N] ')).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') { process.stdout.write('aborted — nothing done.\n'); process.exit(0); }

  for (const r of picked) {
    const res = await doRemove(r);
    if (!res.ok) { process.stderr.write(`${failWord(res)}: ${r.worktree.name} — ${res.error}. ${afterFail(res)}. Stopping.\n`); process.exit(1); }
    process.stdout.write(`removed ${r.worktree.name} — branch intact${res.verdict === 'PUSHED' ? ` (unmerged; also on ${res.originRef})` : ''}${res.costUSD != null ? `, task ${r.taskId} cost $${res.costUSD} unchanged` : ''}\n`);
  }
  process.stdout.write(`\ndone: ${picked.length} removed, each verified.\n`);
  process.exit(0);
}

// `worktrees`: the chat-keyed pass — one archived chat's leftover worktree at a
// time, typed y/n each.
async function cleanupOne(audit) {
  // Trust rule 2: a real human at a real terminal, or nothing.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cogyard cleanup worktrees: refusing — not an interactive terminal.\n' +
      'This mode requires a human typing y/n per worktree (task 106 trust model). No piped/scripted use.\n');
    process.exit(1);
  }
  const candidates = audit.rows.filter(removable);
  const refused = audit.rows.filter((r) => ['DIRTY', 'UNMERGED', 'LOCKED', 'LIVE', 'UNKNOWN'].includes(r.verdict));
  for (const r of refused) {
    process.stderr.write(`REFUSED  ${r.worktree ? r.worktree.name : r.title}: ${r.verdict} — ${r.detail}\n`);
  }
  if (!candidates.length) {
    process.stdout.write('nothing removable to offer.\n');
    process.exit(refused.length ? 1 : 0);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let failed = false;
  for (const r of candidates) {
    process.stdout.write(`\n"${r.title}" → worktree ${r.worktree.name} (${r.worktree.branch})\n`);
    process.stdout.write(`  ${r.detail}\n`);
    process.stdout.write(`  will run: ${r.removeCmd}\n`);
    process.stdout.write(`  undo:     ${r.undoCmd}\n`);
    const a = (await ask(rl, r.verdict === 'PUSHED'
      ? `  remove this worktree? It is ${keptNote(r)}. [y/N] `
      : '  remove this worktree? [y/N] ')).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') { process.stdout.write('  skipped.\n'); continue; }

    const res = await doRemove(r);
    if (!res.ok) {
      process.stderr.write(`  ${failWord(res)}: ${res.error} — stopping. ${afterFail(res)}\n`);
      failed = true; break;
    }
    process.stdout.write(`  removed. verified: branch ${r.worktree.branch} intact${res.verdict === 'PUSHED' ? ` (unmerged; also on ${res.originRef})` : ''}${res.costUSD != null ? `, task ${r.taskId} cost unchanged ($${res.costUSD})` : ''}. undo: ${res.undoCmd}\n`);
  }
  rl.close();
  process.exit(failed ? 1 : 0);
}

// `chat "<query>"` — find → gate → archive → remove the worktree. Owner-ordered
// flow (task 106 amendment 2026-07-19). Gates: branch merged + worktree clean
// (verdict REMOVABLE), or NO_WORKTREE (archive only — nothing to remove).
// Everything else refuses loudly. TTY + typed y/n mandatory.
async function archiveChat(query, dryRun, scope) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('cogyard cleanup chat: refusing — not an interactive terminal (task 106 trust model).\n');
    process.exit(1);
  }
  if (dryRun) process.stdout.write('DRY RUN — nothing will be archived or removed.\n\n');
  const matches = findChats(query);
  if (!matches.length) { process.stdout.write(`no non-archived chat matches "${query}"\n`); process.exit(1); }

  const repoCache = new Map();
  if (scope) process.stdout.write(scopeNote(scope));
  const rows = (await Promise.all(matches
    .map(async (m) => ({ ...await resolveChat(m.session, repoCache), titleHit: m.titleHit, hits: m.hits }))))
    .filter(inScope(scope)).slice(0, 8);
  if (!rows.length) { process.stdout.write(`no match in this project — add --everywhere to search all projects\n`); process.exit(1); }
  process.stdout.write(`${matches.length} match(es) for "${query}"${matches.length > 8 ? ' (showing 8)' : ''}:\n\n`);
  rows.forEach((r, i) => {
    const when = r.lastActivityAt ? r.lastActivityAt.slice(0, 10) : '?';
    process.stdout.write(`  [${i + 1}] ${when}  "${r.title}"  [${r.project || '?'} · ${r.titleHit ? 'title match' : `${r.hits} hit(s)`}] → ${r.verdict}\n`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pickRaw = (await ask(rl, `\npick a chat to clean up [1-${rows.length}, or q]: `)).trim().toLowerCase();
  if (pickRaw === 'q' || pickRaw === '') { rl.close(); process.stdout.write('aborted.\n'); process.exit(0); }
  const pick = Number(pickRaw);
  if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) { rl.close(); process.stderr.write(`not a valid pick: ${pickRaw}\n`); process.exit(2); }
  const r = rows[pick - 1];

  // The gates. REMOVABLE = merged + clean + unlocked + no live pid.
  if (r.verdict !== 'REMOVABLE' && r.verdict !== 'NO_WORKTREE') {
    rl.close();
    process.stderr.write(`REFUSED  "${r.title}": ${r.verdict} — ${r.detail}\n` +
      'cleanup chat requires: branch merged to the default branch AND a clean worktree.\n');
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
      'so this would silently fail to archive. Either quit the app and rerun, or\n' +
      "archive the chat from the app's own UI (the portal's Cleanup tab lists which\n" +
      'chats are ready).\n');
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
  process.stdout.write('  archived (flag verified on re-read; if the chat reappears in the app, the app overwrote it — rerun).\n');

  // 2. Remove the worktree — literally the same body as `cleanup worktrees`.
  if (r.worktree) {
    const res = await doRemove(r);
    if (!res.ok) {
      const what = res.stage === 'remove' ? 'REMOVE FAILED' : 'VERIFY FAILED';
      process.stderr.write(`${what}: ${res.error}. Chat is archived; ${res.stage === 'remove' ? 'worktree untouched' : `undo: ${res.undoCmd}`}.\n`);
      process.exit(1);
    }
    process.stdout.write(`  worktree removed. verified: branch ${r.worktree.branch} intact${res.costUSD != null ? `, task ${r.taskId} cost unchanged ($${res.costUSD})` : ''}.\n`);
  }
  process.stdout.write('cleanup complete.\n');
  process.exit(0);
}

function fmtMb(kb) { return `${(kb / 1024).toFixed(1)} MB`; }

// `disk` — reclaim regenerable dirs from worktrees you are KEEPING. Eligibility,
// the disposable-dir list and the sizing all live in core/reclaim.mjs; this is
// the CLI face of that report. Removing a worktree takes its node_modules with
// it, so this only matters for ones deliberately kept (merged and clean, but
// more work coming). No portal button, by design: removing a worktree takes
// its node_modules with it, so this only matters for ones you are keeping.
async function cmdDisk(rest) {
  const slug = rest.find((a) => !a.startsWith('--'));
  const dryRun = rest.includes('--dry-run');
  if (slug && !findProject(slug)) { process.stderr.write(`cogyard cleanup disk: no registered project: ${slug}\n`); process.exit(2); }
  if (!readRegistry().length) { process.stderr.write('cogyard cleanup disk: no registered projects\n'); process.exit(2); }

  const report = await reclaimReport({ slug });
  process.stdout.write(`${dryRun ? 'DRY RUN — ' : ''}cleanup disk: merged + clean worktrees${slug ? ` in ${slug}` : ' across all projects'}\n`);
  let totalKb = 0, count = 0;
  for (const proj of report.projects) {
    for (const wt of proj.worktrees) {
      if (!wt.diskEligible || !wt.diskDirs.length) continue;
      totalKb += wt.diskKb; count++;
      const nDirs = wt.diskDirs.length > 1 ? ` [${wt.diskDirs.length} dirs]` : '';
      if (dryRun) process.stdout.write(`  would clean  ${proj.slug}/${wt.name}  ${fmtMb(wt.diskKb)}${nDirs}\n`);
      else {
        for (const d of wt.diskDirs) rmSync(d.path, { recursive: true, force: true });
        process.stdout.write(`  cleaned      ${proj.slug}/${wt.name}  ${fmtMb(wt.diskKb)} reclaimed${nDirs}\n`);
      }
    }
  }
  if (!count) { process.stdout.write('  nothing to clean (no merged, clean worktree has build/install dirs).\n'); return; }
  process.stdout.write(`${dryRun ? 'Would reclaim' : 'Reclaimed'} ${fmtMb(totalKb)} across ${count} worktree(s).${dryRun ? ' Re-run without --dry-run to delete.' : ''}\n`);
}

// The report — the process's first step. Read-only, and no `du`: git state and
// the ledgers only, so it is cheap enough to run reflexively.
async function cmdList(rest) {
  const scope = currentScope(rest);
  const report = await cleanupReport({ slug: scope });
  if (rest.includes('--json')) { process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(0)); return; }
  if (scope) process.stdout.write(scopeNote(scope));
  for (const p of report.projects) {
    if (!p.items.length && !p.chats.length) continue;
    process.stdout.write(`\n== ${p.label} ==\n`);
    for (const i of p.items) {
      const act = i.action === 'remove' ? 'REMOVE' : i.action === 'unlock' ? 'unlock' : '—';
      process.stdout.write(`  ${String(i.verdict).padEnd(10)} ${i.worktree.name}${i.taskId ? ` · #${i.taskId}` : ''}  [${act}]` +
        `${i.verdict === 'PUSHED' ? `  unmerged — on ${i.originRef}` : ''}\n`);
      if (i.chat) process.stdout.write(`      chat "${i.chat.title}" — ${i.chat.reason}\n`);
    }
    // Every chat in the project (task 144), ready or held — minus the ones
    // already shown above attached to a worktree row, so the same chat is not
    // printed twice. The portal shows both at once (its worktree table and its
    // chats list answer different questions); a text dump does not need the
    // duplication to carry the same information.
    //
    // A chat another chat started follows it, indented a step per level
    // (task 258, as on the page). A chat with children is printed even when
    // already shown above, so its children never hang under nothing.
    const shown = new Set(p.items.filter((i) => i.chat).map((i) => i.chat.sessionId));
    const parents = new Set(p.chats.map((c) => c.parentSessionId).filter(Boolean));
    for (const c of p.chats) {
      if (shown.has(c.sessionId) && !parents.has(c.sessionId)) continue;
      const indent = '  '.repeat(c.depth || 0);
      process.stdout.write(`  ${c.ready ? 'ARCHIVE   ' : 'HOLD      '} ${indent}"${c.title}" — ${c.reason}\n`);
    }
  }
  process.stdout.write(`\n${report.totalRemovable} worktree(s) removable · ${report.totalArchivable} chat(s) ready to archive in Claude's own UI.\n`);
  process.exit(0);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { help(); process.exit(0); }

  if (cmd === 'worktrees') {
    // Trust rule 2 enforcement: unknown flags ERROR, so a --yes/--force can
    // never be "accepted silently" by a future refactor.
    const unknown = rest.filter((a) => a.startsWith('--') && a !== '--all');
    if (unknown.length) { process.stderr.write(`cogyard cleanup worktrees: unknown flag(s): ${unknown.join(' ')} (no --yes/--force exists, by design)\n`); process.exit(2); }
    if (rest.includes('--all')) return cleanupAll();
    return cleanupOne(await sessionsAudit());
  }

  if (cmd === 'disk') return cmdDisk(rest);

  if (cmd === 'chat') {
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknown = flags.filter((f) => f !== '--dry-run' && f !== '--everywhere');
    if (unknown.length) { process.stderr.write(`cogyard cleanup chat: unknown flag(s): ${unknown.join(' ')} (only --dry-run/--everywhere exist, by design)\n`); process.exit(2); }
    const query = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!query) { process.stderr.write('cogyard cleanup chat: give a search query, e.g. cogyard cleanup chat --dry-run "Pick up 100"\n'); process.exit(2); }
    return archiveChat(query, flags.includes('--dry-run'), currentScope(rest));
  }

  // No subcommand (or flags only) → the report.
  if (!cmd || cmd.startsWith('--')) return cmdList(cmd ? [cmd, ...rest] : rest);

  process.stderr.write(`cogyard cleanup: unknown subcommand '${cmd}'. Only: worktrees, disk, chat (or none for the report)\n`);
  process.exit(2);
}

main();
