// core/scaffolds/builtins.mjs — the built-in project kinds: four for an npm web
// app (single, fullstack, static, library), one for a project with no code
// (research, task 274), one for an Xcode app (apple, task 163) and one for
// PlatformIO firmware (firmware, task 164).
//
// Each kind is a self-describing SCAFFOLD DESCRIPTOR: a creation-time template
// (package.json shape + skeleton files + wiring defaults) plus the one-line
// human description the portal shows. The first four were extracted from the
// former hardcoded KINDS array + per-kind switch branches in core/scaffold.mjs;
// `apple` (task 163) and `firmware` (task 164) are the ones that are not npm
// web apps.
//
// A scaffold is NOT an add-on: it has no status/actions/prereqs and renders no
// Settings card; it's resolved once at `init`. The descriptor contract lives in
// core/scaffolds/index.mjs (the registry).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Worktree-ports note for READMEs of kinds that run a dev server.
function portsNote(kind) {
  if (kind === 'library') return '';
  return `
## Worktree ports

Each cogyard worktree reserves a unique port pair, and \`~/.cogyard/ports.json\` is
the only place those numbers exist. Your \`npm run dev\` must ask for them when it
starts:

\`\`\`
eval "$(cogyard env ports --shell || echo 'exit 1')" && <your dev command>
\`\`\`

That binds \`$FRONTEND_PORT\` (and \`$PORT\` for a backend). Outside a worktree the
command prints nothing and your own defaults stand. **Never hardcode a port, and
never read one out of a file** — a copy goes stale, and a stale copy is how two
worktrees end up on the same port without anyone noticing. Keep the
\`|| echo 'exit 1'\`: \`eval\` reports its own exit status rather than the command's,
so without it a failed lookup would start the server on whatever port was lying
around.${kind === 'static' ? ' The seeded `dev` script already does this.' : ''}
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
  devScript: 'npm run dev',
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
  devScript: 'npm run dev',
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
  devScript: 'npm run dev', // the seeded script below
  versionStamp: true,
  pkgJson(slug) {
    const pkg = basePkg(slug);
    // `static` is the one kind with an unambiguous server, so seed a WORKING dev
    // script (pure wiring, not app code): ask cogyard for this worktree's reserved
    // port and bind it, so the preview lands there rather than on a hardcoded
    // number. It serves the project dir; drop in your own index.html.
    //
    // Three behaviours, all deliberate: no cogyard on PATH (a plain clone) prints
    // nothing and 8044 stands; cogyard outside a worktree prints nothing and 8044
    // stands; cogyard inside a worktree either exports the port or FAILS the
    // script. Do not simplify to `eval "$(cogyard env ports --shell)"` — eval
    // reports its own status, not the command's, so a failed lookup would fall
    // back to 8044 and collide with every other worktree.
    pkg.scripts['dev'] = 'eval "$(command -v cogyard >/dev/null 2>&1 && { cogyard env ports --shell || echo \'exit 1\'; })" && python3 -m http.server "${FRONTEND_PORT:-8044}"';
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
  devScript: null,
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

// research (task 274) — a project whose output is markdown: notes, sources,
// findings. No package.json, so no build, no version and nothing to publish;
// no dev server and no worktree ports. The README is the only instruction file
// it seeds, and it carries the how-to-work-here text: core names no agent file.
function researchReadme(slug) {
  return `# ${slug}

A cogyard \`research\` project: notes, sources and findings, with no code. cogyard has
wired up git, portal registration, and a shared task store.

**There is no build, no dev server and no version here.** The project has no
\`package.json\`, so a merge has nothing to build and nothing is versioned or published.

## Where things go

- \`notes/\` — working notes: what you are reading, thinking and trying. Rough is fine.
- \`sources/\` — what the work rests on: papers, pages, excerpts, data. Say where each
  one came from (a link or a title, and the date you got it), so a finding can be
  traced back to it.
- \`findings/\` — what the work concluded: write-ups someone else could read cold, each
  naming the sources it rests on.

## How to work here

Each piece of work is a task in the project's task store. Work a task in its own
worktree, put what you produce in the folders above, and commit as you go. When a
note turns into a conclusion, write it up in \`findings/\` rather than leaving it in
\`notes/\`.
`;
}

