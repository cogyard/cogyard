// core/validate.mjs — frontmatter schema validator for v2 task files. Pure logic
// over already-loaded tasks (no fs/git); the CLI loads tasks and calls in.
//
// Catches drift the loose YAML can't: bad/typo'd status values, id↔filename
// mismatch, array fields that parsed as scalars, done_date that disagrees with
// status, duplicate ids, and dangling depends_on. Returns issues with severity —
// it never throws on malformed input (that IS the thing it reports).

import { basename } from 'node:path';
import { STATUSES, isValidStatus, isOpen, hasDoneDate, TYPES, isValidType, OWNER_STEP_KINDS, isOwnerStepKind, SETTLED_KINDS, SETTLED_KIND_NAMES, RETIRED_SETTLED_KINDS, isSettledKind, AFTER_MERGE_MARK_RE, AFTER_MERGE_NEAR_RE, blankCodeBlocks } from './status.mjs';

// Levenshtein distance — for "did you mean (dropped)?" on a misspelt marker word.
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// Top-level fields expected on a v2 task. Missing → warning (soft: older files
// predate some fields); present-but-wrong-shape → error.
// `labels` is array-shaped but OPTIONAL and OPEN — listed here only so a
// scalar `labels: foo` is caught as a shape error; its absence is never flagged.
const ARRAY_FIELDS = ['depends_on', 'related', 'touches_paths', 'out_of_scope', 'resources', 'labels'];
// `resources` (task 239): live things a task uses that aren't files — a
// production database, a deployed function, DNS, a device. Two tasks naming the
// same one shouldn't run at once. Short names so two tasks spell one the same.
const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Retired by task 239: order is depends_on; running in parallel is
// touches_paths + resources; advice on editing alongside goes in the body.
const RETIRED_FIELDS = {
  coordination: 'retired — a "must finish first" rule goes in depends_on, a shared live thing in resources, advice on editing alongside another task in the body (Branch strategy)',
  parallel_safe: 'retired — name what the task holds in resources instead (e.g. prod-db), so only tasks using the same thing are kept apart',
};
const RECOMMENDED = ['id', 'slug', 'title', 'status', 'created', 'created_at_commit',
  'last_reviewed_at_commit', 'last_touched_commit', 'depends_on', 'related', 'touches_paths'];

// Task ids are `NNN`, `NNN.M` (sub-task; stored as `NNN_M`), or `NNNx` (letter
// suffix), optionally zero-padded in the filename. Canonicalize so all spellings
// of the same id compare equal: 032→"32", 013.5/013_5→"13.5", 07s→"7s".
// Exported because id equality is NOT a validator-only concern: stores disagree
// on padding (some write `id: 33`, some `id: 033`), so every id→task lookup has
// to compare through this or a leading zero decides whether the lookup succeeds.
export function normalizeTaskId(s) {
  if (s == null) return null;
  const m = String(s).match(/^(\d+)(?:[._](\d+))?([a-z])?$/);
  if (!m) return null;
  return `${Number(m[1])}${m[2] != null ? '.' + Number(m[2]) : ''}${m[3] || ''}`;
}
function filenameIdToken(file) {
  const m = file.match(/^(\d+(?:\.\d+)?[a-z]?)/);
  return m ? normalizeTaskId(m[1]) : null;
}
function filenameSlug(file) {
  return file.replace(/^\d+(?:\.\d+)?[a-z]?-/, '').replace(/\.md$/, '');
}

