#!/usr/bin/env node
// cli/cogyard.mjs — the `cogyard` command (the npm `bin`). A thin dispatcher over
// the per-concern CLI modules + the portal server + the engine hook entrypoints.
//
// This is what makes the driver location-INDEPENDENT: skills, hooks, and users
// invoke `cogyard <command> …` (on PATH via `npm i -g` / `npm link`) instead of
// `node /some/abs/path/cli/<x>.mjs`. It's also the `npx cogyard serve` entrypoint.
//
// Targets are resolved relative to THIS file, so they work wherever the package
// is installed/linked. Each subcommand is spawned as its own node process so the
// existing modules keep their exact argv/stdio/exit-code behaviour (no rewrite).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // <pkg>/cli
const ROOT = join(HERE, '..');                        // <pkg>

// `cogyard <group> …` → the module that handles it.
const ROUTES = {
  tasks: join(HERE, 'tasks.mjs'),
  env: join(HERE, 'env.mjs'),
  tunnel: join(HERE, 'tunnel.mjs'),
  usage: join(HERE, 'usage.mjs'),
  claude: join(HERE, 'claude-install.mjs'),
  doctor: join(HERE, 'doctor.mjs'),
};

// `cogyard init|onboard …` → cli/scaffold.mjs, with the subcommand prepended so
// the one module handles both (task 046). These are top-level (project creation
// is a first-class action), distinct from the low-level `cogyard tasks init`.
const SCAFFOLD_CMDS = new Set(['init', 'onboard']);

// `cogyard hook <name>` → an ENGINE hook entrypoint (the agent-agnostic ones the
// Claude plugin wires via `cogyard hook …`). Claude-input-only hooks stay in the
// plugin, not here.
const HOOKS = {
  'session-start': join(ROOT, 'hooks', 'worktree-session.mjs'),
  'validate-frontmatter': join(ROOT, 'hooks', 'pretooluse-validate-frontmatter.mjs'),
};

// git is a hard dependency of almost every command (init, serve's portal views,
// tasks, env). Fail with a clear message instead of a raw spawn ENOENT when it's
// missing. A few commands don't need it (driver install; the never-block hook).
function gitAvailable() {
  try { return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}
// `doctor` REPORTS a missing git itself — the dispatcher gate must not abort it
// before it can render that very finding.
const GIT_OPTIONAL = new Set(['claude', 'doctor']);

function run(scriptPath, args, extraEnv) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (r.error) {
    process.stderr.write(`cogyard: failed to run ${scriptPath}: ${r.error.message}\n`);
    process.exit(1);
  }
  process.exit(r.status == null ? 1 : r.status);
}

function help() {
  process.stdout.write(`cogyard — markdown task system + collision-free agent worktrees

Usage: cogyard <command> [...]

  init   <name>     create a NEW project (dir + git + skeleton + full wiring)
  onboard [path]    adopt an EXISTING folder as a project (additive-only)
  tasks  <…>        task store: sync, projects, doctor, next-id, current, analyze, mount
  env    <…>        environment + claims: detect, port-owner, claim, release
  tunnel <…>        expose a worktree's dev server at a stable hostname
  usage  <…>        token/cost ledger: collect, report, backfill
  serve  [--port N] run the portal (API + SPA) on one origin (default PORT 7440)
  doctor            install preflight — is this machine wired to run cogyard?
  claude <install|uninstall>  install the Claude driver (skills/commands) into ~/.claude
  hook   <name>     engine hook entrypoint (session-start | validate-frontmatter)

Run \`cogyard <command> --help\` for a command's own options.
`);
}

function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help();
    process.exit(cmd ? 0 : 1);
  }

  const needsGit = !GIT_OPTIONAL.has(cmd) && !(cmd === 'hook' && rest[0] === 'session-start');
  if (needsGit && !gitAvailable()) {
    process.stderr.write('cogyard: `git` was not found on PATH, but cogyard needs it.\n' +
      'Install git (https://git-scm.com/downloads), then re-run.\n');
    process.exit(1);
  }

  if (SCAFFOLD_CMDS.has(cmd)) {
    // scaffold.mjs reads argv[2] as the subcommand → prepend it.
    run(join(HERE, 'scaffold.mjs'), [cmd, ...rest]);
  }

  if (cmd === 'serve') {
    // Dummy-proof: the portal UI (frontend/dist) is gitignored, so build it on the
    // FIRST serve from a fresh clone — then `serve` just works with no separate
    // `npm run build` step. Best-effort: if the build fails (e.g. a global install
    // without dev deps), the server still starts and shows its own 503 with guidance.
    const dist = join(ROOT, 'frontend', 'dist', 'frontend', 'browser');
    if (!existsSync(dist)) {
      process.stderr.write('cogyard: building the portal UI (first run, ~30s)…\n');
      const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
      if (b.status !== 0) process.stderr.write('cogyard: portal build failed — the API will still serve; run `npm install && npm run build` in the repo to get the UI.\n');
    }
    // `cogyard serve --port N` → PORT env the server reads.
    const i = rest.indexOf('--port');
    const extraEnv = (i !== -1 && rest[i + 1]) ? { PORT: rest[i + 1] } : undefined;
    run(join(ROOT, 'server', 'index.mjs'), [], extraEnv);
  }

  if (cmd === 'hook') {
    const name = rest[0];
    const target = HOOKS[name];
    if (!target) {
      process.stderr.write(`cogyard hook: unknown hook '${name ?? ''}'. Known: ${Object.keys(HOOKS).join(', ')}\n`);
      process.exit(1);
    }
    const r = spawnSync(process.execPath, [target, ...rest.slice(1)], { stdio: 'inherit' });
    // SessionStart must NEVER block the session — mirror the hook's own exit-0
    // policy even if `cogyard`/node failed to spawn the entrypoint.
    if (name === 'session-start') process.exit(0);
    if (r.error) {
      process.stderr.write(`cogyard hook ${name}: ${r.error.message}\n`);
      process.exit(1);
    }
    process.exit(r.status == null ? 1 : r.status);
  }

  const route = ROUTES[cmd];
  if (!route) {
    process.stderr.write(`cogyard: unknown command '${cmd}'. Run \`cogyard --help\`.\n`);
    process.exit(1);
  }
  run(route, rest);
}

main();
