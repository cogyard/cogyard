// routes/jobs.mjs — the scheduled-jobs surface (task 118).
//
// GET  /api/jobs            every installed scheduled job: schedule, last run +
//                           outcome, next run, rolling cost, run log
// POST /api/jobs/:id/run    run one NOW, out of band ("Run now"). Same job, same
//                           bounds, same single-flight guard as the nightly
//                           tick — only the trigger differs.
//
// Scheduled jobs are add-ons that declared a `schedule`, so this is
// MACHINE-LEVEL like /api/addons: no project parameter anywhere. The job itself
// receives the whole registry in ctx.projects.
//
// Thin adapter — all contract/state/runner logic lives in core/addons/jobs.mjs.
// The POST goes through the SAME requireSameOrigin + readBody seam as every
// other write; no new write path.

import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin, readBody } from '../http.mjs';

export async function handle(path, u, projects, res) {
  if (path === '/api/jobs') {
    // `enabled` is the capability switch (an add-on that PROVIDES scheduled-jobs
    // and is on). The section renders only when it is true — jobs are opt-in.
    return json(res, 200, {
      enabled: await core.providesEnabled('scheduled-jobs'),
      jobs: await core.listScheduledJobs({ disabled: core.disabledSet() }),
    });
  }
  return false;
}

// POST /api/jobs/:id/run — run now. Body is ignored (a run takes no arguments)
// but is read and parsed so the same origin/body guard applies as everywhere else.
// POST /api/jobs/:id/schedule — set or clear the schedule override. Body is
// { every, at, weekday?, catchUp? }, or { schedule: null } to fall back to the
// manifest's declaration.
export async function handlePost(path, req, res) {
  const m = path.match(/^\/api\/jobs\/([\w.-]+)\/(run|schedule)$/);
  if (!m) return false;
  const [, id, verb] = m;

  const originErr = requireSameOrigin(req);
  if (originErr) return errJson(res, 403, originErr);

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return errJson(res, 400, 'invalid JSON body'); }

  if (verb === 'schedule') {
    try {
      // `schedule: null` clears; anything else is validated by core, which
      // refuses to store something it would have to reinterpret.
      const next = core.setScheduleOverride(id, body?.schedule === null ? null : body);
      return json(res, 200, { ok: true, id, schedule: next });
    } catch (e) {
      return errJson(res, 400, String((e && e.message) || e));
    }
  }

  // runScheduledJob never throws — a refusal (unknown id, switched off, already
  // running) comes back as a result with ok:false, which is 200 + a body the row
  // can render, not an HTTP error. The client shows the reason either way.
  return json(res, 200, await core.runScheduledJob(id, {
    projects: core.discoverProjects(),
    agent: core.adapter.agent,
    disabled: core.disabledSet(),
    trigger: 'manual',
    // Same saved config the nightly tick uses (task 127) — Run now has to be
    // the same run, or it stops being a way to test what will happen at 05:00.
    cfg: await core.addonConfig(id),
  }));
}
