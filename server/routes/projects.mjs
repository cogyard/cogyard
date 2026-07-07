// routes/projects.mjs — project creation/adoption writes.
//
// The portal's "New / Adopt" sidebar button POSTs here. These are the SECOND set
// of writes on the otherwise read-mostly /api surface (after the
// usage/collect), and they go through the SAME documented seam: requireSameOrigin
// + readBody from http.mjs. No new write path. Both endpoints call the ONE shared
// core function (core.ensureProjectWiring) — identical behaviour to the CLI.
//
// This is a LOCAL tool (same-origin, localhost-only by design — see
// requireSameOrigin), so creating a git repo + writing files on disk matches the
// tool's existing threat model (it already shells git and reads transcripts).
// ensureProjectWiring is additive-only; onboard never clobbers an existing file.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as core from '../../core/index.mjs';
import { json, errJson, requireSameOrigin, readBody } from '../http.mjs';

export async function handlePost(path, req, res) {
  const mode = path === '/api/projects/init' ? 'init'
    : path === '/api/projects/onboard' ? 'onboard'
    : null;
  if (!mode) return false;

  const originErr = requireSameOrigin(req);
  if (originErr) return errJson(res, 403, originErr);

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return errJson(res, 400, 'invalid JSON body'); }

  const { path: p, kind, remote, wiring } = body;
  if (!p || typeof p !== 'string') return errJson(res, 400, 'path is required');
  if (!core.KINDS.includes(kind)) return errJson(res, 400, `kind must be one of: ${core.KINDS.join(', ')}`);

  try {
    let target = resolve(p);
    if (mode === 'init') {
      target = core.prepareInitDir(p).target;
    } else if (!existsSync(target)) {
      return errJson(res, 400, `path does not exist: ${target}`);
    }
    const result = core.ensureProjectWiring({
      path: target, kind,
      remote: typeof remote === 'string' ? remote : undefined,
      wiring: wiring === false ? false : undefined,
      scaffold: mode === 'init',
    });
    return json(res, 200, {
      ok: true,
      slug: result.slug,
      repoRoot: result.repoRoot,
      store: result.storePath,
      kind: result.kind,
      steps: result.steps,
      warnings: result.warnings,
    });
  } catch (e) {
    return errJson(res, 400, String((e && e.message) || e));
  }
}
