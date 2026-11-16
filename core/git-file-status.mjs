// core/git-file-status.mjs — the ONE reader of git's per-file status output
// (task 224). Pure leaf: string in, entries out; no git calls, no imports.
//
// Before this module five places read these outputs with five sets of rules —
// the Files tree kept the letter, the commit panel kept git's raw code ("R097",
// a similarity score that means nothing to a reader) and ran a rename's old and
// new paths together into one "old\tnew" path, so clicking it found no file.
//
// Every entry has the same shape:
//   status   ONE letter — A M D R C T U (or '?' untracked, porcelain only)
//   path     the file as it is NOW (a rename's NEW path)
//   oldPath  only for a rename / copy: where it came from

// The first letter of a git status code: "R097" → "R", "M" → "M".
export const statusLetter = (code) => String(code || '').charAt(0).toUpperCase();

const twoPaths = (s) => s === 'R' || s === 'C';

// `git diff|show --name-status -z`: "M\0path\0", renames/copies
// "R097\0old\0new\0". Leading newlines (git show's empty --format line) are
// skipped.
export function parseNameStatusZ(out) {
  const toks = String(out || '').split('\0');
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    const code = toks[i].replace(/^\n+/, '');
    if (!code) continue;
    const status = statusLetter(code);
    if (twoPaths(status)) {
      const oldPath = toks[++i], path = toks[++i];
      if (path) entries.push({ status, path, oldPath });
    } else {
      const path = toks[++i];
      if (path) entries.push({ status, path });
    }
  }
  return entries;
}

// One line of `git log --name-status` (no -z, where per-commit headers make -z
// awkward): "M\tpath", "R097\told\tnew". Returns null for a non-status line.
export function parseNameStatusLine(line) {
  const parts = String(line || '').split('\t');
  if (parts.length < 2 || !/^[A-Z]\d*$/.test(parts[0])) return null;
  const status = statusLetter(parts[0]);
  if (twoPaths(status) && parts.length >= 3) return { status, path: parts[2], oldPath: parts[1] };
  return { status, path: parts[parts.length - 1] };
}

// `git status --porcelain=v1 -z`: "XY path\0", a rename/copy in the index is
// "R  new\0old\0". Keeps both columns — callers differ in which one they show
// (the commit panel splits staged X from unstaged Y; the store view takes X,
// else Y). `x`/`y` are single characters, ' ' for unchanged; untracked is '??'.
export function parsePorcelainZ(out) {
  const toks = String(out || '').split('\0');
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    const e = toks[i];
    if (!e) continue;
    const x = e[0], y = e[1], path = e.slice(3);
    if (x === '?' && y === '?') { entries.push({ x, y, path, untracked: true }); continue; }
    const entry = { x, y, path, untracked: false };
    if (twoPaths(x)) entry.oldPath = toks[++i];
    entries.push(entry);
  }
  return entries;
}
