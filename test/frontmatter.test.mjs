// Tests for the restricted YAML frontmatter parser — the foundation every
// dashboard view, claim check, and CLI command rides on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter, parseScalar, stripInlineComment, readTaskFile } from '../core/frontmatter.mjs';
import { validateTask } from '../core/validate.mjs';

test('parseScalar: scalars', () => {
  assert.equal(parseScalar('null'), null);
  assert.equal(parseScalar('~'), null);
  assert.equal(parseScalar(''), null);
  assert.equal(parseScalar('true'), true);
  assert.equal(parseScalar('false'), false);
  assert.equal(parseScalar('42'), 42);
  assert.equal(parseScalar('-7'), -7);
  assert.equal(parseScalar('"quoted"'), 'quoted');
  assert.equal(parseScalar("'single'"), 'single');
  assert.equal(parseScalar('plain string'), 'plain string');
  // date-like strings stay strings
  assert.equal(parseScalar('2026-06-10'), '2026-06-10');
});

test('parseScalar: quoted values follow YAML escapes', () => {
  // A real title from another project that showed its backslashes on Plan cards.
  assert.equal(parseScalar('"\\"Write by hand\\" textarea"'), '"Write by hand" textarea');
  assert.equal(parseScalar('"a \\\\ b"'), 'a \\ b');
  assert.equal(parseScalar('"line\\nbreak"'), 'line\nbreak');
  assert.equal(parseScalar("'it''s'"), "it's");
  // An unknown escape is left as written, and a single-quoted backslash is literal.
  assert.equal(parseScalar('"C:\\x"'), 'C:\\x');
  assert.equal(parseScalar("'a\\b'"), 'a\\b');
  // A lone quote character is not a quoted empty string.
  assert.equal(parseScalar('"'), '"');
});

test('stripInlineComment: comment after whitespace is stripped', () => {
  assert.equal(stripInlineComment('depends_on: []  # note'), 'depends_on: []');
  assert.equal(stripInlineComment('# whole line'), '');
});

test('stripInlineComment: # inside quotes or mid-word is kept', () => {
  assert.equal(stripInlineComment('title: "issue #42"'), 'title: "issue #42"');
  assert.equal(stripInlineComment("title: 'a # b'"), "title: 'a # b'");
  assert.equal(stripInlineComment('slug: foo#bar'), 'slug: foo#bar');
});

test('parseFrontmatter: the real v2 task schema shape', () => {
  const fm = parseFrontmatter([
    'id: 20',
    'slug: wt-nodes-in-dag',
    'title: Per-branch working-tree nodes in the DAG (SmartGit-style)',
    'status: OPEN',
    'created: 2026-06-10',
    'done_date: null',
    'depends_on: []',
    'related: [9, 10, 18]',
    'touches_paths:',
    '  - core/git-views.mjs',
    '  - server/routes/git.mjs',
    'commit_policy: per-phase',
    'resources: [prod-db, dns]',
    'env:',
    '  planet: null',
    '  ports:',
    '    backend: null',
    '    frontend: null',
    '  claimed_at: null',
    '  claimed_by_session: null',
  ].join('\n'));
  assert.equal(fm.id, 20);
  assert.equal(fm.status, 'OPEN');
  assert.equal(fm.done_date, null);
  assert.deepEqual(fm.depends_on, []);
  assert.deepEqual(fm.related, [9, 10, 18]);
  assert.deepEqual(fm.touches_paths, ['core/git-views.mjs', 'server/routes/git.mjs']);
  assert.deepEqual(fm.resources, ['prod-db', 'dns']);
  assert.equal(fm.env.planet, null);
  assert.equal(fm.env.ports.backend, null);
  assert.equal(fm.env.claimed_at, null);
});

test('parseFrontmatter: resources as a block list (task 239)', () => {
  const fm = parseFrontmatter(['resources:', '  - prod-db', '  - app-store-submission'].join('\n'));
  assert.deepEqual(fm.resources, ['prod-db', 'app-store-submission']);
});

