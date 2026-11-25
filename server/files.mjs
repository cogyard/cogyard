// server/files.mjs — portal file-tree views for the Files tab: per-worktree file
// listing (working tree as on disk — everything, gitignored entries tagged
// `ignored` for the client filter), file content reads, diff-vs-main, and
// per-worktree last-activity (git-index mtime) for pill sorting. Read-mostly:
// writeWorkFile (the in-portal editing) is the one mutation, hash-guarded
// and reached only through the routes/files.mjs POST behind the http.mjs seam.

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync, lstatSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { join, basename, dirname, extname, isAbsolute, resolve, sep, posix } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as core from '../core/index.mjs';
import { assertInProject } from './http.mjs';

// Raw (untrimmed) NUL-separated git output. core.gitP trims, which can eat
// significant bytes (the porcelain lesson) — -z output stays raw here.
function gitZ(args, cwd) {
  try { return execFileSync('git', args, { cwd, maxBuffer: 1 << 26 }).toString(); }
  catch { return ''; }
}
const splitZ = (s) => s.split('\0').filter(Boolean);

// --- Worktree resolution ------------------------------------------------------

// Cheap enumeration (one `git worktree list` — none of the per-worktree
// status/ahead-behind work worktreesForProject does).
export function listWorktrees(proj) {
  return core.gitWorktrees(proj.path).map((e, i) => ({
    path: e.path,
    name: basename(e.path),
    branch: e.branch || (e.detached ? '(detached)' : null),
    isMain: i === 0,
  }));
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

// --- Links (task 269) -------------------------------------------------------------
// git lists a link (a symlink) as one path and says nothing more, so the Files
// tab drew every link as a plain file — and the task link `.cogyard/tasks`,
// which leads outside the repo, said "Not on disk" when clicked. A link entry
// now carries `link`, the same shape in the tree list and in /api/file:
//   target  — the link's own text (readlink), never resolved
//   display — target to print: an absolute one under the home folder as `~/…`
//             (as the Graph tab's folder link prints paths), else target
//   kind    — 'dir' | 'file' | 'broken' (nothing at the target)
//   inside  — whether the target resolves inside the worktree
// Describing a link never reads inside its target.

const within = (p, root) => p === root || p.startsWith(root + sep);
const tildeOf = (p) => {
  const home = homedir();
  return isAbsolute(p) && p.startsWith(home + sep) ? '~' + p.slice(home.length) : p;
};

// What the link at `rel` is, or null when `rel` is not a link.
export function linkInfo(wtPath, rel, root = realpathSync(wtPath)) {
  const abs = join(wtPath, rel);
  try { if (!lstatSync(abs).isSymbolicLink()) return null; } catch { return null; }
  let target = '';
  try { target = readlinkSync(abs); } catch { /* unreadable: kept as '' */ }
  let real = null;
  try { real = realpathSync(abs); } catch { /* broken */ }
  let kind = 'broken';
  if (real) { try { kind = statSync(real).isDirectory() ? 'dir' : 'file'; } catch { /* raced away */ } }
  // A broken link has no real path: judge where it would lead from its text,
  // against its own folder's real path (the worktree's path may itself hold links).
  let where = real;
  if (!where) { try { where = resolve(realpathSync(dirname(abs)), target); } catch { where = ''; } }
  return { target, display: tildeOf(target), kind, inside: !!where && within(where, root) };
}

// Which of the listed paths are links: one readdir per folder (its entries say
// whether each is a link) rather than one lstat per path — the gitignored
// listing runs to tens of thousands of paths.
function linksAmong(wtPath, paths) {
  const byDir = new Map();
  for (const p of paths) {
    const i = p.lastIndexOf('/');
    const d = i < 0 ? '' : p.slice(0, i);
    let names = byDir.get(d);
    if (!names) byDir.set(d, (names = new Set()));
    names.add(p.slice(i + 1));
  }
  const links = new Set();
  for (const [d, names] of byDir) {
    let ents;
    try { ents = readdirSync(join(wtPath, d), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isSymbolicLink() && names.has(e.name)) links.add(d ? `${d}/${e.name}` : e.name);
  }
  return links;
}

// The project's task link, as git spells paths. It is gitignored, so the plain
// listing leaves it out; fileTree adds it (owner's pick, task 269).
const TASK_LINK = core.TASKS_DIR.split(sep).join('/');

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
// untracked-but-not-ignored files reported as '?' (git's own porcelain code for
// untracked — NOT 'A', which is a real staged/committed addition; the client
// paints '?' with a muted badge so OS junk / tool output can't masquerade as an
// intentional add). Files deleted vs main aren't on
// disk but are included with status 'D' and onDisk:false so the tree can still
// show them.
//
// `commitStatus` is the same thing against ONE COMMIT (task 224): `commit`, or
// by default the last commit (HEAD) — then it is only what is not committed yet
// (staged, unstaged, untracked); against an older commit it is everything
// changed since it. Both come in one response so the Files tab's compare
// switch flips instantly and shows both counts. A file deleted before that
// commit has a `status` (vs main) but no `commitStatus`.
//
// `commits` = the branch's newest RECENT_COMMITS commits, for the Files tab's
// commit picker; `vsCommit` = the full sha compared against.
//
// A link entry carries `link` (see "Links" above), and the task link
// `.cogyard/tasks` is listed even without `ignored` (task 269).
//
// `filesHash` = a short hash of `files` exactly as sent (task 270). The Files
// tab re-downloads the tree on every live-update check (it has no change code,
// docs/LIVE-UPDATES.md) and redraws it only when this moves. It covers the file
// list alone: the commit list's ages (`relDate`) change with the clock and must
// not redraw an unchanged tree.
const RECENT_COMMITS = 10;
export async function fileTree(wtPath, { ignored = false, commit = null } = {}) {
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

  // path → { status, oldPath? } for one comparison base.
  const statusesVs = (base) => new Map(core.parseNameStatusZ(gitZ(['diff', '--name-status', '-z', '-M', base], wtPath)).map((e) => [e.path, e]));
  const vsMain = ref ? statusesVs(ref) : new Map();
  const vsCommit = statusesVs(commit || 'HEAD');

  const seen = new Set();
  const files = [];
  for (const p of listed) {
    if (seen.has(p)) continue;
    seen.add(p);
    const deleted = goneFromDisk.has(p);
    const isTracked = tracked.has(p);
    // Ignored files (node_modules, dist, .env…) aren't "changes vs main" — they
    // carry no status so they don't inflate the changed-only view or its count.
    // Untracked-but-not-ignored → '?' (git porcelain), distinct from a real 'A'.
    const untracked = !isTracked && !ignoredSet.has(p);
    const vs = (m) => (deleted ? 'D' : (m.get(p)?.status || (untracked ? '?' : null)));
    files.push({
      path: p, status: vs(vsMain), commitStatus: vs(vsCommit),
      oldPath: vsMain.get(p)?.oldPath, commitOldPath: vsCommit.get(p)?.oldPath,
      onDisk: !deleted, tracked: isTracked,
    });
  }
  // The task link shows even without the gitignored listing (task 269) — only
  // when it is a link: a stray folder there is a store problem, not a link.
  if (!seen.has(TASK_LINK)) {
    let isLink = false;
    try { isLink = lstatSync(join(wtPath, TASK_LINK)).isSymbolicLink(); } catch { /* none */ }
    if (isLink) { seen.add(TASK_LINK); files.push({ path: TASK_LINK, status: null, commitStatus: null, onDisk: true, tracked: false }); }
  }
  // Links among what is on disk carry `link` (task 269).
  const root = realpathSync(wtPath);
  const links = linksAmong(wtPath, files.filter((f) => f.onDisk).map((f) => f.path));
  for (const f of files) {
    const l = links.has(f.path) ? linkInfo(wtPath, f.path, root) : null;
    if (l) f.link = l;
  }
  // Deleted and no longer listed (a committed or staged delete): vs main, and
  // vs the last commit when the delete is not committed yet.
  for (const [p, e] of vsMain) {
    if (e.status === 'D' && !seen.has(p)) { seen.add(p); files.push({ path: p, status: 'D', commitStatus: vsCommit.get(p)?.status === 'D' ? 'D' : null, onDisk: false, tracked: true }); }
  }
  for (const [p, e] of vsCommit) {
    if (e.status === 'D' && !seen.has(p)) files.push({ path: p, status: null, commitStatus: 'D', onDisk: false, tracked: true });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const branch = (await core.gitP(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath)) || '';
  const vsCommitSha = (await core.gitP(['rev-parse', '--verify', '-q', (commit || 'HEAD') + '^{commit}'], wtPath)) || null;
  const LOG_FORMAT = '--format=%H%x1f%h%x1f%s%x1f%cr';
  const parseLog = (log) => (log || '').split('\n').filter(Boolean).map((l) => {
    const [sha, short, subject, relDate] = l.split('\x1f');
    return { sha, short, subject, relDate };
  });
  const commits = parseLog(await core.gitP(['log', '-n', String(RECENT_COMMITS), LOG_FORMAT, 'HEAD'], wtPath));
  // main's own tip, so the picker's main row reads like the commit rows.
  const mainCommit = ref ? parseLog(await core.gitP(['log', '-n', '1', LOG_FORMAT, ref], wtPath))[0] ?? null : null;
  const filesHash = sha256(JSON.stringify(files)).slice(0, 16);
  return { branch, vsRef: ref, vsCommit: vsCommitSha, mainCommit, commits, files, filesHash };
}

// --- File content ------------------------------------------------------------------

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const MAX_TEXT = 1 << 20; // 1 MiB cap on text payloads

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Read a file from the worktree's disk. Returns one of:
//   { forbidden } | { missing } | { image: Buffer, mime } |
//   { meta: { size, link } } | { meta: { binary, size } } |
//   { meta: { content, truncated, size, hash, link? } }
// `hash` is the sha256 of the SERVED bytes (the truncated slice when truncated),
// the save flow's optimistic-concurrency token: a truncated read's hash can
// never match the file on disk, so a truncated buffer can't round-trip a save.
// A link that can't be shown as a file — to a folder, broken, or leading out
// of the worktree — is DESCRIBED ({ size: 0, link }), never read (task 269);
// it used to come back forbidden/missing, which the page showed as "Not on
// disk". A link to a file inside the worktree reads as before, plus `link`.
export function readWorkFile(wtPath, rel) {
  const abs = join(wtPath, rel);
  const root = realpathSync(wtPath);
  const link = linkInfo(wtPath, rel, root);
  if (link && (link.kind !== 'file' || !link.inside)) return { meta: { size: 0, link } };
  if (!existsSync(abs)) return { missing: true };
  // realpath containment — a symlink inside the repo must not escape it.
  const real = realpathSync(abs);
  if (!within(real, root)) return { forbidden: true };
  if (statSync(abs).isDirectory()) return { missing: true };
  const buf = readFileSync(abs);
  const mime = IMAGE_MIME[extname(rel).toLowerCase()];
  if (mime) return { image: buf, mime };
  if (isBinary(buf)) return { meta: { binary: true, size: buf.length, ...(link && { link }) } };
  const served = buf.subarray(0, MAX_TEXT);
  return { meta: { content: served.toString('utf8'), truncated: buf.length > MAX_TEXT, size: buf.length, hash: sha256(served), ...(link && { link }) } };
}

// --- Raw files (task 262) ------------------------------------------------------------
// GET /api/raw/<slug>/<worktree>/<path> serves a worktree file's bytes at an
// address of its own, so an HTML page shown in the Files tab loads the
// stylesheets, images and scripts beside it from the project's real folder.
// The route (routes/files.mjs) sends every response with
// `Content-Security-Policy: sandbox allow-scripts`; that header, not this
// reader, is what keeps a served page away from the portal.

const RAW_MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.jsx': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain', '.md': 'text/plain',
  '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};
const MAX_RAW = 50 << 20; // 50 MiB — a page's video or font, not a disk dump

// The contained real path of `rel` inside the worktree, or why not.
function containedFile(wtPath, rel) {
  const abs = join(wtPath, rel);
  if (!existsSync(abs)) return { missing: true };
  const root = realpathSync(wtPath), real = realpathSync(abs);
  if (real !== root && !real.startsWith(root + sep)) return { forbidden: true };
  if (statSync(real).isDirectory()) return { missing: true };
  return { real };
}

// Read a worktree file for the raw route. Returns one of:
//   { forbidden } | { missing } | { tooLarge } | { body: Buffer, mime }
export function readRawFile(wtPath, rel) {
  const f = containedFile(wtPath, rel);
  if (!f.real) return f;
  if (statSync(f.real).size > MAX_RAW) return { tooLarge: true };
  const ext = extname(rel).toLowerCase();
  const mime = RAW_MIME[ext] || 'application/octet-stream';
  let body = readFileSync(f.real);
  if (mime === 'text/html') body = Buffer.from(inlineBabelSrc(wtPath, rel, body.toString('utf8')), 'utf8');
  return { body, mime };
}

// Babel standalone fetches `<script type="text/babel" src="x.jsx">` with XHR.
// A sandboxed page has an origin of its own, so that XHR needs CORS, which this
// server never sends (CLAUDE.md, Invariants) — the design pages built this way
// would render blank. So the route hands such a page each relative src file
// inline, read from inside the same worktree. Nothing else in the page changes,
// and the file on disk is never touched.
const SCRIPT_TAG = /<script\b([^>]*)>\s*<\/script\s*>/gi;
const ATTR = (name) => new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
export function inlineBabelSrc(wtPath, htmlRel, html) {
  return html.replace(SCRIPT_TAG, (tag, attrs) => {
    if (!/^text\/babel$/i.test(attrs.match(ATTR('type'))?.[2] ?? '')) return tag;
    const src = attrs.match(ATTR('src'))?.[2];
    // Relative paths only: no scheme, no protocol-relative //, no absolute /.
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return tag;
    const rel = posix.normalize(posix.join(posix.dirname(htmlRel), src.split(/[?#]/)[0]));
    if (rel.startsWith('..') || rel.startsWith('/')) return tag;
    const f = containedFile(wtPath, rel);
    if (!f.real) return tag;
    const code = readFileSync(f.real, 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script${attrs.replace(ATTR('src'), '')} data-inlined-from="${src.replace(/"/g, '&quot;')}">\n${code}\n</script>`;
  });
}

// Format an edited buffer with prettier before it hits disk. Server-side on
// purpose: the real prettier (a frontend devDep, hoisted to root node_modules)
// can resolveConfig against the TARGET file's path, so an edit in any project's
// worktree honors that project's own .prettierrc — a browser-side formatter
// can't read those. Best-effort by design: no inferred parser (sh, toml…),
// syntactically broken content, or prettier itself missing → save as typed.
// Lazy-imported so the save path is the only thing that pays prettier's load.
async function formatForSave(real, content) {
  try {
    const { format, resolveConfig, getFileInfo } = await import('prettier');
    const info = await getFileInfo(real);
    if (!info.inferredParser) return null;
    const cfg = (await resolveConfig(real)) || {};
    const out = await format(content, { ...cfg, filepath: real });
    return out === content ? null : out;
  } catch {
    return null;
  }
}

// Write an edited buffer back to the worktree's disk (the Files
// tab's edit → save). Guards mirror the read side plus the write hazards:
//   * containment via assertInProject (traversal, absolute paths, symlink escape)
//   * only existing on-disk text files (no images/binaries, no creation)
//   * files over the read cap are refused — the client only ever saw a
//     truncated buffer, and saving it would amputate the file
//   * baseHash must match the bytes on disk NOW, else 409-shaped { conflict } —
//     live Claude sessions edit these same worktrees, never silently clobber
// The buffer is prettier-formatted first (formatForSave above); when that
// changed it, `content` rides back in the response so the editor re-baselines
// to exactly what's on disk. The write is atomic (tmp file + rename in the
// same dir) so a concurrent reader never sees a half-written file. Returns:
//   { forbidden } | { missing } | { notText } | { tooLarge } |
//   { conflict: { currentHash } } | { ok: { hash, size, content? } }
export async function writeWorkFile(wtPath, rel, content, baseHash) {
  const real = assertInProject(wtPath, rel);
  if (!real) return { forbidden: true };
  if (!existsSync(real) || statSync(real).isDirectory()) return { missing: true };
  const cur = readFileSync(real);
  if (IMAGE_MIME[extname(rel).toLowerCase()] || isBinary(cur)) return { notText: true };
  if (cur.length > MAX_TEXT) return { tooLarge: true };
  if (sha256(cur) !== baseHash) return { conflict: { currentHash: sha256(cur) } };
  const formatted = await formatForSave(real, content);
  const out = formatted ?? content;
  const buf = Buffer.from(out, 'utf8');
  const tmp = real + `.cogyard-save-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, real);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already renamed or never written */ }
    throw e;
  }
  return { ok: { hash: sha256(buf), size: buf.length, ...(formatted != null && { content: out }) } };
}

// --- Diff vs main / vs the last commit ------------------------------------------------

// Working-tree state of one file against the main branch, or with
// `base: 'head'` against the last commit (task 224). Untracked files have no
// `git diff` — synthesize an all-added patch (the untracked-file pattern).
// `from` = a renamed file's old path, so git pairs the two paths instead of
// showing the whole file as added.
export async function wtDiff(wtPath, rel, { ignoreWs = false, base = 'main', from = null } = {}) {
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
  // base: 'main' | 'head' (the last commit) | a commit hash
  const ref = base === 'main' ? await mainRef(wtPath) : base === 'head' ? 'HEAD' : base;
  if (!ref) return '';
  const args = ['diff', '--no-color', '-M'];
  if (ignoreWs) args.push('-w');
  args.push(ref, '--', ...(from ? [from] : []), rel);
  return (await core.gitP(args, wtPath)) || '';
}
