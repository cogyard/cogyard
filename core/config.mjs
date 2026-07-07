// core/config.mjs — read/write ~/.cogyard/config.json.
//
// config.json is the persistent machine-config layer (resolution order:
// env → config.json → per-project → built-in default; see docs/CONFIGURATION.md).
// It started life holding only `driver` (read by core/drivers.mjs);
// this module generalizes that read into a merge-patch read/write plus the
// resolved New/Add-drawer creation defaults the portal's /settings view edits.
//
// Recognized keys today: `driver` (string), `projectsRoot` (string, resolved
// in core/paths.mjs to keep that module import-cycle-free), and `defaults`
// ({ kind, store }). Unknown keys are preserved verbatim by writeConfig's merge.
//
// "No file" means "all defaults" — every reader degrades to built-ins rather than
// throwing, exactly as core/drivers.mjs already did before this refactor.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';
import { KINDS } from './scaffold.mjs';

const CONFIG_PATH = join(COGYARD_HOME, 'config.json');
// Shared is the only store model — `normal` (an in-repo tracked dir)
// is broken under worktrees and was removed as a selectable choice. STORES stays
// a single-member enum so the wire/config validation contract still resolves.
const STORES = ['shared'];
const WEEK_STARTS = ['sunday', 'monday'];
// The portal's per-project tab strip — the legal ids for ui.hiddenTabs.
// Any tab may be hidden: the un-hide UI lives behind the sidebar cog (/settings,
// the global view), which is not a strip tab and can never be hidden.
const PORTAL_TABS = ['tasks', 'board', 'branches', 'worktrees', 'graph', 'files', 'stats'];
// Legacy tab-id migration: the 'activity' tab was renamed 'stats'.
// A config written before the rename may carry 'activity' in ui.hiddenTabs —
// map it forward so a hidden Activity tab stays hidden as Stats instead of
// being silently dropped by the PORTAL_TABS filter. (A stale 'settings' id from
// the retired per-project tab has no alias on purpose — the filter drops it.)
const TAB_ID_ALIASES = { activity: 'stats' };

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

// UI preferences: the activity views' week-start day and the hour
// the punch card's axis starts at (people's days don't start at midnight).
// Default 'sunday' matches GitHub's contribution graph; 'monday' for people who
// read weeks Mon-first. Invalid persisted values are dropped, not crashed on.
const BUILTIN_UI = { weekStart: 'sunday', dayStart: 0, hiddenTabs: [] };
function uiPrefs() {
  const out = { ...BUILTIN_UI };
  const u = readConfig().ui;
  if (u && typeof u === 'object') {
    if (WEEK_STARTS.includes(u.weekStart)) out.weekStart = u.weekStart;
    if (Number.isInteger(u.dayStart) && u.dayStart >= 0 && u.dayStart <= 23) out.dayStart = u.dayStart;
    if (Array.isArray(u.hiddenTabs)) {
      const migrated = u.hiddenTabs.map((t) => TAB_ID_ALIASES[t] ?? t);
      out.hiddenTabs = [...new Set(migrated.filter((t) => PORTAL_TABS.includes(t)))];
    }
  }
  return out;
}

export { CONFIG_PATH, STORES, WEEK_STARTS, PORTAL_TABS, BUILTIN_DEFAULTS, readConfig, writeConfig, projectDefaults, uiPrefs };
