// cogyard.mjs — reaching cogyard's own data layer from an add-on.
//
// An add-on lives OUTSIDE the repo (~/.cogyard/addons/<id>/), so it cannot
// `import '../../core/index.mjs'` the way in-tree code does. Two resolution
// paths, in order:
//   1. RELATIVE — running from its source home (extras/addons/doc-drift/ inside
//      a cogyard checkout, which is what a symlink install gives you, because
//      Node resolves symlinks before computing import.meta.url). Development and
//      the sandbox both land here, and both get the core of the checkout being
//      worked on rather than whatever the registry happens to point at.
//   2. REGISTRY — a copy install has no relative core above it, so read
//      $COGYARD_HOME/projects.json and find the checkout by slug.
//
// Resolution failure is DATA, not an exception: the job reports "cannot reach
// cogyard's engine" as a run failure like any other, visible on the job's row.
//
// Deliberately a per-add-on copy of the same 60 lines the project-brief add-on
// carries. Add-ons are installed independently — one may be symlinked while the
// other is a copy, and neither may depend on the other being present — so a
// shared helper between two separately-installed folders would be a bug, not
// reuse. Keep the two in step by hand if the resolution rules ever change.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = process.env.COGYARD_HOME || join(homedir(), '.cogyard');

// The slug the cogyard checkout is registered under. Overridable because a
// registry is the user's, not ours — someone may have registered it as
// 'cogyard-main' or similar.
const SELF_SLUG = process.env.COGYARD_SELF_SLUG || 'cogyard';

function relativeCore() {
  // extras/addons/doc-drift/cogyard.mjs → <repo>/core/index.mjs
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidate = join(here, '..', '..', '..', 'core', 'index.mjs');
  return existsSync(candidate) ? candidate : null;
}

function registryCore() {
  try {
    const rows = JSON.parse(readFileSync(join(HOME, 'projects.json'), 'utf8'));
    const row = (Array.isArray(rows) ? rows : []).find((p) => p.slug === SELF_SLUG);
    const candidate = row && join(row.path, 'core', 'index.mjs');
    return candidate && existsSync(candidate) ? candidate : null;
  } catch { return null; }
}

let cached = null;

// The engine, imported once per process. Throws with an actionable message when
// no checkout can be found — callers turn that into a failed run.
async function cogyardCore() {
  if (cached) return cached;
  const path = relativeCore() || registryCore();
  if (!path) {
    throw new Error(
      `cannot locate the cogyard engine — no core/index.mjs above this add-on and `
      + `no '${SELF_SLUG}' project in ${join(HOME, 'projects.json')}`,
    );
  }
  cached = await import(pathToFileURL(path).href);
  return cached;
}

export { HOME, SELF_SLUG, cogyardCore };
