// core/publish.mjs — whether a push deploys a project, and how it publishes
// (task 170).
//
// PUSHING AND PUBLISHING ARE DIFFERENT ACTS. Where a push to main deploys to
// production, every push is a release, so the project grows a pre-push hook
// that refuses agents — and then no agent can ever finish a merge there. The
// fix is to move the deploy off the push; this module is how cogyard knows,
// per project, whether that has happened and what the publish is instead.
//
// The answer is a DECLARATION the project commits: `.cogyard/publish.json`.
//
//   { "deploysOnPush": false,
//     "command": "scripts/deploy.sh",          // automated deploy step
//     "manual": ["Press Deploy on …"],         // steps the owner does by hand
//     "health": "https://example.com/health",  // proves the commit is live
//     "liveCheck": "test …",                   // OR: a command that proves the
//                                              //   release is live (exit 0)
//     "tag": true,                             // default true
//     "requires": ["DIGITALOCEAN_TOKEN"],      // credentials the deploy needs
//     "checks": ["npm test"] }                 // must pass on the commit first
//
// At least one of `command` / `manual`. At most one of `health` / `liveCheck`
// (task 267): both answer "is it live?", for a project with a commit-stamped
// /health (`health`) or without one (`liveCheck` — e.g. "npm serves this
// version"); with neither, step 8 asks the owner. Every field is one the publish ACTS
// on; there is no free-text field, because prose here restates the other
// fields or describes cogyard's behaviour, and both go stale. A publish (`cogyard publish
// <project>`, cli/publish.mjs, docs/PUBLISH.md) is cogyard's own release shape
// applied to any project: deploy exactly the main commit, prove it is live,
// then put the flag in the code tree — `v<version>` on that commit, pushed.
// The newest `v*` tag is the release ledger: work after it is unreleased.
//
// Every check here FAILS CLOSED: anything that cannot be proven is a refusal
// with the reason, never a guess.

import { readFileSync, statSync, openSync, writeSync, closeSync, unlinkSync, mkdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute, dirname } from 'node:path';
import { defaultBranchSync } from './exec.mjs';
import { COGYARD_HOME } from './paths.mjs';
import { NAME_RE, hasSecret, whereToSet } from './secrets.mjs';

const PUBLISH_CONFIG = join('.cogyard', 'publish.json');
const LOCK_DIR = join(COGYARD_HOME, 'run', 'publish');
const PUBLISH_LOG = join(COGYARD_HOME, 'publishes.jsonl');

// What every publish applies without being told. ONE definition: the CLI runs
// with these and the project settings card shows these, so what the owner
// reads is what happens.
const PUBLISH_DEFAULTS = Object.freeze({
  verifyTimeoutMinutes: 10,   // how long Verify waits for /health to show the commit, or the live check to pass
  verifyPollSeconds: 15,      // how often it asks
  remote: 'origin',           // the remote main must equal, and the tag is pushed to
  tagFormat: 'v<version>',    // the release tag; <version> from the root package.json
  logPath: PUBLISH_LOG,
});

function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// --- the declaration ----------------------------------------------------------

// Two forms (task 264). The FLAT form above describes one release. A project
// that ships more than one thing from one repo — a device's firmware and its
// website, an iOS app and its website — names each under `releases`:
//
//   { "releases": {
//       "website": { "label": "Website", "tag": "web/v<version>",
//                    "paths": ["site/", "wrangler.jsonc"],
//                    "deploysOnPush": false, "command": "npx wrangler deploy",
//                    "health": "https://example.com/version.json" },
//       "device":  { "label": "Device", "tag": "v<version>",
//                    "paths": ["firmware/"], "deploysOnPush": false,
//                    "manual": ["Flash the meter by USB"] } } }
//
// Each release takes every flat field, plus `label` (required: what the Graph
// and the settings card call it), `paths` (optional: the files whose commits
// count as this release's changes) and a `tag` PATTERN — `<prefix><version>`,
// or false for no tag. The prefix keeps two releases' tags apart, since they
// share one package.json version but ship from different commits: tags of
// overlapping prefixes are refused, or one release's tags would read as the
// other's.
//
// { declared: false }                         — no file
// { declared: true, error }                   — present but unusable
// { declared: true, deploysOnPush, command, manual, health, liveCheck, tag, requires, checks }   — flat
// { declared: true, releases: [{ name, label, tagFormat, tag, paths, deploysOnPush, … }] }
const RELEASE_FIELDS = ['deploysOnPush', 'command', 'manual', 'health', 'liveCheck', 'tag', 'requires', 'checks'];
const RELEASE_NAME_RE = /^[a-z][a-z0-9-]*$/;

