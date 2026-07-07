#!/usr/bin/env node
// env.mjs — environment detection + per-task claim helpers for the v2 task system.
// Used by the bd-write-task skill's Pickup checklist. See _tasks/037-task-system-v2.md.
//
// Subcommands:
//   env.mjs detect                              -> JSON of {planet, ports, hostname, worktree, branch, db}
//   env.mjs port-owner <port>                   -> JSON of {port, pid, cwd, worktree, matches}
//   env.mjs claim <task-file> <session-id>      -> set env.claimed_at + env.claimed_by_session in frontmatter,
//                                                  and record env.worktree + env.branch (the durable "where was
//                                                  this task worked" trail — release does NOT clear those)
//   env.mjs release <task-file>                 -> clear env.claimed_at + env.claimed_by_session ONLY
//   env.mjs --help

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, basename, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// Claims-ledger side effect: claim/release also append an event to
// ~/.cogyard/usage/claims.jsonl — the durable task↔session join the usage
// collector uses. A ledger failure must NEVER fail the claim itself.
async function recordClaimEvent(event, taskFile, sessionId) {
  try {
    const { appendClaimEvent, resolveProjectForPath } = await import('../core/usage.mjs');
    const m = basename(taskFile).match(/^(\d+)/);
    appendClaimEvent({
      event,
      project: resolveProjectForPath(findRepoRoot() || process.cwd()),
      taskId: m ? Number(m[1]) : null,
      sessionId: sessionId || null,
    });
  } catch { /* best-effort only */ }
}

function fail(msg, code = 1) {
  process.stderr.write(`env.mjs: ${msg}\n`);
  process.exit(code);
}

function tryExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

function findRepoRoot(start = process.cwd()) {
  return tryExec('git rev-parse --show-toplevel', { cwd: start });
}

