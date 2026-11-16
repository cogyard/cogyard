// drivers/claude/adapter.mjs — the Claude Code driver.
//
// This IS the reference adapter AND (with the sibling .claude-plugin/, skills/,
// commands/, hooks/) a Claude Code plugin. It implements the three engine seams
// for Claude Code with behaviour byte-identical to the previously hardcoded
// engine — moving the Claude-specific logic here is a no-regression refactor.
//
// Seams (see docs/DRIVERS.md for the contract):
//   worktree    — <repo>/.claude/worktrees/<name> layout + claude/* branches
//   transcripts — ~/.claude/projects/<flattened-cwd>/<session>.jsonl + token parse
//   pricing     — Claude model price table + opus/sonnet/haiku aliases, plus the
//                 live-rate feed the engine syncs from (./pricing-sync.mjs)
//   sessions    — Claude Desktop chat metadata for `cogyard sessions audit`
//   liveState   — Claude Code hook input → working / needs / stopped / closed
//   agent       — headless, tool-less `claude -p` for scheduled jobs
//   skills      — project skills, CLAUDE*.md, skillOverrides, how cogyard is installed

import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { fetchPricing } from './pricing-sync.mjs';

const HOME = homedir();
// Where `cogyard claude install` puts the skills, and where Claude Code keeps
// its plugin list. CLAUDE_CONFIG_DIR is Claude Code's own override.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
// The skills this driver ships: drivers/claude/skills/<name>/SKILL.md.
const DRIVER_DIR = dirname(fileURLToPath(import.meta.url));
const SHIPPED_SKILLS_DIR = join(DRIVER_DIR, 'skills');
// …and the commands: drivers/claude/commands/<name>.md.
const SHIPPED_COMMANDS_DIR = join(DRIVER_DIR, 'commands');
// The names Claude Code itself uses for a slash command (task 218), copied from
// its docs — see the file's own `about`.
const BUILTIN_NAMES_FILE = join(DRIVER_DIR, 'builtin-names.json');
// A project's own skills and commands, and the two settings files whose
// `skillOverrides` can turn a skill off for that project (shared, then just-you).
const PROJECT_SKILLS_DIR = '.claude/skills';
const PROJECT_COMMANDS_DIR = '.claude/commands';
const PROJECT_SETTINGS = '.claude/settings.json';
const PROJECT_SETTINGS_FILES = [PROJECT_SETTINGS, '.claude/settings.local.json'];
// The plugin's id in Claude Code's plugin list is `cogyard@<marketplace>`, and
// its skills are namespaced `cogyard:<name>`.
const PLUGIN_NAME = 'cogyard';
// How long a killed agent gets to exit on its own before SIGKILL. Every stalled
// call in a run pays this once, so it is short.
const KILL_GRACE_MS = 2000;
const TRANSCRIPTS_ROOT = join(HOME, '.claude', 'projects');
// Claude Desktop's chat metadata (macOS): one whole-file JSON per chat, nested
// two dirs deep. NOT jsonl — a line-by-line parser silently yields zero rows.
const DESKTOP_SESSIONS_ROOT = join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
// <repo>/.claude/worktrees/<name> — capture the repo root and the worktree name.
const WORKTREE_RE = /^(.*)\/\.claude\/worktrees\/([^/]+)/;
// The same layout mentioned ANYWHERE in a string (a shell command, an argument)
// — global, unanchored, name only. Stops at whitespace, quotes and shell
// punctuation so `…/<name>"` and `…/<name> && …` yield the bare name.
const WORKTREE_MENTION_RE = /\.claude\/worktrees\/([^/\s"'`;&|)]+)/g;
// Claude Code's tools that write a file the agent names (task 152: "the chat
// edited this task's file" is a worked-on signal).
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Transcript dirs are flattened cwds; a session's transcript is <dir>/<id>.jsonl.
function transcriptsBySession(sessionId) {
  if (!sessionId || !existsSync(TRANSCRIPTS_ROOT)) return [];
  const files = [];
  for (const dir of readdirSync(TRANSCRIPTS_ROOT)) {
    const candidate = join(TRANSCRIPTS_ROOT, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) files.push(candidate);
  }
  return files;
}

// One transcript line → the words the OWNER typed on it, or null (task 237).
// Stricter than the human-turn predicate readTurns uses, because these words
// authorize owner-only commands: a line counts only when Claude Code marks it
// as typed by a person (`origin.kind: "human"`; an older line with no marker
// at all is taken as typed). Never the owner's: a skill's expanded body
// (`isMeta` — its ARGUMENTS line is the agent's text), a compaction summary, a
// helper agent's line, another chat's message (`peer`), a task notification,
// an app message (`promptSource: "system"`). Inside a typed line, pasted text
// and injected `<tag>…</tag>` blocks are cut out; a slash command keeps only
// the arguments the owner typed. A question the agent asked counts only
// through what the owner wrote themself — an "Other" answer or a note —
// never an option the agent wrote and the owner clicked.
function ownerTextOf(obj) {
  if (!obj || obj.type !== 'user' || obj.isMeta || obj.isSidechain || obj.isCompactSummary) return null;
  const r = obj.toolUseResult;
  if (r) {
    if (!r.answers || typeof r.answers !== 'object' || !Array.isArray(r.questions)) return null;
    const labels = new Set();
    for (const q of r.questions) for (const o of (q && q.options) || []) if (o && o.label) labels.add(o.label);
    const typed = Object.values(r.answers).filter((a) => typeof a === 'string' && !labels.has(a));
    for (const n of Object.values(r.annotations || {})) if (n && typeof n.notes === 'string') typed.push(n.notes);
    return typed.join('\n').trim() || null;
  }
  if (obj.origin ? obj.origin.kind !== 'human' : (obj.turnOrigin && obj.turnOrigin !== 'human')) return null;
  if (obj.promptSource === 'system') return null;
  const c = obj.message && obj.message.content;
  let text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
  text = text.replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1 ');
  let prev;
  do { prev = text; text = text.replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, ' '); } while (text !== prev);
  text = text.trim();
  if (!text || text.startsWith('[Request interrupted')) return null;
  return text;
}

// Was this transcript's chat started in Claude Desktop? Every line Claude Code
// writes carries `entrypoint` ("claude-desktop", or "cli" for a terminal chat),
// so the file's head is enough.
function startedInDesktop(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').includes('"entrypoint":"claude-desktop"');
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

// --- pricing -----------------------------------------------------------------
// The SEED table: what pricing falls back to on a machine that has never synced,
// or when the feed is unreachable. It is NOT the maintained source of truth —
// `pricing.sync()` (drivers/claude/pricing-sync.mjs) pulls live rates and the
// engine stores them in $COGYARD_HOME/pricing.json, ahead of these. Don't hand-
// edit this table to add a newly-released model; let a sync do it, and if a sync
// can't, that's the bug to fix.
//
// Rates are $ per MILLION tokens. Newest first; `models` keys are the exact
// `message.model` strings seen in Claude Code transcripts. The cache-tier math
// and version-locking live in core/pricing.mjs — this is just the data.
const PRICING_VERSIONS = [
  {
    version: '2026-08-06',
    effective: '2026-08-06',
    source: 'claude-api skill pricing table (cached 2026-06-24) — adds claude-opus-5',
    models: {
      'claude-fable-5': { input: 10, output: 50 },
      'claude-mythos-5': { input: 10, output: 50 },
      'claude-opus-5': { input: 5, output: 25 },
      'claude-opus-4-8': { input: 5, output: 25 },
      'claude-opus-4-7': { input: 5, output: 25 },
      'claude-opus-4-6': { input: 5, output: 25 },
      'claude-sonnet-5': { input: 3, output: 15 },
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'claude-haiku-4-5': { input: 1, output: 5 },
    },
  },
  {
    version: '2026-06-12',
    effective: '2026-06-12',
    source: 'claude-api skill pricing table (cached 2026-05-26)',
    models: {
      'claude-fable-5': { input: 10, output: 50 },
      'claude-opus-4-8': { input: 5, output: 25 },
      'claude-opus-4-7': { input: 5, output: 25 },
      'claude-opus-4-6': { input: 5, output: 25 },
      'claude-sonnet-5': { input: 3, output: 15 },
      'claude-sonnet-4-6': { input: 3, output: 15 },
      'claude-haiku-4-5': { input: 1, output: 5 },
    },
  },
];

const ALIASES = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  haiku: 'claude-haiku-4-5',
};

// Claude Code transcript `usage` block → the ledger's fixed token shape.
function tokensFromUsage(usage) {
  const split = usage.cache_creation;
  const has5m = split && typeof split.ephemeral_5m_input_tokens === 'number';
  const has1h = split && typeof split.ephemeral_1h_input_tokens === 'number';
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    // Older transcripts lack the tier split — Claude Code's default is the
    // 5-minute cache, so the flat number lands there.
    cacheWrite5m: has5m ? split.ephemeral_5m_input_tokens : (has5m || has1h ? 0 : (usage.cache_creation_input_tokens || 0)),
    cacheWrite1h: has1h ? split.ephemeral_1h_input_tokens : 0,
  };
}

