// inputs.mjs — what the agent is given, and whether it should be called at all.
//
// Two jobs, in this order:
//
//   1. DID ANYTHING HAPPEN? Most projects most nights produce nothing. Paying an
//      agent to write "no change" twelve times a night is what kills this
//      feature's economics and its credibility at once, so silence is detected
//      cheaply — three filesystem/git reads, no tokens — and the previous brief
//      is carried forward instead.
//
//   2. IF IT DID, gather enough for JUDGEMENT. The standard the brief is held to
//      is "if a sentence could have been produced by counting, cut it", and an
//      agent given only counts can only produce counts. So it gets task BODIES,
//      commit subjects, worktree/claim state, the previous brief — and the last
//      session transcript, which is the only input that answers "what was I
//      doing last". cogyard already reads those transcripts nightly to attribute
//      cost and then throws the content away; reading them for narrative is the
//      closest thing to an unfair advantage this feature has.
//
// Everything is BOUNDED. A dozen projects a night, unbounded, is a bill.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cogyardCore } from './cogyard.mjs';

// Per-project input ceilings. Generous enough for judgement, small enough that
// twelve projects is a sane nightly bill.
const LIMITS = {
  tasks: 14,            // open/parked task bodies, most recently touched first
  taskChars: 2200,      // per task body
  commits: 40,
  turns: 24,            // transcript turns (the TAIL — where the work stopped)
  asks: 6,              // his own last instructions, pulled out of that tail
  turnChars: 900,
  prevBriefChars: 2500,
  totalChars: 60000,    // hard cap on the assembled prompt
};

function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch { return ''; }
}

function head(repo) { return git(repo, ['rev-parse', 'HEAD']) || null; }

// Does this repo still have that commit? `rev-parse --verify --quiet` prints the
// sha and stays silent on a miss — unlike `cat-file -e`, whose success is ALSO
// empty output, which would make a pruned sha indistinguishable from a good one.
function hasCommit(repo, sha) {
  return !!sha && !!git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
}

// Where every branch stood, as a minimal set of shas.
//
// A single HEAD cannot answer "what is new since the last brief" in this system,
// because work happens on many task worktree branches at once. So a brief
// records the whole frontier and the next run asks for whatever is not already
// reachable from it.
//
// Reduced with `merge-base --independent`, which drops every tip that is an
// ancestor of another — on this repo that is 136 refs down to 8, because almost
// every task branch has been merged into main. The reduction is what keeps this
// a short line in a file a person can still read.
function refTips(repo) {
  const raw = git(repo, ['for-each-ref', '--format=%(objectname)']);
  const tips = [...new Set(raw.split('\n').filter(Boolean))];
  const h = head(repo);
  if (h && !tips.includes(h)) tips.push(h);       // a detached worktree HEAD is not a ref
  if (!tips.length) return [];
  const reduced = git(repo, ['merge-base', '--independent', ...tips]).split('\n').filter(Boolean);
  return reduced.length ? reduced : tips;
}

// Commits since the last brief, across every branch.
//
// `--all` is deliberate — work in this system happens on task worktree branches,
// not only on main, and a brief that only saw main would miss almost everything.
// But `--all` MUST NOT be combined with a range. `git log --all A..HEAD` reads as
// "everything reachable from any ref, minus what is reachable from A", so every
// commit on every branch that A cannot reach is reported as new — every night,
// forever. Measured on a real project 2026-08-25: the range form returned
// three commits, two of them from MAY, while the plain range returned nothing.
// That is why nearly every project bought a brief every night, and why those
// briefs open by saying nothing landed: the agent read the evidence, saw it was
// old, and said so. One of them (24 Aug) spelled the bug out —
// "the commit log handed over for this pass is stale ... not new activity".
//
// The fix is to exclude the whole recorded frontier instead of one sha:
// `--all --not <tip> <tip> …`. Verified against a synthetic repo with a stale
// branch: the range form reports the stale branch's commit forever, the --not
// form reports only what actually landed, and a quiet night comes back empty.
//
// ONE source, chosen by what is available — never a chain of fallbacks. An empty
// result is the ANSWER ("nothing new"), not a failure to retry a different way.
// Treating it as a failure and falling through to `--since` re-reported the
// boundary commit (git's `--since` is second-granular and inclusive), so every
// quiet night looked busy — the same economics failure by a different route,
// caught in the sandbox 2026-08-19.
function commitsSince(repo, { sinceTips, sinceTime }) {
  const fmt = '%h%x1f%aI%x1f%an%x1f%s%x1f%cI';
  const base = ['log', '--all', '--no-merges', `--pretty=format:${fmt}`, `-n${LIMITS.commits}`];
  // A tip whose commit is gone (a pruned or rebased branch) cannot be excluded;
  // dropping it over-reports, which writes a brief on a quiet night. That is the
  // safe direction to fail — the other one is silence.
  const known = (sinceTips || []).filter((s) => hasCommit(repo, s));

  let raw = '';
  let cut = null;
  if (known.length) {
    raw = git(repo, [...base, '--not', ...known]);
  } else if (sinceTime) {
    // No frontier recorded (a brief written before this existed). Fall back to
    // when a commit LANDED — committer date, which a rebase or cherry-pick
    // updates — and cut strictly, in JS, rather than trusting `--since`'s
    // inclusive boundary.
    raw = git(repo, [...base, `--since=${sinceTime}`]);
    cut = new Date(sinceTime).getTime();
  } else {
    raw = git(repo, [...base, '--since=7 days ago']);
  }

  return raw.split('\n').filter(Boolean)
    .map((line) => {
      const [hash, date, author, subject, committed] = line.split('\x1f');
      return { hash, date, author, subject, committed };
    })
    // Dates carry offsets, so compare instants — never the ISO strings, which
    // sort wrongly across two different offsets.
    .filter((c) => cut == null || (c.committed && new Date(c.committed).getTime() > cut))
    .map(({ committed, ...c }) => c);
}

