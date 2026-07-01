#!/usr/bin/env node
// cli/usage.mjs — token/cost usage collection + reporting (task 026).
//
// Subcommands:
//   usage.mjs collect [--session <id>]   harvest new transcript content into the
//                                        ledger (all transcripts when no --session)
//   usage.mjs collect --hook             SessionEnd-hook mode: reads the hook JSON
//                                        from stdin, collects that transcript only
//   usage.mjs backfill                   first-run harvest of ALL existing
//                                        transcripts, rows flagged backfilled:true
//   usage.mjs report [project]           rollup (all projects, or one in detail)
//   usage.mjs --help

import { existsSync } from 'node:fs';
import {
  collectUsage, usageRollup, projectUsage, findTranscriptsForSession, LEDGER_PATH,
} from '../core/usage.mjs';

function fail(msg, code = 1) {
  process.stderr.write(`usage.mjs: ${msg}\n`);
  process.exit(code);
}

function collectForSession(sessionId) {
  // The active integration knows where its transcripts live (task 038).
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
  const rows = usageRollup();
  if (!rows.length) {
    process.stdout.write(`Ledger is empty (${LEDGER_PATH}). Run: usage.mjs backfill\n`);
    return;
  }
  for (const p of rows) {
    process.stdout.write(`${p.project.padEnd(40)} ${fmtCost(p).padStart(10)}   ${p.sessions} sessions   ${fmtTokens(p.tokens)}\n`);
  }
}

function help() {
  process.stdout.write(`usage.mjs — token/cost usage ledger (task 026)

Subcommands:
  collect [--session <id>]   Harvest new transcript content (idempotent)
  collect --hook             SessionEnd-hook mode (hook JSON on stdin)
  backfill                   Harvest all existing transcripts, flagged backfilled
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
