#!/usr/bin/env node
// worktree-session.mjs — the SessionStart worktree hook, single entry point.
// Replaces the old bash-orchestrator + worktree-setup.py pipeline (the bash
// file is now a 5-line shim that execs this).
//
// Invocation:
//   - As a SessionStart hook (no args): the worktree is the `cwd` in the JSON
//     Claude Code passes on stdin, when that names a worktree; otherwise
//     $CLAUDE_PROJECT_DIR. A chat the desktop app starts inside its own worktree
//     gets $CLAUDE_PROJECT_DIR = the MAIN checkout and the hook runs from there
//     too — only the stdin `cwd` names the worktree (probed 2026-11-09, desktop
//     4.23118.1; task 233). Read here directly, like the PreToolUse hooks do,
//     beside the $CLAUDE_PROJECT_DIR read that was already here.
//   - Manually with an explicit path: `node worktree-session.mjs <worktree-path>`.
//     Needed for worktrees created MID-session via the EnterWorktree tool
//     (pickup-task's task-named worktrees) — SessionStart hooks do not
//     re-fire on EnterWorktree, so the skill runs this directly. The path may be
//     relative (`.` is the usual one); it is resolved to absolute before anything
//     looks at it.
//
// What it does, in order, for every Claude Code session:
//   1. Exits unless the path is one of the active driver's worktrees
//      (the adapter's worktree.detect decides). An EXPLICIT path that isn't one
//      says so on stdout; the automatic $CLAUDE_PROJECT_DIR form stays silent,
//      because it fires on every session and most are ordinary checkouts.
//   2. Auto-mounts the link to the shared task store (.cogyard/tasks) — all projects.
//   3. Reserves a port pair via worktree-ports.mjs — UNIVERSAL, no opt-in
//      Reservation is a registry row + briefing only.
//   4. If the project has a committed worktree config (.cogyard/worktree.json),
//      wires the
//      worktree: env files (always links) and the dev entry in both the
//      worktree's and the main checkout's .claude/launch.json — then notifies
//      and prints the full briefing.
//      Without a config it prints a reserved-ports briefing and writes nothing.
//
// Project discovery is findParentMarker from worktree-ports.mjs — ONE walk-up
// routine for both allocation identity and config lookup.
//
// Failure policy: ALWAYS exit 0. Failures log to $LOG and surface via macOS
// notification. A non-zero exit would block Claude session start.

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, readFileSync, mkdirSync,
  appendFileSync, statSync, unlinkSync, symlinkSync,
} from 'node:fs';
import { join, dirname, basename, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findParentMarker } from './worktree-ports.mjs';
import { adapter } from '../core/drivers.mjs';
import { registerWorktreeLaunch, writeWorktreeLaunch, removeWorktreeLaunch, sweepLaunchEntries, launchNameFor } from '../core/launch.mjs';
import { findWorktreeConfig, devScriptOf, WORKTREE_CONFIG } from '../core/worktree-config.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const COGYARD_HOME = process.env.COGYARD_HOME || join(homedir(), '.cogyard');
const LOG = join(COGYARD_HOME, 'logs', 'worktree-hook.log');
const ALLOCATOR = join(SCRIPT_DIR, 'worktree-ports.mjs');
const TASKS_CLI = join(SCRIPT_DIR, '..', 'cli', 'tasks.mjs');
const WT_EXPLICIT = !!process.argv[2];   // argv = a human/skill asked; env = the automatic hook