// One release's fields, checked: { fields } | { error } (error without the
// file name, so the caller can say which release it is).
function readReleaseFields(raw, { pattern }) {
  if (typeof raw.deploysOnPush !== 'boolean') return { error: 'needs "deploysOnPush": true or false' };
  for (const k of ['command', 'health', 'liveCheck']) {
    if (raw[k] != null && (typeof raw[k] !== 'string' || !raw[k].trim())) return { error: `"${k}" must be a non-empty string when present` };
  }
  if (raw.health != null && raw.liveCheck != null) {
    return { error: '"health" and "liveCheck" both prove the release is live — declare one of them, not both' };
  }
  for (const k of ['manual', 'checks']) {
    if (raw[k] != null && (!Array.isArray(raw[k]) || !raw[k].length || raw[k].some((s) => typeof s !== 'string' || !s.trim()))) {
      return { error: `"${k}" must be a non-empty list of non-empty ${k === 'manual' ? 'steps' : 'commands'} when present` };
    }
  }
  if (raw.health != null && !/^https?:\/\/\S+$/.test(raw.health.trim())) return { error: '"health" must be an http(s) URL' };
  let tagFormat = PUBLISH_DEFAULTS.tagFormat;
  if (pattern) {
    // A release's tag is a pattern, or false. `true` is not accepted: a bare
    // `v<version>` must be written out, so which release owns it is on the page.
    if (raw.tag === false) tagFormat = null;
    else {
      const bad = tagPatternError(raw.tag);
      if (bad) return { error: bad };
      tagFormat = raw.tag;
    }
  } else {
    if (raw.tag != null && typeof raw.tag !== 'boolean') return { error: '"tag" must be true or false' };
    if (raw.tag === false) tagFormat = null;
  }
  if (raw.requires != null && (!Array.isArray(raw.requires) || !raw.requires.length || raw.requires.some((n) => typeof n !== 'string' || !NAME_RE.test(n)))) {
    return { error: '"requires" must be a non-empty list of credential names (letters, digits, _) when present' };
  }
  return {
    fields: {
      deploysOnPush: raw.deploysOnPush,
      command: raw.command?.trim() || null,
      manual: raw.manual ? raw.manual.map((s) => s.trim()) : [],
      health: raw.health?.trim() || null,
      liveCheck: raw.liveCheck?.trim() || null,
      tag: tagFormat !== null,
      requires: raw.requires ?? [],
      checks: raw.checks ? raw.checks.map((s) => s.trim()) : [],
    },
    tagFormat,
  };
}

// `<prefix><version>`: the prefix starts with a letter, holds only what a git
// tag name allows without quoting, and doesn't end in a digit (the version
// starts with one, so the boundary would blur). null when fine.
function tagPatternError(tag) {
  if (typeof tag !== 'string' || !tag.endsWith('<version>') || tag.indexOf('<version>') !== tag.length - '<version>'.length) {
    return '"tag" must be a pattern ending in <version>, like "v<version>" or "web/v<version>", or false';
  }
  const prefix = tag.slice(0, -'<version>'.length);
  if (!/^[A-Za-z][A-Za-z0-9._/-]*$/.test(prefix) || /\d$/.test(prefix) || prefix.includes('..') || prefix.includes('//')) {
    return `"tag": "${tag}" — the part before <version> must start with a letter, use only letters, digits, . _ / -, and not end in a digit`;
  }
  return null;
}

