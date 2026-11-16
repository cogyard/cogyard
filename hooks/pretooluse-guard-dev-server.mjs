#!/usr/bin/env node
// PreToolUse(Bash) guard: inside a worktree, a dev server is started through the
// preview tool, never by hand from the shell.
//
// THE FAILURE THIS EXISTS FOR. On 2026-08-18 a session in a worktree ran
// `PORT=30045 node server/index.mjs &` six times across ninety minutes. It bound
// the BACKEND port and served the built app off it, so the frontend port the
// owner would actually open was never bound at all. Then it killed the process
// during cleanup and reported the work finished, leaving the owner with a dead
// link and no way to look at what had been built. The convention "never start
// dev servers from Bash" already existed — in prose, in CLAUDE.md — and lost.
// That is the whole reason this is code: the sentence was already there.
//
// Note what the session did NOT do: it never reached the preview tool, so
// fixing the preview tool prevented nothing. This guard covers the gap that
// fix left open.
//
// THE RULE. In a LINKED worktree of a REGISTERED project, a command that starts
// this project's long-running dev server is refused, and the refusal names the
// command that works. The main working tree is not covered — its server is the
// always-on portal, which is a different problem with a different owner.
//
// A SECOND RULE (task 197), everywhere, not only in worktrees: `pkill` and
// `killall` are refused, because a kill by name cannot tell a dev server from
// the portal. See "the second rule" below.
//
// WHAT IT IS NOT. A seatbelt, not a wall — it sees the agent's Bash tool and
// nothing else. A human terminal starts whatever it likes, deliberately. It
// also cannot see the preview tool's own spawn, which is the point: the preview
// tool runs `npm run dev` in its own process, and that must keep working.
//
// Fail-open everywhere. Anything unparseable, unresolvable, or merely exotic
// exits 0 (allow). Blocking a build, a test run, or an install because the
// parse went sideways is far worse than missing one hand-rolled server.

import { spawnSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

function allow() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// --- read stdin ------------------------------------------------------------
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { allow(); }
let input;
try { input = JSON.parse(raw); } catch { allow(); }

if (input?.tool_name !== 'Bash') allow();
const command = input?.tool_input?.command;
if (typeof command !== 'string' || !command.trim()) allow();
const cwd = input?.cwd || process.cwd();

// --- shell surface ---------------------------------------------------------
// Split a command into the simple commands the shell would run. A newline,
// `;`, `&`, `&&`, `|` or `||` ends a command only OUTSIDE quotes, and a
// heredoc's body is text, not commands. The first version split on those
// characters wherever they stood, so a line of a commit message
// (`git commit -m "…"`, or the `$(cat <<'EOF' … EOF)` form) that began with a
// server command read as a command of its own and the whole commit was refused
// (task 212) — a mis-split failing CLOSED, which the rule above forbids.
//
// Still crude on purpose: no backticks, no `$(( ))` arithmetic. An unclosed
// quote leaves the rest as one segment that tokenize() fails open on; an
// unterminated heredoc swallows the rest of the command as its body.
function segments(cmd) {
  const out = [];
  const stack = [];      // what we are inside: 'sq' | 'dq' | 'sub' (a $( … ))
  const heredocs = [];   // { word, strip } waiting for the end of this line
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };

  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    const top = stack[stack.length - 1];

    if (top === 'sq') { if (ch === "'") stack.pop(); cur += ch; i++; continue; }
    if (ch === '\\') { cur += cmd.slice(i, i + 2); i += 2; continue; }
    if (top === 'dq') {
      if (ch === '"') stack.pop();
      else if (cmd.startsWith('$(', i)) { stack.push('sub'); cur += '$('; i += 2; continue; }
      cur += ch; i++; continue;
    }

    // Shell code: the top level, or inside $( … ).
    if (ch === '\n') {
      i = skipHeredocBodies(cmd, i + 1, heredocs);
      if (stack.length) cur += ch; else flush();
      continue;
    }
    if (ch === "'") { stack.push('sq'); cur += ch; i++; continue; }
    if (ch === '"') { stack.push('dq'); cur += ch; i++; continue; }
    if (cmd.startsWith('$(', i)) { stack.push('sub'); cur += '$('; i += 2; continue; }
    if (ch === ')' && top === 'sub') { stack.pop(); cur += ch; i++; continue; }
    if (cmd.startsWith('<<', i) && !cmd.startsWith('<<<', i)) {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(cmd.slice(i));
      if (m) {
        heredocs.push({ word: m[2] ?? m[3] ?? m[4], strip: m[1] === '-' });
        cur += m[0]; i += m[0].length; continue;
      }
    }
    if (!stack.length && /[;&|]/.test(ch)) { flush(); i++; continue; }
    cur += ch; i++;
  }
  flush();
  return out;
}

