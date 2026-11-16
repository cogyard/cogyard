// cli/plan.mjs — `cogyard tasks plan [--json] [--problems]` (task 179): the plan
// view as text. The calculation is core/plan.mjs; this file only renders it, so
// the CLI and the portal's Plan tab can never disagree.

import { findRepoRoot, discoverProjects, resolveProjectForPath, planFor } from '../core/index.mjs';

// The owner-step tag: the next unticked box is yours, or one further down is.
const you = (t) => (t.youNext ? `  [next: ${t.youNext.join(', ')}]` : t.youLater.length ? `  [later: ${t.youLater.join(', ')}]` : '');
const frees = (t) => (t.waitedOnBy.length ? `  frees ${t.waitedOnBy.join(', ')}` : '');
// What a task shares with a task IN PROGRESS — the only sharing that matters
// before starting it alongside (task 239). The full list, every open task it
// overlaps, is in --json's `clash`; printed here it could run to dozens.
const shares = (t, running) => {
  const hits = t.clash.filter((c) => running.has(c.id));
  return hits.length ? `  shares with in progress: ${hits.map((c) => `${c.id} (${[...c.files, ...c.resources].join(', ')})`).join('; ')}` : '';
};
const line = (t, running = new Set()) => `    ${String(t.id).padEnd(5)} ${t.name}${you(t)}${frees(t)}${t.blocksOther.length ? `  blocks ${t.blocksOther.map((b) => `${b.project} ${b.id}`).join(', ')}` : ''}${shares(t, running)}`;

export async function cmdPlan(flags = {}) {
  const repoRoot = findRepoRoot();
  if (!repoRoot) { process.stderr.write('Not in a git repository.\n'); process.exit(1); }
  const projects = discoverProjects();
  const slug = resolveProjectForPath(repoRoot);
  const plan = await planFor({ slug, path: repoRoot }, projects);

  if (flags.json) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return; }

  const T = plan.tasks, G = plan.groups;
  const running = new Set(G.progress);
  const out = [`Plan — ${slug}`];
  const flat = (title, ids) => { if (ids.length) out.push('', `${title} (${ids.length})`, ...ids.map((id) => line(T[id], running))); };
  const boxed = (title, boxes) => {
    const n = boxes.reduce((k, g) => k + g.tasks.length, 0);
    if (!n) return;
    out.push('', `${title} (${n})`);
    for (const g of boxes) out.push(`  waiting on ${g.after.join(', ')}`, ...g.tasks.map((id) => line(T[id], running)));
  };
  flat('In progress', G.progress);
  flat('Can start — nothing it depends on is unfinished', G.can);
  boxed('Waiting for a task to finish', G.dep);
  boxed('Waiting on another project', G.other);
  flat('Built — needs your look', G.look);
  if (plan.parked.length) {
    out.push('', `Parked (${plan.parked.length})`,
      ...plan.parked.map((id) => line(T[id]) + (T[id].unmet.length ? `  waiting on ${T[id].unmet.join(', ')}` : '')));
  }
  if (plan.problems.length) {
    if (flags.problems) { out.push('', 'Problems in the task data:'); for (const p of plan.problems) out.push(`  ${p.id}: ${p.text}`); }
    else out.push(`${plan.problems.length} problem(s) in the task data make this less accurate — add --problems to list them.`);
  }
  process.stdout.write(out.join('\n') + '\n');
}
