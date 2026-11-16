#!/usr/bin/env node
// cli/scaffold.mjs — `cogyard init <name>` and `cogyard onboard [path]`.
//
// The two user-facing front doors for turning a directory into a first-class
// cogyard project. They differ ONLY in the precondition:
//   * init    — greenfield. Nothing on disk: create the dir, then wire (with a
//               per-kind app skeleton).
//   * onboard — adopt an EXISTING folder (with or without git). Additive-only;
//               no skeleton (it adopts what's there). The recovery path for a
//               loose, invisible folder.
//
// Both converge on core/scaffold.mjs `ensureProjectWiring()` — the single shared
// wiring core (git · package.json · .gitignore · store · register · worktree config
// · version stamping). Idempotent + additive-only; safe to re-run.
//
// Routed here by cli/cogyard.mjs, which prepends the subcommand: argv is
// [node, scaffold.mjs, <init|onboard>, ...rest].

import { existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  ensureProjectWiring, prepareInitDir, KINDS,
  adapter, auditProcess, describeAudit, reconcileProcess, ownSkillName, PROCESS_AREAS, PROCESS_OUTCOMES,
} from '../core/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// `cogyard serve` binds PORT (default 7440 — see cli/cogyard.mjs help). A proxy
// hostname is the machine's own business, so the line names the address serve
// itself answers on.
const SERVE_PORT = Number(process.env.PORT) || 7440;

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
  cogyard init <name|path> --kind <k> [--remote <url>] [--no-wiring]
  cogyard onboard [path]   --kind <k> [--remote <url>] [--no-wiring]
                           [--reconcile <skill>=<adopt|keep|facts>[,…]]

  init      Greenfield: create the directory + git + initial commit + a per-kind
            skeleton, then run the shared wiring. Fails if the dir already has
            content (use onboard for that).
  onboard   Adopt an EXISTING folder (git-inits if absent). Additive-only — never
            overwrites a file you already have. Re-run to recover a half-set-up
            project (idempotent).

Flags:
  --kind <k>          one of: ${KINDS.join(', ')}  (required)
  --remote <url>      git remote for the shared task store (passed to convert).
  --no-wiring         skip writing .cogyard/worktree.json (default off;
                      auto-skipped for kind=library).
  --reconcile <s>=<o> what to do with a process doc that sits beside one of
                      cogyard's skills (${PROCESS_AREAS.map((a) => a.skill).join(', ')}):
                        adopt  cogyard's skill runs it; the doc section becomes a pointer
                        keep   the section becomes this project's own skill, under a
                               name that is not cogyard's; cogyard's is turned off here
                        facts  cogyard's skill runs it; the section moves into the
                               agent's always-loaded instructions as this project's
                               differences
                      In a terminal, onboard asks instead. Run without a terminal and
                      without this flag, it changes nothing and reports the doc
                      (as does \`cogyard tasks doctor\`). docs/PROJECT-INIT.md,
                      "One process, one place".

The task store is always shared: the seeded _tasks/ is moved to the
<COGYARD_PROJECTS_ROOT>/_tasks/<slug> store, linked as .cogyard/tasks (its own git repo on a 'tasks' branch)
so every worktree mounts the same target. After wiring, the project is registered
(visible in the portal: \`cogyard serve\`, then http://localhost:${SERVE_PORT}) and
any worktree created in it gets a port pair automatically.
`);
}

function resolveOpts(flags) {
  const kind = flags.kind;
  if (!kind) fail(`--kind is required (one of: ${KINDS.join(', ')})`);
  if (!KINDS.includes(kind)) fail(`unknown --kind '${kind}' (one of: ${KINDS.join(', ')})`);
  const wiring = flags['no-wiring'] ? false : undefined; // undefined → kind default
  const remote = typeof flags.remote === 'string' ? flags.remote : undefined;
  return { kind, wiring, remote, reconcile: parseReconcile(flags.reconcile) };
}

// --reconcile merge-to-main=keep,commit=adopt → { 'merge-to-main': 'keep', commit: 'adopt' }
function parseReconcile(v) {
  if (v == null) return {};
  if (typeof v !== 'string') fail('--reconcile needs <skill>=<outcome>');
  const out = {};
  for (const pair of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [skill, outcome] = pair.split('=');
    if (!PROCESS_AREAS.some((a) => a.skill === skill)) fail(`--reconcile: unknown skill '${skill}' (one of: ${PROCESS_AREAS.map((a) => a.skill).join(', ')})`);
    if (!PROCESS_OUTCOMES.includes(outcome)) fail(`--reconcile: unknown outcome '${outcome}' for ${skill} (one of: ${PROCESS_OUTCOMES.join(', ')})`);
    out[skill] = outcome;
  }
  return out;
}

