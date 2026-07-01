// routes/project.mjs — per-project task/worktree/graph views over core/.

import * as core from '../../core/index.mjs';
import { json } from '../http.mjs';

export async function handle(path, u, proj, res) {
  if (path === '/api/tasks') {
    const { tasks } = await core.loadProjectAsync(proj.path);
    return json(res, 200, { slug: proj.slug, label: proj.label, tasks: core.annotateWorktree(core.tasksToData(tasks), proj) });
  }
  if (path === '/api/worktrees') {
    const worktrees = await core.worktreesForProject(proj);
    return json(res, 200, { slug: proj.slug, label: proj.label, worktrees });
  }
  if (path === '/api/graph') {
    const g = await core.gitDagWithWorktrees(proj);
    return json(res, 200, { slug: proj.slug, label: proj.label, ...g });
  }
  return false;
}
