// core/close.mjs — is a task ready to close? (task 171)
//
// `cogyard tasks close` and the "looks closeable" list in `tasks doctor` both
// ask here, so the command and the suggestion can never disagree. READ-ONLY:
// nothing in this module writes a task file — the close itself lives in
// cli/tasks.mjs and runs only when the owner types the command. That is the
// owner's rule, settled 2026-10-02: cogyard OFFERS, it never closes on its own.
//
// The rule (owner, 2026-10-10 — the task file has the reasoning):
//   boxes  — every box in the file (Scope, Acceptance, anything else) is ticked
//            or settled. Settled = dropped / moved (core/status.mjs
//            SETTLED_KINDS). An `(optional)` box is a leftover:
//            the task can close as ENOUGH, not DONE — DONE means nothing is left
//            to see (owner, task 238). An unmarked open box blocks both but ENOUGH.
//   status — OPEN, and no live park note in the text (task 244).
//   merge  — env.branch is contained in the default branch, OR there is no
//            branch to merge (none recorded, or it never got a commit of its own:
//            a task finished by an outside event, like a CI run going green).
//   claim  — unclaimed, or claimed by the person asking (any of their sessions).
//   A task with no boxes at all is never SUGGESTED (no evidence it's finished),
//   but the owner may still close it.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { validateTasks, isBoxMarkerProblem } from './validate.mjs';
import { checkboxSteps, boxCounts, loadTasks } from './frontmatter.mjs';
import { readRegistry } from './registry.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { SETTLED_KINDS, isClosed } from './status.mjs';
import { liveParkNotes, describePark } from './park.mjs';
import { defaultBranchSync } from './exec.mjs';

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// Who is asking — the same identity `env claim` records in env.claimed_by.
export function whoAmI(cwd) {
  return process.env.COGYARD_USER || git(['config', 'user.name'], cwd || process.cwd()) || process.env.USER || null;
}

// The boxes, sorted into what a close cares about. `afterMerge` (task 232) is
// the open `(after merge)` boxes — the agent's own checks still to run on main —
// kept apart from `pending` so a refusal can say "run these" instead of reading
// as a decision for the owner. Both block a close. `leftovers` is the marked
// boxes that block DONE but not ENOUGH — `(optional)` — as { kind, text }. `total` is every box (a task with none is never
// suggested); `counted` is the dashboard's denominator (boxCounts — dropped and
// moved out, leftovers in), for printing a fraction.
export function boxReport(body) {
  const steps = checkboxSteps(body);
  const settled = Object.fromEntries(Object.keys(SETTLED_KINDS).map((k) => [k, 0]));
  const pending = [];
  const leftovers = [];
  const afterMerge = [];
  let done = 0;
  for (const s of steps) {
    if (s.done) { done++; continue; }
    if (s.settled) {
      settled[s.settled]++;
      if (SETTLED_KINDS[s.settled].blocksDone) leftovers.push({ kind: s.settled, text: s.text });
      continue;
    }
    (s.afterMerge ? afterMerge : pending).push(s.text);
  }
  return { total: steps.length, counted: boxCounts(steps).totalCount, done, settled, pending, leftovers, afterMerge };
}

// Has the task's branch reached the default branch?
//   merged     — its tip is in <base> (local, or origin/<base>)
//   unmerged   — it carries commits <base> doesn't have
//   no-branch  — none recorded; merge says nothing about this task
//   no-commits — the branch never got a commit of its own (tip = where it was
//                created), so there is nothing to merge
//   unknown    — recorded, but the branch can't be found here
export function mergeState(branch, repoRoot) {
  if (!branch) return { state: 'no-branch', branch: null };
  if (!repoRoot) return { state: 'unknown', branch, detail: 'no repo to check against' };
  const base = defaultBranchSync(repoRoot);
  if (!base) return { state: 'unknown', branch, detail: 'no main/master branch' };
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)
    || git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repoRoot);
  if (!tip) return { state: 'unknown', branch, base, detail: `branch ${branch} not found` };
  // The reflog's oldest entry is where the branch was created. Tip still there →
  // no work was ever committed on it. (No reflog → skip this check.)
  const created = (git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], repoRoot) || '').split('\n').filter(Boolean).pop();
  if (created && created === tip) return { state: 'no-commits', branch, base };
  const bases = [base, `refs/remotes/origin/${base}`];
  for (const b of bases) {
    if (git(['rev-parse', '--verify', '--quiet', b], repoRoot) == null) continue;
    if (git(['merge-base', '--is-ancestor', tip, b], repoRoot) != null) return { state: 'merged', branch, base };
  }
  return { state: 'unmerged', branch, base };
}

