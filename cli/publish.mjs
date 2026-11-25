#!/usr/bin/env node
// cli/publish.mjs — `cogyard publish` (task 170): pushing is not publishing.
//
//   cogyard publish [list] [--json]    every registered project: does a push to
//                                      main deploy it, its last release, how it
//                                      publishes
//   cogyard publish <project> [<release>] [--yes]
//                                      publish it — a project that names its
//                                      releases in publish.json (task 264)
//                                      publishes one of them, by name or label
//
// A publish is one fixed sequence. Each step either proves what it claims or
// stops the publish with the reason — nothing is tagged unless everything
// before it held. docs/PUBLISH.md is the reference.
//
//   1. Owner        refuse when an agent started this process
//   2. Lock         one publish of a project at a time
//   3. Code         main checked out, clean, identical to origin/main;
//                   v<version> new (or already on this commit) and newer than
//                   the last release
//   4. Live now     what /health serves before anything happens, or whether the
//                   declared live check passes (task 267); when it is already
//                   live, checks and deploy are skipped (a safe re-run)
//   5. Checks       each declared check passes on the commit, in the main
//                   checkout, and leaves it exactly as it was
//   6. Confirm      the owner says yes (or --yes)
//   7. Deploy       the declared command, then each manual step, each one
//                   confirmed by the owner — manual steps can't be --yes'd
//   8. Verify       /health reports exactly this commit, or the live check passes
//                   (both polled); with neither declared, the owner is asked,
//                   by version, tag, commit and the deploy step just done
//   9. Tag          v<version> on the commit, pushed, read back from origin
//  10. Record       one line in ~/.cogyard/publishes.jsonl, success or not
//
// Before step 1 does anything: the declaration is valid, every `requires`
// credential is set, and anything that will need the owner's answer has a
// terminal to ask in. Checks and the deploy command run in the project's main
// checkout with the owner's cogyard credentials (~/.cogyard/secrets.env) in
// their environment; the deploy command and the live check also get
// COGYARD_PUBLISH_SHA, COGYARD_PUBLISH_TAG, COGYARD_PUBLISH_RELEASE and
// COGYARD_PUBLISH_VERSION (the version without the tag's prefix).

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { discoverProjects } from '../core/registry.mjs';
import { agentSession } from '../core/drivers.mjs';
import { loadSecrets } from '../core/secrets.mjs';
import {
  PUBLISH_CONFIG, PUBLISH_LOG, PUBLISH_DEFAULTS, readPublishConfig, publishPlan, publishPreflight,
  healthMatches, healthCommit, tagRelease, takePublishLock, recordPublish, publishInventory,
  resolvePublishProject, checkoutStill, pickRelease, tagPrefix,
} from '../core/publish.mjs';

// A DigitalOcean build takes minutes. Running out is a safe failure: nothing is
// tagged, and a re-run sees the commit already live and tags it. The same
// limits apply to the live check (task 267). The env overrides exist for tests.
const VERIFY_TIMEOUT_MS = Number(process.env.COGYARD_PUBLISH_TIMEOUT_MS) || PUBLISH_DEFAULTS.verifyTimeoutMinutes * 60 * 1000;
const VERIFY_POLL_MS = Number(process.env.COGYARD_PUBLISH_POLL_MS) || PUBLISH_DEFAULTS.verifyPollSeconds * 1000;
// One run of the live check: a command that hangs counts as not live, rather
// than holding the publish past its own limit.
const LIVE_CHECK_RUN_MS = 60 * 1000;

const out = (s = '') => process.stdout.write(s + '\n');

