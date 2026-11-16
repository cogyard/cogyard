#!/usr/bin/env node
// env.mjs — environment detection + per-task claim helpers for the v2 task system.
// Used by the bd-write-task skill's Pickup checklist. See _tasks/037-task-system-v2.md.
//
// Subcommands:
//   env.mjs detect                              -> JSON of {repoRoot, worktree, branch, ports, hostname, db}
//   env.mjs ports [--shell]                     -> the ports a dev server HERE should bind, under the
//                                                  names this project declares (task 131)
//   env.mjs port-owner <port>                   -> JSON of {port, pid, cwd, worktree, matches}
//   env.mjs claim <task-file> <session-id>      -> set env.claimed_at + env.claimed_by + env.branch in the task
//                                                  file, and record this machine's worktree + session in
//                                                  $COGYARD_HOME/claims.json (task 190 — they are not team data).
//                                                  Only from the main checkout or the task's own
//                                                  task-<id>-… worktree (task 234)
//   env.mjs release <task-file>                 -> clear the claim; keep the branch and worktree records
//   env.mjs where <task-file>                   -> JSON of claim, branch, worktree and session for a task
//   env.mjs --help

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { devPorts, shellLines } from '../core/ports.mjs';
import { loadPortAllocations } from '../core/worktrees.mjs';
import { localClaim, setLocalClaim } from '../core/claims.mjs';
import { readTaskFile } from '../core/frontmatter.mjs';
import { normalizeTaskId } from '../core/validate.mjs';
import { gitIdentityFlags } from '../core/exec.mjs';

