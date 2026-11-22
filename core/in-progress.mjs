// core/in-progress.mjs — the All tab's per-project boxes (task 265): for every
// registered project, its tasks in progress and its last 10 closed tasks.
// GET /api/in-progress serves it.
//
// NO RULES OF ITS OWN. "In progress" is the Plan's `progress` group
// (core/plan.mjs planFor) and "closed" is the Recently done strip's list
// (core/recently-done.mjs), so a box on the All tab and the project's own Plan
// tab can never disagree. Which projects get a box, their order, and the
// Today / This week grouping are the portal's: they need the viewer's date and
// the week-start setting, as the Recently done strip's grouping does.
//
// KEPT PER PROJECT (core/memo.mjs). Computing every project's plan and closed
// list took about 1.7 s warm on 14 projects (2026-11-21), and the page refetches
// whenever any agent anywhere changes state. So each project's box is kept until
// its own store, its repo's refs, its store history, the registry or another
// project's store changes (core/versions.mjs inProgressBoxSignals), and the
// agent state — the one part that moves every few seconds — is read fresh on
// every call with the same function the Plan uses (liveForTask).
//
// A project whose plan can't be computed (no store, a git failure) comes back
// as { slug, label, error } rather than failing every other project's box; an
// error is never kept.

import { planFor } from './plan.mjs';
import { recentlyDone } from './recently-done.mjs';
import { loadTasks } from './frontmatter.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { normalizeTaskId } from './validate.mjs';
import { liveForTask, claimedByOther, cachedUser } from './live-state.mjs';
import { whoAmI } from './close.mjs';
import { memoize } from './memo.mjs';
import { inProgressBoxSignals } from './versions.mjs';

const RECENT_LIMIT = 10;

// What a box shows of a task in progress: its chip, flags, title, the agent's
// state, and the squares with their code text — the Plan card's own fields.
const PROGRESS_FIELDS = ['id', 'title', 'type', 'labels', 'status', 'done', 'total', 'boxes', 'code',
  'youNext', 'youLater', 'youSteps', 'worktreeMissing', 'claimedBy', 'claimedAt', 'claimedByOther', 'agent'];
const pick = (t) => Object.fromEntries(PROGRESS_FIELDS.map((k) => [k, t[k] ?? null]));

// The box as computed, plus each in-progress task's frontmatter (kept, never
// sent) so its agent state can be read again without recomputing the plan.
async function computeBox(proj, projects) {
  const [plan, recent] = await Promise.all([planFor(proj, projects), recentlyDone(proj, RECENT_LIMIT)]);
  const ids = plan.groups.progress;
  const fms = new Map();
  if (ids.length) {
    for (const t of loadTasks(tasksDirOf(proj.path))) {
      const id = normalizeTaskId(t.frontmatter?.id);
      if (ids.includes(id)) fms.set(id, t.frontmatter);
    }
  }
  return { progress: ids.map((id) => pick(plan.tasks[id])), recent, fms };
}

// The agent fields as planFor sets them (an in-progress task is always claimed).
function withLiveState(kept, user) {
  return kept.progress.map((t) => {
    const fm = kept.fms.get(t.id);
    return fm ? { ...t, agent: liveForTask(fm, { user }), claimedByOther: claimedByOther(fm, user) } : t;
  });
}

async function projectInProgress(proj, projects, signal = null) {
  if (proj.error) return { slug: proj.slug, label: proj.label, error: String(proj.error) };
  try {
    const kept = await memoize('in-progress', proj.slug, async () => signal, () => computeBox(proj, projects));
    return { slug: proj.slug, label: proj.label, progress: withLiveState(kept, cachedUser(whoAmI)), recent: kept.recent };
  } catch (e) {
    return { slug: proj.slug, label: proj.label, error: String(e?.message || e) };
  }
}

// projects = discoverProjects(). One row per project, in registry order.
async function inProgressAll(projects) {
  const signals = inProgressBoxSignals(projects);
  return Promise.all(projects.map((p) => projectInProgress(p, projects, signals.get(p.slug) ?? null)));
}

export { inProgressAll, projectInProgress, RECENT_LIMIT, PROGRESS_FIELDS };
