// core/registry.mjs — the project registry (projects.json): read/write,
// register/unregister, and discovery (with broken-symlink surfacing).

import { readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { HOME, PROJECTS_ROOT, REGISTRY_PATH } from './paths.mjs';
import { tasksDirOf, oldTasksDir, oldTasksDirProblem } from './tasks-dir.mjs';

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
  // run on a fresh setup, before anything has created the config dir.
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(projects, null, 2) + '\n');
}
function makeProjectEntry(repoRoot) {
  // Label = repo path relative to PROJECTS_ROOT (the conventional clone parent)
  // when it lives there, else relative to HOME, else the absolute path. Repos
  // outside the convention just get a longer label.
  const underRoot = repoRoot.startsWith(PROJECTS_ROOT + '/');
  const label = underRoot ? relative(PROJECTS_ROOT, repoRoot)
    : repoRoot.startsWith(HOME + '/') ? relative(HOME, repoRoot)
    : repoRoot;
  // Slug = identity + store-dir name, so it must be readable. Under the convention
  // it's the (usually one-segment) path relative to PROJECTS_ROOT; OUTSIDE it, use
  // the basename — never the full absolute path, which mangled into `__private__tmp__x`
  // for an init outside the projects root. Collisions (two projects sharing a
  // basename) are disambiguated at register time.
  const rawSlug = underRoot ? relative(PROJECTS_ROOT, repoRoot) : basename(repoRoot);
  const slug = rawSlug.replace(/[^a-zA-Z0-9_-]/g, '__');
  return { slug, path: repoRoot, label };
}
function registerProject(repoRoot) {
  const projects = readRegistry();
  const exists = projects.find((p) => p.path === repoRoot);
  if (exists) return exists;
  const entry = makeProjectEntry(repoRoot);
  // A slug is the store-dir key + portal identity — it must be unique. Two repos
  // with the same basename outside PROJECTS_ROOT would otherwise collide; suffix -2/-3.
  const taken = new Set(projects.map((p) => p.slug));
  if (taken.has(entry.slug)) {
    let n = 2;
    while (taken.has(`${entry.slug}-${n}`)) n++;
    entry.slug = `${entry.slug}-${n}`;
  }
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
  // Read the registry and keep entries whose task directory exists (core/tasks-dir.mjs) — one portal
  // project per registry entry. (Several checkouts sharing one store used to be
  // collapsed into one entry with `clones: [...]`; that served the multi-clone
  // "planet" layout, retired by task 136. Two entries sharing a store now show as
  // two projects, and the storage report flags the sharing.)
  const live = [];
  const broken = [];
  for (const p of readRegistry()) {
    const td = tasksDirOf(p.path);
    if (existsSync(td)) { live.push(p); continue; }
    // A BROKEN .cogyard/tasks link is a project with a problem, not a non-project:
    // surface it as an error row instead of silently dropping it.
    let l = null;
    try { l = lstatSync(td); } catch {}
    if (l && l.isSymbolicLink()) {
      let target = '';
      try { target = readlinkSync(td); } catch {}
      broken.push({ slug: p.slug, path: p.path, label: p.label, error: `broken task-store link ${td.slice(p.path.length + 1)} → ${target}` });
      continue;
    }
    // So is a project an older release set up, still on a top-level `_tasks`:
    // dropping it made `cogyard doctor` report "no projects registered".
    const old = oldTasksDir(p.path);
    if (old) broken.push({ slug: p.slug, path: p.path, label: p.label, error: oldTasksDirProblem(old) });
    // No task directory at all → dropped, as before.
  }
  const out = [...live, ...broken];
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
function findProject(slug) { return discoverProjects().find((p) => p.slug === slug) || null; }

// The slugs a project was registered under before its current one. A project
// that moved or merged checkouts keeps its old locations as `aliases` (paths),
// and each alias's slug is the one anything written back then is keyed by —
// ledger rows, and the nightly jobs' output (task 195).
function formerSlugs(entry) {
  const out = [];
  for (const path of entry?.aliases || []) {
    const old = makeProjectEntry(path).slug;
    if (old !== entry.slug && !out.includes(old)) out.push(old);
  }
  return out;
}

// Ledger slug → the project that owns it now. Usage, activity and claim rows
// carry the registry slug in force when they were written (formerSlugs above).
// Everything else passes through unchanged. Build once per read — it reads the
// registry.
function ledgerSlugResolver() {
  const map = new Map();
  for (const entry of readRegistry()) {
    for (const old of formerSlugs(entry)) if (!map.has(old)) map.set(old, entry.slug);
  }
  return (slug) => (slug != null && map.has(slug) ? map.get(slug) : slug);
}

export { readRegistry, writeRegistry, makeProjectEntry, registerProject, unregisterProject, discoverProjects, findProject, formerSlugs, ledgerSlugResolver };