export function claimState(env, me) {
  if (!env?.claimed_at) return { state: 'none' };
  const by = env.claimed_by || null;
  // A claim with no name predates claimed_by (single-user stores) — it's the owner's.
  if (!by || (me && by === me)) return { state: 'yours', by, session: env.claimed_by_session || null };
  return { state: 'other', by, session: env.claimed_by_session || null };
}

const short = (t) => (t.length > 90 ? t.slice(0, 87) + '…' : t);

// The whole verdict. opts: { repoRoot, me, markerProblems }.
//   markerProblems — the task file's badly written checkbox markers (validator
//   errors, markerProblemsFor below; task 238). Each blocks DONE and ENOUGH
//   alike: a misspelt or retired marker means the box is read wrong.
//   suggest — what `tasks doctor` lists: everything holds AND there are boxes.
//   done / enough — can a plain `close` / `close --enough` go ahead, and if
//   not, every reason why (the command prints them; `--force` overrides all
//   but an already-closed status).
export function closeability(task, { repoRoot = null, me = null, markerProblems = [] } = {}) {
  const fm = task.frontmatter || {};
  const status = fm.status || null;
  const boxes = boxReport(task.body || '');
  const merge = mergeState(fm.env?.branch || null, repoRoot);
  const claim = claimState(fm.env, me);

  // A live park (task 244): status PARKED, or the text's `> **PARKED …**` note.
  // A closed task keeps only an ended record, so this refuses even `--force`
  // (cmdClose checks `parkLive` before the overrides); `unpark` is the way out.
  // It used to read "close takes an OPEN task", and a chat set the status to
  // OPEN by hand to get past it, leaving the note live (task 244's story).
  const parkNotes = liveParkNotes(task.body || '');
  const parkLive = !isClosed(status) && (status === 'PARKED' || parkNotes.length > 0);
  const id = fm.id ?? '<id>';
  const parkReason = !parkLive ? null
    : `${status === 'PARKED' ? 'status is PARKED' : 'its text still has a live park note'}${parkNotes.length ? ` ("${describePark(parkNotes[0])}")` : ''} — `
      + `a parked task is un-parked before it closes: \`cogyard tasks unpark ${id} "<what was seen that ends the wait>"\`, then close it`;

  const shared = [];
  if (isClosed(status)) shared.push(`already ${status}`);
  else if (parkReason) shared.push(parkReason);
  else if (status !== 'OPEN') shared.push(`status is ${status || 'missing'} — close takes an OPEN task`);
  if (merge.state === 'unmerged') shared.push(`branch ${merge.branch} is not merged into ${merge.base}`);
  if (merge.state === 'unknown') shared.push(`can't tell whether ${merge.branch} merged (${merge.detail})`);
  if (claim.state === 'other') shared.push(`claimed by ${claim.by}`);
  if (markerProblems.length) shared.push(`${markerProblems.length} badly written checkbox marker(s) — fix each first (choosing what a box becomes is the owner's decision):\n${markerProblems.map((p) => `      - ${p}`).join('\n')}`);

  const done = [...shared];
  if (boxes.afterMerge.length) done.push(`${boxes.afterMerge.length} check(s) waiting on the merge — run them against the merged code, tick each with what you saw, then close again:\n${boxes.afterMerge.map((t) => `      - [ ] (after merge) ${short(t)}`).join('\n')}`);
  if (boxes.pending.length) done.push(`${boxes.pending.length} box(es) still open:\n${boxes.pending.map((t) => `      - [ ] ${short(t)}`).join('\n')}`);
  if (boxes.leftovers.length) done.push(`${boxes.leftovers.length} box(es) left behind (optional) — a DONE task has nothing left; close with --enough:\n${boxes.leftovers.map((l) => `      - [ ] (${l.kind}) ${short(l.text)}`).join('\n')}`);
  // Nothing but after-merge checks stands in the way: the agent's work, not a
  // question for the owner (task 232).
  const onlyAfterMerge = boxes.afterMerge.length > 0 && done.length === 1;

  return {
    status, boxes, merge, claim,
    done: { ok: done.length === 0, reasons: done, onlyAfterMerge },
    enough: { ok: shared.length === 0, reasons: shared },
    alreadyClosed: isClosed(status),
    park: { live: parkLive, notes: parkNotes, reason: parkReason },
    suggest: done.length === 0 && boxes.total > 0,
  };
}

