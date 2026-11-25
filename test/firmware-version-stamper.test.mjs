// test/firmware-version-stamper.test.mjs — the firmware kind's stamper (task 164).
//
// core/scaffolds/firmware/firmware_version.py is a PlatformIO pre-build script:
// PlatformIO runs it with an SCons `env` before compiling. Here a small harness
// stands in for that env, so the script runs exactly as seeded, against a
// throwaway project: it writes version.h (version from package.json, the short
// commit from git) into the build folder beside a .gitignore that ignores it,
// and puts that folder first on the include path. Skipped where python3 is not
// installed. The real build — `pio run` on a copy of a firmware project — is the
// task's own acceptance check, not this test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const STAMPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'scaffolds', 'firmware', 'firmware_version.py');
const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;

// Stands in for PlatformIO: an `env` with subst() and Prepend(), and Import().
const HARNESS = `import json, sys
script, project, build = sys.argv[1:4]
class Env:
    def __init__(self):
        self.cpppath = []
    def subst(self, name):
        return {"$PROJECT_DIR": project, "$BUILD_DIR": build, "$PIOENV": "app"}[name]
    def Prepend(self, CPPPATH=()):
        self.cpppath = list(CPPPATH) + self.cpppath
env = Env()
scope = {"Import": lambda name: None, "env": env, "__name__": "__main__"}
with open(script, encoding="utf-8") as f:
    exec(compile(f.read(), script, "exec"), scope)
print("CPPPATH=" + json.dumps(env.cpppath))
`;

let ROOT, HARNESS_PATH;
before(() => {
  ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-fw-stamp-')));
  HARNESS_PATH = join(ROOT, 'harness.py');
  writeFileSync(HARNESS_PATH, HARNESS);
});
after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

function project(name, { version, git = true } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  if (version) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  if (git) {
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.email=a@b.c', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init');
    return { dir, build: join(dir, '.pio', 'build', 'app'), commit: g('rev-parse', '--short', 'HEAD').trim() };
  }
  return { dir, build: join(dir, '.pio', 'build', 'app'), commit: 'no-git' };
}

const stamp = ({ dir, build }) => execFileSync('python3', [HARNESS_PATH, STAMPER, dir, build], { encoding: 'utf8' });

test('writes version.h from package.json and git, beside a .gitignore, first on the include path', { skip: !HAS_PYTHON && 'python3 not installed' }, () => {
  const p = project('meter', { version: '2.18.0' });
  const out = stamp(p);
  const header = readFileSync(join(p.build, 'stamp', 'version.h'), 'utf8');
  assert.match(header, /^#define FW_VERSION "2\.18\.0"$/m);
  assert.match(header, new RegExp(`^#define FW_COMMIT "${p.commit}"$`, 'm'));
  assert.match(header, /^#define FW_ENV "app"$/m);
  assert.match(header, new RegExp(`^#define FW_STAMP "v2\\.18\\.0 \\(${p.commit}\\)"$`, 'm'));
  assert.match(header, /GENERATED/);
  assert.equal(readFileSync(join(p.build, 'stamp', '.gitignore'), 'utf8').split('\n')[1], '*');
  assert.ok(out.includes(`CPPPATH=${JSON.stringify([join(p.build, 'stamp')])}`), out);
  assert.match(out, new RegExp(`firmware_version: v2\\.18\\.0 \\(${p.commit}\\) \\[app\\]`));
  // git agrees the header is ignored, though the project's own .gitignore says nothing.
  const ignored = spawnSync('git', ['-C', p.dir, 'check-ignore', '-q', join(p.build, 'stamp', 'version.h')]);
  assert.equal(ignored.status, 0, 'git does not ignore version.h');
});

test('an unchanged stamp leaves version.h alone, so nothing recompiles', { skip: !HAS_PYTHON && 'python3 not installed' }, () => {
  const p = project('steady', { version: '1.0.0' });
  stamp(p);
  const file = join(p.build, 'stamp', 'version.h');
  const before = statSync(file).mtimeMs;
  const out = stamp(p);
  assert.match(out, /\(unchanged\)/);
  assert.equal(statSync(file).mtimeMs, before);
});

test('no package.json gives 0.0.0, and outside git the commit is no-git', { skip: !HAS_PYTHON && 'python3 not installed' }, () => {
  const p = project('bare', { git: false });
  stamp(p);
  const header = readFileSync(join(p.build, 'stamp', 'version.h'), 'utf8');
  assert.match(header, /^#define FW_STAMP "v0\.0\.0 \(no-git\)"$/m);
  assert.ok(existsSync(join(p.build, 'stamp', '.gitignore')));
});
