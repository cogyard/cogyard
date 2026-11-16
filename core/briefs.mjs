// core/briefs.mjs — READING a project's nightly briefs.
//
// A brief is a plain markdown file at $COGYARD_HOME/briefs/<slug>/YYYY-MM-DD.md
// with a small frontmatter block (core/job-output.mjs names the location; until
// task 187 it lived in the project's task store). Core does not write them and does not know
// what wrote them: the nightly brief is an ADD-ON (extras/addons/project-brief),
// core ships zero add-ons, and this module exists only so the portal can render
// a file that is there — and render nothing at all when it isn't.
//
// That is the whole integration. No add-on-contributed panels, no UI extension
// point, no coupling between the portal and any particular add-on: anything
// that writes this file shape gets rendered, including a human with an editor.
//
// The file format is the contract between writer and reader, so it is
// deliberately tiny — flat scalar frontmatter, markdown body — and asserted by
// test/briefs.test.mjs against what the add-on actually writes.
//
// A brief is NEVER a source of truth. The task files are. Nothing here may be
// treated as state; it is prose ABOUT state, regenerable and disposable.

import { basename, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { outputSlugs, briefsDir, heartbeatsDir } from './job-output.mjs';

const DATED_MD = /^\d{4}-\d{2}-\d{2}\.md$/;
const JOB_MD = /^[a-z0-9][a-z0-9-]*\.md$/;

// The files matching `pattern` across a project's output dirs (current slug
// first, then each former slug — core/job-output.mjs outputSlugs, task 195).
// One file per name: the current slug's copy wins over an old slug's.
function filesAcross(dirs, pattern) {
  const byName = new Map();
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) if (pattern.test(f) && !byName.has(f)) byName.set(f, join(dir, f));
  }
  return [...byName.values()];
}

// Every brief file for a project (by registry slug), newest first. Filenames are
// dates, so a string sort is a date sort; anything else in the directory is
// ignored rather than guessed at.
function listBriefFiles(slug) {
  return filesAcross(outputSlugs(slug).map((s) => briefsDir(s)), DATED_MD)
    .sort((a, b) => basename(b).localeCompare(basename(a)));
}

function parseBriefFile(file) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  const meta = {};
  let body = raw;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      let v = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
      if (v === 'null' || v === '') v = null;
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      meta[kv[1]] = v;
    }
    body = raw.slice(m[0].length);
  }
  return { file, meta, body: body.trim() };
}

