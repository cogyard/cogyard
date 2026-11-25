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
// Built-in kinds (single | fullstack | static | library | research | apple | firmware) ship in core
// (./builtins.mjs); the registry only allows ADDITIONS: a community kind is a
// drop-in module at ~/.cogyard/scaffolds/<kind>/scaffold.mjs (same discovery
// idiom as add-ons / drivers) exporting a `scaffold` descriptor:
//
//   export const scaffold = {
//     kind: 'my-kind',                 // MUST equal the folder name; can't shadow a built-in
//     description: 'one line the New/Add drawer + /settings show',
//     worktreePorts: true,             // default opt-in to worktree port wiring
//     devScript: 'npm run dev',        // the dev command .cogyard/worktree.json names;
//                                      //   omitted = 'npm run dev', null = no dev server
//     launchName: 'dev',               // that command's `launch_name`; omitted = 'dev'
//     previewPortVar: 'FRONTEND_PORT', // the port variable its preview tab opens on —
//                                      //   'PORT' (backend) or 'FRONTEND_PORT' (frontend);
//                                      //   omitted = 'FRONTEND_PORT'
//     extraDevScripts: [               // optional: further commands that bind a port,
//       { devScript: 'npm run site',   //   each with its own launch entry — written as
//         launchName: 'site',          //   `extra_dev_scripts` (task 164). launchName is
//         previewPortVar: 'PORT' },    //   required and unique; previewPortVar as above.
//     ],                               //   Needs a devScript: that one comes first.
//     versionStamp: true,              // true = seed scripts/generate-version.mjs (→ version.json);
//                                      //   false = no stamper; or a function
//                                      //   (slug, { version }) => ({ relPath: content }) — the
//                                      //   kind's own stamping files, seeded INSTEAD of the npm
//                                      //   one; `version` is the package.json version on disk
//                                      //   (undefined when it has none)
//     markers: ['*.xcodeproj'],        // optional: file/folder names (or `*.ext`) that mark
//                                      //   a project as this kind's — onboard names the
//                                      //   kind when it finds one (see platformWarnings)
//     gitignore: ['Build.xcconfig'],   // optional: .gitignore lines the kind's files need,
//                                      //   appended with the essentials (a generated file)
//     requiredScripts: ['build'],      // optional: package.json scripts the kind's files rely
//                                      //   on. An existing package.json is never edited, so
//                                      //   onboard warns for each one it lacks (or has
//                                      //   differently), giving the line from pkgJson(slug)
//     pkgJson(slug) { return { name: slug, version: '0.1.0', ... }; },  // object, not string;
//                                      //   or `pkgJson: null` = this kind writes NO package.json
//     skeletonFiles(slug) { return { 'README.md': '...', ... }; },      // {relPath: content}
//     describeProject(root) {          // optional, at init AND onboard (task 164): what the
//       return { files: {}, warnings: [] };  // kind records about the project it finds —
//     },                               //   files written create-if-absent, and warnings
//                                      //   for what it could not tell. Reads files only;
//                                      //   it never runs the project's tools.
//   };
//
// `pkgJson: null` (task 274) is the one way to say "no package.json": the field
// is present and null, so the choice is visible as data and checked here without
// running anything. Leaving `pkgJson` out is still a broken descriptor — an
// omission is far likelier a mistake than a decision. A kind with no
// package.json gets no version (the `version` switch defaults to off when the
// repo root has none, core/switches.mjs) and nothing for a merge to build.
//
// `worktreePorts` and `devScript` are independent on purpose: an iOS app with a
// Node server wants ports AND a dev command; an Xcode-only app may want ports
// for a helper tool but has no dev server (`devScript: null`). A platform is not
// a reason to drop either.
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

// The two port variables every worktree config declares (core/scaffold.mjs
// worktreeConfig): a preview can open on either side of the worktree's pair.
const PREVIEW_PORT_VARS = ['PORT', 'FRONTEND_PORT'];
// A launch name becomes part of a launch entry's name (`wt-<worktree>-<name>`).
const LAUNCH_NAME = /^[A-Za-z0-9._-]+$/;
const isLaunchName = (v) => typeof v === 'string' && LAUNCH_NAME.test(v);
const isPreviewPortVar = (v) => PREVIEW_PORT_VARS.includes(v);

// `extraDevScripts`: a list of commands, each with a launch name no other
// command of the kind uses, after a devScript that comes first.
function validExtraDevScripts(s) {
  const list = s.extraDevScripts;
  if (!Array.isArray(list) || s.devScript === null) return false;
  const seen = new Set([s.launchName ?? 'dev']);
  for (const x of list) {
    if (!x || typeof x.devScript !== 'string' || !x.devScript.trim()) return false;
    if (!isLaunchName(x.launchName) || seen.has(x.launchName)) return false;
    if (x.previewPortVar !== undefined && !isPreviewPortVar(x.previewPortVar)) return false;
    seen.add(x.launchName);
  }
  return true;
}

