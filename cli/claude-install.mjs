#!/usr/bin/env node
// cli/claude-install.mjs — `cogyard claude install` / `uninstall`.
//
// Installs the Claude driver (the skills + commands vendored in
// integrations/claude/) into the user's Claude config dir, for environments where
// the `/plugin` marketplace flow isn't available. By DEFAULT it SYMLINKS the repo's
// files into ~/.claude (single source of truth — edit the repo, changes are live;
// uninstall just removes the links); `--copy` makes frozen copies instead.
//
// Hooks are NOT auto-wired — this prints the exact settings.json block to add, so
// the user stays in control of their config (no silent edits). The skills/commands
// call `cogyard …` on PATH, so the engine must be installed too (`npm i -g
// @cogyard/cli` or `npm link` in a clone).

import {
  existsSync, mkdirSync, readdirSync, lstatSync, readlinkSync, symlinkSync,
  unlinkSync, rmSync, cpSync, realpathSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));           // <pkg>/cli
const DRIVER = join(HERE, '..', 'integrations', 'claude');     // the plugin tree
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

function entries(kind) {
  const src = join(DRIVER, kind);
  if (!existsSync(src)) return [];
  // skills/ holds dirs (<name>/SKILL.md); commands/ holds files (<name>.md).
  return readdirSync(src).map((name) => ({ name, src: join(src, name), dest: join(CLAUDE_DIR, kind, name) }));
}

function install({ copy, rules }) {
  if (!existsSync(DRIVER)) fail(`driver tree not found at ${DRIVER}`);
  const done = [];
  const skipped = [];
  for (const kind of KINDS) {
    mkdirSync(join(CLAUDE_DIR, kind), { recursive: true });
    for (const { name, src, dest } of entries(kind)) {
      if (existsSync(dest) || isOurLink(dest)) {
        // Refresh our own prior links; never clobber a user's real file/dir.
        if (isOurLink(dest)) { try { unlinkSync(dest); } catch {} }
        else { skipped.push(`${kind}/${name} (exists — left untouched)`); continue; }
      }
      if (copy) cpSync(src, dest, { recursive: true });
      else symlinkSync(src, dest);
      done.push(`${kind}/${name}`);
    }
  }

  process.stdout.write(`cogyard claude driver ${copy ? 'copied' : 'linked'} into ${CLAUDE_DIR}:\n`);
  for (const d of done) process.stdout.write(`  + ${d}\n`);
  for (const s of skipped) process.stdout.write(`  ~ ${s}\n`);
  process.stdout.write(`\nNow add these hooks to ${join(CLAUDE_DIR, 'settings.json')} (merge into any existing "hooks"):\n\n`);
  process.stdout.write(hooksBlock());
  if (rules) { process.stdout.write('\n'); installRules(); }
  else process.stdout.write(`\nTip: re-run with \`--rules\` to also write cogyard's always-on operating rules into ${join(CLAUDE_DIR, 'CLAUDE.md')} (a plugin can't deliver those on its own).\n`);

  process.stdout.write(`\nThe skills call \`cogyard …\` on PATH — install the engine too: \`npm i -g @cogyard/cli\` (or \`npm link\` in a clone). Undo: \`cogyard claude uninstall\`.\n`);
}

function uninstall() {
  const removed = [];
  for (const kind of KINDS) {
    for (const { name, dest } of entries(kind)) {
      if (isOurLink(dest)) { unlinkSync(dest); removed.push(`${kind}/${name} (link)`); }
      else if (existsSync(dest)) {
        // A --copy install: remove only if it matches our tree by name (best-effort).
        try { rmSync(dest, { recursive: true, force: true }); removed.push(`${kind}/${name} (copy)`); } catch {}
      }
    }
  }
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
const RULES_BEGIN = '<!-- cogyard:rules:begin (managed by `cogyard claude install --rules`; source: integrations/claude/instructions.md) -->';
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
  const block = {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'cogyard hook session-start' }] }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'cogyard hook validate-frontmatter', timeout: 15 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: join(CLAUDE_DIR, 'skills', 'task-skill-guard.sh') }] }],
  };
  // The UserPromptSubmit guard ships in the plugin (hooks/), not as a skill; for a
  // manual install the simplest is to point at the plugin file in the repo.
  block.UserPromptSubmit[0].hooks[0].command = join(DRIVER, 'hooks', 'userpromptsubmit-task-skill-guard.sh');
  return JSON.stringify({ hooks: block }, null, 2) + '\n';
}

const [, , sub, ...rest] = process.argv;
switch (sub) {
  case 'install': install({ copy: rest.includes('--copy'), rules: rest.includes('--rules') }); break;
  case 'uninstall': uninstall(); break;
  default:
    process.stdout.write(`cogyard claude — install the Claude driver (skills + commands) into ${CLAUDE_DIR}

Usage:
  cogyard claude install [--copy] [--rules]
        symlink (default) or --copy the skills/commands; prints the settings.json
        hook block; --rules also writes cogyard's always-on operating rules into
        CLAUDE.md (a plugin can't deliver those itself).
  cogyard claude uninstall
        remove what install added — skills/commands + the CLAUDE.md rules block
        (hooks in settings.json stay — edit those by hand).

For environments without the /plugin marketplace flow. Needs the engine on PATH
(\`npm i -g @cogyard/cli\` or \`npm link\`).
`);
    process.exit(sub ? 1 : 0);
}
