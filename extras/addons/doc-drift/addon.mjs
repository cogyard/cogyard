// ~/.cogyard/addons/doc-drift/addon.mjs — the docs the tasks left behind.
//
// THE PROBLEM. Tasks change code and forget the docs. A project accumulates
// architectural prose — CLAUDE.md, docs/*.md — that was accurate when written
// and quietly went wrong as five later tasks reshaped the code it describes.
// Nobody notices until someone acts on it: a human, or an AI session that loaded
// the doc as ground truth and is now confidently wrong in every conversation.
//
// THE ANSWER, IN TWO HALVES.
//   1. A candidate query that is nearly free — core/doc-drift.mjs, no agent, no
//      cost: which docs have work in their own declared area that landed long
//      after they were last touched. That half needs none of this add-on.
//   2. The judgement, which is the only expensive part: read the doc, read what
//      those tasks did, and decide whether the doc is now WRONG. That is what
//      the nightly agent call buys, and it is why this exists as a scheduled job.
//
// IT REPORTS; IT DOES NOT FIX. Non-negotiable. Architectural docs are the
// owner's prose and his reasoning, and a nightly agent quietly rewriting them
// means he can never again trust that a doc says what he decided. So the output
// is a finding — this doc, this claim, contradicted by this work, here's what's
// now true — written to $COGYARD_HOME/drift/<slug>.md. Turning a finding into a fix
// is a normal task, picked up by a human, reviewed like any other change. This
// job never edits a doc, never commits, never opens a PR.
//
// THE FAILURE CONDITION IS NOISE, NOT SILENCE. A drift report that cries wolf
// once is a report he stops reading. Everything here is biased that way: a quiet
// default threshold, a prompt whose default answer is "no", a verdict parser
// that discards any finding whose quoted claim isn't literally in the doc, and
// no file at all when there is nothing to say.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, cogyardCore } from './cogyard.mjs';
import { buildPrompt, parseVerdict } from './prompt.mjs';
import { clearReport, fingerprint, readReport, renderFindings, writeHeartbeat, writeReport } from './report.mjs';
import { lastFingerprint, readState, rememberProject } from './state.mjs';

// --- small sync helpers for status()/prereqs(), which the loader calls
// synchronously and must never leave waiting on I/O of ours.

