// store.mjs — the brief FILE: where it lives, how it is written, how it reads back.
//
// A brief is a plain markdown file at $COGYARD_HOME/briefs/<slug>/YYYY-MM-DD.md
// with a small frontmatter block. Deliberately a file and not a database row:
//   * readable without the portal, in any editor;
//   * regenerable and disposable — if the agent writes something wrong, delete it.
//
// Until task 187 the brief lived INSIDE the project's task store, so the store's
// own git would version it (task 120). Nothing ever committed it — this job may
// not commit — so it sat pending until an unrelated `sync push` swept it into
// someone else's commit. It is machine-level output, so it lives in cogyard's
// machine-level home, beside jobs.json. The cost, accepted by the owner: no
// history of briefs and no cross-machine sync.
//
// The brief is NEVER a source of truth. The task files are. Nothing here may be
// read back as authoritative state; it is prose about state.
//
// The layout is core's (core/job-output.mjs, the reader's side). This add-on
// installs outside the repo and cannot import core synchronously, so the lines
// that place a file are spelled again here; docs/ADDONS.md is the contract and
// test/briefs.test.mjs asserts both spellings land on the same path.

import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { HOME } from './cogyard.mjs';

const BRIEFS_DIR = 'briefs';

// A slug becomes a path segment; anything that could climb out of HOME is
// refused (null) rather than written somewhere else. Same guard as core's.
function safeSlug(slug) {
  const s = String(slug ?? '');
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..' ? s : null;
}

// Local wall-clock date, not UTC: a brief written at 05:00 belongs to that
// morning's date wherever the machine is.
function dayStamp(d = new Date()) {
  const t = new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

// $COGYARD_HOME/briefs/<slug> — or null for a slug that is not a safe path
// segment. Whether the PROJECT can be briefed (it has a task store to read) is a
// separate question, asked by the caller (addon.mjs hasStore).
function briefsDir(slug, { create = false } = {}) {
  const s = safeSlug(slug);
  if (!s) return null;
  const dir = join(HOME, BRIEFS_DIR, s);
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

// --- the brief's own frontmatter ---------------------------------------------
// Deliberately its own tiny parser rather than core's: task frontmatter is a
// contract with a schema and a validator, and a brief must never be mistaken for
// one. Flat scalars only.

function parseBrief(raw, file) {
  const out = { file, meta: {}, body: String(raw ?? '') };
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(out.body);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (v === 'null' || v === '') v = null;
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    out.meta[kv[1]] = v;
  }
  out.body = out.body.slice(m[0].length);
  return out;
}

function serializeBrief({ meta, body }) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'number' ? v : String(v).includes('\n') ? JSON.stringify(v) : v}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

// --- reading ------------------------------------------------------------------
//
// `former` is the project's former slugs (ctx.projects[i].formerSlugs, task
// 195): a project whose checkout moved was re-registered under a new slug, and
// the briefs written before that sit under the old one. Reading them too is what
// keeps a move from looking like the project's first night — which would pay for
// an agent call. Writing is only ever under the current slug.

// Every brief file, newest first. Filenames are YYYY-MM-DD so a string sort is a
// date sort; anything else in the directory is ignored rather than guessed at.
// One file per date: the current slug's copy wins over a former slug's.
function listBriefs(slug, former = []) {
  const byDate = new Map();
  for (const s of [slug, ...former]) {
    const dir = briefsDir(s);
    if (!dir || !existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f) && !byDate.has(f)) byDate.set(f, join(dir, f));
    }
  }
  return [...byDate.keys()].sort().reverse().map((f) => byDate.get(f));
}

function readBrief(file) {
  try { return parseBrief(readFileSync(file, 'utf8'), file); } catch { return null; }
}

function newestBrief(slug, former = []) {
  const [file] = listBriefs(slug, former);
  return file ? readBrief(file) : null;
}

function briefForDate(slug, date) {
  const dir = briefsDir(slug);
  if (!dir) return null;
  const file = join(dir, `${date}.md`);
  return existsSync(file) ? readBrief(file) : null;
}

