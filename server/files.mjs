// server/files.mjs — portal file-tree views for the Files tab: per-worktree file
// listing (working tree as on disk — everything, gitignored entries tagged
// `ignored` for the client filter), file content reads, diff-vs-main, and
// per-worktree last-activity (git-index mtime) for pill sorting. All read-only.

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, basename, extname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as core from '../core/index.mjs';

// Raw (untrimmed) NUL-separated git output. core.gitP trims, which can eat
// significant bytes (the task-010 porcelain lesson) — -z output stays raw here.
function gitZ(args, cwd) {
  try { return execFileSync('git', args, { cwd, maxBuffer: 1 << 26 }).toString(); }
  catch { return ''; }
}
const splitZ = (s) => s.split('\0').filter(Boolean);

// --- Worktree resolution ------------------------------------------------------

// Cheap enumeration across all clones (one `git worktree list` per clone — none
// of the per-worktree status/ahead-behind work worktreesForProject does).
export function listWorktrees(proj) {
  const clonePaths = proj.clones && proj.clones.length ? proj.clones : [proj.path];
  const out = [];
  for (const cp of clonePaths) {
    core.gitWorktrees(cp).forEach((e, i) => out.push({
      path: e.path,
      name: basename(e.path),
      branch: e.branch || (e.detached ? '(detached)' : null),
      isMain: i === 0,
      clone: clonePaths.length > 1 ? basename(cp) : null,
    }));
  }
  return out;
}

// Resolve a pill selection by worktree name; '' / missing → the main checkout.
export function findWorktree(proj, wtName) {
  const list = listWorktrees(proj);
  if (!wtName) return list.find((w) => w.isMain) || list[0] || null;
  return list.find((w) => w.name === wtName) || null;
}

// The ref "changed vs main" compares against the repo's default branch (main/master).
const mainRef = (repo) => core.defaultBranch(repo);

// --- Pill activity --------------------------------------------------------------

// last activity = mtime of the worktree's git index — bumped by stage / commit /
// checkout / restore / stash. ONE stat per worktree, no git spawn, no tree walk.
// (Previously walked every non-ignored file to also catch raw unsaved edits; that
// precision cost a `git ls-files` spawn + a full tree walk PER worktree — ~31
// spawns + walks on every /api/wt-activity — and isn't worth it for a switcher.)
// A linked worktree's `.git` is a FILE pointing at <repo>/.git/worktrees/<name>,
// so resolve the real index path rather than assuming <wt>/.git/index.
function gitIndexPath(wtPath) {
  const dotgit = join(wtPath, '.git');
  try {
    if (statSync(dotgit).isDirectory()) return join(dotgit, 'index');
    const m = readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (m) {
      const gd = m[1].trim();
      return join(gd.startsWith('/') ? gd : join(wtPath, gd), 'index');
    }
  } catch { /* no .git, unreadable, etc. */ }
  return null;
}

function lastActivity(wtPath) {
  const idx = gitIndexPath(wtPath);
  if (!idx) return null;
  try { return new Date(statSync(idx).mtimeMs).toISOString(); } catch { return null; }
}

export function worktreeActivity(proj) {
  return listWorktrees(proj).map((w) => ({ ...w, lastActivity: lastActivity(w.path) }));
}

// --- File tree -------------------------------------------------------------------

