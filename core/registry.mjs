// core/registry.mjs — the project registry (projects.json): read/write,
// register/unregister, and discovery (with multi-clone "planet" collapse and
// broken-symlink surfacing).

import { readFileSync, writeFileSync, existsSync, realpathSync, lstatSync, readlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { HOME, PROJECTS_ROOT, REGISTRY_PATH } from './paths.mjs';

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const arr = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeRegistry(projects) {
  projects.sort((a, b) => a.label.localeCompare(b.label));
  // Ensure $COGYARD_HOME exists — `cogyard init`/`onboard` may be the first thing
  // run on a fresh setup, before anything has created the config dir (task 046).
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(projects, null, 2) + '\n');
}
function makeProjectEntry(repoRoot) {
  // Label = repo path relative to PROJECTS_ROOT (the conventional clone parent)
  // when it lives there, else relative to HOME, else the absolute path. Repos
  // outside the convention just get a longer label.
  const label = repoRoot.startsWith(PROJECTS_ROOT + '/') ? relative(PROJECTS_ROOT, repoRoot)
    : repoRoot.startsWith(HOME + '/') ? relative(HOME, repoRoot)
    : repoRoot;
  const slug = label.replace(/[^a-zA-Z0-9_-]/g, '__');
  return { slug, path: repoRoot, label };
}
function registerProject(repoRoot) {
  const projects = readRegistry();
  const exists = projects.find((p) => p.path === repoRoot);
  if (exists) return exists;
  const entry = makeProjectEntry(repoRoot);
  projects.push(entry);
  writeRegistry(projects);
  return entry;
}
function unregisterProject(slugOrPath) {
  const projects = readRegistry();
  const filtered = projects.filter((p) => p.slug !== slugOrPath && p.path !== slugOrPath);
  writeRegistry(filtered);
  return projects.length - filtered.length;
}
function discoverProjects() {
  // Read the registry, filter to entries whose `_tasks/` exists, then collapse
  // multi-clone projects (e.g. clones a/b/c) that share the same canonical
  // _tasks dir into a single dashboard entry. The collapsed entry's label is the
  // parent dir of the canonical _tasks (e.g. the clones' parent dir), and its `path`
  // points at any one of the clones (the first registered) so loadProject still
  // works.
  const live = [];
  const broken = [];
  for (const p of readRegistry()) {
    const td = join(p.path, '_tasks');
    if (existsSync(td)) { live.push(p); continue; }
    // A BROKEN _tasks symlink is a project with a problem, not a non-project:
    // surface it as an error row instead of silently dropping it (task 15).
    let l = null;
    try { l = lstatSync(td); } catch {}
    if (l && l.isSymbolicLink()) {
      let target = '';
      try { target = readlinkSync(td); } catch {}
      broken.push({ slug: p.slug, path: p.path, label: p.label, error: `broken _tasks symlink → ${target}` });
    }
    // No _tasks at all → dropped, as before.
  }
  const groups = new Map();
  for (const p of live) {
    let canonical;
    try { canonical = realpathSync(join(p.path, '_tasks')); }
    catch { canonical = join(p.path, '_tasks'); }
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push(p);
  }
  const out = [];
  for (const [canonical, entries] of groups) {
    if (entries.length === 1) { out.push(entries[0]); continue; }
    // Multi-clone collapse. Label = the canonical _tasks parent, relative to
    // PROJECTS_ROOT (then HOME) when applicable, else absolute.
    const parent = dirname(canonical);
    const label = parent.startsWith(PROJECTS_ROOT + '/') ? relative(PROJECTS_ROOT, parent) : parent.startsWith(HOME + '/') ? relative(HOME, parent) : parent;
    out.push({
      slug: label.replace(/[^a-zA-Z0-9_-]/g, '__'),
      path: entries[0].path,
      label,
      clones: entries.map((e) => e.path),
    });
  }
  out.push(...broken);
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
function findProject(slug) { return discoverProjects().find((p) => p.slug === slug) || null; }

export { readRegistry, writeRegistry, makeProjectEntry, registerProject, unregisterProject, discoverProjects, findProject };
