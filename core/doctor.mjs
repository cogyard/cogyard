// core/doctor.mjs — the `cogyard doctor` install preflight, as pure logic.
//
// runDoctor(ctx) runs a list of preflight checks and returns a structured report.
// It does NO I/O of its own — no `console`, no `child_process`, no fs. Every
// environment fact a check needs arrives via `ctx`; the CLI (cli/doctor.mjs) fills
// real probes, the test injects fakes. This mirrors the repo invariant: core/ owns
// logic, cli/ is the thin renderer + exit-code setter.
//
// runDoctor(ctx) -> {
//   checks: [{ id, label, status: 'ok'|'warn'|'fail', detail, fix }],
//   ok: boolean,          // true iff NO check has status 'fail'  (warn is allowed)
//   counts: { ok, warn, fail },
// }
//
// REPORTS only — it never mutates config/registry/ports (auto-fix is out of scope).

// Node engines floor — keep in sync with package.json "engines".
const NODE_FLOOR_MAJOR = 22;

const ok = (detail) => ({ status: 'ok', detail, fix: null });
const warn = (detail, fix) => ({ status: 'warn', detail, fix });
const fail = (detail, fix) => ({ status: 'fail', detail, fix });

// Each check is { id, label, run(ctx) -> { status, detail, fix } }. Only the three
// things that make cogyard genuinely UNRUNNABLE (old node, no git, unwritable home)
// are fails; everything else is runnable-but-incomplete → warn with guidance. This
// keeps doctor exit-0 on a fresh, correctly-installed-but-unconfigured machine.
// The hooks the ENGINE ships and expects an agent to call. Kept here rather than
// in the CLI because it is a fact about cogyard, not about how one machine reads
// its settings file — the CLI supplies what IS registered, core knows what SHOULD
// be. Each carries both the `cogyard hook <name>` form and its file's stem, since
// an install may legitimately register either.
const ENGINE_HOOKS = [
  { name: 'session-start', file: 'worktree-session', label: 'worktree wiring' },
  { name: 'validate-frontmatter', file: 'pretooluse-validate-frontmatter', label: 'frontmatter validator' },
  { name: 'guard-branch-switch', file: 'pretooluse-guard-branch-switch', label: 'branch-switch guard' },
  { name: 'guard-dev-server', file: 'pretooluse-guard-dev-server', label: 'dev-server guard' },
  { name: 'guard-task-store', file: 'pretooluse-guard-task-store', label: 'task-store git guard' },
  { name: 'live-state', file: 'live-state', label: 'live agent state (Plan and Tasks status line)' },
];

