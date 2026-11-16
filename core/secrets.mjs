// core/secrets.mjs — the one place a credential lives on this machine.
//
// THE PROBLEM. Scheduled jobs shell out to an agent CLI that authenticates from
// its PROCESS ENVIRONMENT (drivers/claude/adapter.mjs spawns it with no `env`
// option, so the child inherits ours). Before this module the only way to get a
// token onto that process was hand-editing `EnvironmentVariables` in a macOS
// LaunchAgent plist — a world-readable file, wiped by a reinstall, impossible to
// write down for anyone else, and invisible to cogyard, so a missing credential
// was discovered as a failed 05:00 run.
//
// THE ANSWER. One file, `$COGYARD_HOME/secrets.env`, mode 0600, read once at
// process start and merged into `process.env`. Two lines of onboarding
// instruction, one place to look, and every child process inherits it for free.
//
// THREE RULES, none of them negotiable:
//
//   1. A VALUE NEVER LEAVES THIS MODULE except into `process.env`. Nothing here
//      returns one, logs one, or puts one in a result object. Every other
//      surface — the API, the Settings card, a job summary, a run log — is
//      limited to `hasSecret()`'s boolean and `secretNames()`'s names. That is
//      why those are the only readers exported.
//   2. AN EXISTING VALUE WINS. A `KEY=…` already in the environment (a shell
//      export, a LaunchAgent variable) is left alone, so a one-off `KEY=x npm
//      run api` still overrides the file for testing.
//   3. A FILE THE WHOLE MACHINE CAN READ IS REFUSED, loudly, with the exact
//      chmod. A 0644 secrets file is the thing this module replaces; loading it
//      anyway would launder the problem into something that looks solved.
//
// NOT the Keychain, deliberately: a Keychain read from a LaunchAgent context
// prompts or fails depending on how the item was stored, which is exactly the
// unattended path that must not break. The seam for one is `SOURCES` below —
// a second source is a function returning [name, value] pairs, and no caller
// changes.
//
// Config lives next door in ./config.mjs and never holds a secret:
// `~/.cogyard/config.json` is world-readable, the portal rewrites it whenever a
// setting is saved, and a JSON value does not reach a child's environment,
// which is the one thing the agent needs.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { COGYARD_HOME } from './paths.mjs';

const SECRETS_PATH = join(COGYARD_HOME, 'secrets.env');

// Environment-variable names. Same shape the shell accepts.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Permission bits that make the file readable (or writable) by anyone but its
// owner. Any of them set = refuse.
const OPEN_TO_OTHERS = 0o077;

// --- parsing ------------------------------------------------------------------

