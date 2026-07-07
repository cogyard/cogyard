// core/drivers.mjs — the agent-driver seam.
//
// The engine is agent-agnostic; three things are inherently agent-specific
// (worktree layout, transcript format, model pricing). This module resolves the
// ACTIVE driver's adapter ONCE at import (top-level await) and exports it as
// `adapter`. Every engine consumer (core/usage.mjs, core/pricing.mjs, the hooks,
// cli/tunnel.mjs) imports that resolved object and uses it synchronously.
//
// Adapters live in <repo>/drivers/<name>/adapter.mjs. The contract + the
// "how to add an agent" guide are in docs/DRIVERS.md.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';
import { readConfig } from './config.mjs';

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
  worktree: { detect() { return null; }, branchPrefix: null },
  transcripts: {
    supported: false,
    root() { return null; },
    list() { return []; },
    findBySession() { return []; },
    parseLine() { return null; },
  },
  pricing: { versions: [], aliases: {} },
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
  const mod = await import(join(DRIVERS_DIR, name, 'adapter.mjs'));
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

export { adapter, NOOP, listDriverNames, resolveActive, loadAdapter };
