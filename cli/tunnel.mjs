#!/usr/bin/env node
// tunnel.mjs — make a cogyard project "tunnel-enabled": expose its CURRENT
// worktree's dev server at a stable public Cloudflare hostname, and have the
// tunnel follow whichever worktree you're working in.
//
// The tension this resolves: cogyard hands every worktree a UNIQUE
// dynamic port so parallel worktrees never collide — but a Cloudflare tunnel
// needs ONE stable target. `tunnel here` reconciles them by rewriting the
// tunnel's ingress to the active worktree's port on demand. One tunnel + one
// hostname per project, repointed as you switch worktrees.
//
// Subcommands:
//   enable <project> <hostname> [--name N] [--side frontend|backend] [--no-follow]
//       one-time setup: create a NAMED cloudflared tunnel, route DNS, write the
//       per-project LaunchAgent + repo .tunnel marker + ~/.cogyard/tunnels.json
//       entry, then point it at the current worktree (= `here`).
//   here [--side frontend|backend]
//       repoint THIS project's tunnel at the current worktree's dev port and
//       restart its LaunchAgent. Run after switching worktrees.
//   status        where it points, agent loaded?, local + edge reachability.
//   disable [--delete]   bootout the agent; --delete tears down tunnel/DNS/files.
//   list          every tunnel-enabled project.
//
// GOTCHAS encoded here (each cost real time — see docs/TUNNELS.md):
//   1. LOCAL-CONFIG mode (config.yml: tunnel + credentials-file + ingress), NOT
//      --token / dashboard mode. Token mode ignores the local config so it can't
//      be scripted to follow worktrees.
//   2. macOS `localhost` resolves to ::1 (IPv6) first; dev servers usually bind
//      IPv4 only → a tunnel pointed at `localhost` silently 404s at the edge. We
//      write 127.0.0.1 in the ingress service URL.
//   3. `cloudflared service install` owns exactly ONE daemon (fixed label) and
//      collides on a second project → per-project LaunchAgents (unique Label),
//      loaded via `launchctl bootstrap gui/$uid <plist>`.
//   4. A stray default ~/.cloudflared/config.yml hijacks any bare
//      `cloudflared tunnel run` → the plist always passes an explicit --config.
//   6. `cloudflared tunnel route dns` fails ("record exists") on a stale CNAME →
//      we pass --overwrite-dns.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { adapter } from '../core/drivers.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_CLI = join(SCRIPT_DIR, 'env.mjs');
const HOME = homedir();
const COGYARD_HOME = process.env.COGYARD_HOME || join(HOME, '.cogyard');
const TUNNELS_PATH = join(COGYARD_HOME, 'tunnels.json');
const CF_DIR = join(HOME, '.cloudflared');
const CERT = join(CF_DIR, 'cert.pem');
const LA_DIR = join(HOME, 'Library', 'LaunchAgents');
const LOG_DIR = join(HOME, 'Library', 'Logs');
const UID = process.getuid();

const CF_BIN = tryExec('command -v cloudflared') || '/opt/homebrew/bin/cloudflared';

// --- tiny helpers ------------------------------------------------------------

