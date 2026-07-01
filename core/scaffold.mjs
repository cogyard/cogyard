// core/scaffold.mjs — the project-creation/adoption engine (task 046).
//
// The SINGLE source of truth both the CLI (`cogyard init` / `cogyard onboard`)
// and the portal (Phase 4 POST through the requireSameOrigin seam) call to turn a
// directory into a first-class cogyard project. Agent-agnostic (task 038): no
// `/.claude/` literals beyond the worktree-config path that the port hook itself
// keys on — that path is the documented opt-in, not a Claude-specific behaviour.
//
// Two guarantees this module must keep:
//   * IDEMPOTENT — safe to re-run on a half-set-up project; a second run reports
//     everything "present" and changes nothing.
//   * ADDITIVE-ONLY — never overwrites an existing file. Every write is
//     create-if-absent; .gitignore is the one append target (sanctioned, the
//     original content is preserved as a prefix). The whole reason this task
//     exists is to make project creation safe, so clobbering is a hard no.
//
// `ensureProjectWiring()` orchestrates the eight wiring steps; `convertToSharedStore()`
// is the extracted, reusable core of the old cli/tasks.mjs `cmdConvert` (which now
// calls it). Skeleton generators are init-only (onboard adopts what's there).

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync,
  lstatSync, realpathSync, readlinkSync, symlinkSync, rmSync, cpSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { PROJECTS_ROOT } from './paths.mjs';
import { tryExec, execLoud } from './exec.mjs';
import { readRegistry, registerProject } from './registry.mjs';

export const KINDS = ['single', 'fullstack', 'static', 'library'];

// --- Shared-store conversion (extracted from cli/tasks.mjs cmdConvert) --------
// Throws Error on failure (the CLI maps that to its `fail()`); calls log(msg) for
// progress so both the CLI and the portal can render it. Returns
// { converted: true, store } or { converted: false, reason: 'already-symlink', store }.

// Recursive {relPath: size} inventory for copy verification. Skips .git.
function inventoryDir(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const f of readdirSync(dir).sort()) {
      if (f === '.git') continue;
      const p = join(dir, f);
      const r = rel ? `${rel}/${f}` : f;
      const st = statSync(p);
      if (st.isDirectory()) walk(p, r);
      else out[r] = st.size;
    }
  };
  walk(root, '');
  return out;
}

// A `git commit` needs a resolvable author identity. Fresh machines often have
// none configured, which would break `init`/`convert` (the OSS clean-machine
// gate hit exactly this). Fall back to a neutral cogyard identity ONLY when the
// user has none — otherwise their configured identity is used.
function gitIdentityFlags(cwd) {
  const name = tryExec('git config user.name', { cwd });
  const email = tryExec('git config user.email', { cwd });
  return (name && email) ? '' : '-c user.name=cogyard -c user.email=cogyard@localhost ';
}

