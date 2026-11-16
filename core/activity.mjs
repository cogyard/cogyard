// core/activity.mjs — activity rollups for the portal's activity views.
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

import { readUsageLedger, readActivityLedger, ledgerPlacement } from './usage.mjs';

// Attention spans: prompts closer than this merge into one engaged stretch.
const GAP_MIN = 30;
// An isolated prompt (span of zero length) still counts as one engaged minute.
const MIN_SPAN_MIN = 1;

// The cross-project views fold everything that is not a registered project into
// two lanes (task 130), named by what they hold so every view that prints a
// lane name reads right without a lookup. `lanes` in activityRollup's answer
// says which keys these are and what is folded into each.
const JOBS_LANE = 'Scheduled tasks';
const OUTSIDE_LANE = 'Outside any project';

// A session record (either fold below) → { lane, member }: the lane it is drawn
// in, and — for the two folded lanes — the job or folder it came from.
function laneOf(place, s) {
  const { kind, key } = place(s);
  if (kind === 'job') return { lane: JOBS_LANE, member: key, job: true };
  if (kind === 'outside') return { lane: OUTSIDE_LANE, member: key, job: false };
  return { lane: key, member: null, job: false };
}

// Local calendar day of an ISO timestamp — the server runs on the user's
// machine, so local days are the days the user experienced.
function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A UTC hour-bucket key ("2026-07-02T14") → the local day its hour starts in.
function hourKeyLocalDay(k) { return localDay(k + ':00:00.000Z'); }

