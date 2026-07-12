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
import { existsSync, readdirSync } from 'node:fs';

const HOME = homedir();
const TRANSCRIPTS_ROOT = join(HOME, '.claude', 'projects');
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
  },

  pricing: { versions: PRICING_VERSIONS, aliases: ALIASES },
};