// Skip the bodies of the heredocs opened on the line that just ended, each up
// to and including its delimiter line (`<<-` strips leading tabs). Returns
// where scanning resumes.
function skipHeredocBodies(cmd, i, heredocs) {
  while (heredocs.length) {
    const { word, strip } = heredocs.shift();
    for (;;) {
      if (i >= cmd.length) return cmd.length;
      const nl = cmd.indexOf('\n', i);
      const line = cmd.slice(i, nl === -1 ? cmd.length : nl);
      i = nl === -1 ? cmd.length : nl + 1;
      if ((strip ? line.replace(/^\t+/, '') : line) === word) break;
    }
  }
  return i;
}

// Tokenize honouring simple quoting. Unbalanced quotes → null (fail open).
function tokenize(seg) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) { if (started || cur) { out.push(cur); cur = ''; started = false; } continue; }
    cur += ch;
    started = true;
  }
  if (quote) return null;
  if (started || cur) out.push(cur);
  return out;
}

// Strip leading `FOO=bar` assignments — `PORT=30045 node server/index.mjs` is
// the exact shape this guard was written for, so the env prefix must not hide
// the command behind it.
function stripEnvPrefix(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

// --- is this segment starting the project's dev server? --------------------
// Returns a short description of what it starts, or null.
//
// Deliberately narrow. Everything a session legitimately does in a worktree —
// npm install, npm test, node --test, npm run build, a one-shot script — must
// pass untouched, so only the shapes that start a long-running server count.

// Package scripts that mean "serve", as opposed to build/test/install.
const SERVER_SCRIPTS = new Set(['dev', 'start', 'serve', 'api', 'frontend']);

// Is this shell script the dev RUNNER, or merely a script whose name starts
// with "dev"? An earlier version matched `dev*.sh` and so refused
// `scripts/dev-ports.sh`, which prints two port numbers and exits — the guard
// blocking the very script that tells a dev server which ports to bind. Exact
// basenames only: a script that starts a server is called dev.sh or start.sh,
// and anything else is ordinary work that must pass.
const DEV_RUNNERS = new Set(['dev.sh', 'start.sh', 'serve.sh']);
function isDevRunner(file) {
  return DEV_RUNNERS.has(basename(file));
}

// Node options that mean "run tests / check syntax / evaluate a string and
// exit". A node command carrying one of these before its file is never a
// server, whatever file it names: `node --test server/test/x.test.mjs` runs one
// test file.
const ONE_SHOT_NODE_FLAGS = new Set(['--test', '--check', '-c', '--eval', '-e', '--print', '-p']);

// The server's ENTRY POINT — `server/index.mjs` (or .js / .cjs) — and nothing
// else. An earlier version matched any script under `server/`, so it refused
// `node server/migrate.mjs` and `node server/local-db.mjs status`: one-shot
// scripts that live beside the server and exit (task 212). Every registered
// project with a `server/` folder starts its server from `server/index.*`.
const SERVER_ENTRY = /(^|\/)server\/index\.(mjs|cjs|js)$/;

function whatItStarts(tokens) {
  const t = stripEnvPrefix(tokens);
  if (!t.length) return null;
  const cmd = basename(t[0]);

  // node <file> — a server only when <file>, the first argument that is not an
  // option, is server/index.{mjs,js,cjs} and no option before it is one of
  // ONE_SHOT_NODE_FLAGS (`--test=…` forms count too). Anything after the file
  // is the script's own argv and is not looked at.
  if (cmd === 'node' || cmd === 'nodemon') {
    const args = t.slice(1);
    const at = args.findIndex((a) => !a.startsWith('-'));
    const opts = at === -1 ? args : args.slice(0, at);
    if (opts.some((o) => ONE_SHOT_NODE_FLAGS.has(o.split('=')[0]))) return null;
    if (at === -1) return null;
    if (SERVER_ENTRY.test(args[at])) return `\`${t.join(' ')}\` runs the API server directly`;
    return null;
  }

  // npm/pnpm/yarn run <script> — only the serving scripts.
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') {
    const rest = t.slice(1).filter((a) => a !== '--');
    if (!rest.length) return null;
    let script = null;
    if (rest[0] === 'run' || rest[0] === 'run-script') script = rest[1];
    else if (rest[0] === 'start') script = 'start';
    if (!script) return null;
    if (!SERVER_SCRIPTS.has(script)) return null;
    return `\`${t.join(' ')}\` runs the \`${script}\` script, which starts a server`;
  }

  // The dev runner itself, however it is spelled.
  if (cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') {
    const file = t.slice(1).find((a) => !a.startsWith('-'));
    if (file && isDevRunner(file)) return `\`${t.join(' ')}\` runs the dev script directly`;
    return null;
  }
  if (isDevRunner(cmd)) return `\`${t.join(' ')}\` runs the dev script directly`;

  // Angular's own server.
  if (cmd === 'ng' && t[1] === 'serve') return `\`${t.join(' ')}\` starts the Angular dev server`;

  return null;
}