// A real task file. The store also holds files that are not tasks: IDEAS.md
// and HANDOFF-*.md are hand-written but a brief has nothing to say about them,
// and a leftover INDEX.md (regenerated by every `tasks sync push` until task
// 190 removed it) once made a push in one project report "a task changed" in
// another, every time.
//
// The id part is `NNN`, `NNN.M` (sub-task) or `NNNx` (letter suffix) — the
// grammar core/validate.mjs parses filenames with, and the reason this is not
// the obvious `\d+-`: a follow-on task like `039a-some-slug.md` is a real task
// and a plain `\d+-` silently misses it, so edits to it would not count as news
// and a night's work on it would read as a quiet night.
//
// This is a SECOND spelling of that grammar — the add-on installs outside the
// repo and cannot import core synchronously — so test/brief-silence.test.mjs
// asserts it agrees with core/validate.mjs on a corpus. If the grammar ever
// moves, that test fails rather than this quietly drifting.
const TASK_FILE = /^\d+(?:\.\d+)?[a-z]?-.+\.md$/;

function taskFiles(tasksDir) {
  try { return readdirSync(tasksDir).filter((f) => TASK_FILE.test(f)).sort(); }
  catch { return []; }
}

// A fingerprint of what the task files SAY, not when they were touched.
//
// mtime alone cannot answer "did anything change", and on this store it
// routinely says yes when nothing did: `env claim` followed by `env release`
// rewrites a file back to its original bytes, a sync push rewrites files it
// pulled, and any editor that saves without changing anything bumps it. Each of
// those bought a full agent call. Hashing the content makes the answer honest,
// and one sha over ~135 files is a few milliseconds against a $0.15 alternative.
//
// ONE scalar, stored in the brief's frontmatter — a per-file hash map would be
// truer still and would turn a tiny flat format into a database. When the digest
// moves, mtime is good enough to say WHICH files moved: naming an extra file is
// harmless, paying for a night that did not happen is not.
function tasksDigest(tasksDir) {
  if (!tasksDir || !existsSync(tasksDir)) return null;
  const h = createHash('sha1');
  for (const f of taskFiles(tasksDir)) {
    try { h.update(f).update('\0').update(readFileSync(join(tasksDir, f))).update('\0'); }
    catch { /* unreadable entry contributes nothing rather than throwing */ }
  }
  return h.digest('hex').slice(0, 16);
}