// Unescape a double-quoted value. Single quotes are literal (shell semantics),
// so only the double-quoted form goes through this.
function unescapeDouble(s) {
  return s.replace(/\\([nrt\\"'])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
}

// Parse `KEY=value` lines. Supports `#` comment lines, blank lines, an optional
// `export ` prefix (so a line copied out of a shell profile just works), and
// single- or double-quoted values.
//
// An UNQUOTED value takes the WHOLE rest of the line — no trailing-comment
// stripping, unlike dotenv. A credential is opaque: silently truncating one at a
// ` #` it happens to contain would produce an auth failure nobody could explain.
// Comments go on their own line; quote anything with spaces.
//
// Returns { entries: Map<name, value>, badLines: [lineNumber] }. Malformed lines
// are reported by NUMBER, never by content — a mistyped line still holds a
// credential.
function parseSecretsEnv(text) {
  const entries = new Map();
  const badLines = [];
  const lines = String(text ?? '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;

    const line = raw.startsWith('export ') ? raw.slice(7).trim() : raw;
    const eq = line.indexOf('=');
    if (eq <= 0) { badLines.push(i + 1); continue; }

    const name = line.slice(0, eq).trim();
    if (!NAME_RE.test(name)) { badLines.push(i + 1); continue; }

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = unescapeDouble(value);
    }
    entries.set(name, value);
  }

  return { entries, badLines };
}

// --- sources ------------------------------------------------------------------

// The resolver seam. A source reports what it can supply as [name, value] pairs
// plus a refusal when it can see something it will not hand over. Adding a
// `keychain:` or `op://` backend later means adding a member here — the merge,
// the cache, and every caller stay as they are.
//
// One member today, on purpose (see the header): the file.
function fileSource() {
  if (!existsSync(SECRETS_PATH)) {
    // No file is the NORMAL state, not an error. Most machines never need one.
    return { ok: true, present: false, entries: new Map(), badLines: [] };
  }

  let mode;
  try { mode = statSync(SECRETS_PATH).mode; } catch (e) {
    return { ok: false, present: true, entries: new Map(), badLines: [], error: `cannot stat ${SECRETS_PATH}: ${e.message}` };
  }

  if (mode & OPEN_TO_OTHERS) {
    return {
      ok: false, present: true, entries: new Map(), badLines: [],
      error: `${SECRETS_PATH} is readable by other users (mode ${(mode & 0o777).toString(8)}) — refusing to load it`,
      fix: `chmod 600 ${SECRETS_PATH}`,
    };
  }

  let text;
  try { text = readFileSync(SECRETS_PATH, 'utf8'); } catch (e) {
    return { ok: false, present: true, entries: new Map(), badLines: [], error: `cannot read ${SECRETS_PATH}: ${e.message}` };
  }

  const { entries, badLines } = parseSecretsEnv(text);
  return { ok: true, present: true, entries, badLines };
}

const SOURCES = [fileSource];

// --- load ---------------------------------------------------------------------

let loaded = null;

// Read every source and merge what it supplies into `process.env`, NEVER
// overwriting a name that already has a value (rule 2).
//
// Returns a report with NAMES ONLY: { ok, path, present, loaded, skipped,
// badLines, error?, fix? }. `loaded` are the names this call put into the
// environment; `skipped` are the ones a pre-existing value won. Nothing in the
// return value, and nothing this function could be made to log, is a secret.
//
// Idempotent and cached: the second call is a no-op returning the first report,
// so any module may call it defensively (hasSecret does) without re-reading disk.
// Never throws — a portal that will not boot because a credential file has the
// wrong mode is a worse failure than the one it is reporting.
function loadSecrets({ force = false } = {}) {
  if (loaded && !force) return loaded;

  const report = { ok: true, path: SECRETS_PATH, present: false, loaded: [], skipped: [], badLines: [] };

  for (const source of SOURCES) {
    let r;
    try { r = source(); } catch (e) { r = { ok: false, present: true, entries: new Map(), badLines: [], error: String((e && e.message) || e) }; }

    if (r.present) report.present = true;
    if (r.badLines?.length) report.badLines.push(...r.badLines);
    if (!r.ok) {
      report.ok = false;
      report.error = r.error;
      if (r.fix) report.fix = r.fix;
      continue; // a refusing source supplies nothing; the others still load
    }

    for (const [name, value] of r.entries) {
      // An empty existing value ('' — set but blank) does not count as set:
      // treating it as a winner would make an accidental `export TOKEN=` shadow
      // the real credential with no way to tell.
      if (process.env[name]) { report.skipped.push(name); continue; }
      process.env[name] = value;
      report.loaded.push(name);
    }
  }

  loaded = report;
  return report;
}

// --- the read surface everything else uses ------------------------------------

// Is this credential available to a process we spawn? That is the ONLY question
// any other module gets to ask, and `process.env` is its literal answer — a
// child inherits exactly this. True for a file-supplied value and for a
// shell-exported one, which is what makes the override in rule 2 usable.
//
// Calls loadSecrets() itself so a CLI process that never boot-loaded still
// answers correctly.
function hasSecret(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
  loadSecrets();
  return typeof process.env[name] === 'string' && process.env[name] !== '';
}

// The names the store defines, sorted. Names, never values — this is what lets a
// Settings card list what is configured without the portal ever holding one.
function secretNames() {
  loadSecrets();
  const out = new Set();
  for (const source of SOURCES) {
    try {
      const r = source();
      if (r.ok) for (const name of r.entries.keys()) out.add(name);
    } catch { /* a broken source contributes no names */ }
  }
  return [...out].sort();
}

// The store's own health, for the surfaces that must explain WHY a credential
// reads as missing. Without this a refused 0600-violation renders identically to
// "you never added it", and the owner has no way to tell the two apart.
//
// Re-reads rather than serving the cached boot report, so the fix this very
// function printed actually takes: add the line or run the chmod, press Recheck,
// and the credential is live in the running portal. (The merge is idempotent —
// re-loading only ever fills in names the environment does not already have.)
function secretsStatus() {
  const r = loadSecrets({ force: true });
  return {
    path: r.path,
    present: r.present,
    ok: r.ok,
    error: r.error ?? null,
    fix: r.fix ?? null,
    badLines: r.badLines ?? [],
    names: r.ok ? secretNames() : [],
  };
}

// WHERE A CREDENTIAL IS SET, in one sentence, generated once.
//
// A credential is SET in this file but USED somewhere else entirely — a
// scheduled job at 05:00, an add-on's action. Whatever needs one has to say
// where to go and fix it, or "missing" is a dead end: the reader is looking at
// the job that failed, not at the place that would make it work. Every consumer
// renders THIS string rather than wording its own, so the instruction can never
// drift between surfaces or go stale when the path changes.
// It names the file and the restart and stops there — it deliberately does NOT
// name a portal screen. Core renders no credential UI (nothing in core calls an
// agent), so the add-on that needs one owns the walkthrough, and core would only
// be guessing where that walkthrough lives.
function whereToSet(name) {
  return `Add ${name} to ${SECRETS_PATH} (mode 600), then restart cogyard.`;
}

// The line that adds a credential, for whoever renders setup instructions. A
// template with a placeholder — this module has no value to put in it and never
// will, and building it here keeps the path out of everyone else's strings.
// `{input}` is a token the SETUP DIALOG substitutes with what the owner typed
// into its box. It is deliberately not a human-readable placeholder like
// <paste the value>: a copyable command containing one is a trap, because
// copy-paste-Enter writes the placeholder verbatim into the store. The dialog
// refuses to copy a command that still holds {input}.
function addSecretCommand(name) {
  return `echo '${name}={input}' >> ${SECRETS_PATH} && chmod 600 ${SECRETS_PATH}`;
}

// Test seam: forget the cached report so a redirected COGYARD_HOME re-reads.
// Does NOT unset anything already merged into process.env — un-setting a
// variable another part of the process is relying on is not this module's call.
function resetSecrets() { loaded = null; }

export { SECRETS_PATH, NAME_RE, parseSecretsEnv, loadSecrets, hasSecret, secretNames, secretsStatus, whereToSet, addSecretCommand, resetSecrets };
