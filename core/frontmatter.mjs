// core/frontmatter.mjs — restricted YAML frontmatter parser (scalars, nested
// objects, arrays), task-file reading, and per-task derived state.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tryExec } from './exec.mjs';
import { readRegistry } from './registry.mjs';
import { isClosed, satisfiesDeps, SETTLED_KINDS, SETTLED_KIND_NAMES, AFTER_MERGE_MARK_RE, CHECKED_MARK_RE, blankCodeBlocks } from './status.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { withLocalClaim } from './claims.mjs';

// Strip a trailing YAML-style inline comment ("  # ...") from a line.
// A '#' starts a comment only when preceded by whitespace (or start of line)
// and is NOT inside a quoted string. Conservative: bail to original line if
// the scan looks ambiguous.
function stripInlineComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && (inSingle || inDouble)) { i++; continue; }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(s[i - 1])) return s.slice(0, i).replace(/\s+$/, '');
    }
  }
  return s;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  // Quoted values follow YAML's own rules, so a title written
  // `"\"Write by hand\" textarea…"` reads `"Write by hand" textarea…` — not with
  // the backslashes left in (they showed on Plan cards). Double quotes take
  // backslash escapes; single quotes only double a quote (`'it''s'` → it's).
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const ESC = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' };
    return s.slice(1, -1).replace(/\\(.)/g, (whole, c) => ESC[c] ?? whole);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseFrontmatter(text) {
  const lines = text.split('\n');
  const root = {};
  const stack = [{ obj: root, indent: -1, key: null, isArray: false }];

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // Strip inline YAML comments: " # comment" at end of line, only when the
    // '#' is preceded by whitespace and is NOT inside quotes. Without this,
    // a line like `depends_on: []  # note` parses the comment as part of the
    // value and crashes downstream code that expects an array.
    raw = stripInlineComment(raw);
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trimStart();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (line.startsWith('- ')) {
      const value = parseScalar(line.slice(2));
      if (Array.isArray(top.obj)) top.obj.push(value);
      else if (top.key) {
        if (!Array.isArray(top.obj[top.key])) top.obj[top.key] = [];
        top.obj[top.key].push(value);
      }
      continue;
    }

    const m = line.match(/^([A-Za-z_][\w.-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];

    if (rest === '') {
      let isArray = false;
      for (let j = i + 1; j < lines.length; j++) {
        const peek = lines[j];
        if (!peek.trim()) continue;
        const peekIndent = peek.length - peek.trimStart().length;
        if (peekIndent > indent) isArray = peek.trimStart().startsWith('- ');
        break;
      }
      const child = isArray ? [] : {};
      if (Array.isArray(top.obj)) top.obj.push({ [key]: child });
      else top.obj[key] = child;
      stack.push({ obj: child, indent, key: isArray ? null : key, isArray });
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      const items = inner ? inner.split(',').map((s) => parseScalar(s.trim())) : [];
      if (Array.isArray(top.obj)) top.obj.push({ [key]: items });
      else top.obj[key] = items;
    } else {
      const v = parseScalar(rest);
      if (Array.isArray(top.obj)) top.obj.push({ [key]: v });
      else top.obj[key] = v;
    }
  }
  return root;
}

function readTaskFile(path) {
  return taskFromContent(path, readFileSync(path, 'utf8'));
}

// The same, from a content STRING — a version of a task file that is not (or
// not only) on disk: the staged or committed one `sync push` compares (task 222).
function taskFromContent(path, content) {
  if (!content.startsWith('---\n')) return { path, frontmatter: null, body: content, hasFrontmatter: false };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { path, frontmatter: null, body: content, hasFrontmatter: false };
  const fmText = content.slice(4, end);
  const body = content.slice(end + 5);
  let fm;
  try { fm = parseFrontmatter(fmText); }
  catch (e) { return { path, frontmatter: null, body, hasFrontmatter: false, parseError: e.message }; }
  // Legacy alias (task 096): the task-kind enum was `category`, now `type`. Old
  // files still carry `category:`; canonicalize to `type` here — the single place
  // that reads `category` — so every downstream consumer (validator, wire `fm`,
  // portal, INDEX) sees one field and no mass task-file rewrite is forced.
  if (fm && typeof fm === 'object' && !Array.isArray(fm) && fm.type == null && fm.category != null) fm.type = fm.category;
  // Task 190: `env.worktree` and `env.claimed_by_session` are this machine's
  // business and live in $COGYARD_HOME/claims.json, not the shared file —
  // laid over here, the one place every reader loads tasks through.
  withLocalClaim(path, fm);
  return { path, frontmatter: fm, body, hasFrontmatter: true };
}

function listTaskFiles(tasksDir) {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => /^\d/.test(f) && f.endsWith('.md'))
    .map((f) => join(tasksDir, f))
    .filter((p) => statSync(p).isFile());
}

function loadTasks(tasksDir) { return listTaskFiles(tasksDir).map(readTaskFile); }

