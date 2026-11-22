// core/park.mjs — a task's park record, in the text (task 244).
//
// A task is parked in two places at once: `status: PARKED` in the frontmatter,
// and a note at the top of the body saying since when and what it waits for.
// Before this module nothing tied the two together, so they drifted apart:
// one project's task 158 was closed, then reopened, with its park note still saying
// PARKED. The owner chose (2026-11-17, option (b)) to keep the record in the
// text, with no new frontmatter field:
//
//   live   — `> **PARKED <date> — <what it waits for>**` (bold, at the top of
//            the body). `cogyard tasks park` writes it and owns it.
//   ended  — `> Parked <date> – <date>: <what it waited for>.`
//            `> Un-parked <date>: <what was seen>.`
//            `cogyard tasks unpark` turns the live line into these. Task files
//            never lose content, so the record of the wait stays.
//
// A closed task keeps only an ended record: `close` refuses while a live note
// is there. Pure text in, text out — nothing here touches a file. The commands
// (cli/tasks.mjs), the validator (core/validate.mjs), `close` (core/close.mjs)
// and the Edit/Write hook all read the record through this module, so they
// can't disagree about what a live note is.
//
// What counts as a LIVE note: a quote line that opens with bold PARKED —
// `> **PARKED` — in the head of the body (everything before the first `## `
// heading), outside fenced code. A struck-through one (`> ~~**PARKED …**~~`,
// how older files marked a superseded park) is not live, and neither is a
// mention later in the file (a task describing the convention, a quote).
// Hand-written notes from before the commands often run over several lines and
// put the reason's end, or a remark, after the bold; the record is the bold
// part — date and reason — and the rest of the paragraph is commentary.

import { blankCodeBlocks } from './status.mjs';

const LIVE_LINE = /^>\s*\*\*PARKED\b/;
const DATE = /\d{4}-\d{2}-\d{2}/;
const HEAD_OPEN = /^(>\s*)\*\*PARKED(?:\s+(\d{4}-\d{2}-\d{2}))?\s*(?:[—–:-]+\s*)?/;