// Which task files moved since a moment. mtime, not git: a task file lives in
// the store (often a symlink to a different repo), and an edit that has not been
// pushed yet is still news. Only ever called once the digest has already said
// something really changed — see detectChange.
function taskEditsSince(tasksDir, sinceTime) {
  if (!tasksDir || !existsSync(tasksDir)) return [];
  const cut = sinceTime ? new Date(sinceTime).getTime() : 0;
  const out = [];
  for (const f of taskFiles(tasksDir)) {
    try {
      const st = statSync(join(tasksDir, f));
      if (st.mtimeMs > cut) out.push({ file: f, at: new Date(st.mtimeMs).toISOString() });
    } catch { /* unreadable entry is not news */ }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// Sessions on this project since a moment, newest first, from the activity
// ledger the engine already harvests nightly.
//
// A session counts only when the OWNER SAID SOMETHING in it, timed by his own
// last prompt. Two rules, both of which used to be the other way round and
// together are why a quiet project still paid for a brief every night:
//
//   * `capturedAt` is when cogyard HARVESTED the row, not when anything happened
//     in the session. activity.jsonl is append-only and re-harvests live
//     sessions — 166 of 531 sessions carry more than one row — so falling back
//     to it gave a finished session a fresh timestamp on every collection. Real
//     case, 2026-08-25: one project's session 989408a0 ended on the 24th and
//     was re-harvested at 05:39 on the 25th, minutes before the 05:00 brief run,
//     which duly reported new activity. Every night. Forever. It is not a
//     fallback with a bad edge case; it is the wrong clock, so it is gone.
//   * a row with no prompts is a window that was opened. Opening a project is
//     the owner's own example of a day when nothing happened.
//
// Deduped by session, keeping its newest prompt: the same session appearing in
// four harvest rows is one session, and counting it four times misreports a
// quiet week as a busy one to the agent that writes the paragraph.
async function sessionsSince(slug, sinceTime) {
  const core = await cogyardCore();
  const cut = sinceTime ? new Date(sinceTime).getTime() : 0;
  const bySession = new Map();
  for (const row of core.readActivityLedger()) {
    if (row.project !== slug || !row.sessionId) continue;
    const prompts = row.prompts || [];
    if (!prompts.length) continue;
    const at = prompts.reduce((a, b) => (a > b ? a : b), '');
    if (!at || new Date(at).getTime() <= cut) continue;
    const prior = bySession.get(row.sessionId);
    if (prior && prior.at >= at) continue;
    bySession.set(row.sessionId, { sessionId: row.sessionId, at, worktree: row.worktree || null, prompts: prompts.length });
  }
  return [...bySession.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Has anything happened on this project since the previous brief? Cheap reads
// and no agent call. `changed` false means: carry the previous brief forward and
// spend nothing.
//
// THREE THINGS COUNT, and each one is a thing the owner did:
//
//   commits    — work landed. Always news.
//   sessions   — he sat down and typed. See sessionsSince for what does not.
//   task edits — a task file's CONTENT moved. See tasksDigest for why content
//                and not mtime.
//
// Everything else is a quiet day, which is the normal day. The bar is
// deliberately "did a person do something", not "did any byte anywhere move":
// this function's false-positive is a paid agent call producing a paragraph that
// says nothing happened, twelve times a night, which is the failure that
// discredits the whole feature (and did — six briefs on this repo, none carried
// forward, ~$0.15 a night, up to 2026-08-25).
//
// The false-NEGATIVE — a real day read as quiet — costs a night of narrative and
// is caught the next night, because the range is measured from the last brief
// that was WRITTEN, not from yesterday. That asymmetry is why the rules above
// are allowed to be strict.
//
// There is no config knob for the bar. It was specced as one and is deliberately
// not built: every candidate ("minimum prompts", "ignore sessions") is a switch
// between a right answer and a wrong one, and shipping the wrong one behind a
// setting is how the wrong one survives.
async function detectChange(project, prev) {
  const sinceTime = prev?.meta?.generated_at || null;
  // The frontier the previous brief recorded. Absent on briefs written before
  // this existed, which is what commitsSince's time fallback is for.
  const sinceTips = String(prev?.meta?.refs || '').split(/\s+/).filter(Boolean);
  const tasksDir = join(project.path, '.cogyard', 'tasks');
  const commits = commitsSince(project.path, { sinceTips, sinceTime });
  const sessions = await sessionsSince(project.slug, sinceTime);

  // The digest is the gate; mtime only ever names the files behind it. A brief
  // written before digests existed has none, so fall back to mtime alone for one
  // night rather than declaring the store unchanged on no evidence.
  const digest = tasksDigest(tasksDir);
  const prevDigest = prev?.meta?.tasks_digest || null;
  const tasksMoved = !prevDigest || !digest || digest !== prevDigest;
  const taskEdits = tasksMoved ? taskEditsSince(tasksDir, sinceTime) : [];

  return {
    // No previous brief at all → there IS a story to tell (the project's current
    // state), so the first brief always runs.
    changed: !prev || !!(commits.length || sessions.length || taskEdits.length),
    first: !prev,
    commits,
    sessions,
    taskEdits,
    head: head(project.path),
    // The frontier as it stands NOW, recorded in the brief this run writes so
    // tomorrow night can ask what is new since it.
    tips: refTips(project.path),
    tasksDigest: digest,
  };
}

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The open work, bodies included, most recently touched first. Closed tasks are
// summarized as one line each and only when they closed recently — "what
// happened" needs to know a thing shipped, but not to re-read it.
function taskInputs(loaded, change) {
  const edited = new Set(change.taskEdits.map((e) => e.file));
  const open = [];
  const closedRecently = [];
  for (const t of loaded.tasks) {
    const fm = t.frontmatter || {};
    const id = fm.id ?? null;
    const file = t.path ? t.path.split('/').pop() : '';
    const row = { id, title: fm.title || '', status: fm.status || '', file, editedSinceLastBrief: edited.has(file) };
    if (['DONE', 'ENOUGH', 'OBSOLETE'].includes(String(fm.status))) {
      if (fm.done_date) closedRecently.push({ ...row, doneDate: fm.done_date });
      continue;
    }
    open.push({
      ...row,
      claimedBy: fm.env?.claimed_by || null,
      claimedAt: fm.env?.claimed_at || null,
      worktree: fm.env?.worktree || null,
      dependsOn: Array.isArray(fm.depends_on) ? fm.depends_on : [],
      // The checkbox ratio is a COUNT and the brief may not restate it — it is
      // here so the agent can tell "barely started" from "one item left", which
      // is a judgement.
      scope: t.derived ? { done: t.derived.checkedCount, total: t.derived.totalCount } : null,
      body: clip(t.body, LIMITS.taskChars),
    });
  }
  open.sort((a, b) => Number(b.editedSinceLastBrief) - Number(a.editedSinceLastBrief) || Number(b.id) - Number(a.id));
  closedRecently.sort((a, b) => String(b.doneDate).localeCompare(String(a.doneDate)));
  return { open: open.slice(0, LIMITS.tasks), closedRecently: closedRecently.slice(0, 8), openCount: open.length };
}

// The tail of the most recent session — where the work actually stopped, and
// what it hit on the way. The tail, not the head: the first turns are the ask,
// the last turns are the state.
async function lastSessionTurns(sessions) {
  if (!sessions.length) return null;
  const core = await cogyardCore();
  const chat = core.transcriptForChat(sessions[0].sessionId);
  if (!chat.found || !chat.turns.length) return null;
  // The tail alone is often a run of assistant turns — an agent narrating its
  // own work — which reads as what the AI was doing, not what HE was doing. His
  // own last instructions are the sharper answer to "what was I doing last", so
  // they are pulled out separately as well as left in place in the tail.
  const asks = chat.turns.filter((t) => t.role === 'user').slice(-LIMITS.asks)
    .map((t) => clip(t.text, LIMITS.turnChars));
  return {
    sessionId: sessions[0].sessionId,
    at: sessions[0].at,
    worktree: sessions[0].worktree,
    asks,
    turns: chat.turns.slice(-LIMITS.turns).map((t) => ({ role: t.role, text: clip(t.text, LIMITS.turnChars) })),
  };
}

// Worktrees with their claim + divergence state: what is mid-flight, what is
// abandoned, what merged and was never cleaned up.
async function worktreeInputs(project) {
  const core = await cogyardCore();
  try {
    const rows = await core.worktreesForProject(project);
    return rows.map((w) => ({
      name: w.name,
      branch: w.branch || null,
      main: !!w.isMain,
      ahead: w.ahead ?? null,
      behind: w.behind ?? null,
      dirty: w.dirty ?? null,
      // Core's own verdict for "branched, never committed, nothing uncommitted"
      // — the shape of an abandoned worktree.
      abandoned: !!w.stale,
      claimedByTaskId: w.claimedByTaskId ?? null,
      claimLive: !!w.claimLive,
    }));
  } catch { return []; }
}

// Everything the agent gets for one project, already bounded.
async function gather(project, prev, change) {
  const core = await cogyardCore();
  const loaded = await core.loadProjectAsync(project.path);
  return {
    project: { slug: project.slug, label: project.label, path: project.path },
    change,
    tasks: taskInputs(loaded, change),
    worktrees: await worktreeInputs(project),
    lastSession: await lastSessionTurns(change.sessions),
    previousBrief: prev
      ? { date: prev.meta.date || null, carriedThrough: prev.meta.carried_through || null, text: clip(prev.body, LIMITS.prevBriefChars) }
      : null,
  };
}

export { LIMITS, git, head, hasCommit, refTips, commitsSince, taskFiles, tasksDigest, taskEditsSince, sessionsSince, detectChange, gather, clip };
