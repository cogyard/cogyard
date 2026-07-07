// core/open-targets.mjs — the editable "Open in" target list
// (~/.cogyard/open-targets.json). The portal's Open-in menu is built from this,
// and POST /api/open resolves a target *id* to its command HERE — the client
// only ever sends an id, never a raw command, so the exec endpoint can't be
// turned into an arbitrary-command runner. Edit the JSON to add an app (e.g.
// Cursor) and both the menu and the endpoint pick it up; no code change.
//
// Each target: { id, label, exec, args }. In args, the tokens are:
//   {file} → the contained absolute path of the file
//   {line} → the 1-based line (when known); when no line is supplied a
//            ":{line}" or "{line}" token is dropped, so "code -g {file}:{line}"
//            degrades cleanly to "code -g <file>".
// As a special exec value, "{default-browser}" runs the file through whatever
// browser is the system default at the moment (resolved from LaunchServices),
// so it follows the default instead of hardcoding one app.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { HOME, COGYARD_HOME } from './paths.mjs';

const OPEN_TARGETS_PATH = join(COGYARD_HOME, 'open-targets.json');
const DEFAULT_BROWSER = '{default-browser}';

const DEFAULTS = [
  { id: 'vscode', label: 'VS Code', exec: 'code', args: ['-g', '{file}:{line}'] },
  { id: 'finder', label: 'Reveal in Finder', exec: 'open', args: ['-R', '{file}'] },
  { id: 'browser', label: 'Open in browser', exec: DEFAULT_BROWSER, args: ['{file}'] },
  { id: 'default', label: 'Open with default app', exec: 'open', args: ['{file}'] },
];

// Read the configured targets, seeding the file with DEFAULTS on first run.
// A malformed file (or any read error) falls back to DEFAULTS rather than
// breaking the menu. Entries missing id/exec/args are dropped.
function openTargets() {
  if (!existsSync(OPEN_TARGETS_PATH)) {
    try { writeFileSync(OPEN_TARGETS_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n'); } catch { /* read-only home; still serve defaults */ }
    return DEFAULTS;
  }
  try {
    const arr = JSON.parse(readFileSync(OPEN_TARGETS_PATH, 'utf8'));
    if (!Array.isArray(arr)) return DEFAULTS;
    const valid = arr.filter((t) => t && typeof t.id === 'string' && typeof t.exec === 'string' && Array.isArray(t.args));
    return valid.length ? valid : DEFAULTS;
  } catch { return DEFAULTS; }
}

function findOpenTarget(id) {
  return openTargets().find((t) => t.id === id) || null;
}

// Persist an edited target list (the /settings list editor). Each row
// must be a complete {id, label, exec, args[]} — this is the one place the client
// sends exec/args (everywhere else it sends only an id), so it's strict: any
// malformed row throws and nothing is written, rather than silently dropping rows
// the way the read path tolerates a hand-corrupted file. Returns the written list.
function writeOpenTargets(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('targets must be a non-empty array');
  const seen = new Set();
  const clean = list.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`target ${i}: not an object`);
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    const label = typeof t.label === 'string' ? t.label.trim() : '';
    const exec = typeof t.exec === 'string' ? t.exec.trim() : '';
    if (!id) throw new Error(`target ${i}: id is required`);
    if (!label) throw new Error(`target ${id}: label is required`);
    if (!exec) throw new Error(`target ${id}: exec is required`);
    if (!Array.isArray(t.args) || !t.args.every((a) => typeof a === 'string')) throw new Error(`target ${id}: args must be an array of strings`);
    if (seen.has(id)) throw new Error(`duplicate target id: ${id}`);
    seen.add(id);
    return { id, label, exec, args: t.args };
  });
  writeFileSync(OPEN_TARGETS_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// The bundle id of the current default browser (the https-scheme handler in
// LaunchServices), e.g. "com.google.chrome". null if it can't be determined.
function defaultBrowserBundleId() {
  try {
    const plist = join(HOME, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure');
    const out = execFileSync('defaults', ['read', plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Each handler is a { ... } block; find the one for the https scheme and
    // take its LSHandlerRoleAll (the app that owns http/https = the browser).
    for (const block of out.split('}')) {
      if (/LSHandlerURLScheme\s*=\s*https?\b/.test(block)) {
        const m = block.match(/LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?/);
        if (m) return m[1];
      }
    }
  } catch { /* not macOS, or LaunchServices unreadable */ }
  return null;
}

// Substitute {file}/{line} into a target's args. Empty args (e.g. a lone {line}
// with no line) are dropped.
function resolveOpenArgs(target, absPath, line) {
  return target.args
    .map((a) => {
      let s = String(a).replaceAll('{file}', absPath);
      s = line ? s.replaceAll('{line}', String(line)) : s.replace(/:?\{line\}/g, '');
      return s;
    })
    .filter((s) => s.length > 0);
}

// Resolve a target to the actual { exec, args } to run. Handles the
// "{default-browser}" special exec by routing through `open -b <bundleId>`
// (falls back to a plain `open <file>` if the default browser can't be found).
function resolveOpenCommand(target, absPath, line) {
  const args = resolveOpenArgs(target, absPath, line);
  if (target.exec === DEFAULT_BROWSER) {
    const bundle = defaultBrowserBundleId();
    return bundle ? { exec: 'open', args: ['-b', bundle, ...args] } : { exec: 'open', args };
  }
  return { exec: target.exec, args };
}

export { OPEN_TARGETS_PATH, openTargets, findOpenTarget, writeOpenTargets, resolveOpenArgs, resolveOpenCommand, defaultBrowserBundleId };
