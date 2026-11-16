// core/chat-read.mjs — print one chat, and search chat text (task 215).
//
// What `cogyard sessions show` / `search` stand on. Until this, cogyard could
// FIND a task's chats but pointed people at a personal script to READ one.
//
// Agent-agnostic: which files exist, which of a chat's copies to read, and how
// a transcript becomes readable turns all come through adapter.transcripts
// (sessionFiles / pickFullest / readTurns / parseLine — docs/DRIVERS.md). This
// module never parses the agent's format itself.
//
// Read-only: nothing here writes, to the agent's folders or the archive.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapter } from './drivers.mjs';
import { COGYARD_HOME } from './paths.mjs';
import { resolveProjectForPath } from './usage.mjs';

// The chat-archive add-on's copy of the agent's transcript folder (task 151),
// same layout as the live one — so a chat the agent has deleted can still be
// read. Mirrors the add-on's own `chat-archive/` + `conversations/` names.
const ARCHIVE_TRANSCRIPTS = join(COGYARD_HOME, 'chat-archive', 'conversations');

const WHOLE = { maxTurns: Infinity, maxChars: Infinity };

// Which folder to read: the agent's live one, or the archive copy.
// → { root, label } | { error }
function transcriptSource({ archive = false } = {}) {
  if (!adapter.transcripts.supported) return { error: `no agent driver with transcripts is active (driver: ${adapter.name})` };
  if (archive) {
    if (!existsSync(ARCHIVE_TRANSCRIPTS)) return { error: `no archive at ${ARCHIVE_TRANSCRIPTS} — the chat-archive add-on has not run on this machine (extras/addons/chat-archive/README.md)` };
    return { root: ARCHIVE_TRANSCRIPTS, label: 'archive' };
  }
  return { root: adapter.transcripts.root(), label: 'live' };
}

// sessionId → [files]. One chat can have a file under each folder it worked in.
function chatsIn(root) {
  const chats = new Map();
  for (const { sessionId, file } of adapter.transcripts.sessionFiles(root)) {
    if (!chats.has(sessionId)) chats.set(sessionId, []);
    chats.get(sessionId).push(file);
  }
  return chats;
}

// sessionId → the agent app's title for the chat (the sidebar name), when the
// driver keeps chat records. A rewound chat's old ids name it too (task 208).
function titleMap() {
  const titles = new Map();
  const sess = adapter.sessions && adapter.sessions.supported ? adapter.sessions : null;
  if (!sess) return titles;
  for (const s of sess.list()) {
    if (!s.title) continue;
    if (s.sessionId && !titles.has(s.sessionId)) titles.set(s.sessionId, s.title);
    for (const prior of s.priorSessionIds || []) if (!titles.has(prior)) titles.set(prior, s.title);
  }
  return titles;
}

const mtimeOf = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };

// The folder a chat worked in, from the first transcript line that records one.
function cwdOf(raw) {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const rec = adapter.transcripts.parseLine(line);
    if (rec && rec.cwd) return rec.cwd;
  }
  return null;
}

const oneLine = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// An id or the start of one → the chat. Two files of the SAME chat are not
// ambiguous (the fuller one is read); a prefix shared by DIFFERENT chats is.
// → { ok:true, sessionId, files, file, source }
//   | { ok:false, error, ambiguous?: [{ sessionId, files }] }
function findChatById(idOrPrefix, opts = {}) {
  const src = transcriptSource(opts);
  if (src.error) return { ok: false, error: src.error };
  const want = String(idOrPrefix || '').trim().toLowerCase();
  if (!want) return { ok: false, error: 'give a chat id, or the start of one' };
  const chats = chatsIn(src.root);
  const ids = chats.has(want) ? [want] : [...chats.keys()].filter((sid) => sid.toLowerCase().startsWith(want));
  if (!ids.length) {
    const hint = opts.archive ? '' : ' (a chat the agent has deleted may still be in the archive: add --archive)';
    return { ok: false, error: `no chat id starts with "${idOrPrefix}" in the ${src.label} transcripts${hint}` };
  }
  if (ids.length > 1) {
    return { ok: false, error: `"${idOrPrefix}" starts ${ids.length} different chats — give more of the id`, ambiguous: ids.map((sid) => ({ sessionId: sid, files: chats.get(sid) })) };
  }
  const files = chats.get(ids[0]);
  return { ok: true, sessionId: ids[0], files, file: adapter.transcripts.pickFullest(files), source: src.label };
}

