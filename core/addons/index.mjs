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
//     prereqs(cfg, { hasSecret, agentCredential, whereToSet }) { return [{ id, label, ok, fixHint? }, …]; }, // machine checks; NEVER auto-installed
//     configSchema: [{ key, label, type: 'string'|'enum'|'boolean'|'project', required?, options?, default?, placeholder? }],
//     status() { return { enabled, summary, healthy, details? }; },  // machine-level roll-up
//     actions: [{ id, label, tier: 'safe'|'manual', destructive?, needsConfig? }],
//     run(actionId, cfg) { return { ok, message? }; },          // SAFE actions only
//     command(actionId, cfg) { return { command, note? }; },    // MANUAL actions only
//     // OPTIONAL — declaring `schedule` makes this a SCHEDULED JOB (task 118):
//     schedule: { every: 'day'|'week', at: 'HH:MM', weekday?: 0-6, catchUp?: true },
//     bounds: { timeoutMs?, maxUnits?, maxCostUsd? },
//     async runScheduled(cfg, ctx) { return { ok, summary, cost?, skipped? }; },
//   };
//
// Scheduled jobs are a THIRD execution tier beside safe/manual: unattended, on a
// timer, nobody watching. The vocabulary lives in ./schedule.mjs and the runner
// + state in ./jobs.mjs; this module only DISCOVERS them, so an add-on with no
// `schedule` is completely unaffected.
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
import { readConfig, readAddonConfig, writeAddonConfig } from '../config.mjs';
import { hasSecret, whereToSet, addSecretCommand, secretsStatus, SECRETS_PATH } from '../secrets.mjs';
import { driverCredential } from '../drivers.mjs';
import { normalizeSchedule, normalizeBounds } from './schedule.mjs';

const ADDONS_DIR = join(COGYARD_HOME, 'addons');
const ENTRY = 'addon.mjs';