// The chat's own folder, from the JSON Claude Code writes to a hook's stdin.
// Only for the automatic form, and never waits on a terminal: a hand run with no
// argument and a keyboard on stdin would otherwise hang. The time limit is for a
// caller that leaves stdin open without writing; Claude Code closes it.
async function chatFolderFromStdin() {
  if (WT_EXPLICIT || process.stdin.isTTY) return null;
  let timer;
  const read = (async () => { let raw = ''; for await (const c of process.stdin) raw += c; return raw; })();
  const limit = new Promise((r) => { timer = setTimeout(() => r(null), 1000); });
  let raw = null;
  try { raw = await Promise.race([read, limit]); } catch { /* unreadable stdin = no signal */ }
  clearTimeout(timer);
  if (raw === null) { process.stdin.destroy(); return null; }
  try {
    const cwd = JSON.parse(raw)?.cwd;
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch { return null; }
}

// A stdin cwd counts only when it is inside a worktree; it is cut back to the
// worktree's own folder (the highest folder the driver still calls a worktree),
// so a chat started in a subfolder wires the worktree and reserves the same port
// row. Anything else keeps today's $CLAUDE_PROJECT_DIR.
function worktreeFromChatFolder(folder) {
  if (!folder) return null;
  let dir = resolve(folder);
  if (!adapter.worktree.detect(dir)) return null;
  while (dirname(dir) !== dir && adapter.worktree.detect(dirname(dir))) dir = dirname(dir);
  return dir;
}

const WT_RAW = process.argv[2]
  || worktreeFromChatFolder(await chatFolderFromStdin())
  || process.env.CLAUDE_PROJECT_DIR || '';
// Absolute from here on. Everything downstream — worktree.detect's string match,
// the allocator's registry key, findParentMarker's walk-up, and the briefing's own
// re-run line — assumes an absolute path, so a relative one (`.`, `../foo`) used to
// fall out of the detect gate below and no-op in silence. `resolve` only: it does
// NOT dereference symlinks, so an absolute path arrives byte-identical and keeps
// matching its existing ~/.cogyard/ports.json row.
const WT = WT_RAW ? resolve(WT_RAW) : '';

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

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// --- the driver's logo, for any session ---------------------------------------
// A plugin install runs no install step, so this is where a plugin user's
// machine first gets the driver's logo (the Plan/Tasks status line). Before the
// worktree gates, because it is not about worktrees. Detached and unwaited:
// the download must never hold up a session start. cli/driver-logo.mjs does
// nothing once the logo is there.
try {
  if (adapter.liveState?.logoSource) {
    spawn(process.execPath, [join(SCRIPT_DIR, '..', 'cli', 'driver-logo.mjs')], { detached: true, stdio: 'ignore' }).unref();
  }
} catch { /* a missing logo only means the status line shows none */ }

// --- gates -------------------------------------------------------------------

if (!WT) process.exit(0);
// Only act inside one of the active driver's worktrees (the adapter's
// worktree.detect decides). No agent active → nothing to wire.
//
// Say so rather than exiting mutely: a caller who is told nothing reads exit 0 as
// "wired", and then discovers otherwise when a dev server binds the wrong port or
// the task-store link is missing. Exit code stays 0 — the always-exit-0 policy is what keeps a
// broken hook from blocking Claude session start.
// Only the EXPLICIT form speaks. As a SessionStart hook the path comes from
// $CLAUDE_PROJECT_DIR and fires on every session, most of them in an ordinary
// checkout — printing there would put this block in front of every session start.
// An argv path is somebody asking for the wiring, and they are owed an answer.
const wtInfo = adapter.worktree.detect(WT);
if (!wtInfo) {
  log(`not a worktree, nothing wired: ${WT}`);
  if (WT_EXPLICIT) {
    process.stdout.write(`cogyard: nothing to wire — this is not a Claude worktree.

  path given : ${WT_RAW}
  resolved   : ${WT}

This hook only acts inside <repo>/.claude/worktrees/<name>. Nothing was written:
no ports reserved, no env files, no link to the task store.

If you meant to wire a worktree, run it from inside one:
  cogyard hook session-start .
`);
  }
  process.exit(0);
}

// --- task-store link automount (.cogyard/tasks) — all worktrees, ports-unrelated -------------

try {
  const out = execFileSync('node', [TASKS_CLI, 'mount'], { cwd: WT, stdio: ['ignore', 'pipe', 'pipe'] });
  logRaw(out);
} catch (e) {
  logRaw(e.stdout); logRaw(e.stderr); // never blocks the session
}

// --- allocate — universal reservation -------------------------------

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
if (!backend || !frontend) failSoft(`could not parse allocator JSON: ${JSON.stringify(alloc)}`);

// --- discovery: one routine, shared with the allocator -------------------------

const parent = findParentMarker(WT);
const projectRoot = parent ? parent.parentDir : wtInfo.parentRepo;
const configPath = findWorktreeConfig(projectRoot)?.path ?? null;

// --- tunnel follow (optional) --------------------------------------------------
// If this project is tunnel-enabled with follow_worktrees on (cli/tunnel.mjs),
// repoint its Cloudflare tunnel at THIS worktree's port so the stable
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

if (!configPath) {
  log(`reserved (no config) ${basename(projectRoot)}/${worktreeName} → backend=:${backend} frontend=:${frontend}`);
  process.stdout.write(`=== Worktree ports (reserved) ===

Project       : ${basename(projectRoot)}
Worktree      : ${worktreeName}
Reserved ports: backend = ${backend}, frontend = ${frontend}

Every Claude worktree gets a reserved port pair so parallel worktrees never
collide. This project has no ${WORKTREE_CONFIG}, so no env files
were written. If you start any server in this worktree, bind it to the ports
above. For automatic env-file/launch.json wiring, add ${WORKTREE_CONFIG}
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
  // null = the project reserves ports but has no dev server (task 162).
  const devScript = devScriptOf(cfg);
  const launchName = cfg.launch_name ?? 'dev';
  const previewPortVar = cfg.preview_port_var ?? 'FRONTEND_PORT';
  const portVars = cfg.port_vars ?? {};

  // Resolve port assignments by which side of the allocation each var maps to.
  // They feed launch.json's port and the briefing — never .env.worktree, which
  // carries no ports (task 143).
  const portValueFor = { backend, frontend };
  const portAssignments = {};
  for (const [varName, side] of Object.entries(portVars)) {
    if (!(side in portValueFor)) throw new Error(`port_vars[${varName}] must map to 'backend' or 'frontend'; got '${side}'`);
    portAssignments[varName] = portValueFor[side];
  }
  // The preview port only matters when there is a dev server to open a tab on.
  if (devScript && !(previewPortVar in portAssignments)) throw new Error(`preview_port_var ${previewPortVar} not declared in port_vars`);
  const previewPort = devScript ? portAssignments[previewPortVar] : null;

  // 1. env files — always a link to the project root's file, never a copy.
  //
  // `copy` and `merge` (a real file written per worktree) were removed in task
  // 211. A copy is one more place a secret lives and drifts, and writing it
  // (temp file + rename) silently replaced a link the owner had put at the
  // target — which is how a project keeps its env files outside the repo. A
  // config still naming either is refused with the fix rather than quietly
  // relinked, so nobody loses a hand-edited worktree file without being told.
  for (const spec of cfg.env_files ?? []) {
    const srcRel = spec.source;
    const tgtRel = spec.target;
    if (!srcRel || !tgtRel) throw new Error(`env_files entry missing source/target: ${JSON.stringify(spec)}`);
    if (spec.strategy !== undefined && spec.strategy !== 'symlink') {
      throw new Error(`env_files strategy '${spec.strategy}' is no longer supported (${tgtRel}): every env file is linked from the project root. Delete "strategy" from that entry in ${configPath}.`);
    }

    const srcAbs = resolve(projectRoot, srcRel);
    // Don't realpath the target — that would follow a leftover symlink to its
    // destination outside the worktree and trip the escape guard below.
    const tgtAbs = normalize(join(WT, tgtRel));
    if (tgtAbs !== WT && !tgtAbs.startsWith(WT + '/')) throw new Error(`env_files target ${tgtRel} escapes worktree path`);

    // Source missing is non-fatal — many projects don't have .env.production locally.
    if (!isFile(srcAbs)) continue;

    mkdirSync(dirname(tgtAbs), { recursive: true });
    try { unlinkSync(tgtAbs); } catch { /* absent or a dir — symlinkSync will surface a real problem */ }
    symlinkSync(srcAbs, tgtAbs);
  }

  // 2. launch.json — the same entry in two files (core/launch.mjs says why).
  //
  // The preview tool reads only the chat's current folder's file (task 230), so
  // a chat inside this worktree needs the worktree's own file, and a chat in the
  // main checkout needs the main checkout's. Task 121 had deleted the worktree's
  // file as unreadable; that was the August reading of the rule, and it left
  // every chat inside a worktree with no way to start its server.
  const previewName = launchNameFor(worktreeName);
  // No dev command → no entry in either file. Sweep instead, which also drops
  // one this worktree got before its config stopped naming a dev command.
  let swept;
  if (devScript) {
    const entry = { worktree: WT, name: previewName, devScript, port: previewPort };
    swept = registerWorktreeLaunch(projectRoot, entry);
    writeWorktreeLaunch(WT, entry);
  } else {
    swept = sweepLaunchEntries(projectRoot, { except: WT });
    if (removeWorktreeLaunch(WT)) log(`removed ${join(WT, '.claude', 'launch.json')} (no dev server)`);
  }
  if (swept.length) log(`launch.json swept ${swept.length} entr${swept.length === 1 ? 'y' : 'ies'}: ${swept.join(', ')}`);

  // 3. Notify + full briefing.
  log(`${projectName}/${worktreeName} → backend=:${backend} frontend=:${frontend}${devScript ? '' : ' (no dev server)'}`);

  if (!devScript) {
    notify(`Worktree ready: ${worktreeName}`, `Ports reserved: ${backend} / ${frontend} (no dev server)`);
    briefing = `=== Worktree dev environment ===

Project       : ${projectName}
Worktree      : ${worktreeName}
Worktree path : ${WT}
Project root  : ${projectRoot}

Reserved ports: backend = ${backend}, frontend = ${frontend}

# No dev server

${WORKTREE_CONFIG} names no dev_script, so this project has no dev server to
start and no preview entry was registered. That is deliberate — it is how a
project built outside npm (an Xcode app, firmware) is wired. If you start any
server in this worktree anyway, bind it to the ports above: a script asks
\`cogyard env ports\`, which reads ~/.cogyard/ports.json.

Reference: docs/WORKTREE-PORTS.md
=== end allocation ===
`;
  } else {
    notify(`Worktree ready: ${worktreeName}`, `Frontend: http://localhost:${previewPort}\nBackend:  :${backend}`);

    briefing = `=== Worktree dev environment ===

Project       : ${projectName}
Worktree      : ${worktreeName}
Worktree path : ${WT}
Project root  : ${projectRoot}

Allocated ports (do NOT collide with the parent project's dev servers):
  backend  port = ${backend}
  frontend port = ${frontend}

The SessionStart hook has set up:
  - ${WT}/.env.* (links to the project root's env files — editing one edits that file)
  - ${WT}/.claude/launch.json (entry "${previewName}" — the file preview_start reads from inside this worktree)
  - ${projectRoot}/.claude/launch.json (the same entry, for a chat in the main checkout)

# Dev server

  preview_start name="${previewName}"

Spawns ${devScript} in this worktree, bound to the allocated ports above.
When the work has something to look at, start it and LEAVE IT RUNNING until this
branch merges: the owner checks a worktree after the work by clicking its
frontend port in the Worktrees tab, so don't stop it before the merge, and stop
it after the merge. Work with nothing to look at (docs, hooks, CLI, a native
app) needs no server. Nothing restarts a server that dies.

preview_start reads .claude/launch.json from the chat's CURRENT folder only
(task 230). So start it while the chat is inside this worktree, or from the
main checkout; both files carry the entry.

If that name is not found, do NOT hand-write an entry to get around it — that
is a known failure that seventeen sessions papered over instead of reporting
(task 121). It means this hook has not run for this worktree (it does not
re-fire after EnterWorktree). Run it from inside the worktree, then retry:

  cogyard hook session-start ${WT}

Why the name is "${previewName}" and not "${launchName}": the main checkout's
file lists every worktree, so each needs a name of its own, and the worktree's
file uses the same one so the briefing never depends on which file is read.
The hook removes both once this worktree is gone. Ports do NOT come from
either file, nor from .env.worktree (which carries none): a dev script asks
\`cogyard env ports\`, which reads ~/.cogyard/ports.json. The entry only tells
the preview tool what to run and which port to open a tab on.

# Direct URLs

  Frontend : http://localhost:${previewPort}
  Backend  : http://localhost:${backend}

# DO NOT
  - Hand-edit .claude/launch.json — the hook rewrites it at every
    session startup.

Reference: docs/WORKTREE-PORTS.md
=== end allocation ===
`;
  }
} catch (e) {
  failSoft(`worktree setup failed: ${e.message}`);
}

process.stdout.write(briefing);
process.exit(0);
