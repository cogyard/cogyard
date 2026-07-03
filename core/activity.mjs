// core/activity.mjs — activity rollups for the portal's activity views (task 064).
//
// Reads the two usage-dir ledgers and answers the portal's three questions:
// attention (the human's own prompt timestamps, gap-coalesced into engaged
// spans), machine cost per day (usage rows' locked-in costUSD spread across
// days by the mined per-hour message weights), and the single-day drill-down.
// Commits-per-day lives in git-views.mjs (it's a git projection, not a ledger
// one). The mined/approximated split is the task's decided resolution ladder:
// activity.jsonl rows are MINED (hour-level truth); usage rows whose sessions
// have no activity coverage (transcript pruned before the activity cursors
// ever saw it) fall back to a day-level APPROXIMATION from firstTs/lastTs and
// are reported separately so the UI can render them as estimates.

import { readUsageLedger, readActivityLedger } from './usage.mjs';
import { discoverProjects } from './registry.mjs';

// Attention spans: prompts closer than this merge into one engaged stretch.
const GAP_MIN = 30;
// An isolated prompt (span of zero length) still counts as one engaged minute.
const MIN_SPAN_MIN = 1;

// Local calendar day of an ISO timestamp — the server runs on the owner's
// machine, so local days are the days the owner experienced.
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A UTC hour-bucket key ("2026-07-02T14") → the local day its hour starts in.
function hourKeyLocalDay(k) { return localDay(k + ':00:00.000Z'); }

// Ledger rows key per-clone registry slugs (e.g. `myproject-planets__earth`)
// while the portal shows the COLLAPSED project (`myproject-planets`) — the same
// join the overview table does. Build a normalizer against discoverProjects():
// a ledger slug maps to the longest discovered slug it equals or extends with
// `__`; unmatched slugs pass through.
function slugNormalizer() {
  let slugs = [];
  try { slugs = discoverProjects().filter((p) => !p.error).map((p) => p.slug).sort((a, b) => b.length - a.length); } catch {}
  const memo = new Map();
  return (raw) => {
    const s = raw || '(unknown)';
    if (!memo.has(s)) memo.set(s, slugs.find((d) => s === d || s.startsWith(d + '__')) || s);
    return memo.get(s);
  };
}

// Merge activity.jsonl rows (appended incrementally, possibly several per
// session) into one record per session: prompts concatenated + deduped,
// hour counts summed. → Map sessionId → {project, worktree, prompts, hours}
function mergedActivitySessions() {
  const norm = slugNormalizer();
  const bySession = new Map();
  for (const row of readActivityLedger()) {
    if (!row.sessionId) continue;
    let s = bySession.get(row.sessionId);
    if (!s) { s = { project: null, worktree: null, prompts: new Set(), hours: {}, tasks: {}, commitTasks: {} }; bySession.set(row.sessionId, s); }
    if (!s.project && row.project) s.project = norm(row.project);
    if (!s.worktree && row.worktree) s.worktree = row.worktree;
    for (const ts of row.prompts || []) s.prompts.add(ts);
    for (const [k, n] of Object.entries(row.hours || {})) s.hours[k] = (s.hours[k] || 0) + n;
    for (const [id, n] of Object.entries(row.tasks || {})) s.tasks[id] = (s.tasks[id] || 0) + n;
    for (const [id, n] of Object.entries(row.commitTasks || {})) s.commitTasks[id] = (s.commitTasks[id] || 0) + n;
  }
  return bySession;
}

// Usage rows folded to one cost record per session (cost is locked in on the
// rows; this only sums it). → Map sessionId → {project, worktree, costUSD,
// messages, firstTs, lastTs}
function usageSessions() {
  const norm = slugNormalizer();
  const bySession = new Map();
  for (const row of readUsageLedger()) {
    if (!row.sessionId) continue;
    let s = bySession.get(row.sessionId);
    if (!s) {
      s = { project: row.project ? norm(row.project) : null, worktree: row.worktree || null, costUSD: 0, messages: 0, firstTs: null, lastTs: null, claimedTasks: new Set() };
      bySession.set(row.sessionId, s);
    }
    if (row.taskId != null) s.claimedTasks.add(String(row.taskId));
    if (row.costUSD != null) s.costUSD += row.costUSD;
    s.messages += row.messages || 0;
    if (row.firstTs && (!s.firstTs || row.firstTs < s.firstTs)) s.firstTs = row.firstTs;
    if (row.lastTs && (!s.lastTs || row.lastTs > s.lastTs)) s.lastTs = row.lastTs;
  }
  return bySession;
}