const research = {
  kind: 'research',
  description: 'Notes, sources and findings with no code — no package.json, no build, no dev server, no worktree ports.',
  worktreePorts: false,
  devScript: null,
  versionStamp: false,
  pkgJson: null, // writes no package.json (see core/scaffolds/index.mjs)
  skeletonFiles(slug) {
    return {
      'README.md': researchReadme(slug),
      'notes/.gitkeep': '',
      'sources/.gitkeep': '',
      'findings/.gitkeep': '',
    };
  },
};

// --- apple: an Xcode app, macOS or iOS ---------------------------------------
// One kind for both platforms: each is an Xcode project built by xcodebuild,
// stamped through its build settings, with no npm dev server. The scripts it
// seeds are real files beside this module (./apple/), copied as they are.

function appleFile(name) {
  return readFileSync(new URL(`./apple/${name}`, import.meta.url), 'utf8');
}

// The Version.xcconfig the stamper writes for `version`: the body of its
// heredoc with $version filled in. Read out of the script so that the file
// seeded here and the one every build writes are the same bytes — a difference
// would leave the committed file modified after the first build.
export function appleVersionXcconfig(version) {
  const m = appleFile('xcode-version.sh').match(/^cat > Version\.xcconfig <<EOF\n([\s\S]*?)^EOF$/m);
  if (!m) throw new Error('core/scaffolds/apple/xcode-version.sh has no Version.xcconfig heredoc');
  return m[1].replace('$version', () => version);
}

function appleReadme(slug) {
  return `# ${slug}

A cogyard \`apple\` project: an Xcode app, for macOS or iOS. cogyard has wired up git, portal
registration, and a shared task store.

**cogyard does not create the Xcode project.** Make it in Xcode (File > New > Project) and save it
in this folder, at the root or one folder down (an app beside a server often keeps it in \`ios/\`).
The usual flow is to make that your first task.

## Building

\`npm run build\` runs \`scripts/xcode-build.sh\`. It finds the Xcode workspace, project or Swift
package, asks it for its schemes (\`xcodebuild -list -json\`), and builds the one it finds. With no
scheme, or more than one, it stops and says what it found; name the one to build in
\`package.json\`: \`"build": "bash scripts/xcode-build.sh -scheme MyApp"\`. Anything else after the
script name goes to \`xcodebuild\` as it is, such as the \`-destination\` an iOS app needs
(\`'generic/platform=iOS Simulator'\`), or \`'generic/platform=macOS'\`, which stops \`xcodebuild\`
warning that it picked one of several Macs.

There is no dev server. A worktree of this project still gets its own reserved ports, for a server
you may keep beside the app, but nothing is started for the app itself.

## Version stamping

The version is the one in \`package.json\`; a merge bumps it. \`scripts/xcode-version.sh\` writes it
into \`Version.xcconfig\` (committed), and the build number and the short commit into
\`Build.xcconfig\` (gitignored, because it changes with every commit). \`npm run build\` runs it
first, and \`npm version\` runs it after a bump, so the bump commit carries the new version. After
building, \`npm run build\` reads the version and commit back out of each app it built, and warns
when either one is not what was stamped.

### The one-time hookup in Xcode

cogyard never edits an Xcode project, so until this is done once, the built app keeps the version
Xcode itself set:

1. Add Version.xcconfig to the project: File > Add Files, add it to no
   target. It is at the repo root, which may be a folder above the project.
2. Select the project, then its Info tab. Under Configurations, set Debug
   and Release of each app target to Version.xcconfig.
3. Select each app target, then Build Settings. Delete the target's own
   Marketing Version and Current Project Version (select the row, press
   Delete), so the values from Version.xcconfig show through: a target's
   own value always wins over an xcconfig.
4. In the same target's Info tab, add a String row named GitCommitShort
   whose value is $(GIT_COMMIT_SHORT). The app reads it with
   Bundle.main.object(forInfoDictionaryKey: "GitCommitShort").
`;
}

