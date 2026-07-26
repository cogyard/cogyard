// scripts/cost-attribution-coverage.mjs — task 103 baseline + regression check.
//
// Answers one question: of a project's total banked cost, how much can be
// attributed to a task, and how much stays in the general `(no task)` bucket?
//
// It buckets each usage.jsonl row's costUSD using the EXACT resolver the query
// path ships (core/usage.mjs sessionTaskFallback / effectiveTaskId), so the
// numbers here are the numbers the portal shows — one source of truth:
//   before  — claim only (row.taskId set at collection time)
//   after   — claim OR banked activity fallback (commit [#NN] / _tasks/NNN- refs)
//   (no task) — no signal anywhere; stays in the general project bucket
//
// The shift from before → after IS the acceptance evidence. Run it pre/post any
// change to the resolver. Read-only — touches no ledger, no repo.
//
// Usage:  node scripts/cost-attribution-coverage.mjs [projectSlug]   (default: cogyard)

import { readUsageLedger, sessionTaskFallback, effectiveTaskId } from '../core/usage.mjs';

const slug = process.argv[2] || 'cogyard';
const inProject = (p) => { const s = p || '(unknown)'; return s === slug || s.startsWith(slug + '__'); };

const fallback = sessionTaskFallback();

let total = 0, claimOnly = 0, recovered = 0, none = 0;
const byTask = new Map();
for (const row of readUsageLedger()) {
  if (!inProject(row.project) || row.costUSD == null) continue;
  total += row.costUSD;
  const claim = row.taskId != null;
  const eff = effectiveTaskId(row, fallback);
  if (claim) claimOnly += row.costUSD;
  else if (eff != null) recovered += row.costUSD;
  else none += row.costUSD;
  const key = eff ?? '(no task)';
  byTask.set(key, (byTask.get(key) || 0) + row.costUSD);
}

const pct = (n) => total ? (n / total * 100).toFixed(1) + '%' : '0%';
const usd = (n) => '$' + n.toFixed(2).padStart(9);

console.log(`\n  project: ${slug}`);
console.log(`  TOTAL banked cost              ${usd(total)}`);
console.log(`  ─────`);
console.log(`  before  (claim only)           ${usd(claimOnly)}  ${pct(claimOnly)}`);
console.log(`  + recovered (banked fallback)  ${usd(recovered)}  ${pct(recovered)}`);
console.log(`  = attributed (after)           ${usd(claimOnly + recovered)}  ${pct(claimOnly + recovered)}`);
console.log(`  (no task) — general bucket     ${usd(none)}  ${pct(none)}`);
console.log(`\n  top tasks by cost (after attribution):`);
for (const [id, c] of [...byTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(id).padEnd(10)} ${usd(c)}  ${pct(c)}`);
}
console.log('');