// Terminal colour — the owner's pick (2026-10-12) from a side-by-side preview
// of three schemes on light and dark terminals: bold step headings, cyan facts
// (commits, tags, URLs), dim detail, green ✓, red ✗, magenta for "don't do it
// yet", and the hand step as black text on a yellow band. Yellow TEXT was
// rejected: it is near-invisible on a light terminal, on the one line you act
// on. Off when the output is not a terminal or NO_COLOR is set (same rule as
// cogyard doctor), so piped and logged output stays plain.
const COLOR_OUT = process.stdout.isTTY && !process.env.NO_COLOR;
const COLOR_ERR = process.stderr.isTTY && !process.env.NO_COLOR;
const sgr = (code, on = COLOR_OUT) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = sgr(1);
const dim = sgr(2);
const green = sgr(32);
const cyan = sgr(36);
const magenta = sgr(35);
const band = sgr('30;43');            // black on yellow — readable on light and dark
const errRed = sgr('1;31', COLOR_ERR);
const errBold = sgr(1, COLOR_ERR);
const errPlainRed = sgr(31, COLOR_ERR);

function help() {
  out(`cogyard publish — pushing is not publishing

  cogyard publish [list] [--json]    which projects deploy on push, each one's last
                                     release, and how each publishes
  cogyard publish <project> [--yes]  deploy <project>'s main, prove it is live, tag
                                     v<version> on it (owner only; docs/PUBLISH.md)
  cogyard publish <project> <release> [--yes]
                                     the same for one release of a project that
                                     names its releases (its name or label)

A project declares itself in ${PUBLISH_CONFIG}.`);
}

// --- list ---------------------------------------------------------------------