const CHECKS = [
  {
    id: 'node',
    label: 'Node.js runtime',
    run(ctx) {
      const major = parseInt(String(ctx.nodeVersion).split('.')[0], 10);
      if (!Number.isFinite(major) || major < NODE_FLOOR_MAJOR) {
        return fail(
          `Node ${ctx.nodeVersion} — cogyard needs Node ${NODE_FLOOR_MAJOR}+.`,
          `Install Node ${NODE_FLOOR_MAJOR} or newer (https://nodejs.org), then re-run.`,
        );
      }
      return ok(`Node ${ctx.nodeVersion}`);
    },
  },
  {
    id: 'git',
    label: 'git on PATH',
    run(ctx) {
      const v = ctx.gitVersion();
      if (!v) {
        return fail(
          'git was not found on PATH — init, the portal views, tasks and env all need it.',
          'Install git (https://git-scm.com/downloads), then re-run.',
        );
      }
      return ok(v);
    },
  },
  {
    id: 'home',
    label: 'config home writable',
    run(ctx) {
      if (!ctx.homeWritable()) {
        return fail(
          `${ctx.home} is not writable — cogyard can't persist the registry, ports, or config.`,
          `Make ${ctx.home} writable (or set $COGYARD_HOME to a writable path), then re-run.`,
        );
      }
      return ok(ctx.home);
    },
  },
  {
    id: 'config',
    label: 'config.json',
    run(ctx) {
      // Absent config means "all defaults" — that's the healthy fresh-machine state.
      if (ctx.config == null) return ok('absent (all defaults)');
      if (typeof ctx.config !== 'object') {
        return warn(
          'config.json is present but unparseable — cogyard will fall back to defaults.',
          `Fix the JSON in ${ctx.home}/config.json (or delete it to use defaults).`,
        );
      }
      const name = ctx.config.driver;
      if (typeof name === 'string' && name !== 'none' && !ctx.driver.available.includes(name)) {
        return warn(
          `config.json names driver "${name}", which isn't installed — cogyard will fall back to auto-detect.`,
          `Set "driver" to one of: ${ctx.driver.available.join(', ') || '(none installed)'} — or remove it.`,
        );
      }
      return ok('present and valid');
    },
  },
  {
    id: 'projects-root',
    label: 'projects root',
    run(ctx) {
      if (!ctx.rootExists()) {
        return warn(
          `${ctx.projectsRoot} doesn't exist — it's only a default (convert's store location + a label shortener), never required.`,
          `Create ${ctx.projectsRoot}, or set $COGYARD_PROJECTS_ROOT to where your clones live.`,
        );
      }
      return ok(ctx.projectsRoot);
    },
  },
  {
    id: 'registry',
    label: 'project registry',
    run(ctx) {
      if (!ctx.registry.length) {
        return warn(
          'no projects registered — the portal will be empty until you add one.',
          'Run `cogyard onboard <path>` to adopt an existing folder, or `cogyard init <name>` for a new one.',
        );
      }
      // A project whose task directory is broken, or still the old top-level
      // `_tasks`, is in the registry as an error row: name each, with its fix.
      const problems = ctx.registry.filter((p) => p.error);
      if (problems.length) {
        return warn(
          `${ctx.registry.length} project(s), ${problems.length} with a problem: ${problems.map((p) => `${p.slug} — ${p.error}`).join('; ')}`,
          'Fix each as its line says; `cogyard tasks doctor` shows every project\'s task storage.',
        );
      }
      return ok(`${ctx.registry.length} project(s)`);
    },
  },
  {
    id: 'driver',
    label: 'agent driver',
    run(ctx) {
      if (!ctx.driver.active) {
        return warn(
          'no agent driver active — cogyard runs fine, but usage cost will be null.',
          'Run cogyard inside a supported agent (e.g. Claude Code), or set "driver" in config.json. See docs/DRIVERS.md.',
        );
      }
      return ok(`${ctx.driver.active} active`);
    },
  },
  {
    id: 'frontend',
    label: 'portal UI built',
    run(ctx) {
      if (!ctx.frontendBuilt()) {
        return warn(
          'frontend/dist is not built — the first `serve` builds it (a problem only on a no-toolchain global install).',
          'Run `npm run build`, or just `cogyard serve` (it builds on first run).',
        );
      }
      return ok('built');
    },
  },
  {
    id: 'hooks',
    label: 'agent hooks wired',
    run(ctx) {
      // Nothing to wire if no agent is active — the CLI and portal work without one.
      if (!ctx.driver.active) return ok('no agent active — hooks not applicable');
      const commands = ctx.agentHookCommands;
      if (commands == null) {
        return warn(
          "couldn't read the agent's hook configuration — wiring is unverified.",
          'Check the agent settings file named above, or re-run `cogyard claude install` and paste the block it prints.',
        );
      }
      // A hook may be registered EITHER as `cogyard hook <name>` or by an absolute
      // path to its file. Both are legitimate installs, so match on either.
      const missing = ENGINE_HOOKS.filter(
        (h) => !commands.some((cmd) => cmd.includes(h.name) || cmd.includes(h.file)),
      );
      if (missing.length) {
        return warn(
          `${missing.length} of ${ENGINE_HOOKS.length} not wired: ${missing.map((h) => h.label).join(', ')}.`,
          'Run `cogyard claude install` and merge the hooks block it prints into your agent settings.',
        );
      }
      return ok(`all ${ENGINE_HOOKS.length} wired`);
    },
  },
  {
    id: 'port',
    label: 'serve port free',
    run(ctx) {
      const port = ctx.servePort;
      const where = port ? `port ${port}` : 'the default serve port';
      if (!ctx.portFree(port)) {
        return warn(
          `${where} is in use — \`cogyard serve\` will fail to bind there.`,
          `Stop whatever holds ${where}, or run \`cogyard serve --port <N>\`.`,
        );
      }
      return ok(`${where} free`);
    },
  },
];

function runDoctor(ctx) {
  const checks = CHECKS.map((c) => {
    const r = c.run(ctx);
    return { id: c.id, label: c.label, status: r.status, detail: r.detail, fix: r.fix };
  });
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  return { checks, ok: counts.fail === 0, counts };
}

export { runDoctor, NODE_FLOOR_MAJOR, ENGINE_HOOKS };
