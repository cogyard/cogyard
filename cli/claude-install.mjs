#!/usr/bin/env node
// cli/claude-install.mjs — `cogyard claude install` / `uninstall`.
//
// Installs the Claude driver (the skills + commands vendored in
// drivers/claude/) into the user's Claude config dir, for environments where
// the `/plugin` marketplace flow isn't available. By DEFAULT it SYMLINKS the repo's
// files into ~/.claude (single source of truth — edit the repo, changes are live;
// uninstall just removes the links); `--copy` makes frozen copies instead.
//
// Hooks are NOT auto-wired — this prints the exact settings.json block to add, so
// the user stays in control of their config (no silent edits). The skills/commands
// call `cogyard …` on PATH, so the engine must be installed too (`npm i -g
// cogyard` or `npm link` in a clone).

import {
  existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync,
  unlinkSync, rmSync, cpSync, realpathSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));           // <pkg>/cli
const DRIVER = join(HERE, '..', 'drivers', 'claude');     // the plugin tree
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// The two component dirs we manage: <driver>/<kind> → <claude>/<kind>.
const KINDS = ['skills', 'commands'];

function fail(msg) { process.stderr.write(`cogyard claude: ${msg}\n`); process.exit(1); }

// Is `p` a symlink we own (points back into this driver tree)?
function isOurLink(p) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return false;
    return realpathSync(p).startsWith(realpathSync(DRIVER));
  } catch { return false; }
}

// skills/ holds dirs (<name>/SKILL.md); commands/ holds files (<name>.md).
// Each is linked under its PERSONAL name, `cogyard-<name>` (task 218: the
// adapter's personalName), so it never takes a name someone's own skill, a
// project's or Claude Code's uses. `legacy` is where an older install put it,
// under the bare name — install moves cogyard's own link from there.
function entries(kind, personalName) {
  const src = join(DRIVER, kind);
  if (!existsSync(src)) return [];
  return readdirSync(src).map((file) => {
    const ext = kind === 'commands' && file.endsWith('.md') ? '.md' : '';
    const bare = ext ? file.slice(0, -ext.length) : file;
    const personal = personalName(bare);
    return {
      bare, personal,
      src: join(src, file),
      entry: `${kind}/${personal}${ext}`,
      dest: join(CLAUDE_DIR, kind, `${personal}${ext}`),
      legacy: personal === bare ? null : join(CLAUDE_DIR, kind, file),
      legacyEntry: `${kind}/${file}`,
    };
  });
}

// A link into SOME cogyard checkout's drivers/claude/<kind>/<file> — e.g. one
// made from the main checkout, seen from a clone. Not ours to move: this
// checkout would repoint it at itself.
function isCogyardLink(p, kind, file) {
  try {
    if (!lstatSync(p).isSymbolicLink()) return false;
    return realpathSync(p).endsWith(`/drivers/claude/${kind}/${file}`);
  } catch { return false; }
}

async function claudeSkills() {
  const { loadAdapter } = await import('../core/drivers.mjs');
  return (await loadAdapter('claude')).skills;
}

// The driver's logo, for the portal's status line. The public repo ships none
// (it is Anthropic's trademark), so onboarding downloads the public copy the
// adapter names. A failure is only a note: the status line works without it.
async function installLogo() {
  const { loadAdapter } = await import('../core/drivers.mjs');
  const { fetchDriverLogo, logoFile } = await import('../core/driver-logo.mjs');
  const adapter = await loadAdapter('claude');
  const have = logoFile(adapter);
  if (have) { process.stdout.write(`\nDriver logo: ${have}\n`); return; }
  const r = await fetchDriverLogo(adapter);
  process.stdout.write(r.ok
    ? `\nDriver logo downloaded to ${r.path} (from ${adapter.liveState.logoSource.url}).\n`
    : `\nDriver logo not downloaded (${r.error}); the portal's status line shows no logo until you re-run \`cogyard claude install\`.\n`);
}

// --- name clashes (task 218) -------------------------------------------------
// What install puts in ~/.claude is a PERSONAL skill or command. In Claude
// Code a personal one beats a project's of the same name in every repo on the
// machine, a skill beats a command file of the same name, and a personal one
// with a built-in command's name replaces that built-in
// (code.claude.com/docs/en/skills, "Resolve skills that share a name"). So
// every name is `cogyard-<name>`, which people, projects and Claude Code leave
// alone — and before linking one, install still looks for anyone already
// using it: every registered project's own skills and commands, and Claude
// Code's own names. The plugin route is namespaced (/cogyard:<name>).

const PLUGIN_ROUTE = '/plugin marketplace add cogyard/cogyard, then /plugin install cogyard@cogyard';