// Gap-coalesce sorted prompt timestamps into engaged spans.
// → [{start, end, prompts}] (ISO strings; end >= start)
function coalesceSpans(sortedTs, gapMin = GAP_MIN) {
  const spans = [];
  for (const ts of sortedTs) {
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) continue;
    const last = spans[spans.length - 1];
    if (last && t - last.endMs <= gapMin * 60000) {
      last.endMs = Math.max(last.endMs, t);
      last.prompts += 1;
    } else {
      spans.push({ startMs: t, endMs: t, prompts: 1 });
    }
  }
  return spans.map((s) => ({ start: new Date(s.startMs).toISOString(), end: new Date(s.endMs).toISOString(), prompts: s.prompts }));
}

// Split a span's minutes across the local days it covers.
function spanMinutesByDay(span) {
  const out = {};
  let cur = new Date(span.start).getTime();
  const end = new Date(span.end).getTime();
  const total = Math.max((end - cur) / 60000, MIN_SPAN_MIN);
  if (localDay(span.start) === localDay(span.end)) return { [localDay(span.start)]: total };
  while (cur <= end) {
    const day = localDay(new Date(cur).toISOString());
    const next = new Date(cur); next.setHours(24, 0, 0, 0);
    const sliceEnd = Math.min(next.getTime(), end);
    out[day] = (out[day] || 0) + (sliceEnd - cur) / 60000;
    cur = next.getTime();
  }
  return out;
}

// Which task(s) a session worked, best-signal-first: `[#NN]` tags on the
// session's OWN git commits (definitive — the /commit skill stamps them), then
// the claims join (explicit `cogyard env claim`), then DOMINANT `_tasks/NNN-…`
// references mined from the transcript text (≥25% of the top count, so passing
// mentions don't tag), then a `task-NNN-*` worktree name. → deduped array of
// id strings, strongest first.
function sessionTaskIds(activitySession, usageSession) {
  const out = [];
  const push = (raw) => { const id = String(raw).replace(/^0+(?=\d)/, ''); if (id && !out.includes(id)) out.push(id); };
  const commits = Object.entries((activitySession && activitySession.commitTasks) || {}).sort((x, y) => y[1] - x[1]);
  for (const [id] of commits) push(id);
  if (usageSession) for (const id of usageSession.claimedTasks || []) push(id);
  const refs = Object.entries((activitySession && activitySession.tasks) || {}).sort((x, y) => y[1] - x[1]);
  const top = refs.length ? refs[0][1] : 0;
  for (const [id, n] of refs) { if (n >= Math.max(2, top * 0.25)) push(id); }
  const wt = (activitySession && activitySession.worktree) || (usageSession && usageSession.worktree) || '';
  const m = String(wt).match(/^task-0*(\d+)/);
  if (m) push(m[1]);
  return out.slice(0, 3);
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// The braid's data: per project, per local day —
//   prompts          count of the owner's messages (mined)
//   attentionMin     gap-coalesced engaged minutes (mined)
//   costUSD          cost spread across days by mined hour weights
//   costApproxUSD    cost from sessions with NO activity coverage, spread
//                    evenly across the days of the session's firstTs..lastTs
//                    span — an estimate, rendered distinctly by the UI
// → {sinceDay, projects: {slug: {days: {date: {...}}}}}
function activityRollup(days = 366) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const sinceDay = localDay(cutoff.toISOString());
  const activity = mergedActivitySessions();
  const usage = usageSessions();
  const projects = {};
  const bucket = (slug, day) => {
    if (!projects[slug]) projects[slug] = { days: {} };
    const d = projects[slug].days;
    if (!d[day]) d[day] = { prompts: 0, attentionMin: 0, costUSD: 0, costApproxUSD: 0 };
    return d[day];
  };

  // Attention + prompt counts: per project, coalesce prompts across ALL its
  // sessions (the owner's attention is one stream, whichever session it hit).
  const promptsByProject = new Map();
  for (const s of activity.values()) {
    const slug = s.project || '(unknown)';
    if (!promptsByProject.has(slug)) promptsByProject.set(slug, []);
    promptsByProject.get(slug).push(...s.prompts);
  }
  for (const [slug, tsList] of promptsByProject) {
    tsList.sort();
    for (const ts of tsList) {
      const day = localDay(ts);
      if (day && day >= sinceDay) bucket(slug, day).prompts += 1;
    }
    for (const span of coalesceSpans(tsList)) {
      for (const [day, min] of Object.entries(spanMinutesByDay(span))) {
        if (day >= sinceDay) bucket(slug, day).attentionMin += min;
      }
    }
  }

  // Cost: mined spread when the session has activity hours, else even-spread
  // approximation over the session's day span.
  for (const [sessionId, u] of usage) {
    if (!u.costUSD) continue;
    const slug = u.project || '(unknown)';
    const a = activity.get(sessionId);
    const totalMsgs = a ? Object.values(a.hours).reduce((x, y) => x + y, 0) : 0;
    if (a && totalMsgs > 0) {
      for (const [k, n] of Object.entries(a.hours)) {
        const day = hourKeyLocalDay(k);
        if (day && day >= sinceDay) bucket(slug, day).costUSD += u.costUSD * (n / totalMsgs);
      }
    } else if (u.firstTs && u.lastTs) {
      const daysSpanned = [];
      let cur = new Date(localDay(u.firstTs) + 'T12:00:00');
      const lastDay = localDay(u.lastTs);
      while (localDay(cur.toISOString()) <= lastDay) {
        daysSpanned.push(localDay(cur.toISOString()));
        cur = new Date(cur.getTime() + 86400000);
      }
      for (const day of daysSpanned) {
        if (day >= sinceDay) bucket(slug, day).costApproxUSD += u.costUSD / daysSpanned.length;
      }
    }
  }

  for (const p of Object.values(projects)) {
    for (const d of Object.values(p.days)) {
      d.attentionMin = round1(d.attentionMin);
      d.costUSD = round2(d.costUSD);
      d.costApproxUSD = round2(d.costApproxUSD);
    }
  }
  return { sinceDay, gapMin: GAP_MIN, projects };
}

