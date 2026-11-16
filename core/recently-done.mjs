// core/recently-done.mjs — the Plan tab's Recently done strip (task 198): a
// project's newest finished tasks. GET /api/recently-done serves it.
//
// DONE tasks with a done_date, newest first, at most `limit`. ENOUGH and
// OBSOLETE are left out (owner, 2026-10-09). Grouping into Today / This week / …
// is the portal's job: it needs the viewer's date and the week-start setting.
//
// Each row: { id, title, type, labels, doneDate, done, total, boxes } — the
// card's facts. `boxes` is one { done, onMain } per counted box in file order,
// as the Plan's (task 251); `onMain` is always null — a finished task's
// squares stay grey, with no git work spent on them.
//
// Order: by done_date, then — because done_date has no time of day — by WHEN
// the task was closed: the newest task-store commit that set a done_date in its
// file (owner, 2026-10-09: ordering same-day tasks by number put the last one
// closed fourth). A close not committed yet falls back to the file's mtime; a
// tie after that goes highest number first.

import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { loadTasks, computeDerived, taskLabels, checkboxSteps, countedBoxes } from './frontmatter.mjs';
import { tasksDirOf } from './tasks-dir.mjs';
import { gitP } from './exec.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}/;
const idNum = (id) => Number(String(id).match(/\d+/)?.[0] ?? 0);

// task file name → epoch ms of the newest commit that added or removed a dated
// `done_date:` line in it. One `git log` over the store; {} when the store has
// no history (not a git repo, or git unavailable). Paths are reduced to file
// names, so a store that is a folder inside the project's repo works too.
async function closeCommitTimes(dir) {
  const out = await gitP(['log', '--format=%x01%ct', '--name-only', '-G', '^done_date: *[0-9]', '--', '.'], dir);
  const times = {};
  for (const block of (out || '').split('\x01').slice(1)) {
    const [ts, ...files] = block.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const f of files) if (!(basename(f) in times)) times[basename(f)] = Number(ts) * 1000;
  }
  return times;
}

async function recentlyDone(proj, limit = 20) {
  let dir;
  try { dir = realpathSync(tasksDirOf(proj.path)); } catch { return []; }
  const done = [];
  for (const t of loadTasks(dir)) {
    const fm = t.frontmatter || {};
    const doneDate = String(fm.done_date ?? '').match(DATE)?.[0];
    if (fm.status !== 'DONE' || !doneDate || fm.id == null) continue;
    done.push({ t, id: String(fm.id), title: String(fm.title ?? ''), doneDate });
  }
  const times = await closeCommitTimes(dir);
  const closedAt = (t) => {
    const c = times[basename(t.path)];
    if (c != null) return c;
    try { return statSync(t.path).mtimeMs; } catch { return 0; }
  };
  for (const d of done) d.closedAt = closedAt(d.t);
  done.sort((a, b) => b.doneDate.localeCompare(a.doneDate) || b.closedAt - a.closedAt || idNum(b.id) - idNum(a.id));
  return done.slice(0, limit).map(({ t, id, title, doneDate }) => {
    // The same checkbox count the Plan card uses (computeDerived — one rule).
    // staleOverride=false: a closed task needs no git call.
    const d = computeDerived(t, [], proj.path, false);
    // type + labels so a done card shows the same icon and tags (task 227).
    const fm = t.frontmatter || {};
    const boxes = countedBoxes(checkboxSteps(t.body || '')).map((s) => ({ done: s.done, onMain: null }));
    return { id, title, type: fm.type || null, labels: taskLabels(fm), doneDate, done: d.checkedCount, total: d.totalCount, boxes };
  });
}

export { recentlyDone };
