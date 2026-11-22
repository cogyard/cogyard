// cogyard API — entry point + router. Serves the built SPA and a READ-ONLY
// /api/* surface over the in-repo data layer (core/index.mjs).
//
// Layout: http.mjs (transport + guards + the write seam) · git.mjs (portal git
// views) · routes/{meta,project,git,files,usage,actions,projects}.mjs (endpoint
// groups). Read-mostly: the only writes are routes/usage.mjs (POST
// /api/usage/collect), routes/actions.mjs (working-tree discard + open),
// routes/projects.mjs (POST /api/projects/{init,onboard}),
// routes/addons.mjs (safe-tier add-on actions), routes/jobs.mjs (POST
// /api/jobs/:id/run), and
// routes/files.mjs (POST /api/file save) — all through the http.mjs
// origin/containment seam.
//
// It also owns the scheduled-job tick (task 118): the always-on portal is the
// only process reliably up at 05:00, so the timer lives here rather than in a
// second LaunchAgent.
//
// Prod: PORT=7437 behind the com.cogyard.serve LaunchAgent (Caddy maps
// http://cogyard → :7437). Dev: PORT=7440 with the Angular proxy in front.

import { createServer } from 'node:http';
import pino from 'pino';
import * as core from '../core/index.mjs';
import { json, errJson, serveStatic } from './http.mjs';
import * as meta from './routes/meta.mjs';
import * as project from './routes/project.mjs';
import * as git from './routes/git.mjs';
import * as files from './routes/files.mjs';
import * as usage from './routes/usage.mjs';
import * as activity from './routes/activity.mjs';
import * as actions from './routes/actions.mjs';
import * as projectActions from './routes/projects.mjs';
import * as config from './routes/config.mjs';
import * as addons from './routes/addons.mjs';
import * as jobs from './routes/jobs.mjs';
import * as axes from './routes/axes.mjs';
import * as switches from './routes/switches.mjs';
import * as reclaim from './routes/reclaim.mjs';
import * as cleanup from './routes/cleanup.mjs';
import * as storage from './routes/storage.mjs';

const PORT = Number(process.env.PORT) || 7440;
const log = pino();

// Every git this process (and its children) runs is a READ for a view, so it
// must never take git's optional locks: a plain `git status` otherwise rewrites
// .git/index whenever it refreshes file stat info, which (a) races a commit the
// user is making in a terminal and (b) moves the index mtime that
// /api/versions reads, so a poll would invalidate its own fingerprint (task
// 173; measured in docs/LIVE-UPDATES.md). Set once here so every spawn site —
// core/exec.mjs, server/git.mjs, server/files.mjs, core/unmerged.mjs — inherits it.
process.env.GIT_OPTIONAL_LOCKS = '0';

// The credential store (task 127), loaded BEFORE anything can spawn a child.
// Scheduled jobs shell out to an agent CLI that authenticates from its process
// environment, and the child inherits ours — so `$COGYARD_HOME/secrets.env`
// becomes real here, in the one process that both dev (`npm run api`) and the
// LaunchAgent (`bin/serve`) start, rather than in a hand-edited plist.
//
// Only NAMES are logged, never values. A missing file is the normal case and
// says nothing; a refusal (a file other users can read) is a warning carrying
// its own chmod fix, and the portal still boots — refusing to start over a file
// permission would be a worse failure than the one being reported.
const secrets = core.loadSecrets();
if (!secrets.ok) log.warn({ path: secrets.path, fix: secrets.fix }, secrets.error);
else if (secrets.loaded.length || secrets.skipped.length) {
  log.info({ loaded: secrets.loaded, alreadySet: secrets.skipped }, 'credential store loaded');
}
if (secrets.badLines.length) log.warn({ path: secrets.path, lines: secrets.badLines }, 'credential store: unparseable line(s) ignored');