// The fixed text of a tag before its version: "v" for "v<version>".
function tagPrefix(tagFormat) {
  return tagFormat ? tagFormat.slice(0, -'<version>'.length) : null;
}

function readPublishConfig(projectRoot) {
  const path = join(projectRoot, PUBLISH_CONFIG);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { declared: false }; }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { declared: true, error: `${PUBLISH_CONFIG} is not valid JSON: ${e.message}` }; }
  const bad = (msg) => ({ declared: true, error: `${PUBLISH_CONFIG}: ${msg}` });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('must be a JSON object');
  const unknownIn = (obj, known) => Object.keys(obj).filter((k) => !known.has(k));
  const unknownMsg = (keys) => `unknown field(s) ${keys.map((k) => `"${k}"`).join(', ')} — a typo here would silently change what a publish does`;

  if (!('releases' in raw)) {
    const unknown = unknownIn(raw, new Set(RELEASE_FIELDS));
    if (unknown.length) return bad(unknownMsg(unknown));
    const r = readReleaseFields(raw, { pattern: false });
    if (r.error) return bad(r.error);
    return { declared: true, ...r.fields };
  }

  // The `releases` form: nothing beside it at the top, so a flat field left
  // over from before the move can't be read as applying to every release.
  const top = unknownIn(raw, new Set(['releases']));
  if (top.length) return bad(`${unknownMsg(top)} — with "releases", every field goes inside a release`);
  const rs = raw.releases;
  if (!rs || typeof rs !== 'object' || Array.isArray(rs) || !Object.keys(rs).length) {
    return bad('"releases" must be an object naming at least one release');
  }
  const releases = [];
  for (const [name, body] of Object.entries(rs)) {
    const where = `release "${name}"`;
    if (!RELEASE_NAME_RE.test(name)) return bad(`${where}: a release's name is lowercase letters, digits and -, starting with a letter`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(`${where} must be a JSON object`);
    const unknown = unknownIn(body, new Set([...RELEASE_FIELDS, 'label', 'paths']));
    if (unknown.length) return bad(`${where}: ${unknownMsg(unknown)}`);
    if (typeof body.label !== 'string' || !body.label.trim()) return bad(`${where} needs a "label" — what the Graph and the settings card call it`);
    if (body.paths != null && (!Array.isArray(body.paths) || !body.paths.length
      || body.paths.some((p) => typeof p !== 'string' || !p.trim() || p.trim().startsWith('/') || p.split('/').includes('..')))) {
      return bad(`${where}: "paths" must be a non-empty list of paths inside the repo when present`);
    }
    if (body.tag === undefined) return bad(`${where} needs a "tag": a pattern like "v<version>" or "web/v<version>", or false`);
    const r = readReleaseFields(body, { pattern: true });
    if (r.error) return bad(`${where}: ${r.error}`);
    releases.push({
      name, label: body.label.trim(), tagFormat: r.tagFormat,
      paths: body.paths ? body.paths.map((p) => p.trim()) : [], ...r.fields,
    });
  }
  for (let i = 0; i < releases.length; i++) {
    for (let j = i + 1; j < releases.length; j++) {
      const a = tagPrefix(releases[i].tagFormat), b = tagPrefix(releases[j].tagFormat);
      if (a && b && (a.startsWith(b) || b.startsWith(a))) {
        return bad(`releases "${releases[i].name}" and "${releases[j].name}" have overlapping tags ("${releases[i].tagFormat}" and "${releases[j].tagFormat}") — one's tags would read as the other's; give each its own prefix`);
      }
    }
  }
  return { declared: true, releases };
}

// Every release a usable declaration describes, in one shape: the flat form is
// one release with no name or label, tagged "v<version>" unless "tag": false.
// [] when undeclared or invalid.
function publishReleases(cfg) {
  if (!cfg?.declared || cfg.error) return [];
  if (cfg.releases) return cfg.releases;
  const { declared, ...fields } = cfg;
  return [{ name: null, label: null, tagFormat: cfg.tag ? PUBLISH_DEFAULTS.tagFormat : null, paths: [], ...fields }];
}