// --- where are we? ---------------------------------------------------------
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

// A LINKED worktree has its own git dir under `<common>/worktrees/<name>`; the
// main working tree's git dir IS the common dir. Git's own distinction, so it
// needs no path convention and holds for any agent's worktree layout.
function linkedWorktree(dir) {
  const out = git(dir, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!out) return null;
  const [gitDir, commonDir, top] = out.split('\n').map((s) => s.trim());
  if (!gitDir || !commonDir || !top) return null;
  const abs = (p) => { try { return realpathSync(resolve(dir, p)); } catch { return resolve(dir, p); } };
  if (abs(gitDir) === abs(commonDir)) return null;      // the main working tree — not ours
  try {
    const wt = realpathSync(top);
    const mainRoot = realpathSync(resolve(abs(commonDir), '..'));
    return { worktree: wt, mainRoot };
  } catch { return null; }
}

// Only police repos this system knows about; an unrelated clone is none of its
// business. Raw registry, not discoverProjects() — a checkout whose task store
// is unmounted is still a checkout worth guarding.
async function isRegisteredProject(repoRoot) {
  try {
    const { readRegistry } = await import(`${SELF}/../core/index.mjs`);
    const same = (p) => { try { return realpathSync(p) === repoRoot; } catch { return false; } };
    return (readRegistry() || []).some((p) => same(p.path) || (p.aliases || []).some(same));
  } catch { return false; }
}

