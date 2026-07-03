// core/config.mjs — read/write ~/.cogyard/config.json (task 060).
//
// config.json is the persistent machine-config layer (resolution order:
// env → config.json → per-project → built-in default; see docs/CONFIGURATION.md).
// It started life holding only `integration` (read by core/integrations.mjs);
// this module generalizes that read into a merge-patch read/write plus the
// resolved New/Add-drawer creation defaults the portal's /settings view edits.
//
// Recognized keys today: `integration` (string), `projectsRoot` (string, resolved
// in core/paths.mjs to keep that module import-cycle-free), and `defaults`
// ({ kind, store }). Unknown keys are preserved verbatim by writeConfig's merge.
//
// "No file" means "all defaults" — every reader degrades to built-ins rather than
// throwing, exactly as core/integrations.mjs already did before this refactor.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { KINDS } from './scaffold.mjs';

const CONFIG_PATH = join(COGYARD_HOME, 'config.json');
const STORES = ['shared', 'normal'];
const WEEK_STARTS = ['sunday', 'monday'];

// Built-in creation defaults — what the New/Add drawer shows before anything is
// saved. `config.json.defaults` overlays these (validated, invalid values dropped).
const BUILTIN_DEFAULTS = { kind: 'single', store: 'shared' };

// The whole config object, or {} when the file is absent/malformed. A non-object
// (e.g. a JSON array) is treated as no config rather than propagated.
function readConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch { return {}; }
}

// Merge-patch the config file: existing keys are preserved, the patch overrides.
// Creates COGYARD_HOME on first write (same idiom as core/registry.mjs). Returns
// the merged object that was written.
function writeConfig(patch) {
  const next = { ...readConfig(), ...(patch || {}) };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// The resolved creation defaults: built-ins overlaid with any valid
// config.json.defaults. Invalid persisted values (bad kind/store) are dropped,
// not crashed on — a hand-corrupted file still yields usable defaults.
function projectDefaults() {
  const out = { ...BUILTIN_DEFAULTS };
  const d = readConfig().defaults;
  if (d && typeof d === 'object') {
    if (KINDS.includes(d.kind)) out.kind = d.kind;
    if (STORES.includes(d.store)) out.store = d.store;
  }
  return out;
}

// UI preferences (task 064): the activity views' week-start day and the hour
// the punch card's axis starts at (people's days don't start at midnight).
// Default 'sunday' matches GitHub's contribution graph; 'monday' for people who
// read weeks Mon-first. Invalid persisted values are dropped, not crashed on.
const BUILTIN_UI = { weekStart: 'sunday', dayStart: 0 };
function uiPrefs() {
  const out = { ...BUILTIN_UI };
  const u = readConfig().ui;
  if (u && typeof u === 'object') {
    if (WEEK_STARTS.includes(u.weekStart)) out.weekStart = u.weekStart;
    if (Number.isInteger(u.dayStart) && u.dayStart >= 0 && u.dayStart <= 23) out.dayStart = u.dayStart;
  }
  return out;
}

export { CONFIG_PATH, STORES, WEEK_STARTS, BUILTIN_DEFAULTS, readConfig, writeConfig, projectDefaults, uiPrefs };