// Which release `name` means: its name, or its label, any case. The flat form
// takes no name. A `releases` file with ONE entry needs no name either — it
// publishes like the flat form, and a name, if given, must still be its own.
// { ok, release } | { ok: false, reason }.
function pickRelease(cfg, name) {
  const all = publishReleases(cfg);
  if (!cfg.releases) {
    if (name) return { ok: false, reason: `this project declares one release, so it takes no release name — leave out "${name}"` };
    return { ok: true, release: all[0] };
  }
  const names = all.map((r) => r.name).join(', ');
  const theReleases = all.length === 1 ? `this project's release is ${names}` : `this project's releases are ${names}`;
  if (!name) {
    if (all.length === 1) return { ok: true, release: all[0] };
    return { ok: false, reason: `this project declares ${all.length} releases (${names}) — name the one to publish` };
  }
  const q = name.toLowerCase();
  const hit = all.find((r) => r.name === q) ?? all.find((r) => r.label.toLowerCase() === q);
  if (!hit) return { ok: false, reason: `no release called "${name}" — ${theReleases}` };
  return { ok: true, release: hit };
}

// What `cogyard publish <project>` may do with a declaration (flat) or with
// one release of it:
//   { ok: true }  |  { ok: false, reason }
function publishPlan(cfg) {
  if (!cfg.declared && !('deploysOnPush' in cfg)) return { ok: false, reason: `no ${PUBLISH_CONFIG} — this project has not declared how it publishes (docs/PUBLISH.md).` };
  if (cfg.error) return { ok: false, reason: cfg.error };
  if (cfg.releases) return { ok: false, reason: `this project declares ${cfg.releases.length === 1 ? '1 release' : `${cfg.releases.length} releases`} — a publish is of one of them` };
  if (cfg.deploysOnPush) {
    return { ok: false, reason: 'this project deploys on every push to main, so there is no separate publish. Turn off the push trigger on the platform first, then set "deploysOnPush": false.' };
  }
  if (!cfg.command && !cfg.manual.length) {
    return { ok: false, reason: `${PUBLISH_CONFIG} declares neither a "command" nor "manual" steps — there is nothing a publish could do.` };
  }
  // Credentials are checked here, before anything runs — never discovered
  // missing halfway through a deploy. Names only; no value is read out.
  const missing = (cfg.requires ?? []).filter((n) => !hasSecret(n));
  if (missing.length) {
    return { ok: false, reason: `missing credential(s) ${missing.join(', ')}. ${missing.map(whereToSet).join(' ')}` };
  }
  return { ok: true };
}

// --- the code tree --------------------------------------------------------------

