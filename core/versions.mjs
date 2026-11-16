// core/versions.mjs — one short change code per portal cache entry (task 173).
//
// The portal no longer re-downloads every entry on a timer. Every few seconds it
// sends the names of the entries something on screen is reading to
// GET /api/versions and refetches only those whose code moved. A code is a hash
// of everything the entry's endpoint READS, computed from file metadata and git's
// ref files only — zero git processes — so a check costs milliseconds.
//
// THE RULE THAT KEEPS THIS CORRECT: a code must cover every input its endpoint
// reads. Each function below names the endpoint it mirrors; if that endpoint
// starts reading something new, add it here, or the entry can go stale. An entry
// this module has no code for returns null, and the browser then polls it on
// every check exactly as before — a gap costs bandwidth, never freshness. That is
// why Graph, Worktrees and the Files tab deliberately have no code (owner
// decision, 2026-10-06): their uncommitted-change views have no cheap signal.
//
// Codes are deterministic (no process state), so a portal restart changes none
// and causes no refetch. Design + measurements: docs/LIVE-UPDATES.md.

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { COGYARD_HOME, REGISTRY_PATH } from './paths.mjs';
import { uiPrefs } from './config.mjs';
import { readState, keyOf } from './refs.mjs';
import { outputSlugs, briefsDir, heartbeatsDir, driftPath } from './job-output.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { liveSignature } from './live-state.mjs';

// Server-formatted relative ages ("5 minutes ago") in /api/tasks change with the
// clock, not with any file. Folding a coarse clock bucket into that code bounds
// how long such a label can lag; 5 minutes is ~12 task-list fetches an hour,
// against ~514 when it was polled every 7 s.
const CLOCK_BUCKET_MS = 5 * 60 * 1000;

const hash = (parts) => createHash('sha1').update(parts.join('\x1f')).digest('hex').slice(0, 16);
const st = (p) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } };
const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return '-'; } };

// Every entry of a directory (non-recursive) as name:mtime:size, sorted.
// filesOnly skips subdirectories — a stray folder in a store must not move the
// task list's code.
function dirSig(dir, filesOnly = false) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return '-'; }
  return ents.filter((e) => !(filesOnly && e.isDirectory())).map((e) => e.name).sort()
    .map((n) => `${n}:${st(join(dir, n))}`).join('|');
}

// One check computes each repo's / store's signature once, however many entries
// share it (Overview, Activity and the project list all read every repo).
function makeCtx() {
  const memo = new Map();
  const once = (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); };
  return {
    // Every ref tip — what `git log --all` / `--branches` / `rev-parse` walk —
    // plus the linked-worktree admin entries (`git worktree list`: HEAD, gitdir,
    // locked). null when .git is not a plain directory (a linked checkout or a
    // submodule registered directly); the caller then gives up on a code.
    refs: (repo) => once(`refs:${repo}`, () => {
      const gd = join(repo, '.git');
      try { if (!statSync(gd).isDirectory()) return null; } catch { return null; }
      const out = [`HEAD=${read(join(gd, 'HEAD'))}`, `packed=${st(join(gd, 'packed-refs'))}`];
      const walk = (dir, rel) => {
        let ents;
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name}`);
          else out.push(`${rel}/${e.name}=${read(join(dir, e.name))}`);
        }
      };
      walk(join(gd, 'refs'), 'refs');
      let wts = [];
      try { wts = readdirSync(join(gd, 'worktrees')); } catch { /* none */ }
      for (const n of wts) {
        const w = join(gd, 'worktrees', n);
        out.push(`wt/${n}=${read(join(w, 'HEAD'))}|${read(join(w, 'gitdir'))}|${st(join(w, 'locked'))}`);
      }
      return out.sort().join('\n');
    }),
    // Just the checkout tips — main's HEAD and each linked worktree's HEAD
    // (core/refs.mjs readState, the same snapshot the unmerged count and the
    // overview memo key on). Far cheaper than refs() on repos with many remote
    // refs or tags; enough for endpoints that never walk other branches.
    tips: (repo) => once(`tips:${repo}`, () => {
      try { const s = readState(repo); return s.mainSha ? keyOf(s) : null; } catch { return null; }
    }),
    // Local branch tips only (refs/heads + packed-refs + HEAD) — what
    // `git log --branches` and the default branch's first-parent walk read.
    heads: (repo) => once(`heads:${repo}`, () => {
      const gd = join(repo, '.git');
      try { if (!statSync(gd).isDirectory()) return null; } catch { return null; }
      const out = [`HEAD=${read(join(gd, 'HEAD'))}`, `packed=${st(join(gd, 'packed-refs'))}`];
      const walk = (dir, rel) => {
        let ents;
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name}`);
          else out.push(`${rel}/${e.name}=${read(join(dir, e.name))}`);
        }
      };
      walk(join(gd, 'refs', 'heads'), 'refs/heads');
      return out.sort().join('\n');
    }),
    // The task store as the endpoints see it: where the task link resolves to (a
    // re-pointed symlink is a different store) and its files' metadata.
    store: (repo) => once(`store:${repo}`, () => {
      let real;
      try { real = realpathSync(tasksDirOf(repo)); } catch { return 'no-store'; }
      return `${real}\n${dirSig(real, true)}`;
    }),
    // A project's nightly-job output, which lives under $COGYARD_HOME by slug
    // (core/job-output.mjs, task 187) — never in the store — and is also read
    // under each of the project's former slugs (task 195), so those count too.
    // The drift reader decides between slugs by the heartbeats; dailyCode
    // carries those already.
    briefs: (slug) => once(`briefs:${slug}`, () => outputSlugs(slug).map((s) => dirSig(briefsDir(s))).join('\n')),
    heartbeats: (slug) => once(`hb:${slug}`, () => outputSlugs(slug).map((s) => dirSig(heartbeatsDir(s))).join('\n')),
    drift: (slug) => once(`drift:${slug}`, () => outputSlugs(slug).map((s) => st(driftPath(s))).join('\n')),
    usage: () => once('usage', () => dirSig(join(COGYARD_HOME, 'usage'))),
    // What the agent on each claimed task is doing (task 202) — states only,
    // not every event (core/live-state.mjs liveSignature says why).
    live: () => once('live', () => liveSignature()),
  };
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// --- one code per entry, each named for the endpoint it mirrors ---------------

