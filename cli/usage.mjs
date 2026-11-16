#!/usr/bin/env node
// cli/usage.mjs — token/cost usage collection + reporting.
//
// Subcommands:
//   usage.mjs collect [--session <id>]   harvest new transcript content into the
//                                        ledger (all transcripts when no --session)
//   usage.mjs collect --hook             SessionEnd-hook mode: reads the hook JSON
//                                        from stdin, collects that transcript only
//   usage.mjs backfill                   first-run harvest of ALL existing
//                                        transcripts, rows flagged backfilled:true
//   usage.mjs reprice [--dry-run]        price the rows a missing model left at
//                                        costUSD:null (all projects)
//   usage.mjs pricing [sync]             show the active price table (or pull
//                                        live rates now, then reprice)
//   usage.mjs report [project]           rollup (all projects, or one in detail)
//   usage.mjs --help

import { existsSync } from 'node:fs';
import {
  collectUsage, repriceLedger, refreshPricing, readUsageLedger,
  usageRollup, projectUsage, findTranscriptsForSession, LEDGER_PATH,
} from '../core/usage.mjs';
import { activeVersions, pricingStatus } from '../core/pricing.mjs';

function fail(msg, code = 1) {
  process.stderr.write(`usage.mjs: ${msg}\n`);
  process.exit(code);
}

function collectForSession(sessionId) {
  // The active driver knows where its transcripts live.
  const files = findTranscriptsForSession(sessionId);
  if (!files.length) fail(`no transcript found for session ${sessionId}`);
  return collectUsage({ files });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

function fmtTokens(t) {
  const m = (n) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n));
  return `in ${m(t.input)} · out ${m(t.output)} · cacheR ${m(t.cacheRead)} · cacheW ${m(t.cacheWrite5m + t.cacheWrite1h)}`;
}

function fmtCost(b) {
  const total = b.costUSD || 0;
  if (b.backfilledCostUSD && b.backfilledCostUSD >= total) return `≈$${total.toFixed(2)}`; // fully backfilled estimate
  if (b.backfilledCostUSD) return `$${total.toFixed(2)} (≈$${b.backfilledCostUSD.toFixed(2)} backfilled)`;
  return `$${total.toFixed(2)}`;
}

function report(project) {
  if (project) {
    const p = projectUsage(project);
    process.stdout.write(`# ${p.project} — ${fmtCost(p)} across ${p.sessions} sessions\n\n`);
    process.stdout.write('## By model\n');
    for (const [model, b] of Object.entries(p.models).sort((a, z) => z[1].costUSD - a[1].costUSD)) {
      process.stdout.write(`  ${model.padEnd(22)} ${fmtCost(b).padStart(10)}   ${fmtTokens(b.tokens)}\n`);
    }
    process.stdout.write('\n## By task\n');
    for (const t of p.tasks) {
      process.stdout.write(`  ${String(t.taskId ?? '(no task)').padEnd(12)} ${fmtCost(t).padStart(10)}   ${fmtTokens(t.tokens)}\n`);
    }
    return;
  }
  const { projects, jobs, outside } = usageRollup();
  if (!projects.length && !jobs.length && !outside.length) {
    process.stdout.write(`Ledger is empty (${LEDGER_PATH}). Run: usage.mjs backfill\n`);
    return;
  }
  const line = (name, p) => process.stdout.write(`${name.padEnd(40)} ${fmtCost(p).padStart(10)}   ${p.sessions} sessions   ${fmtTokens(p.tokens)}\n`);
  for (const p of projects) line(p.project, p);
  // Every row is in exactly one section, so the sections add up to the ledger.
  if (jobs.length) {
    process.stdout.write('\n## Scheduled tasks\n');
    for (const j of jobs) line(j.job, j);
  }
  if (outside.length) {
    process.stdout.write('\n## Outside any project\n');
    for (const p of outside) line(p.project, p);
  }
}