function pushCell(r) {
  if (!r.declared) return 'undeclared';
  if (r.error) return 'INVALID';
  return r.deploysOnPush ? 'YES' : 'no';
}
function howCell(r) {
  if (!r.declared) return '—';
  if (r.error) return r.error;
  const steps = [r.command && `run \`${r.command}\``, ...(r.manual ?? [])].filter(Boolean);
  if (!steps.length) return 'nothing to publish';
  return `${steps.join(' → ')} — live check: ${r.health ?? (r.liveCheck ? `runs \`${r.liveCheck}\`` : 'you confirm')}`;
}

function list(json) {
  const rows = publishInventory(discoverProjects().filter((p) => !p.error));
  if (json) return out(JSON.stringify(rows, null, 2));
  const head = ['PROJECT', 'PUSH DEPLOYS', 'LAST RELEASE', 'PRE-PUSH HOOK', 'HOW IT PUBLISHES'];
  // A project naming its releases (task 264) gets one line per release.
  const table = rows.flatMap((r) => (r.releases
    ? r.releases.map((rel) => [`${r.label} · ${rel.label} (${rel.name})`, pushCell({ declared: true, ...rel }), rel.lastRelease ?? '—', r.prePushHook ? 'yes' : '—', howCell({ declared: true, ...rel })])
    : [[r.label, pushCell(r), r.lastRelease ?? '—', r.prePushHook ? 'yes' : '—', howCell(r)]]));
  const n = head.length - 1;
  const widths = head.slice(0, n).map((h, i) => Math.max(h.length, ...table.map((t) => t[i].length)));
  const line = (cells) => cells.map((c, i) => (i < n ? c.padEnd(widths[i]) : c)).join('  ');
  out(line(head));
  for (const t of table) out(line(t));
  const undeclared = rows.filter((r) => !r.declared).length;
  if (undeclared) out(`\n${undeclared} project(s) have no ${PUBLISH_CONFIG} — cogyard does not guess.`);
}

// --- publish ------------------------------------------------------------------

let rl = null;
// Ctrl-D or a closed terminal at a prompt is an answer too: no. It must stop
// the publish cleanly (lock released, failure recorded), never crash out of it.
async function ask(question) {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } catch { out(''); return ''; }
}
const yesNo = async (q) => /^y(es)?$/i.test(await ask(`${bold(`${q} [y/N]`)} `));

// A check's own output, indented and dimmed so it reads as detail under the
// step rather than as cogyard speaking. Line by line, as it arrives.
function runDimmed(cmd, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (stream, sink) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) sink.write(`   ${dim(l)}\n`);
      });
      stream.on('end', () => { if (buf) sink.write(`   ${dim(buf)}\n`); });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stdout);
    child.on('error', (error) => resolve({ error, status: null }));
    child.on('close', (status, signal) => resolve({ status, signal }));
  });
}

async function readHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
    return await res.json();
  } catch { return null; }
}

async function waitForHealth(url, sha) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let last = null;
  for (;;) {
    const body = await readHealth(url);
    if (healthMatches(body, sha)) return { ok: true };
    const now = healthCommit(body) ?? (body ? 'no commit in the response' : 'no answer');
    if (now !== last) { out(dim(`     ${new Date().toTimeString().slice(0, 8)}  serving ${now}`)); last = now; }
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(VERIFY_POLL_MS);
  }
}

// One run of the declared live check (task 267): its exit status and the last
// line it printed (stdout and stderr together) — what the owner reads to see
// what the check is waiting for. Never throws.
function runLiveCheck(cmd, cwd, env, timeoutMs = LIVE_CHECK_RUN_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    const lastLine = () => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? null;
    child.on('error', (error) => resolve({ ok: false, status: null, last: `could not start it: ${error.message}` }));
    child.on('close', (status, signal) => resolve({
      ok: status === 0,
      status,
      last: lastLine() ?? (status === 0 ? 'passed, printing nothing' : signal ? `stopped after ${Math.round(timeoutMs / 1000)} s (${signal})` : `exit ${status}, printing nothing`),
    }));
  });
}

// Step 8 with a live check: run it every poll until it passes or time runs out,
// showing a line whenever what it prints changes.
async function waitForLiveCheck(cmd, cwd, env) {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let last = null;
  for (;;) {
    const r = await runLiveCheck(cmd, cwd, env, Math.max(1000, Math.min(LIVE_CHECK_RUN_MS, deadline - Date.now())));
    if (r.last !== last) { out(dim(`     ${new Date().toTimeString().slice(0, 8)}  ${r.last}`)); last = r.last; }
    if (r.ok) return { ok: true, last };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(VERIFY_POLL_MS);
  }
}

async function publish(slug, releaseName, yes) {
  const record = { project: slug, ok: false };
  let lock = null;
  const stop = (step, reason, code = 1) => {
    process.stderr.write(`\n${errRed(`✗ ${step}:`)} ${errBold(reason)}\n${errPlainRed(`  Not published${record.tag ? `, ${record.tag} not set` : ''}.`)}\n`);
    if (record.sha) { record.failedAt = step; record.reason = reason; recordPublish(record); }
    lock?.release();
    rl?.close();
    process.exit(code);
  };
  const step = (n, title) => out(`\n${bold(`${n}. ${title}`)}`);
  const ok = (s) => out(`   ${green('✓')} ${s}`);
  // Ctrl-C at any point: nothing after it runs, so nothing is tagged. Re-running
  // is safe — step 4 sees a deploy that already went live and skips it.
  process.on('SIGINT', () => stop('Interrupted', 'stopped with Ctrl-C', 130));

  step(1, 'Owner');
  const agent = await agentSession();
  if (agent) stop('Owner', `started by ${agent}. Publishing is the owner's act — run it from your own terminal.`, 3);
  ok('started from a terminal, not an agent');

  const found = resolvePublishProject(discoverProjects(), slug);
  if (!found.ok) stop('Project', found.reason);
  const { project } = found;
  record.project = project.slug;
  ok(`project: ${project.label} ${dim(`(${project.path})`)}`);
  const decl = readPublishConfig(project.path);
  if (!decl.declared || decl.error) stop('Declaration', publishPlan(decl).reason, 2);
  // Which release (task 264): the flat form is the one release and takes no
  // name; a project naming its releases publishes exactly one, named.
  const picked = pickRelease(decl, releaseName);
  if (!picked.ok) stop('Declaration', picked.reason, 2);
  const cfg = picked.release;
  // What is being published, in every sentence below: "Deadlift Website".
  const what = cfg.label ? `${project.label} ${cfg.label}` : project.label;
  if (cfg.name) { record.release = cfg.name; ok(`release: ${cfg.label} ${dim(`(${cfg.name})`)}`); }
  const plan = publishPlan(cfg);
  if (!plan.ok) stop('Declaration', plan.reason, 2);
  // Everything that will need the owner's answer is checked BEFORE anything
  // runs — never discover halfway through a deploy that nobody can be asked.
  if (cfg.manual.length && !process.stdin.isTTY) stop('Declaration', 'this publish has manual steps for you to confirm, and there is no terminal to ask in', 2);
  if (!cfg.health && !cfg.liveCheck && !process.stdin.isTTY) stop('Declaration', 'no health URL or live check is declared, so you must confirm it is live — and there is no terminal to ask in', 2);

  step(2, 'Lock');
  lock = takePublishLock(project.slug);
  if (!lock.ok) { const r = lock.reason; lock = null; stop('Lock', r, 2); }
  ok(`no other publish of ${project.label} is running`);

  step(3, 'Code');
  const pre = publishPreflight(project.path, {
    tag: cfg.tag, prefix: tagPrefix(cfg.tagFormat) ?? 'v',
    tagOff: cfg.name ? `set "tag": false for the "${cfg.name}" release in ${PUBLISH_CONFIG}` : undefined,
  });
  if (!pre.ok) stop('Code', pre.reason, 2);
  Object.assign(record, { sha: pre.sha, tag: pre.tag, previous: pre.previous });
  ok(`${pre.branch} @ ${cyan(pre.short)}, clean${pre.remote ? `, identical to ${pre.remote}/${pre.branch}` : ' (no remote)'}`);
  if (pre.tag) ok(pre.tagHere ? `${cyan(pre.tag)} is already on this commit — a re-run; it stays` : `${cyan(pre.tag)} is new${pre.previous ? `, after ${cyan(pre.previous)}` : ' (first release)'}`);
  else ok('no tag ("tag": false)');

  // What the deploy command and the live check are told they are publishing.
  // The version is the tag's without its prefix: "2.22.0" for "v2.22.0" or
  // "web/v2.22.0"; empty with "tag": false (no version is read then).
  const publishEnv = {
    COGYARD_PUBLISH_SHA: pre.sha, COGYARD_PUBLISH_TAG: pre.tag ?? '',
    COGYARD_PUBLISH_RELEASE: cfg.name ?? '', COGYARD_PUBLISH_VERSION: pre.version ?? '',
  };
  // Read at each use, after loadSecrets() has put the owner's credentials in.
  const childEnv = () => ({ ...process.env, ...publishEnv });
  const pollText = VERIFY_POLL_MS >= 1000 ? `${Math.round(VERIFY_POLL_MS / 1000)} s` : `${VERIFY_POLL_MS} ms`;
  const limitMin = Math.round(VERIFY_TIMEOUT_MS / 60000);

  step(4, 'Live now');
  let alreadyLive = false;
  if (cfg.health) {
    const body = await readHealth(cfg.health);
    alreadyLive = healthMatches(body, pre.sha);
    const serving = healthCommit(body);
    ok(`${cyan(cfg.health)} serves ${serving ? cyan(serving) : (body ? 'a response with no commit' : 'nothing (no answer)')}`);
    if (alreadyLive) ok(`${cyan(pre.short)} is already live — checks and deploy are skipped`);
  } else if (cfg.liveCheck) {
    // Once, like reading the health URL: a release that already passes is a
    // re-run of one that went live, so nothing is checked or deployed again.
    loadSecrets();
    out(`   → ${cfg.liveCheck}`);
    const r = await runLiveCheck(cfg.liveCheck, project.path, childEnv());
    out(`   ${dim(r.last)}`);
    alreadyLive = r.ok;
    if (alreadyLive) ok(`the live check passes: ${what} ${cyan(pre.tag ?? pre.short)} is already live — checks and deploy are skipped`);
    else ok(`not live yet (the live check exits ${r.status ?? 'without finishing'}) — step 8 runs it again after the deploy`);
  } else {
    ok('no health URL or live check declared — step 8 will ask you to confirm instead');
  }

  step(5, 'Checks');
  if (alreadyLive) ok('skipped — already live');
  else if (!cfg.checks.length) ok('none declared');
  else {
    // Secrets are already in process.env when `requires` named any; load them
    // regardless so a check sees the same environment the deploy will.
    loadSecrets();
    for (const c of cfg.checks) {
      out(`   → ${c}`);
      const r = await runDimmed(c, project.path);
      if (r.error) stop('Checks', `could not start \`${c}\`: ${r.error.message}`);
      if (r.status !== 0) stop('Checks', `\`${c}\` failed (exit ${r.status ?? r.signal}) — nothing was deployed`);
      ok(c);
    }
    const moved = checkoutStill(project.path, pre.sha);
    if (moved) stop('Checks', `${moved} — what was checked is not what would ship`);
    ok(`the checkout is still exactly ${cyan(pre.short)}`);
  }

  step(6, 'Confirm');
  // Plain sentences, each with a subject and a verb. No labels lined up with
  // spaces: the owner can't be expected to read alignment as meaning (an
  // earlier "7. Deploy  you, when asked: …" was unreadable). And every manual
  // step says "don't do it yet" — a wording that only listed the steps made
  // the owner press Deploy at this question instead of at step 7.
  const release = pre.tag ? `as ${pre.tag}` : 'without a release tag';
  out(`   You are about to publish ${what} ${pre.tag ? `as ${cyan(pre.tag)}` : release}. That is commit ${cyan(pre.short)}.`);
  out('');
  const next = [];
  if (alreadyLive) {
    next.push(`Nothing is deployed, because commit ${cyan(pre.short)} is already live.`);
  } else {
    if (cfg.command) next.push(`cogyard runs this command for you: ${cfg.command}`);
    for (const s of cfg.manual) {
      next.push(`cogyard asks you to do this by hand. ${magenta("Don't do it yet; cogyard tells you when.")}\n       "${s}"`);
    }
  }
  if (cfg.health) next.push(`cogyard waits up to ${limitMin} minutes for ${cyan(cfg.health)} to show commit ${cyan(pre.short)}.`);
  else if (cfg.liveCheck) next.push(`cogyard runs this live check every ${pollText}, up to ${limitMin} minutes, until it passes: ${cyan(cfg.liveCheck)}`);
  else next.push(`cogyard asks you whether commit ${cyan(pre.short)} is live, because nothing declared lets it check.`);
  next.push(pre.tag
    ? `cogyard tags commit ${cyan(pre.short)} as ${cyan(pre.tag)} and pushes the tag to ${pre.remote ?? 'nowhere (no remote)'}.`
    : 'No release tag is set, because this project turns tagging off.');
  out('   If you answer yes, these things happen in this order:');
  next.forEach((s, i) => out(`     ${i === 0 ? 'First' : i === next.length - 1 ? 'Last' : 'Then'}, ${s}`));
  out('');
  if (yes) ok('you passed --yes, so the publish starts');
  else {
    if (!process.stdin.isTTY) stop('Confirm', 'no terminal to ask in — pass --yes to confirm', 2);
    if (!(await yesNo(`   Start publishing ${what} ${release}?`))) stop('Confirm', 'you said no', 1);
    ok('started');
  }

  step(7, 'Deploy');
  if (alreadyLive) ok('skipped — already live');
  else {
    if (cfg.command) {
      const secrets = loadSecrets();
      if (!secrets.ok) stop('Deploy', `credentials not loaded — ${secrets.error}${secrets.fix ? ` (${secrets.fix})` : ''}`);
      out(`   → ${cfg.command}`);
      const r = spawnSync(cfg.command, { cwd: project.path, shell: true, stdio: 'inherit', env: childEnv() });
      if (r.error) stop('Deploy', `could not start the command: ${r.error.message}`);
      if (r.status !== 0) stop('Deploy', `the command exited ${r.status ?? r.signal}`, r.status || 1);
      ok('deploy command succeeded');
    }
    for (const [i, s] of cfg.manual.entries()) {
      // The one moment the owner acts: a yellow band, words only (the indent
      // stays outside it), so it can't be missed on a light or dark terminal.
      out(`   ${band(` Do this by hand now${cfg.manual.length > 1 ? ` (step ${i + 1} of ${cfg.manual.length})` : ''}: `)}`);
      out(`     ${band(` "${s}" `)}`);
      if (!(await yesNo('   Have you done it?'))) stop('Deploy', `you didn't confirm the hand step "${s}"`);
      ok('you did it');
    }
  }

  step(8, 'Verify');
  if (cfg.health) {
    out(`   waiting for ${cyan(cfg.health)} to serve ${cyan(pre.short)} (up to ${limitMin} min)`);
    const h = await waitForHealth(cfg.health, pre.sha);
    if (!h.ok) stop('Verify', `${pre.short} never went live — still serving ${h.last}. Check the platform's deploy log.`);
    ok(`${cyan(cfg.health)} serves ${cyan(pre.short)}`);
  } else if (cfg.liveCheck) {
    // No question (task 267): the declared check answers it. Each line below
    // is what the check printed last, shown when it changes.
    out(`   running the live check every ${pollText} (up to ${limitMin} min) until it passes:`);
    out(`   → ${cfg.liveCheck}`);
    loadSecrets();
    const l = await waitForLiveCheck(cfg.liveCheck, project.path, childEnv());
    if (!l.ok) stop('Verify', `the live check did not pass within ${limitMin} min — it last printed: ${l.last}`);
    ok(`live ✓ — ${what} ${cyan(pre.tag ?? pre.short)} passes the live check`);
  } else {
    // Nothing declared can answer, so the owner does — asked about exactly what
    // should now be live and what was just done to put it there, never a bare
    // "have you seen <sha> live?" (task 267: that question meant nothing).
    if (!process.stdin.isTTY) stop('Verify', 'nothing declared to check it is live, and no terminal to ask in', 2);
    const named = !pre.tag ? what
      : pre.tag === `v${pre.version}` ? `${what} ${pre.tag}` : `${what} ${pre.tag} (version ${pre.version})`;
    const done = [
      ...(cfg.command ? [`cogyard ran \`${cfg.command}\``] : []),
      ...cfg.manual.map((s) => `you did the hand step "${s}"`),
    ];
    out(`   Nothing in ${PUBLISH_CONFIG} lets cogyard check this itself (no "health" URL or "liveCheck" command), so you decide.`);
    if (!(await yesNo(`   Is ${named} (commit ${pre.short}) live, after ${done.join(' and ')}?`))) stop('Verify', 'you did not confirm it is live');
    ok('you confirmed it is live');
  }

  step(9, 'Tag');
  if (pre.tag) {
    const t = tagRelease(project.path, { tag: pre.tag, sha: pre.sha, remote: pre.remote, label: what });
    if (!t.ok) stop('Tag', `deployed and live, but ${t.error}`);
    ok(`${cyan(pre.tag)} → ${cyan(pre.short)}${t.pushed ? `, and ${pre.remote} has it` : ' (no remote)'}`);
  } else ok('skipped ("tag": false)');

  step(10, 'Record');
  record.ok = true;
  recordPublish(record);
  ok(dim(PUBLISH_LOG));
  lock.release();
  rl?.close();
  out(`\n${green(`Published ${what} ${pre.tag ?? pre.short}.`)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const [first, second, ...more] = args.filter((a) => !a.startsWith('-'));
  if (flags.has('--help') || flags.has('-h') || first === 'help') return help();
  if (!first || first === 'list') return list(flags.has('--json'));
  if (more.length) {
    process.stderr.write(`cogyard publish takes a project and at most one release — "${more.join(' ')}" is left over\n`);
    process.exit(2);
  }
  return publish(first, second ?? null, flags.has('--yes') || flags.has('-y'));
}

main();
