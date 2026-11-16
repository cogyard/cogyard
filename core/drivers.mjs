// core/drivers.mjs — the agent-driver seam.
//
// The engine is agent-agnostic; a handful of things are inherently
// agent-specific (worktree layout, transcript format, model pricing, the agent
// app's own chat metadata, and running the agent headlessly). This module resolves the
// ACTIVE driver's adapter ONCE at import (top-level await) and exports it as
// `adapter`. Every engine consumer (core/usage.mjs, core/pricing.mjs, the hooks,
// cli/tunnel.mjs) imports that resolved object and uses it synchronously.
//
// Adapters live in <repo>/drivers/<name>/adapter.mjs. The contract + the
// "how to add an agent" guide are in docs/DRIVERS.md.

import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { readConfig } from './config.mjs';
import { hasSecret } from './secrets.mjs';

// drivers/ sits at the repo root, one level up from core/. Resolved from
// THIS file's location, so it's correct no matter which module imports us.
const DRIVERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drivers');

// The built-in no-op adapter — ships in core so the CLI + portal run with NO
// agent active at all (plain human user). Every seam returns its "off" value;
// the engine falls back to generic markers / registry / basename, harvests no
// usage, and never invents a cost.
const NOOP = {
  name: 'none',
  detect() { return false; },
  inSession() { return false; },
  sessionId() { return null; },
  worktree: { detect() { return null; }, branchPrefix: null },
  transcripts: {
    supported: false,
    root() { return null; },
    list() { return []; },
    findBySession() { return []; },
    sessionFiles() { return []; },
    pickFullest(files) { return (files && files[0]) || null; },
    parseLine() { return null; },
    firstHumanLabel() { return null; },
    readTurns() { return { turns: [], truncated: false }; },
    ownerTurns() { return []; },
  },
  pricing: { versions: [], aliases: {} },
  sessions: { supported: false, root() { return null; }, list() { return []; }, listArchived() { return []; }, status(ids) { return Object.fromEntries((ids || []).map((id) => [id, 'unknown'])); }, archive() { throw new Error('no agent driver active'); }, appRunning() { return false; } },
  liveState: { supported: false, logo: null, parseHook() { return null; } },
  // Scheduled jobs that need an agent must check `supported` and report "no
  // agent driver active" on their Settings row — never throw, never invent text.
  // `credential: null` = this driver needs no credential (there is no agent to
  // authenticate), so /settings shows no credential row at all.
  agent: { supported: false, credential: null, async run() { return { ok: false, text: '', cost: null, model: null, error: 'no agent driver active', failure: 'error', elapsedMs: 0, ttfbMs: null }; } },
  // No agent → no skill channel and no instruction files: the process-doc
  // check (task 133) sees only docs/*.md, and offers no outcome that needs a
  // skill or an always-loaded file.
  skills: {
    supported: false,
    alwaysLoaded: null,
    instructionFiles() { return []; },
    projectSkills() { return []; },
    projectCommands() { return []; },
    projectSkillFile() { return null; },
    renderSkill() { throw new Error('no agent driver active'); },
    invocation(name) { return name; },
    installCommand: null,
    personalName(name) { return name; },
    install() { return { personal: false, personalSkills: [], personalCommands: [], bareSkills: [], bareCommands: [], plugin: false }; },
    shipped() { return []; },
    shippedCommands() { return []; },
    reservedNames() { return []; },
    isOff() { return null; },
    turnOff() { throw new Error('no agent driver active'); },
  },
};