// Numeric x.y.z compare; null when either side is not plain semver.
function compareVersions(a, b) {
  const p = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = p(a); const y = p(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// The newest release tag reachable from `ref` (default: the default branch).
// `prefix` is the release's tag text before its version (task 264): "v" for
// the flat form, "web/v" for a release tagged "web/v<version>".
function lastRelease(projectRoot, ref = null, prefix = 'v') {
  const target = ref ?? defaultBranchSync(projectRoot);
  if (!target) return null;
  return git(['describe', '--tags', '--abbrev=0', '--match', `${prefix}[0-9]*`, target], projectRoot);
}

// Can this checkout be published, and exactly what? A publish ships ONE
// commit, so it must be unambiguous: the default branch, checked out, nothing
// uncommitted, identical to origin's (a platform builds what is pushed), and —
// when tagging — carrying a version newer than the last release.
//
//   { ok: true, branch, sha, short, remote, version, tag, tagHere, previous }
//   { ok: false, reason }
//
// `fetch: false` (task 259) skips the one side effect, the fetch, and judges
// against <remote>/<branch> as of the LAST fetch — every other check, and every
// refusal sentence, is the same. That is how the read-only settings card asks
// "would a publish go through?" without writing to the repo.
//
// `prefix` and `tagOff` (task 264) are one release's: its tag text before the
// version, and where its "tag": false would go — so a refusal names the right
// place to turn tagging off.
function publishPreflight(projectRoot, { tag = true, fetch = true, prefix = 'v', tagOff = `set "tag": false in ${PUBLISH_CONFIG}` } = {}) {
  const branch = defaultBranchSync(projectRoot);
  if (!branch) return { ok: false, reason: 'no main or master branch in this checkout' };
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
  if (current !== branch) return { ok: false, reason: `the checkout is on '${current}', not '${branch}' — a publish ships ${branch}` };
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], projectRoot);
  if (dirty === null) return { ok: false, reason: 'git status failed in the checkout' };
  if (dirty) return { ok: false, reason: `${branch} has uncommitted changes — commit or discard them first` };

  const sha = git(['rev-parse', 'HEAD'], projectRoot);
  const remote = (git(['remote'], projectRoot) ?? '').split('\n').includes('origin') ? 'origin' : null;
  if (remote) {
    if (fetch && git(['fetch', '--quiet', '--tags', remote, branch], projectRoot) === null) {
      return { ok: false, reason: `could not fetch ${remote} — a publish must know exactly what ${remote}/${branch} is` };
    }
    const remoteSha = git(['rev-parse', `${remote}/${branch}`], projectRoot);
    if (remoteSha !== sha) {
      const ahead = git(['rev-list', '--count', `${remote}/${branch}..HEAD`], projectRoot);
      const behind = git(['rev-list', '--count', `HEAD..${remote}/${branch}`], projectRoot);
      return { ok: false, reason: `${branch} is ${ahead} ahead / ${behind} behind ${remote}/${branch} — push or pull until they match, so the deploy builds the commit that gets tagged` };
    }
  }

  const out = { ok: true, branch, sha, short: sha.slice(0, 7), remote, version: null, tag: null, tagHere: false, previous: lastRelease(projectRoot, sha, prefix) };
  if (!tag) return out;

  let version = null;
  try { version = JSON.parse(git(['show', `${sha}:package.json`], projectRoot) ?? '').version ?? null; } catch { /* none */ }
  if (typeof version !== 'string' || !version) {
    return { ok: false, reason: `no "version" in package.json at ${out.short} to tag — add one, or ${tagOff}` };
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, reason: `version "${version}" at ${out.short} is not plain x.y.z, so it can't be compared with the last release — use x.y.z, or ${tagOff}` };
  }
  out.version = version;
  out.tag = `${prefix}${version}`;
  const tagAt = git(['rev-parse', '--verify', '--quiet', `refs/tags/${out.tag}^{commit}`], projectRoot);
  if (tagAt && tagAt !== sha) {
    return { ok: false, reason: `${out.tag} already marks ${tagAt.slice(0, 7)} — ${out.short} needs a new version before it can be published (the merge to main bumps it)` };
  }
  out.tagHere = !!tagAt;
  if (!out.tagHere && out.previous) {
    const cmp = compareVersions(version, out.previous.slice(prefix.length));
    if (cmp === null) {
      return { ok: false, reason: `the last release tag ${out.previous} is not plain ${prefix}X.Y.Z, so ${version} can't be proven newer — fix or remove that tag first` };
    }
    if (cmp <= 0) {
      return { ok: false, reason: `version ${version} is not newer than the last release ${out.previous} — bump it before publishing` };
    }
  }
  return out;
}

// After the checks ran in the checkout: is it still exactly the commit being
// published, with no tracked file changed? A check that rewrites a tracked
// file (a formatter, a build that writes into the tree) means the checked code
// is not the committed code. null when unchanged, else the reason.
function checkoutStill(projectRoot, sha) {
  const head = git(['rev-parse', 'HEAD'], projectRoot);
  if (head !== sha) return `the checkout moved from ${sha.slice(0, 7)} to ${head ? head.slice(0, 7) : 'nothing'} while the checks ran`;
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], projectRoot);
  if (dirty === null) return 'git status failed after the checks';
  if (dirty) return `the checks changed tracked files:\n${dirty}`;
  return null;
}