test('validate: resources are short names; coordination / parallel_safe warn on an open task only (task 239)', () => {
  const v = (fm) => validateTask({ path: '/x/001-t.md', hasFrontmatter: true, body: '',
    frontmatter: { id: 1, slug: 't', status: 'OPEN', type: 'bug', ...fm } }, {});
  assert.deepEqual(v({ resources: ['prod-db', 'app-store-submission'] }).errors, []);
  assert.match(v({ resources: ['Prod DB'] }).errors.join(), /resources: "Prod DB" is not a short name/);
  assert.match(v({ resources: ['prod_db'] }).errors.join(), /not a short name/);
  assert.match(v({ resources: 'prod-db' }).errors.join(), /resources: expected a list/);
  assert.match(v({ coordination: [] }).warnings.join(), /coordination: retired/);
  assert.match(v({ parallel_safe: true }).warnings.join(), /parallel_safe: retired/);
  assert.deepEqual(v({ status: 'DONE', done_date: '2026-11-01', coordination: [], parallel_safe: false }).warnings
    .filter((w) => /retired/.test(w)), [], 'a closed task keeps them as history');
});

test('parseFrontmatter: inline comment on an array does not corrupt the value', () => {
  const fm = parseFrontmatter('depends_on: []  # waits for nothing');
  assert.deepEqual(fm.depends_on, []);
});

test('parseFrontmatter: claim fields written by env.mjs claim', () => {
  const fm = parseFrontmatter([
    'env:',
    '  claimed_at: 2026-06-10T22:24:26.064Z',
    '  claimed_by_session: funny-allen-2e819f-1781130266',
  ].join('\n'));
  assert.equal(fm.env.claimed_at, '2026-06-10T22:24:26.064Z');
  assert.equal(fm.env.claimed_by_session, 'funny-allen-2e819f-1781130266');
});

test('parseFrontmatter: blank lines and full-line comments ignored', () => {
  const fm = parseFrontmatter('# header comment\n\nid: 3\n\n# trailing');
  assert.deepEqual(fm, { id: 3 });
});

test('parseFrontmatter: dedent closes nested blocks', () => {
  const fm = parseFrontmatter([
    'env:',
    '  ports:',
    '    backend: 7440',
    '  hostname: mb.lan',
    'after: yes',
  ].join('\n'));
  assert.equal(fm.env.ports.backend, 7440);
  assert.equal(fm.env.hostname, 'mb.lan');
  assert.equal(fm.after, 'yes');
});

// --- legacy `category` → `type` alias (task 096) -----------------------------
// The task-kind enum was renamed category→type; readTaskFile canonicalizes an old
// `category:` key to `type` at the parse boundary so pre-096 files still validate
// without a mass rewrite. This is the ONLY place that reads `category`.
test('readTaskFile: legacy `category` is aliased to `type`; explicit `type` wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cogyard-fm-'));
  try {
    const legacy = join(dir, '001-legacy.md');
    writeFileSync(legacy, '---\nid: 1\nstatus: OPEN\ncategory: bug\n---\nbody\n');
    assert.equal(readTaskFile(legacy).frontmatter.type, 'bug');

    const modern = join(dir, '002-modern.md');
    writeFileSync(modern, '---\nid: 2\nstatus: OPEN\ntype: feature\n---\nbody\n');
    assert.equal(readTaskFile(modern).frontmatter.type, 'feature');

    // Both present (shouldn't happen) — explicit type is not clobbered by the alias.
    const both = join(dir, '003-both.md');
    writeFileSync(both, '---\nid: 3\nstatus: OPEN\ntype: docs\ncategory: bug\n---\nbody\n');
    assert.equal(readTaskFile(both).frontmatter.type, 'docs');

    // Neither → type stays undefined (the validator then errors on it).
    const neither = join(dir, '004-neither.md');
    writeFileSync(neither, '---\nid: 4\nstatus: OPEN\n---\nbody\n');
    assert.equal(readTaskFile(neither).frontmatter.type, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