// Status of task <id> in the registered project <slug> — how a cross-project
// `depends_on: [<slug>#<id>]` resolves (task 179). null when the project or task
// can't be found, which reads as unmet: a dangling dep blocks, same as a local
// one. Cached per task file and re-read when the file changes, because the
// portal process is long-lived and a dependency closing must show.
const crossCache = new Map(); // '<slug>#<id>' → { path, mtimeMs, status }
function crossDepStatus(slug, id) {
  const key = `${slug}#${id}`;
  const hit = crossCache.get(key);
  if (hit) {
    try { if (statSync(hit.path).mtimeMs === hit.mtimeMs) return hit.status; } catch { /* moved or gone — look again */ }
  }
  const proj = readRegistry().find((p) => p.slug === slug);
  if (!proj) return null;
  const file = listTaskFiles(tasksDirOf(proj.path)).find((p) => new RegExp(`^0*${id}[-.]`).test(basename(p)));
  if (!file) return null;
  try {
    const status = readTaskFile(file).frontmatter?.status ?? null;
    crossCache.set(key, { path: file, mtimeMs: statSync(file).mtimeMs, status });
    return status;
  } catch { return null; }
}

// A checkbox only the OWNER can do (task 179) carries a marker at the start of
// its text:  `- [ ] (you: credential) Log in to the machine Cloudflare account`.
// The need lives on the STEP, not the task, so it clears itself the moment the
// box is ticked, and a task is autopilot work up to the first marked box.
// Kinds: core/status.mjs OWNER_STEP_KINDS.
//
// An unticked box can also be SETTLED (task 171): `(dropped: why)`, `(moved: 050)`,
// `(optional)`, or text opening with ~~strikethrough~~ (= dropped,
// no reason). Kinds and what each means for closing: core/status.mjs
// SETTLED_KINDS. And a box can wait on the merge (task 232): `(after merge)`,
// the agent's own check that only runs once the branch is on main
// (core/status.mjs AFTER_MERGE_MARK_RE). The markers may come in any order.
//
// Returns every ticked/unticked box in document order:
//   { done, owner: kinds[] | null, settled: kind | null, settledArg: string | null, afterMerge: bool, text, line }
// `line` is the box's 0-based line in `body` (the Plan card's tick times read
// `git blame` by it, task 251).
// `settled` is only ever set on an unticked box — a ticked box is done, whatever it says.
// `afterMerge` is only set on an open box that is not settled — the one still to run.
const OWNER_MARK_RE = /^\(you(?::\s*([^)]*))?\)\s*/i;
const SETTLED_MARK_RE = new RegExp(`^\\((${SETTLED_KIND_NAMES.join('|')})(?::\\s*([^)]*))?\\)\\s*`, 'i');
function checkboxSteps(body) {
  const out = [];
  const text0 = blankCodeBlocks(body); // same line count as body: fenced lines are blanked, not removed
  let line = 0, seen = 0;
  for (const m of text0.matchAll(/^[ \t]*[-*]\s+\[([^\]]*)\][ \t]?(.*)$/gm)) {
    for (; seen < m.index; seen++) if (text0.charCodeAt(seen) === 10) line++;
    const inside = m[1];
    const open = inside === ' ' || inside === '';
    const done = !open && CHECKED_MARK_RE.test(inside.trim());
    if (!open && !done) continue; // `[?]`, `[wip]` — same "don't guess" rule as the count below
    let text = m[2];
    let owner = null;
    let settled = null;
    let settledArg = null;
    let afterMerge = false;
    for (let i = 0; i < 3; i++) {
      const om = owner ? null : text.match(OWNER_MARK_RE);
      if (om) { owner = String(om[1] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); text = text.slice(om[0].length); continue; }
      const sm = settled ? null : text.match(SETTLED_MARK_RE);
      if (sm) { settled = sm[1].toLowerCase(); settledArg = sm[2] != null && sm[2].trim() ? sm[2].trim() : null; text = text.slice(sm[0].length); continue; }
      const am = afterMerge ? null : text.match(AFTER_MERGE_MARK_RE);
      if (am) { afterMerge = true; text = text.slice(am[0].length); continue; }
      break;
    }
    text = text.trim();
    if (!settled && text.startsWith('~~')) settled = 'dropped';
    out.push({ done, owner, settled: done ? null : settled, settledArg: done ? null : settledArg, afterMerge: afterMerge && !done && !settled, text, line });
  }
  return out;
}

// The boxes that COUNT, in file order — checkboxSteps' boxes less the ones
// settled as dropped / moved: they are not work left, and `tasks close` doesn't
// wait on them. An `(optional)` box stays in as unfinished — a leftover that
// blocks a plain close (SETTLED_KINDS). The Plan card draws one square per box
// in this list (task 251), so its squares and boxCounts' total can't disagree.
function countedBoxes(steps) {
  return steps.filter((s) => s.done || !s.settled || SETTLED_KINDS[s.settled].blocksDone);
}

