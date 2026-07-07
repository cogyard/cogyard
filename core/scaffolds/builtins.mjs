// core/scaffolds/builtins.mjs — the four built-in project kinds.
//
// Each kind is a self-describing SCAFFOLD DESCRIPTOR: a creation-time template
// (package.json shape + skeleton files + wiring defaults) plus the one-line
// human description the portal shows. Extracted from the former hardcoded
// KINDS array + per-kind switch branches in core/scaffold.mjs — behavior
// unchanged, now data the registry serves.
//
// A scaffold is NOT an add-on: it has no status/actions/prereqs and renders no
// Settings card; it's resolved once at `init`. The descriptor contract lives in
// core/scaffolds/index.mjs (the registry).

// Worktree-ports note for READMEs of kinds that run a dev server.
function portsNote(kind) {
  if (kind === 'library') return '';
  return `
## Worktree ports

Each cogyard worktree reserves a unique port pair. The SessionStart hook writes
them into \`.env.worktree\` (gitignored). Your \`npm run dev\` must read them — e.g.
\`. ./.env.worktree\` then bind \`$FRONTEND_PORT\` (and \`$PORT\` for a backend) — so the
preview lands on the reserved port. **Never hardcode a port.**${kind === 'static' ? ' The seeded `dev` script already does this.' : ''}
`;
}

function readme(slug, kind) {
  const stampLine = kind === 'library'
    ? ''
    : '\nVersion + commit are stamped at build time via `scripts/generate-version.mjs`.\n';
  return `# ${slug}

A cogyard \`${kind}\` project — cogyard has wired up git, portal registration, and a shared
task store.
${stampLine}
**cogyard does not scaffold application code.** Build the app yourself; the usual flow is to
make it your first task — open the project in your agent and scaffold the app (framework,
entry points, dev server) as task 1.
${portsNote(kind)}`;
}

// Common package.json base; descriptors specialize it.
function basePkg(slug) {
  return {
    name: slug,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { 'generate-version': 'node scripts/generate-version.mjs' },
  };
}

const single = {
  kind: 'single',
  description: 'One Node app in one folder — the minimal wiring; bring your own app + dev workflow.',
  worktreePorts: true,
  versionStamp: true,
  pkgJson(slug) { return basePkg(slug); },
  skeletonFiles(slug) {
    return { 'README.md': readme(slug, 'single') };
  },
};

const fullstack = {
  kind: 'fullstack',
  description: 'Wiring for a frontend + backend + SQL monorepo; scaffold the app shape yourself.',
  worktreePorts: true,
  versionStamp: true,
  pkgJson(slug) { return basePkg(slug); },
  skeletonFiles(slug) {
    return {
      'README.md': readme(slug, 'fullstack')
        + '\nA frontend + backend + SQL monorepo is the usual target here (e.g. Angular + Node/Express).\n',
    };
  },
};

const staticKind = {
  kind: 'static',
  description: "Static-site wiring with a working dev script bound to the worktree's reserved port; add your own index.html.",
  worktreePorts: true,
  versionStamp: true,
  pkgJson(slug) {
    const pkg = basePkg(slug);
    // `static` is the one kind with an unambiguous server, so seed a WORKING dev
    // script (pure wiring, not app code): source .env.worktree (the SessionStart
    // hook writes this worktree's reserved ports there) and bind $FRONTEND_PORT —
    // so the preview lands on the reserved port, not a hardcoded one. It serves the
    // project dir; drop in your own index.html.
    pkg.scripts['dev'] = '[ -f .env.worktree ] && . ./.env.worktree; python3 -m http.server ${FRONTEND_PORT:-8044}';
    return pkg;
  },
  skeletonFiles(slug) {
    return { 'README.md': readme(slug, 'static') };
  },
};

const library = {
  kind: 'library',
  description: 'Publishable Node library wiring — no dev server, no worktree ports; add your own src/index.mjs.',
  worktreePorts: false,
  versionStamp: false, // a library stamps via package.json
  pkgJson(slug) {
    const pkg = basePkg(slug);
    delete pkg.private;
    delete pkg.scripts['generate-version'];
    pkg.main = 'src/index.mjs';
    return pkg;
  },
  skeletonFiles(slug) {
    return { 'README.md': readme(slug, 'library') };
  },
};

export const BUILTIN_SCAFFOLDS = [single, fullstack, staticKind, library];
