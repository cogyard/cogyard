// core/drift.mjs — READING a project's doc-drift report.
//
// Sibling of core/briefs.mjs, and the same posture: core does not write this
// file and does not know what wrote it. The doc-drift job is an ADD-ON
// (extras/addons/doc-drift, task 119), core ships zero add-ons, and this module
// exists only so the Daily tab can render a report that is there — and render
// nothing when it isn't.
//
// One file per project at $COGYARD_HOME/drift/<slug>.md (core/job-output.mjs;
// in the project's task store until task 187), overwritten each run and
// REMOVED when a complete pass finds nothing. That asymmetry is load-bearing and
// this reader must preserve it: no file means no findings, never "we didn't
// look". A stale file can therefore never be read as a live finding.
//
// Rendering it here was deliberately deferred on 2026-08-19 — the owner wanted
// to know the findings were worth reading before giving them a surface — and
// asked for it on 2026-08-20, which is what task 120's own scope always
// anticipated ("119 adds that section to the surface this task creates").

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { outputSlugs, driftPath, heartbeatsDir } from './job-output.mjs';

// Which report file speaks for a project — or null for none.
//
// After a slug change (task 195) a report may still sit under an old slug. It
// counts only until a job has looked at the project under its CURRENT slug (any
// heartbeat there): from then on the job writes, and on a clean pass removes,
// drift/<current>.md alone, so the old file would otherwise read as a live
// finding forever — exactly what "no file means no findings" forbids. The old
// file is left where it is.
function driftFile(slug) {
  const [current, ...former] = outputSlugs(slug);
  if (!current) return null;
  const own = driftPath(current);
  if (existsSync(own)) return own;
  if (!former.length || lookedSince(current)) return null;
  return former.map((s) => driftPath(s)).find((p) => existsSync(p)) || null;
}

function lookedSince(slug) {
  try { return readdirSync(heartbeatsDir(slug)).some((f) => f.endsWith('.md')); } catch { return false; }
}

// The report, normalized for the wire — or null when there is none, which the
// Daily tab renders as nothing at all. `findings` is the count the job recorded;
// `markdown` is the body it wrote, which the portal renders verbatim rather than
// re-deriving, so what you read in the portal is what you read in the file.
function readDrift(slug) {
  const path = driftFile(slug);
  if (!path) return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }

  const meta = {};
  let body = raw;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      let v = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
      if (v === 'null' || v === '') v = null;
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      meta[kv[1]] = v;
    }
    body = raw.slice(m[0].length);
  }

  return {
    generatedAt: meta.generated_at || null,
    findings: Number(meta.findings) || 0,
    examined: Number(meta.examined) || 0,
    candidates: Number(meta.candidates) || 0,
    cost: typeof meta.cost_usd === 'number' ? meta.cost_usd : null,
    markdown: String(body).trim(),
  };
}

// Does this project have a live drift report? Asked per project on the sidebar
// poll, alongside the brief count, to decide whether the Daily tab exists.
function hasDrift(slug) {
  return !!driftFile(slug);
}

export { driftFile, readDrift, hasDrift };
