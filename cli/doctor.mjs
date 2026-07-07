#!/usr/bin/env node
// cli/doctor.mjs — `cogyard doctor`: the thin renderer over core/doctor.mjs.
//
// This module owns ALL the I/O the preflight needs (read process/git/fs, probe a
// port), packs the facts into a `ctx`, calls the pure `runDoctor(ctx)`, renders the
// ok/warn/fail report with a fix line per problem, and sets the exit code (non-zero
// iff any check FAILED — warnings don't fail). It REPORTS only; it never mutates
// config/registry/ports (auto-fix is out of scope).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

import { COGYARD_HOME, PROJECTS_ROOT } from '../core/paths.mjs';
import { discoverProjects } from '../core/registry.mjs';
import { adapter, listDriverNames } from '../core/drivers.mjs';
import { runDoctor } from '../core/doctor.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // <pkg>
// Keep this path in sync with server/http.mjs DIST (what `serve` actually serves).
const DIST = join(ROOT, 'frontend', 'dist', 'frontend', 'browser');
// `cogyard serve` binds PORT (default 7440 — see cli/cogyard.mjs help).
const SERVE_PORT = Number(process.env.PORT) || 7440;

function gitVersion() {
  try {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

function isWritable(p) {
  try { accessSync(p, constants.W_OK); return true; } catch { return false; }
}

// Writable if the home dir itself is writable, or — when it doesn't exist yet —
// the nearest existing ancestor is (cogyard would mkdir -p it on first write).
function homeWritable(home) {
  if (existsSync(home)) return isWritable(home);
  let dir = dirname(home);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return isWritable(dir);
}

// Absent → null (ok). Parseable → the object. Present-but-unparseable → the raw
// string (a non-object truthy value, which core's `config` check warns on).
function readConfig() {
  const p = join(COGYARD_HOME, 'config.json');
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    try { return JSON.parse(raw); } catch { return raw; }
  } catch { return 'unreadable'; }
}

function probePortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const SYMBOL = {
  ok: () => c(32, '✔'),
  warn: () => c(33, '!'),
  fail: () => c(31, '✖'),
};

async function main() {
  // Probe everything that needs I/O here, then inject plain closures so runDoctor
  // stays pure and synchronous.
  const portFree = await probePortFree(SERVE_PORT);

  const ctx = {
    nodeVersion: process.versions.node,
    gitVersion,
    home: COGYARD_HOME,
    homeWritable: () => homeWritable(COGYARD_HOME),
    config: readConfig(),
    projectsRoot: PROJECTS_ROOT,
    rootExists: () => existsSync(PROJECTS_ROOT),
    registry: discoverProjects(),
    driver: {
      active: adapter.name && adapter.name !== 'none' ? adapter.name : null,
      available: listDriverNames(),
    },
    frontendBuilt: () => existsSync(DIST),
    servePort: SERVE_PORT,
    portFree: () => portFree,
  };

  const report = runDoctor(ctx);

  process.stdout.write(`cogyard doctor — install preflight (${COGYARD_HOME})\n\n`);
  for (const ch of report.checks) {
    process.stdout.write(`  ${SYMBOL[ch.status]()} ${ch.label.padEnd(22)} ${ch.detail}\n`);
    if (ch.status !== 'ok' && ch.fix) process.stdout.write(`      ↳ ${c(2, ch.fix)}\n`);
  }

  const { ok, warn, fail } = report.counts;
  process.stdout.write(`\n  ${ok} ok · ${warn} warn · ${fail} fail\n`);
  process.stdout.write('  For per-project task-storage health, run `cogyard tasks doctor`.\n');
  if (!report.ok) {
    process.stdout.write(c(31, '\n  Some checks FAILED — cogyard is not fully runnable until they are fixed.\n'));
  }

  process.exit(report.ok ? 0 : 1);
}

main();