const server = createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    log.info({ method: req.method, path: req.url?.split('?')[0], status: res.statusCode, ms: Date.now() - started });
  });
  try {
    const u = new URL(req.url, 'http://localhost');
    const path = u.pathname;

    // Anything not under /api is the SPA (static asset or client route).
    if (!path.startsWith('/api')) return serveStatic(res, path);

    // Read-mostly API. Writes go ONLY through the http.mjs seam (requireSameOrigin
    // + readBody): POST /api/usage/collect (the refresh button), the
    // working-tree actions, POST /api/projects/{init,onboard} (the New/Adopt
    // button), POST /api/{config,open-targets} (the settings view),
    // POST /api/addons/:id/:action (safe-tier add-on actions only) and
    // POST /api/addons/:id/config (task 127 — the owner's saved add-on
    // settings, declared keys only; never a credential — those live in
    // ~/.cogyard/secrets.env, not in world-readable config.json),
    // POST /api/axes (the settings axis manager — task 096),
    // POST /api/switches (a project's switches — task 246), and
    // POST /api/file (the Files-tab save), and POST /api/cleanup/worktree
    // (task 117 — removes one worktree, behind a typed-name gate the SERVER
    // enforces; a client-only confirmation would be decoration).
    // Everything else non-GET is rejected outright.
    if (req.method === 'POST') {
      if (await usage.handlePost(path, req, res) !== false) return;
      if (await actions.handlePost(path, req, res, core.discoverProjects()) !== false) return;
      if (await projectActions.handlePost(path, req, res) !== false) return;
      if (await config.handlePost(path, req, res) !== false) return;
      if (await addons.handlePost(path, req, res) !== false) return;
      if (await jobs.handlePost(path, req, res) !== false) return;
      if (await axes.handlePost(path, req, res) !== false) return;
      if (await switches.handlePost(path, req, res) !== false) return;
      if (await files.handlePost(path, req, res, core.discoverProjects()) !== false) return;
      if (await cleanup.handlePost(path, req, res) !== false) return;
      return errJson(res, 405, 'method not allowed');
    }
    if (req.method !== 'GET') return errJson(res, 405, 'method not allowed (read-only API)');

    const projects = core.discoverProjects();
    if (await meta.handle(path, u, projects, res) !== false) return;
    if (await usage.handle(path, u, projects, res) !== false) return;
    if (await activity.handle(path, u, projects, res) !== false) return;
    if (await config.handle(path, u, projects, res) !== false) return;
    if (await addons.handle(path, u, projects, res) !== false) return;
    if (await jobs.handle(path, u, projects, res) !== false) return;
    if (await axes.handle(path, u, projects, res) !== false) return;
    if (await switches.handle(path, u, projects, res) !== false) return;
    if (await reclaim.handle(path, u, projects, res) !== false) return;
    if (await cleanup.handle(path, u, projects, res) !== false) return;
    if (await storage.handle(path, u, projects, res) !== false) return;
    // Raw worktree files (task 262) — the project comes from the path, not ?p=.
    if (await files.handleRaw(path, u, req, projects, res) !== false) return;

    // Per-project endpoints below need a resolved project.
    const slug = u.searchParams.get('p');
    const proj = slug ? projects.find((p) => p.slug === slug) : projects[0];
    if (!proj) return errJson(res, 404, 'unknown project: ' + slug);

    if (await project.handle(path, u, proj, res) !== false) return;
    if (await git.handle(path, u, proj, res) !== false) return;
    if (await files.handle(path, u, proj, res) !== false) return;

    errJson(res, 404, 'not found: ' + path);
  } catch (e) {
    log.error({ err: e, path: req.url }, 'request failed');
    errJson(res, 500, String((e && e.message) || e));
  }
});

// Ship the default Surface label axis (task 096): idempotent, never clobbers an
// existing $COGYARD_HOME/axes.json, so a fresh install gets grouping out of the
// box while a customized map is left untouched. Best-effort — a write failure
// just means resolveAxes degrades to flat, which is a safe state.
core.seedSharedAxes();

server.listen(PORT, () => log.info({ port: PORT }, 'cogyard API listening'));