// Models the ledger has rows for but the table can't price — the failure this
// whole mechanism exists to make loud instead of silent ($0 that reads as free).
function unpricedModels() {
  const counts = new Map();
  for (const row of readUsageLedger()) {
    if (row.costUSD !== null && row.costUSD !== undefined) continue;
    counts.set(row.model, (counts.get(row.model) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function pricingReport() {
  const st = pricingStatus();
  const current = activeVersions()[0];
  process.stdout.write(`driver     ${st.driver}\n`);
  const table = st.synced ? 'synced'
    : st.seedVersions ? 'built-in seed (never synced)'
      : 'none — this driver ships no price table, so cost is never computed';
  process.stdout.write(`table      ${table}\n`);
  process.stdout.write(`version    ${st.version || '—'}\n`);
  process.stdout.write(`source     ${st.source || '—'}\n`);
  // Only this driver's entry — the store holds every driver's table, and showing
  // another one's would imply rates that aren't in play here.
  if (st.synced) {
    process.stdout.write(`store      ${st.storePath}\n`);
    process.stdout.write(`updated    ${st.updated}\n`);
  }
  if (current) {
    process.stdout.write('\n$ per MTok\n');
    for (const [model, r] of Object.entries(current.models).sort()) {
      process.stdout.write(`  ${model.padEnd(32)} in $${String(r.input).padStart(6)}   out $${String(r.output).padStart(6)}\n`);
    }
  }
  const unpriced = unpricedModels();
  if (unpriced.length) {
    process.stdout.write('\nUNPRICED — ledger rows with no cost (they read as $0):\n');
    for (const [model, n] of unpriced) process.stdout.write(`  ${model.padEnd(32)} ${n} row(s)\n`);
    process.stdout.write('Run `usage.mjs pricing sync` — if a model stays here, the feed does not carry it.\n');
  }
}

function help() {
  process.stdout.write(`usage.mjs — token/cost usage ledger

Subcommands:
  collect [--session <id>]   Harvest new transcript content (idempotent)
  collect --hook             SessionEnd-hook mode (hook JSON on stdin)
  backfill                   Harvest all existing transcripts, flagged backfilled
  reprice [--dry-run]        Fill in cost for rows whose model was missing from
                             the price table when they were collected (every
                             project). Priced rows are never touched.
  pricing                    Show the active price table, where it came from,
                             and any models the ledger can't price
  pricing sync               Pull live rates now; reprice unpriced rows if the
                             table changed (the portal does this every 24h)
  report [project]           Cost/token rollup (all projects, or one in detail)
`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'collect': {
    if (rest.includes('--hook')) {
      const raw = await readStdin();
      let transcriptPath = null;
      try { transcriptPath = JSON.parse(raw).transcript_path || null; } catch {}
      const result = transcriptPath && existsSync(transcriptPath)
        ? collectUsage({ files: [transcriptPath] })
        : collectUsage(); // fall back to a full sweep
      process.stdout.write(JSON.stringify(result) + '\n');
      break;
    }
    const sIdx = rest.indexOf('--session');
    const result = sIdx !== -1 ? await collectForSession(rest[sIdx + 1]) : collectUsage();
    process.stdout.write(JSON.stringify(result) + '\n');
    break;
  }
  case 'backfill': {
    const result = collectUsage({ backfilled: true });
    process.stdout.write(JSON.stringify(result) + '\n');
    break;
  }
  case 'reprice': {
    const result = repriceLedger({ dryRun: rest.includes('--dry-run') });
    process.stdout.write(JSON.stringify(result) + '\n');
    break;
  }
  case 'pricing': {
    if (rest[0] === 'sync') {
      const result = await refreshPricing();
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.sync.ok) process.exitCode = 1;
      break;
    }
    pricingReport();
    break;
  }
  case 'report':
    report(rest[0]);
    break;
  case '--help':
  case '-h':
  case undefined:
    help();
    break;
  default:
    fail(`unknown subcommand: ${cmd}. Run usage.mjs --help`);
}
