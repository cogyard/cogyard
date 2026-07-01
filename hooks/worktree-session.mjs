#!/usr/bin/env node
// worktree-session.mjs — the SessionStart worktree hook, single entry point.
// Replaces the old bash-orchestrator + worktree-setup.py pipeline (the bash
// file is now a 5-line shim that execs this).
//
// Invocation:
//   - As a SessionStart hook (no args): worktree path comes from
//     $CLAUDE_PROJECT_DIR, set by Claude Code.
//   - Manually with an explicit path: `node worktree-session.mjs <worktree-path>`.
//     Needed for worktrees created MID-session via the EnterWorktree tool
//     (bd-pickup-task's task-named worktrees) — SessionStart hooks do not
//     re-fire on EnterWorktree, so the skill runs this directly.
//
// What it does, in order, for every Claude Code session:
//   1. Exits unless the path is one of the active integration's worktrees
//      (the adapter's worktree.detect decides; task 038).
//   2. Auto-mounts the shared _tasks symlink (task 015) — all projects.
//   3. Reserves a port pair via worktree-ports.mjs — UNIVERSAL, no opt-in
//      (task 042). Reservation is a registry row + briefing only.
//   4. If the project has a committed .claude/worktree-config.json, wires the
//      worktree: .planet (kind=planet), env files (symlink/copy/merge),
//      .claude/launch.json — then notifies and prints the full briefing.
//      Without a config it prints a reserved-ports briefing and writes nothing.
//
// Project discovery is findParentMarker from worktree-ports.mjs — ONE walk-up
// routine for both allocation identity and config lookup.
//
// Failure policy: ALWAYS exit 0. Failures log to $LOG and surface via macOS
// notification. A non-zero exit would block Claude session start.

import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  appendFileSync, lstatSync, statSync, unlinkSync, symlinkSync,
} from 'node:fs';
import { join, dirname, basename, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findParentMarker } from './worktree-ports.mjs';
import { adapter } from '../core/integrations.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const COGYARD_HOME = process.env.COGYARD_HOME || join(homedir(), '.cogyard');
const LOG = join(COGYARD_HOME, 'logs', 'worktree-hook.log');
const ALLOCATOR = join(SCRIPT_DIR, 'worktree-ports.mjs');
const TASKS_CLI = join(SCRIPT_DIR, '..', 'cli', 'tasks.mjs');
const WT = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || '';

try { mkdirSync(dirname(LOG), { recursive: true }); } catch { /* log dir best-effort */ }

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

function log(msg) {
  try { appendFileSync(LOG, `[${ts()}] ${msg}\n`); } catch { /* never block on logging */ }
}

function logRaw(text) {
  if (text && String(text).length) {
    try { appendFileSync(LOG, String(text)); } catch { /* ditto */ }
  }
}

function notify(title, message) {
  try {
    execFileSync('osascript', ['-e', `display notification "${message}" with title "${title}" sound name "Pop"`], { stdio: 'ignore' });
  } catch { /* notification is best-effort */ }
}

function failSoft(reason) {
  log(`FAILED (${WT}): ${reason}`);
  notify('Worktree port hook FAILED', `${reason} — see ${LOG}`);
  process.exit(0);
}