function readPlanet(repoRoot) {
  // .planet may live at the repo root or anywhere up the path (Claude Code worktrees can sit several levels deep
  // inside the original clone; the .planet file is always at the original clone's root).
  let dir = repoRoot;
  while (dir && dir !== '/' && !dir.endsWith(':')) {
    const path = join(dir, '.planet');
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const env = {};
      for (const line of raw.split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return { path, env };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Ports registry (~/.cogyard/ports.json), keyed by absolute worktree path.
// Projects without a .planet (no worktree-config.json) still get a reserved
// port pair from the SessionStart/EnterWorktree hook — those live here, not in
// a .planet file. Same COGYARD_HOME resolution as worktree-ports.mjs.
function readPortsAllocation(worktreePath) {
  const home = process.env.COGYARD_HOME || join(homedir(), '.cogyard');
  const registry = join(home, 'ports.json');
  if (!existsSync(registry)) return null;
  try {
    const data = JSON.parse(readFileSync(registry, 'utf8'));
    return data.allocations?.[worktreePath] || null;
  } catch {
    return null;
  }
}

function detect() {
  const repoRoot = findRepoRoot();
  if (!repoRoot) fail('not in a git repo');

  const branch = tryExec('git branch --show-current', { cwd: repoRoot }) || null;
  const worktreeName = repoRoot.split('/').pop();

  const planetInfo = readPlanet(repoRoot);
  const planet = planetInfo?.env?.PLANET_NAME || null;
  // Ports: .planet wins (planet projects); else fall back to the reserved-ports
  // registry so task-named worktrees in plain projects still report their pair.
  const alloc = readPortsAllocation(repoRoot);
  const backendPort = planetInfo?.env?.PORT ? Number(planetInfo.env.PORT) : (alloc?.backend ?? null);
  const frontendPort = planetInfo?.env?.FRONTEND_PORT ? Number(planetInfo.env.FRONTEND_PORT) : (alloc?.frontend ?? null);
  const hostname = planet ? `${planet}.told` : (alloc?.hostname ?? null);

  return {
    repoRoot,
    worktree: worktreeName,
    branch,
    planet,
    ports: { backend: backendPort, frontend: frontendPort },
    hostname,
    db: 'development', // best guess; the task can override per its needs
  };
}

function portOwner(port) {
  if (!port) fail('port required');
  const pid = tryExec(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t | head -n1`);
  if (!pid) return { port: Number(port), pid: null, cwd: null, worktree: null, matches: false };

  // -d cwd shows the cwd line; tail -1 + awk for last column.
  const cwd = tryExec(`lsof -p ${pid} -d cwd -Fn | grep '^n' | head -n1 | sed 's/^n//'`);
  const here = findRepoRoot();
  const matches = !!(cwd && here && (cwd === here || cwd.startsWith(here + '/')));
  const worktree = cwd ? cwd.split('/').pop() : null;
  return { port: Number(port), pid: Number(pid), cwd, worktree, matches };
}

// Minimal YAML frontmatter editor: we only need to set / clear two known keys nested under env:.
// We treat the frontmatter as text and surgically replace the lines, preserving everything else.
function editFrontmatter(taskFile, mutator) {
  const content = readFileSync(taskFile, 'utf8');
  if (!content.startsWith('---\n')) fail(`${taskFile} has no YAML frontmatter`);
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) fail(`${taskFile} frontmatter not terminated`);
  const fmText = content.slice(4, end);
  const body = content.slice(end + 5);
  const newFm = mutator(fmText);
  const tmpPath = join(tmpdir(), `task-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmpPath, `---\n${newFm}\n---\n${body}`);
  renameSync(tmpPath, taskFile);
}

function setEnvFields(fmText, fields) {
  // Find the env: block and the keys within it; replace or insert.
  const lines = fmText.split('\n');
  let envStart = -1;
  let envEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^env:\s*$/.test(lines[i])) {
      envStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (!/^\s/.test(lines[j]) && lines[j].length > 0) {
          envEnd = j;
          break;
        }
      }
      break;
    }
  }
  if (envStart === -1) {
    // No env block — append one.
    const block = ['env:'];
    for (const [k, v] of Object.entries(fields)) {
      block.push(`  ${k}: ${v === null ? 'null' : v}`);
    }
    return [...lines, ...block].join('\n');
  }

  // Walk env block lines (envStart+1 .. envEnd-1), update or insert each field.
  const envLines = lines.slice(envStart + 1, envEnd);
  for (const [k, v] of Object.entries(fields)) {
    const formatted = v === null ? 'null' : v;
    const re = new RegExp(`^(\\s+)${k}:\\s.*$`);
    let found = false;
    for (let i = 0; i < envLines.length; i++) {
      const m = envLines[i].match(re);
      if (m) {
        envLines[i] = `${m[1]}${k}: ${formatted}`;
        found = true;
        break;
      }
    }
    if (!found) envLines.push(`  ${k}: ${formatted}`);
  }
  return [...lines.slice(0, envStart + 1), ...envLines, ...lines.slice(envEnd)].join('\n');
}