const apple = {
  kind: 'apple',
  description: 'Xcode app wiring (macOS or iOS) — npm run build runs xcodebuild, the version is stamped through .xcconfig files, no dev server; create the Xcode project yourself.',
  // Ports stay on: an app often sits beside a server in the same repo, and that
  // server's worktrees need their ports. No dev server is named for the app.
  worktreePorts: true,
  devScript: null,
  markers: ['*.xcodeproj', '*.xcworkspace', 'Package.swift'],
  gitignore: ['Build.xcconfig'],
  // An existing package.json is never edited, so onboard names whichever of
  // these it lacks, with the exact line.
  requiredScripts: ['build', 'version'],
  pkgJson(slug) {
    return {
      name: slug,
      version: '0.1.0',
      private: true,
      scripts: {
        build: 'bash scripts/xcode-build.sh',
        // npm runs "version" after a bump and before its commit, so the bump
        // commit carries the new Version.xcconfig; the build after it then
        // leaves the tree clean.
        version: 'bash scripts/xcode-version.sh && git add Version.xcconfig',
      },
    };
  },
  // Seeded on onboard too. Version.xcconfig is seeded with the version already
  // in it so it is committed with the wiring, ready for the Xcode hookup.
  versionStamp(slug, { version } = {}) {
    const files = {
      'scripts/xcode-version.sh': appleFile('xcode-version.sh'),
      'scripts/xcode-build.sh': appleFile('xcode-build.sh'),
    };
    if (version) files['Version.xcconfig'] = appleVersionXcconfig(version);
    return files;
  },
  skeletonFiles(slug) {
    return { 'README.md': appleReadme(slug) };
  },
};

// --- firmware (task 164) -------------------------------------------------------
// A PlatformIO project: the build target is a board and its "run" is a flash, but
// it keeps a HOST-SIDE preview server — the device's screens rendered in a
// browser — and that server is the dev entry and genuinely needs a worktree port,
// so worktreePorts stays true. cogyard describes the project; it never runs
// `pio` (no build, flash or monitor from core/ or cli/). PlatformIO is the source
// of truth for the build environments and their boards (`pio project config`);
// the one fact cogyard records is which environment is production.

const FIRMWARE_RECORD = '.cogyard/firmware.json';

function firmwareRecord(env) {
  return JSON.stringify({
    _comment: 'Firmware facts (cogyard, kind firmware). production_env is the PlatformIO build environment that is the shipped firmware: what a release builds and flashes, pio run -e <production_env> -t upload. Every environment and its board come from PlatformIO itself — pio project config — so they are not copied here. See docs/PROJECT-INIT.md.',
    production_env: env,
  }, null, 2) + '\n';
}