function registryProjects() {
  try {
    const rows = JSON.parse(readFileSync(join(HOME, 'projects.json'), 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function num(v, d) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : d;
}

function list(v) {
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// The driver's failure vocabulary (docs/DRIVERS.md), said in this job's words.
// Before task 138 every one of these was the single word "aborted", so the run
// log could not tell an unreachable agent from one that wedged mid-answer.
const DRIFT_FAILURE = {
  'no-response': 'could not reach the agent',
  stalled: 'the agent stopped mid-answer',
  cancelled: 'the run ended before this doc was judged',
  error: 'agent failed',
};

// --- one candidate ------------------------------------------------------------

// Ask the agent about ONE doc. Returns a finding, or null when the doc is fine
// (which includes every ambiguous answer — see parseVerdict).
async function judge(candidate, { project, tasksById, agent, cfg, signal, log }) {
  const docPath = join(project.path, candidate.doc);
  let docText;
  try { docText = readFileSync(docPath, 'utf8'); } catch {
    log(`${project.slug}: ${candidate.doc} — unreadable, skipped`);
    return { cost: 0, finding: null };
  }

  const tasks = candidate.tasks.map((t) => ({ ...t, body: tasksById.get(t.id)?.body || '' }));
  const prompt = buildPrompt({
    project: project.label || project.slug,
    doc: candidate.doc,
    docText,
    docLastCommit: candidate.docLastCommit,
    ageDays: candidate.ageDays,
    area: candidate.area,
    tasks,
    commits: candidate.tasks.flatMap((t) => t.commits),
  });

  // Per-candidate bounds. Core's timeoutMs bounds the WHOLE run (every project,
  // every doc), which is far too loose for one call.
  //
  // The bound that matters is SILENCE, not duration (task 138): the driver
  // streams, so a call is killed for going quiet rather than for taking a
  // while, and a long doc that keeps producing is never cut off. `ceilingSec`
  // is a pure backstop — kept under this job's own 20-minute run budget, so one
  // pathological doc cannot eat the whole night's remaining candidates.
  const signalOnly = new AbortController();
  const onParentAbort = () => signalOnly.abort();
  if (signal) {
    if (signal.aborted) signalOnly.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let res;
  try {
    res = await agent.run({
      prompt,
      signal: signalOnly.signal,
      model: cfg.model || undefined,
      silenceMs: num(cfg.silenceSec, 90) * 1000,
      ceilingMs: num(cfg.ceilingSec, 600) * 1000,
    });
  } catch (e) {
    res = { ok: false, text: '', cost: null, error: String((e && e.message) || e), failure: 'error' };
  } finally {
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }

  const cost = typeof res.cost === 'number' && Number.isFinite(res.cost) ? res.cost : 0;
  if (!res.ok) {
    // Name the KIND, not just "failed" — a stall and an unreachable agent are
    // different problems, and the run log is where the owner looks first.
    log(`${project.slug}: ${candidate.doc} — ${DRIFT_FAILURE[res.failure] || 'agent failed'}: ${res.error || 'no reason given'}`);
    return { cost, finding: null, error: res.error || 'agent failed' };
  }

  const verdict = parseVerdict(res.text, { docText });

  // The agent replied, but not with a judgement. That is NOT a clean bill of
  // health — this doc was never judged, and saying "clean" here is the exact
  // expensive silence this job is built to avoid. Report it, keep it out of the
  // clean count, and let it be retried tomorrow.
  if (verdict.usable === false) {
    log(`${project.slug}: ${candidate.doc} — NOT JUDGED (${verdict.reason})`);
    return { cost, finding: null, unjudged: true, reason: verdict.reason };
  }

  if (!verdict.stale) {
    log(`${project.slug}: ${candidate.doc} — not stale`);
    return { cost, finding: null };
  }

  // The agent may name a narrower set of tasks than the query surfaced; prefer
  // its answer when it is a subset of what it was shown, since it read them.
  const shown = new Set(candidate.tasks.map((t) => t.id));
  const named = (verdict.taskIds || []).filter((id) => shown.has(id));
  const tasksForFinding = (named.length ? named : [...shown]).map((id) => {
    const t = candidate.tasks.find((x) => x.id === id);
    return { id, title: t?.title || '' };
  });

  log(`${project.slug}: ${candidate.doc} — STALE`);
  return {
    cost,
    finding: {
      doc: candidate.doc,
      docLastCommit: candidate.docLastCommit,
      ageDays: candidate.ageDays,
      claim: verdict.claim,
      now: verdict.now,
      tasks: tasksForFinding,
    },
  };
}

// Local wall-clock date, not UTC: a run at 05:20 belongs to that morning's date
// wherever the machine is. Same rule as the brief job's dayStamp.
function dayStamp(d = new Date()) {
  const t = new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

// --- the heartbeat (task 139) --------------------------------------------------
//
// THE VOCABULARY DECISION, and why it is not a wider one.
//
// This job has five internal outcomes (findings / clean / unchanged / failed /
// unjudged); the brief job has three (written / unchanged / failed). The
// temptation is to widen the shared `outcome` field to the union of both. That
// is the wrong shape: the heartbeat answers ONE question — "is anything still
// watching this project, and did it get anywhere?" — and a field that grows a
// term every time a job is added stops being a contract and becomes a list.
//
// So the contract keeps its three, defined by MEANING rather than by job:
//   written   — it looked and produced a report (a brief; here, findings)
//   unchanged — it looked and there was nothing new to say
//   failed    — it looked and could not finish
//
// The job-specific detail lives in the NOTE, which is a free sentence and is
// what a person reads when they open the file. `clean` and `unchanged` both map
// to `unchanged` because they are the same answer to the heartbeat's question —
// the note still says which one it was.
//
// `unjudged` maps to `failed`: some doc was looked at and no verdict came back.
// Calling that "unchanged" would report a partial blind spot as a clean night,
// which is the exact confusion this whole feature exists to prevent.
const HEARTBEAT = (outcome, date, r = {}) => {
  const n = r.findings || 0;
  switch (outcome) {
    case 'findings':
      return { date, outcome: 'written',
        note: `Looked at this project on ${date} and reported ${n} doc${n === 1 ? '' : 's'} that may have gone stale.` };
    case 'clean':
      return { date, outcome: 'unchanged',
        note: `Looked at this project on ${date}. No doc has work in its own area newer than itself, so there was nothing to report.` };
    case 'unchanged':
      return { date, outcome: 'unchanged',
        note: `Looked at this project on ${date}. The same docs and the same commits as the last run, so the previous verdict still stands.` };
    case 'unjudged':
      return { date, outcome: 'failed',
        note: `Looked at this project on ${date}, but at least one doc came back without a usable verdict. Treat those as unexamined.` };
    default:
      return { date, outcome: 'failed',
        note: `Looked at this project on ${date} and could not finish. The run summary records why.` };
  }
};

// --- one project --------------------------------------------------------------

async function driftOne(project, { core, agent, cfg, signal, log, budgetLeft, unitsLeft }) {
  const candidates = (await core.docDriftCandidates(project.path, {
    docGlobs: list(cfg.docGlobs).length ? list(cfg.docGlobs) : undefined,
    minTasks: num(cfg.minTasks, undefined),
    minAgeDays: cfg.minAgeDays === '0' ? 0 : num(cfg.minAgeDays, undefined),
  })).candidates;

  // Nothing looks stale: clear any previous report and spend nothing. This is
  // the common case and it must cost zero — the query is the cheap half.
  if (!candidates.length) {
    const cleared = clearReport(project.slug);
    rememberProject(project.slug, { fingerprint: '', findings: 0, checkedAt: new Date().toISOString() });
    log(`${project.slug}: no candidates${cleared ? ' — previous report cleared' : ''}`);
    return { outcome: 'clean', cost: 0, called: 0 };
  }

  // Same docs, same commits, same tasks as last time: the agent would be asked
  // the identical question and would give the identical answer. Don't ask.
  const fp = fingerprint(candidates);
  if (fp && fp === lastFingerprint(project.slug)) {
    log(`${project.slug}: ${candidates.length} candidate(s), unchanged since the last run — no agent call`);
    return { outcome: 'unchanged', cost: 0, called: 0 };
  }

  const tasksById = new Map();
  for (const t of core.loadTasks(core.tasksDirOf(project.path))) {
    const id = Number(t.frontmatter?.id);
    if (Number.isFinite(id)) tasksById.set(id, t);
  }

  const findings = [];
  let cost = 0;
  let called = 0;
  let examined = 0;
  let failures = 0;
  let unjudged = 0;

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    if (called >= unitsLeft) { log(`${project.slug}: run unit ceiling reached — ${candidates.length - examined} candidate(s) not examined`); break; }
    if (cost >= budgetLeft) { log(`${project.slug}: run cost ceiling reached — ${candidates.length - examined} candidate(s) not examined`); break; }

    const r = await judge(candidate, { project, tasksById, agent, cfg, signal, log });
    examined += 1;
    called += 1;
    cost += r.cost;
    if (r.error) failures += 1;
    if (r.unjudged) unjudged += 1;
    if (r.finding) findings.push(r.finding);
  }

  // A partial pass must not delete a report built from a fuller one, and must
  // not claim a clean bill of health it didn't earn. Only a complete pass with
  // no findings clears the file — and a doc the agent never actually judged
  // makes the pass incomplete, exactly like an error does. That also keeps the
  // fingerprint unstored, so tomorrow's run asks again instead of inheriting a
  // verdict nobody gave.
  const complete = examined === candidates.length && !failures && !unjudged && !signal?.aborted;

  if (findings.length) {
    writeReport(project.slug, {
      meta: {
        project: project.slug,
        generated_at: new Date().toISOString(),
        candidates: candidates.length,
        examined,
        findings: findings.length,
        cost_usd: Number(cost.toFixed(6)),
      },
      body: renderFindings({
        project: project.label || project.slug,
        findings,
        checked: examined,
        generatedAt: new Date().toISOString(),
      }),
    });
  } else if (complete) {
    clearReport(project.slug);
  }

  if (complete) rememberProject(project.slug, { fingerprint: fp, findings: findings.length, checkedAt: new Date().toISOString() });

  return {
    // A doc nobody judged outranks the clean ones in the outcome, for the same
    // reason it outranks them in the summary line.
    outcome: findings.length ? 'findings' : failures ? 'failed' : unjudged ? 'unjudged' : 'clean',
    cost, called, findings: findings.length, examined, candidates: candidates.length, failures, unjudged,
  };
}

// --- the manifest -------------------------------------------------------------

export const manifest = {
  id: 'doc-drift',
  label: 'Daily doc drift',
  description: 'Finds project docs that the tasks left behind — a doc whose own area kept changing long after the doc did — and reports, per project, which claim in it now looks wrong. It never edits a doc.',
  icon: '🧭',
  thirdParty: false,

  // 05:20 local, twenty minutes after the nightly brief's slot: the two jobs are
  // independent, but sharing a minute means sharing a laptop's wake-up and both
  // fighting for the same agent. catchUp on — a laptop asleep at 05:20 is the
  // normal case.
  schedule: { every: 'day', at: '05:20', catchUp: true },

  // This job calls the agent (the judgement half), so its Settings row should
  // warn when the driver's credential is missing. A job that only reads git and
  // files omits this and is never told it needs one.
  needsAgent: true,

  // What core enforces vs what this job enforces (docs/ADDONS.md):
  //   timeoutMs  — core aborts the whole run through ctx.signal.
  //   maxUnits   — MAX DOCS given an agent call in one run, across all projects.
  //   maxCostUsd — the run's cost ceiling, checked before each call.
  // Deliberately smaller than the brief's: this job's value is one true finding
  // a week, not coverage.
  bounds: { timeoutMs: 20 * 60 * 1000, maxUnits: 12, maxCostUsd: 2 },

  configSchema: [
    { key: 'docGlobs', label: 'Which files count as docs', type: 'string', default: 'CLAUDE.md, docs/**/*.md, _docs/**/*.md', placeholder: 'CLAUDE.md, docs/**/*.md, _docs/**/*.md' },
    { key: 'minTasks', label: 'Minimum contradicting tasks', type: 'string', default: '2' },
    { key: 'minAgeDays', label: 'Minimum days between the doc and the newest work', type: 'string', default: '30' },
    { key: 'model', label: 'Model', type: 'string', placeholder: 'the driver\'s default' },
    // NO credential field here, deliberately. The agent's credential belongs to
    // the DRIVER — it is the driver that spawns the agent, every scheduled job
    // needs the same one variable, and its name is an agent-specific literal
    // that has no business inside a community add-on. It is declared in
    // drivers/<name>/adapter.mjs and surfaced by the 'scheduled-tasks' add-on;
    // this job only REPORTS whether it is there (see prereqs below).
    // The real bound: a call is killed for going QUIET, not for taking a while,
    // so a long doc that keeps streaming is never cut off (task 138).
    { key: 'silenceSec', label: 'Give up after this many seconds of silence', type: 'string', default: '90' },
    // The backstop, not the mechanism. Nothing legitimate lives near it.
    { key: 'ceilingSec', label: 'Absolute ceiling for one doc (seconds)', type: 'string', default: '600' },
    { key: 'skip', label: 'Skip these projects (slugs, comma-separated)', type: 'string', placeholder: 'scratch,archive' },
  ],

  // Machine-level roll-up: which projects currently have findings. Deliberately
  // not a copy of the job's run state — core owns that and shows it on the
  // Scheduled jobs row.
  status() {
    const projects = registryProjects();
    const state = readState();
    let withFindings = 0;
    let findings = 0;
    let newest = null;
    for (const p of projects) {
      const report = readReport(p.slug);
      if (report?.meta?.findings) { withFindings += 1; findings += Number(report.meta.findings) || 0; }
      const at = state[p.slug]?.checkedAt || null;
      if (at && (!newest || at > newest)) newest = at;
    }
    const summary = !projects.length ? 'no projects registered'
      : !newest ? 'not run yet'
      : findings ? `${findings} stale doc${findings === 1 ? '' : 's'} across ${withFindings} project${withFindings === 1 ? '' : 's'}`
      : 'no docs look stale';
    return {
      enabled: !!newest,
      healthy: true, // findings are the product, not a fault — never render as unhealthy
      summary,
      details: { projects: projects.length, withFindings, findings, lastCheckedAt: newest },
    };
  },

  // Core hands in `cfg` and, in the second argument, the things this job needs
  // to report on a credential WITHOUT owning one (task 127):
  //   agentCredential — the active driver's { env, label, set }, or null if the
  //     driver needs none. Naming a variable here would hardcode the literal the
  //     driver seam exists to avoid.
  //   whereToSet(name) — core's one sentence saying where to set it. The
  //     credential is set in the store and used HERE, so this row has to carry
  //     the pointer; "missing" alone leaves the reader at the wrong end of it.
  prereqs(cfg = {}, { agentCredential, whereToSet } = {}) {
    const projects = registryProjects();
    // The project's link to its task store (cogyard task 160).
    const withStore = projects.filter((p) => existsSync(join(p.path, '.cogyard', 'tasks'))).length;
    const rows = [
      {
        id: 'stores',
        label: 'Projects with a task store',
        ok: withStore > 0,
        fixHint: withStore > 0 ? undefined : 'Set a project up with `cogyard onboard` — drift is derived from its task files.',
      },
    ];

    // The credential, checked NOW rather than at 05:20. This job's agent call is
    // its whole expensive half, and a missing token used to surface as a failed
    // nightly run and nothing else.
    if (agentCredential) {
      rows.push({
        id: 'credential',
        label: `${agentCredential.label} — the agent this job calls`,
        ok: !!agentCredential.set,
        fixHint: agentCredential.set ? undefined
          : `${typeof whereToSet === 'function' ? whereToSet(agentCredential.env) : `Set ${agentCredential.env}.`}`
            + (agentCredential.howTo ? ` Get the value with: ${agentCredential.howTo}` : ''),
      });
    }

    rows.push({
      id: 'agent',
      label: 'An agent driver that can run headlessly',
      // Checked for real at run time through ctx.agent.
      ok: true,
      fixHint: 'Verified when the job runs; a run with no agent driver reports "no agent driver active" on this job\'s row.',
    });
    return rows;
  },

  // Unattended. No prompts, no stdin, nothing that waits for a human.
  // Idempotent: a catch-up run after a missed night re-derives the same
  // candidates, matches the stored fingerprint, and makes no agent call.
  async runScheduled(cfg = {}, ctx = {}) {
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    const bounds = ctx.bounds || {};

    let core;
    try { core = await cogyardCore(); } catch (e) {
      const error = String((e && e.message) || e);
      log(error);
      return { ok: false, summary: 'cannot reach cogyard\'s engine', cost: 0, error };
    }

    // "No agent driver active" is a CONFIGURATION state, not a failure to look:
    // cogyard works exactly as designed with no agent installed. Reported on the
    // row; nothing is written and nothing already written is deleted.
    if (!ctx.agent || !ctx.agent.supported || typeof ctx.agent.run !== 'function') {
      log('no agent driver active — nothing examined');
      return { ok: false, skipped: true, summary: 'no agent driver active', cost: 0, error: 'no agent driver active' };
    }

    const skip = new Set(list(cfg.skip));
    const projects = (ctx.projects || []).filter((p) => p && p.path && !skip.has(p.slug));
    const maxUnits = num(bounds.maxUnits, 12);
    const maxCost = num(bounds.maxCostUsd, 2);

    const tally = { findings: 0, clean: 0, unchanged: 0, failed: 0, unjudged: 0 };
    let cost = 0;
    let called = 0;
    let staleDocs = 0;
    let unjudgedDocs = 0;

    for (const project of projects) {
      if (ctx.signal?.aborted) break;
      let r;
      try {
        r = await driftOne(project, {
          core, agent: ctx.agent, cfg, signal: ctx.signal, log,
          budgetLeft: maxCost - cost,
          unitsLeft: maxUnits - called,
        });
      } catch (e) {
        // A project whose query blows up must not stop the other eleven, and
        // must not silently look clean either.
        const error = String((e && e.message) || e);
        log(`${project.slug}: FAILED — ${error}`);
        r = { outcome: 'failed', cost: 0, called: 0 };
      }
      // This project was LOOKED AT tonight, whatever came of it (task 139).
      //
      // Without this, a clean pass and a dead job render identically on the
      // Daily tab — nothing — because the report file is deliberately deleted
      // when there is nothing to say. The owner hit exactly that on 2026-09-03
      // and had to ask a person to read jobs.json for him.
      //
      // Written for every outcome the loop REACHED. Not written for a project
      // the run never got to: `ctx.signal.aborted` breaks out of this loop
      // above, and those projects genuinely went unobserved — claiming
      // otherwise would hide the state the heartbeat exists to reveal.
      try { writeHeartbeat(project.slug, manifest.id, HEARTBEAT(r.outcome, dayStamp(), r)); }
      catch { /* an unwritable home already surfaces through the run summary */ }

      cost += r.cost || 0;
      called += r.called || 0;
      staleDocs += r.findings || 0;
      unjudgedDocs += r.unjudged || 0;
      tally[r.outcome] = (tally[r.outcome] || 0) + 1;
    }

    // The Settings row shows this line in the morning, so it leads with what
    // needs acting on. Anything unexamined leads, ALWAYS: "no docs look stale ·
    // 1 project FAILED" reads as a clean bill of health with a footnote, when
    // the truth is that a project was never looked at. (Caught by the first live
    // run, where the agent could not authenticate.) A doc the agent answered
    // about without judging is the same lie in a quieter voice, so it leads too.
    const bits = [];
    if (tally.unchanged) bits.push(`${tally.unchanged} unchanged`);
    if (tally.clean) bits.push(`${tally.clean} clean`);
    const verdict = staleDocs
      ? `${staleDocs} doc${staleDocs === 1 ? '' : 's'} look${staleDocs === 1 ? 's' : ''} stale across ${tally.findings} project${tally.findings === 1 ? '' : 's'}`
      : 'no docs look stale';
    const alarms = [];
    if (tally.failed) alarms.push(`${tally.failed} project${tally.failed === 1 ? '' : 's'} could NOT be examined`);
    if (unjudgedDocs) alarms.push(`${unjudgedDocs} doc${unjudgedDocs === 1 ? '' : 's'} NOT judged`);
    const head = alarms.length ? alarms.join(', ') : verdict;
    const rest = alarms.length ? [verdict, ...bits] : bits;

    const errors = [];
    if (tally.failed) errors.push(`${tally.failed} project(s) could not be examined`);
    if (unjudgedDocs) errors.push(`${unjudgedDocs} doc(s) got no usable answer from the agent`);

    return {
      ok: tally.failed === 0 && unjudgedDocs === 0,
      skipped: called === 0 && tally.failed === 0,
      summary: `${head}${rest.length ? ` · ${rest.join(', ')}` : ''}`,
      cost: Number(cost.toFixed(6)),
      error: errors.length ? errors.join('; ') : undefined,
    };
  },
};

export default manifest;