// Just the paragraphs: the H1, the collapsed evidence block and the cost footer
// stripped off. Used when a failed run carries the last brief that COULD be
// written forward underneath its alarm — quoting the whole file there would nest
// a heading and a <details> inside a blockquote.
function proseOf(brief) {
  if (!brief) return '';
  return String(brief.body || '').trim()
    .replace(/^#[^\n]*\n+/, '')
    .replace(/\n<details>[\s\S]*?<\/details>\n?/g, '\n')
    .replace(/\n---\n+\*[^\n]*\*\s*$/, '')
    .trim();
}

// The newest brief that actually says something — skipping any run of failures.
// Null when every brief on record failed, or there are none.
function lastGoodBrief(slug, former = []) {
  for (const file of listBriefs(slug, former)) {
    const b = readBrief(file);
    if (b && b.meta.status !== 'failed') return b;
  }
  return null;
}

// How many nights in a row have failed, counting back from the newest brief.
// Drives escalation: the third identical failure must not read like the first.
function consecutiveFailures(slug, former = []) {
  let n = 0;
  for (const file of listBriefs(slug, former)) {
    const b = readBrief(file);
    if (!b || b.meta.status !== 'failed') break;
    n += 1;
  }
  return n;
}

// --- writing ------------------------------------------------------------------

// Atomic tmp+rename, like every other cogyard state write: the portal may be
// reading this file to render a panel while the nightly job replaces it.
function writeBrief(slug, date, { meta, body }) {
  const dir = briefsDir(slug, { create: true });
  if (!dir) throw new Error(`not a usable project slug: ${JSON.stringify(slug)}`);
  const file = join(dir, `${date}.md`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeBrief({ meta, body }));
  renameSync(tmp, file);
  return file;
}

// Nothing happened, so the previous brief is still the current answer: stamp it
// rather than writing a near-identical file. This is what "carry forward" means
// here — one brief per thing that actually happened, with a date range on it,
// instead of fourteen copies of the same paragraph for a quiet fortnight.
//
// A previous brief under a former slug is never rewritten: the stamped copy goes
// under the current slug with the same date, and the reader takes that copy.
function carryForward(slug, throughDate, former = []) {
  const prev = newestBrief(slug, former);
  if (!prev) return null;
  if (prev.meta.carried_through === throughDate) return prev.file; // already stamped today
  const meta = { ...prev.meta, carried_through: throughDate };
  const dir = briefsDir(slug, { create: true });
  if (!dir) return null;
  const file = join(dir, basename(prev.file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeBrief({ meta, body: prev.body }));
  renameSync(tmp, file);
  return file;
}

// --- the heartbeat (task 134) -------------------------------------------------
//
// Once a quiet night correctly writes nothing, silence stops being evidence:
// "quiet for a week" and "this job died a week ago" render the same empty page.
// So every run records that it LOOKED, whatever it concluded — one file per job,
// overwritten each night, at $COGYARD_HOME/heartbeats/<slug>/<job-id>.md.
//
// Deliberately NOT a new brief file: a heartbeat is not prose about the project
// and must never appear in the run of days the owner reads back through. It is
// the answer to a different question — "is anything still watching this?" —
// and core reads it from its own directory (core/briefs.mjs readHeartbeats).
//
// The body is one plain sentence because someone will open this file in an
// editor one day and deserves to know what it is without a schema.

const HEARTBEATS_DIR = 'heartbeats';

function heartbeatsDir(slug, { create = false } = {}) {
  const s = safeSlug(slug);
  if (!s) return null;
  const dir = join(HOME, HEARTBEATS_DIR, s);
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHeartbeat(slug, jobId, { date, outcome, note }) {
  const dir = heartbeatsDir(slug, { create: true });
  if (!dir) return null;
  const file = join(dir, `${jobId}.md`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, serializeBrief({
    meta: { job: jobId, checked: date, checked_at: new Date().toISOString(), outcome },
    body: note,
  }));
  renameSync(tmp, file);
  return file;
}

function readHeartbeat(slug, jobId) {
  const dir = heartbeatsDir(slug);
  if (!dir) return null;
  const file = join(dir, `${jobId}.md`);
  return existsSync(file) ? readBrief(file) : null;
}

export {
  BRIEFS_DIR, HEARTBEATS_DIR, dayStamp, briefsDir, heartbeatsDir,
  writeHeartbeat, readHeartbeat,
  parseBrief, serializeBrief,
  listBriefs, readBrief, newestBrief, briefForDate, proseOf, lastGoodBrief, consecutiveFailures,
  writeBrief, carryForward,
};
