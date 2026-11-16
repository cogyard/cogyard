// core/axes.mjs — the label-axis registry (task 096). An "axis" is a named,
// colored bundle of sibling labels (Surface = {frontend, backend, …}). Labels
// themselves stay 100% free-form; the axis map is a thin, OPTIONAL grouping layer
// the portal renders on top of them. Two layers resolve into one per-project view:
//   · shared  — $COGYARD_HOME/axes.json    (universal axes, e.g. Surface)
//   · project — <task link>/axes.json   (that project's domain axes; lives in the task store, travels with the tasks)
// Project wins on conflict: a project axis of the same NAME replaces the shared
// one in its slot; new project axes append. A label in NO axis is "Ungrouped" —
// the portal shows those as the un-curated backlog. When neither file exists the
// resolver returns [] and the portal degrades to today's flat label list (there is
// deliberately NO hardcoded built-in axis, so deleting the map file yields flat).
//
// Agent-agnostic (the CLAUDE.md seam): no Claude-Code literals live here — the
// axis map is neutral config the engine owns, not a driver concern.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { tasksDirOf } from './tasks-dir.mjs';

// The one shipped default (task 096): a universal Surface axis. It is SEEDED as a
// real file at $COGYARD_HOME/axes.json (see seedSharedAxes) rather than baked in,
// so the "delete the file → flat list" contract holds. Kept here as the seed body
// and as the documented default shape.
export const DEFAULT_SHARED_AXES = [
  { name: 'Surface', color: '#4f8cff', labels: ['frontend', 'backend', 'db', 'cli', 'desktop', 'core'] },
];

// Neutral slate applied to an axis row that omits `color`.
const DEFAULT_AXIS_COLOR = '#8a8f98';

const sharedAxesPath = () => join(COGYARD_HOME, 'axes.json');
// The project axis map lives IN the project's task store, next to the task files
// it groups (<task link>/axes.json — .cogyard/tasks, or _tasks before task 160). For shared-store projects the link is a
// symlink, so this resolves into the canonical store — the map travels with the
// tasks, is shared across every checkout, and never lands in a project's code main.
const projectAxesPath = (projectPath) => join(tasksDirOf(projectPath), 'axes.json');

// Parse one axes.json → array of clean axis rows, or [] on ANY problem (missing
// file, bad JSON, wrong shape). Never throws: a hand-corrupted file degrades to
// "no axes from this layer", the same forgiving contract as core/config.mjs.
function readAxesFile(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return []; }
  const axes = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.axes : null;
  if (!Array.isArray(axes)) return [];
  return axes.map(cleanAxis).filter(Boolean);
}

// One axis row is valid iff it has a non-empty string name and a (possibly empty)
// array of string labels; `color` is optional (defaulted downstream). Unknown
// fields are dropped, dup labels collapsed. Returns null for an unusable row.
function cleanAxis(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!name) return null;
  const labels = Array.isArray(a.labels)
    ? [...new Set(a.labels.filter((l) => typeof l === 'string' && l))] : [];
  const color = typeof a.color === 'string' && a.color.trim() ? a.color.trim() : null;
  return { name, color, labels };
}

// Overlay `over` onto `base`: an `over` axis REPLACES a `base` axis of the same
// name in the base's slot (position preserved); `over` axes with no base match
// append after. Pure. Used once — project over shared — but factored out so the
// name-replace rule is stated in exactly one place.
function overlayAxes(base, over) {
  const overByName = new Map(over.map((a) => [a.name, a]));
  const used = new Set();
  const out = base.map((a) => {
    if (overByName.has(a.name)) { used.add(a.name); return overByName.get(a.name); }
    return a;
  });
  for (const a of over) if (!used.has(a.name)) out.push(a);
  return out;
}

// Resolve shared + project axis maps into one ordered list for a project. Pure
// except for the two file reads. Every returned axis carries a color (its own or
// the neutral default). Empty array when neither file exists → portal renders flat.
export function resolveAxes(projectPath) {
  const shared = readAxesFile(sharedAxesPath());
  const project = projectPath ? readAxesFile(projectAxesPath(projectPath)) : [];
  return overlayAxes(shared, project).map((a) => ({ ...a, color: a.color || DEFAULT_AXIS_COLOR }));
}

// label → { axis, color } for the first axis (in resolved order) that lists the
// label. First-wins keeps a label appearing in two axes deterministic. Labels in
// no axis are simply absent from the map — the portal treats those as Ungrouped.
// The portal can build this itself from the axes array; exported for core-side
// callers (write-task's Phase 3 registry check, tests).
export function axisLookup(resolved) {
  const map = {};
  for (const ax of resolved || []) {
    for (const l of ax.labels) if (!(l in map)) map[l] = { axis: ax.name, color: ax.color };
  }
  return map;
}

// The flat set of every label registered across the resolved axes — the curated
// vocabulary write-task checks before minting a new label (Phase 3).
export function registeredLabels(resolved) {
  const set = new Set();
  for (const ax of resolved || []) for (const l of ax.labels) set.add(l);
  return set;
}

// Write the shipped Surface default to $COGYARD_HOME/axes.json IF ABSENT. Idempotent
// seed (same idiom as registry/config first-write): never clobbers an existing file,
// so a customized shared map is safe. Returns the resolved shared list after seeding.
export function seedSharedAxes() {
  const path = sharedAxesPath();
  if (readAxesFile(path).length === 0) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ axes: DEFAULT_SHARED_AXES }, null, 2) + '\n');
    } catch { /* best-effort seed; resolveAxes still degrades to flat on failure */ }
  }
  return readAxesFile(path);
}

// === Per-layer raw reads + writes — the desktop/portal axis manager (Phase 4) ===
// The manager edits each LAYER separately (unlike resolveAxes, which merges them),
// so it needs the raw shared and raw project maps, not the resolved view.
export function readSharedAxes() { return readAxesFile(sharedAxesPath()); }
export function readProjectAxes(projectPath) {
  return projectPath ? readAxesFile(projectAxesPath(projectPath)) : [];
}

// Sanitize an axes list from an untrusted caller (the write endpoint) into clean
// rows via the same cleanAxis used on read: name required, labels a string array,
// color optional. Drops unusable rows — never throws on malformed input.
export function sanitizeAxes(list) {
  return Array.isArray(list) ? list.map(cleanAxis).filter(Boolean) : [];
}

// Serialize a sanitized axes list, omitting a null color (kept tidy — resolveAxes
// re-defaults an absent color to neutral on read).
function serializeAxes(axes) {
  const rows = axes.map((a) => (a.color ? { name: a.name, color: a.color, labels: a.labels }
    : { name: a.name, labels: a.labels }));
  return JSON.stringify({ axes: rows }, null, 2) + '\n';
}

// Persist the machine-global shared map ($COGYARD_HOME/axes.json). Returns the
// sanitized list that was written.
export function writeSharedAxes(list) {
  const axes = sanitizeAxes(list);
  const path = sharedAxesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeAxes(axes));
  return axes;
}

// Persist a project's committed map (<task link>/axes.json, in the task store).
// Commit it with `cogyard tasks sync push "<msg>" -- axes.json`; no task claims it,
// so a chat's push that names nothing leaves it pending.
// Returns the sanitized list that was written.
export function writeProjectAxes(projectPath, list) {
  const axes = sanitizeAxes(list);
  const path = projectAxesPath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeAxes(axes));
  return axes;
}
