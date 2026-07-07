// core/validate.mjs — frontmatter schema validator for v2 task files. Pure logic
// over already-loaded tasks (no fs/git); the CLI loads tasks and calls in.
//
// Catches drift the loose YAML can't: bad/typo'd status values, id↔filename
// mismatch, array fields that parsed as scalars, done_date that disagrees with
// status, duplicate ids, and dangling depends_on. Returns issues with severity —
// it never throws on malformed input (that IS the thing it reports).

import { basename } from 'node:path';
import { STATUSES, isValidStatus, hasDoneDate, CATEGORIES, isValidCategory } from './status.mjs';

// Top-level fields expected on a v2 task. Missing → warning (soft: older files
// predate some fields); present-but-wrong-shape → error.
// `labels` is array-shaped but OPTIONAL and OPEN — listed here only so a
// scalar `labels: foo` is caught as a shape error; its absence is never flagged.
const ARRAY_FIELDS = ['depends_on', 'related', 'touches_paths', 'out_of_scope', 'coordination', 'labels'];
const RECOMMENDED = ['id', 'slug', 'title', 'status', 'created', 'created_at_commit',
  'last_reviewed_at_commit', 'last_touched_commit', 'depends_on', 'related', 'touches_paths'];

// Task ids are `NNN`, `NNN.M` (sub-task; stored as `NNN_M`), or `NNNx` (letter
// suffix), optionally zero-padded in the filename. Canonicalize so all spellings
// of the same id compare equal: 032→"32", 013.5/013_5→"13.5", 07s→"7s".
function normId(s) {
  if (s == null) return null;
  const m = String(s).match(/^(\d+)(?:[._](\d+))?([a-z])?$/);
  if (!m) return null;
  return `${Number(m[1])}${m[2] != null ? '.' + Number(m[2]) : ''}${m[3] || ''}`;
}
function filenameIdToken(file) {
  const m = file.match(/^(\d+(?:\.\d+)?[a-z]?)/);
  return m ? normId(m[1]) : null;
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

  // category — required, closed enum. Orthogonal to status: status is
  // lifecycle, category is kind. Required (error if missing/invalid); `labels` by
  // contrast is open and optional, so it is never required here.
  if (fm.category == null) err(`category: missing (required — one of ${CATEGORIES.join(' | ')})`);
  else if (!isValidCategory(fm.category)) err(`category: "${fm.category}" not one of ${CATEGORIES.join(' | ')}`);

  // id — present, well-formed, and matching the filename prefix.
  const fnId = filenameIdToken(file);
  const fmId = normId(fm.id);
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

  // dangling dependencies — referenced id has no task file.
  if (Array.isArray(fm.depends_on) && ctx.allIds) {
    for (const d of fm.depends_on) {
      if (d != null && !ctx.allIds.has(normId(d))) warn(`depends_on: ${d} has no matching task`);
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

// Validate a whole project's loaded tasks. Pure: caller provides the array.
// Returns { results:[{file,errors,warnings}], errorCount, warningCount }.
export function validateTasks(tasks) {
  const idCounts = new Map();
  const allIds = new Set();
  for (const t of tasks) {
    // Index by canonical id (frontmatter preferred, else the filename token) so
    // dup-detection and dangling-dep checks compare ids the same way regardless
    // of zero-padding or `.`/`_` sub-task spelling.
    const id = normId(t.frontmatter?.id) || filenameIdToken(basename(t.path));
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
