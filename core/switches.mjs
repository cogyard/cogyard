// core/switches.mjs — a project's switches (task 246): the few places a
// project works differently from cogyard's defaults, set per project.
//
//   rebase   'always' | 'ask'                         default 'always'
//   version  'off' | 'minor' | 'patch'
//            | { command, file }                       default 'minor' when the
//                                                      repo root has package.json,
//                                                      else 'off'
//   decisions_log  a repo-relative path to the         default null (off)
//            project's decisions log, e.g.
//            'docs/DECISIONS.md' (task 276): when
//            set, `cogyard tasks validate <id>`
//            refuses a task that records a decision
//            until an entry in that file cites it
//            (core/validate.mjs decisionLogProblems)
//
// The file is <task link>/switches.json — IN the project's task store, next to
// axes.json, so every worktree sees a change at once (a repo file is frozen per
// worktree at spawn), saving never dirties the main checkout, and a team store
// shares it. Absent file = every default.
//
// The defaults live HERE and nowhere else: the skills read the resolved values
// through `cogyard tasks switches --json`, never the file.
//
// Read is forgiving (same idiom as core/axes.mjs and core/config.mjs): a bad
// JSON file, an unknown key or an invalid value is dropped and the default
// applies. Write is strict: anything invalid is refused with a reason and
// nothing is written.
//
// Agent-agnostic: no agent literals. These are engine data; only a driver's
// skills act on them.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { tasksDirOf } from './tasks-dir.mjs';

const SWITCHES_FILE = 'switches.json';
const switchesPath = (projectPath) => join(tasksDirOf(projectPath), SWITCHES_FILE);

const REBASE_VALUES = ['always', 'ask'];
const VERSION_VALUES = ['off', 'minor', 'patch'];
const NPM_COUNTER = 'package.json';

// Each switch: its default for a project, and a checker that returns
// { value } for a valid input or { error } saying why not.
const SWITCHES = {
  rebase: {
    defaultFor: () => 'always',
    check(v) {
      return REBASE_VALUES.includes(v) ? { value: v }
        : { error: `rebase must be one of ${REBASE_VALUES.join(', ')}` };
    },
  },
  version: {
    defaultFor: (projectPath) => (projectPath && existsSync(join(projectPath, NPM_COUNTER)) ? 'minor' : 'off'),
    check(v) {
      if (typeof v === 'string') {
        return VERSION_VALUES.includes(v) ? { value: v }
          : { error: `version must be one of ${VERSION_VALUES.join(', ')}, or { command, file }` };
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { error: `version must be one of ${VERSION_VALUES.join(', ')}, or { command, file }` };
      }
      const command = typeof v.command === 'string' ? v.command.trim() : '';
      const file = typeof v.file === 'string' ? v.file.trim() : '';
      if (!command) return { error: 'version.command must be a non-empty command' };
      if (!file) return { error: 'version.file must name the file that holds the version' };
      if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
        return { error: 'version.file must be a path inside the repo, relative to its root' };
      }
      return { value: { command, file } };
    },
  },
  // Off unless set: a project that keeps no log never has a merge refused.
  decisions_log: {
    defaultFor: () => null,
    check(v) {
      const path = typeof v === 'string' ? v.trim() : '';
      if (!path) return { error: 'decisions_log must name the log file, a path inside the repo relative to its root (e.g. docs/DECISIONS.md)' };
      if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
        return { error: 'decisions_log must be a path inside the repo, relative to its root' };
      }
      return { value: path };
    },
  },
};

const SWITCH_NAMES = Object.keys(SWITCHES);

// The raw object in the file, or {} on any problem. Never throws.
function readRaw(projectPath) {
  if (!projectPath) return {};
  try {
    const raw = JSON.parse(readFileSync(switchesPath(projectPath), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

// The file the version is kept in, for the "the merge already changed the
// version" guard — package.json for minor/patch, the declared file for a
// project's own command, null when versioning is off.
function counterFileOf(version) {
  if (version === 'off') return null;
  if (typeof version === 'object') return version.file;
  return NPM_COUNTER;
}

// → { rebase: { value, set }, version: { value, set, file }, decisions_log: { value, set } }
// `set` is true when the value came from the file, false when it is the default.
// decisions_log.value is null when the project keeps no log (the check is off).
export function resolveSwitches(projectPath) {
  const raw = readRaw(projectPath);
  const out = {};
  for (const name of SWITCH_NAMES) {
    const def = SWITCHES[name];
    const checked = name in raw ? def.check(raw[name]) : null;
    out[name] = checked && !checked.error
      ? { value: checked.value, set: true }
      : { value: def.defaultFor(projectPath), set: false };
  }
  out.version.file = counterFileOf(out.version.value);
  return out;
}

// What each switch is when the project does not set it — for a reader that
// offers "back to the default" and needs to say what that is.
// → { rebase, version, decisions_log }
export function switchDefaults(projectPath) {
  const out = {};
  for (const name of SWITCH_NAMES) out[name] = SWITCHES[name].defaultFor(projectPath);
  return out;
}

// The values as stored in the file (only what is set, invalid entries dropped)
// — what the settings card edits.
export function readProjectSwitches(projectPath) {
  const raw = readRaw(projectPath);
  const out = {};
  for (const name of SWITCH_NAMES) {
    if (!(name in raw)) continue;
    const checked = SWITCHES[name].check(raw[name]);
    if (!checked.error) out[name] = checked.value;
  }
  return out;
}

// Why each entry in the file is being ignored (unknown key, invalid value, a
// file that is not a JSON object) — [] when every entry is used. So a reader
// can say a hand edit did not take, instead of silently showing the default.
export function switchProblems(projectPath) {
  if (!projectPath) return [];
  let raw;
  try { raw = JSON.parse(readFileSync(switchesPath(projectPath), 'utf8')); }
  catch (e) { return e.code === 'ENOENT' ? [] : [`${SWITCHES_FILE} is not valid JSON — every switch is at its default`]; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [`${SWITCHES_FILE} is not a JSON object — every switch is at its default`];
  const v = validateSwitches(raw);
  return v.ok ? [] : v.errors.map((e) => `${e} — ignored, the default applies`);
}

// Check an untrusted input: every key must be a known switch, every value
// valid or null (null = unset, back to the default).
// → { ok: true, switches } with only the set values, or { ok: false, errors }.
export function validateSwitches(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['switches must be an object'] };
  }
  const errors = [];
  const switches = {};
  for (const [name, v] of Object.entries(input)) {
    if (!SWITCHES[name]) { errors.push(`unknown switch: ${name} (known: ${SWITCH_NAMES.join(', ')})`); continue; }
    if (v === null) continue;
    const checked = SWITCHES[name].check(v);
    if (checked.error) errors.push(checked.error);
    else switches[name] = checked.value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, switches };
}

// Replace the project's switches with `input` (a key left out or null goes
// back to its default). Refuses, writing nothing, on any invalid entry.
// → { ok: true, switches, path } or { ok: false, errors }.
// Commit it with `cogyard tasks sync push "<msg>" -- switches.json`.
export function writeProjectSwitches(projectPath, input) {
  const v = validateSwitches(input);
  if (!v.ok) return v;
  const path = switchesPath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v.switches, null, 2) + '\n');
  return { ok: true, switches: v.switches, path };
}

export { SWITCHES_FILE, SWITCH_NAMES, REBASE_VALUES, VERSION_VALUES };
