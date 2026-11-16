// core/touches.mjs — keeping a task's touches_paths true (task 239).
//
// The plan's parallel check (`clash` in core/plan.mjs) is only as good as each
// task's list of the files it edits. A 2026-11-09 count found 25 of cogyard's
// newest 40 closed tasks had changed existing code files their list didn't
// name, so two tasks autopilot ran "safely" side by side could still collide.
// Two moments keep the list true, both through `cogyard tasks touches`:
//
//   --add    the working chat, BEFORE editing a file its list doesn't cover:
//            the path goes into the list (committed); any task IN PROGRESS that
//            also lists it is named, for information only.
//   --check  merge-to-main, before merging: every file the branch changed that
//            the list doesn't cover, so it can be added and the record is true.
//
// Markdown files never count (a shared doc merges easily — the plan's soft
// clash), so neither moment reports them.
//
// What STOPS work is a real conflict, not a shared file name (owner,
// 2026-11-13: a list of files exempt from clashing "could potentially be a huge
// list and it also won't be comprehensive"). `cogyard tasks conflicts` asks git:
// a dry-run merge of the task's branch against every other branch in progress
// and the default branch (`dryMerge`, below). Two tasks listing one file often
// merge cleanly — 239 and 247 shared three files and merged without a conflict.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitP, defaultBranch } from './exec.mjs';

const execFileP = promisify(execFile);

// The plan's rule: an entry covers a file when it is that file, or a folder
// ('…/') the file sits under.
export const covers = (entry, file) => entry === file || (entry.endsWith('/') && file.startsWith(entry));
export const isCovered = (list, file) => (list || []).some((e) => typeof e === 'string' && covers(e.trim(), file));
const isMarkdown = (f) => f.endsWith('.md');

// Files in `changed` the task's list doesn't cover — Markdown left out (it
// never clashes).
export function outsideList({ changed = [], touches = [] }) {
  return changed.filter((f) => !isMarkdown(f) && !isCovered(touches, f));
}

// Add `paths` to the frontmatter's touches_paths, keeping every other line as
// written. Any form — missing, `[]`, `[a, b]`, or a block list — comes out as a
// block list. Paths already covered are skipped. Pure: text in, text out.
// Returns { text, added } (text unchanged when nothing was added).
export function addTouchesPaths(text, paths) {
  if (!text.startsWith('---\n')) throw new Error('no frontmatter');
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) throw new Error('frontmatter not terminated');
  const lines = text.slice(4, end).split('\n');
  const at = lines.findIndex((l) => /^touches_paths:(\s|$)/.test(l));

  let existing = [], from = at, to = at; // lines [from, to] are the field today
  if (at !== -1) {
    const inline = lines[at].replace(/^touches_paths:\s*/, '').replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) {
      existing = inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      while (to + 1 < lines.length && /^\s+-\s/.test(lines[to + 1])) {
        to++;
        existing.push(lines[to].replace(/^\s+-\s+/, '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, ''));
      }
    }
  }
  const added = [];
  for (const p of paths.map((s) => String(s).trim()).filter(Boolean)) {
    if (!isCovered(existing, p) && !isCovered(added, p)) added.push(p);
  }
  if (!added.length) return { text, added };

  const block = ['touches_paths:', ...[...existing, ...added].map((p) => `  - ${p}`)];
  if (at === -1) {
    const after = lines.findIndex((l) => /^related:(\s|$)/.test(l));
    lines.splice(after === -1 ? lines.length : after + 1, 0, ...block);
  } else {
    lines.splice(from, to - from + 1, ...block);
  }
  return { text: `---\n${lines.join('\n')}${text.slice(end)}`, added };
}

// Files the current branch changed against the repo's default branch (since
// they split), or null when there is no default branch to compare with.
export async function branchChangedFiles(repoRoot) {
  const base = await defaultBranch(repoRoot);
  if (!base) return null;
  const out = await gitP(['diff', '--name-only', `${base}...HEAD`], repoRoot);
  return (out || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

// From a computed plan: the tasks IN PROGRESS (other than `id`) that share one
// of `paths` with task `id` — [{ id, files }]. Only the given paths count, so a
// clash the task already had before them isn't reported again.
export function runningClashesFor(plan, id, paths) {
  const running = new Set(plan.groups.progress.filter((x) => String(x) !== String(id)));
  const mine = plan.tasks[String(id)]?.clash || [];
  return mine.filter((c) => running.has(c.id))
    .map((c) => ({ id: c.id, files: c.files.filter((f) => paths.some((p) => covers(f, p) || covers(p, f))) }))
    .filter((c) => c.files.length);
}

// Would merging branches `a` and `b` conflict? A dry run (`git merge-tree
// --write-tree`, git 2.38+): it writes objects only, and touches neither
// branch, the index nor any working tree. Called directly rather than through
// gitP, because a conflict is exit 1 and its stdout (tree id, then the
// conflicted files) is the answer.
// → { conflict: false, files: [] } | { conflict: true, files } | { error }
export async function dryMerge(repoRoot, a, b) {
  for (const ref of [a, b]) {
    if (!(await gitP(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot))) return { error: `branch ${ref} not found` };
  }
  try {
    await execFileP('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd: repoRoot, maxBuffer: 1 << 24 });
    return { conflict: false, files: [] };
  } catch (e) {
    if (e.code === 1 && e.stdout) {
      return { conflict: true, files: [...new Set(String(e.stdout).trim().split('\n').slice(1).map((s) => s.trim()).filter(Boolean))] };
    }
    return { error: String(e.stderr || e.message).trim() };
  }
}

// `branch` against each of `others` ([{ id, branch }] — the other tasks in
// progress) and the default branch. One dry run each, in order.
// → [{ id, branch, conflict, files } | { id, branch, error }], the default
// branch last with id null.
export async function branchConflicts(repoRoot, branch, others) {
  const base = await defaultBranch(repoRoot);
  const targets = [...others, ...(base && base !== branch ? [{ id: null, branch: base }] : [])];
  const out = [];
  for (const t of targets) out.push({ id: t.id, branch: t.branch, ...(await dryMerge(repoRoot, branch, t.branch)) });
  return out;
}
