// Boxes the write-task skill forbids (task 255): a box for a deploy or a check
// against production is a validator ERROR (it starts `checkbox `, so close,
// doctor, the portal and the write hook all see it); a box for the owner looking
// at the work is a WARNING, because it is a wording guess. Only open boxes on a
// task still in play are checked. Box texts below are real ones from task
// stores, quoted so the phrase lists can't drift from what they were built on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTasks, introducedErrors } from '../core/validate.mjs';
import { markerProblemsByFile } from '../core/close.mjs';

const fm = { id: 1, slug: 'a', title: 'A', status: 'OPEN', created: '2026-01-01', created_at_commit: 'abc', last_reviewed_at_commit: 'abc', last_touched_commit: 'abc', depends_on: [], related: [], touches_paths: [] };
const task = (body, over = {}) => ({ path: '/s/001-a.md', hasFrontmatter: true, frontmatter: { ...fm, ...over }, body });
const check = (body, over) => {
  const r = validateTasks([task(body, over)]).results[0];
  return { errors: r.errors.filter((e) => e.startsWith('checkbox')), warnings: r.warnings.filter((w) => w.startsWith('checkbox')) };
};

test('a deploy box with no marker is an error quoting the after-deploy rule (cogyard-site 015)', () => {
  const { errors, warnings } = check('- [ ] `npx wrangler deploy` run, https://cogyard.com/docs.html reloaded, the new copy visible there.');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^checkbox "`npx wrangler deploy` run/);
  assert.match(errors[0], /"No box for anything after a deploy\. Deploying is the owner's\."/);
  assert.deepEqual(warnings, []);
});

test('a deploy box marked (after merge) is an error quoting the (after merge) rule', () => {
  const { errors } = check('- [ ] (after merge) Deploy and check it live.');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /on \(after merge\): "Never for something that needs a production deploy\."/);
});

test('an owner-review box is a warning quoting the owner-looking rule, not an error (cogyard-site 017)', () => {
  const { errors, warnings } = check('- [ ] Owner reviews the rendered page before deploy');
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^checkbox "Owner reviews the rendered page before deploy" — looks like a box for the owner looking at the work \(a wording guess\)/);
  assert.match(warnings[0], /"No box for the owner looking at the work\."/);
});

test('one message per forbidden box', () => {
  const { errors, warnings } = check([
    '- [ ] Owner deploys via `npx wrangler deploy` and live-verifies',
    '- [ ] `curl -sSI https://example.com/api/x` returns `content-encoding: gzip` after deploy.',
    '- [ ] User confirms before DONE.',
    '- [ ] The owner tries it on their phone',
  ].join('\n'));
  assert.equal(errors.length, 2);
  assert.equal(warnings.length, 2);
});

test('legitimate boxes that mention deploys, production, live or the owner are not flagged', () => {
  const { errors, warnings } = check([
    "- [ ] Copy the parent's `.env.development` and `.env.production` to where the app reads them",
    '- [ ] Record whatever identifies the board and the production build env.',
    '- [ ] One deployment serving a team (per spec\'s deployment story)',
    '- [ ] One full dress-rehearsal release from the public clone (deploy verify above).',
    '- [ ] Hand the live URL (https://cogyard.com) to cogyard task 029 (launch).',
    '- [ ] Deploy the media server via Docker Compose under `compose/`',
    '- [ ] Deploy Redis instance (DO Managed Database or AWS ElastiCache)',
    '- [ ] Confirm the schema-state query in pickup-step 6 against production.',
    '- [ ] Confirm live TV plays on a LAN client, then from a satellite.',
    '- [ ] Detect a box whose text names a production deploy or a live site, marked `(after merge)` or not.',
    '- [ ] The CLI asks so the owner confirms the delete',
    '- [ ] User reviews + approves the three buckets (decide `published_at` + order)',
    '- [ ] (you: decision) Owner approves the final copy',
    '- [ ] (after merge) The Plan card reads "idle" on the real portal',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('the compliant form — the deploy in prose under "Deploy verify", no box — is silent', () => {
  const { errors, warnings } = check([
    '**Deploy verify:** none from the agent. Deploying is the owner\'s: `npx wrangler deploy`, then load https://cogyard.com/docs.html after the deploy.',
    '',
    '- [x] Section 15 written',
  ].join('\n'));
  assert.deepEqual([errors, warnings], [[], []]);
});

test('ticked and settled boxes are never flagged — a settled box often quotes the rule', () => {
  const { errors, warnings } = check([
    '- [x] `npx wrangler deploy` run, the new copy visible there.',
    '- [ ] (dropped: deploying is the owner\'s — the write-task skill: "No box for anything after a deploy.") Deploy and check it live.',
    '- [ ] (moved: site#002) Owner reviews the page',
    '- [ ] ~~Owner deploys via wrangler~~',
  ].join('\n'));
  assert.deepEqual([errors, warnings], [[], []]);
});

test('a closed task is history: its open boxes are not checked', () => {
  for (const status of ['DONE', 'ENOUGH', 'OBSOLETE']) {
    const { errors, warnings } = check('- [ ] Owner deploys via `npx wrangler deploy` and live-verifies', { status, done_date: '2026-01-02' });
    assert.deepEqual([status, errors, warnings], [status, [], []]);
  }
  assert.equal(check('- [ ] Owner deploys via `npx wrangler deploy`', { status: 'PARKED' }).errors.length, 1);
});

test('a box shown inside a code block is not a box', () => {
  assert.deepEqual(check('```\n- [ ] Deploy and check it live\n```').errors, []);
});

test('the deploy error is a marker problem, so close refuses it and the write hook refuses a new one', () => {
  const t = task('- [ ] Deploy and check it live.');
  assert.equal(markerProblemsByFile([t]).get('001-a.md').length, 1);
  assert.equal(introducedErrors([], task('- [ ] Write section 15'), t).length, 1);
  assert.deepEqual(introducedErrors([], t, task('- [ ] Deploy and check it live.\n- [x] Write section 15')), [], 'an old box does not stop the file being edited');
});