// Is `pio` (or its long name) an executable on PATH? Looked up, never run.
function pioOnPath() {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of ['pio', 'platformio']) {
      try {
        const st = statSync(join(dir, name));
        if (st.isFile() && (st.mode & 0o111)) return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

// The `[env:NAME]` sections a platformio.ini defines, read as text.
function pioEnvNames(ini) {
  const names = [];
  for (const line of ini.split(/\r?\n/)) {
    const m = line.match(/^\s*\[\s*env:([^\]\s]+)\s*\]/);
    if (m) names.push(m[1]);
  }
  return names;
}

function firmwareReadme(slug) {
  return `# ${slug}

A cogyard \`firmware\` project — cogyard has wired up git, portal registration, and a shared
task store.

**cogyard does not scaffold application code, and it never runs PlatformIO** — it does not
build, flash or talk to a board. Build the firmware yourself; the usual flow is to make it your
first task.

## PlatformIO

The firmware builds with PlatformIO (\`pio\`). Create the project here with
\`pio project init --board <board id>\`, one \`[env:*]\` per sketch. PlatformIO is the source of
truth for the build environments and each one's board: \`pio project config\` lists them.
cogyard records only which environment is production, as \`production_env\` in
\`${FIRMWARE_RECORD}\`. \`cogyard onboard\` writes it when \`platformio.ini\` defines one
environment; with several, write it yourself. A release builds and flashes that one:
\`pio run -e <production_env> -t upload\`. \`npm run build\` runs \`pio run\`.

## Version stamp

\`scripts/firmware_version.py\` is a PlatformIO pre-build script that writes \`version.h\` —
the version from \`package.json\` and the short git commit — before every build. Hook it up
once in \`platformio.ini\`:

\`\`\`
[env]
extra_scripts = pre:scripts/firmware_version.py
\`\`\`

then \`#include "version.h"\` in the sketch and show \`FW_STAMP\` (\`v0.1.0 (abc1234)\`) on the
device's own screen. \`version.h\` is generated into the build folder and never committed.

## The host-side preview, and worktree ports

The dev command is \`npm run preview\`: a host-side server that renders the device's screens in
a browser, so a UI change can be seen without flashing a board. Write that script — it is the
one thing here that binds a port. Each cogyard worktree reserves a unique port pair, and
\`~/.cogyard/ports.json\` is the only place those numbers exist, so the preview asks for its
port when it starts:

\`\`\`
eval "$(cogyard env ports --shell || echo 'exit 1')" && node preview/server.mjs
\`\`\`

and listens on \`$PORT\`, where its preview tab opens. Outside a worktree the command prints
nothing and your own default stands. **Never hardcode a port, and never read one out of a
file** — a copy goes stale, and a stale copy is how two worktrees end up on the same port
without anyone noticing. Keep the \`|| echo 'exit 1'\`: \`eval\` reports its own exit status
rather than the command's, so without it a failed lookup would start the server on whatever
port was lying around.

A second command that serves on a worktree port (a website beside the preview) goes in
\`.cogyard/worktree.json\` under \`extra_dev_scripts\`, with its own \`launch_name\`, so it gets
its own preview entry. A tool that needs a port only for itself — a headless screenshot —
takes one the system picks (port 0), never the preview's.
`;
}

const firmware = {
  kind: 'firmware',
  description: "PlatformIO firmware wiring — the dev server is the host-side preview on the worktree's port; version + commit go into a generated version.h.",
  worktreePorts: true, // the host-side preview needs its own port per worktree
  devScript: 'npm run preview',
  launchName: 'preview',
  previewPortVar: 'PORT',
  markers: ['platformio.ini'],
  // The firmware's own stamper, seeded instead of the npm one: a PlatformIO
  // pre-build script, so `pio run` stamps whichever way it is started.
  versionStamp() {
    return { 'scripts/firmware_version.py': readFileSync(join(HERE, 'firmware', 'firmware_version.py'), 'utf8') };
  },
  pkgJson(slug) {
    const pkg = basePkg(slug);
    delete pkg.scripts['generate-version'];
    pkg.scripts.build = 'pio run';
    return pkg;
  },
  skeletonFiles(slug) {
    return { 'README.md': firmwareReadme(slug) };
  },
  // At init and onboard: record the production environment when platformio.ini
  // leaves no doubt, and say what is missing otherwise. Never runs pio.
  describeProject(root) {
    const files = {};
    const warnings = [];
    if (!pioOnPath()) {
      warnings.push('PlatformIO (pio) is not on PATH. cogyard never runs it and has set this project up without it, '
        + 'but building, flashing and listing the build environments (pio project config) need it — install PlatformIO Core.');
    }
    let ini = null;
    try { ini = readFileSync(join(root, 'platformio.ini'), 'utf8'); } catch { /* none yet */ }
    const recorded = existsSync(join(root, FIRMWARE_RECORD));
    const write = `write ${FIRMWARE_RECORD} as {"production_env": "<env>"} and commit it`;
    if (ini === null) {
      if (!recorded) warnings.push(`No platformio.ini at the project root yet, so no production build environment is recorded. Once \`pio project init --board <id>\` makes one, re-run \`cogyard onboard\` — or ${write}.`);
      return { files, warnings };
    }
    const envs = pioEnvNames(ini);
    if (envs.length === 1) files[FIRMWARE_RECORD] = firmwareRecord(envs[0]);
    else if (!recorded) {
      warnings.push(envs.length
        ? `platformio.ini defines ${envs.length} build environments (${envs.join(', ')}), and cogyard cannot tell which is production. Check them with \`pio project config\`, then ${write}.`
        : `platformio.ini defines no [env:…] section, so no production build environment is recorded. Add one, then re-run \`cogyard onboard\` — or ${write}.`);
    }
    return { files, warnings };
  },
};

export const BUILTIN_SCAFFOLDS = [single, fullstack, staticKind, library, research, apple, firmware];