// Ask the owner, one cogyard skill at a time, what to do with each process doc
// still beside it (task 133). Only in a terminal: anything else would be a
// guess. Updates result.warnings to what is still left afterwards.
async function askReconcile(result) {
  if (!result.process || !result.process.collisions.length) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const before = new Set(describeAudit(result.process));
  const skills = adapter.skills;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const skill of [...new Set(result.process.collisions.map((c) => c.skill))]) {
      const area = PROCESS_AREAS.find((a) => a.skill === skill);
      const here = result.process.collisions.filter((c) => c.skill === skill);
      const own = ownSkillName(result.slug, skill);
      const plugin = result.process.install.plugin;
      const offer = {
        adopt: `cogyard's ${skill} runs ${area.label}; the section becomes a pointer to it`,
        keep: `the section becomes this project's own skill, ${own}; cogyard's ${skill} is turned off here${plugin ? ` (cogyard is a plugin here, so its ${skills.invocation(skill, { cogyard: true, plugin: true })} stays loaded and ${skills.alwaysLoaded} will say which to use)` : ''}`,
        facts: `cogyard's ${skill} runs ${area.label}; the section moves into ${skills.alwaysLoaded} as this project's differences`,
      };
      const choices = result.process.outcomes;
      process.stdout.write(`\nA ${area.label} process sits beside cogyard's ${skill} skill, and nothing says which one wins:\n`);
      for (const c of here) process.stdout.write(`    ${c.file}${c.heading ? ` ("${c.heading}")` : ''}\n`);
      process.stdout.write('Choose the one place it lives:\n');
      choices.forEach((o, i) => process.stdout.write(`  ${i + 1}  ${o.padEnd(6)} ${offer[o]}\n`));
      process.stdout.write(`  s  skip   change nothing now; \`cogyard tasks doctor\` keeps flagging it\n`);
      let pick = null;
      while (pick === null) {
        const a = (await rl.question(`Choice [${choices.map((_, i) => i + 1).join('/')}/s]: `)).trim().toLowerCase();
        if (a === 's' || a === 'skip') pick = '';
        else if (choices[Number(a) - 1]) pick = choices[Number(a) - 1];
        else if (choices.includes(a)) pick = a;
      }
      if (!pick) { process.stdout.write(`  – ${skill}: skipped\n`); continue; }
      const r = reconcileProcess(result.repoRoot, { skill, outcome: pick, collisions: result.process.collisions, slug: result.slug });
      process.stdout.write(`  + ${skill}: ${pick} → ${r.changed.join(', ')} (commit ${r.commit})\n`);
      for (const n of r.notes) process.stdout.write(`      ${n}\n`);
      result.reconciled.push({ skill, outcome: pick, ...r });
    }
  } finally { rl.close(); }
  result.process = auditProcess(result.repoRoot, { slug: result.slug });
  result.warnings = [...result.warnings.filter((w) => !before.has(w)), ...describeAudit(result.process)];
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
  process.stdout.write(`  store:  ${result.storePath}\n`);
  process.stdout.write(`  portal: http://localhost:${SERVE_PORT}/p/${result.slug}  (start it with \`cogyard serve\`)\n`);
  if (result.warnings.length) {
    process.stdout.write('\n⚠ warnings:\n');
    for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
  }
  reportDoctor(result.slug);
}

function cmdInit(positional, flags) {
  const name = positional[0];
  if (!name) fail('usage: cogyard init <name|path> --kind <k>');
  const { kind, wiring, remote } = resolveOpts(flags);
  // <name> may be a bare name (created under cwd) or a path.
  let target;
  try {
    const r = prepareInitDir(name);
    target = r.target;
    if (r.created) process.stdout.write(`Created ${target}\n`);
  } catch (e) { fail(e.message.replace('use onboard', 'use `cogyard onboard`')); }
  process.stdout.write(`\nWiring ${basename(target)} (kind=${kind})…\n`);
  let result;
  try {
    result = ensureProjectWiring({
      path: target, kind, wiring, remote, scaffold: true,
      log: (m) => process.stdout.write(m + '\n'),
    });
  } catch (e) { fail(e.message); }
  finish(result);
}

async function cmdOnboard(positional, flags) {
  const target = resolve(positional[0] || process.cwd());
  if (!existsSync(target)) fail(`path does not exist: ${target} — use \`cogyard init\` to create it`);
  const { kind, wiring, remote, reconcile } = resolveOpts(flags);
  process.stdout.write(`\nAdopting ${basename(target)} (kind=${kind}, additive-only)…\n`);
  let result;
  try {
    result = ensureProjectWiring({
      path: target, kind, wiring, remote, reconcile, scaffold: false,
      log: (m) => process.stdout.write(m + '\n'),
    });
    await askReconcile(result);
  } catch (e) { fail(e.message); }
  finish(result);
}

async function main() {
  const [, , sub, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);
  if (flags.help || flags.h) { help(); process.exit(0); }
  if (sub === 'init') cmdInit(positional, flags);
  else if (sub === 'onboard') await cmdOnboard(positional, flags);
  else fail(`scaffold: unknown subcommand '${sub ?? ''}' (init | onboard)`);
}

main();