// Merge activity.jsonl rows (appended incrementally, possibly several per
// session) into one record per session: prompts concatenated + deduped,
// hour counts summed. → Map sessionId → {project, worktree, prompts, hours}
function mergedActivitySessions() {
  const bySession = new Map();
  for (const row of readActivityLedger()) {
    if (!row.sessionId) continue;
    let s = bySession.get(row.sessionId);
    if (!s) { s = { project: null, worktree: null, job: null, prompts: new Set(), hours: {}, tasks: {}, commitTasks: {} }; bySession.set(row.sessionId, s); }
    if (!s.project && row.project) s.project = row.project;
    if (!s.job && row.job) s.job = row.job;
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
  const bySession = new Map();
  for (const row of readUsageLedger()) {
    if (!row.sessionId) continue;
    let s = bySession.get(row.sessionId);
    if (!s) {
      s = { project: row.project || null, worktree: row.worktree || null, job: row.job || null, costUSD: 0, messages: 0, firstTs: null, lastTs: null, claimedTasks: new Set() };
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

// EVERY task a session worked, best-signal-first: `[#NN]` tags on the session's
// OWN git commits (definitive — the /commit skill stamps them), then the claims
// join (explicit `cogyard env claim`), then DOMINANT `.cogyard/tasks/NNN-…` / `_tasks/NNN-…` references
// mined from the transcript text (≥25% of the top count, so passing mentions
// don't tag), then a `task-NNN-*` worktree name. → deduped array of id strings,
// strongest first, UNCAPPED.
//
// Uncapped matters (task 117): cleanup asks "is this chat safe to archive?",
// which is true only when EVERY task in the chat is finished. A truncated list
// silently drops the tasks that should have blocked archiving, so the answer
// would be wrong in exactly the direction that loses a chat someone still
// needs. Callers that only DISPLAY tasks want the capped view below.
function sessionTaskIdsAll(activitySession, usageSession) {
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
  return out;
}

// The DISPLAY view: the same ladder, capped at 3. The activity rows render task
// chips in a fixed-width cell, where a chat touching eight tasks would blow the
// layout and tell the reader nothing — three strongest is the useful answer.
// Never use this to decide anything; it is lossy by design.
const SESSION_TASK_DISPLAY_CAP = 3;
function sessionTaskIds(activitySession, usageSession) {
  return sessionTaskIdsAll(activitySession, usageSession).slice(0, SESSION_TASK_DISPLAY_CAP);
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// The braid's data: per project, per local day —
//   prompts          count of the user's messages (mined)
//   attentionMin     gap-coalesced engaged minutes (mined)
//   costUSD          cost spread across days by mined hour weights
//   costApproxUSD    cost from sessions with NO activity coverage, spread
//                    evenly across the days of the session's firstTs..lastTs
//                    span — an estimate, rendered distinctly by the UI
// Keys are registered project slugs plus the two folded lanes (JOBS_LANE,
// OUTSIDE_LANE); `lanes` names what each folded lane holds. A scheduled job's
// prompts are the machine's, not the user's, so its sessions add COST only —
// counting them as attention is how 153 one-shot calls once ranked a temp
// folder fourth on this chart.
// → {sinceDay, projects: {lane: {days: {date: {...}}}}, lanes: {lane: {kind, members}}}
function activityRollup(days = 366) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const sinceDay = localDay(cutoff.toISOString());
  const activity = mergedActivitySessions();
  const usage = usageSessions();
  const place = ledgerPlacement();
  const projects = {};
  const lanes = {};
  const note = ({ lane, member, job }) => {
    if (member == null) return;
    if (!lanes[lane]) lanes[lane] = { kind: job ? 'jobs' : 'outside', members: [] };
    if (!lanes[lane].members.includes(member)) lanes[lane].members.push(member);
  };
  const bucket = (slug, day) => {
    if (!projects[slug]) projects[slug] = { days: {} };
    const d = projects[slug].days;
    if (!d[day]) d[day] = { prompts: 0, attentionMin: 0, costUSD: 0, costApproxUSD: 0 };
    return d[day];
  };

  // Attention + prompt counts: per project, coalesce prompts across ALL its
  // sessions (the user's attention is one stream, whichever session it hit).
  const promptsByProject = new Map();
  for (const s of activity.values()) {
    const l = laneOf(place, s);
    if (l.job) continue;
    const slug = l.lane;
    if (!s.prompts.size) continue;
    note(l);
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
    const l = laneOf(place, u);
    note(l);
    const slug = l.lane;
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
  for (const l of Object.values(lanes)) l.members.sort();
  return { sinceDay, gapMin: GAP_MIN, projects, lanes };
}

// Single-day drill-down: every session that touched the local day, with its
// prompt timestamps and active hours on that day, plus a per-project prompt
// list for the tick lane. Sessions without activity coverage come back with
// approx: true and only their usage-row span.
function activityDay(date) {
  const activity = mergedActivitySessions();
  const usage = usageSessions();
  const place = ledgerPlacement();
  // Same lanes as the braid, so a session's colour and order match it; the
  // job or folder a folded session came from stands in for its worktree.
  const where = (a, u) => {
    const l = laneOf(place, { project: (a && a.project) || (u && u.project) || null, job: (a && a.job) || (u && u.job) || null });
    return { project: l.lane, worktree: l.member ?? ((a && a.worktree) || (u && u.worktree) || null), job: l.job };
  };
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
    const w = where(a, u);
    sessions.push({
      sessionId,
      project: w.project,
      worktree: w.worktree,
      taskIds: sessionTaskIds(a, u),
      // A job's prompt is the machine's; the day's prompt ticks are the user's.
      prompts: w.job ? [] : prompts,
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
    const w = where(null, u);
    sessions.push({
      sessionId,
      project: w.project,
      worktree: w.worktree,
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

// Punch card: per time window, per
// project, a 7×24 matrix of the user's prompt counts by LOCAL weekday
// (0=Sunday, JS getDay) × hour — "when am I most active". Prompts only: it's
// an attention chart, not a labor one. Windows are trailing day-counts.
function activityPunchcard(windows = [7, 28, 91, 366]) {
  const now = Date.now();
  const cutoffs = windows.map((w) => ({ w, since: now - w * 86400000 }));
  const out = Object.fromEntries(windows.map((w) => [String(w), {}]));
  const place = ledgerPlacement();
  for (const s of mergedActivitySessions().values()) {
    const l = laneOf(place, s);
    if (l.job) continue; // the machine's prompts, not the user's activity
    const slug = l.lane;
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

export { activityRollup, activityDay, activityPunchcard, coalesceSpans, localDay, JOBS_LANE, OUTSIDE_LANE,
  sessionTaskIdsAll, sessionTaskIds, SESSION_TASK_DISPLAY_CAP,
  // The two session folds. Exported so core/cleanup.mjs can run the SAME ladder
  // over the SAME inputs the activity views use — rebuilding these from the raw
  // ledgers would be a second definition of "what a session is", which is the
  // exact duplication task 117 exists to remove.
  mergedActivitySessions, usageSessions };