// --- live check -------------------------------------------------------------------

// Does a /health body report EXACTLY this commit? `commit` (full or ≥7 chars),
// `commitShort`, or `sha`.
function healthMatches(body, sha) {
  if (!body || typeof body !== 'object' || !sha) return false;
  for (const k of ['commit', 'commitShort', 'sha']) {
    const v = body[k];
    if (typeof v === 'string' && v.length >= 7 && sha.startsWith(v)) return true;
  }
  return false;
}

function healthCommit(body) {
  if (!body || typeof body !== 'object') return null;
  for (const k of ['commit', 'commitShort', 'sha']) if (typeof body[k] === 'string') return body[k].slice(0, 7);
  return null;
}

// --- the flag ---------------------------------------------------------------------

// Tag `sha` with `tag` (annotated), push it, and PROVE the remote has it on
// that commit. Returns { ok, pushed, error? }.
function tagRelease(projectRoot, { tag, sha, remote, label }) {
  const at = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], projectRoot);
  if (at && at !== sha) return { ok: false, error: `${tag} already marks ${at.slice(0, 7)}` };
  if (!at && git(['tag', '-a', tag, '-m', `Published ${label} ${tag}`, sha], projectRoot) === null) {
    return { ok: false, error: `git tag ${tag} failed` };
  }
  if (!remote) return { ok: true, pushed: false };
  git(['push', '--quiet', remote, `refs/tags/${tag}`], projectRoot);
  const remoteAt = (git(['ls-remote', remote, `refs/tags/${tag}^{}`], projectRoot) ?? '').split(/\s+/)[0];
  if (remoteAt !== sha) {
    return { ok: false, error: `${tag} is set locally but ${remote} does not have it on ${sha.slice(0, 7)} — run: git -C ${projectRoot} push ${remote} ${tag}` };
  }
  return { ok: true, pushed: true };
}

// --- one publish at a time, and a record of each ------------------------------

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Take the per-project publish lock. { ok, release } | { ok: false, reason }.
// A lock left by a process that no longer exists is taken over.
function takePublishLock(slug) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const path = join(LOCK_DIR, `${slug.replace(/[^\w.-]/g, '_')}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return { ok: true, release() { if (!released) { released = true; try { unlinkSync(path); } catch { /* gone */ } } } };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: `cannot create ${path}: ${e.message}` };
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (holder && pidAlive(holder)) return { ok: false, reason: `another publish of this project is running (pid ${holder})` };
      try { unlinkSync(path); } catch { /* raced */ }
    }
  }
  return { ok: false, reason: `could not take ${path}` };
}

function recordPublish(entry) {
  mkdirSync(dirname(PUBLISH_LOG), { recursive: true });
  appendFileSync(PUBLISH_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// --- the listing --------------------------------------------------------------------

// The pre-push hook git would run for this checkout, or null.
function prePushHook(projectRoot) {
  let dir = git(['config', 'core.hooksPath'], projectRoot);
  if (dir) {
    if (!isAbsolute(dir)) dir = join(projectRoot, dir);
  } else {
    const common = git(['rev-parse', '--git-common-dir'], projectRoot);
    if (!common) return null;
    dir = join(isAbsolute(common) ? common : join(projectRoot, common), 'hooks');
  }
  const hook = join(dir, 'pre-push');
  try {
    const s = statSync(hook);
    return s.isFile() && (s.mode & 0o111) ? hook : null;
  } catch { return null; }
}

// Which project does `name` mean? Exact slug, then exact label, then the ONE
// project whose slug or label contains it. More than one → refused with the
// candidates, never a pick: publishing the wrong project is not recoverable.
//   { ok: true, project } | { ok: false, reason }
function resolvePublishProject(projects, name) {
  const live = projects.filter((p) => !p.error);
  const exact = live.find((p) => p.slug === name) ?? live.find((p) => p.label === name);
  if (exact) return { ok: true, project: exact };
  const q = name.toLowerCase();
  const hits = live.filter((p) => p.slug.toLowerCase().includes(q) || (p.label ?? '').toLowerCase().includes(q));
  if (hits.length === 1) return { ok: true, project: hits[0] };
  if (!hits.length) return { ok: false, reason: `no registered project matches '${name}' — \`cogyard publish list\` shows them` };
  return { ok: false, reason: `'${name}' matches ${hits.length} projects (${hits.map((p) => p.slug).join(', ')}) — name one exactly` };
}