export function convertToSharedStore({ repoRoot, store, remote, log = () => {} }) {
  const tasksDir = join(repoRoot, '_tasks');
  let l = null;
  try { l = lstatSync(tasksDir); } catch {}
  if (!l) throw new Error('no _tasks/ to convert — create it first');
  if (l.isSymbolicLink()) {
    return { converted: false, reason: 'already-symlink', store: readlinkSync(tasksDir) };
  }

  // Clean gate: the conversion commit must contain ONLY the conversion.
  const dirty = tryExec('git status --porcelain -- _tasks', { cwd: repoRoot });
  if (dirty) throw new Error(`_tasks/ has uncommitted/untracked changes — commit or stash them first:\n${dirty}`);

  // Default store: every project's store lives under ONE parent folder,
  // <PROJECTS_ROOT>/_tasks/<slug> (registry slug when registered, else basename).
  const reg = readRegistry().find((p) => resolve(p.path) === repoRoot);
  const resolvedStore = resolve(String(store || join(PROJECTS_ROOT, '_tasks', reg ? reg.slug : basename(repoRoot))));
  if (resolvedStore === repoRoot || resolvedStore.startsWith(repoRoot + '/')) throw new Error('store must live OUTSIDE the repo (default: <COGYARD_PROJECTS_ROOT>/_tasks/<slug>)');
  if (existsSync(resolvedStore)) throw new Error(`store path already exists: ${resolvedStore} — refusing to merge into an existing directory`);
  for (const p of readRegistry()) {
    let canon = null;
    try { canon = realpathSync(join(p.path, '_tasks')); } catch { continue; }
    if (canon === resolvedStore) throw new Error(`${resolvedStore} is already the canonical _tasks of registered project "${p.slug}" (${p.path}) — pick a different store`);
  }

  // 1. Copy-first. Never copy a nested .git — the store gets a fresh `git init`.
  cpSync(tasksDir, resolvedStore, { recursive: true, filter: (src) => basename(src) !== '.git' });
  // 2. Verify before touching the originals.
  const src = inventoryDir(tasksDir);
  const dst = inventoryDir(resolvedStore);
  if (JSON.stringify(src) !== JSON.stringify(dst)) {
    try { rmSync(resolvedStore, { recursive: true, force: true }); } catch {}
    throw new Error('copy verification FAILED (file list/sizes differ) — originals untouched, bad copy removed');
  }
  log(`Copied ${Object.keys(src).length} files → ${resolvedStore} (verified).`);

  // 3. The store becomes its own git repo on branch `tasks`.
  execLoud('git init -b tasks', { cwd: resolvedStore });
  execLoud('git add .', { cwd: resolvedStore });
  execLoud(`git ${gitIdentityFlags(resolvedStore)}commit -m ${JSON.stringify(`convert: import _tasks from ${basename(repoRoot)}`)}`, { cwd: resolvedStore });
  if (remote && typeof remote === 'string') {
    execLoud(`git remote add origin ${JSON.stringify(remote)}`, { cwd: resolvedStore });
    try { execLoud('git push -u origin tasks', { cwd: resolvedStore }); }
    catch { log('Push failed — origin is wired; push manually when reachable.'); }
  } else {
    log('Local-only store (no remote). `sync push` will commit locally and skip pushing.');
  }

  // 4. Only now remove the (verified-copied) originals and mount the symlink.
  execLoud('git rm -r -q _tasks', { cwd: repoRoot });
  if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true, force: true });
  symlinkSync(resolvedStore, tasksDir); // ABSOLUTE on purpose — worktrees mount the same target
  const giPath = join(repoRoot, '.gitignore');
  const gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  if (!gi.split('\n').some((x) => x.trim() === '_tasks' || x.trim() === '_tasks/')) {
    writeFileSync(giPath, gi + (gi === '' || gi.endsWith('\n') ? '' : '\n') + '# task system: _tasks is a symlink to the shared store (cogyard convert)\n_tasks\n');
  }
  execLoud('git add .gitignore', { cwd: repoRoot });
  execLoud(`git ${gitIdentityFlags(repoRoot)}commit -m ${JSON.stringify(`convert _tasks/ to shared store at ${resolvedStore}`)}`, { cwd: repoRoot });

  return { converted: true, store: resolvedStore };
}

// --- Per-kind skeletons (init-only; create-if-absent) ------------------------

function pkgJson(slug, kind) {
  const base = {
    name: slug,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: {},
  };
  if (kind !== 'library') base.scripts['generate-version'] = 'node scripts/generate-version.mjs';
  // `static` is the one kind with an unambiguous server, so seed a WORKING dev:
  // source .env.worktree (the SessionStart hook writes this worktree's reserved
  // ports there) and bind $FRONTEND_PORT — so the preview lands on the reserved
  // port, not a hardcoded one. Replaceable starter; other kinds leave `dev` to the
  // developer/scaffold (the worktree-config _comment documents the contract).
  if (kind === 'static') base.scripts['dev'] = '[ -f .env.worktree ] && . ./.env.worktree; python3 -m http.server ${FRONTEND_PORT:-8044}';
  if (kind === 'library') { delete base.private; base.main = 'src/index.mjs'; }
  return JSON.stringify(base, null, 2) + '\n';
}

