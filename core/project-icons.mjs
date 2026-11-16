// core/project-icons.mjs — per-project icons for the portal's left rail (task 114).
//
// An icon is a path to an image file INSIDE the project's own repo, stored
// repo-root-relative in config.json's `ui.projectIcons` ({ [slug]: relativePath }).
// You choose the path on the project's settings tab. There is no auto-detection:
// guessing which file in a repo is "the icon" is a heuristic that is wrong often
// enough to be worse than an empty field, and choosing takes two seconds.
//
// A PICKER IS NOT DETECTION, and the rule above does not forbid one (task 140).
// `listProjectImages()` below answers "what images does this repo have"; the
// owner answers which one is the icon. Nothing ranks the candidates, nominates a
// favourite, or pre-fills the field — that is the line, and it is still drawn.
// What changed is only that you no longer have to leave the portal and transcribe
// a path by hand to cross it.
//
// `ui.projectIconBorders` is the companion list: the slugs whose icon gets a
// white border behind it on the dark rail. Also owner-set, also a checkbox — the
// portal never inspects artwork to decide whether it needs one.
//
// This module is therefore just the rules for those two stored values — the
// validators, the mime table — plus the API's error messages.
//
// The map keys off the DISPLAYED slug (what the rail renders), not a registry
// entry: core/registry.mjs's discoverProjects() synthesizes a fresh entry when it
// collapses a multi-clone project, so an icon stored on a member entry in
// projects.json would vanish for exactly those projects.
//
// Path safety is enforced twice by design: syntactically here (no absolute paths,
// no `..`, image extensions only) and again by realpath containment at the API
// edge (server/http.mjs's assertInProject), which also catches symlink escapes.

import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { gitP } from './exec.mjs';

// The image types the rail can render, and what to serve them as. Anything not
// in here is rejected — an icon path is not a general file-read hole.
const ICON_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

// Syntactic validity of a stored icon path: a repo-root-relative path to a file
// with a known image extension. Mirrors server/http.mjs's badRelPath posture —
// no absolute paths, no `..` segment, no NUL — plus the extension allowlist.
function isIconPath(p) {
  if (!p || typeof p !== 'string' || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.split(/[\\/]/).includes('..')) return false;
  return Object.hasOwn(ICON_MIME, extname(p).toLowerCase());
}

// Content-Type for a validated icon path.
function iconMime(p) {
  return ICON_MIME[extname(p).toLowerCase()] || 'application/octet-stream';
}

// A cache key for the artwork an icon URL currently resolves to (task 140).
//
// /api/project-icon is addressed by SLUG, so its URL is identical before and
// after the owner points a project at a different file — the browser replayed
// its cached copy and the rail kept showing the old icon for a full max-age.
// Threading this version through the URL makes the address change exactly when
// the bytes do: the stored path is in the key, so re-pointing busts it, and
// mtime+size are in it too, so editing the file in place busts it as well.
//
// Deliberately NOT a content hash: an icon is served on every portal load, and
// reading + hashing every project's artwork to answer /api/config would be real
// work on every poll. mtime+size is what every static file server has used for
// this since the 90s, and the failure it admits — a rewrite that preserves both
// — costs one hard refresh.
//
// Returns null when the file is unreadable (missing, or a path that escaped its
// project). Callers omit the parameter then: an unversioned URL still resolves,
// and a 404 is the rail's empty-slot state anyway.
function iconVersion(absPath, rel) {
  let st;
  try { st = statSync(absPath); } catch { return null; }
  if (!st.isFile()) return null;
  let h = 2166136261; // FNV-1a over path + mtime + size; short, stable, cheap.
  for (const s of [rel || '', String(Math.trunc(st.mtimeMs)), String(st.size)]) {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= 0x2f; h = Math.imul(h, 16777619); // separator, so a+bc !== ab+c
  }
  return (h >>> 0).toString(36);
}

