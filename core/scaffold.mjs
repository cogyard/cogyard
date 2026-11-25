// core/scaffold.mjs — the project-creation/adoption engine.
//
// The SINGLE source of truth both the CLI (`cogyard init` / `cogyard onboard`)
// and the portal (Phase 4 POST through the requireSameOrigin seam) call to turn a
// directory into a first-class cogyard project. Agent-agnostic: no
// `/.claude/` literals. The worktree config — the opt-in the port hook keys on —
// is written to `.cogyard/worktree.json` (task 159); core/worktree-config.mjs
// owns both that path and the old `.claude/` one it replaced.
//
// Two guarantees this module must keep:
//   * IDEMPOTENT — safe to re-run on a half-set-up project; a second run reports
//     everything "present" and changes nothing.
//   * ADDITIVE-ONLY — never overwrites an existing file. Every write is
//     create-if-absent; .gitignore is the one append target (sanctioned, the
//     original content is preserved as a prefix). The whole reason this task
//     exists is to make project creation safe, so clobbering is a hard no.
//
// The one sanctioned edit of existing files is step 9 (task 133): a process
// document — a merge or commit process beside cogyard's skill — is reduced to a
// pointer, and only on the owner's explicit choice. See core/process-docs.mjs.
//
// `ensureProjectWiring()` orchestrates the nine wiring steps; `convertToSharedStore()`
// is the extracted, reusable core of the old cli/tasks.mjs `cmdConvert` (which now
// calls it). Skeleton generators are init-only (onboard adopts what's there).

import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync,
  lstatSync, realpathSync, readlinkSync, symlinkSync, rmSync, cpSync,
} from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { PROJECTS_ROOT } from './paths.mjs';
import { tryExec, execLoud, gitIdentityFlags } from './exec.mjs';
import { readRegistry, registerProject } from './registry.mjs';
import { KINDS, scaffoldFor, platformWarnings } from './scaffolds/index.mjs';
import { WORKTREE_CONFIG } from './worktree-config.mjs';
import { TASKS_DIR, IN_REPO_TASKS_DIR, TASKS_IGNORE, locateTasksDir, tasksDirOf, ensureTasksLinkIgnored } from './tasks-dir.mjs';
import { auditProcess, describeAudit, reconcileProcess } from './process-docs.mjs';

// Kinds come from the scaffold registry: built-ins ship in
// core/scaffolds/builtins.mjs, community kinds drop into ~/.cogyard/scaffolds/.
// Re-exported here so existing consumers (core/config.mjs, routes) keep working.
export { KINDS };

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