// generate-version.mjs, modelled on this repo's own (commits d216063/401652d):
// one build-time source for version + commit. Writes version.json at the repo
// root (the generic target — a frontend project moves the output to
// frontend/src/ in its own build wiring). Gitignored, never hand-edited.
function generateVersionScript() {
  return `#!/usr/bin/env node
// scripts/generate-version.mjs — the SINGLE build-time source of version + commit.
// Writes version.json from the ROOT package.json version + the short git HEAD.
// Run at build time; import it where the app shows its build stamp. Generated +
// gitignored — never hand-edit. (Pattern from cogyard's own generate-version.mjs.)

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
let commit = null;
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
catch { /* no git (packaged tree) — commit stays null */ }
writeFileSync(join(ROOT, 'version.json'), JSON.stringify({ version, commit }, null, 2) + '\\n');
process.stdout.write(\`generate-version: v\${version} (\${commit || 'no-git'}) → version.json\\n\`);
`;
}

function skeletonFiles(slug, kind) {
  // Returns { relPath: content } for files this kind seeds. README is universal.
  const portsNote = kind === 'library' ? '' : `
## Worktree ports

Each cogyard worktree reserves a unique port pair. The SessionStart hook writes
them into \`.env.worktree\` (gitignored). Your \`npm run dev\` must read them — e.g.
\`. ./.env.worktree\` then bind \`$FRONTEND_PORT\` (and \`$PORT\` for a backend) — so the
preview lands on the reserved port. **Never hardcode a port.**${kind === 'static' ? ' The seeded `dev` script already does this.' : ''}
`;
  const readme = `# ${slug}\n\nA cogyard \`${kind}\` project.\n\nVersion + commit are stamped at build time via \`scripts/generate-version.mjs\`.\n${portsNote}`;
  const files = { 'README.md': readme };
  if (kind === 'single') {
    files['index.mjs'] = `// ${slug} — entry point\nconsole.log('hello from ${slug}');\n`;
  } else if (kind === 'library') {
    files['src/index.mjs'] = `// ${slug} — library entry\nexport const hello = () => 'hello from ${slug}';\n`;
  } else if (kind === 'static') {
    files['index.html'] = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${slug}</title></head>
<body>
  <main><h1>${slug}</h1><p>A cogyard static site.</p></main>
  <footer><small id="version-stamp"></small></footer>
  <script type="module">
    // Build wiring: \`node scripts/generate-version.mjs\` writes version.json.
    fetch('version.json').then((r) => r.ok ? r.json() : null).then((v) => {
      if (v) document.getElementById('version-stamp').textContent = \`v\${v.version}\${v.commit ? ' (' + v.commit + ')' : ''}\`;
    }).catch(() => {});
  </script>
</body>
</html>
`;
  } else if (kind === 'fullstack') {
    files['README.md'] = readme + `\nScaffold the monorepo shape (Angular + Node/Express + SQL) with the \`bd-scaffold-fullstack\` skill — this seeds only the cogyard wiring.\n`;
  }
  return files;
}

function worktreeConfig(slug, kind) {
  return JSON.stringify({
    _comment: "Worktree port wiring (cogyard). The SessionStart hook merges this worktree's reserved PORT/FRONTEND_PORT into .env.worktree. Your `npm run dev` MUST read those — source .env.worktree and bind $FRONTEND_PORT (and $PORT) — never hardcode a port, or the preview lands on the wrong one. See docs/PROJECT-INIT.md.",
    project_name: slug,
    kind,
    dev_script: 'npm run dev',
    launch_name: 'dev',
    port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
    preview_port_var: 'FRONTEND_PORT',
    // Merge the reserved ports into .env.worktree so the dev script can source
    // them (the cogyard dev.sh pattern). The hook skips a merge whose source is
    // missing, so ensureProjectWiring also seeds .env.worktree.defaults.
    env_files: [{ source: '.env.worktree.defaults', target: '.env.worktree', strategy: 'merge' }],
  }, null, 2) + '\n';
}

// Base env merged per-worktree into the (gitignored) .env.worktree; committed.
function envWorktreeDefaults(slug) {
  return `# .env.worktree.defaults — base dev env for ${slug}.
# The cogyard SessionStart hook copies this to .env.worktree in each worktree and
# appends that worktree's reserved ports (PORT, FRONTEND_PORT). Add shared dev env
# vars here. Your dev script should: \`. ./.env.worktree\` then bind $FRONTEND_PORT.
# .env.worktree itself is generated per-worktree and gitignored — never commit it.
`;
}

// prepareInitDir — the greenfield precondition for `init`: create the target dir
// if absent, or accept an empty one; refuse a non-empty dir (that's onboard's
// job). Shared by the CLI and the portal route so both behave identically.
export function prepareInitDir(targetPath) {
  const target = resolve(targetPath);
  if (existsSync(target)) {
    const entries = readdirSync(target).filter((f) => f !== '.git');
    if (entries.length) throw new Error(`${target} already exists and is non-empty — use onboard to adopt it`);
    return { target, created: false };
  }
  mkdirSync(target, { recursive: true });
  return { target, created: true };
}

// --- The shared wiring core --------------------------------------------------

const GITIGNORE_ESSENTIALS = [
  'node_modules',
  'dist/',
  'version.json',
  '.claude/launch.json',
  '.env.worktree',
];

// ensureProjectWiring — turn an existing directory (with or without git) into a
// first-class cogyard project. Idempotent + additive-only. Returns a report:
//   { repoRoot, slug, store, steps: [{ step, status, detail }], warnings: [...] }
// where status is 'created' | 'present' | 'appended' | 'skipped'.
//
// `scaffold` (default false) gates the per-kind app skeleton: init passes true,
// onboard false (it adopts what's there). The shared wiring runs for both.
export function ensureProjectWiring({
  path: projPath, kind, store = 'shared', wiring, remote, scaffold = false, log = () => {},
}) {
  if (!projPath) throw new Error('ensureProjectWiring: path is required');
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind} (one of ${KINDS.join(', ')})`);
  if (store !== 'shared' && store !== 'normal') throw new Error(`unknown store model: ${store} (shared|normal)`);
  const target = resolve(projPath);
  if (!existsSync(target)) throw new Error(`path does not exist: ${target}`);
  const wantWiring = wiring != null ? wiring : kind !== 'library';

  const steps = [];
  const warnings = [];
  const created = [];
  const rec = (step, status, detail) => {
    steps.push({ step, status, detail });
    const glyph = { created: '+', appended: '~', present: '·', skipped: '–' }[status] || '✓';
    log(`  ${glyph} ${step.padEnd(28)} ${detail}`);
  };
  const ensureFile = (rel, content) => {
    const p = join(target, rel);
    if (existsSync(p)) { rec(rel, 'present', 'left untouched (additive-only)'); return false; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    created.push(rel);
    rec(rel, 'created', 'written');
    return true;
  };

  // 1. git — ensure a repo (init if absent). Capture pre-state to decide commit shape.
  const hadGit = !!tryExec('git rev-parse --show-toplevel', { cwd: target });
  if (!hadGit) {
    execLoud('git init -b main', { cwd: target });
    rec('git', 'created', 'git init -b main');
  } else {
    rec('git', 'present', 'repo already initialised');
  }
  // Canonicalise to the git toplevel so register/convert agree on the path.
  const repoRoot = tryExec('git rev-parse --show-toplevel', { cwd: target }) || target;
  const hadCommits = !!tryExec('git rev-parse --verify --quiet HEAD', { cwd: repoRoot });

  // 2. register — portal visibility (the step skipped on cogyard-site). Early so
  // the store slug is settled before convert computes its default.
  const already = readRegistry().some((p) => resolve(p.path) === repoRoot);
  const entry = registerProject(repoRoot);
  rec('register', already ? 'present' : 'created', `${entry.slug} → portal`);
  const slug = entry.slug;

  // 3. root package.json with a version — the release counter. Create if absent;
  // NEVER touch an existing one (warn if it lacks a version).
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, pkgJson(slug, kind));
    created.push('package.json');
    rec('package.json', 'created', 'minimal, version 0.1.0');
  } else {
    let v = null;
    try { v = JSON.parse(readFileSync(pkgPath, 'utf8')).version; } catch {}
    rec('package.json', 'present', v ? `version ${v}` : 'left untouched');
    if (!v) warnings.push('package.json exists but has no "version" — the version rules need one; add it manually.');
  }

  // 4. .gitignore essentials — append (never replace).
  {
    const giPath = join(repoRoot, '.gitignore');
    const existed = existsSync(giPath);
    const gi = existed ? readFileSync(giPath, 'utf8') : '';
    const present = new Set(gi.split('\n').map((x) => x.trim()));
    const missing = GITIGNORE_ESSENTIALS.filter((x) => !present.has(x) && !present.has(x.replace(/\/$/, '')));
    if (missing.length) {
      const prefix = gi === '' || gi.endsWith('\n') ? gi : gi + '\n';
      writeFileSync(giPath, prefix + '# cogyard wiring (task 046)\n' + missing.join('\n') + '\n');
      if (!existed) created.push('.gitignore');
      rec('.gitignore', existed ? 'appended' : 'created', `+${missing.length} line(s)`);
    } else {
      rec('.gitignore', 'present', 'essentials already present');
    }
  }

  // 5. per-kind app skeleton (init-only).
  if (scaffold) {
    for (const [rel, content] of Object.entries(skeletonFiles(slug, kind))) ensureFile(rel, content);
  } else {
    rec('skeleton', 'skipped', 'onboard adopts existing files');
  }

  // 6. version + commit stamping (no-op for library — it exposes version via package.json).
  if (kind !== 'library') ensureFile('scripts/generate-version.mjs', generateVersionScript());
  else rec('scripts/generate-version.mjs', 'skipped', 'library stamps via package.json');

  // 7. worktree wiring — the REAL opt-in the port hook keys on. Pair it with a
  // committed .env.worktree.defaults so the hook's env_files merge has a source
  // to write the reserved ports into (a dev script sources .env.worktree).
  if (wantWiring) {
    ensureFile('.claude/worktree-config.json', worktreeConfig(slug, kind));
    ensureFile('.env.worktree.defaults', envWorktreeDefaults(slug));
  } else {
    rec('.claude/worktree-config.json', 'skipped', `kind=${kind} opts out of worktree ports`);
  }

  // 8a. ensure _tasks/ exists (so the store step has something to convert / mount).
  const tasksDir = join(repoRoot, '_tasks');
  let tl = null;
  try { tl = lstatSync(tasksDir); } catch {}
  if (!tl) {
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, '.gitkeep'), '');
    rec('_tasks/', 'created', 'empty store seeded');
  } else if (tl.isSymbolicLink()) {
    rec('_tasks/', 'present', `symlink → ${readlinkSync(tasksDir)}`);
  } else {
    rec('_tasks/', 'present', 'normal directory');
  }

  // 8b. commit our additions so the store step (convert) sees a clean, tracked _tasks.
  if (!hadCommits) {
    execLoud('git add -A', { cwd: repoRoot });
    if (tryExec('git diff --cached --name-only', { cwd: repoRoot })) {
      execLoud(`git ${gitIdentityFlags(repoRoot)}commit -m ${JSON.stringify('chore: initial commit (cogyard)')}`, { cwd: repoRoot });
      rec('commit', 'created', 'initial commit');
    }
  } else {
    for (const rel of created) execLoud(`git add ${JSON.stringify(rel)}`, { cwd: repoRoot });
    if (existsSync(tasksDir) && !(tl && tl.isSymbolicLink())) execLoud('git add _tasks', { cwd: repoRoot });
    if (tryExec('git diff --cached --name-only', { cwd: repoRoot })) {
      execLoud(`git ${gitIdentityFlags(repoRoot)}commit -m ${JSON.stringify('chore: cogyard project wiring')}`, { cwd: repoRoot });
      rec('commit', 'created', 'wiring commit');
    } else {
      rec('commit', 'present', 'nothing to commit');
    }
  }

  // 8c. task store — shared by default (the `⚠ no _tasks` fix). convert is the
  // single source of truth; it no-ops when already a symlink (idempotent).
  let storePath = realpathSync(tasksDir);
  if (store === 'shared') {
    const r = convertToSharedStore({ repoRoot, remote, log });
    if (r.converted) { storePath = r.store; rec('store', 'created', `shared → ${r.store}`); }
    else { storePath = realpathSync(tasksDir); rec('store', 'present', `already shared → ${storePath}`); }
  } else {
    rec('store', 'present', `normal (in-repo _tasks/)`);
  }

  return { repoRoot, slug, kind, store, storePath, steps, warnings };
}
