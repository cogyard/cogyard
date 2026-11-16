// report.mjs — the drift report FILE: where it lives, how it is written, and
// when it is removed.
//
// One file per project at $COGYARD_HOME/drift/<slug>.md, overwritten each run.
// Deliberately a file: readable without the portal, in any editor, and
// deletable. The Daily tab renders it (core/drift.mjs).
//
// Until task 187 it lived in the project's task store (<project>/_tasks/drift.md)
// so the store's own git would version it. Nothing ever committed it — this job
// may not commit — so it sat pending until an unrelated `sync push` swept it into
// someone else's commit. It is machine-level output, so it lives in cogyard's
// machine-level home now, beside this add-on's own doc-drift.json.
//
// NOTHING IS WRITTEN WHEN THERE IS NOTHING TO SAY. A project with no confirmed
// findings has its report REMOVED, so a stale file can never be read as a live
// finding. That asymmetry is the whole design: silence must mean silence.
//
// This add-on never writes to a doc — it writes ABOUT docs. The layout is core's
// (core/job-output.mjs); this add-on installs outside the repo and cannot import
// core synchronously, so the lines that place a file are spelled again here.
// docs/ADDONS.md is the contract, and test/doc-drift-addon.test.mjs asserts this
// writer lands where core reads.

import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { HOME } from './cogyard.mjs';

const DRIFT_DIR = 'drift';

// A slug becomes a path segment; anything that could climb out of HOME is
// refused (null) rather than written somewhere else. Same guard as core's.
function safeSlug(slug) {
  const s = String(slug ?? '');
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..' ? s : null;
}

// $COGYARD_HOME/drift/<slug>.md — or null for a slug that is not a safe path
// segment, which callers treat as "nowhere to report".
function reportPath(slug) {
  const s = safeSlug(slug);
  return s ? join(HOME, DRIFT_DIR, `${s}.md`) : null;
}

// --- the fingerprint ----------------------------------------------------------
// What the last run looked at, so an unchanged repo costs nothing. It has to
// cover BOTH halves of a candidate: the doc's own last commit (a doc edited
// since must be re-judged) and the contradicting commits (new work must be
// re-judged). Two runs with the same fingerprint would ask the agent the same
// question and get the same answer, so the second one doesn't ask.
function fingerprint(candidates) {
  return candidates
    .map((c) => `${c.doc}@${c.docLastCommit.sha}:${c.tasks.map((t) => t.id).join('.')}~${c.newestCommitAt}`)
    .sort()
    .join('|');
}

// --- reading ------------------------------------------------------------------

function parseReport(raw) {
  const text = String(raw ?? '');
  const out = { meta: {}, body: text };
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (v === 'null' || v === '') v = null;
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    out.meta[kv[1]] = v;
  }
  out.body = text.slice(m[0].length);
  return out;
}

function readReport(slug) {
  const path = reportPath(slug);
  if (!path || !existsSync(path)) return null;
  try { return { path, ...parseReport(readFileSync(path, 'utf8')) }; } catch { return null; }
}

// --- writing ------------------------------------------------------------------

function serialize(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : v}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}

// Written for a human who has not been thinking about this doc: the claim
// first (that is the part he can check in ten seconds), then what is now true,
// then the tasks to read if he wants the detail.
function renderFindings({ project, findings, checked, generatedAt }) {
  const lines = [
    `# Doc drift — ${project}`,
    '',
    `${findings.length} doc${findings.length === 1 ? '' : 's'} look${findings.length === 1 ? 's' : ''} stale`
      + ` (of ${checked} candidate${checked === 1 ? '' : 's'} examined, ${String(generatedAt).slice(0, 10)}).`,
    '',
    'Each finding is a claim in a doc that the work below appears to contradict.',
    'Nothing here has been changed — fixing a doc is a normal task, picked up by a human.',
    '',
  ];
  for (const f of findings) {
    lines.push(
      `## ${f.doc}`,
      '',
      `Last changed ${String(f.docLastCommit.date).slice(0, 10)} (${f.docLastCommit.sha}), `
        + `${f.ageDays} days before the newest work in its area.`,
      '',
      `**It says:** “${f.claim.trim()}”`,
      '',
      `**Now:** ${f.now.trim()}`,
      '',
      `**Contradicted by:** ${f.tasks.map((t) => `#${t.id} ${t.title || ''}`.trim()).join(' · ')}`,
      '',
    );
  }
  return lines.join('\n');
}

// Write the report, atomically (tmp+rename): the portal or the owner's editor
// may be reading it while a 05:20 run rewrites it.
function writeReport(slug, { meta, body }) {
  const path = reportPath(slug);
  if (!path) return null;
  mkdirSync(join(HOME, DRIFT_DIR), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serialize(meta, body));
  renameSync(tmp, path);
  return path;
}

// No findings → no file. Returns true when something was actually removed, so
// the run log can say "cleared" rather than claiming a change that didn't happen.
function clearReport(slug) {
  const path = reportPath(slug);
  if (!path || !existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// --- the heartbeat (task 139) --------------------------------------------------
//
// "I looked", recorded separately from "here is what I found". The report above
// is DELETED on a clean pass, deliberately, so a stale finding can never be read
// as a current one — which leaves a clean night and a dead job rendering the
// same empty section. This is the other half.
//
// Format: $COGYARD_HOME/heartbeats/<slug>/<job-id>.md, flat scalar frontmatter, one plain
// sentence of body. Specified in docs/ADDONS.md and read by core's
// readHeartbeats(); this is a second INDEPENDENT implementation of that written
// contract, which is the designed extension path — add-ons are installed
// separately and may not import one another, so the doc is the shared thing,
// not the code. test/doc-drift-addon.test.mjs asserts this writer and the
// project-brief one produce a file core parses identically; if the format ever
// moves, that fails rather than the two silently diverging.
const HEARTBEATS = 'heartbeats';

function writeHeartbeat(slug, jobId, { date, outcome, note }) {
  const s = safeSlug(slug);
  if (!s) return null;
  const dir = join(HOME, HEARTBEATS, s);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${jobId}.md`);
  const tmp = `${file}.tmp`;
  // Atomic tmp+rename like every other cogyard state write: the portal may be
  // reading this to render a line while the nightly job replaces it.
  writeFileSync(tmp, serialize(
    { job: jobId, checked: date, checked_at: new Date().toISOString(), outcome },
    note,
  ));
  renameSync(tmp, file);
  return file;
}

export { DRIFT_DIR, HEARTBEATS, reportPath, fingerprint, parseReport, readReport, renderFindings, writeReport, clearReport, serialize, writeHeartbeat };