function readEnvField(fmText, key) {
  // Look for the key inside the env: block specifically.
  const lines = fmText.split('\n');
  let inEnv = false;
  for (const line of lines) {
    if (/^env:\s*$/.test(line)) { inEnv = true; continue; }
    if (inEnv && /^[^\s#]/.test(line)) inEnv = false; // exited env block
    if (inEnv) {
      const m = line.match(new RegExp(`^\\s+${key}:\\s*(.*)$`));
      if (m) {
        const v = m[1].trim();
        if (v === 'null' || v === '~' || v === '') return null;
        return v.replace(/^['"]|['"]$/g, '');
      }
    }
  }
  return null;
}

// Who is claiming — the human identity teammates see. Self-reported,
// advisory (v1 has no auth): env override, else git identity,
// else OS user.
function resolveClaimant(cwd) {
  return process.env.COGYARD_USER
    || tryExec('git config user.name', { cwd: cwd || process.cwd() })
    || process.env.USER
    || null;
}

// Team-store plumbing. A store is "remote-backed" when the canonical
// _tasks dir (symlink resolved) is a git repo with an origin AND a tasks branch
// — the same conditions tasks.mjs `sync` keys on. Local-only stores get NONE of
// the pull/push behavior below: single-user flow is unchanged.
function storeInfo(taskFile) {
  const dir = dirname(realpathSync(taskFile));
  const inRepo = !!tryExec('git rev-parse --show-toplevel', { cwd: dir });
  if (!inRepo) return { dir, remote: false };
  const remotes = (tryExec('git remote', { cwd: dir }) || '').split('\n');
  const hasTasksBranch = !!tryExec('git rev-parse --verify --quiet refs/heads/tasks', { cwd: dir });
  return { dir, remote: remotes.includes('origin') && hasTasksBranch };
}

function storePull(store) {
  if (!store.remote) return;
  // Best-effort: offline must not block claiming (the push below will surface
  // real divergence). --autostash tolerates uncommitted task edits in the store.
  tryExec('git pull --rebase --autostash origin tasks', { cwd: store.dir });
}

// Commit + push ONLY the task file. Returns 'pushed' | 'nothing' | 'lost' |
// 'push-failed'. 'lost' = a concurrent commit touched the same file and the
// rebase conflicted (someone else claimed): our commit is unwound, the file is
// restored to the remote's truth, and ONLY that file is touched.
function storePushFile(store, abs, message) {
  if (!store.remote) return 'nothing';
  const rel = relative(store.dir, realpathSync(abs));
  if (tryExec(`git add -- ${JSON.stringify(rel)}`, { cwd: store.dir }) === null) return 'push-failed';
  if (tryExec(`git diff --cached --quiet -- ${JSON.stringify(rel)}`, { cwd: store.dir }) !== null) return 'nothing';
  if (tryExec(`git commit -m ${JSON.stringify(message)} -- ${JSON.stringify(rel)}`, { cwd: store.dir }) === null) return 'push-failed';
  if (tryExec('git push origin tasks', { cwd: store.dir }) !== null) return 'pushed';
  if (tryExec('git pull --rebase --autostash origin tasks', { cwd: store.dir }) !== null) {
    return tryExec('git push origin tasks', { cwd: store.dir }) !== null ? 'pushed' : 'push-failed';
  }
  // Rebase conflict on our claim commit — we lost the race. Unwind touching
  // only our file: abort, drop the commit (keep the edit staged), restore the
  // file to the remote's version, then fast-forward.
  tryExec('git rebase --abort', { cwd: store.dir });
  tryExec('git reset --soft HEAD~1', { cwd: store.dir });
  tryExec(`git restore --source origin/tasks --staged --worktree -- ${JSON.stringify(rel)}`, { cwd: store.dir });
  tryExec('git pull --rebase --autostash origin tasks', { cwd: store.dir });
  return 'lost';
}

function refuseClaim(abs, fmText, sessionId) {
  process.stderr.write(JSON.stringify({
    error: 'already_claimed',
    taskFile: abs,
    claimed_at: readEnvField(fmText, 'claimed_at'),
    claimed_by: readEnvField(fmText, 'claimed_by'),
    claimed_by_session: readEnvField(fmText, 'claimed_by_session'),
    attempted_by: sessionId,
    hint: 'pass --force to override (will displace the other session\'s claim)',
  }, null, 2) + '\n');
  process.exit(2);
}

async function claim(taskFile, sessionId, opts = {}) {
  if (!taskFile || !sessionId) fail('usage: env.mjs claim <task-file> <session-id> [--force]');
  const abs = resolve(taskFile);
  const store = storeInfo(abs);

  // Remote-backed stores (team model): pull → claim → push, so the
  // claim is visible to teammates immediately and a lost race surfaces as
  // "claimed by <name>", never a rebase conflict. Up to 3 attempts; each
  // attempt re-reads the file AFTER pulling, so the check runs on fresh state.
  const attempts = store.remote ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    storePull(store);
    const content = readFileSync(abs, 'utf8');
    const end = content.indexOf('\n---\n', 4);
    if (end !== -1) {
      const fmText = content.slice(4, end);
      const existingClaim = readEnvField(fmText, 'claimed_at');
      const existingBy = readEnvField(fmText, 'claimed_by_session');
      if (existingClaim && existingBy && existingBy !== sessionId && !opts.force) {
        refuseClaim(abs, fmText, sessionId);
      }
    }
    const now = new Date().toISOString();
    // Besides the claim lock, record WHERE the work happens. These two are the
    // durable trail (worktrees/sessions outlive the claim — they're kept as the
    // feature's history), so release() deliberately leaves them in place.
    const here = findRepoRoot();
    const worktree = here ? here.split('/').pop() : null;
    const branch = here ? tryExec('git branch --show-current', { cwd: here }) || null : null;
    const claimedBy = resolveClaimant(here);
    const fields = { claimed_at: now, claimed_by_session: sessionId };
    if (claimedBy) fields.claimed_by = claimedBy;
    if (worktree) fields.worktree = worktree;
    if (branch) fields.branch = branch;
    editFrontmatter(abs, (fm) => setEnvFields(fm, fields));
    const outcome = storePushFile(store, abs, `claim ${basename(abs)}${claimedBy ? ` by ${claimedBy}` : ''}`);
    if (outcome === 'lost') continue; // file now holds the winner's claim; next attempt re-checks it
    if (outcome === 'push-failed') process.stderr.write('env.mjs: warning — claim written locally but push failed; run `cogyard tasks sync push` when the remote is reachable\n');
    process.stdout.write(JSON.stringify({ taskFile: abs, claimed_at: now, claimed_by: claimedBy, claimed_by_session: sessionId, worktree, branch }) + '\n');
    return recordClaimEvent('claim', abs, sessionId);
  }
  // 3 lost races in a row: the file now shows the current holder — refuse with it.
  const content = readFileSync(abs, 'utf8');
  const end = content.indexOf('\n---\n', 4);
  refuseClaim(abs, end !== -1 ? content.slice(4, end) : '', sessionId);
}

async function release(taskFile) {
  if (!taskFile) fail('usage: env.mjs release <task-file>');
  const abs = resolve(taskFile);
  const store = storeInfo(abs);
  storePull(store);
  // Capture the releasing session BEFORE the frontmatter is cleared — the
  // claims ledger needs it to close this session's claim window.
  let sessionId = null;
  const content = readFileSync(abs, 'utf8');
  const end = content.indexOf('\n---\n', 4);
  if (end !== -1) sessionId = readEnvField(content.slice(4, end), 'claimed_by_session');
  editFrontmatter(abs, (fm) => setEnvFields(fm, { claimed_at: 'null', claimed_by: 'null', claimed_by_session: 'null' }));
  const outcome = storePushFile(store, abs, `release ${basename(abs)}`);
  if (outcome === 'lost') {
    // Someone touched the file concurrently; the release edit was unwound.
    // Redo it on the fresh state and push again (best-effort second try).
    editFrontmatter(abs, (fm) => setEnvFields(fm, { claimed_at: 'null', claimed_by: 'null', claimed_by_session: 'null' }));
    if (storePushFile(store, abs, `release ${basename(abs)}`) === 'push-failed') {
      process.stderr.write('env.mjs: warning — release written locally but push failed; run `cogyard tasks sync push`\n');
    }
  } else if (outcome === 'push-failed') {
    process.stderr.write('env.mjs: warning — release written locally but push failed; run `cogyard tasks sync push`\n');
  }
  process.stdout.write(JSON.stringify({ taskFile: abs, released: true }) + '\n');
  return recordClaimEvent('release', abs, sessionId);
}

function help() {
  process.stdout.write(`env.mjs — environment detection + per-task claim helpers

Subcommands:
  detect                              JSON of current env (planet, ports, worktree, branch)
  port-owner <port>                   JSON identifying which worktree owns a TCP port
  claim <task-file> <session-id>      Set env.claimed_at + env.claimed_by_session; record
                                      env.worktree + env.branch (durable, survives release)
  release <task-file>                 Clear env.claimed_at + env.claimed_by_session only —
                                      env.worktree/env.branch stay as the worked-in record

Reads .planet at repo root (or up to 2 parents). Tolerates missing .planet (returns nulls).
`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'detect':
    process.stdout.write(JSON.stringify(detect(), null, 2) + '\n');
    break;
  case 'port-owner':
    process.stdout.write(JSON.stringify(portOwner(rest[0]), null, 2) + '\n');
    break;
  case 'claim': {
    const force = rest.includes('--force');
    const args = rest.filter((a) => a !== '--force');
    await claim(args[0], args[1], { force });
    break;
  }
  case 'release':
    await release(rest[0]);
    break;
  case '--help':
  case '-h':
  case undefined:
    help();
    break;
  default:
    fail(`unknown subcommand: ${cmd}. Run env.mjs --help`);
}
