#!/usr/bin/env node
// cli/scaffold.mjs — `cogyard init <name>` and `cogyard onboard [path]` (task 046).
//
// The two user-facing front doors for turning a directory into a first-class
// cogyard project. They differ ONLY in the precondition:
//   * init    — greenfield. Nothing on disk: create the dir, then wire (with a
//               per-kind app skeleton).
//   * onboard — adopt an EXISTING folder (with or without git). Additive-only;
//               no skeleton (it adopts what's there). The recovery path for a
//               loose, invisible folder (the task-044 cogyard-site situation).
//
// Both converge on core/scaffold.mjs `ensureProjectWiring()` — the single shared
// wiring core (git · package.json · .gitignore · store · register · worktree-config
// · version stamping). Idempotent + additive-only; safe to re-run.
//
// Routed here by cli/cogyard.mjs, which prepends the subcommand: argv is
// [node, scaffold.mjs, <init|onboard>, ...rest].

import { existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureProjectWiring, prepareInitDir, KINDS } from '../core/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(msg, code = 1) {
  process.stderr.write(`cogyard: ${msg}\n`);
  process.exit(code);
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('-')) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function help() {
  process.stdout.write(`cogyard init / onboard — create or adopt a first-class cogyard project.

Usage:
  cogyard init <name|path> --kind <k> [--store shared|normal] [--remote <url>] [--no-wiring]
  cogyard onboard [path]   --kind <k> [--store shared|normal] [--remote <url>] [--no-wiring]

  init      Greenfield: create the directory + git + initial commit + a per-kind
            skeleton, then run the shared wiring. Fails if the dir already has
            content (use onboard for that).
  onboard   Adopt an EXISTING folder (git-inits if absent). Additive-only — never
            overwrites a file you already have. Re-run to recover a half-set-up
            project (idempotent).

Flags:
  --kind <k>          one of: ${KINDS.join(', ')}  (required)
  --store <model>     shared (default) | normal. shared moves _tasks/ to the
                      <COGYARD_PROJECTS_ROOT>/_tasks/<slug> store (default);
                      normal keeps _tasks/ as a tracked dir in the repo.
  --remote <url>      git remote for the shared task store (passed to convert).
  --no-wiring         skip writing .claude/worktree-config.json (default off;
                      auto-skipped for kind=library).

After wiring, the project is registered (visible at http://cogyard/) and any
worktree created in it gets a port pair automatically.
`);
}

function resolveOpts(flags) {
  const kind = flags.kind;
  if (!kind) fail(`--kind is required (one of: ${KINDS.join(', ')})`);
  if (!KINDS.includes(kind)) fail(`unknown --kind '${kind}' (one of: ${KINDS.join(', ')})`);
  const store = flags.store || 'shared';
  if (store !== 'shared' && store !== 'normal') fail(`--store must be 'shared' or 'normal' (got '${store}')`);
  const wiring = flags['no-wiring'] ? false : undefined; // undefined → kind default
  const remote = typeof flags.remote === 'string' ? flags.remote : undefined;
  return { kind, store, wiring, remote };
}

// Run the existing doctor and surface only this project's rows — the acceptance
// signal is "doctor reports the new project clean".
function reportDoctor(slug) {
  const r = spawnSync(process.execPath, [join(HERE, 'tasks.mjs'), 'doctor'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  process.stdout.write('\n--- cogyard tasks doctor (this project) ---\n');
  const header = lines.find((l) => l.startsWith('PROJECT'));
  if (header) process.stdout.write(header + '\n');
  const row = lines.find((l) => l.startsWith(slug + ' ') || l.startsWith(slug.padEnd(28)));
  if (row) process.stdout.write(row + '\n');
  const schema = lines.find((l) => l.includes(` ${slug} `) && /error\(s\)/.test(l));
  if (schema) process.stdout.write(schema.trim() + '\n');
  process.stdout.write('Run `cogyard tasks doctor` for the full cross-project audit.\n');
}

function finish(result) {
  process.stdout.write(`\n✓ ${result.slug} (${result.kind}) wired.\n`);
  process.stdout.write(`  repo:   ${result.repoRoot}\n`);
  process.stdout.write(`  store:  ${result.storePath} (${result.store})\n`);
  process.stdout.write(`  portal: http://cogyard/  (slug: ${result.slug})\n`);
  if (result.warnings.length) {
    process.stdout.write('\n⚠ warnings:\n');
    for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
  }
  reportDoctor(result.slug);
}

function cmdInit(positional, flags) {
  const name = positional[0];
  if (!name) fail('usage: cogyard init <name|path> --kind <k>');
  const { kind, store, wiring, remote } = resolveOpts(flags);
  // <name> may be a bare name (created under cwd) or a path.
  let target;
  try {
    const r = prepareInitDir(name);
    target = r.target;
    if (r.created) process.stdout.write(`Created ${target}\n`);
  } catch (e) { fail(e.message.replace('use onboard', 'use `cogyard onboard`')); }
  process.stdout.write(`\nWiring ${basename(target)} (kind=${kind}, store=${store})…\n`);
  let result;
  try {
    result = ensureProjectWiring({
      path: target, kind, store, wiring, remote, scaffold: true,
      log: (m) => process.stdout.write(m + '\n'),
    });
  } catch (e) { fail(e.message); }
  finish(result);
}

function cmdOnboard(positional, flags) {
  const target = resolve(positional[0] || process.cwd());
  if (!existsSync(target)) fail(`path does not exist: ${target} — use \`cogyard init\` to create it`);
  const { kind, store, wiring, remote } = resolveOpts(flags);
  process.stdout.write(`\nAdopting ${basename(target)} (kind=${kind}, store=${store}, additive-only)…\n`);
  let result;
  try {
    result = ensureProjectWiring({
      path: target, kind, store, wiring, remote, scaffold: false,
      log: (m) => process.stdout.write(m + '\n'),
    });
  } catch (e) { fail(e.message); }
  finish(result);
}

function main() {
  const [, , sub, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);
  if (flags.help || flags.h) { help(); process.exit(0); }
  if (sub === 'init') cmdInit(positional, flags);
  else if (sub === 'onboard') cmdOnboard(positional, flags);
  else fail(`scaffold: unknown subcommand '${sub ?? ''}' (init | onboard)`);
}

main();
