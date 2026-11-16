// core/addons/schedule.mjs — the scheduled-job vocabulary and slot arithmetic.
// Pure leaf (imports nothing), so both the add-on registry (index.mjs, which
// publishes a normalized schedule to the portal) and the job runner (jobs.mjs)
// can use it without an import cycle. Same posture as core/status.mjs.
//
// Deliberately NOT cron. `{ every: 'day' | 'week', at: 'HH:MM' }` covers every
// job we can foresee; a cron string is a parser plus a support burden for
// expressiveness nobody asked for (owner's call, 2026-08-12). Widening this
// later is easy; narrowing it after add-ons depend on it is not.

const EVERY = ['day', 'week'];

// Bounds every scheduled job runs under. `timeoutMs` is enforced BY CORE (the
// run is aborted); the other two are handed to the job in ctx.bounds for it to
// honour, because only the job knows what a "unit" of its work is. Core cannot
// count something it has no concept of.
const DEFAULT_BOUNDS = { timeoutMs: 15 * 60 * 1000, maxUnits: 50, maxCostUsd: 5 };

// How late a missed slot may still run when catchUp is off.
const CATCHUP_GRACE_MS = 60 * 60 * 1000;

// Normalize a manifest's `schedule` to { every, at, hour, minute, weekday,
// catchUp } — or null when absent or malformed. Null means "not a scheduled
// job": a typo'd schedule must never silently become a DIFFERENT schedule, and
// must never crash the loader either, so it degrades to not-scheduled.
function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const every = EVERY.includes(raw.every) ? raw.every : null;
  if (!every) return null;
  const m = typeof raw.at === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.at.trim()) : null;
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  // Weekly needs a day; `every: 'week'` alone is underspecified. 1 = Monday
  // (JS getDay(): 0 = Sunday).
  const wd = Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6 ? raw.weekday : 1;
  return {
    every,
    at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
    weekday: every === 'week' ? wd : null,
    // Default ON: a laptop that sleeps through every slot would otherwise never
    // run the job at all, and give no sign of why.
    catchUp: raw.catchUp !== false,
  };
}

function normalizeBounds(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    timeoutMs: num(b.timeoutMs, DEFAULT_BOUNDS.timeoutMs),
    maxUnits: num(b.maxUnits, DEFAULT_BOUNDS.maxUnits),
    maxCostUsd: num(b.maxCostUsd, DEFAULT_BOUNDS.maxCostUsd),
  };
}

// Local wall-clock, deliberately: "05:00" means 05:00 where the machine is, and
// keeps meaning that across a DST change. Building from local Date parts (never
// a UTC offset) is what makes that true.
function slotOn(date, schedule) {
  const d = new Date(date);
  d.setHours(schedule.hour, schedule.minute, 0, 0);
  return d;
}

// The most recent scheduled moment at or before `now`.
function prevSlot(schedule, now = new Date()) {
  if (!schedule) return null;
  const candidate = slotOn(now, schedule);
  if (schedule.every === 'day') {
    if (candidate <= now) return candidate;
    const y = new Date(candidate);
    y.setDate(y.getDate() - 1);
    return y;
  }
  const back = new Date(candidate);
  back.setDate(back.getDate() - ((back.getDay() - schedule.weekday + 7) % 7));
  if (back > now) back.setDate(back.getDate() - 7);
  return back;
}

// The next scheduled moment strictly after `from`.
function nextSlot(schedule, from = new Date()) {
  if (!schedule) return null;
  const candidate = slotOn(from, schedule);
  if (schedule.every === 'day') {
    if (candidate > from) return candidate;
    const t = new Date(candidate);
    t.setDate(t.getDate() + 1);
    return t;
  }
  const fwd = new Date(candidate);
  fwd.setDate(fwd.getDate() + ((schedule.weekday - fwd.getDay() + 7) % 7));
  if (fwd <= from) fwd.setDate(fwd.getDate() + 7);
  return fwd;
}

// Is this job due? `since` is its last run — or, for a job that has never run,
// the time it was first seen (jobs.mjs seeds that). The seed is what stops a
// freshly installed job from firing immediately: without it, "never ran" reads
// as "missed every slot since the epoch".
//
// catchUp ON  → any missed slot still counts: the machine woke up, run it.
// catchUp OFF → only a slot inside the grace window counts; an older missed slot
//               is skipped. A missed night is a missed night, never a queue that
//               floods on wake.
function isDue(schedule, since, now = new Date()) {
  const prev = prevSlot(schedule, now);
  if (!prev) return false;
  const last = since ? new Date(since) : null;
  if (last && last >= prev) return false;
  if (schedule.catchUp) return true;
  return now - prev <= CATCHUP_GRACE_MS;
}

export {
  EVERY, DEFAULT_BOUNDS, CATCHUP_GRACE_MS,
  normalizeSchedule, normalizeBounds, prevSlot, nextSlot, isDue,
};
