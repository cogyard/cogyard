// core/addons/index.mjs — the add-on contract, loader/discovery, and registry.
//
// Add-ons are cogyard's community extension axis: runtime CAPABILITIES a user
// installs to make COGYARD ITSELF do more (expose a tunnel, front the server
// with a proxy, push notifications, …). An add-on is MACHINE-LEVEL: installed
// once, configured once, rendered as one card on the global /settings page —
// never a per-project feature. If an add-on operates on a project (tunnel
// points at one project's worktree), that targeting is the add-on's own
// business, expressed as a `type: 'project'` config field — the framework has
// no per-project structure at all.
//
// Core ships the contract + this loader + the Settings surface and ZERO
// add-ons — anything platform-, service-, or owner-specific lives outside the
// published tree. Distinct from the other extension concepts:
//   * drivers/<name>/  — agent DRIVERS (which AI runs cogyard)
//   * core/scaffolds/       — project-kind templates (creation-time)
//   * .claude-plugin/       — Claude Code packaging of this repo
// docs/ADDONS.md is the public contract reference; keep it in lockstep.
//
// Discovery (the task's Phase-0 decision): drop-in directory. An add-on is
// installed by placing (cloning, copying, symlinking) a folder at
//   ~/.cogyard/addons/<id>/addon.mjs
// whose module exports a `manifest` object:
//
//   export const manifest = {
//     id: 'my-addon',                  // MUST equal the folder name
//     label: 'My Add-on',
//     description: '…',
//     icon: '🧩',                      // emoji / short glyph the Settings card shows
//     thirdParty: true,                // external service involved → bias to 'manual'
//     platforms: ['<process.platform value>'], // omit for all; else hidden/disabled elsewhere
//     prereqs() { return [{ id, label, ok, fixHint? }, …]; },   // machine checks; NEVER auto-installed
//     configSchema: [{ key, label, type: 'string'|'enum'|'boolean'|'project', required?, options?, default?, placeholder? }],
//     status() { return { enabled, summary, healthy, details? }; },  // machine-level roll-up
//     actions: [{ id, label, tier: 'safe'|'manual', destructive?, needsConfig? }],
//     run(actionId, cfg) { return { ok, message? }; },          // SAFE actions only
//     command(actionId, cfg) { return { command, note? }; },    // MANUAL actions only
//   };
//
// `type: 'project'` config fields: the portal renders a dropdown of registered
// projects and passes the chosen SLUG in `cfg` like any other value. That is
// the only project awareness anywhere in this framework.
//
// Tiered execution is enforced HERE, not trusted to the add-on: a 'safe' action
// goes through manifest.run(); a 'manual' action NEVER executes — the registry
// calls the side-effect-free manifest.command() and hands the copy-paste string
// to the UI. (The add-on is trusted code, but keeping execute and render as two
// functions means a buggy add-on can't be executed by the manual path at all.)
//
// State is derived, never duplicated: the registry stores nothing; every read
// calls the add-on's own status()/prereqs(), which inspect whatever state the
// add-on itself owns (e.g. tunnel's ~/.cogyard/tunnels.json).
//
// Same degradation posture as core/drivers.mjs: no addons dir → empty
// catalog; a broken add-on is skipped (listed as invalid), never crashes the
// engine. Manifests are resolved once per process (import cache) — installing
// or editing an add-on takes effect on the next process start (for the portal,
// the documented LaunchAgent reload).

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { COGYARD_HOME } from '../paths.mjs';
import { readConfig } from '../config.mjs';

const ADDONS_DIR = join(COGYARD_HOME, 'addons');
const ENTRY = 'addon.mjs';