// One row per project: "which projects deploy on push, and how does each one
// publish?". `projects` is the registry's [{slug, label, path}]. A project
// naming its releases (task 264) has no project-wide last release; each of its
// `releases` carries its own.
function publishInventory(projects) {
  return projects.map((p) => {
    const cfg = readPublishConfig(p.path);
    const row = {
      slug: p.slug,
      label: p.label ?? p.slug,
      path: p.path,
      ...cfg,
      prePushHook: prePushHook(p.path),
      lastRelease: cfg.releases ? null : lastRelease(p.path),
    };
    if (cfg.releases) {
      row.releases = cfg.releases.map((r) => ({ ...r, lastRelease: r.tagFormat ? lastRelease(p.path, null, tagPrefix(r.tagFormat)) : null }));
    }
    return row;
  });
}

// The recent publishes of one project from the log, newest first.
function publishHistory(slug, limit = 10) {
  let text = '';
  try { text = readFileSync(PUBLISH_LOG, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.project === slug) rows.push(r); } catch { /* a torn line */ }
  }
  return rows.reverse().slice(0, limit);
}

async function readLive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'cache-control': 'no-cache' } });
    const body = await res.json();
    return { reachable: true, commit: healthCommit(body), body };
  } catch { return { reachable: false, commit: null, body: null }; }
}

// Everything the project settings card shows about how a project publishes —
// READ-ONLY: no fetch (it reads origin/<branch> as of the last fetch), no
// writes, credential NAMES with a set/missing boolean and never a value.
// The text before the version in the tags one release counts as its own: its
// pattern's prefix. The flat form keeps "v" even with "tag": false, as before
// task 264 (its card shows the newest v tag either way); a named release with
// "tag": false has none — another release's tags are not its own.
function releaseTagPrefix(rel) {
  if (rel.name === null) return 'v';
  return tagPrefix(rel.tagFormat);
}

// One release's last tag on `tipSha`: its commit, date, and how many commits
// since — only commits touching the release's `paths` when it lists any.
function releaseLastTag(root, rel, tipSha) {
  const prefix = releaseTagPrefix(rel);
  if (!prefix) return null;
  const tag = lastRelease(root, tipSha ?? undefined, prefix);
  if (!tag) return null;
  const paths = rel.paths ?? [];
  return {
    tag,
    short: (git(['rev-parse', `${tag}^{commit}`], root) ?? '').slice(0, 7) || null,
    date: git(['log', '-1', '--format=%cI', `${tag}^{commit}`], root),
    unreleased: Number(git(['rev-list', '--count', `${tag}..${tipSha}`, ...(paths.length ? ['--', ...paths] : [])], root) ?? 0),
    paths,
  };
}

async function releaseStatus(root, rel, tipSha) {
  let live = null;
  if (rel.health) {
    const r = await readLive(rel.health);
    live = {
      url: rel.health,
      reachable: r.reachable,
      commit: r.commit,
      servesTip: !!(tipSha && r.body && healthMatches(r.body, tipSha)),
    };
  }
  // Would `cogyard publish` go through right now? The same two checks it makes
  // before step 1, in the same order and with the same refusal sentences — the
  // code check WITHOUT its fetch, so this stays read-only (as of the last fetch).
  // It cannot see checks inside the project's own deploy step.
  let ready;
  const plan = publishPlan(rel);
  if (!plan.ok) ready = { ok: false, reason: plan.reason };
  else {
    const pre = publishPreflight(root, {
      tag: rel.tag, fetch: false, prefix: tagPrefix(rel.tagFormat) ?? 'v',
      tagOff: rel.name ? `set "tag": false for the "${rel.name}" release in ${PUBLISH_CONFIG}` : undefined,
    });
    ready = pre.ok ? { ok: true, reason: null } : { ok: false, reason: pre.reason };
  }
  return {
    name: rel.name,
    label: rel.label,
    declaration: rel,
    credentials: rel.requires.map((name) => ({ name, set: hasSecret(name) })),
    lastRelease: releaseLastTag(root, rel, tipSha),
    live,
    ready,
  };
}