// Flat file list of the working tree: tracked + untracked, and — only when
// `ignored: true` — gitignored files too (only .git internals are excluded —
// git never lists those). Gitignored files are opt-in because enumerating them
// walks node_modules/dist: ~220k entries and a ~25 MB response on a big repo,
// vs ~1k entries without. The client lazy-loads the ignored view on demand.
// Each entry is tagged `tracked: true|false` — false means "non-git" (untracked,
// whether gitignored like node_modules or just not yet added). The client uses
// it to gray non-git rows. Each entry also carries its status vs the main
// branch (committed AND uncommitted differences): A/M/D/R…, with
// untracked-but-not-ignored files reported as 'A' (additions relative to main,
// though `git diff` itself doesn't list them). Files deleted vs main aren't on
// disk but are included with status 'D' and onDisk:false so the tree can still
// show them.
export async function fileTree(wtPath, { ignored = false } = {}) {
  const ref = await mainRef(wtPath);
  // Default: tracked + untracked-but-not-ignored (--exclude-standard skips the
  // gitignored forest). With `ignored`: everything on disk, plus the ignored
  // set computed separately only to keep node_modules/dist out of the status
  // counts (they aren't "changes vs main").
  const listed = ignored
    ? splitZ(gitZ(['ls-files', '--cached', '--others', '-z'], wtPath))
    : splitZ(gitZ(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], wtPath));
  const ignoredSet = ignored
    ? new Set(splitZ(gitZ(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], wtPath)))
    : new Set();
  const tracked = new Set(splitZ(gitZ(['ls-files', '--cached', '-z'], wtPath)));
  const goneFromDisk = new Set(splitZ(gitZ(['ls-files', '--deleted', '-z'], wtPath)));

  const st = new Map(), oldPaths = new Map();
  if (ref) {
    // -z: `M\0path\0` per entry; renames/copies are `R100\0old\0new\0`.
    const toks = gitZ(['diff', '--name-status', '-z', '-M', ref], wtPath).split('\0');
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t) continue;
      const s = t[0];
      if (s === 'R' || s === 'C') { const from = toks[++i], to = toks[++i]; st.set(to, s); oldPaths.set(to, from); }
      else st.set(toks[++i], s);
    }
  }

  const seen = new Set();
  const files = [];
  for (const p of listed) {
    if (seen.has(p)) continue;
    seen.add(p);
    const deleted = goneFromDisk.has(p);
    const isTracked = tracked.has(p);
    // Ignored files (node_modules, dist, .env…) aren't "changes vs main" — they
    // carry no status so they don't inflate the changed-only view or its count.
    const status = deleted ? 'D' : (st.get(p) || (!isTracked && !ignoredSet.has(p) ? 'A' : null));
    files.push({ path: p, status, oldPath: oldPaths.get(p), onDisk: !deleted, tracked: isTracked });
  }
  for (const [p, s] of st) {
    if (s === 'D' && !seen.has(p)) files.push({ path: p, status: 'D', onDisk: false, tracked: true });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const branch = (await core.gitP(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath)) || '';
  return { branch, vsRef: ref, files };
}

// --- File content ------------------------------------------------------------------

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const MAX_TEXT = 1 << 20; // 1 MiB cap on text payloads

// Read a file from the worktree's disk. Returns one of:
//   { forbidden } | { missing } | { image: Buffer, mime } |
//   { meta: { binary, size } } | { meta: { content, truncated, size } }
export function readWorkFile(wtPath, rel) {
  const abs = join(wtPath, rel);
  if (!existsSync(abs)) return { missing: true };
  // realpath containment — a symlink inside the repo must not escape it.
  const root = realpathSync(wtPath), real = realpathSync(abs);
  if (real !== root && !real.startsWith(root + sep)) return { forbidden: true };
  if (statSync(abs).isDirectory()) return { missing: true };
  const buf = readFileSync(abs);
  const mime = IMAGE_MIME[extname(rel).toLowerCase()];
  if (mime) return { image: buf, mime };
  if (buf.subarray(0, 8000).includes(0)) return { meta: { binary: true, size: buf.length } };
  return { meta: { content: buf.subarray(0, MAX_TEXT).toString('utf8'), truncated: buf.length > MAX_TEXT, size: buf.length } };
}

// --- Diff vs main ----------------------------------------------------------------------

// Working-tree state of one file against the main branch. Untracked files have
// no `git diff` vs main — synthesize an all-added patch (the task-010 pattern).
export async function vsMainDiff(wtPath, rel, ignoreWs) {
  const isTracked = !!gitZ(['ls-files', '--cached', '-z', '--', rel], wtPath);
  if (!isTracked) {
    const fp = join(wtPath, rel);
    if (!existsSync(fp)) return '';
    const buf = readFileSync(fp);
    if (buf.includes(0)) return `Binary files /dev/null and b/${rel} differ`;
    const lines = buf.toString('utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n');
  }
  const ref = await mainRef(wtPath);
  if (!ref) return '';
  const args = ['diff', '--no-color'];
  if (ignoreWs) args.push('-w');
  args.push(ref, '--', rel);
  return (await core.gitP(args, wtPath)) || '';
}