// The progress fraction over countedBoxes — the one count every surface shows
// (Tasks tab, Plan card, recently-done strip, doctor, analyze).
function boxCounts(steps) {
  const counted = countedBoxes(steps);
  return { checkedCount: counted.filter((s) => s.done).length, totalCount: counted.length };
}

function computeDerived(task, allTasks, repoRoot, staleOverride) {
  const fm = task.frontmatter || {};
  const status = fm.status || 'UNKNOWN';
  const body = task.body || '';
  // Progress = the boxes checkboxSteps reads — the one box reader, so the
  // dashboard fraction and `tasks close` (task 171) count the same boxes. Ticks
  // are tolerant (core/status.mjs CHECKED_MARK_RE); only a box at the start of a
  // list line counts, so `- [ ]` quoted in a table or code sample is not a box.
  // (Was its own regex, also matching mid-line — it over-counted 9 of 765 tasks.)
  // Settled boxes leave the total (boxCounts), so a task `tasks close` closed
  // on its settled boxes reads 20/20, not 20/26.
  const steps = checkboxSteps(body);
  const { checkedCount, totalCount } = boxCounts(steps);

  // Defensive: depends_on SHOULD be an array, but if the frontmatter parser
  // ever yields a scalar or object (e.g. due to a malformed YAML line), don't
  // crash the entire viewer — coerce to a single-element array.
  const rawDeps = fm.depends_on;
  const depsList = Array.isArray(rawDeps) ? rawDeps
                 : rawDeps == null ? []
                 : [rawDeps];
  // Which deps are unmet (not just whether) — the Waiting bucket's derived
  // "waiting on #N" reads this list. A dangling dep (no matching task) counts
  // as unmet, same as before.
  const unmetDeps = depsList.filter((depId) => {
    // `<slug>#<id>` (task 179): a task in ANOTHER project's store.
    const cross = String(depId).match(/^([A-Za-z0-9._-]+)#0*(\d+)$/);
    if (cross) return !satisfiesDeps(crossDepStatus(cross[1], Number(cross[2])));
    const dep = allTasks.find((t) => t.frontmatter && Number(t.frontmatter.id) === Number(depId));
    // ENOUGH counts as satisfied — the dep shipped; its leftovers don't block dependents.
    return !(dep && satisfiesDeps(dep.frontmatter.status));
  });
  const depsMet = unmetDeps.length === 0;

  const claimedAt = fm.env?.claimed_at || null;
  const claimedBy = fm.env?.claimed_by_session || null;
  const claimedByName = fm.env?.claimed_by || null; // human identity — who, not which session

  // Staleness: either use a precomputed value (the async server path prefetches
  // all of these in parallel via computeStaleMap — the slow part), or fall back
  // to a synchronous git call (the CLI path: INDEX gen, analyze).
  let stale = false;
  if (staleOverride !== undefined) {
    stale = !!staleOverride;
  } else if (!isClosed(status) && fm.last_reviewed_at_commit && fm.touches_paths && repoRoot) {
    // Closed tasks (DONE/ENOUGH/OBSOLETE) skip — staleness is noise on a closed task. Mirrors computeStaleMap.
    try {
      const paths = fm.touches_paths.filter((p) => !p.startsWith('~/')).join(' ');
      if (paths) {
        const cmd = `git log --oneline ${fm.last_reviewed_at_commit}..HEAD -- ${paths} 2>/dev/null | wc -l`;
        const count = Number(tryExec(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }) || 0);
        stale = count > 5;
      }
    } catch {}
  }

  // Owner steps (task 179): the unticked boxes marked `(you: …)`, and whether
  // the NEXT unticked box is one — i.e. the task is stopped on the owner now.
  // A settled box (task 171 — dropped, moved, …) is nobody's next step.
  const pending = steps.filter((s) => !s.done && !s.settled);
  const youOpen = pending.filter((s) => s.owner).map((s) => ({ kinds: s.owner, text: s.text }));
  const firstOpen = pending[0];
  const youNext = firstOpen && firstOpen.owner ? firstOpen.owner : null;

  const ready = status === 'OPEN' && depsMet && !claimedAt;
  return {
    status, checkedCount, totalCount,
    progressPct: totalCount > 0 ? Math.round((checkedCount / totalCount) * 100) : null,
    ready, stale, depsMet, unmetDeps,
    claimed: !!claimedAt, claimedAt, claimedBy, claimedByName,
    youOpen, youNext,
  };
}

// A task's category tags (task 227): its `labels` list, non-empty strings only.
// A scalar `labels: foo` is a shape error (core/validate.mjs) and reads as none.
function taskLabels(fm) {
  return Array.isArray(fm?.labels) ? fm.labels.filter((l) => typeof l === 'string' && l) : [];
}

export { stripInlineComment, parseScalar, parseFrontmatter, readTaskFile, taskFromContent, listTaskFiles, loadTasks, computeDerived, checkboxSteps, countedBoxes, boxCounts, taskLabels };