// The task's id from its frontmatter, else null (claims.mjs then keys by the
// filename's id).
const topLevelId = (fmText) => ((fmText || '').match(/^id:\s*['"]?([^'"\s#]+)/m) || [])[1] || null;
// The session holding a claim: this machine's record, else a not-yet-migrated
// task file's own field.
function sessionOf(abs, fmText) {
  const local = localClaim(abs, topLevelId(fmText));
  return local && 'session' in local ? local.session : readEnvField(fmText, 'claimed_by_session');
}

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

// A task-file argument as an absolute path, or a one-line failure naming it —
// a missing file otherwise surfaced as a raw ENOENT stack trace (task 209).
function taskPath(taskFile) {
  const abs = resolve(taskFile);
  if (!existsSync(abs)) fail(`no such task file: ${abs}`);
  return abs;
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

// Ports registry (~/.cogyard/ports.json), keyed by absolute worktree path.
// Every agent worktree gets a reserved port pair from the SessionStart /
// EnterWorktree hook, and it lives only here. The reader is core's, so this and `env ports` can never read
// the registry two different ways.
function readPortsAllocation(worktreePath) {
  return loadPortAllocations()[worktreePath] || null;
}

function detect() {
  const repoRoot = findRepoRoot();
  // Outside a git repo there is no checkout to describe — say so in the same
  // JSON shape (every field null) rather than failing, so a caller parsing it
  // gets an answer everywhere.
  if (!repoRoot) {
    return { repoRoot: null, worktree: null, branch: null, ports: { backend: null, frontend: null }, hostname: null, db: 'development' };
  }

  const branch = tryExec('git branch --show-current', { cwd: repoRoot }) || null;
  const worktreeName = repoRoot.split('/').pop();

  // Ports come from the reserved-ports registry; a main checkout has no
  // allocation and reports nulls.
  const alloc = readPortsAllocation(repoRoot);

  return {
    repoRoot,
    worktree: worktreeName,
    branch,
    ports: { backend: alloc?.backend ?? null, frontend: alloc?.frontend ?? null },
    hostname: alloc?.hostname ?? null,
    db: 'development', // best guess; the task can override per its needs
  };
}

// `env ports` — the one question a dev script asks: which ports should a server
// started HERE bind, and what does this project call them? The rule lives in
// core/ports.mjs; this is the printer.
//
// A problem prints NOTHING on stdout and exits non-zero, in both modes. That is
// the whole promise: a caller doing `eval "$(cogyard env ports --shell)"` must
// never receive a port that was guessed. The diagnosis goes to stderr, where a
// human reads it and an eval cannot.
function ports({ shell }) {
  const r = devPorts();
  if (r.problem) {
    process.stderr.write(`env.mjs ports: ${r.problem.message}\n`);
    process.exit(1);
  }
  if (!r.inWorktree) {
    // Nothing to collide with here, so the caller's own defaults are correct and
    // this prints no assignment that would override them.
    if (!shell) {
      process.stdout.write('not in a worktree — no allocation applies here; this project\'s own defaults stand\n');
    }
    return;
  }
  if (shell) {
    process.stdout.write(shellLines(r.assignments).join('\n') + '\n');
    return;
  }
  const width = Math.max(...r.assignments.map((a) => a.name.length));
  const lines = r.assignments.map((a) => `  ${a.name.padEnd(width)} = ${a.port}  (${a.side})`);
  process.stdout.write(`${basename(r.projectRoot)} / ${basename(r.worktreePath)}\n${lines.join('\n')}\n`);
}

function portOwner(port) {
  // A whole number 1–65535, or the usage line — anything else used to print a
  // null result as if a lookup ran, and reached the shell command below (task 209).
  if (!/^\d+$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) {
    fail(`usage: env.mjs port-owner <port> — ${port ? `"${port}" is not a port number (1–65535)` : 'port required'}`);
  }
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
// task dir (link resolved) is a git repo with an origin AND a tasks branch
// — the same conditions tasks.mjs `sync` keys on. Local-only stores get none of
// the pull/push behavior below, but a store that is a git repo still gets the
// claim or release COMMITTED (task 222): left uncommitted, the edit sits
// pending under this chat's claim, and every other chat's `sync push` refuses it.
function storeInfo(taskFile) {
  const dir = dirname(realpathSync(taskFile));
  const inRepo = !!tryExec('git rev-parse --show-toplevel', { cwd: dir });
  if (!inRepo) return { dir, inRepo: false, remote: false };
  const remotes = (tryExec('git remote', { cwd: dir }) || '').split('\n');
  const hasTasksBranch = !!tryExec('git rev-parse --verify --quiet refs/heads/tasks', { cwd: dir });
  return { dir, inRepo: true, remote: remotes.includes('origin') && hasTasksBranch };
}

function storePull(store) {
  if (!store.remote) return;
  // Best-effort: offline must not block claiming (the push below will surface
  // real divergence). --autostash tolerates uncommitted task edits in the store.
  tryExec(`git ${gitIdentityFlags(store.dir)}pull --rebase --autostash origin tasks`, { cwd: store.dir });
}

// Commit ONLY the task file, then push it on a remote-backed store. Returns
// 'pushed' | 'committed' (local-only store) | 'nothing' | 'lost' |
// 'push-failed' | 'commit-failed'. 'lost' = a concurrent commit touched the
// same file and the rebase conflicted (someone else claimed): our commit is
// unwound, the file is restored to the remote's truth, and ONLY that file is touched.
function storePushFile(store, abs, message) {
  if (!store.inRepo) return 'nothing';
  const rel = relative(store.dir, realpathSync(abs));
  const identity = gitIdentityFlags(store.dir);
  const failed = store.remote ? 'push-failed' : 'commit-failed';
  if (tryExec(`git add -- ${JSON.stringify(rel)}`, { cwd: store.dir }) === null) return failed;
  if (tryExec(`git diff --cached --quiet -- ${JSON.stringify(rel)}`, { cwd: store.dir }) !== null) return 'nothing';
  if (tryExec(`git ${identity}commit -m ${JSON.stringify(message)} -- ${JSON.stringify(rel)}`, { cwd: store.dir }) === null) return failed;
  if (!store.remote) return 'committed';
  if (tryExec('git push origin tasks', { cwd: store.dir }) !== null) return 'pushed';
  if (tryExec(`git ${identity}pull --rebase --autostash origin tasks`, { cwd: store.dir }) !== null) {
    return tryExec('git push origin tasks', { cwd: store.dir }) !== null ? 'pushed' : 'push-failed';
  }
  // Rebase conflict on our claim commit — we lost the race. Unwind touching
  // only our file: abort, drop the commit (keep the edit staged), restore the
  // file to the remote's version, then fast-forward.
  tryExec('git rebase --abort', { cwd: store.dir });
  tryExec('git reset --soft HEAD~1', { cwd: store.dir });
  tryExec(`git restore --source origin/tasks --staged --worktree -- ${JSON.stringify(rel)}`, { cwd: store.dir });
  tryExec(`git ${identity}pull --rebase --autostash origin tasks`, { cwd: store.dir });
  return 'lost';
}

function refuseClaim(abs, fmText, sessionId) {
  process.stderr.write(JSON.stringify({
    error: 'already_claimed',
    taskFile: abs,
    claimed_at: readEnvField(fmText, 'claimed_at'),
    claimed_by: readEnvField(fmText, 'claimed_by'),
    claimed_by_session: sessionOf(abs, fmText),
    attempted_by: sessionId,
    hint: 'pass --force to override (will displace the other session\'s claim)',
  }, null, 2) + '\n');
  process.exit(2);
}

// A claim is valid only on an OPEN task (owner, 2026-11-06, task 222): a closed
// task is reopened first, a parked one un-parked. Exit 4, nothing written.
function refuseNotOpen(abs, fmText, status, sessionId) {
  const id = topLevelId(fmText) ?? '<id>';
  const closed = status === 'DONE' || status === 'ENOUGH';
  process.stderr.write(JSON.stringify({
    error: 'not_open',
    taskFile: abs,
    status,
    attempted_by: sessionId,
    hint: closed
      ? `#${id} is ${status}. A claim is valid only on an OPEN task: reopen it first — cogyard tasks reopen ${id} --why "<what the work is>" — then claim. Nothing was written.`
      : `#${id} is ${status}. A claim is valid only on an OPEN task: set it back to OPEN first if it is to be worked, then claim. Nothing was written.`,
  }, null, 2) + '\n');
  process.exit(4);
}

// Is `dir` a linked worktree (not the repo's main checkout)? Asked of git, not
// of a folder layout, so it holds for any agent's worktrees (task 038).
function inLinkedWorktree(dir) {
  const out = tryExec('git rev-parse --path-format=absolute --git-dir --git-common-dir', { cwd: dir });
  if (!out) return false;
  const [gitDir, commonDir] = out.split('\n');
  return !!gitDir && !!commonDir && gitDir !== commonDir;
}

// The worktree a task is worked in is `task-<id>-<slug>` — the name pickup-task
// gives EnterWorktree — and nothing else (task 234). Returns null when `here`
// may claim the task: the main checkout ("work directly on main"), or a
// worktree whose name starts `task-<this task's id>-`, the id compared through
// normalizeTaskId so `task-07-…`, `task-007-…` and `task-028b-…` all match as
// `cogyard tasks find` would. Otherwise returns { worktree, expected }.
function wrongWorktree(abs, here) {
  if (!here || !inLinkedWorktree(here)) return null;
  const worktree = basename(here);
  const stem = basename(abs).replace(/\.md$/, '');
  const fmText = readFileSync(abs, 'utf8').slice(4);
  const taskId = normalizeTaskId(topLevelId(fmText)) ?? normalizeTaskId((stem.match(/^(\d+(?:[._]\d+)?[a-z]?)/) || [])[1]);
  const m = worktree.match(/^task-(\d+(?:[._]\d+)?[a-z]?)(?:-|$)/);
  if (m && taskId != null && normalizeTaskId(m[1]) === taskId) return null;
  return { worktree, expected: `task-${stem}`.slice(0, 64) };
}

function refuseWrongWorktree(abs, wrong, sessionId) {
  process.stderr.write(JSON.stringify({
    error: 'wrong_worktree',
    taskFile: abs,
    worktree: wrong.worktree,
    expected_worktree: wrong.expected,
    attempted_by: sessionId,
    hint: `a task is claimed only from its own worktree, ${wrong.expected}, or from the main checkout. `
      + 'Follow pickup-task Step 5 ("a worktree made outside the process"): leave this one, '
      + `EnterWorktree name=${wrong.expected}, carry the commits over, then claim. Nothing was written.`,
  }, null, 2) + '\n');
  process.exit(3);
}

async function claim(taskFile, sessionId, opts = {}) {
  if (!taskFile || !sessionId) fail('usage: env.mjs claim <task-file> <session-id> [--force] [--any-worktree]');
  // A missing file fails here in one line — wrongWorktree() below reads it (task 209).
  const abs = taskPath(taskFile);

  // Before anything is pulled or written: the right place, or the owner's say-so.
  const wrong = wrongWorktree(abs, findRepoRoot());
  if (wrong && !opts.anyWorktree) refuseWrongWorktree(abs, wrong, sessionId);
  if (wrong) {
    const { agentSession } = await import('../core/drivers.mjs');
    const agent = await agentSession();
    if (agent) {
      process.stderr.write(
        `Claiming a task from ${wrong.worktree} instead of ${wrong.expected} is the owner's call, `
        + `and this was started by ${agent}. Nothing changed.\n`
        + `Hand the owner this command to run from their own terminal:\n\n`
        + `  cd ${findRepoRoot()} && cogyard env claim ${abs} ${sessionId} --any-worktree${opts.force ? ' --force' : ''}\n`);
      process.exit(1);
    }
  }
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
      // A claim is valid only on an OPEN task (task 222). Checked after the
      // pull, so a team store refuses on fresh state; nothing is written.
      const status = (fmText.match(/^status:\s*["']?([A-Za-z]+)/m) || [])[1] || null;
      if (status && status !== 'OPEN') refuseNotOpen(abs, fmText, status, sessionId);
      const existingClaim = readEnvField(fmText, 'claimed_at');
      // Claimed, and not by this session — including a claim made on another
      // machine (a teammate's), which this machine has no session for.
      const existingBy = sessionOf(abs, fmText);
      if (existingClaim && existingBy !== sessionId && !opts.force) {
        refuseClaim(abs, fmText, sessionId);
      }
    }
    const now = new Date().toISOString();
    // Besides the claim lock, record WHERE the work happens — the durable trail
    // (worktrees outlive the claim as the feature's history), so release()
    // leaves it in place. The branch is team data (it lives in the shared code
    // repo) and goes in the task file; the worktree folder and the session are
    // this machine's and go in claims.json (task 190).
    const here = findRepoRoot();
    const worktree = here ? here.split('/').pop() : null;
    const branch = here ? tryExec('git branch --show-current', { cwd: here }) || null : null;
    const claimedBy = resolveClaimant(here);
    const fields = { claimed_at: now };
    if (claimedBy) fields.claimed_by = claimedBy;
    if (branch) fields.branch = branch;
    editFrontmatter(abs, (fm) => setEnvFields(fm, fields));
    setLocalClaim(abs, topLevelId(readFileSync(abs, 'utf8').slice(4)), { ...(worktree ? { worktree } : {}), session: sessionId, at: now });
    const outcome = storePushFile(store, abs, `claim ${basename(abs)}${claimedBy ? ` by ${claimedBy}` : ''}`);
    if (outcome === 'lost') continue; // file now holds the winner's claim; next attempt re-checks it
    if (outcome === 'push-failed') process.stderr.write('env.mjs: warning — claim written locally but push failed; run `cogyard tasks sync push` when the remote is reachable\n');
    if (outcome === 'commit-failed') process.stderr.write(`env.mjs: warning — claim written but not committed; run \`cogyard tasks sync push "claim" -- ${abs}\`\n`);
    process.stdout.write(JSON.stringify({ taskFile: abs, claimed_at: now, claimed_by: claimedBy, claimed_by_session: sessionId, worktree, branch }) + '\n');
    return recordClaimEvent('claim', abs, sessionId);
  }
  // 3 lost races in a row: the file now shows the current holder — refuse with it.
  const content = readFileSync(abs, 'utf8');
  const end = content.indexOf('\n---\n', 4);
  refuseClaim(abs, end !== -1 ? content.slice(4, end) : '', sessionId);
}

async function release(taskFile, { commit = true } = {}) {
  if (!taskFile) fail('usage: env.mjs release <task-file> [--no-commit]');
  const abs = taskPath(taskFile);
  const store = storeInfo(abs);
  storePull(store);
  // Capture the releasing session BEFORE the frontmatter is cleared — the
  // claims ledger needs it to close this session's claim window.
  let sessionId = null;
  const content = readFileSync(abs, 'utf8');
  const end = content.indexOf('\n---\n', 4);
  const fmText = end !== -1 ? content.slice(4, end) : '';
  if (end !== -1) sessionId = sessionOf(abs, fmText);
  // A not-yet-migrated file still carries claimed_by_session: clear it too.
  const cleared = { claimed_at: 'null', claimed_by: 'null', ...(readEnvField(fmText, 'claimed_by_session') ? { claimed_by_session: 'null' } : {}) };
  editFrontmatter(abs, (fm) => setEnvFields(fm, cleared));
  setLocalClaim(abs, topLevelId(fmText), { session: null });
  // --no-commit: the caller commits this edit together with its own (close's
  // status change goes in one "close #N" commit, not a "release" one).
  const outcome = commit ? storePushFile(store, abs, `release ${basename(abs)}`) : 'nothing';
  if (outcome === 'lost') {
    // Someone touched the file concurrently; the release edit was unwound.
    // Redo it on the fresh state and push again (best-effort second try).
    editFrontmatter(abs, (fm) => setEnvFields(fm, cleared));
    if (storePushFile(store, abs, `release ${basename(abs)}`) === 'push-failed') {
      process.stderr.write('env.mjs: warning — release written locally but push failed; run `cogyard tasks sync push`\n');
    }
  } else if (outcome === 'push-failed') {
    process.stderr.write('env.mjs: warning — release written locally but push failed; run `cogyard tasks sync push`\n');
  } else if (outcome === 'commit-failed') {
    process.stderr.write(`env.mjs: warning — release written but not committed; run \`cogyard tasks sync push "release" -- ${abs}\`\n`);
  }
  process.stdout.write(JSON.stringify({ taskFile: abs, released: true }) + '\n');
  return recordClaimEvent('release', abs, sessionId);
}

function help() {
  process.stdout.write(`env.mjs — environment detection + per-task claim helpers

Subcommands:
  detect                              JSON of current env (worktree, branch, ports, hostname)
  ports [--shell]                     The ports a dev server started HERE should bind, under the
                                      names this project declares in .cogyard/worktree.json
                                      port_vars. --shell prints \`export NAME=value\` lines to eval.
                                      In a worktree an unresolvable allocation exits non-zero with
                                      nothing on stdout — a port is never guessed. Outside a
                                      worktree it prints no assignment: the repo's defaults stand.

                                      In a dev script:
                                        ports=$(cogyard env ports --shell) || exit 1
                                        eval "$ports"
                                      Inline in an npm script (note the \`|| echo 'exit 1'\`, without
                                      which a failure evals to nothing and is silently ignored):
                                        eval "$(cogyard env ports --shell || echo 'exit 1')" && vite

                                      A repo with several dev entries — or one that must still run on
                                      a machine with no cogyard installed — puts a \`command -v cogyard\`
                                      guard in ONE scripts/dev-ports.sh and prefixes each entry with it.
                                      Copy that shim verbatim from docs/WORKTREE-PORTS.md ("When cogyard
                                      is not installed") so the repos do not drift apart.
  port-owner <port>                   JSON identifying which worktree owns a TCP port
  claim <task-file> <session-id>      Claim a task: env.claimed_at, env.claimed_by and env.branch
                                      in the task file (shared); this machine's worktree and
                                      session in ~/.cogyard/claims.json (not team data).
                                      Refused (exit 4, nothing written) when the task isn't
                                      OPEN — reopen a closed task first (\`tasks reopen\`).
                                      Refused (exit 3, nothing written) from a worktree not
                                      named task-<id>-… for that task; the main checkout and
                                      the task's own worktree are fine. --force displaces
                                      another session's claim; --any-worktree (the owner's,
                                      refused when an agent runs it) claims from any worktree
  release <task-file> [--no-commit]   Clear the claim — the branch and worktree stay as the
                                      record of where the task was worked. Claim and release
                                      commit the task file themselves (and push, on a team
                                      store); --no-commit leaves the edit for a caller that
                                      commits it with its own change (\`tasks close\`)
  where <task-file>                   JSON of a task's claim (claimed_at, claimed_by), branch,
                                      worktree and session — the file's fields with this
                                      machine's record laid over them

detect reads ports from ~/.cogyard/ports.json; outside a worktree they are null.
Outside a git repo every field is null (still exit 0).
`);
}

const [, , cmd, ...rest] = process.argv;
// `<subcommand> --help` answers before any argument is used — the subcommands
// take positional arguments, so without this the flag was read as a task file
// (a stack trace) or a port (a null result) (task 209).
const SUBCOMMANDS = ['detect', 'ports', 'port-owner', 'claim', 'release', 'where'];
if (SUBCOMMANDS.includes(cmd) && (rest.includes('--help') || rest.includes('-h'))) {
  help();
  process.exit(0);
}
switch (cmd) {
  case 'detect':
    process.stdout.write(JSON.stringify(detect(), null, 2) + '\n');
    break;
  case 'ports':
    ports({ shell: rest.includes('--shell') });
    break;
  case 'port-owner':
    process.stdout.write(JSON.stringify(portOwner(rest[0]), null, 2) + '\n');
    break;
  case 'claim': {
    const force = rest.includes('--force');
    const anyWorktree = rest.includes('--any-worktree');
    const args = rest.filter((a) => a !== '--force' && a !== '--any-worktree');
    await claim(args[0], args[1], { force, anyWorktree });
    break;
  }
  case 'release':
    await release(rest.filter((a) => a !== '--no-commit')[0], { commit: !rest.includes('--no-commit') });
    break;
  case 'where': {
    if (!rest[0]) fail('usage: env.mjs where <task-file>');
    const t = readTaskFile(taskPath(rest[0]));
    const env = (t.frontmatter && t.frontmatter.env) || {};
    const v = (x) => (x == null || x === 'null' ? null : x);
    process.stdout.write(JSON.stringify({
      taskFile: realpathSync(resolve(rest[0])),
      claimed_at: v(env.claimed_at), claimed_by: v(env.claimed_by), branch: v(env.branch),
      worktree: v(env.worktree), session: v(env.claimed_by_session),
    }, null, 2) + '\n');
    break;
  }
  case '--help':
  case '-h':
  case undefined:
    help();
    break;
  default:
    fail(`unknown subcommand: ${cmd}. Run env.mjs --help`);
}