function fail(msg, code = 1) {
  process.stderr.write(`tunnel: ${msg}\n`);
  process.exit(code);
}
function tryExec(cmd, opts = {}) {
  try {
    return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch { return null; }
}
function cf(args, { capture = false } = {}) {
  if (capture) return execFileSync(CF_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync(CF_BIN, args, { stdio: 'inherit' });
  return '';
}
function launchctl(args, { check = false } = {}) {
  try {
    execFileSync('launchctl', args, { stdio: check ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    return true;
  } catch { return false; }
}
function parseOpts(rest) {
  return Object.fromEntries(
    rest.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    }),
  );
}
const opt = (opts, key, dflt) => (opts[key] && opts[key] !== true ? String(opts[key]) : dflt);

// --- registry (~/.cogyard/tunnels.json) -------------------------------------

function readTunnels() {
  if (!existsSync(TUNNELS_PATH)) return {};
  try { return JSON.parse(readFileSync(TUNNELS_PATH, 'utf8')) || {}; } catch { return {}; }
}
function writeTunnels(obj) {
  mkdirSync(COGYARD_HOME, { recursive: true });
  writeFileSync(TUNNELS_PATH, JSON.stringify(obj, null, 2) + '\n');
}

// --- per-project path conventions --------------------------------------------

const LAUNCHD_PREFIX = process.env.COGYARD_LAUNCHD_PREFIX || 'com.cogyard';
const labelFor = (name) => `${LAUNCHD_PREFIX}.cloudflared.${name}`;
const plistPath = (name) => join(LA_DIR, `${labelFor(name)}.plist`);
const configPath = (name) => join(CF_DIR, `${name}.yml`);
const credsFor = (tunnelId) => join(CF_DIR, `${tunnelId}.json`);

const findRepoRoot = (start = process.cwd()) => tryExec('git rev-parse --show-toplevel', { cwd: start });
const deriveName = (label) => label.toLowerCase().replace(/[^a-z0-9]/g, '');

// Read env.mjs detect for a worktree and return the requested port side.
function detectPort(cwd, side = 'frontend') {
  let info;
  try {
    info = JSON.parse(execFileSync('node', [ENV_CLI, 'detect'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return { port: null, info: null }; }
  const port = info?.ports?.[side] ?? info?.ports?.frontend ?? info?.ports?.backend ?? null;
  return { port, info };
}

// Resolve tunnel metadata from a repo: prefer the .tunnel marker, else the
// registry (keyed by the project's MAIN clone path — resolve it from a worktree
// path via the active driver's worktree layout).
function loadMeta(repoRoot) {
  if (!repoRoot) fail('not in a git repo');
  let meta = null;
  const marker = join(repoRoot, '.tunnel');
  if (existsSync(marker)) {
    const m = {};
    for (const line of readFileSync(marker, 'utf8').split('\n')) {
      const mm = line.match(/^\s*([a-z_]+)\s*=\s*(.*)$/);
      if (mm) m[mm[1]] = mm[2].trim();
    }
    if (m.name && m.tunnel_id && m.hostname) {
      meta = { name: m.name, tunnel_id: m.tunnel_id, hostname: m.hostname, side: m.side || 'frontend' };
    }
  }
  if (!meta) {
    const wt = adapter.worktree.detect(repoRoot);
    const projectRoot = wt ? wt.parentRepo : repoRoot;
    const hit = Object.values(readTunnels()).find((t) => t.project_path === repoRoot || t.project_path === projectRoot);
    if (hit) meta = { name: hit.name, tunnel_id: hit.tunnel_id, hostname: hit.hostname, side: hit.port_side || 'frontend' };
  }
  if (!meta) fail(`no .tunnel marker at ${repoRoot} and no registry entry — run \`tunnel enable <project> <hostname>\` first`);
  meta.creds = credsFor(meta.tunnel_id);
  meta.repoRoot = repoRoot;
  return meta;
}

// --- config + LaunchAgent writers (gotchas 1,2,3,4) --------------------------

function writeConfig(name, tunnelId, hostname, port) {
  writeFileSync(configPath(name), `tunnel: ${tunnelId}
credentials-file: ${credsFor(tunnelId)}

ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:${port}
  - service: http_status:404
`);
}

function writePlist(name) {
  mkdirSync(LA_DIR, { recursive: true });
  writeFileSync(plistPath(name), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
	<dict>
		<key>Label</key>
		<string>${labelFor(name)}</string>
		<key>ProgramArguments</key>
		<array>
			<string>${CF_BIN}</string>
			<string>tunnel</string>
			<string>--config</string>
			<string>${configPath(name)}</string>
			<string>run</string>
		</array>
		<key>RunAtLoad</key>
		<true/>
		<key>KeepAlive</key>
		<true/>
		<key>ThrottleInterval</key>
		<integer>5</integer>
		<key>StandardOutPath</key>
		<string>${join(LOG_DIR, `cloudflared.${name}.out.log`)}</string>
		<key>StandardErrorPath</key>
		<string>${join(LOG_DIR, `cloudflared.${name}.err.log`)}</string>
	</dict>
</plist>
`);
}

const agentLoaded = (name) => launchctl(['print', `gui/${UID}/${labelFor(name)}`], { check: true });
function restartAgent(name) {
  if (agentLoaded(name)) launchctl(['kickstart', '-k', `gui/${UID}/${labelFor(name)}`]);
  else launchctl(['bootstrap', `gui/${UID}`, plistPath(name)]);
}

const httpCode = (url) => tryExec(`curl -sS -o /dev/null -w '%{http_code}' --max-time 6 ${JSON.stringify(url)}`) || '000';
const ok = (code) => code.startsWith('2') || code.startsWith('3');

// --- project + tunnel resolution ---------------------------------------------

function resolveProject(arg) {
  const hit = core.findProject(arg);
  if (hit) return { slug: hit.slug, path: hit.path, label: hit.label };
  const start = arg === '.' ? process.cwd() : resolve(arg);
  const root = existsSync(start) ? findRepoRoot(start) : null;
  if (!root) fail(`could not resolve project "${arg}" — not a registry slug and not a git repo path`);
  const e = core.makeProjectEntry(root);
  return { slug: e.slug, path: e.path, label: e.label };
}

function lookupTunnelId(name) {
  const out = tryExec(`${JSON.stringify(CF_BIN)} tunnel list --output json`);
  if (!out) return null;
  try { return (JSON.parse(out).find((t) => t.name === name) || {}).id || null; } catch { return null; }
}

// --- subcommands -------------------------------------------------------------

function enable(rest) {
  const args = rest.filter((a) => !a.startsWith('--'));
  const opts = parseOpts(rest);
  const [projectArg, hostname] = args;
  if (!projectArg || !hostname) fail('usage: tunnel enable <project> <hostname> [--name N] [--side frontend|backend] [--no-follow]');

  const proj = resolveProject(projectArg);
  const name = opt(opts, 'name', deriveName(proj.label));
  const side = opt(opts, 'side', 'frontend');
  const follow = !opts['no-follow'];

  if (!existsSync(CERT)) {
    fail(`not logged in to Cloudflare. Run this one-time interactive step first:\n\n  cloudflared tunnel login\n\nThen re-run \`tunnel enable\`.`);
  }

  let tunnelId = lookupTunnelId(name);
  if (tunnelId) {
    process.stdout.write(`• tunnel "${name}" already exists (${tunnelId}) — reusing\n`);
  } else {
    process.stdout.write(`• creating tunnel "${name}"…\n`);
    cf(['tunnel', 'create', name]);
    tunnelId = lookupTunnelId(name);
    if (!tunnelId) fail(`created tunnel "${name}" but could not find its id via \`cloudflared tunnel list\``);
  }
  if (!existsSync(credsFor(tunnelId))) fail(`credentials file missing: ${credsFor(tunnelId)}`);

  process.stdout.write(`• routing DNS ${hostname} → ${name}…\n`);
  cf(['tunnel', 'route', 'dns', '--overwrite-dns', name, hostname]);

  writePlist(name);
  writeFileSync(join(proj.path, '.tunnel'), `name=${name}\ntunnel_id=${tunnelId}\nhostname=${hostname}\nside=${side}\n`);

  const reg = readTunnels();
  reg[proj.slug] = {
    slug: proj.slug,
    label: proj.label,
    project_path: proj.path,
    name,
    tunnel_id: tunnelId,
    hostname,
    credentials_file: credsFor(tunnelId),
    config: configPath(name),
    plist: plistPath(name),
    port_side: side,
    follow_worktrees: follow,
  };
  writeTunnels(reg);
  process.stdout.write(`• registered ${proj.slug} → https://${hostname}\n`);

  here([], { metaOverride: { name, tunnel_id: tunnelId, hostname, side, creds: credsFor(tunnelId), repoRoot: proj.path } });

  process.stdout.write(`\n✅ tunnel enabled for ${proj.label}\n   https://${hostname}  →  this worktree's :${side} port\n   Switch worktrees and run \`tunnel here\` to repoint.\n`);
  if (httpCode(`https://${hostname}/`) === '000') {
    process.stdout.write(`   (edge not answering yet — DNS can take a minute to propagate; check \`tunnel status\`)\n`);
  }
}

function here(rest, { metaOverride } = {}) {
  const opts = parseOpts(rest);
  const repoRoot = metaOverride?.repoRoot || findRepoRoot();
  const meta = metaOverride || loadMeta(repoRoot);
  const side = opt(opts, 'side', meta.side || 'frontend');

  const { port } = detectPort(repoRoot, side);
  if (!port) fail(`could not detect the ${side} port for this worktree (env.mjs detect returned null). Is the worktree wired?`);

  writeConfig(meta.name, meta.tunnel_id, meta.hostname, port);
  restartAgent(meta.name);
  process.stdout.write(`✅ tunnel '${meta.name}' → https://${meta.hostname}  ⇒  127.0.0.1:${port}   [worktree: ${repoRoot.split('/').pop()}]\n`);
}

function status() {
  const repoRoot = findRepoRoot();
  const meta = loadMeta(repoRoot);

  let configPort = null;
  if (existsSync(configPath(meta.name))) {
    const m = readFileSync(configPath(meta.name), 'utf8').match(/service:\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) configPort = Number(m[1]);
  }
  const { port: herePort } = detectPort(repoRoot, meta.side);
  const loaded = agentLoaded(meta.name);
  const localCode = configPort ? httpCode(`http://127.0.0.1:${configPort}/`) : null;
  const edgeCode = httpCode(`https://${meta.hostname}/`);
  const pointsHere = configPort && herePort && configPort === herePort;

  const line = (k, v) => process.stdout.write(`  ${k.padEnd(18)}: ${v}\n`);
  process.stdout.write(`tunnel status — ${meta.name}\n`);
  line('hostname', `https://${meta.hostname}`);
  line('tunnel id', meta.tunnel_id);
  line('config target', configPort ? `127.0.0.1:${configPort}` : '(no config written yet)');
  line('this worktree', herePort ? `${repoRoot.split('/').pop()} :${herePort} (${meta.side})` : `${repoRoot.split('/').pop()} (no port detected)`);
  line('points here?', pointsHere ? 'yes' : (configPort ? 'NO — run `tunnel here` to repoint' : 'no'));
  line('LaunchAgent', loaded ? `loaded (${labelFor(meta.name)})` : 'NOT loaded — run `tunnel here`');
  line('local app', configPort ? `HTTP ${localCode}${ok(localCode) ? ' ✅' : ' ⚠️'}` : 'n/a');
  line('public edge', `HTTP ${edgeCode}${ok(edgeCode) ? ' ✅' : ' ⚠️'}`);
}

function disable(rest) {
  const del = rest.includes('--delete');
  const repoRoot = findRepoRoot();
  const meta = loadMeta(repoRoot);

  if (agentLoaded(meta.name)) {
    process.stdout.write(`• booting out LaunchAgent ${labelFor(meta.name)}…\n`);
    launchctl(['bootout', `gui/${UID}/${labelFor(meta.name)}`]);
  } else {
    process.stdout.write(`• LaunchAgent not loaded\n`);
  }

  if (!del) {
    process.stdout.write(`✅ tunnel '${meta.name}' stopped. Config/registry kept — \`tunnel here\` resumes, \`tunnel disable --delete\` tears down fully.\n`);
    return;
  }

  process.stdout.write(`• deleting cloudflared tunnel "${meta.name}"…\n`);
  try { cf(['tunnel', 'cleanup', meta.name]); } catch { /* best-effort */ }
  try { cf(['tunnel', 'delete', meta.name]); } catch (e) { process.stdout.write(`  (delete failed: ${e.message} — remove manually if needed)\n`); }

  for (const p of [plistPath(meta.name), configPath(meta.name), credsFor(meta.tunnel_id), join(repoRoot, '.tunnel')]) {
    try { if (existsSync(p)) { unlinkSync(p); process.stdout.write(`• removed ${p}\n`); } } catch { /* ignore */ }
  }
  const reg = readTunnels();
  const slug = Object.keys(reg).find((k) => reg[k].project_path === repoRoot);
  if (slug) { delete reg[slug]; writeTunnels(reg); }

  process.stdout.write(`✅ tunnel '${meta.name}' fully torn down.\n⚠️  cloudflared does NOT remove the DNS CNAME for ${meta.hostname} — delete it in the Cloudflare dashboard if you won't reuse the name.\n`);
}

function list() {
  const entries = Object.values(readTunnels());
  if (!entries.length) { process.stdout.write('No tunnel-enabled projects. Run `tunnel enable <project> <hostname>`.\n'); return; }
  for (const t of entries) {
    const state = agentLoaded(t.name) ? 'loaded' : 'stopped';
    process.stdout.write(`${t.label.padEnd(20)} ${('https://' + t.hostname).padEnd(32)} ${t.name.padEnd(16)} [${state}] follow=${t.follow_worktrees !== false}\n`);
  }
}

function help() {
  process.stdout.write(`tunnel.mjs — expose a project's CURRENT worktree dev server at a stable Cloudflare hostname

Subcommands:
  enable <project> <hostname> [--name N] [--side frontend|backend] [--no-follow]
                              one-time setup: create tunnel, route DNS, write LaunchAgent +
                              .tunnel marker + registry, then point at the current worktree
  here [--side frontend|backend]
                              repoint THIS project's tunnel at the current worktree's port
  status                      show target port, LaunchAgent state, local + edge reachability
  disable [--delete]          stop the LaunchAgent; --delete tears down tunnel/DNS/files too
  list                        list tunnel-enabled projects

The tunnel follows worktrees: switch worktree, run \`tunnel here\`, same hostname → new port.
Cloudflare login (cloudflared tunnel login) is a one-time interactive step you do yourself.
Full reference + gotchas: docs/TUNNELS.md (in the cogyard repo)
`);
}

// --- core (findProject / makeProjectEntry for `enable`) + dispatch -----------

const core = await import('../core/index.mjs').catch((e) => fail(`could not load core/index.mjs: ${e.message}`));

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'enable': enable(rest); break;
  case 'here': here(rest); break;
  case 'status': status(); break;
  case 'disable': disable(rest); break;
  case 'list': list(); break;
  case '--help':
  case '-h':
  case undefined: help(); break;
  default: fail(`unknown subcommand: ${cmd}. Run tunnel.mjs --help`);
}