// The projects to check: registered ones whose folder exists.
async function registeredProjects() {
  const { readRegistry } = await import('../core/registry.mjs');
  return readRegistry().filter((p) => p && p.path && existsSync(p.path));
}

// Every way cogyard's <kind>/<name>, installed personally, would take a name
// someone else uses → [sentence]. Empty = safe to link.
function clashesFor(kind, name, { projects, skills }) {
  const out = [];
  const what = kind === 'skills' ? 'skill' : 'command';
  for (const r of skills.reservedNames ? skills.reservedNames() : []) {
    if (r.name === name) out.push(`${name} is ${r.why} — a personal ${what} of that name would replace it`);
  }
  for (const p of projects) {
    const where = p.label || p.slug || p.path;
    for (const s of skills.projectSkills(p.path)) {
      if (s.name !== name) continue;
      out.push(kind === 'skills'
        ? `${where}: its own ${s.file} would never run — a personal skill wins over a project's`
        // A personal command against a project skill: the docs say a skill
        // beats a command file and a personal one beats a project's, not which
        // rule wins here. Either way only one of them runs.
        : `${where}: its own ${s.file} has the same name, and only one of the two would run`);
    }
    for (const c of skills.projectCommands ? skills.projectCommands(p.path) : []) {
      if (c.name !== name) continue;
      out.push(kind === 'skills'
        ? `${where}: its own ${c.file} would never run — a skill wins over a command file`
        : `${where}: its own ${c.file} would never run — a personal command wins over a project's`);
    }
  }
  return out;
}

// `--link-anyway a,b` / `--link-anyway=a,b` (repeatable) → Set of names.
function linkAnywayNames(args) {
  const names = new Set();
  args.forEach((a, i) => {
    const v = a.startsWith('--link-anyway=') ? a.slice('--link-anyway='.length)
      : a === '--link-anyway' ? (args[i + 1] || '') : null;
    if (v != null) for (const n of v.split(',').map((s) => s.trim()).filter(Boolean)) names.add(n);
  });
  return names;
}

async function install({ copy, rules, linkAnyway = new Set() }) {
  if (!existsSync(DRIVER)) fail(`driver tree not found at ${DRIVER}`);
  const skills = await claudeSkills();
  const projects = await registeredProjects();
  const done = [];
  const skipped = [];
  const moved = [];     // an older install's bare-name link of ours, now under the new name
  const elsewhere = []; // an older bare-name link into ANOTHER cogyard checkout — left
  const refused = [];   // [{ entry, personal, bare, clashes }] — not linked: the name is taken
  const kept = [];      // [{ entry, personal, dest, clashes }] — an earlier link of ours that clashes
  for (const kind of KINDS) {
    mkdirSync(join(CLAUDE_DIR, kind), { recursive: true });
    for (const { bare, personal, src, entry, dest, legacy, legacyEntry } of entries(kind, skills.personalName)) {
      const ours = isOurLink(dest);
      if (existsSync(dest) && !ours) { skipped.push(`${entry} (exists — left untouched)`); continue; }
      const clashes = clashesFor(kind, personal, { projects, skills });
      const blocked = clashes.length > 0 && !linkAnyway.has(personal) && !linkAnyway.has(bare);
      // An earlier install's link stays where it is, even when it clashes:
      // removing it would change a working setup behind the owner's back. The
      // output says what it hides instead.
      if (blocked && !ours) { refused.push({ entry, personal, bare, clashes }); continue; }
      // Refresh our own prior links; never clobber a user's real file/dir.
      if (ours) { try { unlinkSync(dest); } catch {} }
      if (copy) cpSync(src, dest, { recursive: true });
      else symlinkSync(src, dest);
      if (blocked) kept.push({ entry, personal, dest, clashes });
      else done.push(`${entry}  (/${personal})${clashes.length ? ` — linked anyway with --link-anyway; the name is also used: ${clashes.join('; ')}` : ''}`);
      // The older bare-name link: the new name now carries it, so ours goes.
      // A link into another cogyard checkout is that checkout's to move.
      if (legacy && isOurLink(legacy)) { unlinkSync(legacy); moved.push(`${legacyEntry} → ${entry}  (type /${personal} instead of /${bare})`); }
      else if (legacy && isCogyardLink(legacy, kind, legacyEntry.slice(kind.length + 1))) elsewhere.push({ legacyEntry, target: realpathSync(legacy), bare });
    }
  }

  process.stdout.write(`cogyard claude driver ${copy ? 'copied' : 'linked'} into ${CLAUDE_DIR}:\n`);
  for (const d of done) process.stdout.write(`  + ${d}\n`);
  for (const m of moved) process.stdout.write(`  → ${m}\n`);
  for (const s of skipped) process.stdout.write(`  ~ ${s}\n`);
  for (const e of elsewhere) {
    process.stdout.write(`  ~ ${e.legacyEntry} — an older install's link into another cogyard checkout (${e.target}); left. While it is there, /${e.bare} still hides a project's own ${e.bare}. Re-run \`cogyard claude install\` from that checkout to move it.\n`);
  }
  for (const r of refused) {
    process.stdout.write(`  ✗ ${r.entry} — not ${copy ? 'copied' : 'linked'}: the name /${r.personal} is already in use\n`);
    for (const c of r.clashes) process.stdout.write(`      · ${c}\n`);
    process.stdout.write(`      Get it without the clash from the cogyard plugin, as /cogyard:${r.bare} (${PLUGIN_ROUTE}),\n`);
    process.stdout.write(`      or ${copy ? 'copy' : 'link'} it anyway: cogyard claude install${copy ? ' --copy' : ''} --link-anyway ${r.personal}\n`);
  }
  for (const k of kept) {
    process.stdout.write(`  ! ${k.entry} — linked by an earlier install, and the name /${k.personal} is also used here:\n`);
    for (const c of k.clashes) process.stdout.write(`      · ${c}\n`);
    process.stdout.write(`      Left in place. To stop it, remove that one link: rm ${k.dest}  (only the link — the repo's file stays)\n`);
  }
  if (done.length || moved.length) {
    process.stdout.write(`\ncogyard's skills and commands are /cogyard-<name> here (/cogyard stays /cogyard), so they never take a name your own skills, a project's, or Claude Code's use. Asking in your own words ("merge it") works as before.\n`);
  }
  process.stdout.write(`\nNow add these hooks to ${join(CLAUDE_DIR, 'settings.json')} (merge into any existing "hooks"):\n\n`);
  process.stdout.write(hooksBlock());
  try { await installLogo(); } catch (e) { process.stdout.write(`\nDriver logo skipped: ${e.message}\n`); }
  if (rules) { process.stdout.write('\n'); installRules(); }
  else process.stdout.write(`\nTip: re-run with \`--rules\` to also write cogyard's always-on operating rules into ${join(CLAUDE_DIR, 'CLAUDE.md')} (a plugin can't deliver those on its own).\n`);

  process.stdout.write(`\nThe skills call \`cogyard …\` on PATH — install the engine too: \`npm i -g cogyard\` (or \`npm link\` in a clone). Undo: \`cogyard claude uninstall\`.\n`);
}