// --- the second rule: no kill by name, anywhere (task 197) -----------------
// `pkill` / `killall` match processes by name or pattern, and the always-on
// portal runs the same `node server/index.mjs` as every worktree's dev server —
// so a pattern kill aimed at a dev server takes the portal down too. It did, on
// 2026-07-20 (`pkill -f server/index.mjs`). There is no pattern narrow enough
// to be safe, so every one is refused, in any folder, and the refusal names the
// two ways that are: by port, or by PID. Moved here from the owner's personal
// guard; text that only mentions the words (a commit message, an echo) passes.
const KILL_BY_NAME = new Set(['pkill', 'killall']);
// Commands that run the next word as a command. Their own options, and the
// count or duration `timeout` / `nice -n` take, are skipped to reach it.
const RUNS_NEXT = new Set(['sudo', 'nohup', 'xargs', 'time', 'exec', 'env', 'command', 'nice', 'timeout', 'doas']);
const bare = (tok) => tok.replace(/^(\$\(|\(|`)+/, '');

function killsByName(tokens) {
  let t = stripEnvPrefix(tokens.map(bare));
  while (t.length && RUNS_NEXT.has(basename(t[0]))) {
    t = t.slice(1);
    while (t.length && (t[0].startsWith('-') || /^\d+[smhd]?$/.test(t[0]))) t = t.slice(1);
    t = stripEnvPrefix(t);
  }
  if (t.length && KILL_BY_NAME.has(basename(t[0]))) return basename(t[0]);
  // A command substitution later in the line — `echo $(pkill node)`.
  const sub = tokens.find((tok, i) => i > 0 && /^(\$\(|`)/.test(tok) && KILL_BY_NAME.has(basename(bare(tok))));
  return sub ? basename(bare(sub)) : null;
}

const segs = segments(command);

for (const seg of segs) {
  const tokens = tokenize(seg);
  if (!tokens) continue;                       // unbalanced quotes — fail open
  const which = killsByName(tokens);
  if (!which) continue;
  deny(
    `Kill-by-name guard: \`${which}\` is refused — it matches processes by name or pattern, and the always-on cogyard portal `
    + `runs the same \`node server/index.mjs\` as every worktree's dev server, so a pattern kill takes the portal down with it.\n\n`
    + `Stop the one process you mean instead:\n`
    + `  • by port → \`lsof -ti:<port> | xargs kill\` (a worktree's ports: \`cogyard env detect\`; who holds one: \`cogyard env port-owner <port>\`)\n`
    + `  • by PID → \`kill <pid>\`\n`
    + `  • a server the preview tool started → \`preview_stop\`\n\n`
    + `Never stop the portal itself (port 7437 by default, its LaunchAgent) unless the owner asked.`,
  );
}

// --- walk the command ------------------------------------------------------

// A `cd` anywhere means a later segment may not run where this hook thinks it
// does. Stand down rather than refuse something legitimate elsewhere.
if (segs.some((s) => /^(cd|pushd|popd)\b/.test(s))) allow();

for (const seg of segs) {
  const tokens = tokenize(seg);
  if (!tokens) continue;                       // unbalanced quotes — fail open
  const starts = whatItStarts(tokens);
  if (!starts) continue;

  const here = linkedWorktree(cwd);
  if (!here) continue;                         // main working tree, or not a repo
  if (!(await isRegisteredProject(here.mainRoot))) continue;

  const name = basename(here.worktree);
  deny(
    `Dev-server guard: in a worktree, the dev server is started through the preview tool, not from the shell.\n\n`
    + `Refused: ${starts}\n\n`
    + `Why: a hand-started server binds whatever port the command happens to name. That is how a session `
    + `served this project off its BACKEND port, never bound the frontend port the owner opens, then killed `
    + `it on the way out and reported the work finished. The owner looks at a worktree AFTER the work — a `
    + `dead or wrong-ported server means they cannot see what was built.\n\n`
    + `Instead:\n`
    + `  preview_start name="wt-${name}"\n\n`
    + `The session-start hook writes that entry to this worktree's .claude/launch.json — the file preview_start `
    + `reads while the chat is in this worktree — and it binds this worktree's allocated ports. If the name is `
    + `not found, the hook has not run for this worktree (it does not re-fire after EnterWorktree) — run it, then retry:\n`
    + `  cogyard hook session-start ${here.worktree}\n\n`
    + `Do NOT hand-write a launch entry to get around this; that is the failure this whole area exists to stop.\n\n`
    + `Before reporting the work done, check the server is still up — the owner's first move is to click that port.\n\n`
    + `This guard only sees the agent's shell; a human can still start whatever they like from their own terminal.`,
  );
}

allow();