// Folder names that can hold an add-on entry file. Sorted for stable catalog order.
function listAddonIds() {
  try {
    return readdirSync(ADDONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(ADDONS_DIR, d.name, ENTRY)))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

// Import one add-on's manifest. Throws on module/shape errors — callers decide
// whether that means "skip" (catalog) or "surface" (loadAddons diagnostics).
async function loadManifest(id) {
  const mod = await import(join(ADDONS_DIR, id, ENTRY));
  const m = mod.manifest ?? mod.default;
  if (!m || typeof m !== 'object') throw new Error(`${id}/${ENTRY} exports no manifest`);
  if (m.id !== id) throw new Error(`manifest id '${m.id}' must equal its folder name '${id}'`);
  if (typeof m.label !== 'string' || !m.label) throw new Error(`manifest '${id}' needs a label`);
  return m;
}

// Does this add-on run on the current host? Omitted/empty platforms = everywhere.
function supportedHere(manifest) {
  return !Array.isArray(manifest.platforms) || manifest.platforms.length === 0
    || manifest.platforms.includes(process.platform);
}

// Resolve every installed add-on once per process: [{ id, manifest }] for the
// loadable ones plus [{ id, error }] for the broken ones (the catalog lists
// them so a typo'd install is visible, not silently absent).
let resolved = null;
async function loadAddons() {
  if (resolved) return resolved;
  const ok = [], broken = [];
  for (const id of listAddonIds()) {
    try { ok.push({ id, manifest: await loadManifest(id) }); }
    catch (e) { broken.push({ id, error: String((e && e.message) || e) }); }
  }
  resolved = { ok, broken };
  return resolved;
}

// Framework-level activation switch (config.json `disabledAddons: [id, …]`,
// written through POST /api/config): an installed add-on that's switched OFF is
// still listed (metadata only) but INERT — none of its functions are called and
// its actions refuse to run. Install ≠ activate. Unknown ids are harmless (the
// state survives uninstall/reinstall).
function disabledSet() {
  const d = readConfig().disabledAddons;
  return new Set(Array.isArray(d) ? d.filter((x) => typeof x === 'string') : []);
}

// Guarded call into add-on code: its exceptions become data, never a crash.
function tryCall(fn, ...args) {
  try { return { value: typeof fn === 'function' ? fn(...args) : undefined }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
}

// The wire-safe slice of a manifest (functions stripped, platform verdict added).
function publicManifest(manifest) {
  const { id, label, description, icon, thirdParty, platforms, configSchema, actions } = manifest;
  return {
    id, label,
    description: description ?? '',
    icon: icon ?? null,
    thirdParty: !!thirdParty,
    platforms: Array.isArray(platforms) ? platforms : null,
    supported: supportedHere(manifest),
    configSchema: Array.isArray(configSchema) ? configSchema : [],
    actions: (Array.isArray(actions) ? actions : []).map((a) => ({
      id: a.id, label: a.label, tier: a.tier === 'manual' ? 'manual' : 'safe',
      destructive: !!a.destructive, needsConfig: !!a.needsConfig,
    })),
  };
}

// The discovered catalog: public manifests + machine prereq results, plus the
// unloadable installs.
async function listAddons() {
  const { ok, broken } = await loadAddons();
  const off = disabledSet();
  const catalog = ok.map(({ id, manifest }) => {
    const entry = publicManifest(manifest);
    entry.active = !off.has(id);
    if (entry.active && entry.supported) {
      const p = tryCall(manifest.prereqs);
      entry.prereqs = Array.isArray(p.value) ? p.value : [];
      if (p.error) entry.prereqError = p.error;
    } else {
      entry.prereqs = []; // switched off / unsupported → no add-on code runs
    }
    return entry;
  });
  return { addons: catalog, invalid: broken };
}

// Every installed add-on's live machine-level status. Unsupported platforms
// are reported disabled (not probed); a throwing status() is reported unhealthy.
async function addonStatuses() {
  const { ok } = await loadAddons();
  const off = disabledSet();
  return ok.map(({ id, manifest }) => {
    if (off.has(id)) {
      return { id, active: false, supported: supportedHere(manifest), enabled: false, healthy: null, summary: 'switched off' };
    }
    if (!supportedHere(manifest)) {
      return { id, active: true, supported: false, enabled: false, healthy: null, summary: `not available on ${process.platform}` };
    }
    const s = tryCall(manifest.status);
    if (s.error) return { id, active: true, supported: true, enabled: false, healthy: false, summary: `status failed: ${s.error}` };
    const v = s.value && typeof s.value === 'object' ? s.value : {};
    return {
      id, active: true, supported: true,
      enabled: !!v.enabled,
      healthy: v.healthy ?? null,
      summary: typeof v.summary === 'string' ? v.summary : '',
      details: v.details ?? null,
      prereqs: (() => { const p = tryCall(manifest.prereqs); return Array.isArray(p.value) ? p.value : []; })(),
    };
  });
}

// Run one action. Tier decides the path — 'safe' executes via run(), 'manual'
// NEVER executes: it renders the copy-paste command via command(). Every
// failure is a thrown Error; the server maps it to a 4xx.
async function runAddonAction(id, actionId, cfg) {
  const { ok } = await loadAddons();
  const found = ok.find((a) => a.id === id);
  if (!found) throw new Error(`unknown add-on: ${id}`);
  if (disabledSet().has(id)) throw new Error(`add-on '${id}' is switched off — activate it in /settings first`);
  const { manifest } = found;
  if (!supportedHere(manifest)) throw new Error(`add-on '${id}' is not available on ${process.platform}`);
  const action = (manifest.actions || []).find((a) => a.id === actionId);
  if (!action) throw new Error(`add-on '${id}' has no action '${actionId}'`);

  if (action.tier === 'manual') {
    const c = tryCall(manifest.command, actionId, cfg);
    if (c.error) throw new Error(`command render failed: ${c.error}`);
    const v = c.value && typeof c.value === 'object' ? c.value : { command: c.value };
    if (typeof v.command !== 'string' || !v.command) throw new Error(`add-on '${id}' rendered no command for '${actionId}'`);
    return { ok: true, manual: true, command: v.command, note: v.note ?? null };
  }

  if (typeof manifest.run !== 'function') throw new Error(`add-on '${id}' has no run()`);
  const r = await manifest.run(actionId, cfg);
  const v = r && typeof r === 'object' ? r : {};
  return { ok: v.ok !== false, manual: false, message: v.message ?? '' };
}

// Test seam: forget the resolved set so a redirected COGYARD_HOME re-discovers.
function resetAddons() { resolved = null; }

export { ADDONS_DIR, listAddonIds, loadManifest, loadAddons, listAddons, addonStatuses, runAddonAction, supportedHere, resetAddons };