async function uninstall() {
  const skills = await claudeSkills();
  const removed = [];
  const left = [];
  for (const kind of KINDS) {
    for (const { entry, dest, legacy, legacyEntry } of entries(kind, skills.personalName)) {
      if (isOurLink(dest)) { unlinkSync(dest); removed.push(`${entry} (link)`); }
      else if (existsSync(dest)) {
        // A --copy install: the cogyard-<name> is cogyard's by name.
        try { rmSync(dest, { recursive: true, force: true }); removed.push(`${entry} (copy)`); } catch {}
      }
      // An older install's bare-name entry: a link of ours goes; anything else
      // under a bare name may be the person's own, so it stays.
      if (legacy && isOurLink(legacy)) { unlinkSync(legacy); removed.push(`${legacyEntry} (link, older install)`); }
      else if (legacy && existsSync(legacy) && !lstatSync(legacy).isSymbolicLink()) left.push(legacyEntry);
    }
  }
  for (const l of left) process.stdout.write(`~ ${l} left: not a link, so it may be your own (an older \`--copy\` install put cogyard's copies under bare names — remove it by hand if it is cogyard's)\n`);
  const rulesRemoved = removeRules();
  if (rulesRemoved) removed.push('CLAUDE.md operating-rules block');
  if (!removed.length) { process.stdout.write('cogyard claude: nothing installed to remove.\n'); return; }
  process.stdout.write(`Removed from ${CLAUDE_DIR}:\n`);
  for (const r of removed) process.stdout.write(`  - ${r}\n`);
  process.stdout.write('\n(Hooks in settings.json were NOT touched — remove the cogyard hook lines by hand if you added them.)\n');
}

// --- operating rules → the user's CLAUDE.md -------------------------------
// A plugin cannot inject always-on context, and CLAUDE.md is the only reliable
// always-on channel. So `--rules` writes the canonical rules (instructions.md)
// into <claude>/CLAUDE.md between markers (idempotent: refresh-in-place; uninstall
// removes the block). This is the consented "copy the snippet" step, automated.
const RULES_BEGIN = '<!-- cogyard:rules:begin (managed by `cogyard claude install --rules`; source: drivers/claude/instructions.md) -->';
const RULES_END = '<!-- cogyard:rules:end -->';
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function rulesRe() { return new RegExp('\\n*' + escapeRe(RULES_BEGIN) + '[\\s\\S]*?' + escapeRe(RULES_END) + '\\n*'); }