async function publishStatus(project) {
  const root = project.path;
  const declaration = readPublishConfig(root);
  const branch = defaultBranchSync(root);
  const remote = (git(['remote'], root) ?? '').split('\n').includes(PUBLISH_DEFAULTS.remote) ? PUBLISH_DEFAULTS.remote : null;
  const tipRef = branch ? (remote ? `${remote}/${branch}` : branch) : null;
  const tipSha = tipRef ? git(['rev-parse', '--verify', '--quiet', `${tipRef}^{commit}`], root) : null;

  let version = null;
  if (tipSha) {
    try { version = JSON.parse(git(['show', `${tipSha}:package.json`], root) ?? '').version ?? null; } catch { /* none */ }
  }

  const releases = await Promise.all(publishReleases(declaration).map((rel) => releaseStatus(root, rel, tipSha)));
  // The flat form's one release is also spread at the top, as before task 264:
  // a card or caller that knows one release keeps reading the same fields. An
  // undeclared or invalid file still reports the v-tag last release.
  const flat = declaration.releases ? null : (releases[0] ?? null);
  const withoutPaths = (l) => { if (!l) return null; const { paths, ...rest } = l; return rest; };
  const flatLast = declaration.releases ? null
    : withoutPaths(flat ? flat.lastRelease : releaseLastTag(root, { name: null, paths: [] }, tipSha));

  return {
    slug: project.slug,
    declaration,
    releases,
    credentials: flat ? flat.credentials : [],
    tip: tipSha ? { ref: tipRef, short: tipSha.slice(0, 7), version } : null,
    lastRelease: flatLast,
    live: flat ? flat.live : null,
    ready: flat ? flat.ready : null,
    prePushHook: prePushHook(root),
    history: publishHistory(project.slug),
    defaults: { ...PUBLISH_DEFAULTS, branch },
  };
}

// The Graph's tag refs, labelled with the release each belongs to (task 264).
// Only a project naming its releases gets labels — the flat form's tags show
// as they always have. `rows` are the Graph's rows ({ refs: ['tag: v2.4.0', …] });
// a matched row comes back as a copy with
//   releaseTags: [{ tag, release, label, version }]
// The SPA shows `<label> <version>` and keeps the tag for hover; it never
// matches tags itself.
function labelReleaseTags(projectRoot, rows) {
  const cfg = readPublishConfig(projectRoot);
  if (!cfg.releases || !Array.isArray(rows)) return rows;
  const pats = cfg.releases.filter((r) => r.tagFormat).map((r) => ({ r, prefix: tagPrefix(r.tagFormat) }));
  if (!pats.length) return rows;
  return rows.map((row) => {
    const found = [];
    for (const ref of row.refs ?? []) {
      if (!ref.startsWith('tag: ')) continue;
      const tag = ref.slice(5);
      for (const { r, prefix } of pats) {
        const version = tag.slice(prefix.length);
        if (tag.startsWith(prefix) && /^\d/.test(version)) { found.push({ tag, release: r.name, label: r.label, version }); break; }
      }
    }
    return found.length ? { ...row, releaseTags: found } : row;
  });
}

export {
  PUBLISH_DEFAULTS, publishHistory, publishStatus, labelReleaseTags,
  PUBLISH_CONFIG, PUBLISH_LOG, readPublishConfig, publishReleases, pickRelease, tagPrefix, publishPlan, compareVersions, lastRelease,
  publishPreflight, checkoutStill, healthMatches, healthCommit, tagRelease, takePublishLock, recordPublish,
  prePushHook, publishInventory, resolvePublishProject,
};