// Validate one task against the schema. ctx.idCounts: Map<id, count> for dup
// detection; ctx.allIds: Set<number> for dangling-dep detection. Returns
// { file, errors:[], warnings:[] }.
export function validateTask(task, ctx = {}) {
  const file = basename(task.path);
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!task.hasFrontmatter) {
    if (task.parseError) err(`frontmatter failed to parse: ${task.parseError}`);
    else warn('no frontmatter (backfill candidate)');
    return { file, errors, warnings };
  }
  const fm = task.frontmatter || {};

  // status — the core drift check.
  if (fm.status == null) err('status: missing');
  else if (!isValidStatus(fm.status)) err(`status: "${fm.status}" not one of ${STATUSES.join(' | ')}`);

  // type — required, closed enum. Orthogonal to status: status is lifecycle,
  // type is kind. Required (error if missing/invalid); `labels` by contrast is
  // open and optional, so it is never required here. `fm.type` is populated from
  // a legacy `category:` key at parse time (core/frontmatter.mjs), so old files
  // that predate the task-096 rename still validate.
  if (fm.type == null) err(`type: missing (required — one of ${TYPES.join(' | ')})`);
  else if (!isValidType(fm.type)) err(`type: "${fm.type}" not one of ${TYPES.join(' | ')}`);

  // id — present, well-formed, and matching the filename prefix.
  const fnId = filenameIdToken(file);
  const fmId = normalizeTaskId(fm.id);
  if (fm.id == null) err('id: missing');
  else if (fmId == null) err(`id: "${fm.id}" is not a valid id (expected NNN, NNN.M, or NNNx)`);
  else if (fnId != null && fmId !== fnId) err(`id: "${fm.id}" disagrees with filename (${fnId})`);

  // slug — cosmetic; mismatch is a warning.
  if (fm.slug == null) warn('slug: missing');
  else if (fm.slug !== filenameSlug(file)) warn(`slug: "${fm.slug}" disagrees with filename ("${filenameSlug(file)}")`);

  // array-shaped fields must not have parsed to a scalar/object.
  for (const f of ARRAY_FIELDS) {
    if (fm[f] != null && !Array.isArray(fm[f])) err(`${f}: expected a list, got ${typeof fm[f]} (${JSON.stringify(fm[f])})`);
  }

  // done_date must agree with status: DONE/ENOUGH carry one; nothing else should.
  if (fm.status != null && isValidStatus(fm.status)) {
    const hasDate = fm.done_date != null && fm.done_date !== '';
    if (hasDoneDate(fm.status) && !hasDate) warn(`done_date: missing for ${fm.status}`);
    if (!hasDoneDate(fm.status) && hasDate) warn(`done_date: set ("${fm.done_date}") but status ${fm.status} is not a finished state`);
  }

  // A claim is valid only on an OPEN task (owner, 2026-11-06, task 222): a
  // reopened task is OPEN again, so the plan places it ("In progress" when
  // claimed, "Can start" when not) and nothing closed or parked is ever
  // held. An ERROR, so `validate` exits 1, doctor counts it, the Tasks tab
  // flags it, and the write hook and `sync push` refuse a NEW one — e.g. a hand
  // edit that parks or obsoletes a claimed task.
  const claimedAt = fm.env?.claimed_at;
  if (claimedAt != null && claimedAt !== '' && claimedAt !== 'null' && fm.status != null && fm.status !== 'OPEN') {
    const fix = hasDoneDate(fm.status)
      ? `reopen it (\`cogyard tasks reopen ${fm.id ?? '<id>'} --why "…"\`) if work continues, else release the claim (\`cogyard env release <file>\`)`
      : 'release the claim (`cogyard env release <file>`), or set it back to OPEN if it is being worked';
    err(`env.claimed_at: claimed (since ${String(claimedAt).slice(0, 10)}${fm.env?.claimed_by ? ` by ${fm.env.claimed_by}` : ''}) but status is ${fm.status} — a claim is valid only on an OPEN task; ${fix}`);
  }

  // touches_paths names FILES (task 179): the Plan tab works out which tasks can
  // run side by side from them, and a whole top-level folder says nothing about
  // which files — the task shows as "files unknown". A warning, so old files pass.
  if (Array.isArray(fm.touches_paths)) {
    for (const p of fm.touches_paths) {
      if (typeof p === 'string' && /^[^/~]+\/$/.test(p.trim())) warn(`touches_paths: "${p}" is a whole top-level folder — list the files instead, or the Plan tab can't tell what this task clashes with`);
    }
  }

  if (Array.isArray(fm.resources)) {
    for (const r of fm.resources) {
      if (typeof r !== 'string' || !RESOURCE_NAME.test(r)) err(`resources: ${JSON.stringify(r)} is not a short name — lowercase words joined by "-", e.g. prod-db, app-store-submission`);
    }
  }
  // A retired field on a task still in play (OPEN / PARKED) is a warning; a
  // closed task keeps its fields as history, so it is never flagged.
  if (fm.status != null && isOpen(fm.status)) {
    for (const [f, why] of Object.entries(RETIRED_FIELDS)) if (f in fm) warn(`${f}: ${why}`);
  }

  // Checkbox markers (tasks 171, 179, 232, 238) — `(you: …)`, `(dropped: why)`,
  // `(moved: <id>)`, `(optional)`, `(after merge)`. `tasks close`, the progress
  // fraction and `/merge-to-main` read these words, so a box with a misspelt,
  // retired or incomplete marker silently means something else. Each problem
  // is an ERROR (owner, 2026-10-30, task 238: "I need something to call these
  // out so tasks are written properly"; they were warnings, and three retired
  // `(deferred)` boxes went unnoticed): `validate` exits 1, `doctor` names the
  // file, the portal flags it, `close` refuses, and the write hook refuses a
  // NEW one while a file's existing ones stay editable. Every message says
  // what to write instead. All start with `checkbox ` — isBoxMarkerProblem.
  const boxErr = err;

  // Owner steps (task 179): a checkbox marked `(you: <kind>)` must say what
  // for, from the closed list.
  for (const m of blankCodeBlocks(task.body).matchAll(/^[ \t]*[-*]\s+\[[^\]]*\][ \t]?\(you(?::\s*([^)]*))?\)/gim)) {
    const kinds = String(m[1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const bad = kinds.filter((k) => !isOwnerStepKind(k));
    if (!kinds.length) boxErr(`checkbox "(you)" — say what for: (you: ${OWNER_STEP_KINDS.join(' | ')})`);
    else if (bad.length) boxErr(`checkbox "(you: ${kinds.join(', ')})" — ${bad.map((b) => `"${b}"`).join(', ')} not one of ${OWNER_STEP_KINDS.join(' | ')}; put a note after the marker, not inside it`);
  }

  // Settled boxes (task 171): `(dropped: why)`, `(moved: <id>)`, `(optional)`
  // — core/status.mjs SETTLED_KINDS. A leading parenthesis is ordinary prose
  // too ("(UI) tidy the header"), so an unknown word is flagged only when it is
  // a near-miss of a real one — or a retired word (`(deferred)`, task 238).
  for (const m of blankCodeBlocks(task.body).matchAll(/^[ \t]*[-*]\s+\[ ?\][ \t]?(?:\((?:you(?::[^)]*)?|after merge)\)\s*){0,2}\(([A-Za-z]+)(?::\s*([^)]*))?\)/gim)) {
    const word = m[1].toLowerCase();
    const arg = m[2] != null ? m[2].trim() : '';
    if (Object.prototype.hasOwnProperty.call(RETIRED_SETTLED_KINDS, word)) {
      boxErr(`checkbox "(${m[1]})" — that word is retired: ${RETIRED_SETTLED_KINDS[word]}`);
      continue;
    }
    if (!isSettledKind(word)) {
      const near = word.length >= 4 && SETTLED_KIND_NAMES.find((k) => editDistance(word, k) <= 2);
      if (near) boxErr(`checkbox "(${m[1]}…)" — did you mean (${near})? Settled-box words: ${SETTLED_KIND_NAMES.join(' | ')}`);
      continue;
    }
    if (word === 'dropped' && !arg) boxErr('checkbox "(dropped)" — say why: (dropped: <reason>)');
    if (SETTLED_KINDS[word].needsTarget) {
      if (!arg) { boxErr(`checkbox "(${word})" — say where: (${word}: <id>) or (${word}: <project-slug>#<id>)`); continue; }
      const cross = arg.match(/^([A-Za-z0-9._-]+)#(.*)$/);
      if (cross) { if (normalizeTaskId(cross[2].replace(/^#/, '')) == null) boxErr(`checkbox "(${word}: ${arg})" — expected <project-slug>#<id>`); continue; }
      const id = normalizeTaskId(arg.replace(/^(?:task\s*)?#?/i, ''));
      if (id == null) boxErr(`checkbox "(${word}: ${arg})" — expected a task id, e.g. (${word}: 050)`);
      else if (ctx.allIds && !ctx.allIds.has(id)) boxErr(`checkbox "(${word}: ${arg})" — no task ${arg} in this project; file that task first`);
    }
  }

  // After-merge checks (task 232): the words are fixed, `(after merge)`. A
  // near-miss like `(post-merge)` reads as an ordinary open box, so `close` and
  // `/merge-to-main` would not know to run it.
  for (const m of blankCodeBlocks(task.body).matchAll(/^[ \t]*[-*]\s+\[[^\]]*\][ \t]?((?:\([^)]*\)\s*)+)/gm)) {
    for (const p of m[1].match(/\([^)]*\)/g) || []) {
      if (AFTER_MERGE_NEAR_RE.test(p) && !AFTER_MERGE_MARK_RE.test(p)) boxErr(`checkbox "${p}" — write it as (after merge)`);
    }
  }

  // dangling dependencies — referenced id has no task file. A cross-project dep
  // (`<slug>#<id>`, task 179) lives in another store: checked for shape only
  // here (this module reads no files); it resolves through the registry when
  // derived state is computed.
  if (Array.isArray(fm.depends_on) && ctx.allIds) {
    for (const d of fm.depends_on) {
      if (d == null) continue;
      const cross = String(d).match(/^([A-Za-z0-9._-]+)#(.*)$/);
      if (cross) { if (normalizeTaskId(cross[2]) == null) err(`depends_on: "${d}" — expected <project-slug>#<id>`); continue; }
      if (!ctx.allIds.has(normalizeTaskId(d))) warn(`depends_on: ${d} has no matching task`);
    }
  }

  // duplicate id across the project.
  if (fmId != null && ctx.idCounts && ctx.idCounts.get(fmId) > 1) {
    err(`id: "${fm.id}" is used by ${ctx.idCounts.get(fmId)} files`);
  }

  // recommended fields present (soft).
  for (const f of RECOMMENDED) {
    if (!(f in fm)) warn(`${f}: missing (recommended)`);
  }

  return { file, errors, warnings };
}

// A validator error about a checkbox marker (they all start `checkbox `) — what
// `tasks close` refuses over (task 238).
export const isBoxMarkerProblem = (m) => String(m).startsWith('checkbox ');

// The ONE regression rule (task 222) — the Edit/Write hook and `sync push`
// both apply it: a new version of a task file may not carry MORE errors than
// the version it replaces, checked against the rest of the project (so
// duplicate ids and `(moved: <id>)` targets count). Existing errors pass, so an
// old file can always be edited toward correct; a brand-new file (before =
// null) must be clean. Returns the introduced errors, [] when it passes.
export function introducedErrors(siblings, before, after) {
  const errorsOf = (t) => {
    if (!t) return [];
    const r = validateTasks([...siblings, t]).results.find((x) => x.file === basename(t.path));
    return r ? r.errors : [];
  };
  const was = errorsOf(before), now = errorsOf(after);
  if (now.length <= was.length) return [];
  const seen = new Set(was);
  const added = now.filter((e) => !seen.has(e));
  return added.length ? added : now;
}

// Validate a whole project's loaded tasks. Pure: caller provides the array.
// Returns { results:[{file,errors,warnings}], errorCount, warningCount }.
export function validateTasks(tasks) {
  const idCounts = new Map();
  const allIds = new Set();
  for (const t of tasks) {
    // Index by canonical id (frontmatter preferred, else the filename token) so
    // dup-detection and dangling-dep checks compare ids the same way regardless
    // of zero-padding or `.`/`_` sub-task spelling.
    const id = normalizeTaskId(t.frontmatter?.id) || filenameIdToken(basename(t.path));
    if (id != null) {
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
      allIds.add(id);
    }
  }
  const ctx = { idCounts, allIds };
  const results = tasks.map((t) => validateTask(t, ctx));
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) { errorCount += r.errors.length; warningCount += r.warnings.length; }
  return { results, errorCount, warningCount };
}
