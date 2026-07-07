// core/paths.mjs — config-home resolution. $COGYARD_HOME (default ~/.cogyard/).
// Resolution is evaluated at import; writes go wherever reads resolved.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const COGYARD_HOME = process.env.COGYARD_HOME || join(HOME, '.cogyard');
const REGISTRY_PATH = join(COGYARD_HOME, 'projects.json');
const WORKTREE_PORTS_PATH = join(COGYARD_HOME, 'ports.json');

// PROJECTS_ROOT — the conventional parent directory that holds your project
// clones AND the per-project shared task stores (`<PROJECTS_ROOT>/_tasks/<slug>`).
// Used only as a default (convert's store location) and a label-shortener
// (registry display), never a required path — a repo outside it still works.
//
// Resolves env → config.json.projectsRoot → ~/gitroot, mirroring how
// `driver` resolves. The config.json read is a tiny inline JSON parse rather
// than an import of core/config.mjs, so paths.mjs stays dependency-light and free
// of the import cycle that would form (config.mjs imports paths.mjs). Resolved at
// import like the rest of this module: a config.json change takes effect on the
// next process start (for the portal, the LaunchAgent reload the deploy step runs).
function configuredProjectsRoot() {
  try {
    const cfg = JSON.parse(readFileSync(join(COGYARD_HOME, 'config.json'), 'utf8'));
    if (cfg && typeof cfg.projectsRoot === 'string' && cfg.projectsRoot.trim()) return cfg.projectsRoot.trim();
  } catch { /* no/invalid config → fall through to the default */ }
  return null;
}

// Resolved value + which layer produced it, for the /settings view to label the
// source (env override vs saved config vs built-in default).
function resolveProjectsRoot() {
  if (process.env.COGYARD_PROJECTS_ROOT) return { value: process.env.COGYARD_PROJECTS_ROOT, source: 'env' };
  const fromConfig = configuredProjectsRoot();
  if (fromConfig) return { value: fromConfig, source: 'config' };
  return { value: join(HOME, 'gitroot'), source: 'default' };
}

const PROJECTS_ROOT = resolveProjectsRoot().value;

export { HOME, COGYARD_HOME, PROJECTS_ROOT, REGISTRY_PATH, WORKTREE_PORTS_PATH, resolveProjectsRoot };