// GET /api/tasks — task files (+ the store's axes.json, in the same dir), task
// staleness against HEAD, `[#NN]` commits across all refs, worktree names and
// branches, the shared axes.json, the registry (label), and relative commit ages.
function tasksCode(ctx, proj) {
  const refs = ctx.refs(proj.path);
  if (refs == null) return null;
  // ctx.live(): the live agent state on claimed tasks (task 202).
  return hash(['tasks', st(REGISTRY_PATH), ctx.store(proj.path), refs, st(join(COGYARD_HOME, 'axes.json')), ctx.live(),
    String(Math.floor(Date.now() / CLOCK_BUCKET_MS))]);
}

// GET /api/branches — ref tips (local + origin), worktree list, and task files
// (the branch → task match reads them).
function branchesCode(ctx, proj) {
  const refs = ctx.refs(proj.path);
  if (refs == null) return null;
  return hash(['branches', ctx.store(proj.path), refs]);
}

// GET /api/plan (task 179) — task files (store), ref tips + worktree admin
// entries (a parked task's unmerged branch commits; which claimed worktrees are
// live; tracked files follow HEAD), and every OTHER project's store, because a
// task elsewhere can depend on ours (`<slug>#<id>`) or ours on it; and the
// live agent state on claimed tasks (task 202).
function planCode(ctx, proj, projects) {
  const refs = ctx.refs(proj.path);
  if (refs == null) return null;
  const parts = ['plan', st(REGISTRY_PATH), ctx.store(proj.path), refs, ctx.live()];
  for (const p of projects) if (!p.error && p.slug !== proj.slug) parts.push(p.slug, ctx.store(p.path));
  return hash(parts);
}

// GET /api/recently-done (task 198) — the task files (store): the newest DONE
// tasks, their titles and checkbox counts; and the store's git history, which
// orders same-day tasks by the commit that closed them — so the refs of the
// store's own repo, or of the project's repo when the store is a folder in it.
// No history at all (a plain folder) is fine: the order then comes from files.
function recentCode(ctx, proj) {
  let real = null;
  try { real = realpathSync(tasksDirOf(proj.path)); } catch { /* no store */ }
  const history = (real && ctx.refs(real)) ?? ctx.refs(proj.path) ?? 'no-history';
  return hash(['recent', ctx.store(proj.path), history]);
}

