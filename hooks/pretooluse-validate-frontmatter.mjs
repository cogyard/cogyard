#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit) forcing guard for task-file frontmatter.
//
// Stop malformed frontmatter at write time. Reads the hook
// JSON on stdin; if the target is a `_tasks/<NNN>-*.md` file, it reconstructs
// the post-edit content, validates it with the SAME validator as
// `tasks.mjs validate` (core/validate.mjs), and DENIES the write iff it would
// INCREASE the file's error count.
//
// Why "increase", not "any error": ~30 task files across projects already carry
// legacy schema errors. A hook that blocked on any error would make those files
// un-editable — you couldn't even edit toward correctness. Gating on a
// regression (errorsAfter > errorsBefore) means: you can always reduce or hold
// errors, never introduce new ones; a brand-new file (before = 0) must be clean.
//
// Fail-open everywhere: any parse/IO/edit-apply uncertainty exits 0 (allow). A
// guard that crashes-closed would block all editing — far worse than missing one
// bad write, which `tasks.mjs validate` / `doctor` still catch after the fact.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

function allow() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// --- read stdin ------------------------------------------------------------
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { allow(); }
let input;
try { input = JSON.parse(raw); } catch { allow(); }

const ti = input?.tool_input || {};
const fp = ti.file_path;
if (!fp) allow();

// Only NNN-prefixed task markdown under a _tasks/ dir; never the generated
// index. Matches both the symlink path (project/_tasks/NNN-*.md, what tools
// use) and the resolved store path (<COGYARD_PROJECTS_ROOT>/_tasks/<slug>/NNN-*.md).
if (!fp.includes('/_tasks/') || !/^\d.*\.md$/.test(basename(fp)) || basename(fp) === 'INDEX.md') allow();

// --- load the validator from this script's own checkout --------------------
let parseFrontmatter, loadTasks, validateTasks;
try {
  ({ parseFrontmatter, loadTasks, validateTasks } = await import(`${SELF}/../core/index.mjs`));
} catch { allow(); }

// Parse a content STRING into the {path,frontmatter,hasFrontmatter,...} shape
// validateTask expects (mirrors core/frontmatter.mjs readTaskFile).
function taskFromContent(path, content) {
  if (!content.startsWith('---\n')) return { path, frontmatter: null, body: content, hasFrontmatter: false };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { path, frontmatter: null, body: content, hasFrontmatter: false };
  const fmText = content.slice(4, end), body = content.slice(end + 5);
  try { return { path, frontmatter: parseFrontmatter(fmText), body, hasFrontmatter: true }; }
  catch (e) { return { path, frontmatter: null, body, hasFrontmatter: false, parseError: e.message }; }
}

const current = existsSync(fp) ? readFileSync(fp, 'utf8') : null;

// Reconstruct the would-be content from the tool input.
function applyEdit(src, oldS, newS, all) {
  if (oldS === '') return null;            // ambiguous insert — let it through
  if (!src.includes(oldS)) return null;    // can't locate anchor — fail open
  return all ? src.split(oldS).join(newS) : src.replace(oldS, newS);
}

let resulting;
if (ti.content != null) {                  // Write (full file)
  resulting = ti.content;
} else if (Array.isArray(ti.edits)) {       // MultiEdit
  let s = current ?? '';
  for (const e of ti.edits) {
    const r = applyEdit(s, e.old_string ?? '', e.new_string ?? '', !!e.replace_all);
    if (r == null) allow();
    s = r;
  }
  resulting = s;
} else if (ti.old_string != null) {         // Edit
  const r = applyEdit(current ?? '', ti.old_string, ti.new_string ?? '', !!ti.replace_all);
  if (r == null) allow();
  resulting = r;
} else {
  allow();
}

// Validate candidate against its siblings (excludes the target so its own row
// isn't double-counted); compare to the file's current error count.
const dir = dirname(fp);
let siblings = [];
try { siblings = loadTasks(dir).filter((t) => t.path !== fp); } catch { siblings = []; }
const fileBase = basename(fp);

function errorsFor(content) {
  const { results } = validateTasks([...siblings, taskFromContent(fp, content)]);
  const r = results.find((x) => x.file === fileBase);
  return r ? r.errors : [];
}

const before = current != null ? errorsFor(current) : [];
const after = errorsFor(resulting);

if (after.length > before.length) {
  const beforeSet = new Set(before);
  const introduced = after.filter((e) => !beforeSet.has(e));
  const list = (introduced.length ? introduced : after).map((e) => `  • ${e}`).join('\n');
  deny(
    `Task-frontmatter guard: this write would introduce ${after.length - before.length} new schema error(s) in ${fileBase}:\n${list}\n\n`
    + `Fix the frontmatter so it validates, then retry. Run \`cogyard tasks validate\` to check. `
    + `(Pre-existing errors are allowed through — this only blocks NEW ones.)`,
  );
}

allow();
