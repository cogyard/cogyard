// ~/.cogyard/addons/project-brief/addon.mjs — the nightly project brief.
//
// THE PROBLEM. The owner runs a dozen projects at once. Returning to one after
// two weeks, his questions are always the same: where are we, what was I doing
// last, where did we leave this. The portal answers none of them — it shows
// counts, which he can already see and which tell him nothing. Reconstructing
// the real state means opening task files one by one and reading git log, every
// time, for every project.
//
// THE ANSWER. Once a night, per project, an agent that has read the task
// bodies, the commits, and the last session transcript writes three paragraphs:
// what happened, where it stands, what's next. Twelve paragraphs over coffee,
// then go to work.
//
// This is deliberately an OPTIONAL ADD-ON, not core (task 120's framing, the
// owner's own): cogyard works today without it, most people with two projects
// will never want it, and it only starts paying for itself somewhere north of
// ten concurrent projects. Source lives in the cogyard repo under
// extras/addons/project-brief/ and is INSTALLED to ~/.cogyard/addons/ — see
// README.md. Nothing about it ships in core.
//
// WHAT IT WILL NOT DO. It reads, and it writes one markdown file per project
// per night under cogyard's machine-level home ($COGYARD_HOME/briefs/<slug>/ —
// never inside the project or its task store, task 187). It does not commit,
// does not open PRs, does not touch project source or docs, and does not notify
// anybody. The brief is somewhere you go, not something that interrupts you.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './cogyard.mjs';
import { detectChange, gather, LIMITS } from './inputs.mjs';
import { buildPrompt, buildDetail, parseProse } from './prompt.mjs';
import { failedBrief, writtenBrief } from './render.mjs';
import { carryForward, consecutiveFailures, dayStamp, lastGoodBrief, listBriefs, newestBrief, readBrief, writeBrief, writeHeartbeat } from './store.mjs';

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

// Whether a project has a task store to brief FROM. The brief itself is written
// under HOME, but a project with no tasks has no story to tell. The store is
// reached through the project's `.cogyard/tasks` link (cogyard task 160).
function hasStore(projectPath) {
  return !!projectPath && existsSync(join(projectPath, '.cogyard', 'tasks'));
}