function installRules() {
  const src = join(DRIVER, 'instructions.md');
  if (!existsSync(src)) fail(`rules source not found at ${src}`);
  const md = join(CLAUDE_DIR, 'CLAUDE.md');
  const block = `${RULES_BEGIN}\n\n${readFileSync(src, 'utf8').trim()}\n\n${RULES_END}`;
  let content = existsSync(md) ? readFileSync(md, 'utf8') : '';
  const had = rulesRe().test(content);
  content = had ? content.replace(rulesRe(), `\n\n${block}\n\n`)
                : `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${block}\n`;
  writeFileSync(md, content);
  process.stdout.write(`cogyard operating rules ${had ? 'refreshed in' : 'written into'} ${md} (between the cogyard:rules markers).\n`);
}

function removeRules() {
  const md = join(CLAUDE_DIR, 'CLAUDE.md');
  if (!existsSync(md)) return false;
  const content = readFileSync(md, 'utf8');
  if (!rulesRe().test(content)) return false;
  writeFileSync(md, content.replace(rulesRe(), '\n'));
  return true;
}

function hooksBlock() {
  // The worktree guard is plugin-local like the task-skill guard (it judges
  // Claude Code's own worktree tools), so a manual install points at the file
  // in the repo. It runs on Bash and on EnterWorktree / ExitWorktree.
  const worktreeGuard = { type: 'command', command: `node "${join(DRIVER, 'hooks', 'pretooluse-guard-worktree.mjs')}"`, timeout: 15 };
  const block = {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'cogyard hook session-start' }] }],
    PreToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'cogyard hook validate-frontmatter', timeout: 15 }] },
      { matcher: 'Bash', hooks: [
        { type: 'command', command: 'cogyard hook guard-branch-switch', timeout: 15 },
        { type: 'command', command: 'cogyard hook guard-dev-server', timeout: 15 },
        { type: 'command', command: 'cogyard hook guard-task-store', timeout: 15 },
        worktreeGuard,
      ] },
      { matcher: 'EnterWorktree|ExitWorktree', hooks: [worktreeGuard] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: join(CLAUDE_DIR, 'skills', 'task-skill-guard.sh') }] }],
  };
  // The UserPromptSubmit guard ships in the plugin (hooks/), not as a skill; for a
  // manual install the simplest is to point at the plugin file in the repo.
  block.UserPromptSubmit[0].hooks[0].command = join(DRIVER, 'hooks', 'userpromptsubmit-task-skill-guard.sh');
  // The live-state hook (task 202): every event that changes what a chat is
  // doing, for the Plan and Tasks tabs' status line. Same list as the plugin's
  // hooks.json. Never blocks, always exits 0.
  const live = { type: 'command', command: 'cogyard hook live-state', timeout: 5 };
  for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) (block[ev] ||= []).push({ matcher: '*', hooks: [live] });
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'Elicitation', 'ElicitationResult', 'SessionEnd']) (block[ev] ||= []).push({ hooks: [live] });
  return JSON.stringify({ hooks: block }, null, 2) + '\n';
}

const [, , sub, ...rest] = process.argv;
switch (sub) {
  case 'install': install({ copy: rest.includes('--copy'), rules: rest.includes('--rules'), linkAnyway: linkAnywayNames(rest) }); break;
  case 'uninstall': await uninstall(); break;
  default:
    process.stdout.write(`cogyard claude — install the Claude driver (skills + commands) into ${CLAUDE_DIR}

Usage:
  cogyard claude install [--copy] [--rules] [--link-anyway <name>[,<name>…]]
        symlink (default) or --copy the skills/commands; prints the settings.json
        hook block; --rules also writes cogyard's always-on operating rules into
        CLAUDE.md (a plugin can't deliver those itself).
        Each is linked as /cogyard-<name> (/cogyard stays /cogyard), so it
        never takes a name your own skills, a project's or Claude Code's use;
        an older install's bare-name links are moved to the new names. A name
        that is in use anyway is NOT linked, and the output says which and
        why; --link-anyway <name> links it regardless. The plugin route's
        names are /cogyard:<name>.
  cogyard claude uninstall
        remove what install added — skills/commands + the CLAUDE.md rules block
        (hooks in settings.json stay — edit those by hand).

For environments without the /plugin marketplace flow. Needs the engine on PATH
(\`npm i -g cogyard\` or \`npm link\`).
`);
    process.exit(sub && sub !== '--help' && sub !== '-h' ? 1 : 0);
}