function listExternalKinds() {
  try {
    return readdirSync(SCAFFOLDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(SCAFFOLDS_DIR, d.name, ENTRY)))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

// A list of non-empty strings — the shape of `markers`, `gitignore`, `requiredScripts`.
function names(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x);
}

async function resolveScaffolds() {
  const byKind = new Map(BUILTIN_SCAFFOLDS.map((s) => [s.kind, { ...s, builtin: true }]));
  for (const kind of listExternalKinds()) {
    if (byKind.has(kind)) continue; // additions only — a drop-in can't shadow a built-in
    try {
      const mod = await import(join(SCAFFOLDS_DIR, kind, ENTRY));
      const s = mod.scaffold ?? mod.default;
      if (!s || typeof s !== 'object' || s.kind !== kind) continue;
      if ((s.pkgJson !== null && typeof s.pkgJson !== 'function') || typeof s.skeletonFiles !== 'function') continue;
      if (s.devScript !== undefined && s.devScript !== null && typeof s.devScript !== 'string') continue;
      if (s.launchName !== undefined && !isLaunchName(s.launchName)) continue;
      if (s.previewPortVar !== undefined && !isPreviewPortVar(s.previewPortVar)) continue;
      if (s.extraDevScripts !== undefined && !validExtraDevScripts(s)) continue;
      if (s.describeProject !== undefined && typeof s.describeProject !== 'function') continue;
      if (s.versionStamp !== undefined && !['boolean', 'function'].includes(typeof s.versionStamp)) continue;
      if (s.markers !== undefined && !names(s.markers)) continue;
      if (s.gitignore !== undefined && !names(s.gitignore)) continue;
      if (s.requiredScripts !== undefined && !names(s.requiredScripts)) continue;
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

// --- What is onboard adopting? (task 162) -------------------------------------
// Every built-in kind assumes an npm web app: it names `npm run dev` and seeds
// the npm stamper. A folder holding an Xcode project or PlatformIO firmware is
// strong evidence those defaults are wrong, so onboard says so — it warns and
// carries on with the kind it was given; it never refuses or picks for you.
//
// Core keeps its own short list so it can warn before any kind for that
// platform is installed; a kind's `markers` add to it and are how a better kind
// gets named. These are project facts, not agent ones, so they belong here.
const NON_NPM_MARKERS = [
  { pattern: '*.xcodeproj', label: 'an Xcode project' },
  { pattern: '*.xcworkspace', label: 'an Xcode workspace' },
  { pattern: 'Package.swift', label: 'a Swift package' },
  { pattern: 'platformio.ini', label: 'a PlatformIO firmware project' },
];

function matches(name, pattern) {
  return pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern;
}

function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// The marked paths in `dir`, looked for at the root and one folder down — an
// iOS app beside a server commonly keeps its Xcode project in `ios/`. Hidden
// folders and node_modules are not looked into.
function findMarkers(dir, patterns) {
  const found = [];
  const check = (name, rel) => {
    const pattern = patterns.find((p) => matches(name, p));
    if (pattern) found.push({ path: rel, pattern });
    return !!pattern;
  };
  for (const e of entries(dir)) {
    if (check(e.name, e.name)) continue;
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    for (const c of entries(join(dir, e.name))) check(c.name, `${e.name}/${c.name}`);
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// One warning per marked path the chosen kind does not claim, naming the kinds
// that do — or saying none is installed. Empty when nothing is out of place.
// `seeded` lists what this run wrote that may not fit (the caller knows, e.g.
// --no-wiring); onboard is additive-only, so re-running it with a better kind
// will not replace those files — the warning says to remove them first.
function platformWarnings(dir, kind, { seeded = [] } = {}) {
  const chosen = scaffoldFor(kind);
  const label = new Map(NON_NPM_MARKERS.map((m) => [m.pattern, m.label]));
  const patterns = [...new Set([...label.keys(), ...KINDS.flatMap((k) => SCAFFOLDS.get(k).markers || [])])];
  const claimedBy = (pattern) => KINDS.filter((k) => (SCAFFOLDS.get(k).markers || []).includes(pattern));
  const check = seeded.length ? ` Check what kind "${kind}" seeded — ${seeded.join(' and ')} — which may not fit.` : '';
  const out = [];
  for (const { path, pattern } of findMarkers(dir, patterns)) {
    if ((chosen.markers || []).includes(pattern)) continue;
    const what = label.get(pattern) || `a ${pattern} file`;
    const better = claimedBy(pattern);
    out.push(`found ${path} (${what}), but kind "${kind}" assumes an npm web app.${check}`
      + (better.length
        ? ` A better kind is installed: ${better.join(', ')} — remove those files and re-run onboard with --kind ${better[0]}.`
        : ' No installed kind handles it yet.'));
  }
  return out;
}

export { SCAFFOLDS_DIR, KINDS, scaffoldFor, scaffoldKinds, platformWarnings };