function slugList(v) {
  return String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// What each night's heartbeat says. One plain sentence per outcome, because the
// file is meant to be readable by a person who opened it in an editor with no
// idea what wrote it.
const HEARTBEAT = {
  written: (date) => ({ date, outcome: 'written', note: `Looked at this project on ${date} and wrote a brief.` }),
  unchanged: (date) => ({ date, outcome: 'unchanged', note: `Looked at this project on ${date}. Nothing had happened since the last brief, so none was written.` }),
  failed: (date) => ({ date, outcome: 'failed', note: `Looked at this project on ${date} and could not write a brief. The failure is recorded in that night's brief file.` }),
};

// What each failure kind MEANS, in the owner's terms. Four of these come from
// the driver (docs/DRIVERS.md); `unusable` is this job's own, because only the
// caller knows the answer was not the thing it asked for.
//
// The distinction is the point of task 138: before it, every cause arrived as
// the word "aborted", so a night the model merely wedged read exactly like a
// night the credential died. These must never read alike.
const FAILURE_KINDS = {
  'no-response': 'could not reach the agent',
  stalled: 'the agent stopped mid-answer',
  cancelled: 'the run ended before this project was reached',
  unusable: 'no brief in the answer',
  error: 'could not look',
};

// Record a night that produced no brief — in the file the owner actually opens,
// never only in a log. `kind` separates "could not look" (a dead credential, a
// timeout) from "looked, was paid, and did not answer" (see parseProse): they
// read differently and they send the owner to different places. The date of the
// last brief that DID get written is recorded in `last_good`; its prose is not
// reprinted here (owner, 2026-09-03 — the Daily tab already shows the previous
// nights right underneath, so reprinting was the same words twice on a screen).
function writeFailure(project, name, date, { error, kind, cost, head, log, timing }) {
  const former = project.formerSlugs || [];
  const nights = consecutiveFailures(project.slug, former) + 1;
  const good = lastGoodBrief(project.slug, former);
  const ms = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  writeBrief(project.slug, date, {
    meta: {
      date, project: project.slug, status: 'failed', failure_kind: kind, head: head || null,
      generated_at: new Date().toISOString(), cost_usd: cost || 0, failures: nights,
      error: JSON.stringify(String(error)), last_good: good?.meta?.date || null,
      // How long it took and whether anything ever arrived. Recorded on the
      // failure because that is the case nobody could measure before: the nights
      // were only ever visible as gaps between log lines.
      elapsed_ms: ms(timing?.elapsedMs), ttfb_ms: ms(timing?.ttfbMs),
    },
    body: failedBrief({ project: name, date, error, nights, kind }),
  });
  log(`${name}: FAILED — ${FAILURE_KINDS[kind] || FAILURE_KINDS.error}`
    + ` (${nights} night${nights === 1 ? '' : 's'} running) — ${error}`);
  return { outcome: 'failed', cost: cost || 0, error };
}

// One project's brief run. Returns a record the caller folds into the summary;
// never throws — a project that blows up must not stop the other eleven.
async function briefOne(project, { agent, cfg, signal, log, budgetLeft }) {
  const date = dayStamp();
  const name = project.label || project.slug;

  if (!hasStore(project.path)) {
    log(`${name}: no task store — skipped`);
    return { outcome: 'nostore', cost: 0 };
  }

  // Former slugs too (core hands them in, task 195): a project whose checkout
  // moved still has its last brief, so the move is not paid for as a first night.
  const former = project.formerSlugs || [];
  const prev = newestBrief(project.slug, former);
  // A failed brief is never carried forward as though it were an answer: the
  // whole point of recording the failure is that the state is UNKNOWN, so the
  // next run must try again rather than treat "nothing new since I couldn't
  // look" as "nothing happened".
  const retryingFailure = prev?.meta?.status === 'failed';
  const change = await detectChange(project, retryingFailure ? null : prev);

  if (!change.changed) {
    carryForward(project.slug, date, former);
    log(`${name}: nothing since ${prev?.meta?.date || 'the last brief'} — carried forward, no agent call`);
    return { outcome: 'unchanged', cost: 0 };
  }

  if (budgetLeft <= 0) {
    log(`${name}: run cost ceiling reached — not called`);
    return { outcome: 'budget', cost: 0 };
  }

  const inputs = await gather(project, retryingFailure ? null : prev, change);
  const prompt = buildPrompt(inputs, { totalChars: LIMITS.totalChars });

  // Per-project bounds. Core's timeoutMs bounds the WHOLE run (a dozen
  // projects), which is far too loose for one call.
  //
  // The bound that matters is SILENCE, not duration (task 138). A flat cap
  // cannot tell a big project from a hung one — it killed both, and every cause
  // reached the owner as the same word. The driver streams, so the question is
  // "has this produced nothing for N seconds?", and a project that keeps
  // emitting is never killed however long it legitimately takes. `ceilingSec` is
  // a pure backstop against a stream that dribbles forever.
  //
  // Defaults are honest rather than round: successful calls streamed with
  // inter-event gaps under a second (measured 2026-09-04), so 90s of silence is
  // ~100x headroom and only ever fires on a call that has genuinely stopped.
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
      ceilingMs: num(cfg.ceilingSec, 900) * 1000,
    });
  } catch (e) {
    res = { ok: false, text: '', cost: null, model: null, error: String((e && e.message) || e), failure: 'error' };
  } finally {
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }

  const cost = typeof res.cost === 'number' && Number.isFinite(res.cost) ? res.cost : 0;

  // The agent could not be reached, or could not run. `res.failure` says WHICH —
  // a stall and a dead credential are different problems and send the owner to
  // different places, so the kind is carried through rather than flattened.
  if (!res.ok) {
    return writeFailure(project, name, date, {
      error: res.error || 'the agent returned nothing', kind: res.failure || 'error',
      cost, head: change.head, log, timing: res,
    });
  }

  // The agent replied — but an answer is only a brief if it is shaped like one.
  // Anything else (a tool call, a question, a wall of bullets, a refusal) is a
  // FAILED night, not a quiet one. Writing it up would produce a page that
  // reads as true, which is worse than a blank one; see parseProse.
  const parsed = parseProse(res.text);
  if (!parsed.usable) {
    return writeFailure(project, name, date, {
      error: parsed.reason, kind: 'unusable', cost, head: change.head, log,
    });
  }

  writeBrief(project.slug, date, {
    meta: {
      date, project: project.slug, status: 'ok', head: change.head,
      // Where every branch stood when this was written — the minimal
      // independent set, so it is a short line rather than every ref. Tomorrow
      // night asks git for whatever is not reachable from these, which is the
      // only way to tell new work from a branch that has sat still for months.
      refs: (change.tips || []).join(' ') || null,
      // The fingerprint of the task files this brief was written from. Next
      // night's detectChange compares against it, so a store whose files were
      // rewritten but not CHANGED reads as the quiet night it was.
      tasks_digest: change.tasksDigest || null,
      generated_at: new Date().toISOString(), cost_usd: cost, model: res.model || null,
      first: change.first ? true : undefined,
    },
    body: writtenBrief({
      project: name, date, prose: parsed.prose,
      detail: cfg.detail === false ? '' : buildDetail(inputs),
      cost, model: res.model,
    }),
  });
  log(`${name}: written (${change.commits.length} commit(s), ${change.sessions.length} session(s))`);
  return { outcome: 'written', cost };
}

