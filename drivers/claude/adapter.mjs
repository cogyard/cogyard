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
//   pricing     — Claude model price table + opus/sonnet/haiku aliases

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const HOME = homedir();
const TRANSCRIPTS_ROOT = join(HOME, '.claude', 'projects');
// Claude Desktop's chat metadata (macOS): one whole-file JSON per chat, nested
// two dirs deep. NOT jsonl — a line-by-line parser silently yields zero rows.
const DESKTOP_SESSIONS_ROOT = join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
// <repo>/.claude/worktrees/<name> — capture the repo root and the worktree name.
const WORKTREE_RE = /^(.*)\/\.claude\/worktrees\/([^/]+)/;

// --- pricing (lifted from the old core/pricing.mjs) --------------------------
// Rates are $ per MILLION tokens. Newest first; `models` keys are the exact
// `message.model` strings seen in Claude Code transcripts. The cache-tier math
// and version-locking live in core/pricing.mjs — this is just the data.
const PRICING_VERSIONS = [
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

export default {
  name: 'claude',

  // Active when running under Claude Code, or when the Claude config dir exists.
  detect() {
    return !!process.env.CLAUDECODE
      || !!process.env.CLAUDE_PROJECT_DIR
      || existsSync(join(HOME, '.claude'));
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
    // Transcript dirs are flattened cwds; a session's transcript is <dir>/<id>.jsonl.
    findBySession(sessionId) {
      if (!sessionId || !existsSync(TRANSCRIPTS_ROOT)) return [];
      const files = [];
      for (const dir of readdirSync(TRANSCRIPTS_ROOT)) {
        const candidate = join(TRANSCRIPTS_ROOT, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) files.push(candidate);
      }
      return files;
    },
    // One raw JSONL line → {sessionId, cwd, usage, prompt}. usage is the billable
    // assistant turn ({model, timestamp, dedupeKey, tokens}) or null. prompt is a
    // HUMAN prompt event ({timestamp, dedupeKey}) or null — the attention signal
    // — the human's own messages, not the agent's turns.
    parseLine(line) {
      let obj;
      try { obj = JSON.parse(line); } catch { return null; }
      const out = { sessionId: obj.sessionId || null, cwd: obj.cwd || null, usage: null, prompt: null };
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
  },

  pricing: { versions: PRICING_VERSIONS, aliases: ALIASES },

  sessions: {
    supported: true,
    // Claude Desktop chat metadata, normalized. Reads are unrestricted; the ONE
    // sanctioned write is archive() below (task 106 trust model, owner-amended
    // 2026-07-19). A chat tile's cliSessionId can be REBOUND to a different
    // transcript over its lifetime (observed 2026-07-18) — callers must not
    // assume 1:1.
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
};
