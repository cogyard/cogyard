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
import { sanitizeProjectIcons, sanitizeProjectIconBorders } from './project-icons.mjs';

const CONFIG_PATH = join(COGYARD_HOME, 'config.json');
const WEEK_STARTS = ['sunday', 'monday'];
// The portal's per-project tab strip — the legal ids for ui.hiddenTabs.
// Any tab may be hidden: the un-hide UI lives behind the sidebar cog (/settings,
// the global view), which is not a strip tab and can never be hidden. Neither
// is a project's Admin tab, pinned right of the strip, which holds Stats and
// Cleanup as inner tabs (task 249) — so 'stats' and 'cleanup' are no longer tab
// ids, and an older config naming them is cleaned like any unknown id: dropped
// from hiddenTabs, and a defaultTab of either falls back.
const PORTAL_TABS = ['daily', 'tasks', 'plan', 'branches', 'worktrees', 'graph', 'files'];
// Legacy tab-id migration: the 'board' tab was replaced by 'plan' (task 179) in
// the same slot. A config written before that may carry 'board' in
// ui.hiddenTabs — map it forward so a hidden tab stays hidden under its new id
// instead of being silently dropped by the PORTAL_TABS filter. Ids whose tab
// left the strip have no alias on purpose — the filter drops them: a stale
// 'settings' from the retired per-project tab, and 'stats' / 'cleanup' / the
// older 'activity' (Stats' first name), which now live inside Admin (task 249).
const TAB_ID_ALIASES = { board: 'plan' };

// Built-in creation defaults — what the New/Add drawer shows before anything is
// saved. `config.json.defaults` overlays these (validated, invalid values dropped).
// Only the kind: every project's tasks live in a store, so there is no store
// choice to default (task 169 removed the last `store: 'shared'`).
const BUILTIN_DEFAULTS = { kind: 'single' };

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
// config.json.defaults. An invalid persisted kind is dropped, not crashed on —
// a hand-corrupted file still yields usable defaults. Anything else in an older
// file's `defaults` (a `store` key) is ignored.
function projectDefaults() {
  const out = { ...BUILTIN_DEFAULTS };
  const d = readConfig().defaults;
  if (d && typeof d === 'object') {
    if (KINDS.includes(d.kind)) out.kind = d.kind;
  }
  return out;
}

// UI preferences: the activity views' week-start day, the hour
// the punch card's axis starts at (people's days don't start at midnight), which
// strip tabs are hidden, each project's rail icon (task 114 — a repo-relative
// image path per project slug), and which of those icons get a white border
// behind them on the dark rail; see core/project-icons.mjs.
// Default 'sunday' matches GitHub's contribution graph; 'monday' for people who
// read weeks Mon-first. Invalid persisted values are dropped, not crashed on.
// defaultTab is the tab a project opens on (task 216). It is resolved here
// against hiddenTabs, so the portal never sees a hidden landing tab: a hidden
// choice falls to the first visible tab in strip order ('tasks' if none are).
const BUILTIN_UI = { weekStart: 'sunday', dayStart: 0, hiddenTabs: [], defaultTab: 'tasks', projectIcons: {}, projectIconBorders: [] };
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
    const tab = TAB_ID_ALIASES[u.defaultTab] ?? u.defaultTab;
    if (PORTAL_TABS.includes(tab)) out.defaultTab = tab;
    out.projectIcons = sanitizeProjectIcons(u.projectIcons);
    out.projectIconBorders = sanitizeProjectIconBorders(u.projectIconBorders);
  }
  if (out.hiddenTabs.includes(out.defaultTab)) {
    out.defaultTab = PORTAL_TABS.find((t) => !out.hiddenTabs.includes(t)) ?? 'tasks';
  }
  return out;
}

// Add-on config values, persisted under `addons: { <id>: { <key>: <value> } }`
// (task 127). Until this existed, add-on config lived only in a browser signal:
// the Settings dialog held it, sent it in the POST body of a manually-triggered
// action, and forgot it on reload — so a nightly job, which nobody triggers,
// always ran on `{}` and saw only its own in-code defaults.
//
// VALUES ONLY, NEVER A SECRET. config.json is world-readable and the portal
// rewrites it whenever a setting is saved; a credential lives in
// ./secrets.mjs's 0600 file, and the agent's credential belongs to the driver
// (./drivers.mjs) and explained by whichever add-on asks for it.
//
// Storage is untyped here on purpose: this module knows config.json's shape,
// not any add-on's schema. Defaults, coercion, and validation belong with the
// manifests.
function addonConfigs() {
  const a = readConfig().addons;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
}

function readAddonConfig(id) {
  const v = addonConfigs()[id];
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {};
}

// Replace ONE add-on's stored values. writeConfig's merge is shallow, so the
// whole `addons` map has to be rebuilt here — patching it in place would drop
// every other add-on's config.
function writeAddonConfig(id, values) {
  const next = { ...addonConfigs(), [id]: { ...(values || {}) } };
  writeConfig({ addons: next });
  return next[id];
}

export { CONFIG_PATH, WEEK_STARTS, PORTAL_TABS, BUILTIN_DEFAULTS, readConfig, writeConfig, projectDefaults, uiPrefs, addonConfigs, readAddonConfig, writeAddonConfig };