// Folder names that can hold an add-on entry file. Sorted for stable catalog order.
//
// The test is "does <name>/addon.mjs exist", NOT "is <name> a directory": a
// Dirent for a SYMLINK reports isDirectory() === false, so the type check
// silently rejected every symlinked install — which is the install this doc
// (and every add-on README) recommends, because it makes the add-on track the
// checkout. existsSync follows the link and answers the question that actually
// matters; a plain file in this directory still has no entry file and is still
// ignored.
function listAddonIds() {
  try {
    return readdirSync(ADDONS_DIR)
      .filter((name) => existsSync(join(ADDONS_DIR, name, ENTRY)))
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

// ============================================================================
// Add-on config (task 127) — the owner's persisted values.
// ----------------------------------------------------------------------------
// An add-on's config VALUES live in config.json under `addons.<id>` (see
// ../config.mjs). This layer is the one that knows a field's TYPE, so defaults,
// coercion, and validation live here.
//
// NO CREDENTIALS PASS THROUGH HERE. config.json is world-readable and the portal
// rewrites it whenever a setting is saved, so nothing in this file may ever hold
// a secret. The agent's credential belongs to the DRIVER and is surfaced once
// by the driver (../drivers.mjs) and stored by ../secrets.mjs; an add-on is told
// only whether it resolves, through the `agentCredential` handed to prereqs().
//
// A `secret` FIELD TYPE briefly lived here so an add-on could declare its own
// third-party credential. It was removed with nothing using it: the agent
// credential — the case that motivated it — turned out to belong to the driver,
// and core does not carry contract surface on speculation. If an add-on ever
// genuinely needs its own credential, add it back deliberately, for that add-on.
// ============================================================================

function schemaOf(manifest) {
  return (Array.isArray(manifest.configSchema) ? manifest.configSchema : [])
    .filter((f) => f && typeof f.key === 'string' && f.key);
}

// The cfg an add-on actually receives: schema defaults overlaid with the owner's
// persisted values.
function resolveConfig(manifest, persisted) {
  const out = {};
  for (const f of schemaOf(manifest)) {
    const stored = persisted?.[f.key];
    if (stored !== undefined) { out[f.key] = stored; continue; }
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

// The resolved cfg for one installed add-on, by id. What the scheduler hands a
// nightly job, and the base the Settings dialog's posted drafts merge onto.
async function addonConfig(id) {
  const { ok } = await loadAddons();
  const found = ok.find((a) => a.id === id);
  if (!found) return {};
  return resolveConfig(found.manifest, readAddonConfig(id));
}

// Validate one submitted field against its declared type. Returns { value } to
// store, { skip: true } to drop (an empty value clears the key), or { error }.
function coerceField(field, raw) {
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') return { error: `'${field.key}' must be true or false` };
    return { value: raw };
  }
  if (typeof raw !== 'string') return { error: `'${field.key}' must be a string` };
  const v = raw.trim();
  if (!v) return { skip: true };
  if (field.type === 'enum' && Array.isArray(field.options) && !field.options.includes(v)) {
    return { error: `'${field.key}' must be one of: ${field.options.join(', ')}` };
  }
  return { value: v };
}

// Persist one add-on's config. Only DECLARED keys are accepted — an unknown key
// is a typo or a stale field from an older manifest, and silently storing it
// would make config.json accumulate settings nothing reads. Throws on the first
// rejection; the server maps it to a 400.
async function saveAddonConfig(id, values) {
  const { ok } = await loadAddons();
  const found = ok.find((a) => a.id === id);
  if (!found) throw new Error(`unknown add-on: ${id}`);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('config must be an object');

  const fields = new Map(schemaOf(found.manifest).map((f) => [f.key, f]));
  const next = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) throw new Error(`add-on '${id}' has no config field '${key}'`);
    const r = coerceField(field, raw);
    if (r.error) throw new Error(r.error);
    if (!r.skip) next[key] = r.value;
  }
  writeAddonConfig(id, next);
  return resolveConfig(found.manifest, next);
}

// What prereqs() is called with (task 127). It used to take nothing, which left
// an add-on with no way to say "the credential is missing" on its card — so the
// first anyone heard of it was a failed 05:00 run.
//
// Every argument is an addition; an add-on that ignores them is unaffected.
//   cfg — its resolved config.
//   ctx.hasSecret(name) — a boolean. NOT the value: prereqs() reports whether a
//     credential is there, and there is deliberately no call here that could
//     hand an add-on the credential itself.
//   ctx.agentCredential — the ACTIVE DRIVER's credential ({ env, label, set,
//     howTo }) or null. A job that calls ctx.agent needs this one, and it is the
//     driver's, not the add-on's — so the add-on reports it WITHOUT naming any
//     agent-specific literal of its own.
//   ctx.whereToSet(name) — the one sentence saying where a credential is set.
//     The credential is set in one place and used in another, so "missing" on
//     its own is a dead end: the reader is looking at the job that failed, not
//     at the file that would fix it. Every consumer renders this same string.
//   ctx.addSecretCommand(name) / ctx.secretsPath / ctx.secretsStatus — enough to
//     WRITE the instructions for setting a credential without hardcoding this
//     machine's paths, and to say when the file exists but is being refused.
function prereqArgs(manifest, id) {
  return [
    resolveConfig(manifest, readAddonConfig(id)),
    {
      hasSecret, whereToSet, addSecretCommand,
      secretsPath: SECRETS_PATH,
      secretsStatus: secretsStatus(),
      agentCredential: driverCredential(),
    },
  ];
}

// Guarded call into add-on code: its exceptions become data, never a crash.
function tryCall(fn, ...args) {
  try { return { value: typeof fn === 'function' ? fn(...args) : undefined }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
}

// The wire-safe slice of one config field. Built key by key rather than passed
// through, so a manifest can never smuggle onto the wire something this module
// has not thought about.
function publicField(field) {
  const out = { key: field.key, label: field.label ?? field.key, type: field.type ?? 'string' };
  if (field.required) out.required = true;
  if (Array.isArray(field.options)) out.options = field.options;
  if (field.default !== undefined) out.default = field.default;
  if (field.placeholder !== undefined) out.placeholder = field.placeholder;
  return out;
}

// The wire-safe slice of a manifest (functions stripped, platform verdict added).
function publicManifest(manifest) {
  const { id, label, description, icon, thirdParty, platforms, actions } = manifest;
  // The owner's persisted values, so the Settings dialog opens on what is
  // actually stored instead of on schema defaults it then silently diverges from.
  const persisted = readAddonConfig(id);
  // A declared-but-malformed schedule normalizes to null: the add-on is simply
  // not a scheduled job, rather than one on a schedule nobody intended.
  const schedule = normalizeSchedule(manifest.schedule);
  return {
    id, label,
    // What capability this add-on PROVIDES, when it gates one. Core reads the
    // flag, never an add-on's name: 'scheduled-jobs' means "while this is
    // switched off, no job runs and the Scheduled tasks section is hidden".
    provides: typeof manifest.provides === 'string' ? manifest.provides : null,
    description: description ?? '',
    icon: icon ?? null,
    thirdParty: !!thirdParty,
    platforms: Array.isArray(platforms) ? platforms : null,
    supported: supportedHere(manifest),
    schedule,
    bounds: schedule ? normalizeBounds(manifest.bounds) : null,
    // Declaring a schedule without runScheduled() is an add-on bug the row must
    // show, so report the two facts separately instead of collapsing them.
    runnable: typeof manifest.runScheduled === 'function',
    configSchema: schemaOf(manifest).map(publicField),
    // What is stored today, so the dialog opens on the saved values.
    config: resolveConfig(manifest, persisted),
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
      const args = prereqArgs(manifest, id);
      const p = tryCall(manifest.prereqs, ...args);
      entry.prereqs = Array.isArray(p.value) ? p.value : [];
      if (p.error) entry.prereqError = p.error;
      // A one-time setup walkthrough the DIALOG renders (task 127). The add-on
      // supplies words and commands; it ships no UI. Returning null means there
      // is nothing left to do, so the guide disappears once setup is complete
      // rather than sitting there as permanent instructions.
      const g = tryCall(manifest.setup, ...args);
      entry.setup = g.value && typeof g.value === 'object' && Array.isArray(g.value.steps) ? g.value : null;
    } else {
      entry.prereqs = []; // switched off / unsupported → no add-on code runs
      entry.setup = null;
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
    // status() gets the same context prereqs()/setup() do. Without it an add-on
    // reporting on a credential saw `agentCredential` undefined and said "no
    // agent driver active" on its row while its own dialog named the token — the
    // row contradicting its own contents.
    const s = tryCall(manifest.status, ...prereqArgs(manifest, id));
    if (s.error) return { id, active: true, supported: true, enabled: false, healthy: false, summary: `status failed: ${s.error}` };
    const v = s.value && typeof s.value === 'object' ? s.value : {};
    return {
      id, active: true, supported: true,
      enabled: !!v.enabled,
      healthy: v.healthy ?? null,
      summary: typeof v.summary === 'string' ? v.summary : '',
      details: v.details ?? null,
      prereqs: (() => { const p = tryCall(manifest.prereqs, ...prereqArgs(manifest, id)); return Array.isArray(p.value) ? p.value : []; })(),
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

  // The dialog's live drafts overlay the persisted config, so pressing a button
  // uses what is on screen rather than what was last saved.
  const posted = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  cfg = { ...resolveConfig(manifest, readAddonConfig(id)), ...posted };

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

// Is the scheduled-jobs capability switched on? An add-on has to PROVIDE it and
// be active. Nothing installed → no scheduled work happens and no section is
// rendered, which is the honest state: jobs are an opt-in capability, not
// something core does on its own.
// `disabled` is passed IN rather than read here, so this answers the same
// question the caller's other checks answer. core/addons/jobs.mjs takes its
// deps from the caller by design; reading config directly here made the runner
// consult two different sources for "is this switched off".
async function providesEnabled(capability, disabled = disabledSet()) {
  const { ok } = await loadAddons();
  return ok.some(({ id, manifest }) => manifest.provides === capability && !disabled.has(id) && supportedHere(manifest));
}

// Test seam: forget the resolved set so a redirected COGYARD_HOME re-discovers.
function resetAddons() { resolved = null; }

export { ADDONS_DIR, providesEnabled, listAddonIds, loadManifest, loadAddons, listAddons, addonStatuses, runAddonAction, addonConfig, saveAddonConfig, supportedHere, disabledSet, resetAddons };