export const manifest = {
  id: 'project-brief',
  label: 'Daily project brief',
  description: 'Once a night, an agent reads each project\'s tasks, commits and last session, and writes three paragraphs: what happened, where it stands, what\'s next.',
  icon: '📋',
  thirdParty: false,

  // 05:00 local: after the machine has been idle overnight and before the owner
  // reads it. catchUp on, because a laptop asleep at 05:00 is the normal case
  // and a brief that silently never runs is the failure this whole design is
  // organized against.
  schedule: { every: 'day', at: '05:00', catchUp: true },

  // What core enforces vs what this job enforces (docs/ADDONS.md):
  //   timeoutMs  — core aborts the whole run through ctx.signal.
  //   maxUnits   — MAX PROJECTS given an agent call in one run. Honoured below.
  //   maxCostUsd — the run's cost ceiling. Honoured below, checked before each
  //                agent call, because a fan-out bug across a dozen projects
  //                each spawning an agent is the expensive failure mode here.
  //
  // THE RUN CAP MUST EXCEED maxUnits × the per-project timeout, or the tail of
  // the project list can never be reached. It did not, and the first real run
  // proved it (2026-08-21): 30 minutes against 12 projects that can each take
  // the 240s per-project timeout is 48 minutes of worst case, so the run was
  // aborted partway and the last two projects were skipped — silently as far as
  // those projects are concerned, since a skipped project gets no brief at all
  // rather than a failed one. Alphabetical order made it the same projects every
  // night. 2h covers the declared 25 × 240s with slack; a nightly job has all
  // night, and finishing late beats being cut off mid-list.
  bounds: { timeoutMs: 2 * 60 * 60 * 1000, maxUnits: 25, maxCostUsd: 3 },

  configSchema: [
    { key: 'model', label: 'Model', type: 'string', placeholder: 'the driver\'s default' },
    // The real bound. A call is killed for going QUIET, not for taking a while,
    // so a big project that keeps streaming is never cut off (task 138).
    { key: 'silenceSec', label: 'Give up after this many seconds of silence', type: 'string', default: '90' },
    // The backstop, not the mechanism. Nothing legitimate lives near it.
    { key: 'ceilingSec', label: 'Absolute ceiling for one project (seconds)', type: 'string', default: '900' },
    { key: 'detail', label: 'Include the collapsed detail block', type: 'boolean', default: true },
    { key: 'skip', label: 'Skip these projects (slugs, comma-separated)', type: 'string', placeholder: 'scratch,archive' },
  ],

  // Machine-level roll-up: how many registered projects currently have a brief,
  // and how fresh the newest one is. Deliberately not a copy of the job's run
  // state — core owns that and shows it on the Scheduled jobs row.
  status() {
    const projects = registryProjects();
    let withBrief = 0;
    let newest = null;
    let failing = 0;
    for (const p of projects) {
      const [file] = listBriefs(p.slug);
      if (!file) continue;
      withBrief += 1;
      const b = readBrief(file);
      const date = b?.meta?.date || null;
      if (date && (!newest || date > newest)) newest = date;
      if (b?.meta?.status === 'failed') failing += 1;
    }
    const summary = !projects.length ? 'no projects registered'
      : !withBrief ? 'no briefs written yet'
      : `${withBrief} of ${projects.length} projects have a brief · newest ${newest}${failing ? ` · ${failing} failing` : ''}`;
    return { enabled: withBrief > 0, healthy: failing === 0, summary, details: { withBrief, projects: projects.length, newest, failing } };
  },

  prereqs() {
    const projects = registryProjects();
    const withStore = projects.filter((p) => hasStore(p.path)).length;
    return [
      {
        id: 'stores',
        label: 'Projects with a task store',
        ok: withStore > 0,
        fixHint: withStore > 0 ? undefined : 'Set a project up with `cogyard onboard` — the brief is written from its task files.',
      },
      {
        id: 'agent',
        label: 'An agent driver that can run headlessly',
        // Checked for real at run time through ctx.agent: an add-on has no
        // agent-agnostic way to ask core which driver is active without
        // importing it, and naming an agent here would hardcode the literal the
        // driver seam exists to avoid.
        ok: true,
        fixHint: 'Verified when the job runs; a run with no agent driver reports "no agent driver active" on this job\'s row.',
      },
    ];
  },

  // Unattended. No prompts, no stdin, nothing that waits for a human.
  // Idempotent: a catch-up run after a missed night re-detects change against
  // the newest brief and carries it forward rather than writing a second copy.
  async runScheduled(cfg = {}, ctx = {}) {
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    const bounds = ctx.bounds || {};

    // "No agent driver active" is a CONFIGURATION state, not a failure to look:
    // cogyard is working exactly as designed with no agent installed. It is
    // reported on the job's row and nothing is written — writing a dozen alarm
    // briefs for it would cry wolf and, worse, make the state that DOES matter
    // (a credential that died in November) look like more of the same.
    if (!ctx.agent || !ctx.agent.supported || typeof ctx.agent.run !== 'function') {
      log('no agent driver active — nothing written');
      return { ok: false, skipped: true, summary: 'no agent driver active', cost: 0, error: 'no agent driver active' };
    }

    const skip = new Set(slugList(cfg.skip));
    const projects = (ctx.projects || []).filter((p) => p && p.path && !skip.has(p.slug));
    const maxUnits = num(bounds.maxUnits, 25);
    const maxCost = num(bounds.maxCostUsd, 3);

    const tally = { written: 0, unchanged: 0, failed: 0, nostore: 0, budget: 0, aborted: 0 };
    let cost = 0;
    let called = 0;

    for (const project of projects) {
      if (ctx.signal?.aborted) { tally.aborted += 1; continue; }
      if (called >= maxUnits) { tally.budget += 1; continue; }

      let r;
      try {
        r = await briefOne(project, {
          agent: ctx.agent, cfg, signal: ctx.signal, log,
          budgetLeft: maxCost - cost,
        });
      } catch (e) {
        // A project whose inputs cannot even be gathered still gets a loud
        // brief: silence is the one outcome this feature may never produce.
        const error = String((e && e.message) || e);
        try {
          writeFailure(project, project.label || project.slug, dayStamp(), {
            error, kind: 'error', cost: 0, head: null, log,
          });
        } catch { /* an unwritable store is reported through the summary below */ }
        r = { outcome: 'failed', cost: 0, error };
      }

      // The heartbeat: this project was LOOKED AT tonight, whatever came of it.
      // Written for the three outcomes that mean somebody looked, and
      // deliberately NOT for 'budget' or 'aborted' — those projects were skipped
      // and genuinely went unobserved, which is precisely what the owner needs to
      // be able to see. 'nostore' has nowhere to write it.
      if (r.outcome === 'written' || r.outcome === 'unchanged' || r.outcome === 'failed') {
        try { writeHeartbeat(project.slug, manifest.id, HEARTBEAT[r.outcome](dayStamp())); }
        catch { /* an unwritable home already surfaces through the brief itself */ }
      }

      cost += r.cost || 0;
      tally[r.outcome] = (tally[r.outcome] || 0) + 1;
      if (r.outcome === 'written' || r.outcome === 'failed') called += 1;
    }

    // Written for a human reading it half-asleep: what got written, what was
    // quiet, and — first, because it is the only part that needs acting on —
    // what failed.
    const bits = [];
    if (tally.failed) bits.push(`${tally.failed} FAILED`);
    if (tally.written) bits.push(`${tally.written} written`);
    if (tally.unchanged) bits.push(`${tally.unchanged} unchanged`);
    if (tally.budget) bits.push(`${tally.budget} skipped (run ceiling)`);
    if (tally.nostore) bits.push(`${tally.nostore} without a task store`);
    if (tally.aborted) bits.push(`${tally.aborted} skipped (run aborted)`);

    return {
      ok: tally.failed === 0,
      skipped: tally.written === 0 && tally.failed === 0,
      summary: `${projects.length} project${projects.length === 1 ? '' : 's'} · ${bits.join(', ') || 'nothing to do'}`,
      cost: Number(cost.toFixed(6)),
      error: tally.failed ? `${tally.failed} project(s) could not be briefed` : undefined,
    };
  },
};

export default manifest;
