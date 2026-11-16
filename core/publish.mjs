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
//     "tag": true,                             // default true
//     "requires": ["DIGITALOCEAN_TOKEN"],      // credentials the deploy needs
//     "checks": ["npm test"] }                 // must pass on the commit first
//
// At least one of `command` / `manual`. Every field is one the publish ACTS
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
  verifyTimeoutMinutes: 10,   // how long Verify waits for /health to show the commit
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

// { declared: false }                         — no file
// { declared: true, error }                   — present but unusable
// { declared: true, deploysOnPush, command, manual, health, tag, requires, checks }
function readPublishConfig(projectRoot) {
  const path = join(projectRoot, PUBLISH_CONFIG);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { declared: false }; }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { declared: true, error: `${PUBLISH_CONFIG} is not valid JSON: ${e.message}` }; }
  const bad = (msg) => ({ declared: true, error: `${PUBLISH_CONFIG}: ${msg}` });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('must be a JSON object');
  const known = new Set(['deploysOnPush', 'command', 'manual', 'health', 'tag', 'requires', 'checks']);
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  if (unknown.length) return bad(`unknown field(s) ${unknown.map((k) => `"${k}"`).join(', ')} — a typo here would silently change what a publish does`);
  if (typeof raw.deploysOnPush !== 'boolean') return bad('needs "deploysOnPush": true or false');
  for (const k of ['command', 'health']) {
    if (raw[k] != null && (typeof raw[k] !== 'string' || !raw[k].trim())) return bad(`"${k}" must be a non-empty string when present`);
  }
  for (const k of ['manual', 'checks']) {
    if (raw[k] != null && (!Array.isArray(raw[k]) || !raw[k].length || raw[k].some((s) => typeof s !== 'string' || !s.trim()))) {
      return bad(`"${k}" must be a non-empty list of non-empty ${k === 'manual' ? 'steps' : 'commands'} when present`);
    }
  }
  if (raw.health != null && !/^https?:\/\/\S+$/.test(raw.health.trim())) return bad('"health" must be an http(s) URL');
  if (raw.tag != null && typeof raw.tag !== 'boolean') return bad('"tag" must be true or false');
  if (raw.requires != null && (!Array.isArray(raw.requires) || !raw.requires.length || raw.requires.some((n) => typeof n !== 'string' || !NAME_RE.test(n)))) {
    return bad('"requires" must be a non-empty list of credential names (letters, digits, _) when present');
  }
  return {
    declared: true,
    deploysOnPush: raw.deploysOnPush,
    command: raw.command?.trim() || null,
    manual: raw.manual ? raw.manual.map((s) => s.trim()) : [],
    health: raw.health?.trim() || null,
    tag: raw.tag !== false,
    requires: raw.requires ?? [],
    checks: raw.checks ? raw.checks.map((s) => s.trim()) : [],
  };
}