// WHERE THE BINARY IS. Bare `spawn('claude')` searches the inherited PATH, and
// the process that matters here is a LaunchAgent, whose PATH is a short fixed
// list set in a plist — not a login shell's. Claude Code installs itself to
// `~/.local/bin`, which is on neither that list nor any system default, so the
// always-on portal spawned `claude` and got ENOENT while the identical call
// from a terminal worked. Verified against the live portal 2026-08-19: its PATH
// is `<nvm node>:/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin`, and the
// binary is at `~/.local/bin/claude`.
//
// Locating the agent's own binary is an agent literal, so it belongs to this
// driver — core must never learn a program name. `CLAUDE_CODE_BIN` is the
// escape hatch for an install this list does not know.
function agentBin() {
  const override = process.env.CLAUDE_CODE_BIN;
  if (override) return existsSync(override) ? override : null;

  const onPath = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v claude'], { encoding: 'utf8' });
  const found = String(onPath.stdout || '').trim();
  if (found && existsSync(found)) return found;

  for (const c of [
    join(HOME, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(HOME, '.claude/local/claude'),
  ]) if (existsSync(c)) return c;

  return null;
}

// Which model actually ANSWERED. `modelUsage` routinely carries more than one
// entry: the CLI makes small auxiliary calls (a cheap model doing housekeeping)
// alongside the model that produced the result, and the auxiliary one is often
// FIRST. Reading `Object.keys(...)[0]` therefore reported the wrong model —
// observed 2026-08-19, where a run whose answer came from claude-sonnet-5 was
// reported as claude-haiku-4-5 because haiku billed 12 output tokens of
// overhead. Attribute by output tokens: the model that wrote the text is the
// model that wrote the most of it.
function answeringModel(modelUsage) {
  const rows = Object.entries(modelUsage || {});
  if (!rows.length) return null;
  let best = null;
  let bestOut = -1;
  for (const [id, u] of rows) {
    const out = Number(u?.outputTokens) || 0;
    if (out > bestOut) { bestOut = out; best = id; }
  }
  return best;
}

// --- skills (task 133) -------------------------------------------------------
// Claude Code never merges two skills; which one runs is decided by how cogyard
// was installed (drivers/claude/README.md, "Skipping or replacing a skill in
// one project"). These read the facts that decide it.

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function samePath(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); }
}

function shippedSkillNames() {
  try {
    return readdirSync(SHIPPED_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(SHIPPED_SKILLS_DIR, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}

// <dir>/<name>.md → [name], sorted. Top level only: a file in a subfolder is
// `/<folder>:<name>` to Claude Code, a different name.
function commandNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.md'))
      .map((d) => d.name.slice(0, -3))
      .sort();
  } catch { return []; }
}

// cogyard's personal name for its skill or command <name> (task 218).
const PERSONAL_PREFIX = 'cogyard-';
function personalName(name) {
  return name === PLUGIN_NAME || name.startsWith(PERSONAL_PREFIX) ? name : `${PERSONAL_PREFIX}${name}`;
}

// Is <path> one of cogyard's own entries — a link into some cogyard checkout's
// drivers/claude/<kind>/<entry>? Any checkout counts (a link made from the main
// checkout, read from a worktree), so the test is the target's shape. A plain
// folder or file there is someone's own, never cogyard's.
function isCogyardEntry(path, kind, entry) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    return realpathSync(path).endsWith(`/drivers/claude/${kind}/${entry}`);
  } catch { return false; }
}

