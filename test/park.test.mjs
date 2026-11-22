// core/park.mjs and the validator's park check (task 244): what a LIVE park
// note is, how `park` writes one and `unpark` ends one, and the two
// contradictions `validate` reports as errors. The shapes are the ones real
// stores hold (wording made neutral): a phone app's multi-line notes with a
// remark after the bold, the same app's struck-through superseded parks, a
// home server's one-line note above a `> **Status:**` line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveParkNotes, describePark, parkRecordKey, writeParkNote, endParkNotes, cleanParkReason } from '../core/park.mjs';
import { validateTask } from '../core/validate.mjs';

// The phone app's task 158, its head as it was on 2026-11-17: OPEN, a live note.
const APP_158 = `
# 158: The map while walking

> **PARKED 2026-10-20 — waiting for an App Store release with 1.30.0 or later, then the check on
> the test phone** (owner: "merge it"). All three parts are merged (main at 1.30.0, \`2b666e5\`).
> Part 2 changes what the phone sends, and the owner closes it.

> **Status: OPEN** (until the park above). Three fixes found from the owner's two screenshots.

## What this is

Text.
`;

// The same app's task 134: one live park on top, a struck-through older one.
const APP_134 = `
# 134: A pin

> **PARKED 2026-11-03 — waiting for an App Store release with 1.42.0 or later, then the check on
> the test phone** (owner: "merge"). The fix is merged.

> ~~**PARKED 2026-10-19**~~ (superseded by the 2026-11-03 park above: the check ran on 1.39.0 and
> failed.) **PARKED 2026-10-19 — waiting for an App Store release with 1.24.0 or later**.

> **Status: OPEN.** The owner's decision.

## What this is
`;

// A home server's task 014: a one-line note, a bare \`>\`, then the status line.
const SERVER_014 = `
# 014: Rollout

> **PARKED 2026-07-17 — waiting on the storage architecture decision.** You'd onboard users onto a layout about to change. Original blocking note below:
>
> **Status: PARKED — waiting on tasks 012 + 013 + 032.** The gate task.

## What this is
`;

test('a live note: a quote line opening with bold PARKED in the head; date and the bold reason read across lines', () => {
  const [n, ...rest] = liveParkNotes(APP_158);
  assert.equal(rest.length, 0);
  assert.equal(n.date, '2026-10-20');
  assert.equal(n.reason, "waiting for an App Store release with 1.30.0 or later, then the check on the test phone");
  assert.equal(n.bold, true);
  assert.equal(describePark(n, 40), 'PARKED 2026-10-20 — waiting for an App Store release with…');
});

test('a struck-through older park is not live; only the top one is', () => {
  const notes = liveParkNotes(APP_134);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].date, '2026-11-03');
});

test('a one-line note ending in a period; the status line under it is not part of it', () => {
  const [n] = liveParkNotes(SERVER_014);
  assert.equal(n.reason, 'waiting on the storage architecture decision.');
  assert.equal(n.start, n.end);
});

test('not live: a mention after the first ## heading, one inside fenced code, one not at the start of a quote line', () => {
  const body = [
    '', '# 9: Docs', '', 'A note is written like `> **PARKED 2026-01-01 — x**`.', '',
    '```markdown', '> **PARKED 2026-01-01 — inside a code block**', '```', '',
    '## Notes', '', '> **PARKED 2026-01-01 — further down, a quote of another task**', '',
  ].join('\n');
  assert.deepEqual(liveParkNotes(body), []);
});

