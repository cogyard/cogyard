// test/ledger-aliases.test.mjs — usage rows written under an old slug resolve to
// the project that owns it now (task 136).
//
// A project that once had several registered checkouts (one per clone) left
// ledger rows under those checkouts' slugs. Its registry entry keeps
// the old locations as `aliases`, and the ledger readers map a row's project
// through them — without rewriting the ledger. Also locks that the old
// `slug__suffix` prefix join is gone: a nested project's rows no longer count
// under a parent whose slug is a prefix of it.
//
// COGYARD_HOME and the projects root are redirected to a throwaway dir BEFORE
// importing usage.mjs, so this never touches the real ~/.cogyard.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = mkdtempSync(join(tmpdir(), 'cogyard-aliases-'));
const ROOT = join(HOME, 'projects');
process.env.COGYARD_HOME = HOME;
process.env.COGYARD_PROJECTS_ROOT = ROOT;
const USAGE = join(HOME, 'usage');
mkdirSync(USAGE, { recursive: true });

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const t = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

writeFileSync(join(HOME, 'projects.json'), JSON.stringify([
  { slug: 'told__earth', path: join(ROOT, 'told/earth'), label: 'told/earth',
    aliases: [join(ROOT, 'told/mars'), join(ROOT, 'told/saturn')] },
  { slug: 'site', path: join(ROOT, 'site'), label: 'site' },
]));
const LEDGER = join(USAGE, 'usage.jsonl');
writeFileSync(LEDGER, jsonl([
  { sessionId: 'a', project: 'told__earth', taskId: null, model: 'm', tokens: t(), costUSD: 10 },
  { sessionId: 'b', project: 'told__mars', taskId: null, model: 'm', tokens: t(), costUSD: 4 },
  { sessionId: 'c', project: 'told__saturn', taskId: null, model: 'm', tokens: t(), costUSD: 1 },
  { sessionId: 'd', project: 'site__blog', taskId: null, model: 'm', tokens: t(), costUSD: 7 },
]));

const { projectUsage, readUsageLedger } = await import('../core/usage.mjs');
const { ledgerSlugResolver } = await import('../core/registry.mjs');

after(() => rmSync(HOME, { recursive: true, force: true }));

test('an alias path yields the slug its old rows were written under', () => {
  const resolve = ledgerSlugResolver();
  assert.equal(resolve('told__mars'), 'told__earth');
  assert.equal(resolve('told__saturn'), 'told__earth');
  assert.equal(resolve('told__earth'), 'told__earth');
  assert.equal(resolve('unknown'), 'unknown');
  assert.equal(resolve(null), null);
});

test("the project's usage includes rows written under its aliases", () => {
  const u = projectUsage('told__earth');
  assert.equal(u.costUSD, 15);
  assert.equal(u.sessions, 3);
});

test('the ledger file itself is not rewritten', () => {
  assert.equal(readUsageLedger().filter((r) => r.project === 'told__earth').length, 3);
  assert.match(readFileSync(LEDGER, 'utf8'), /"told__mars"/);
});

test('a slug that merely extends a project slug with __ is not that project', () => {
  assert.equal(projectUsage('site').costUSD, 0);
});