// The day a shipped skill last changed: its last commit when the driver sits in
// a git checkout (a clone or `npm link`), else the file's own date (an npm
// install has no history).
function skillChanged(name) {
  const r = spawnSync('git', ['-C', DRIVER_DIR, 'log', '-1', '--format=%cs', '--', join('skills', name)], { encoding: 'utf8' });
  const day = String(r.stdout || '').trim();
  if (r.status === 0 && /^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  try { return statSync(join(SHIPPED_SKILLS_DIR, name, 'SKILL.md')).mtime.toISOString().slice(0, 10); } catch { return null; }
}

// Is the cogyard plugin on for this project? A user-scope install applies
// everywhere; a project- or local-scope one only to its own folder.
function pluginOn(repoRoot) {
  const list = readJson(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'));
  const plugins = list && typeof list.plugins === 'object' ? list.plugins : {};
  for (const [id, installs] of Object.entries(plugins)) {
    if (id.split('@')[0] !== PLUGIN_NAME) continue;
    for (const i of Array.isArray(installs) ? installs : []) {
      if (!i || i.scope === 'user' || !i.scope) return true;
      if (repoRoot && i.projectPath && samePath(i.projectPath, repoRoot)) return true;
    }
  }
  return false;
}

export default {
  name: 'claude',

  // Active when running under Claude Code, or when the Claude config dir exists.
  detect() {
    return !!process.env.CLAUDECODE
      || !!process.env.CLAUDE_PROJECT_DIR
      || existsSync(join(HOME, '.claude'));
  },

  // Was THIS process started by Claude Code (a tool call), not a human's shell?
  // Narrower than detect(): no ~/.claude fallback, because an installed agent is
  // not the same as the agent running this command. Claude Code sets these in
  // every shell it spawns. Used to keep owner-only commands (cogyard publish,
  // task 170) out of an agent's reach.
  inSession() {
    return !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE || process.env.CLAUDE_PROJECT_DIR);
  },

  // The id of the chat that started THIS process, or null (task 225). Claude
  // Code exports it to every shell it spawns; it is the same id a claim records
  // (`cogyard env claim <file> <session-id>`) and the transcript's file name.
  sessionId() {
    return process.env.CLAUDE_CODE_SESSION_ID || null;
  },

  worktree: {
    // <repo>/.claude/worktrees/<name> → {parentRepo, name}; else null.
    detect(path) {
      if (!path) return null;
      const m = String(path).match(WORKTREE_RE);
      return m ? { parentRepo: m[1], name: m[2] } : null;
    },
    branchPrefix: 'claude/',
  },

  transcripts: {
    supported: true,
    root() { return TRANSCRIPTS_ROOT; },
    // Recursive: subagent transcripts live nested under
    // <project>/<sessionId>/subagents/agent-*.jsonl and carry real usage.
    list() {
      if (!existsSync(TRANSCRIPTS_ROOT)) return [];
      const files = [];
      for (const rel of readdirSync(TRANSCRIPTS_ROOT, { recursive: true })) {
        if (String(rel).endsWith('.jsonl')) files.push(join(TRANSCRIPTS_ROOT, String(rel)));
      }
      return files;
    },
    findBySession: transcriptsBySession,
    // Every chat's MAIN transcript (helper logs excluded) under root — default
    // root(); a different root is a copy with the same layout (the chat-archive
    // add-on's, task 151). → [{ sessionId, file }]. A chat that switched folders
    // mid-way (into a worktree) has one file under EACH folder, so a sessionId
    // can appear more than once — pickFullest() chooses between them.
    sessionFiles(root = TRANSCRIPTS_ROOT) {
      if (!root || !existsSync(root)) return [];
      const out = [];
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        let names;
        try { names = readdirSync(join(root, dir.name)); } catch { continue; }
        for (const f of names) {
          if (f.endsWith('.jsonl')) out.push({ sessionId: f.slice(0, -'.jsonl'.length), file: join(root, dir.name, f) });
        }
      }
      return out;
    },
    // Several transcript files for ONE chat → the one to read: the most messages
    // (user + assistant lines), ties → the newest mtime. The two copies can
    // differ a lot (78 vs 620 messages, seen 2026-10-13), so "first found" can
    // show the short one. null for an empty list.
    pickFullest(files) {
      if (!files || !files.length) return null;
      if (files.length === 1) return files[0];
      const score = (file) => {
        let messages = 0;
        let mtime = 0;
        try {
          mtime = statSync(file).mtimeMs;
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.type === 'user' || obj.type === 'assistant') messages++;
          }
        } catch {}
        return { file, messages, mtime };
      };
      return files.map(score)
        .sort((a, b) => b.messages - a.messages || b.mtime - a.mtime)[0].file;
    },
    // The logs of the helper agents this session spawned (the Agent tool):
    // <dir>/<sessionId>/subagents/*.jsonl. Their lines carry the PARENT's
    // sessionId, and their commands are that chat's work — an autopilot chat's
    // commits are made by its helpers (task 152). Kept apart from findBySession,
    // whose callers (chat labels, `usage session`) want the main log only.
    findHelpersBySession(sessionId) {
      if (!sessionId || !existsSync(TRANSCRIPTS_ROOT)) return [];
      const files = [];
      for (const dir of readdirSync(TRANSCRIPTS_ROOT)) {
        const sub = join(TRANSCRIPTS_ROOT, dir, sessionId, 'subagents');
        if (!existsSync(sub)) continue;
        for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f));
      }
      return files;
    },
    // One raw JSONL line → {sessionId, cwd, usage, prompt, worktreesTouched,
    // commands, filesWritten}.
    // usage is the billable assistant turn ({model, timestamp, dedupeKey,
    // tokens}) or null. prompt is a HUMAN prompt event ({timestamp, dedupeKey})
    // or null — the attention signal — the human's own messages, not the
    // agent's turns. worktreesTouched is the worktree NAMES this line's own
    // tool calls name (see below); [] on every other line. commands is the
    // shell commands this line's tool calls RAN (Bash input), filesWritten the
    // paths its edit/write tool calls targeted — the chat's own actions, never
    // text it merely read or quoted (task 152).
    parseLine(line) {
      let obj;
      try { obj = JSON.parse(line); } catch { return null; }
      const out = { sessionId: obj.sessionId || null, cwd: obj.cwd || null, usage: null, prompt: null, worktreesTouched: [], commands: [], filesWritten: [] };
      if (obj.type === 'assistant') {
        const msg = obj.message;
        if (msg && msg.usage && msg.model && msg.model !== '<synthetic>') {
          out.usage = {
            model: msg.model,
            timestamp: obj.timestamp || null,
            // streaming repeats the same message id — dedupe on requestId:msgId.
            dedupeKey: `${obj.requestId || ''}:${msg.id || obj.uuid}`,
            tokens: tokensFromUsage(msg.usage),
          };
        }
        // Worktrees this turn OPERATED ON, from the agent's own tool calls —
        // a Bash command's `git -C .claude/worktrees/<name>` or `worktree add
        // …/<name>`, an EnterWorktree by name. An orchestrator that never
        // changes directory into the worktrees it creates and drives leaves
        // no cwd trace in them; this is the evidence it does leave. Only the
        // tool_use INPUT is read — never a tool RESULT, where `git worktree
        // list` output names every worktree on the machine and a grep echoes
        // whatever it searched for (both seen live, 2026-09-18).
        const blocks = msg && Array.isArray(msg.content) ? msg.content : [];
        const names = new Set();
        for (const b of blocks) {
          if (!b || b.type !== 'tool_use' || !b.input) continue;
          if (b.name === 'EnterWorktree' && typeof b.input.name === 'string') names.add(b.input.name);
          if (b.name === 'Bash' && typeof b.input.command === 'string') out.commands.push(b.input.command);
          if (WRITE_TOOLS.has(b.name)) {
            const f = b.input.file_path || b.input.notebook_path;
            if (typeof f === 'string') out.filesWritten.push(f);
          }
          for (const v of Object.values(b.input)) {
            if (typeof v !== 'string') continue;
            for (const m of v.matchAll(WORKTREE_MENTION_RE)) names.add(m[1]);
          }
        }
        out.worktreesTouched = [...names];
      } else if (obj.type === 'user' && !obj.toolUseResult && !obj.isMeta && obj.timestamp) {
        // Tool results also arrive as type:'user' lines — the toolUseResult field
        // separates them. A genuine human prompt carries string content or a
        // text block.
        const c = obj.message && obj.message.content;
        const isHuman = typeof c === 'string'
          || (Array.isArray(c) && c.some((b) => b && b.type === 'text'));
        if (isHuman) out.prompt = { timestamp: obj.timestamp, dedupeKey: 'p:' + (obj.uuid || obj.timestamp) };
      }
      return out;
    },
    // The first HUMAN prompt text in a transcript — the chat's LABEL. Same
    // human-turn predicate as parseLine (skip tool results / meta / injected
    // `<…>` reminders), but returns the words, capped ≤100 chars. Bounded
    // head-read only: transcripts run to many MB, and the first typed prompt is
    // always near the top. null when unreadable or no human turn is found.
    firstHumanLabel(file) {
      if (!file) return null;
      let head;
      try {
        const fd = openSync(file, 'r');
        const buf = Buffer.alloc(256 * 1024);
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        head = buf.subarray(0, n).toString('utf8');
      } catch { return null; }
      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type !== 'user' || obj.toolUseResult || obj.isMeta) continue;
        const c = obj.message && obj.message.content;
        let text = null;
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          const t = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
          if (t) text = t;
        }
        const trimmed = (text || '').trim();
        // Skip injected/reminder turns (serialized content starting with '<' —
        // command wrappers, tool results, system reminders); the owner's first
        // *typed* prompt is the label.
        if (!trimmed || trimmed.startsWith('<')) continue;
        return trimmed.length > 100 ? trimmed.slice(0, 99) + '…' : trimmed;
      }
      return null;
    },
    // A transcript file → the readable conversation: an ordered list of
    // { role: 'user'|'assistant', text, timestamp }. Human turns skip tool
    // results / meta / injected `<…>` lines (same predicate as parseLine);
    // assistant turns take the text blocks only (no thinking, no tool_use
    // noise). Bounded: at most opts.maxTurns turns, each capped to
    // opts.maxChars, with a `truncated` signal so the viewer can say so. This
    // is the ONLY place the Claude transcript shape is read for display —
    // core/portal stay format-agnostic (docs/DRIVERS.md).
    readTurns(file, opts = {}) {
      const maxTurns = opts.maxTurns || 600;
      const maxChars = opts.maxChars || 8000;
      const out = { turns: [], truncated: false };
      if (!file) return out;
      let raw;
      try { raw = readFileSync(file, 'utf8'); } catch { return out; }
      const cap = (s) => (s.length > maxChars ? s.slice(0, maxChars) + '\n…[turn truncated]' : s);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        if (out.turns.length >= maxTurns) { out.truncated = true; break; }
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'user' && !obj.toolUseResult && !obj.isMeta) {
          const c = obj.message && obj.message.content;
          let text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
          text = (text || '').trim();
          // Skip injected/reminder turns (serialized `<…>`), keep typed prompts.
          if (text && !text.startsWith('<')) out.turns.push({ role: 'user', text: cap(text), timestamp: obj.timestamp || null });
        } else if (obj.type === 'assistant') {
          const parts = obj.message && obj.message.content;
          if (Array.isArray(parts)) {
            const text = parts.filter((p) => p.type === 'text').map((p) => p.text || '').join('\n').trim();
            if (text) out.turns.push({ role: 'assistant', text: cap(text), timestamp: obj.timestamp || null });
          }
        }
      }
      return out;
    },
    // Everything the OWNER typed in one chat, oldest first (task 237) — the
    // words core/owner-words.mjs checks before an agent may run an owner-only
    // task command. Reads every file the chat has (one per folder it worked
    // in), main log only; a line kept in two files is counted once.
    ownerTurns(sessionId) {
      const out = [];
      const seen = new Set();
      for (const file of transcriptsBySession(sessionId)) {
        let raw;
        try { raw = readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n')) {
          if (!line.includes('"type":"user"')) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.sessionId && obj.sessionId !== sessionId) continue;
          const key = obj.uuid || line;
          if (seen.has(key)) continue;
          seen.add(key);
          const text = ownerTextOf(obj);
          if (text) out.push(text);
        }
      }
      return out;
    },
  },

  // versions = the offline seed; sync() = the live feed the engine polls and
  // stores ahead of it (core/pricing.mjs → syncPricing).
  pricing: { versions: PRICING_VERSIONS, aliases: ALIASES, sync: fetchPricing },

  sessions: {
    supported: true,
    // Where the chat metadata lives, as-is — for a job that copies the store
    // rather than reading it (task 151's chat archive).
    root() { return DESKTOP_SESSIONS_ROOT; },
    // Claude Desktop chat metadata, normalized. Reads are unrestricted; the ONE
    // sanctioned write is archive() below (task 106 trust model, owner-amended
    // 2026-07-19). A chat tile's cliSessionId can be REBOUND to a different
    // transcript over its lifetime (observed 2026-07-18) — callers must not
    // assume 1:1. A rewind is one such rebind: the app starts a new transcript
    // and keeps the old ids in priorCliSessionIds, which ride along as
    // priorSessionIds so a ledger row recorded under an old id still finds its
    // chat (task 208). Still ONE row per chat.
    list() {
      if (!existsSync(DESKTOP_SESSIONS_ROOT)) return [];
      const rows = [];
      for (const rel of readdirSync(DESKTOP_SESSIONS_ROOT, { recursive: true })) {
        if (!String(rel).endsWith('.json')) continue;
        const file = join(DESKTOP_SESSIONS_ROOT, String(rel));
        let d;
        try { d = JSON.parse(readFileSync(file, 'utf8')); }
        catch { continue; }
        if (!d || typeof d !== 'object' || !('cliSessionId' in d)) continue;
        rows.push({
          title: d.title || null,
          sessionId: d.cliSessionId || null,
          priorSessionIds: Array.isArray(d.priorCliSessionIds) ? d.priorCliSessionIds.filter(Boolean) : [],
          cwd: d.cwd || d.originCwd || null,
          isArchived: !!d.isArchived,
          lastActivityAt: typeof d.lastActivityAt === 'number' ? new Date(d.lastActivityAt).toISOString() : null,
          metaFile: file,
        });
      }
      rows.sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
      return rows;
    },
    listArchived() { return this.list().filter((r) => r.isArchived); },
    // Is each chat still in the app, archived by the owner, or deleted by the
    // owner (task 226)? → { [id]: 'open' | 'archived' | 'deleted' | 'unknown' }.
    // In the app's list → its archived flag (a rewound chat is found by an
    // earlier id too). Not in it: a Desktop chat the app no longer lists was
    // deleted there: deleting drops the chat's entry, and the transcript can
    // stay behind (2026-10-17: 89 Desktop transcripts on the owner's machine
    // had no entry, all real chats). A chat with no
    // entry AND no transcript is gone entirely. A terminal chat is never in
    // the app's list, so its transcript is all there is: open.
    status(ids) {
      const out = {};
      const appKnown = existsSync(DESKTOP_SESSIONS_ROOT);
      if (!appKnown && !existsSync(TRANSCRIPTS_ROOT)) {
        for (const id of ids) out[id] = 'unknown';
        return out;
      }
      const byId = new Map();
      for (const r of this.list()) {
        if (r.sessionId) byId.set(r.sessionId, r);
        for (const p of r.priorSessionIds) if (!byId.has(p)) byId.set(p, r);
      }
      for (const id of ids) {
        const row = byId.get(id);
        if (row) { out[id] = row.isArchived ? 'archived' : 'open'; continue; }
        const files = transcriptsBySession(id);
        out[id] = !files.length || (appKnown && files.some(startedInDesktop)) ? 'deleted' : 'open';
      }
      return out;
    },
    // Is the desktop app (the OWNER of the metadata store) running? While it
    // is, archive() writes get clobbered by the app's in-memory state — proven
    // live 2026-07-19 on "Pick up 77". Callers must refuse the archive path
    // when this is true and point at the app's own archive tool instead.
    appRunning() {
      // ps, not pgrep — pgrep misses the app in some execution contexts
      // (observed 2026-07-19) while ps -o comm reliably lists it.
      const r = spawnSync('ps', ['ax', '-o', 'comm'], { encoding: 'utf8' });
      return r.status === 0 && String(r.stdout).includes('Claude.app/Contents/MacOS/Claude');
    },
    // The single sanctioned metadata write: flip isArchived on one chat.
    // Reversible (a UI flag, no data); the desktop app stays the owner of the
    // file — a concurrent app write may win, which the caller accepts. Returns
    // the re-read flag value so callers can verify the write stuck.
    archive(sessionId) {
      const row = this.list().find((r) => r.sessionId === sessionId);
      if (!row) throw new Error(`no desktop chat metadata for session ${sessionId}`);
      const d = JSON.parse(readFileSync(row.metaFile, 'utf8'));
      d.isArchived = true;
      writeFileSync(row.metaFile, JSON.stringify(d));
      return !!JSON.parse(readFileSync(row.metaFile, 'utf8')).isArchived;
    },
  },

  // What each Claude Code hook event means for a chat (task 202). ONLY
  // documented behaviour (owner, 2026-10-13) — code.claude.com/docs/en/hooks:
  //  - every event carries session_id; one fired inside a subagent also
  //    carries agent_id ("Common input fields"). `cwd` is the chat's folder,
  //    so it cannot tell workers apart (also seen in a real run).
  //  - PermissionRequest: "a tool call needs a permission decision".
  //    Notification permission_prompt / elicitation_dialog /
  //    elicitation_url_dialog: Claude is waiting on you. Elicitation: an MCP
  //    server asks you for input. AskUserQuestion and ExitPlanMode "require
  //    user interaction", so their PreToolUse means waiting until their
  //    PostToolUse.
  //  - Stop: "Claude finishes responding"; its background_tasks let a hook
  //    tell "done" from "paused waiting for background work". Each entry is
  //    { id, type: shell|subagent|monitor|…, status, description }. Both mean
  //    the chat is idle; the second is 'background' (task 229).
  //  - SubagentStop carries the same background_tasks, scoped to the CHAT, and
  //    also fires when Claude Code's own internal agents finish (prompt
  //    suggestions, /btw) — so a helper finishing is not the chat's turn.
  //  - StopFailure: "the turn ends due to an API error", with `error`.
  //  - PostToolUse for the Agent tool returns the worker's agentId and the
  //    description it was given. Autopilot starts each worker's description
  //    with "task NNN", which is how a worker maps to its task.
  //  - SessionEnd: "a session terminates" — the chat's PROCESS ended, for any
  //    reason, and the Desktop app ends idle chats' processes by itself (seen
  //    2026-10-16: seven chats in one second). So it is 'ended' (nothing is
  //    running), never "closed": the chat is still in the app. Whether the
  //    owner archived or deleted it is sessions.status()'s answer (task 226).
  //    A killed process sends nothing, so its last state stays — nothing here
  //    guesses that it died.
  liveState: {
    supported: true,
    // No bundled logo: the Claude mark is Anthropic's trademark, so cogyard
    // ships only WHERE a public copy lives, and `cogyard claude install`
    // downloads it into $COGYARD_HOME/drivers/claude/ (core/driver-logo.mjs).
    // Simple Icons' published SVG, pinned to a release; the fill is Claude's
    // brand colour (the SVG ships uncoloured).
    logo: null,
    logoSource: { url: 'https://cdn.jsdelivr.net/npm/simple-icons@16.35.0/icons/claude.svg', fill: '#D97757' },
    parseHook(input) {
      if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !input.session_id) return null;
      const session = input.session_id;
      const agent = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
      const ev = (state, extra) => ({ session, agent, state, ...extra });
      const asksYou = (t) => t === 'AskUserQuestion' || t === 'ExitPlanMode';
      // background_tasks is absent when Claude Code cannot reach its task
      // registry, so an absent list says nothing; an empty one says "none".
      const bgKnown = (i) => Array.isArray(i.background_tasks);
      const bgRunning = (i) => bgKnown(i) && i.background_tasks.some((b) => b && b.status === 'running');
      switch (input.hook_event_name) {
        case 'SessionStart': return ev('stopped');
        case 'UserPromptSubmit': return ev('working');
        case 'PreToolUse': return ev(asksYou(input.tool_name) ? 'needs' : 'working');
        case 'PostToolUseFailure':
        case 'SubagentStart':
        case 'ElicitationResult': return ev('working');
        case 'Elicitation': return ev('needs');
        case 'StopFailure': return ev('error', { error: typeof input.error === 'string' ? input.error : 'unknown' });
        case 'PostToolUse': {
          const r = input.tool_response;
          const spawned = input.tool_name === 'Agent' && r && typeof r === 'object' && typeof r.agentId === 'string' ? r.agentId : null;
          const m = spawned ? String(input.tool_input?.description ?? r.description ?? '').match(/^\s*task\s+#?(\d+(?:\.\d+)?[a-z]?)\b/i) : null;
          return ev('working', m ? { spawn: { agent: spawned, task: m[1] } } : {});
        }
        case 'PermissionRequest': return ev('needs');
        case 'Notification': {
          const t = String(input.notification_type || '');
          return t === 'permission_prompt' || t === 'elicitation_dialog' || t === 'elicitation_url_dialog' ? ev('needs') : null;
        }
        // The turn is over either way: the chat waits on you. A job it left
        // running (a dev server never finishes) is not the chat working, so it
        // is its own idle state (task 229) — never 'working', which read
        // "running" for hours on a chat nobody was using.
        case 'Stop': return ev(bgRunning(input) ? 'background' : 'stopped');
        // A worker or helper finished. Its background_tasks are the CHAT's;
        // an empty list tells core the chat has nothing left in the background.
        case 'SubagentStop': return agent ? ev('stopped', bgKnown(input) && !bgRunning(input) ? { backgroundDone: true } : {}) : null;
        case 'SessionEnd': return ev('ended');
        default: return null;
      }
    },
  },

  agent: {
    supported: true,

    // THE CREDENTIAL, declared here and nowhere else (task 127).
    //
    // It belongs to the DRIVER because it is this adapter that spawns the agent,
    // and the agent authenticates from its process environment. Every scheduled
    // job that calls the agent seam needs this same one variable — so declaring
    // it per-add-on would both duplicate it and put a Claude-Code literal inside
    // community add-ons, which is exactly what the driver seam exists to prevent.
    //
    // cogyard never mints, refreshes, or reads the value: `howTo` is printed for
    // the owner to run themselves, and the value lives in the credential store
    // (core/secrets.mjs) where the spawned child inherits it from the
    // environment. Verified on this machine 2026-08-18: `claude auth status`
    // reports loggedIn:false, and the headless invocation below returns
    // "Not logged in" inside a well-formed envelope — the CLI holds no
    // credential of its own, so this variable is the whole authentication story.
    credential: {
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      label: 'Claude Code OAuth token',
      howTo: 'claude setup-token',
    },

    // Headless Claude Code with NO tools: the caller supplies every input in
    // `prompt`, the agent returns text. `--tools ""` is the CLI's own switch for
    // "disable all tools" (verified against `claude --help`, 2026-08-12) — with
    // no tools there is no filesystem access, so there is no permission surface
    // to get wrong and nothing needs `bypassPermissions`. That is the whole
    // reason a scheduled job may call this unattended.
    //
    // The prompt goes over STDIN, not argv: a brief's inlined task bodies run to
    // tens of KB and argv has a hard length limit.
    //
    // `--safe-mode` is what makes an unattended run answer the QUESTION IT WAS
    // ASKED. Without it the CLI auto-discovers the user's CLAUDE.md files and
    // obeys them, and those files are written for an interactive session with
    // tools: they say things like "read the file before asserting anything about
    // it". A tool-less job cannot comply, so the agent spends the money and
    // replies with a tool call it cannot make instead of the answer. The caller
    // then gets prose it cannot parse — and a parser that discards anything
    // unparseable turns that into a job which reports "nothing found" every
    // night, expensively and wrongly.
    //
    // Reproduced and measured on this machine 2026-08-19, spawning with the
    // LaunchAgent's own environment (HOME + PATH + the credential) and its own
    // cwd (`/`), asking whether the context mentioned this project:
    //   without --safe-mode → "**Tool: read** {"file_path": "~/.claude/CLAUDE.md"}"
    //                         24,211 input tokens, $0.0975, question unanswered
    //   with    --safe-mode → "NO:"  4,429 input tokens, $0.0032, answered
    // The hijacking file is HOME-keyed, so a neutral `cwd` cannot prevent this;
    // cwd governs only the PROJECT CLAUDE.md, which the LaunchAgent (cwd `/`)
    // never loaded in the first place.
    //
    // It is the right switch rather than a blunt one: it disables customizations
    // — CLAUDE.md, skills, plugins, hooks, MCP servers, output styles — while
    // "auth, model selection, built-in tools, and permissions work normally"
    // (`claude --help`). None of those customizations can mean anything to a
    // tool-less prompt that carries all of its own inputs.
    //
    // NOT used: `--bare`. Re-tested 2026-08-19 WITH `CLAUDE_CODE_OAUTH_TOKEN`
    // set, because the note that ruled it out predated the credential store:
    // it still exits 1 with "Not logged in · Please run /login". The CLI's own
    // help says why — under `--bare` "Anthropic auth is strictly
    // ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never read)".
    // So it is incompatible with the credential this seam declares, not merely
    // untried.
    //
    // The explicit neutral `cwd` is for determinism, NOT for the above: a child
    // that inherits the parent's directory behaves differently under `npm run
    // api` (a repo checkout) than under the LaunchAgent (`/`). Pinning it makes
    // dev and prod the same run. A caller may name the folder instead (`cwd`):
    // the scheduled-job runner passes each job its own empty folder, because
    // the transcript records where the call ran and that is how the usage
    // ledger files the call under the job (task 130). Unset → `tmpdir()`.
    // SUPERVISED BY SILENCE, NOT BY DURATION (task 138). `--output-format json`
    // emits ONE blob when the whole answer is finished, so until that moment the
    // child produces nothing and the only thing left to judge it by is the
    // clock — which cannot tell thinking from hanging. `stream-json` with
    // `--include-partial-messages` emits line-delimited events as the model
    // works, so the question becomes "has this produced nothing for N seconds?"
    // and a slow-but-working call is never killed however big the project is.
    // (`--verbose` is required alongside stream-json under `-p`.)
    //
    // Verified against the installed binary 2026-09-04, tool-less and in
    // safe-mode, for a one-word answer: events at 0.52s, 1.39s, 2.22s, 2.69s,
    // 3.59s, then `type:'result'` at 3.60s carrying the same `result` /
    // `total_cost_usd` / `modelUsage` / `is_error` fields the old json mode
    // returned whole. Inter-event gaps under a second, against a 90s default
    // silence window — a working call has ~100x headroom.
    //
    // `silenceMs` is the real bound; `ceilingMs` is a pure backstop against a
    // stream that dribbles forever. Both are the CALLER's to set — a driver
    // that cannot stream should leave silence unimplemented and rely on the
    // ceiling rather than inventing a number.
    async run({ prompt, signal, model, silenceMs, ceilingMs, cwd } = {}) {
      const t0 = Date.now();
      const timing = () => ({ elapsedMs: Date.now() - t0, ttfbMs });
      let ttfbMs = null;

      if (typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, text: '', cost: null, model: null, error: 'empty prompt', failure: 'error', ...timing() };
      }
      // Already cancelled before any work started — say so, and say it before
      // looking for the binary. A caller that has withdrawn its request is owed
      // "cancelled", not a diagnosis of this machine's install; the CI runner has
      // no claude on PATH, and reporting THAT for an aborted call made the
      // adapter's answer depend on the host rather than on what was asked.
      if (signal?.aborted) {
        return { ok: false, text: '', cost: null, model: null, error: 'cancelled by the caller', failure: 'cancelled', ...timing() };
      }

      const args = ['-p', '--tools', '', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--safe-mode'];
      if (model) args.push('--model', model);

      const bin = agentBin();
      if (!bin) {
        return {
          ok: false, text: '', cost: null, model: null, failure: 'error', ...timing(),
          error: 'the claude CLI was not found on PATH or in any known install location'
               + ' — set CLAUDE_CODE_BIN to its full path (a LaunchAgent does not'
               + ' inherit a login shell\'s PATH)',
        };
      }

      let child;
      try {
        // NOT spawn's own `signal` option: it fires SIGTERM once and reports
        // AbortError immediately, so a child that ignores SIGTERM survives while
        // the caller is told the call ended. Measured 2026-09-04 — the promise
        // settled in 10ms and the child was still alive a second later, still
        // holding this process's stdio pipes. In the always-on portal that is a
        // process leak, so the kill is escalated by hand below instead.
        child = spawn(bin, args, { cwd: cwd || tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return { ok: false, text: '', cost: null, model: null, error: `spawn failed: ${e.message}`, failure: 'error', ...timing() };
      }

      // Only two things are kept out of a stream that can run to thousands of
      // events: the final `result` envelope, and a tail of raw output for the
      // error message when there isn't one.
      let payload = null;
      let pending = '';
      let tail = '';
      let events = 0;
      const err = [];

      const consume = (line) => {
        if (!line.trim()) return;
        events += 1;
        let o;
        try { o = JSON.parse(line); } catch { return; }
        if (o && o.type === 'result') payload = o;
      };

      // --- supervision -------------------------------------------------------
      // `verdict` is set by whichever bound fires first and then never changes;
      // the code after the await reads it to tell "we killed this" from "it
      // ended on its own".
      let verdict = null;
      let bound = null;          // which bound fired: 'silence' | 'ceiling' | 'caller'
      let silenceTimer = null;

      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        // Escalate. A SIGTERM the child declines to honour is exactly the case
        // that produced the leak, so give it a moment to exit cleanly and then
        // take the choice away. The wait is short on purpose: a CLI still
        // running two seconds after being asked to stop is not going to stop,
        // and this delay is paid by every stalled call in the run.
        const hard = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
        }, KILL_GRACE_MS);
        hard.unref();
      };

      const give = (v, b) => { if (!verdict) { verdict = v; bound = b; kill(); } };
      // Nothing ever arrived vs it began and then stopped — the two are
      // different diagnoses (a dead credential or an unreachable server, versus
      // a model that wedged mid-answer) and the owner needs to be sent to
      // different places for them.
      const quietKind = () => (ttfbMs === null ? 'no-response' : 'stalled');

      // The silence window, restarted by every byte from the child. This is the
      // whole mechanism: work that is progressing is never killed.
      const heard = () => {
        if (!silenceMs || verdict) return;
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => give(quietKind(), 'silence'), silenceMs);
      };
      heard();

      // The backstop. Not the mechanism — a number this generous only ever fires
      // for a stream that dribbles forever without finishing.
      const ceilingTimer = ceilingMs ? setTimeout(() => give(quietKind(), 'ceiling'), ceilingMs) : null;

      const onParentAbort = () => give('cancelled', 'caller');
      if (signal) signal.addEventListener('abort', onParentAbort, { once: true });

      child.stdout.on('data', (d) => {
        if (ttfbMs === null) ttfbMs = Date.now() - t0;
        heard();
        const s = d.toString('utf8');
        tail = (tail + s).slice(-4096);
        pending += s;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) consume(line);
      });
      child.stderr.on('data', (d) => { heard(); if (err.length < 32) err.push(d); });
      // EPIPE if the child died before reading — the exit handler reports the
      // real reason, so swallow the write error rather than masking it.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);

      const done = await new Promise((resolve) => {
        child.on('error', (e) => resolve({ failed: e }));
        // 'close' rather than 'exit': it fires once the stdio streams are also
        // done, which is what proves nothing is still holding this process's
        // pipes open.
        child.on('close', (code, sig) => resolve({ code, sig }));
      });

      clearTimeout(silenceTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
      consume(pending);

      if (verdict) {
        // Never round a sub-second window down to "0s" — a bound that reads as
        // zero makes a correct kill look like a bug.
        const secs = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);
        const window = secs(bound === 'ceiling' ? ceilingMs : silenceMs);
        const why = {
          'no-response': `the agent produced no output at all in ${window}`
            + (bound === 'ceiling' ? ' (absolute ceiling)' : ' (silence window)'),
          stalled: `the agent produced ${events} event(s), the last ${secs(Date.now() - t0 - (bound === 'ceiling' ? 0 : silenceMs))} in`
            + `, then went silent for ${window}`
            + (bound === 'ceiling' ? ' — absolute ceiling reached while still producing' : ''),
          cancelled: 'cancelled by the caller',
        }[verdict];
        return { ok: false, text: '', cost: null, model: null, error: why, failure: verdict, ...timing() };
      }

      if (done.failed) {
        return {
          ok: false, text: '', cost: null, model: null, failure: 'error', ...timing(),
          error: `agent failed: ${done.failed.message}`,
        };
      }

      if (!payload || typeof payload !== 'object') {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        // Nothing at all came back: the call never connected. Auth, network, a
        // server that is down — indistinguishable from here, and all of them
        // "we never got an answer" rather than "the answer was wrong".
        const kind = events === 0 ? 'no-response' : 'error';
        return {
          ok: false, text: '', cost: null, model: null, failure: kind, ...timing(),
          error: events === 0
            ? `the agent exited ${done.code} without producing any output: ${(stderr || tail).trim().slice(0, 200) || '(nothing on stderr either)'}`
            : `no result event in ${events} streamed event(s) (exit ${done.code}): ${(stderr || tail).trim().slice(0, 200)}`,
        };
      }

      // The CLI reports its own failures INSIDE a well-formed result envelope
      // (`is_error: true`, the reason in `result`) — e.g. "Not logged in ·
      // Please run /login" with exit 1. Read the envelope, not just the code.
      const cost = typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : null;
      const usedModel = answeringModel(payload.modelUsage) || model || null;
      if (payload.is_error || done.code !== 0) {
        return {
          ok: false, text: '', cost, model: usedModel, failure: 'error', ...timing(),
          error: String(payload.result || `agent exited ${done.code}`),
        };
      }
      return { ok: true, text: String(payload.result ?? ''), cost, model: usedModel, error: null, failure: null, ...timing() };
    },
  },

  // Where a project's process can live for Claude Code, and which of cogyard's
  // skills reach it (task 133). Core's process-doc check (core/process-docs.mjs)
  // asks these; it never names a Claude Code file itself.
  skills: {
    supported: true,

    // The instruction file Claude Code always loads at a repo's root — where a
    // project's facts go when cogyard's skill stays in charge.
    alwaysLoaded: 'CLAUDE.md',

    // The agent instruction files in a repo, relative to it: CLAUDE.md and its
    // CLAUDE.<topic>.md siblings at the root (a CLAUDE.md points at those), and
    // .claude/CLAUDE.md. CLAUDE.md first.
    instructionFiles(repoRoot) {
      let names = [];
      try { names = readdirSync(repoRoot).filter((f) => /^CLAUDE(\.[^/]+)?\.md$/i.test(f)); } catch {}
      names.sort((a, b) => (a === 'CLAUDE.md' ? -1 : b === 'CLAUDE.md' ? 1 : a.localeCompare(b)));
      if (existsSync(join(repoRoot, '.claude', 'CLAUDE.md'))) names.push('.claude/CLAUDE.md');
      return names;
    },

    // The project's own skills: .claude/skills/<name>/SKILL.md → [{ name, file }],
    // file relative to the repo.
    projectSkills(repoRoot) {
      const dir = join(repoRoot, PROJECT_SKILLS_DIR);
      let ents = [];
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      return ents
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(dir, d.name, 'SKILL.md')))
        .map((d) => ({ name: d.name, file: `${PROJECT_SKILLS_DIR}/${d.name}/SKILL.md` }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    // The project's own commands: .claude/commands/<name>.md → [{ name, file }],
    // file relative to the repo (task 218). Claude Code treats a command file
    // as a skill of that name, so it clashes with cogyard's skills AND commands.
    projectCommands(repoRoot) {
      return commandNames(join(repoRoot, PROJECT_COMMANDS_DIR))
        .map((name) => ({ name, file: `${PROJECT_COMMANDS_DIR}/${name}.md` }));
    },

    // Where a new project skill called <name> is written, relative to the repo.
    projectSkillFile(name) { return `${PROJECT_SKILLS_DIR}/${name}/SKILL.md`; },

    // A skill file's whole text: Claude Code's frontmatter, then the body.
    renderSkill({ name, description, body }) {
      return `---\nname: ${name}\ndescription: ${JSON.stringify(String(description))}\n---\n\n${String(body).trim()}\n`;
    },

    // The command that installs cogyard's skills and commands as personal ones.
    installCommand: 'cogyard claude install',

    // The name cogyard's skill or command <name> gets as a PERSONAL one
    // (task 218): `cogyard-<name>`, so it can never take a name someone's own
    // skill, a project's, or Claude Code's uses. A name that already is
    // `cogyard` or starts with `cogyard-` keeps it. Under the plugin the name
    // stays <name> — the plugin namespaces it as `cogyard:<name>`.
    personalName,

    // How the owner runs a skill by hand. cogyard's own are `cogyard-<name>`
    // installed personally, `cogyard:<name>` under the plugin.
    invocation(name, { cogyard = false, plugin = false } = {}) {
      if (cogyard && plugin) return `/${PLUGIN_NAME}:${name}`;
      return `/${cogyard ? personalName(name) : name}`;
    },

    // How cogyard's skills reach Claude Code on this machine, for this repo:
    //   personal — `cogyard claude install` put them in ~/.claude, as
    //              `cogyard-<name>`; a project skill named <name> loads beside
    //              them;
    //   plugin   — the cogyard plugin is on, so they are `cogyard:<name>` and a
    //              same-named project skill loads beside them.
    // Both can be true; neither means cogyard's skills are not installed.
    // personalSkills / personalCommands: which of cogyard's are installed
    // personally, under either name. bareSkills / bareCommands: those an older
    // install linked under the bare <name> — those still beat a project's own
    // skill or command of that name, until `cogyard claude install` moves them.
    install(repoRoot) {
      const skills = shippedSkillNames();
      const commands = commandNames(SHIPPED_COMMANDS_DIR);
      const bareSkills = skills.filter((n) => personalName(n) !== n && isCogyardEntry(join(CLAUDE_DIR, 'skills', n), 'skills', n));
      const bareCommands = commands.filter((n) => personalName(n) !== n && isCogyardEntry(join(CLAUDE_DIR, 'commands', `${n}.md`), 'commands', `${n}.md`));
      const personalSkills = skills.filter((n) => bareSkills.includes(n) || existsSync(join(CLAUDE_DIR, 'skills', personalName(n), 'SKILL.md')));
      const personalCommands = commands.filter((n) => bareCommands.includes(n) || existsSync(join(CLAUDE_DIR, 'commands', `${personalName(n)}.md`)));
      return { personal: personalSkills.length > 0, personalSkills, personalCommands, bareSkills, bareCommands, plugin: pluginOn(repoRoot) };
    },

    // cogyard's skills this driver ships → [{ name, changed }], `changed` the
    // day each last changed (YYYY-MM-DD) or null.
    shipped() {
      return shippedSkillNames().map((name) => ({ name, changed: skillChanged(name) }));
    },

    // cogyard's commands this driver ships → [{ name }] (task 218).
    shippedCommands() {
      return commandNames(SHIPPED_COMMANDS_DIR).map((name) => ({ name }));
    },

    // Names Claude Code keeps for itself → [{ name, why }] (task 218). A
    // personal skill or command under one replaces the built-in (its aliases
    // still reach it). The list is copied from Claude Code's docs — Claude Code
    // exposes none to read — and `why` says when it was last checked.
    reservedNames() {
      const f = readJson(BUILTIN_NAMES_FILE);
      if (!f) return [];
      const when = f.checked ? ` (Claude Code's docs, checked ${f.checked})` : '';
      return [
        ...(f.commands || []).map((name) => ({ name, why: `Claude Code's built-in /${name}${when}` })),
        ...(f.aliases || []).map((name) => ({ name, why: `an alias of a Claude Code built-in command${when}` })),
        ...(f.reserved || []).map((name) => ({ name, why: `a name Claude Code reserves${when}` })),
      ];
    },

    // Is skill <name> turned off for this repo? → the settings file that does
    // it (relative), or null. Only "off" counts: "user-invocable-only" still
    // loads the skill. `cogyard: true` asks about cogyard's skill <name>, which
    // answers to `cogyard-<name>` (and to <name> while an older install's
    // bare-name link is in place).
    isOff(repoRoot, name, { cogyard = false } = {}) {
      const keys = cogyard ? [personalName(name), name] : [name];
      for (const rel of PROJECT_SETTINGS_FILES) {
        const s = readJson(join(repoRoot, rel));
        if (s && s.skillOverrides && keys.some((k) => s.skillOverrides[k] === 'off')) return rel;
      }
      return null;
    },

    // Turn skill <name> off for this repo, in the settings file shared with
    // everyone on it. Only the one key is added; every other setting stays as
    // it was. → the file written (relative), or null when it was already off
    // there. Refuses a settings file that is not valid JSON rather than
    // replacing it. `cogyard: true` turns off cogyard's skill <name>, whose key
    // is `cogyard-<name>` — a project skill named <name> stays on.
    turnOff(repoRoot, name, { cogyard = false } = {}) {
      if (cogyard) name = personalName(name);
      const file = join(repoRoot, PROJECT_SETTINGS);
      let s = {};
      if (existsSync(file)) {
        s = readJson(file);
        if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${PROJECT_SETTINGS} is not a JSON object — fix it by hand, then re-run`);
      }
      if (s.skillOverrides && s.skillOverrides[name] === 'off') return null;
      s.skillOverrides = { ...(s.skillOverrides || {}), [name]: 'off' };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
      return PROJECT_SETTINGS;
    },
  },
};