// One chat, whole, as readable turns. → findChatById's result + { title, turns }
function readChat(idOrPrefix, opts = {}) {
  const r = findChatById(idOrPrefix, opts);
  if (!r.ok) return r;
  const { turns } = adapter.transcripts.readTurns(r.file, WHOLE);
  return { ...r, title: titleMap().get(r.sessionId) || null, turns };
}

// Case-insensitive search over chat TEXT — the human's prompts, the agent's
// replies, and the chat's title; not tool output. Newest chat first, one row
// per chat, stopping at `limit` matches.
// opts: { days, project (slug), limit (default 25), archive }
// → { ok, query, source, rows:[{ sessionId, lastActiveAt, cwd, project, title,
//      firstPrompt, snippet, hits, file }] } | { ok:false, error }
function searchChats(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'give some text to search for' };
  // A case-insensitive regex, not toLowerCase(): lowercasing every transcript
  // (GBs) took 16 s on a real machine, the regex 1.5 s.
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const src = transcriptSource(opts);
  if (src.error) return { ok: false, error: src.error };
  const limit = opts.limit > 0 ? opts.limit : 25;
  const cutoff = opts.days > 0 ? Date.now() - opts.days * 86400000 : 0;
  // Text the transcript stores escaped (quotes, backslashes, control chars)
  // can't be found in the raw file, so only a query free of them may use the
  // raw file as a quick "could this chat match at all" filter.
  const rawFilter = !/["\\\u0000-\u001f]/.test(q);
  const titles = titleMap();

  const candidates = [];
  for (const [sessionId, files] of chatsIn(src.root)) {
    const mtime = Math.max(...files.map(mtimeOf));
    if (mtime >= cutoff) candidates.push({ sessionId, files, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  const rows = [];
  for (const c of candidates) {
    if (rows.length >= limit) break;
    const title = titles.get(c.sessionId) || null;
    const titleHit = !!title && re.test(title);
    const raws = new Map();
    for (const f of c.files) { try { raws.set(f, readFileSync(f, 'utf8')); } catch {} }
    if (rawFilter && !titleHit && ![...raws.values()].some((raw) => re.test(raw))) continue;
    const file = adapter.transcripts.pickFullest(c.files);
    const raw = raws.get(file) || '';
    const cwd = cwdOf(raw);
    const project = cwd ? resolveProjectForPath(cwd) : null;
    if (opts.project && project !== opts.project) continue;
    const { turns } = adapter.transcripts.readTurns(file, WHOLE);
    const matching = turns.filter((t) => re.test(t.text));
    if (!matching.length && !titleHit) continue;
    let snippet = `[title] ${title}`;
    if (matching.length) {
      const text = matching[0].text;
      const m = text.match(re);
      const from = Math.max(0, m.index - 60);
      snippet = (from ? '…' : '') + oneLine(text.slice(from, m.index + m[0].length + 60), 160);
    }
    const first = turns.find((t) => t.role === 'user');
    rows.push({
      sessionId: c.sessionId,
      lastActiveAt: new Date(c.mtime).toISOString(),
      cwd,
      project,
      title,
      firstPrompt: first ? oneLine(first.text, 110) : null,
      snippet,
      hits: matching.length + (titleHit ? 1 : 0),
      file,
    });
  }
  return { ok: true, query: String(query).trim(), source: src.label, rows };
}

export { ARCHIVE_TRANSCRIPTS, findChatById, readChat, searchChats };