test('park writes "> **PARKED <date> — <reason>**" under the title, as its own paragraph above the status line', () => {
  const body = '\n# 7: Thing\n\n> **Status: OPEN.** Ready.\n\n## What this is\n';
  const out = writeParkNote(body, { date: '2026-11-17', reason: '  waiting for the   **vendor** reply ' });
  assert.equal(out, '\n# 7: Thing\n\n> **PARKED 2026-11-17 — waiting for the vendor reply**\n\n> **Status: OPEN.** Ready.\n\n## What this is\n');
  assert.deepEqual(liveParkNotes(out).map((n) => n.reason), ['waiting for the vendor reply']);
  // A title straight above the status line still gets blank lines around the note.
  const tight = writeParkNote('\n# 7: Thing\n> **Status: OPEN.**\n', { date: '2026-11-17', reason: 'x' });
  assert.equal(tight, '\n# 7: Thing\n\n> **PARKED 2026-11-17 — x**\n\n> **Status: OPEN.**\n');
  // A new park goes on top of an older, ended record.
  const again = writeParkNote('\n# 7: T\n\n> Parked 2026-01-01 – 2026-02-01: old.\n> Un-parked 2026-02-01: seen.\n', { date: '2026-11-17', reason: 'new' });
  assert.match(again, /^\n# 7: T\n\n> \*\*PARKED 2026-11-17 — new\*\*\n\n> Parked 2026-01-01/);
  assert.equal(cleanParkReason(' a\n b ** c '), 'a b c');
});

test('unpark ends the command-written note in the owner\'s format, and leaves no live note', () => {
  const parked = '\n# 7: Thing\n\n> **PARKED 2026-11-01 — waiting for the vendor reply**\n\n> **Status: PARKED.** Ready.\n';
  const out = endParkNotes(parked, { end: '2026-11-17', seen: 'the vendor replied on the 16th' });
  assert.equal(out, '\n# 7: Thing\n\n> Parked 2026-11-01 – 2026-11-17: waiting for the vendor reply.\n> Un-parked 2026-11-17: the vendor replied on the 16th.\n\n> **Status: PARKED.** Ready.\n');
  assert.deepEqual(liveParkNotes(out), []);
});

test('unpark of a hand-written note keeps every word: the bold goes, the remark after it stays, nothing is deleted', () => {
  const out = endParkNotes(APP_158, { end: '2026-11-20', seen: 'the test phone is on 1.31.0; the map held the last good position' });
  assert.ok(out.includes("> Parked 2026-10-20 – 2026-11-20: waiting for an App Store release with 1.30.0 or later, then the check on\n> the test phone (owner: \"merge it\"). All three parts are merged"));
  assert.ok(out.includes('> Part 2 changes what the phone sends, and the owner closes it.\n> Un-parked 2026-11-20: the test phone is on 1.31.0; the map held the last good position.\n\n> **Status: OPEN**'));
  assert.deepEqual(liveParkNotes(out), []);
  // Every original word is still in the file.
  for (const w of APP_158.replace(/\*\*/g, '').split(/\s+/).filter((x) => x && x !== 'PARKED' && x !== '—')) assert.ok(out.includes(w), w);
  const fc = endParkNotes(SERVER_014, { end: '2026-11-20', seen: 'decided in docs/STORAGE.md' });
  assert.ok(fc.includes('> Parked 2026-07-17 – 2026-11-20: waiting on the storage architecture decision. You\'d onboard'));
  assert.ok(fc.includes('Original blocking note below:\n> Un-parked 2026-11-20: decided in docs/STORAGE.md.\n>\n> **Status: PARKED'));
});

test('unpark with no live note (a PARKED status nothing recorded) writes the un-park line on its own', () => {
  const out = endParkNotes('\n# 7: T\n\n> **Status: PARKED.**\n', { end: '2026-11-17', seen: 'done waiting' });
  assert.equal(out, '\n# 7: T\n\n> Un-parked 2026-11-17: done waiting.\n\n> **Status: PARKED.**\n');
});

test('the record a hook compares is date + bold reason; a remark after the bold is not part of it', () => {
  const k = parkRecordKey(APP_158);
  assert.equal(parkRecordKey(APP_158.replace('(owner: "merge it")', '(owner: "merge it", 2026-10-20)')), k);
  assert.notEqual(parkRecordKey(APP_158.replace('1.30.0 or later', '1.31.0 or later')), k);
  assert.notEqual(parkRecordKey(APP_158.replace('2026-10-20 —', '2026-10-21 —')), k);
  assert.equal(parkRecordKey('\n# 1: x\n'), '');
});

// --- the validator ------------------------------------------------------------

const fm = (status, extra = {}) => ({ id: 158, slug: 's', title: 't', status, type: 'bug', done_date: ['DONE', 'ENOUGH'].includes(status) ? '2026-11-02' : null, ...extra });
const parkErrors = (status, body) => validateTask({ path: '/s/158-s.md', hasFrontmatter: true, frontmatter: fm(status), body }).errors.filter((e) => e.startsWith('park:'));

test('a live note on an OPEN task is an error naming park (still waits) and unpark (wait over)', () => {
  const [e, ...rest] = parkErrors('OPEN', APP_158);
  assert.equal(rest.length, 0);
  assert.match(e, /^park: the text says "PARKED 2026-10-20 — waiting for an App Store release/);
  assert.match(e, /but status is OPEN; if it still waits, `cogyard tasks park 158` sets PARKED and keeps the note; if the wait is over, `cogyard tasks unpark 158 "<what was seen>"` ends it/);
});

test('a live note on a DONE (or OBSOLETE) task is an error naming unpark --on; the status stays', () => {
  for (const s of ['DONE', 'ENOUGH', 'OBSOLETE']) {
    const [e] = parkErrors(s, APP_158);
    assert.match(e, new RegExp(`but status is ${s}; a ${s} task keeps only an ended record — \`cogyard tasks unpark 158 "<what was seen>" --on <the day the wait ended>\` ends the note \\(the status stays ${s}\\)`));
  }
});

test('a PARKED task with no live note is an error naming park "<reason>"; with one it is clean', () => {
  const [e] = parkErrors('PARKED', '\n# 158: x\n\n> **Status: PARKED — waiting on 012.**\n');
  assert.match(e, /^park: status is PARKED but the text has no live park note saying what it waits for; `cogyard tasks park 158 "<what it waits for>" \[--on <the day it was parked>\]` writes one/);
  assert.deepEqual(parkErrors('PARKED', APP_158), []);
  assert.deepEqual(parkErrors('PARKED', APP_134), []);
});

test('no note on a non-PARKED task, and an ended note anywhere, are clean', () => {
  const ended = endParkNotes(APP_158, { end: '2026-11-20', seen: 'seen' });
  for (const s of ['OPEN', 'DONE', 'ENOUGH', 'OBSOLETE']) {
    assert.deepEqual(parkErrors(s, '\n# 158: x\n\nBody.\n'), []);
    assert.deepEqual(parkErrors(s, ended), []);
  }
});