// Where the head ends: the first `## ` heading outside code, else the end.
function headEnd(lines, plain) {
  const i = plain.findIndex((l) => /^##\s/.test(l));
  return i === -1 ? lines.length : i;
}

// A paragraph inside a quote ends at a blank line, a bare `>`, a line that
// isn't quoted, or a quote line that opens a new bold or struck entry.
function paragraphEnd(lines, start) {
  let e = start;
  while (e + 1 < lines.length) {
    const next = lines[e + 1];
    if (!/^>/.test(next) || /^>\s*$/.test(next) || /^>\s*(?:\*\*|~~)/.test(next)) break;
    e++;
  }
  return e;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const endSentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

// Every live park note in a task body, top first:
//   { start, end }  — line indexes of the note's paragraph in body.split('\n')
//   date            — 'YYYY-MM-DD', or null when the note gives none
//   reason          — what it waits for: the bold text after the date, one line
//   bold            — whether the bold closes inside the paragraph
export function liveParkNotes(body) {
  const lines = String(body ?? '').split('\n');
  const plain = blankCodeBlocks(body).split('\n');
  const stop = headEnd(lines, plain);
  const out = [];
  for (let i = 0; i < stop; i++) {
    if (!LIVE_LINE.test(plain[i])) continue;
    const end = paragraphEnd(lines, i);
    const para = lines.slice(i, end + 1).join('\n');
    const head = para.match(HEAD_OPEN);
    const after = para.slice(head[0].length);
    const close = after.indexOf('**');
    const inner = close === -1 ? after : after.slice(0, close);
    // Continuation lines carry their own `> `; the reason is read without them.
    const reason = oneLine(inner.replace(/\n>\s?/g, ' '));
    out.push({ start: i, end, date: head[2] || null, reason, bold: close !== -1 });
    i = end;
  }
  return out;
}

// The short form of a note, for messages: `PARKED 2026-10-20 — waiting for …`.
export function describePark(note, max = 90) {
  const r = note.reason.length > max ? note.reason.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : note.reason;
  return `PARKED${note.date ? ` ${note.date}` : ''} — ${r || '(no reason given)'}`;
}

// The record a hook compares before and after a hand edit: date + reason of
// each live note. Commentary after the bold is not part of it.
export function parkRecordKey(body) {
  return liveParkNotes(body).map((n) => `${n.date || ''}|${n.reason}`).join('\n');
}

// Where a new note goes: after the `# ` title in the head, else at the top.
// Returns the index the note's line is inserted at.
function insertAt(lines, plain) {
  const stop = headEnd(lines, plain);
  const h = plain.slice(0, stop).findIndex((l) => /^#\s/.test(l));
  if (h !== -1) return h + 1;
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  return i;
}

// Insert quote lines as their own paragraph, one blank line on each side.
function insertParagraph(body, quoteLines) {
  const lines = String(body ?? '').split('\n');
  const plain = blankCodeBlocks(body).split('\n');
  let at = insertAt(lines, plain);
  if (at < lines.length && lines[at].trim() === '') at++;   // past the blank under the title
  const block = [...quoteLines];
  if (at > 0 && lines[at - 1].trim() !== '') block.unshift('');
  if (at >= lines.length || lines[at].trim() !== '') block.push('');
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

// A note's reason as `park` writes it: one line, no `**` (it would end the
// bold early). Returns '' for nothing usable.
export function cleanParkReason(reason) {
  return oneLine(String(reason ?? '').replace(/\*\*/g, ''));
}

// Write a live note at the top of the body: `> **PARKED <date> — <reason>**`.
export function writeParkNote(body, { date, reason }) {
  if (!DATE.test(String(date || ''))) throw new Error(`writeParkNote: bad date ${date}`);
  const r = cleanParkReason(reason);
  if (!r) throw new Error('writeParkNote: no reason');
  return insertParagraph(body, [`> **PARKED ${date} — ${r}**`]);
}

// End every live note: its bold `**PARKED <date> — <reason>**` becomes
// `Parked <date> – <end>: <reason>.` (the rest of the paragraph kept as it
// was), and `> Un-parked <end>: <seen>.` goes right after the top one. With no
// live note (a PARKED status nothing recorded), the un-park line is written on
// its own at the top. `seen` is what was seen that ends the wait.
export function endParkNotes(body, { end, seen }) {
  if (!DATE.test(String(end || ''))) throw new Error(`endParkNotes: bad date ${end}`);
  const s = oneLine(seen);
  if (!s) throw new Error('endParkNotes: nothing seen');
  const unpark = `> Un-parked ${end}: ${endSentence(s)}`;
  const notes = liveParkNotes(body);
  if (!notes.length) return insertParagraph(body, [unpark]);
  const lines = String(body ?? '').split('\n');
  // Bottom first, so earlier line indexes stay valid.
  for (let k = notes.length - 1; k >= 0; k--) {
    const n = notes[k];
    const para = lines.slice(n.start, n.end + 1).join('\n');
    const head = para.match(HEAD_OPEN);
    const lead = head[1];
    const rest = para.slice(head[0].length);
    const close = rest.indexOf('**');
    let inner = close === -1 ? rest : rest.slice(0, close);
    let after = close === -1 ? '' : rest.slice(close + 2);
    // Nothing after the bold: the reason ends the sentence.
    if (!after.trim()) { inner = endSentence(inner.replace(/\s+$/, '')); after = ''; }
    const ended = `${lead}Parked ${n.date || '(undated)'} – ${end}: ${inner}${after}`.split('\n');
    if (k === 0) ended.push(unpark);
    lines.splice(n.start, n.end - n.start + 1, ...ended);
  }
  return lines.join('\n');
}