// The task's text states its status a second time, in a `> **Status: X.**` line
// under the title (the write-task template writes one). Nothing reads it, so a
// close that changed only the frontmatter left the file contradicting itself —
// and a contradiction invites a hand edit (task 228). `close` and `reopen` call
// this to rewrite the status WORD in the first such line; the rest of the
// sentence is the author's and is left alone. No such line → body unchanged.
// Pure text in, text out — this module still writes nothing.
export function rewriteStatusLine(body, status) {
  return body.replace(/^(>\s*\*\*Status:\s*)([A-Z][A-Z_]*)/m, (_, lead) => `${lead}${status}`);
}

// Every OPEN task, in every registered project, that looks ready to close — what
// `tasks doctor` lists. READS ONLY: listing a task never changes it; the owner
// closes it with `cogyard tasks close <id>`. The box check runs first and is
// pure text, so git (the merge check) only runs for the few that pass it.
// Returns [{ slug, path, id, title, file, boxes, merge }].
export function closeableTasks({ projects = readRegistry(), me = whoAmI() } = {}) {
  const out = [];
  for (const proj of projects) {
    const dir = tasksDirOf(proj.path);
    if (!existsSync(dir)) continue;
    let tasks;
    try { tasks = loadTasks(dir); } catch { continue; }
    let problems = null;
    for (const t of tasks) {
      if (t.frontmatter?.status !== 'OPEN') continue;
      const b = boxReport(t.body || '');
      if (!b.total || b.pending.length || b.leftovers.length || b.afterMerge.length) continue;
      problems ||= markerProblemsByFile(tasks);
      const v = closeability(t, { repoRoot: proj.path, me, markerProblems: problems.get(basename(t.path)) || [] });
      if (!v.suggest) continue;
      out.push({ slug: proj.slug, path: proj.path, id: t.frontmatter.id, title: t.frontmatter.title || '', file: t.path, boxes: v.boxes, merge: v.merge });
    }
  }
  return out;
}

// The badly written checkbox markers in a project's task files (task 238):
// the validator's `checkbox …` errors, checked against the whole project so a
// `(moved: <id>)` to a missing task counts. Map<filename, string[]>.
export function markerProblemsByFile(tasks) {
  const out = new Map();
  for (const r of validateTasks(tasks).results) {
    const p = r.errors.filter(isBoxMarkerProblem);
    if (p.length) out.set(r.file, p);
  }
  return out;
}

