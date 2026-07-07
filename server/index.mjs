// cogyard API — entry point + router. Serves the built SPA and a READ-ONLY
// /api/* surface over the in-repo data layer (core/index.mjs).
//
// Layout: http.mjs (transport + guards + the write seam) · git.mjs (portal git
// views) · routes/{meta,project,git,files,usage,actions,projects}.mjs (endpoint
// groups). Read-mostly: the only writes are routes/usage.mjs (POST
// /api/usage/collect), routes/actions.mjs (working-tree discard + open),
// routes/projects.mjs (POST /api/projects/{init,onboard}),
// routes/addons.mjs (safe-tier add-on actions), and
// routes/files.mjs (POST /api/file save) — all through the http.mjs
// origin/containment seam.
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

const PORT = Number(process.env.PORT) || 7440;
const log = pino();

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
    // button), POST /api/{config,open-targets} (the settings view), and
    // POST /api/addons/:id/:action (safe-tier add-on actions only),
    // and POST /api/file (the Files-tab save). Everything else non-GET
    // is rejected outright.
    if (req.method === 'POST') {
      if (await usage.handlePost(path, req, res) !== false) return;
      if (await actions.handlePost(path, req, res, core.discoverProjects()) !== false) return;
      if (await projectActions.handlePost(path, req, res) !== false) return;
      if (await config.handlePost(path, req, res) !== false) return;
      if (await addons.handlePost(path, req, res) !== false) return;
      if (await files.handlePost(path, req, res, core.discoverProjects()) !== false) return;
      return errJson(res, 405, 'method not allowed');
    }
    if (req.method !== 'GET') return errJson(res, 405, 'method not allowed (read-only API)');

    const projects = core.discoverProjects();
    if (await meta.handle(path, u, projects, res) !== false) return;
    if (await usage.handle(path, u, projects, res) !== false) return;
    if (await activity.handle(path, u, projects, res) !== false) return;
    if (await config.handle(path, u, projects, res) !== false) return;
    if (await addons.handle(path, u, projects, res) !== false) return;

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

server.listen(PORT, () => log.info({ port: PORT }, 'cogyard API listening'));

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
