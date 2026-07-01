// core/analyze.mjs — heuristic analyzer for unknown-frontmatter tasks: infers
// status/done_date/paths/title from the task body for `tasks.mjs analyze`.

import { statSync } from 'node:fs';
import { STATUSES, hasDoneDate } from './status.mjs';

function inferStatus(task) {
  const body = task.body || '';
  const reasons = [];
  let status = null;

  const m = body.match(/\*\*Status:\s*([A-Z_a-z]+)\.?\*\*/);
  if (m) {
    const s = m[1].toUpperCase();
    if (STATUSES.includes(s)) {
      status = s;
      reasons.push(`prose status line says "${s}"`);
    }
  }

  const head = body.slice(0, 1500);
  let doneDate = null;
  const doneM =
    head.match(/\*\*Status:\s*DONE\s*\(([\d-]+)\)\*\*/i) ||
    head.match(/\bDONE\s*\((\d{4}-\d{2}-\d{2})\)/i) ||
    head.match(/\bDONE\s+(\d{4}-\d{2}-\d{2})\b/i) ||
    head.match(/—\s*DONE\s+(\d{4}-\d{2}-\d{2})/i);
  if (doneM) { status = 'DONE'; doneDate = doneM[1]; reasons.push(`done date in body: ${doneDate}`); }

  if (!status && /^##?\s*(Done|Shipped|Complete|Merged)\.?\s*$/im.test(body)) {
    status = 'DONE'; reasons.push('heading suggests completion');
  }
  if (!status && /^\s*(?:✅|✔️|☑)/m.test(body) && !/^\s*-\s*\[\s\]/m.test(body)) {
    status = 'DONE'; reasons.push('check emoji + zero unchecked boxes');
  }
  // Same tolerant counting as in computeDerived (core/frontmatter.mjs) — accept
  // multiple "checked" mark variants. Keep this in sync if either copy changes.
  let checked = 0;
  let unchecked = 0;
  const checkboxRe2 = /-\s+\[([^\]]*)\]/g;
  const checkedMarkRe2 = /^(?:[xX]|✓|✔|✅|☑|☒|🗸|✗|✘|done|y|Y|yes|YES)$/;
  let m2;
  while ((m2 = checkboxRe2.exec(body)) !== null) {
    const inside = m2[1];
    if (inside === ' ' || inside === '') unchecked++;
    else if (checkedMarkRe2.test(inside.trim())) checked++;
  }
  const total = checked + unchecked;
  if (!status && total > 0) {
    const pct = checked / total;
    if (pct === 1.0 && total >= 3) { status = 'DONE'; reasons.push(`all ${total} checkboxes ticked`); }
    else if (pct >= 0.9 && total >= 5) { status = 'DONE'; reasons.push(`${checked}/${total} checkboxes ticked (≥90%)`); }
    else if (pct === 0 && total >= 3) { status = 'OPEN'; reasons.push(`0/${total} checkboxes ticked`); }
    else if (pct > 0) { status = 'OPEN'; reasons.push(`${checked}/${total} partial progress`); }
  }
  if (!status) {
    try {
      const st = statSync(task.path);
      const ageDays = (Date.now() - st.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 90 && total === 0) { status = 'OPEN'; reasons.push(`age ${Math.round(ageDays)}d, no checkboxes — review needed`); }
    } catch {}
  }
  if (!status) { status = 'OPEN'; reasons.push('no signal — defaulting to OPEN'); }
  // DONE/ENOUGH are finished states — they should carry a done_date (core/status.mjs).
  if (hasDoneDate(status) && !doneDate) {
    try { doneDate = new Date(statSync(task.path).mtimeMs).toISOString().slice(0, 10); reasons.push(`done_date inferred from mtime: ${doneDate}`); } catch {}
  }
  const pathHints = new Set();
  const pathRe = /(?:^|[\s(`'"\[])((?:backend|frontend|db|src|app|scripts|docs|_docs|lib|cmd|server|client|public)\/[a-zA-Z0-9_./@-]+)/g;
  let pm;
  while ((pm = pathRe.exec(body)) !== null) {
    const p = pm[1].replace(/[)\]'"`,.;:]+$/, '');
    if (p.length > 4 && p.length < 200) pathHints.add(p);
  }
  let title = null;
  const titleM = body.match(/^#\s+(.+?)$/m);
  if (titleM) title = titleM[1].replace(/^\d+[a-z]?:\s*/, '').trim();
  return { status, doneDate, reasons, paths: Array.from(pathHints).slice(0, 8), title, checkedCount: checked, totalCount: total };
}

export { inferStatus };