function listDriverNames() {
  try {
    return readdirSync(DRIVERS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(DRIVERS_DIR, d.name, 'adapter.mjs')))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

async function loadAdapter(name) {
  // A filesystem path (absolute, or ending in .mjs) loads that adapter directly,
  // so a driver can live OUTSIDE the repo (e.g. the private demo adapter the
  // shadow-yard demo runs under). A bare name resolves under drivers/<name>/.
  const spec = name.includes('/') || name.endsWith('.mjs')
    ? (isAbsolute(name) ? name : join(process.cwd(), name))
    : join(DRIVERS_DIR, name, 'adapter.mjs');
  const mod = await import(spec);
  return mod.default;
}

// Explicit selection: env var, then ~/.cogyard/config.json. null → auto-detect.
function configuredName() {
  if (process.env.COGYARD_DRIVER) return process.env.COGYARD_DRIVER;
  const driver = readConfig().driver;
  return typeof driver === 'string' ? driver : null;
}

async function resolveActive() {
  const want = configuredName();
  if (want === 'none') return NOOP;
  if (want) {
    try { return await loadAdapter(want); }
    catch { return NOOP; } // misconfigured name → degrade, don't crash the engine
  }
  // Auto-detect: the first adapter whose detect() claims the environment wins.
  for (const name of listDriverNames()) {
    try {
      const a = await loadAdapter(name);
      if (a && typeof a.detect === 'function' && a.detect()) return a;
    } catch { /* skip a broken adapter */ }
  }
  return NOOP;
}

// Resolved once, at import. Top-level await keeps every consumer synchronous.
const adapter = await resolveActive();

// The name of the agent this process is running inside, or null when a human
// started it (task 170). Asks EVERY installed driver, not just the active one:
// the active one is a configuration choice (COGYARD_DRIVER=none, or auto-detect
// picking whichever agent is installed), while "is an agent running this
// command" is a fact about the process — an owner-only command must not become
// reachable because the driver setting says something else.
async function agentSession() {
  for (const name of listDriverNames()) {
    try {
      const a = await loadAdapter(name);
      if (a && typeof a.inSession === 'function' && a.inSession()) return a.name || name;
    } catch { /* a broken adapter claims nothing */ }
  }
  return null;
}

// The id of the agent chat running this process, or null when none can say
// (a human's shell, or an agent whose driver has no way to know) — task 225.
// Asks every installed driver for the same reason agentSession does: which chat
// is running a command is a fact about the process, not a driver setting. A
// driver predating the seam has no sessionId() and answers nothing.
async function currentSessionId() {
  for (const name of listDriverNames()) {
    try {
      const a = await loadAdapter(name);
      const id = a && typeof a.sessionId === 'function' ? a.sessionId() : null;
      if (id) return String(id);
    } catch { /* a broken adapter claims nothing */ }
  }
  return null;
}

// What the owner typed in the agent chat running this process (task 237):
// { agent, sessionId, turns }. The driver that says it is running this process
// answers — the same every-driver walk as agentSession, since the chat whose
// words count is a fact about the process. No agent → agent null, turns [];
// an agent whose driver can't read its chats → turns [], so nothing the owner
// "said" can be shown and an owner-only command stays refused.
async function currentOwnerTurns() {
  for (const name of listDriverNames()) {
    try {
      const a = await loadAdapter(name);
      if (!a || typeof a.inSession !== 'function' || !a.inSession()) continue;
      const id = typeof a.sessionId === 'function' ? a.sessionId() : null;
      const read = a.transcripts && a.transcripts.ownerTurns;
      const turns = id && typeof read === 'function' ? read(String(id)) : [];
      return { agent: a.name || name, sessionId: id ? String(id) : null, turns: Array.isArray(turns) ? turns : [] };
    } catch { /* a broken adapter claims nothing */ }
  }
  return { agent: null, sessionId: null, turns: [] };
}

// The ACTIVE driver's credential, and whether it currently resolves (task 127).
//
// This belongs to the DRIVER, not to any add-on. It is the agent binary that
// authenticates, so every scheduled job calling `ctx.agent` needs the same one
// variable — and the variable's name is an agent-specific literal, which by this
// module's whole reason for existing may not appear anywhere else in the engine.
// (It was briefly declared per-add-on. Two scheduled jobs meant two identical
// declarations of a Claude literal inside community add-ons, and swapping the
// driver would have left every one of them quietly wrong.)
//
// Returns null when the driver needs no credential — the no-op adapter, or any
// agent that authenticates some other way — so the Settings card renders nothing
// rather than an empty requirement. `set` is a BOOLEAN; the value stays in
// core/secrets.mjs and reaches the agent through the environment it inherits.
function driverCredential() {
  const c = adapter.agent?.credential;
  if (!c || typeof c.env !== 'string' || !c.env) return null;
  return {
    env: c.env,
    label: c.label ?? c.env,
    howTo: c.howTo ?? null,
    set: hasSecret(c.env),
  };
}

export { adapter, NOOP, listDriverNames, resolveActive, loadAdapter, driverCredential, agentSession, currentSessionId, currentOwnerTurns };
