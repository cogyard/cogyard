// core/scaffolds/index.mjs — the project-kind (scaffold) registry.
//
// A SCAFFOLD is a creation-time template a project `kind` selects at `init`:
// package.json shape + skeleton files + wiring defaults + a one-line human
// description. It is the THIRD extension axis, distinct from the other two:
//   * add-ons      — runtime capabilities (Settings cards)   core/addons/
//   * drivers      — agent drivers (which AI runs cogyard)   core/drivers.mjs
//   * scaffolds    — creation-time project templates          THIS registry
// A scaffold has no status/actions/prereqs and renders no card — do not force
// one through the add-on manifest.
//
// Built-in kinds (single | fullstack | static | library) ship in core
// (./builtins.mjs); the registry only allows ADDITIONS: a community kind is a
// drop-in module at ~/.cogyard/scaffolds/<kind>/scaffold.mjs (same discovery
// idiom as add-ons / drivers) exporting a `scaffold` descriptor:
//
//   export const scaffold = {
//     kind: 'my-kind',                 // MUST equal the folder name; can't shadow a built-in
//     description: 'one line the New/Add drawer + /settings show',
//     worktreePorts: true,             // default opt-in to worktree port wiring
//     versionStamp: true,              // seed scripts/generate-version.mjs
//     pkgJson(slug) { return { name: slug, version: '0.1.0', ... }; },  // object, not string
//     skeletonFiles(slug) { return { 'README.md': '...', ... }; },      // {relPath: content}
//   };
//
// Resolved once at import (top-level await, like core/drivers.mjs); a
// newly installed scaffold takes effect on the next process start. A broken
// external module is skipped — never crashes the engine, never blocks init.

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { COGYARD_HOME } from '../paths.mjs';
import { BUILTIN_SCAFFOLDS } from './builtins.mjs';

const SCAFFOLDS_DIR = join(COGYARD_HOME, 'scaffolds');
const ENTRY = 'scaffold.mjs';

function listExternalKinds() {
  try {
    return readdirSync(SCAFFOLDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(SCAFFOLDS_DIR, d.name, ENTRY)))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

async function resolveScaffolds() {
  const byKind = new Map(BUILTIN_SCAFFOLDS.map((s) => [s.kind, { ...s, builtin: true }]));
  for (const kind of listExternalKinds()) {
    if (byKind.has(kind)) continue; // additions only — a drop-in can't shadow a built-in
    try {
      const mod = await import(join(SCAFFOLDS_DIR, kind, ENTRY));
      const s = mod.scaffold ?? mod.default;
      if (!s || typeof s !== 'object' || s.kind !== kind) continue;
      if (typeof s.pkgJson !== 'function' || typeof s.skeletonFiles !== 'function') continue;
      byKind.set(kind, { ...s, builtin: false });
    } catch { /* broken drop-in → skip, keep the engine alive */ }
  }
  return byKind;
}

// Resolved once, at import (same posture as core/drivers.mjs).
const SCAFFOLDS = await resolveScaffolds();

// The kind list every consumer validates against (order: built-ins, then additions).
const KINDS = [...SCAFFOLDS.keys()];

function scaffoldFor(kind) {
  const s = SCAFFOLDS.get(kind);
  if (!s) throw new Error(`unknown kind: ${kind} (one of ${KINDS.join(', ')})`);
  return s;
}

// Wire-safe rows for /api/config — the UI's kind dropdown + descriptions.
function scaffoldKinds() {
  return KINDS.map((k) => {
    const s = SCAFFOLDS.get(k);
    return { kind: k, description: String(s.description || ''), builtin: !!s.builtin };
  });
}

export { SCAFFOLDS_DIR, KINDS, scaffoldFor, scaffoldKinds };