// Keep the model price table current (task 113). A hand-maintained table means
// every new model prices at null and its work silently reads as $0 until a human
// notices — so the always-on portal pulls live rates on boot and every 24h, and
// reprices the rows that were left unpriced when the table changes. Fail-closed
// in core: any fetch/parse failure keeps the last known-good table. Never awaited
// and never on a request path; a rejected promise here must not take the API down.
const PRICING_SYNC_MS = Number(process.env.COGYARD_PRICING_SYNC_MS || 24 * 60 * 60 * 1000);
function syncPricingNow(trigger) {
  core.refreshPricing().then((r) => {
    if (!r.sync.ok) return log.warn({ trigger, reason: r.sync.reason }, 'pricing sync failed — keeping current table');
    if (!r.sync.changed) return log.info({ trigger, models: r.sync.models }, 'pricing sync: no change');
    log.info({
      trigger, version: r.sync.version, added: r.sync.added, rateChanges: r.sync.rateChanges,
      repriced: r.reprice && r.reprice.repriced, stillUnpriced: r.reprice && r.reprice.stillUnpriced,
    }, 'pricing table updated');
  }).catch((err) => log.warn({ trigger, err: err.message }, 'pricing sync threw'));
}
syncPricingNow('boot');
setInterval(() => syncPricingNow('interval'), PRICING_SYNC_MS).unref();

// Scheduled add-on jobs (task 118). The always-on portal is the only process
// that is reliably up at 05:00, so it owns the timer — no second LaunchAgent, no
// cron, nothing platform-specific in core (docs/DEPLOY.md argues process
// management stays out of the published tree, and this satisfies it).
//
// The tick is a POLL, not a per-job timer: it asks core which jobs are due and
// runs those. That is what makes catch-up work — a laptop asleep at 05:00 wakes,
// ticks, and sees the missed slot. Timers fired while suspended do not.
//
// Same posture as the pricing sync above: never awaited, never on a request
// path, and every failure is contained. core.runScheduledJob() does not throw —
// it records the failure on the job so it is visible in Settings in the morning.
const JOBS_TICK_MS = Number(process.env.COGYARD_JOBS_TICK_MS || 5 * 60 * 1000);
async function tickJobs(trigger) {
  try {
    const due = await core.dueJobs({ disabled: core.disabledSet() });
    for (const job of due) {
      log.info({ trigger, job: job.id, schedule: job.schedule.at }, 'scheduled job due');
      const r = await core.runScheduledJob(job.id, {
        projects: core.discoverProjects(),
        agent: core.adapter.agent,
        disabled: core.disabledSet(),
        trigger: 'schedule',
        // The owner's saved settings (task 127). Until add-on config was
        // persisted this passed nothing, so every nightly run saw `{}` and a
        // threshold changed in Settings had no effect on the one execution
        // path nobody is watching.
        cfg: await core.addonConfig(job.id),
      });
      if (r.ok) log.info({ job: r.id, ms: r.durationMs, cost: r.cost }, r.summary || 'scheduled job done');
      else log.warn({ job: r.id, outcome: r.outcome, err: r.error }, 'scheduled job failed');
    }
  } catch (err) {
    // Only a bug in the discovery path can land here; a job's own failure is
    // already data by this point. Log and keep the portal serving.
    log.warn({ trigger, err: err.message }, 'job tick threw');
  }
}
// No boot tick: a server restart must not fire every job. The first tick lands
// one interval in, by which point the seed/last-run state decides what is due.
setInterval(() => { tickJobs('interval'); }, JOBS_TICK_MS).unref();

// Orphan guard. scripts/dev.sh sets COGYARD_DEV_GUARD when it
// backgrounds this backend. If the launching shell dies (terminal closed,
// kill -9, the Claude_Preview MCP reaping it), the trap in dev.sh never fires
// and this process is reparented to launchd (ppid 1) — that's how dev backends
// pile up as orphans. Self-exit when orphaned. Prod runs under the LaunchAgent
// (ppid 1 by design) and never sets the flag, so it is unaffected.
if (process.env.COGYARD_DEV_GUARD) {
  setInterval(() => {
    if (process.ppid === 1) {
      log.info('dev launcher gone (orphaned) — exiting to avoid a stray backend');
      process.exit(0);
    }
  }, 3000).unref();
}

// Usage-ledger sweep: harvest any transcript content the SessionEnd
// hook missed (crashed sessions) before Claude Code retention prunes it.
// Idempotent and off the request path; a failure only logs.
setTimeout(() => {
  try {
    const result = core.collectUsage();
    log.info(result, 'usage sweep complete');
  } catch (e) {
    log.warn({ err: e }, 'usage sweep failed');
  }
}, 3000);