// Directories never worth walking for artwork, when there is no git to ask.
// Dependencies and build output hold thousands of images, none of them this
// project's logo.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.angular', '.cache', '.venv', 'venv', '__pycache__',
  'DerivedData', 'Pods', 'target',
]);
const MAX_IMAGES = 300;   // enough to choose from; a cap so a huge repo can't hang the portal
const MAX_DEPTH = 6;      // an icon 7 levels down is not the one you meant

// Every image file in a project's repo, repo-root-relative, sorted (task 140).
//
// This is the PICKER's data, and a picker is not the auto-detection task 114
// removed: nothing here ranks, guesses, or nominates "the icon". It answers
// "what images does this repo have", the owner answers which one.
//
// Asks git first — `ls-files --cached --others --exclude-standard` is tracked
// plus untracked-but-not-ignored, which is exactly the set a human thinks of as
// "files in my repo", gitignore honoured for free and fast on a big tree. A repo
// with no git (or a git that fails) falls back to a bounded manual walk.
async function listProjectImages(repoPath) {
  const fromGit = await gitP(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repoPath);
  // ls-files lists every file, so the extension filter applies either way; the
  // walk applies it as it goes but re-checking is free and keeps the two paths
  // honest about returning the same shape.
  const paths = fromGit === null ? walkForImages(repoPath) : fromGit.split('\0');
  const images = paths.filter((p) => p && isIconPath(p)
    && !p.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)));
  return [...new Set(images)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_IMAGES);
}

// Fallback for a non-git project: depth- and count-bounded directory walk.
function walkForImages(root) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < MAX_IMAGES) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= MAX_IMAGES) break;
      if (e.name.startsWith('.') && e.name !== '.well-known') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(e.name)) continue;
        stack.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile() && Object.hasOwn(ICON_MIME, extname(e.name).toLowerCase())) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  }
  return out;
}

// Validate a persisted/incoming { [slug]: relPath } map. Invalid entries are
// DROPPED, not thrown on — a hand-corrupted config still yields a usable map,
// the same posture as the rest of uiPrefs(). An empty-string value means "no
// icon" and is dropped too, which is how the settings card clears a row.
function sanitizeProjectIcons(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [slug, path] of Object.entries(map)) {
    if (typeof slug !== 'string' || !slug) continue;
    if (typeof path !== 'string' || !path.trim()) continue;
    const rel = path.trim();
    if (!isIconPath(rel)) continue;
    out[slug] = rel;
  }
  return out;
}

// Which projects want a white border behind their rail icon, as a list of slugs.
// A project's icon is its own artwork, shown as-is; some are drawn for white
// browser chrome and need something light behind them on the dark rail, some
// don't. That's a per-project judgement the owner makes with a checkbox in
// /settings — nothing here inspects an image to decide.
function sanitizeProjectIconBorders(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))];
}

// Same rules as sanitize, but reports WHY — the API needs a specific 400 message
// instead of silently dropping what the user typed. Returns null when valid.
function projectIconBordersError(list) {
  if (!Array.isArray(list)) return 'projectIconBorders must be an array of project slugs';
  for (const s of list) if (typeof s !== 'string') return 'projectIconBorders entries must be project slugs (strings)';
  return null;
}

// Same rules as sanitize, but reports WHY — the API needs a specific 400 message
// instead of silently dropping what the user typed. Returns null when valid.
function projectIconsError(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'projectIcons must be an object keyed by project slug';
  for (const [slug, path] of Object.entries(map)) {
    if (typeof path !== 'string') return `projectIcons.${slug} must be a string path`;
    const rel = path.trim();
    if (!rel) continue; // empty = clear this project's icon
    if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) return `projectIcons.${slug} must be relative to the project root, not absolute`;
    if (rel.split(/[\\/]/).includes('..')) return `projectIcons.${slug} must not contain ".."`;
    if (!isIconPath(rel)) return `projectIcons.${slug} must be an image file (${Object.keys(ICON_MIME).join(', ')})`;
  }
  return null;
}

export { ICON_MIME, isIconPath, iconMime, iconVersion, listProjectImages, sanitizeProjectIcons, projectIconsError,
  sanitizeProjectIconBorders, projectIconBordersError };