// Gives a project its shared task store and the `.cogyard/tasks` link to it,
// ignored by `.cogyard/.gitignore` (the root `.gitignore` is untouched).
// An existing in-repo `_tasks/` folder (IN_REPO_TASKS_DIR) is ADOPTED: copied
// into the new store, verified, then removed from the repo. With nothing to
// adopt, the store starts empty. An old-style `_tasks` LINK is refused with the
// steps to replace it — cogyard no longer reads that name (task 183).
export function convertToSharedStore({ repoRoot, store, remote, log = () => {} }) {
  const found = locateTasksDir(repoRoot);
  if (found) {
    if (lstatSync(found.path).isSymbolicLink()) {
      const target = readlinkSync(found.path);
      // A link to a store that no longer exists (moved or deleted) is not a
      // store: say so instead of "nothing to do" (task 169). Where the store
      // went is unknowable, so this never repoints the link itself.
      if (!existsSync(found.path)) {
        const reg = readRegistry().find((p) => resolve(p.path) === repoRoot);
        const usual = join(PROJECTS_ROOT, '_tasks', reg ? reg.slug : basename(repoRoot));
        const fix = existsSync(usual)
          ? `A store exists at the usual place, ${usual} — if it is this project's, point the link at it: ln -sfn ${JSON.stringify(usual)} ${TASKS_DIR}`
          : `Point the link at the store where it is now (ln -sfn <store path> ${TASKS_DIR}), or remove the link (rm ${TASKS_DIR}) and re-run to start an empty store`;
        throw new Error(`${TASKS_DIR} is a link to ${target}, which does not exist — the store was moved or deleted. ${fix}`);
      }
      return { converted: false, reason: 'already-symlink', store: target };
    }
    throw new Error(`${TASKS_DIR} is a folder, not a link to a task store — rename it to ${IN_REPO_TASKS_DIR}/ (which convert adopts) and re-run`);
  }
  const linkPath = join(repoRoot, TASKS_DIR);
  const srcRel = IN_REPO_TASKS_DIR;
  const srcDir = join(repoRoot, srcRel);
  let srcL = null;
  try { srcL = lstatSync(srcDir); } catch {}
  if (srcL?.isSymbolicLink()) {
    throw new Error(`${srcRel} is an old-style link to a task store (→ ${readlinkSync(srcDir)}), a name cogyard no longer reads. Replace it: link ${TASKS_DIR} to the same target, add /tasks to ${TASKS_IGNORE}, then remove ${srcRel}`);
  }
  const adopt = !!srcL;

  // Clean gate: the conversion commit must contain ONLY the conversion.
  if (adopt) {
    const dirty = tryExec(`git status --porcelain -- ${JSON.stringify(srcRel)}`, { cwd: repoRoot });
    if (dirty) throw new Error(`${srcRel}/ has uncommitted/untracked changes — commit or stash them first:\n${dirty}`);
  }

  // Default store: every project's store lives under ONE parent folder,
  // <PROJECTS_ROOT>/_tasks/<slug> (registry slug when registered, else basename).
  const reg = readRegistry().find((p) => resolve(p.path) === repoRoot);
  const resolvedStore = resolve(String(store || join(PROJECTS_ROOT, '_tasks', reg ? reg.slug : basename(repoRoot))));
  if (resolvedStore === repoRoot || resolvedStore.startsWith(repoRoot + '/')) throw new Error('store must live OUTSIDE the repo (default: <COGYARD_PROJECTS_ROOT>/_tasks/<slug>)');
  if (existsSync(resolvedStore)) throw new Error(`store path already exists: ${resolvedStore} — refusing to merge into an existing directory`);
  for (const p of readRegistry()) {
    let canon = null;
    try { canon = realpathSync(tasksDirOf(p.path)); } catch { continue; }
    if (canon === resolvedStore) throw new Error(`${resolvedStore} is already the task store of registered project "${p.slug}" (${p.path}) — pick a different store`);
  }

  if (adopt) {
    // 1. Copy-first. Never copy a nested .git — the store gets a fresh `git init`.
    cpSync(srcDir, resolvedStore, { recursive: true, filter: (src) => basename(src) !== '.git' });
    // 2. Verify before touching the originals.
    const src = inventoryDir(srcDir);
    const dst = inventoryDir(resolvedStore);
    if (JSON.stringify(src) !== JSON.stringify(dst)) {
      try { rmSync(resolvedStore, { recursive: true, force: true }); } catch {}
      throw new Error('copy verification FAILED (file list/sizes differ) — originals untouched, bad copy removed');
    }
    log(`Copied ${Object.keys(src).length} files → ${resolvedStore} (verified).`);
  } else {
    mkdirSync(resolvedStore, { recursive: true });
    writeFileSync(join(resolvedStore, '.gitkeep'), '');
    log(`Created an empty task store at ${resolvedStore}.`);
  }

  // 3. The store becomes its own git repo on branch `tasks`.
  execLoud('git init -b tasks', { cwd: resolvedStore });
  execLoud('git add .', { cwd: resolvedStore });
  const storeMsg = adopt ? `convert: import ${srcRel} from ${basename(repoRoot)}` : `init: task store for ${basename(repoRoot)}`;
  execLoud(`git ${gitIdentityFlags(resolvedStore)}commit -m ${JSON.stringify(storeMsg)}`, { cwd: resolvedStore });
  if (remote && typeof remote === 'string') {
    execLoud(`git remote add origin ${JSON.stringify(remote)}`, { cwd: resolvedStore });
    try { execLoud('git push -u origin tasks', { cwd: resolvedStore }); }
    catch { log('Push failed — origin is wired; push manually when reachable.'); }
  } else {
    log('Local-only store (no remote). `sync push` will commit locally and skip pushing.');
  }

  // 4. Only now remove the (verified-copied) originals and mount the link.
  // The commit names its paths, so nothing the owner had staged rides along.
  const paths = [];
  if (adopt) {
    execLoud(`git rm -r -q -- ${JSON.stringify(srcRel)}`, { cwd: repoRoot });
    if (existsSync(srcDir)) rmSync(srcDir, { recursive: true, force: true });
    paths.push(srcRel);
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(resolvedStore, linkPath); // ABSOLUTE on purpose — worktrees mount the same target
  if (ensureTasksLinkIgnored(repoRoot)) {
    execLoud(`git add -- ${JSON.stringify(TASKS_IGNORE)}`, { cwd: repoRoot });
    paths.push(TASKS_IGNORE);
  }
  if (paths.length) {
    const msg = adopt ? `convert ${srcRel}/ to shared store at ${resolvedStore}` : `link ${TASKS_DIR} to the shared task store at ${resolvedStore}`;
    execLoud(`git ${gitIdentityFlags(repoRoot)}commit -m ${JSON.stringify(msg)} -- ${paths.map((x) => JSON.stringify(x)).join(' ')}`, { cwd: repoRoot });
  }

  return { converted: true, store: resolvedStore };
}

// --- Join an EXISTING team store -----------------------------------
// Member-#2 onboarding: the team lead ran `convert --remote <url>`; a new member
// clones the project repo and gets no link to the store (it is gitignored) and no
// store. `join` closes that gap in one command: clone the store (branch tasks) to
// <PROJECTS_ROOT>/_tasks/<slug>, mount the absolute link (.cogyard/tasks), register the project.
// Same guarantees as the rest of this module: idempotent (healthy setup → no-op
// messages) and additive-only (never repoints a symlink at a DIFFERENT store).
export function joinSharedStore({ repoRoot, remote, store, slug, log = () => {} }) {
  if (!remote || typeof remote !== 'string') throw new Error('join needs the store remote URL');
  const reg = readRegistry().find((p) => resolve(p.path) === repoRoot);
  const storeName = slug || (reg ? reg.slug : basename(repoRoot));
  const resolvedStore = resolve(String(store || join(PROJECTS_ROOT, '_tasks', storeName)));
  if (resolvedStore === repoRoot || resolvedStore.startsWith(repoRoot + '/')) throw new Error('store must live OUTSIDE the repo (default: <COGYARD_PROJECTS_ROOT>/_tasks/<slug>)');

  const found = locateTasksDir(repoRoot);
  const l = found ? lstatSync(found.path) : null;
  if (l && !l.isSymbolicLink()) {
    throw new Error(`${relative(repoRoot, found.path)} is a folder, not a link to a task store. To publish its tasks, rename it to ${IN_REPO_TASKS_DIR}/ and run "cogyard tasks convert --remote <url>"; otherwise move it aside before joining.`);
  }

  // Store: reuse an existing clone of the SAME remote; clone fresh otherwise.
  if (existsSync(resolvedStore)) {
    const origin = tryExec('git remote get-url origin', { cwd: resolvedStore });
    if (!origin) throw new Error(`store path exists but is not a git clone with an origin: ${resolvedStore}`);
    if (origin !== remote) throw new Error(`store path exists but its origin is ${origin}, not ${remote} — pass a different --store`);
    log(`Store already cloned at ${resolvedStore} (origin matches).`);
  } else {
    mkdirSync(dirname(resolvedStore), { recursive: true });
    execLoud(`git clone -b tasks ${JSON.stringify(remote)} ${JSON.stringify(resolvedStore)}`);
    log(`Cloned store → ${resolvedStore} (branch tasks).`);
  }
  const branch = tryExec('git branch --show-current', { cwd: resolvedStore });
  if (branch !== 'tasks') throw new Error(`store is on branch ${branch || '?'} (expected tasks)`);

  // Mount the ABSOLUTE link `.cogyard/tasks` (worktrees resolve the same target
  // via `mount`). An existing one is kept.
  const tasksDir = l ? found.path : join(repoRoot, TASKS_DIR);
  const name = relative(repoRoot, tasksDir);
  if (l) {
    if (existsSync(tasksDir)) {
      const current = realpathSync(tasksDir);
      if (current === realpathSync(resolvedStore)) log(`${name} already → ${resolvedStore}. Nothing to mount.`);
      else throw new Error(`${name} is a link to a DIFFERENT store (${current}) — refusing to repoint; remove it first if that is intended`);
    } else {
      const old = readlinkSync(tasksDir);
      rmSync(tasksDir);
      symlinkSync(resolvedStore, tasksDir);
      log(`Replaced broken link (was → ${old}) with ${name} → ${resolvedStore}`);
    }
  } else {
    mkdirSync(dirname(tasksDir), { recursive: true });
    symlinkSync(resolvedStore, tasksDir);
    log(`Mounted ${name} → ${resolvedStore}`);
  }

  // Ignore the link: normally already committed by the lead's convert; add only if missing.
  if (ensureTasksLinkIgnored(repoRoot)) {
    log(`Added /tasks to ${TASKS_IGNORE} (uncommitted — the lead's convert usually ships this; commit if yours lacked it).`);
  }

  const entry = registerProject(repoRoot);
  log(`Registered ${entry.slug} → ${entry.path}`);
  return { joined: true, store: resolvedStore, slug: entry.slug };
}

// --- Per-kind skeletons (init-only; create-if-absent) ------------------------
// The per-kind content lives in the scaffold registry (core/scaffolds/); this
// module only asks the resolved descriptor for it.

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

// The descriptor's dev command (task 162): omitted = 'npm run dev', null = the
// kind has no dev server.
const DEFAULT_DEV_SCRIPT = 'npm run dev';
function devScriptFor(desc) {
  return desc.devScript === undefined ? DEFAULT_DEV_SCRIPT : desc.devScript;
}

// The dev entry a kind names (task 164): its command, the `launch_name` the
// config gives it, and the port variable its preview tab opens on. The defaults
// are what every kind wrote before, so a kind that names neither writes the
// same file byte for byte.
//
// `extra` is every further command that binds a port (`extraDevScripts`,
// written as `extra_dev_scripts`), each with its own launch entry; none unless
// the kind names some, and then the key is absent from the file.
function devEntryFor(desc) {
  return {
    devScript: devScriptFor(desc),
    launchName: desc.launchName ?? 'dev',
    previewPortVar: desc.previewPortVar ?? 'FRONTEND_PORT',
    extra: (desc.extraDevScripts || []).map((x) => ({
      devScript: x.devScript, launchName: x.launchName, previewPortVar: x.previewPortVar ?? 'FRONTEND_PORT',
    })),
  };
}

// `devScript` null writes a config with NO dev_script and no preview fields:
// the worktree still gets its ports, and every reader (the session hook, the
// Stop-hook server check — core/worktree-config.mjs devScriptOf) reads the
// missing field as "no dev server here", never as a broken config.
function worktreeConfig(slug, { devScript, launchName, previewPortVar, extra = [] }) {
  if (!devScript) {
    return JSON.stringify({
      _comment: "Worktree port wiring (cogyard). This project has no dev server, so no dev_script is named and no preview entry is registered. Every worktree still gets its own reserved ports, and ~/.cogyard/ports.json is the ONLY place they exist; anything that binds one asks for it at runtime — eval \"$(cogyard env ports --shell || echo 'exit 1')\". See docs/PROJECT-INIT.md.",
      project_name: slug,
      port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
    }, null, 2) + '\n';
  }
  const commands = [devScript, ...extra.map((x) => x.devScript)].map((c) => `\`${c}\``);
  const yours = commands.length === 1 ? commands[0] : `${commands.slice(0, -1).join(', ')} and ${commands.at(-1)}`;
  const cfg = {
    _comment: `Worktree port wiring (cogyard). Every worktree gets its own reserved ports, and ~/.cogyard/ports.json is the ONLY place they exist. Your ${yours} MUST ask for them at runtime — eval "$(cogyard env ports --shell || echo 'exit 1')" — and must never read a copy out of a file: a copy rots, and a rotted copy is how two worktrees silently bind one port. The \`|| echo 'exit 1'\` is load-bearing, because eval reports its own status and not the command's. See docs/PROJECT-INIT.md.`,
    project_name: slug,
    dev_script: devScript,
    launch_name: launchName,
    port_vars: { PORT: 'backend', FRONTEND_PORT: 'frontend' },
    preview_port_var: previewPortVar,
    // No env_files. The ports are asked for at runtime, so there is no copy to
    // merge into a file — which is the whole point. A project that later wants
    // SHARED, non-port dev env vars in its worktrees can add an env_files entry
    // then; it must never carry a port.
  };
  if (extra.length) {
    cfg.extra_dev_scripts = extra.map((x) => ({
      dev_script: x.devScript, launch_name: x.launchName, preview_port_var: x.previewPortVar,
    }));
  }
  return JSON.stringify(cfg, null, 2) + '\n';
}

// The git repo a not-yet-created (or empty) init target would land inside, or
// null. Asks git from the target itself when it exists, else from its nearest
// existing ancestor — the folder the target would be created under. An empty
// target that is its OWN repo (a fresh `git init`) is not "inside" anything.
function enclosingRepo(target) {
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  const top = tryExec('git rev-parse --show-toplevel', { cwd: probe });
  if (!top) return null;
  if (probe === target && realpathSync(top) === realpathSync(target)) return null;
  return top;
}

// prepareInitDir — the greenfield precondition for `init`: create the target dir
// if absent, or accept an empty one; refuse a non-empty dir (that's onboard's
// job). Shared by the CLI and the portal route so both behave identically.
//
// It also refuses a target inside an existing git repo (task 182), BEFORE
// creating anything: the wiring canonicalises to the git toplevel, so it would
// register, gitignore-append and commit into the ENCLOSING repo instead of
// giving the new folder a repo of its own.
export function prepareInitDir(targetPath) {
  const target = resolve(targetPath);
  const outer = enclosingRepo(target);
  if (outer) {
    throw new Error(`${target} is inside the git repo at ${outer} — init creates a project in a folder of its own, ` +
      `and here it would wire that repo instead. Choose a folder outside ${outer}, ` +
      `or adopt that repo itself with \`cogyard onboard ${outer}\` (in the portal: Add existing).`);
  }
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
//
// `reconcile` ({ <cogyard skill>: 'adopt' | 'keep' | 'facts' }) is the owner's
// choice for a process doc that sits beside one of cogyard's skills (step 9).
// Without one, a collision is reported in `warnings` and left for the owner —
// never guessed. The report's `process` is the audit after step 9, so a caller
// that can ask (the CLI, in a terminal) asks about what is left.
export function ensureProjectWiring({
  path: projPath, kind, wiring, remote, scaffold = false, reconcile = {}, log = () => {},
}) {
  if (!projPath) throw new Error('ensureProjectWiring: path is required');
  const desc = scaffoldFor(kind); // throws with the registry's kind list on an unknown kind
  const target = resolve(projPath);
  if (!existsSync(target)) throw new Error(`path does not exist: ${target}`);
  const wantWiring = wiring != null ? wiring : desc.worktreePorts !== false;

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
  // NEVER touch an existing one (warn if it lacks a version, or a script the
  // kind's files rely on — the warning gives the exact line to add). A kind that
  // declares `pkgJson: null` writes none (task 274) — and a pkgJson() that
  // returns no object writes none too, rather than a file holding `null`.
  const pkgPath = join(repoRoot, 'package.json');
  // What the kind would write. Asked for even when a package.json exists, for
  // the scripts it would hold; a kind with no pkgJson() function has none.
  const kindPkg = typeof desc.pkgJson === 'function' ? desc.pkgJson(slug) : null;
  let version;
  if (existsSync(pkgPath)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch {}
    version = pkg?.version || undefined;
    rec('package.json', 'present', version ? `version ${version}` : 'left untouched');
    if (!version) warnings.push('package.json exists but has no "version" — the version rules need one; add it manually.');
    for (const name of desc.requiredScripts || []) {
      const want = kindPkg?.scripts?.[name];
      const have = pkg?.scripts?.[name];
      if (want === undefined || have === want) continue;
      const line = `${JSON.stringify(name)}: ${JSON.stringify(want)}`;
      warnings.push(have === undefined
        ? `package.json has no "${name}" script, which kind "${kind}" needs. onboard never edits an existing package.json — add this line to its "scripts" yourself: ${line}`
        : `package.json's "${name}" script is ${JSON.stringify(have)}, not kind "${kind}"'s. onboard left it as it is; to use the kind's, change it to: ${line}`);
    }
  } else if (desc.pkgJson === null) {
    rec('package.json', 'skipped', `kind=${kind} writes no package.json`);
  } else if (!kindPkg || typeof kindPkg !== 'object' || Array.isArray(kindPkg)) {
    rec('package.json', 'skipped', `kind=${kind} pkgJson() returned no object`);
    warnings.push(`kind "${kind}" pkgJson() returned no object, so no package.json was written — a kind that writes none declares \`pkgJson: null\`.`);
  } else {
    writeFileSync(pkgPath, JSON.stringify(kindPkg, null, 2) + '\n');
    created.push('package.json');
    version = kindPkg.version;
    rec('package.json', 'created', 'minimal, version 0.1.0');
  }

  // 4. .gitignore essentials, plus any line the kind's own files need — append
  // (never replace).
  {
    const giPath = join(repoRoot, '.gitignore');
    const existed = existsSync(giPath);
    const gi = existed ? readFileSync(giPath, 'utf8') : '';
    const present = new Set(gi.split('\n').map((x) => x.trim()));
    const wanted = [...new Set([...GITIGNORE_ESSENTIALS, ...(desc.gitignore || [])])];
    const missing = wanted.filter((x) => !present.has(x) && !present.has(x.replace(/\/$/, '')));
    if (missing.length) {
      const prefix = gi === '' || gi.endsWith('\n') ? gi : gi + '\n';
      writeFileSync(giPath, prefix + '# cogyard wiring\n' + missing.join('\n') + '\n');
      if (!existed) created.push('.gitignore');
      rec('.gitignore', existed ? 'appended' : 'created', `+${missing.length} line(s)`);
    } else {
      rec('.gitignore', 'present', 'essentials already present');
    }
  }

  // 5. per-kind app skeleton (init-only).
  if (scaffold) {
    for (const [rel, content] of Object.entries(desc.skeletonFiles(slug))) ensureFile(rel, content);
  } else {
    rec('skeleton', 'skipped', 'onboard adopts existing files');
  }

  // 6. version + commit stamping (descriptor-gated; library stamps via package.json).
  // A function is the kind's own way to stamp (task 162) — an Xcode build phase,
  // a firmware header — and replaces the npm stamper rather than adding to it.
  // It is told the version on disk, so a file that has to be committed with the
  // version already in it (an Xcode .xcconfig) can be seeded right.
  // `false` with a package.json means the version lives there (library); `false`
  // with `pkgJson: null` means the kind has no version at all (task 274).
  if (typeof desc.versionStamp === 'function') {
    const files = Object.entries(desc.versionStamp(slug, { version }) || {});
    for (const [rel, content] of files) ensureFile(rel, content);
    if (!files.length) rec('version stamp', 'skipped', `kind=${kind} seeds no stamping files`);
  } else if (desc.versionStamp !== false) ensureFile('scripts/generate-version.mjs', generateVersionScript());
  else if (desc.pkgJson === null) rec('scripts/generate-version.mjs', 'skipped', `kind=${kind} has no version to stamp`);
  else rec('scripts/generate-version.mjs', 'skipped', `kind=${kind} stamps via package.json`);

  // 6b. what the kind records about the project it finds (task 164) — e.g. a
  // firmware project's production build environment. Same create-if-absent
  // rule; anything the kind could not tell comes back as a warning. A kind that
  // throws here costs the project no wiring: the failure becomes a warning.
  if (typeof desc.describeProject === 'function') {
    let found = {};
    try { found = desc.describeProject(repoRoot) || {}; }
    catch (e) { found = { warnings: [`kind ${kind} could not look at the project: ${e.message}`] }; }
    for (const [rel, content] of Object.entries(found.files || {})) ensureFile(rel, content);
    warnings.push(...(found.warnings || []));
  }

  // 7. worktree wiring — the REAL opt-in the port hook keys on. Nothing else is
  // seeded: a dev script asks `cogyard env ports` at runtime, so there is no
  // port copy in any file and therefore nothing that can rot out of date.
  if (!wantWiring) {
    rec(WORKTREE_CONFIG, 'skipped', `kind=${kind} opts out of worktree ports`);
  } else {
    ensureFile(WORKTREE_CONFIG, worktreeConfig(slug, devEntryFor(desc)));
  }

  // 7b. onboard only: does what we are adopting look like an npm web app at
  // all? An Xcode project or firmware says the defaults just seeded are wrong;
  // warn and carry on (task 162). init starts from an empty folder — nothing to see.
  if (!scaffold) {
    const seeded = [];
    if (wantWiring && devScriptFor(desc) && created.includes(WORKTREE_CONFIG)) seeded.push(`dev_script "${devScriptFor(desc)}" in ${WORKTREE_CONFIG}`);
    if (desc.versionStamp === true && created.includes('scripts/generate-version.mjs')) seeded.push('scripts/generate-version.mjs');
    warnings.push(...platformWarnings(repoRoot, kind, { seeded }));
  }

  // 8a. what the store step below starts from: an existing `.cogyard/tasks`
  // link (kept), an in-repo `_tasks/` folder the repo already had (adopted into
  // the new store), or nothing (the store starts empty).
  const foundTasks = locateTasksDir(repoRoot);
  const inRepoDir = join(repoRoot, IN_REPO_TASKS_DIR);
  let inRepoL = null;
  try { inRepoL = lstatSync(inRepoDir); } catch {}
  const adoptInRepo = !foundTasks && inRepoL && !inRepoL.isSymbolicLink();
  if (foundTasks) {
    const fl = lstatSync(foundTasks.path);
    rec(`${TASKS_DIR}/`, 'present', fl.isSymbolicLink() ? `symlink → ${readlinkSync(foundTasks.path)}` : 'a folder, not a link to a task store — refused at the store step below');
  } else if (adoptInRepo) {
    rec(`${IN_REPO_TASKS_DIR}/`, 'present', 'in-repo folder — adopted into the shared store below');
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
    if (adoptInRepo) execLoud(`git add -- ${JSON.stringify(IN_REPO_TASKS_DIR)}`, { cwd: repoRoot });
    if (tryExec('git diff --cached --name-only', { cwd: repoRoot })) {
      execLoud(`git ${gitIdentityFlags(repoRoot)}commit -m ${JSON.stringify('chore: cogyard project wiring')}`, { cwd: repoRoot });
      rec('commit', 'created', 'wiring commit');
    } else {
      rec('commit', 'present', 'nothing to commit');
    }
  }

  // 8c. the task store — the only model. convert is the single source of
  // truth; it no-ops when already a symlink (idempotent), refuses a folder at
  // .cogyard/tasks,
  // adopts a pre-existing in-repo _tasks/ folder, or creates an empty store.
  let storePath;
  const r = convertToSharedStore({ repoRoot, remote, log });
  if (r.converted) { storePath = r.store; rec('store', 'created', `shared → ${r.store}`); }
  else { storePath = realpathSync(tasksDirOf(repoRoot)); rec('store', 'present', `already shared → ${storePath}`); }

  // 9. one process, one place (task 133). A merge or commit process in a doc
  // beside cogyard's skill is moved into one place, but only on the owner's
  // choice (`reconcile`); otherwise it is reported and `tasks doctor` keeps
  // flagging it.
  const reconciled = [];
  let audit = auditProcess(repoRoot, { slug });
  for (const skill of [...new Set(audit.collisions.map((c) => c.skill))]) {
    const outcome = reconcile[skill];
    if (!outcome) continue;
    const r = reconcileProcess(repoRoot, { skill, outcome, collisions: audit.collisions, slug });
    reconciled.push({ skill, outcome, ...r });
    rec('process docs', 'created', `${skill}: ${outcome} → ${r.changed.join(', ')} (commit ${r.commit})`);
    for (const n of r.notes) log(`      ${n}`);
  }
  if (reconciled.length) audit = auditProcess(repoRoot, { slug });
  if (!reconciled.length) {
    const left = audit.collisions.length + audit.shadowed.length + audit.stale.length;
    if (left) rec('process docs', 'skipped', `${left} finding(s) — see warnings; nothing changed`);
    else if (audit.reconciled.length) rec('process docs', 'present', `already reconciled (${[...new Set(audit.reconciled.map((x) => `${x.skill}: ${x.outcome}`))].join(', ')})`);
    else rec('process docs', 'present', 'no process doc beside cogyard\'s skills');
  }
  warnings.push(...describeAudit(audit));

  return { repoRoot, slug, kind, storePath, steps, warnings, process: audit, reconciled };
}