// Single-day drill-down: every session that touched the local day, with its
// prompt timestamps and active hours on that day, plus a per-project prompt
// list for the tick lane. Sessions without activity coverage come back with
// approx: true and only their usage-row span.
function activityDay(date) {
  const activity = mergedActivitySessions();
  const usage = usageSessions();
  const sessions = [];
  const covered = new Set();

  for (const [sessionId, a] of activity) {
    const prompts = [...a.prompts].filter((ts) => localDay(ts) === date).sort();
    const hours = Object.fromEntries(Object.entries(a.hours).filter(([k]) => hourKeyLocalDay(k) === date));
    if (!prompts.length && !Object.keys(hours).length) continue;
    covered.add(sessionId);
    const u = usage.get(sessionId);
    const totalMsgs = Object.values(a.hours).reduce((x, y) => x + y, 0);
    const dayMsgs = Object.values(hours).reduce((x, y) => x + y, 0);
    sessions.push({
      sessionId,
      project: a.project || (u && u.project) || '(unknown)',
      worktree: a.worktree || (u && u.worktree) || null,
      taskIds: sessionTaskIds(a, u),
      prompts,
      hours,
      costUSD: u && totalMsgs > 0 ? round2(u.costUSD * (dayMsgs / totalMsgs)) : 0,
      approx: false,
    });
  }

  // Approximated sessions: usage rows overlapping the day, never mined.
  for (const [sessionId, u] of usage) {
    if (covered.has(sessionId) || !u.firstTs || !u.lastTs) continue;
    if (localDay(u.firstTs) > date || localDay(u.lastTs) < date) continue;
    const daySpan = Math.max(1, Math.round((new Date(localDay(u.lastTs) + 'T12:00:00') - new Date(localDay(u.firstTs) + 'T12:00:00')) / 86400000) + 1);
    sessions.push({
      sessionId,
      project: u.project || '(unknown)',
      worktree: u.worktree || null,
      taskIds: sessionTaskIds(null, u),
      firstTs: u.firstTs,
      lastTs: u.lastTs,
      prompts: [],
      hours: {},
      costUSD: round2(u.costUSD / daySpan),
      approx: true,
    });
  }

  sessions.sort((a, b) => String(a.project).localeCompare(String(b.project)) || String(a.worktree).localeCompare(String(b.worktree)));
  const prompts = {};
  for (const s of sessions) {
    if (!s.prompts.length) continue;
    if (!prompts[s.project]) prompts[s.project] = [];
    prompts[s.project].push(...s.prompts);
  }
  for (const list of Object.values(prompts)) list.sort();
  return { date, sessions, prompts };
}

// Punch card (task 064 round 6, windowed round 10): per time window, per
// project, a 7×24 matrix of the owner's prompt counts by LOCAL weekday
// (0=Sunday, JS getDay) × hour — "when am I most active". Prompts only: it's
// an attention chart, not a labor one. Windows are trailing day-counts.
function activityPunchcard(windows = [7, 28, 91, 366]) {
  const now = Date.now();
  const cutoffs = windows.map((w) => ({ w, since: now - w * 86400000 }));
  const out = Object.fromEntries(windows.map((w) => [String(w), {}]));
  for (const s of mergedActivitySessions().values()) {
    const slug = s.project || '(unknown)';
    for (const ts of s.prompts) {
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) continue;
      for (const { w, since } of cutoffs) {
        if (d.getTime() < since) continue;
        const win = out[String(w)];
        if (!win[slug]) win[slug] = Array.from({ length: 7 }, () => Array(24).fill(0));
        win[slug][d.getDay()][d.getHours()] += 1;
      }
    }
  }
  return out;
}

export { activityRollup, activityDay, activityPunchcard, coalesceSpans, localDay };