// A box settled in PROSE before the markers existed (task 238): "→ MOVED to
// task 050", "Deferred (owner's call)", "OBSOLETE (…)", "Optional: …". Returns
// the marker the text already says, { kind, arg }, or null when it says nothing
// a reader could act on. A proposal only — `tasks doctor` prints it and the
// owner decides; nothing here writes a file. Phrases at the start of the box
// win over phrases further in. "Deferred" — and the retired `(deferred)`
// marker — reads as (optional): left behind, unless it names the task that
// took it ("deferred to task 017" is moved).
// `ids` (optional) is the project's task ids: a move to a task that doesn't
// exist proposes nothing, because validate would flag the marker.
const cleanReason = (s) => {
  const r = String(s || '').replace(/[()\n]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.;,:—-]+$/, '');
  return r.length <= 80 ? r : r.slice(0, 80).replace(/\s+\S*$/, '') + '…';
};
export function proseSettled(text, ids = null) {
  const t = String(text || '').replace(/[*`]/g, '').trim();
  const known = (id) => !ids || ids.has(Number(id));
  // moved — to a task that holds the work (the id kept as the text wrote it)
  const mv = t.match(/^\(?→\s*(\d+[a-z]?)\)/)
    || t.match(/\b(?:moved|carried|tracked|deferred)\s+(?:to|by|in)\s+\[?task\s+(\d+[a-z]?)\b/i);
  if (mv && known(parseInt(mv[1], 10))) return { kind: 'moved', arg: mv[1] };
  const start = t.replace(/^→\s*/, '');
  // dropped — said at the start, or as an all-caps word further in
  let m = start.match(/^(OBSOLETE|DROPPED|Skipped|Won'?t do)\b[\s:—-]*(?:\(([^)]*)\))?/i);
  if (m) return { kind: 'dropped', arg: cleanReason(m[2]) || m[1].toLowerCase() };
  if (/^\(?(?:deferred|optional)\b/i.test(start)) return { kind: 'optional', arg: null };
  m = t.match(/\b(DROPPED|OBSOLETE)\b\s*(?:\(([^)]*)\))?/);
  if (m) return { kind: 'dropped', arg: cleanReason(m[2]) || m[1].toLowerCase() };
  if (/\(out of scope\)/i.test(t)) return { kind: 'dropped', arg: 'out of scope' };
  m = t.match(/\(moved to (?!task)([^)]+)\)/i);
  if (m) return { kind: 'dropped', arg: `moved to ${cleanReason(m[1])}` };
  if (/\bDEFERRED\b/.test(t) || /[.;—]\s\s*Deferred\b/.test(t) || /\(\s*deferred\b/i.test(t)) return { kind: 'optional', arg: null };
  if (/\(optional\b/i.test(t) || /\s[-–—]\s*optional\b/i.test(t)) return { kind: 'optional', arg: null };
  return null;
}
export const markerText = ({ kind, arg }) => `(${kind}${arg ? `: ${arg}` : ''})`;

// Every DONE task, in every registered project, that still holds an open box —
// unmarked or `(optional)` (task 238). DONE means nothing is left to see;
// leftovers belong to ENOUGH, so an ENOUGH task holding them is fine and isn't
// listed. What `tasks doctor` lists. READS ONLY.
// Returns [{ slug, path, id, title, file, open: [{ text, kind, proposal }] }]:
// `kind` is the box's leftover marker ('optional') or null when it has none; `proposal` (unmarked boxes only) is proseSettled's reading, or null.
export function doneWithLeftovers({ projects = readRegistry() } = {}) {
  const out = [];
  for (const proj of projects) {
    const dir = tasksDirOf(proj.path);
    if (!existsSync(dir)) continue;
    let tasks;
    try { tasks = loadTasks(dir); } catch { continue; }
    const ids = new Set(tasks.map((t) => parseInt(t.frontmatter?.id, 10)).filter((n) => !Number.isNaN(n)));
    for (const t of tasks) {
      const fm = t.frontmatter || {};
      if (fm.status !== 'DONE') continue;
      const open = checkboxSteps(t.body || '').filter((s) => !s.done && (!s.settled || SETTLED_KINDS[s.settled].blocksDone))
        .map((s) => ({ text: s.text, kind: s.settled, proposal: s.settled ? null : proseSettled(s.text, ids) }));
      if (open.length) out.push({ slug: proj.slug, path: proj.path, id: fm.id, title: fm.title || '', file: t.path, open });
    }
  }
  return out;
}