// What `cogyard publish <project>` may do with a declaration:
//   { ok: true }  |  { ok: false, reason }
function publishPlan(cfg) {
  if (!cfg.declared) return { ok: false, reason: `no ${PUBLISH_CONFIG} — this project has not declared how it publishes (docs/PUBLISH.md).` };
  if (cfg.error) return { ok: false, reason: cfg.error };
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
function lastRelease(projectRoot, ref = null) {
  const target = ref ?? defaultBranchSync(projectRoot);
  if (!target) return null;
  return git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', target], projectRoot);
}

// Can this checkout be published, and exactly what? A publish ships ONE
// commit, so it must be unambiguous: the default branch, checked out, nothing
// uncommitted, identical to origin's (a platform builds what is pushed), and —
// when tagging — carrying a version newer than the last release.
//
//   { ok: true, branch, sha, short, remote, version, tag, tagHere, previous }
//   { ok: false, reason }
function publishPreflight(projectRoot, { tag = true } = {}) {
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
    if (git(['fetch', '--quiet', '--tags', remote, branch], projectRoot) === null) {
      return { ok: false, reason: `could not fetch ${remote} — a publish must know exactly what ${remote}/${branch} is` };
    }
    const remoteSha = git(['rev-parse', `${remote}/${branch}`], projectRoot);
    if (remoteSha !== sha) {
      const ahead = git(['rev-list', '--count', `${remote}/${branch}..HEAD`], projectRoot);
      const behind = git(['rev-list', '--count', `HEAD..${remote}/${branch}`], projectRoot);
      return { ok: false, reason: `${branch} is ${ahead} ahead / ${behind} behind ${remote}/${branch} — push or pull until they match, so the deploy builds the commit that gets tagged` };
    }
  }

  const out = { ok: true, branch, sha, short: sha.slice(0, 7), remote, version: null, tag: null, tagHere: false, previous: lastRelease(projectRoot, sha) };
  if (!tag) return out;

  let version = null;
  try { version = JSON.parse(git(['show', `${sha}:package.json`], projectRoot) ?? '').version ?? null; } catch { /* none */ }
  if (typeof version !== 'string' || !version) {
    return { ok: false, reason: `no "version" in package.json at ${out.short} to tag — add one, or set "tag": false in ${PUBLISH_CONFIG}` };
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return { ok: false, reason: `version "${version}" at ${out.short} is not plain x.y.z, so it can't be compared with the last release — use x.y.z, or set "tag": false in ${PUBLISH_CONFIG}` };
  }
  out.version = version;
  out.tag = `v${version}`;
  const tagAt = git(['rev-parse', '--verify', '--quiet', `refs/tags/${out.tag}^{commit}`], projectRoot);
  if (tagAt && tagAt !== sha) {
    return { ok: false, reason: `${out.tag} already marks ${tagAt.slice(0, 7)} — ${out.short} needs a new version before it can be published (the merge to main bumps it)` };
  }
  out.tagHere = !!tagAt;
  if (!out.tagHere && out.previous) {
    const cmp = compareVersions(version, out.previous.replace(/^v/, ''));
    if (cmp === null) {
      return { ok: false, reason: `the last release tag ${out.previous} is not plain vX.Y.Z, so ${version} can't be proven newer — fix or remove that tag first` };
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
// publish?". `projects` is the registry's [{slug, label, path}].
function publishInventory(projects) {
  return projects.map((p) => ({
    slug: p.slug,
    label: p.label ?? p.slug,
    path: p.path,
    ...readPublishConfig(p.path),
    prePushHook: prePushHook(p.path),
    lastRelease: lastRelease(p.path),
  }));
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
async function publishStatus(project) {
  const root = project.path;
  const declaration = readPublishConfig(root);
  const branch = defaultBranchSync(root);
  const remote = (git(['remote'], root) ?? '').split('\n').includes(PUBLISH_DEFAULTS.remote) ? PUBLISH_DEFAULTS.remote : null;
  const tipRef = branch ? (remote ? `${remote}/${branch}` : branch) : null;
  const tipSha = tipRef ? git(['rev-parse', '--verify', '--quiet', `${tipRef}^{commit}`], root) : null;

  const lastTag = lastRelease(root, tipSha ?? undefined);
  const lastReleaseInfo = lastTag ? {
    tag: lastTag,
    short: (git(['rev-parse', `${lastTag}^{commit}`], root) ?? '').slice(0, 7) || null,
    date: git(['log', '-1', '--format=%cI', `${lastTag}^{commit}`], root),
    unreleased: Number(git(['rev-list', '--count', `${lastTag}..${tipSha}`], root) ?? 0),
  } : null;

  let live = null;
  if (declaration.declared && !declaration.error && declaration.health) {
    const r = await readLive(declaration.health);
    live = {
      url: declaration.health,
      reachable: r.reachable,
      commit: r.commit,
      servesTip: !!(tipSha && r.body && healthMatches(r.body, tipSha)),
    };
  }

  let version = null;
  if (tipSha) {
    try { version = JSON.parse(git(['show', `${tipSha}:package.json`], root) ?? '').version ?? null; } catch { /* none */ }
  }

  return {
    slug: project.slug,
    declaration,
    credentials: declaration.declared && !declaration.error
      ? declaration.requires.map((name) => ({ name, set: hasSecret(name) }))
      : [],
    tip: tipSha ? { ref: tipRef, short: tipSha.slice(0, 7), version } : null,
    lastRelease: lastReleaseInfo,
    live,
    prePushHook: prePushHook(root),
    history: publishHistory(project.slug),
    defaults: { ...PUBLISH_DEFAULTS, branch },
  };
}

export {
  PUBLISH_DEFAULTS, publishHistory, publishStatus,
  PUBLISH_CONFIG, PUBLISH_LOG, readPublishConfig, publishPlan, compareVersions, lastRelease,
  publishPreflight, checkoutStill, healthMatches, healthCommit, tagRelease, takePublishLock, recordPublish,
  prePushHook, publishInventory, resolvePublishProject,
};