// Atomic-ish idempotent write: tmp + rename, parents created.
function writeIdempotent(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// --- gates -------------------------------------------------------------------

if (!WT) process.exit(0);
// Only act inside one of the active integration's worktrees (the adapter's
// worktree.detect decides). No agent active → nothing to wire (task 038).
const wtInfo = adapter.worktree.detect(WT);
if (!wtInfo) process.exit(0);

// --- _tasks automount (task 015) — all worktrees, ports-unrelated -------------

try {
  const out = execFileSync('node', [TASKS_CLI, 'mount'], { cwd: WT, stdio: ['ignore', 'pipe', 'pipe'] });
  logRaw(out);
} catch (e) {
  logRaw(e.stdout); logRaw(e.stderr); // never blocks the session
}

// --- allocate — universal reservation (task 042) -------------------------------

if (!existsSync(ALLOCATOR)) failSoft(`allocator not found at ${ALLOCATOR}`);
let alloc = null;
try {
  alloc = JSON.parse(execFileSync('node', [ALLOCATOR, 'allocate', WT], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());
} catch (e) {
  logRaw(e.stderr);
  failSoft('allocator returned empty');
}
const backend = alloc.backend;
const frontend = alloc.frontend;
const worktreeName = alloc.worktree_name;
const parentPlanet = alloc.parent_planet;
if (!backend || !frontend) failSoft(`could not parse allocator JSON: ${JSON.stringify(alloc)}`);

// --- discovery: one routine, shared with the allocator -------------------------

const parent = findParentMarker(WT);
const projectRoot = parent ? parent.parentDir : wtInfo.parentRepo;
const configPath = join(projectRoot, '.claude', 'worktree-config.json');

// --- tunnel follow (optional) --------------------------------------------------
// If this project is tunnel-enabled with follow_worktrees on (cli/tunnel.mjs,
// task 031), repoint its Cloudflare tunnel at THIS worktree's port so the stable
// hostname follows the worktree with zero manual steps. Best-effort: never blocks.
maybeFollowTunnel(projectRoot, WT);

function maybeFollowTunnel(projRoot, worktree) {
  try {
    const tunnelsPath = join(COGYARD_HOME, 'tunnels.json');
    if (!existsSync(tunnelsPath)) return;
    const reg = JSON.parse(readFileSync(tunnelsPath, 'utf8')) || {};
    const hit = Object.values(reg).find((t) => t.project_path === projRoot && t.follow_worktrees !== false);
    if (!hit) return;
    const tunnelCli = join(SCRIPT_DIR, '..', 'cli', 'tunnel.mjs');
    const out = execFileSync('node', [tunnelCli, 'here'], { cwd: worktree, stdio: ['ignore', 'pipe', 'pipe'] });
    logRaw(out);
    log(`tunnel follow: ${hit.name} → ${basename(worktree)}`);
  } catch (e) {
    logRaw(String(e.stdout || '')); logRaw(String(e.stderr || ''));
    log(`tunnel follow skipped: ${e.message}`); // best-effort, never blocks
  }
}

// --- no config → reserved only: brief, write nothing, no notification ----------

if (!isFile(configPath)) {
  log(`reserved (no config) ${basename(projectRoot)}/${worktreeName} → backend=:${backend} frontend=:${frontend}`);
  process.stdout.write(`=== Worktree ports (reserved) ===

Project       : ${basename(projectRoot)}
Worktree      : ${worktreeName}
Reserved ports: backend = ${backend}, frontend = ${frontend}

Every Claude worktree gets a reserved port pair so parallel worktrees never
collide. This project has no .claude/worktree-config.json, so no env files
were written. If you start any server in this worktree, bind it to the ports
above. For automatic env-file/launch.json wiring, add a worktree-config.json
(see docs/WORKTREE-PORTS.md in the cogyard repo).
=== end allocation ===
`);
  process.exit(0);
}

// --- config → full wiring (was worktree-setup.py) ------------------------------

let briefing;
try {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));

  const projectName = cfg.project_name || basename(projectRoot);
  const kind = cfg.kind ?? 'single';
  const devScript = cfg.dev_script ?? 'npm run dev';
  const launchName = cfg.launch_name ?? 'dev';
  const previewPortVar = cfg.preview_port_var ?? 'FRONTEND_PORT';
  const portVars = cfg.port_vars ?? {};

  // Resolve port assignments by which side of the allocation each var maps to.
  const portValueFor = { backend, frontend };
  const portAssignments = {};
  for (const [varName, side] of Object.entries(portVars)) {
    if (!(side in portValueFor)) throw new Error(`port_vars[${varName}] must map to 'backend' or 'frontend'; got '${side}'`);
    portAssignments[varName] = portValueFor[side];
  }
  if (!(previewPortVar in portAssignments)) throw new Error(`preview_port_var ${previewPortVar} not declared in port_vars`);
  const previewPort = portAssignments[previewPortVar];

  // 1. .planet file (kind=planet only).
  if (kind === 'planet') {
    const planetNameVar = cfg.planet_name_var ?? 'PLANET_NAME';
    const template = cfg.planet_name_template ?? '{parent}-{worktree}';
    const planetName = template.replace('{parent}', parentPlanet).replace('{worktree}', worktreeName);
    const lines = [`${planetNameVar}=${planetName}`];
    for (const [k, v] of Object.entries(portAssignments)) lines.push(`${k}=${v}`);
    writeIdempotent(join(WT, '.planet'), lines.join('\n') + '\n');
  }

  // 2. env files.
  for (const spec of cfg.env_files ?? []) {
    const srcRel = spec.source;
    const tgtRel = spec.target;
    const strategy = spec.strategy ?? 'symlink';
    if (!srcRel || !tgtRel) throw new Error(`env_files entry missing source/target: ${JSON.stringify(spec)}`);

    const srcAbs = resolve(projectRoot, srcRel);
    // Don't realpath the target — that would follow a leftover symlink to its
    // destination outside the worktree and trip the escape guard below.
    const tgtAbs = normalize(join(WT, tgtRel));
    if (tgtAbs !== WT && !tgtAbs.startsWith(WT + '/')) throw new Error(`env_files target ${tgtRel} escapes worktree path`);

    // Source missing is non-fatal — many projects don't have .env.production locally.
    if (!isFile(srcAbs)) continue;

    if (strategy === 'symlink') {
      mkdirSync(dirname(tgtAbs), { recursive: true });
      try { unlinkSync(tgtAbs); } catch { /* absent or a dir — symlinkSync will surface a real problem */ }
      symlinkSync(srcAbs, tgtAbs);
    } else if (strategy === 'copy') {
      writeIdempotent(tgtAbs, readFileSync(srcAbs, 'utf8'));
    } else if (strategy === 'merge') {
      let body = readFileSync(srcAbs, 'utf8');
      if (body && !body.endsWith('\n')) body += '\n';
      body += '\n# --- worktree overrides (task 042 SessionStart hook) ---\n';
      for (const [k, v] of Object.entries(portAssignments)) body += `${k}=${v}\n`;
      // If target is a symlink (leftover from a previous run), drop it.
      try { if (lstatSync(tgtAbs).isSymbolicLink()) unlinkSync(tgtAbs); } catch { /* absent is fine */ }
      writeIdempotent(tgtAbs, body);
    } else {
      throw new Error(`unknown env_files strategy: '${strategy}'`);
    }
  }

  // 3. .claude/launch.json for the Claude_Preview MCP.
  const scriptArgs = (devScript.startsWith('npm run ') ? devScript.slice('npm run '.length) : devScript).split(/\s+/).filter(Boolean);
  const launch = {
    version: '0.0.1',
    configurations: [
      { name: launchName, runtimeExecutable: 'npm', runtimeArgs: ['run', ...scriptArgs], port: previewPort },
    ],
  };
  writeIdempotent(join(WT, '.claude', 'launch.json'), JSON.stringify(launch, null, 2) + '\n');

  // 4. Notify + full briefing.
  log(`${projectName}/${worktreeName} → backend=:${backend} frontend=:${frontend}`);
  notify(`Worktree ready: ${worktreeName}`, `Frontend: http://localhost:${previewPort}\nBackend:  :${backend}`);

  briefing = `=== Worktree dev environment (task 042) ===

Project       : ${projectName}
Worktree      : ${worktreeName}
Worktree path : ${WT}
Project root  : ${projectRoot}

Allocated ports (do NOT collide with the parent project's dev servers):
  backend  port = ${backend}
  frontend port = ${frontend}

The SessionStart hook has set up:
  - ${WT}/.planet (if this project uses the planet convention)
  - ${WT}/.env.* (symlinks or merged copies of the project's env files)
  - ${WT}/.claude/launch.json (preview MCP config)

# Dev server

Start it for this session via the Claude_Preview MCP: preview_start
name="${launchName}" (spawns ${devScript}, bound to the allocated ports above).
Nothing keeps a server running across sessions — start it when you need it, stop
it when you're done.

# Direct URLs

  Frontend : http://localhost:${previewPort}
  Backend  : http://localhost:${backend}

# DO NOT
  - Hand-edit .planet, .env.worktree, or .claude/launch.json — the hook
    rewrites them at every session startup.

Reference: docs/WORKTREE-PORTS.md
=== end allocation ===
`;
} catch (e) {
  failSoft(`worktree setup failed: ${e.message}`);
}

process.stdout.write(briefing);
process.exit(0);
