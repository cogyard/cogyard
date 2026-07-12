// core/frontmatter.mjs — restricted YAML frontmatter parser (scalars, nested
// objects, arrays), task-file reading, and per-task derived state.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tryExec } from './exec.mjs';
import { isClosed, satisfiesDeps } from './status.mjs';

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
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
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
  const content = readFileSync(path, 'utf8');
  if (!content.startsWith('---\n')) return { path, frontmatter: null, body: content, hasFrontmatter: false };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { path, frontmatter: null, body: content, hasFrontmatter: false };
  const fmText = content.slice(4, end);
  const body = content.slice(end + 5);
  let fm;
  try { fm = parseFrontmatter(fmText); }
  catch (e) { return { path, frontmatter: null, body, hasFrontmatter: false, parseError: e.message }; }
  return { path, frontmatter: fm, body, hasFrontmatter: true };
}

function listTaskFiles(tasksDir) {
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => /^\d/.test(f) && f.endsWith('.md') && f !== 'INDEX.md')
    .map((f) => join(tasksDir, f))
    .filter((p) => statSync(p).isFile());
}

function loadTasks(tasksDir) { return listTaskFiles(tasksDir).map(readTaskFile); }

function computeDerived(task, allTasks, repoRoot, staleOverride) {
  const fm = task.frontmatter || {};
  const status = fm.status || 'UNKNOWN';
  const body = task.body || '';
  // Count checkboxes tolerantly. Agents (Claude included) use multiple variants
  // when ticking off completed items, and an exact-`[x]` regex misses them all,
  // making the dashboard fraction lie. Accept anything inside the brackets that
  // is plausibly a "checked" mark: ascii x/X, Unicode check marks, emoji checks.
  // Unchecked is strict: only `[ ]` (single space).
  const checkboxRe = /-\s+\[([^\]]*)\]/g;
  let checkedCount = 0;
  let uncheckedCount = 0;
  const checkedMarkRe = /^(?:[xX]|✓|✔|✅|☑|☒|🗸|✗|✘|done|y|Y|yes|YES)$/;
  let m;
  while ((m = checkboxRe.exec(body)) !== null) {
    const inside = m[1];
    if (inside === ' ' || inside === '') uncheckedCount++;
    else if (checkedMarkRe.test(inside.trim())) checkedCount++;
    // Anything else (e.g. `[?]`, `[~]`, `[wip]`) — ignore. Don't guess.
  }
  const totalCount = checkedCount + uncheckedCount;

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

  const ready = status === 'OPEN' && depsMet && !claimedAt;
  return {
    status, checkedCount, totalCount,
    progressPct: totalCount > 0 ? Math.round((checkedCount / totalCount) * 100) : null,
    ready, stale, depsMet, unmetDeps,
    claimed: !!claimedAt, claimedAt, claimedBy, claimedByName,
  };
}

export { stripInlineComment, parseScalar, parseFrontmatter, readTaskFile, listTaskFiles, loadTasks, computeDerived };
