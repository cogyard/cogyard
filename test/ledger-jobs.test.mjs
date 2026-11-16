// test/ledger-jobs.test.mjs — a scheduled job's agent call is ledgered under the
// job, never under a project (task 130).
//
// Before this, a job's transcript was filed by its working directory like any
// other, and a job ran in tmpdir() — so its usage landed under a project slug
// named `T` (the basename of macOS's temp folder) that no view could show. Each
// job now runs in `$COGYARD_HOME/run/<job-id>`, and the harvest files any
// transcript recorded there under that job.
//
// Real harvests over synthetic transcripts, through the claude driver's own
// line parser. COGYARD_HOME and the projects root are redirected to a throwaway
// dir BEFORE importing usage.mjs, so this never touches the real ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// realpath: the agent records its cwd with symlinks resolved (/var → /private/var
// here), and the test's own paths must look the way a real transcript's would.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cogyard-ledger-jobs-')));
const ROOT = join(HOME, 'projects');
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = ROOT;
process.env.COGYARD_DRIVER = 'claude';

const SITE = join(ROOT, 'site');
mkdirSync(SITE, { recursive: true });
writeFileSync(join(HOME, 'projects.json'), JSON.stringify([
  { slug: 'site', path: SITE, label: 'site' },
]));

const TRANSCRIPTS = join(HOME, 'transcripts');
mkdirSync(TRANSCRIPTS, { recursive: true });

// One human prompt and one priced assistant turn, recorded as running in `cwd`.
function transcript(name, sessionId, cwd) {
  const file = join(TRANSCRIPTS, `${name}.jsonl`);
  const lines = [
    { type: 'user', sessionId, cwd, uuid: `${sessionId}-u`, timestamp: '2026-10-05T12:00:00Z', message: { content: 'hello' } },
    {
      type: 'assistant', sessionId, cwd, requestId: `${sessionId}-r`, timestamp: '2026-10-05T12:00:05Z',
      message: { id: `${sessionId}-m`, model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 } },
    },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const { collectUsage, readUsageLedger, readActivityLedger, jobForPath, projectUsage } =
  await import('../core/usage.mjs');

after(() => rmSync(HOME, { recursive: true, force: true }));

const JOB_DIR = join(HOME, 'run', 'doc-drift');
mkdirSync(JOB_DIR, { recursive: true });

collectUsage({
  files: [
    transcript('job', 'S-job', JOB_DIR),
    transcript('project', 'S-site', join(SITE, 'src')),
    transcript('elsewhere', 'S-else', join(HOME, 'somewhere-else')),
  ],
});

const usageFor = (sid) => readUsageLedger().filter((r) => r.sessionId === sid);
const activityFor = (sid) => readActivityLedger().filter((r) => r.sessionId === sid);

test("a job's transcript lands under the job, with no project", () => {
  const rows = usageFor('S-job');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job, 'doc-drift');
  assert.equal(rows[0].project, null);
  assert.equal(rows[0].worktree, null);
  assert.ok(rows[0].tokens.output > 0, 'the tokens are kept, not just the identity');

  const act = activityFor('S-job');
  assert.equal(act.length, 1);
  assert.equal(act[0].job, 'doc-drift');
  assert.equal(act[0].project, null);
});

test("a normal project transcript is unaffected and carries no job", () => {
  const [row] = usageFor('S-site');
  assert.equal(row.project, 'site');
  assert.equal(row.job, undefined);
  assert.equal(activityFor('S-site')[0].project, 'site');
  // …and the job's tokens are nowhere in the project's totals.
  assert.equal(projectUsage('site').sessions, 1);
});

test('an unknown path still degrades to the basename fallback', () => {
  const [row] = usageFor('S-else');
  assert.equal(row.project, 'somewhere-else');
  assert.equal(row.job, undefined);
});

test('jobForPath: only paths UNDER the run root name a job', () => {
  assert.equal(jobForPath(JOB_DIR), 'doc-drift');
  assert.equal(jobForPath(join(JOB_DIR, 'nested')), 'doc-drift');
  assert.equal(jobForPath(join(HOME, 'run')), null);
  assert.equal(jobForPath(join(HOME, 'runner', 'x')), null);
  assert.equal(jobForPath(SITE), null);
  assert.equal(jobForPath(null), null);
});