// The lead paragraph — what /all shows per project, so the cross-project glance
// is twelve paragraphs rather than a table of counts. Skips the H1 and any
// blockquote (a failed brief opens with its alarm block, whose first line is
// not a paragraph).
function leadParagraph(body) {
  const blocks = String(body || '').replace(/^#[^\n]*\n+/, '').trim().split(/\n\s*\n/);
  for (const b of blocks) {
    const t = b.trim();
    if (!t || t.startsWith('>') || t.startsWith('#') || t.startsWith('<')) continue;
    return t;
  }
  return '';
}

// The failure vocabulary the wire admits. Anything else in a brief file is
// normalized to 'error' — see failureKind below.
const FAILURE_KINDS = new Set(['no-response', 'stalled', 'cancelled', 'unusable', 'error']);

// One parsed brief, normalized for the wire.
function normalizeBrief(b) {
  if (!b) return null;
  const status = b.meta.status === 'failed' ? 'failed' : 'ok';
  return {
    date: b.meta.date || null,
    status,
    // Set when a run found nothing had happened and stamped this brief as still
    // current instead of writing a near-identical one. The panel reads it as
    // "written the 4th, still true on the 11th".
    carriedThrough: b.meta.carried_through || null,
    generatedAt: b.meta.generated_at || null,
    cost: typeof b.meta.cost_usd === 'number' ? b.meta.cost_usd : null,
    model: b.meta.model || null,
    // failed only: why, how many nights running, and the last brief that could
    // be written. Nights drives the portal's escalation — a third silent night
    // must not look like the first.
    error: status === 'failed' ? (b.meta.error || 'unknown error') : null,
    // WHY the night failed. These read differently and send the owner to
    // different places, so the portal must tell them apart without opening the
    // file. Four come from the driver (docs/DRIVERS.md), `unusable` from the
    // job itself:
    //   'no-response' — nothing arrived; the agent was never reached.
    //   'stalled'     — it began answering and stopped. NOT the credential.
    //   'cancelled'   — the run ended first.
    //   'error'       — it could not run, or reported its own error.
    //   'unusable'    — it replied, was paid, and that was not a brief.
    // Unknown values fall back to 'error' rather than reaching the UI: a brief
    // file is data, and the portal switches on this.
    failureKind: status === 'failed' ? (FAILURE_KINDS.has(b.meta.failure_kind) ? b.meta.failure_kind : 'error') : null,
    failures: status === 'failed' ? (Number(b.meta.failures) || 1) : 0,
    lastGood: b.meta.last_good || null,
    markdown: b.body,
    lead: leadParagraph(b.body),
  };
}

// The newest brief for a project — or null when it has none.
function newestBrief(slug) {
  const [file] = listBriefFiles(slug);
  return file ? normalizeBrief(parseBriefFile(file)) : null;
}

// A project's brief HISTORY, newest first (task 120, owner 2026-08-20). The
// reason the briefs are kept rather than overwritten: coming back to a project
// after two weeks, one night's paragraph answers "what happened last night",
// which is not the question — "what happened while I was away" needs the run of
// them. Bounded because a year of nightly briefs is 365 files and no one reads
// past the first screenful.
function listBriefs(slug, limit = 30) {
  return listBriefFiles(slug)
    .slice(0, Math.max(1, limit))
    .map((f) => normalizeBrief(parseBriefFile(f)))
    .filter(Boolean);
}

// How many briefs a project has, without parsing any of them — the portal hides
// the Brief tab entirely for a project that has none, so this is asked for every
// project on every sidebar poll.
function briefCount(slug) {
  return listBriefFiles(slug).length;
}

// --- heartbeats (task 134) ----------------------------------------------------
//
// A brief's failure mode is ABSENCE, and absence is what a person does not
// notice. Once a quiet night correctly writes nothing, "this project has been
// quiet for a week" and "this job has been dead for a week" produce the same
// empty page — so a run records that it LOOKED, separately from whether it found
// anything to say.
//
// One file per job at $COGYARD_HOME/heartbeats/<slug>/<job-id>.md, same tiny
// flat-scalar format as a brief, for the same reason: the format is the whole
// contract, an add-on writes it and core renders it, and a person with an editor
// must be able to read it. Per job rather than per project because two jobs
// (project-brief, doc-drift) can watch the same project and one of them dying is
// exactly what this is for. Machine-level by nature: it says THIS machine's job
// looked, which is why it never belonged in a (possibly shared) task store.
//
// NO heartbeat is NOT an alarm. Most projects have no job installed and never
// will, and a job older than this feature never wrote one. Only a heartbeat that
// EXISTS and has gone stale says something is wrong.

function normalizeHeartbeat(b, job) {
  if (!b) return null;
  return {
    job: b.meta.job || job,
    // The local day the job looked. A date, not a timestamp, because "has
    // anything looked at this today" is a question about days.
    checked: b.meta.checked || null,
    checkedAt: b.meta.checked_at || null,
    // What that look concluded: 'written' | 'unchanged' | 'failed'. Distinct
    // from the brief's own status — a job can be perfectly alive and still be
    // failing to write, and those are different repairs.
    outcome: b.meta.outcome || null,
    note: String(b.body || '').trim(),
  };
}

// Every job's heartbeat for a project, most recently checked first. Empty for a
// project nothing watches, which is the ordinary case. A job that last looked
// before the project's slug changed shows that look until it looks again.
function readHeartbeats(slug) {
  return filesAcross(outputSlugs(slug).map((s) => heartbeatsDir(s)), JOB_MD)
    .map((f) => normalizeHeartbeat(parseBriefFile(f), basename(f, '.md')))
    .filter(Boolean)
    .sort((a, b) => String(b.checked || '').localeCompare(String(a.checked || '')));
}

// The one-line-per-project shape for /all: everything except the markdown body,
// which no cross-project view renders.
function briefSummary(slug) {
  const b = newestBrief(slug);
  if (!b) return null;
  const { markdown, ...rest } = b;
  return rest;
}

export {
  listBriefFiles, parseBriefFile, leadParagraph,
  normalizeBrief, newestBrief, listBriefs, briefCount, briefSummary,
  normalizeHeartbeat, readHeartbeats,
};