// GET /api/daily — briefs, heartbeats, the drift report (all under
// $COGYARD_HOME by slug since task 187 — the store is not read), and the
// registry (the answer carries the project's label; found missing by
// test/versions-guard.test.mjs — a rename left Daily on the old name).
function dailyCode(ctx, proj) {
  return hash(['daily', st(REGISTRY_PATH), ctx.briefs(proj.slug), ctx.heartbeats(proj.slug), ctx.drift(proj.slug)]);
}

// GET /api/usage and GET /api/usage/project/<slug> — the usage + activity
// ledgers and claims (all in usage/), and the registry (slug aliases, placement).
function usageCode(ctx) {
  return hash(['usage', st(REGISTRY_PATH), ctx.usage()]);
}

// GET /api/activity — commits per day over every project's LOCAL branches
// (`git log --branches`) and merges on its default branch, the ledgers, the
// registry, and today's date (the window slides at midnight).
function activityCode(ctx, projects) {
  const parts = ['activity', st(REGISTRY_PATH), ctx.usage(), localDay()];
  for (const p of projects) {
    const heads = ctx.heads(p.path);
    if (heads == null) return null;
    parts.push(p.slug, heads);
  }
  return hash(parts);
}

// GET /api/overview — per project: task counts (store), git summary (checkout
// tips + .git/index mtime — exactly the existing memoize signal), unmerged
// count (tips), newest brief; plus the registry (which projects, error rows).
function overviewCode(ctx, projects) {
  const parts = ['overview', st(REGISTRY_PATH)];
  for (const p of projects) {
    if (p.error) { parts.push(p.slug, 'error', p.error); continue; }
    const tips = ctx.tips(p.path);
    if (tips == null) return null;
    parts.push(p.slug, ctx.store(p.path), ctx.briefs(p.slug), tips, st(join(p.path, '.git', 'index')));
  }
  return hash(parts);
}

// GET /api/projects — claimed counts (store) and unmerged counts (checkout tips,
// core/unmerged.mjs) per project, and the registry.
function projectsCode(ctx, projects) {
  const parts = ['projects', st(REGISTRY_PATH)];
  for (const p of projects) {
    if (p.error) { parts.push(p.slug, 'error'); continue; }
    const tips = ctx.tips(p.path);
    if (tips == null) return null;
    parts.push(p.slug, ctx.store(p.path), tips);
  }
  return hash(parts);
}

// GET /api/config — config.json, open-targets.json, the registry, and each
// configured icon file (its version is derived from the file).
function configCode(projects) {
  const parts = ['config', st(join(COGYARD_HOME, 'config.json')), st(join(COGYARD_HOME, 'open-targets.json')), st(REGISTRY_PATH)];
  let icons = {};
  try { icons = uiPrefs().projectIcons || {}; } catch { /* unreadable config → no icons */ }
  for (const [slug, rel] of Object.entries(icons).sort()) {
    const p = projects.find((x) => x.slug === slug);
    parts.push(slug, p ? st(join(p.path, rel)) : '-');
  }
  return hash(parts);
}

// keys: the entry names the browser holds ('tasks|<slug>', 'overview', …).
// projects: core.discoverProjects() for this request. → { [key]: code | null }.
// Any key not listed here — and any project-scoped key whose slug is unknown —
// is null: "no code, poll it".
function versionsFor(keys, projects) {
  const ctx = makeCtx();
  const out = {};
  for (const key of keys) {
    const [family, slug, ...rest] = String(key).split('|');
    const proj = slug ? projects.find((p) => p.slug === slug && !p.error) : null;
    let code = null;
    try {
      if (family === 'tasks' && proj && !rest.length) code = tasksCode(ctx, proj);
      else if (family === 'branches' && proj && !rest.length) code = branchesCode(ctx, proj);
      else if (family === 'daily' && proj && !rest.length) code = dailyCode(ctx, proj);
      else if (family === 'plan' && proj && !rest.length) code = planCode(ctx, proj, projects);
      else if (family === 'recent' && proj && !rest.length) code = recentCode(ctx, proj);
      else if (family === 'usage' && (proj || !slug) && !rest.length) code = usageCode(ctx);
      else if (key === 'activity') code = activityCode(ctx, projects);
      else if (key === 'overview') code = overviewCode(ctx, projects);
      else if (key === 'projects') code = projectsCode(ctx, projects);
      else if (key === 'config') code = configCode(projects);
    } catch { code = null; } // any surprise → poll, never stale
    out[key] = code;
  }
  return out;
}

export { versionsFor, CLOCK_BUCKET_MS };
