// Wire shapes for the cogyard /api endpoints — 1:1 with the server's JSON.
// The service file (api.service.ts) exports only the client class; every
// response/entity type lives here. New endpoint = new interface here first.

// /api/health
export interface HealthResponse { ok: boolean; commit: string | null; version: string | null; projects: number; }

// /api/projects — `claimed` backs the sidebar + dock badges (tasks in flight);
// `unmerged` (worktrees ahead of main) still ships for the Branches/overview views.
export interface Project { slug: string; label: string; claimed?: number; unmerged?: number; }

// /api/tasks
// A resolved label axis (task 096): a named, colored bundle of sibling labels.
// `axes` is the shared+project map resolved server-side (core/axes.mjs); [] when
// no map exists, which the portal renders as today's flat label list.
export interface AxisRow { name: string; color: string; labels: string[]; }
export interface TasksResponse { slug: string; label: string; tasks: any[]; axes?: AxisRow[]; }

// /api/plan (task 179) — what's left, grouped by one plain rule each. Every
// field is derived in core/plan.mjs (its header states the rules); the page only
// lays it out and filters it. Task ids are TEXT ('40', '40.1', '40e'); a
// cross-project dep reads '<slug>#<id>'.
/** Another active task this one shares a file or a resource with (task 239): they shouldn't run at
 *  the same time, but either may go first — never a wait. softClash entries share Markdown only. */
export interface PlanClash { id: string; files: string[]; resources?: string[]; }
export interface PlanBlocks { project: string; id: string; title: string; status: string; }
export interface PlanTask {
  id: string; title: string; name: string; type: string | null; what: string; status: string;
  /** The task's category tags, its frontmatter `labels` ([] when none) — coloured by `PlanResponse.axes` (task 227). */
  labels: string[];
  done: number; total: number; left: number; size: 'quick' | 'mid' | 'long';
  /** One per counted box, in task-file order (length = total) — the card's squares (task 251). */
  boxes: TaskBox[];
  /** Where the task's code is (task 251; rules in core/plan.mjs's header). */
  code: PlanCode;
  unmet: string[]; unblocks: string[];
  /** Tasks whose depends_on lists this one (the card's "frees"). */
  waitedOnBy: string[];
  blocksOther: PlanBlocks[];
  clash: PlanClash[]; softClash: PlanClash[]; filesUnknown: boolean;
  /** Its frontmatter `resources`: live things it uses that aren't files (task 239). */
  resources: string[];
  /** touches_paths entries the clash check ignores: whole folders, paths outside the repo. */
  skippedPaths: string[];
  /** Owner steps: unticked boxes marked `(you: <kind>)`. youNext = the NEXT unticked box is the owner's
   *  (its kinds); youLater = kinds of the owner's boxes further down. Neither = autopilot can finish it. */
  youNext: string[] | null; youLater: string[]; youSteps: { kinds: string[]; text: string }[];
  touchesOther: boolean;
  startNow: boolean; claimedBy: string | null;
  /** Claimed, but the claim's worktree no longer exists (task 189) — still in progress, flagged on the card. */
  worktreeMissing: boolean;
  claimedAt: string | null;
  /** Claimed by a named person who is not this machine's user (task 202) — the card shows their name. */
  claimedByOther: boolean;
  /** What the agent on this claimed task is doing right now (task 202); null when unclaimed or someone else's. */
  agent: LiveState | null;
}
/** One counted checkbox (task 251). onMain: true = its code is on main, false = only on the branch,
 *  null = unticked, or the task has no code state (no branch, no `[#N]` commit on main). */
export interface TaskBox { done: boolean; onMain: boolean | null; }
/** Where a task's code is (task 251). none = no branch and no `[#N]` commit on main; merged = main has a
 *  `[#N]` commit and the branch has nothing main lacks; ahead = the branch has commits main lacks.
 *  branch is null when no recorded branch exists. */
export interface PlanCode { state: 'none' | 'merged' | 'ahead'; ahead: number; behind: number; branch: string | null; }
/** A claimed task's live agent state (core/live-state.mjs liveForTask, task 202). */
export interface LiveState {
  /** The driver that reported it — names its logo (GET /api/drivers/<driver>/logo). */
  driver: string;
  /** working = running · needs = waiting on you · stopped = idle · background = idle, with a job the
   *  chat started still running (task 229) · error = the turn ended on an API error ·
   *  archived / deleted = the owner archived or deleted the chat in the agent app (task 226) ·
   *  unknown = the driver cannot report. */
  state: 'working' | 'needs' | 'stopped' | 'background' | 'error' | 'archived' | 'deleted' | 'unknown';
  /** For state error: the type the agent reported (e.g. rate_limit, overloaded). */
  error?: string;
  /** When this state began / the last event, epoch ms (null when no record). */
  since: number | null; at: number | null;
  /** The record is the task's own autopilot worker's, not the chat's. */
  autopilot: boolean;
}
/** A waiting box: the tasks in it all list `after` in their depends_on. */
export interface PlanBox { after: string[]; tasks: string[]; }
export interface PlanProblem { id: string; kind: string; text: string; }
export interface PlanResponse {
  slug: string; label: string;
  groups: { progress: string[]; can: string[]; dep: PlanBox[]; other: PlanBox[]; look: string[] };
  parked: string[];
  tasks: Record<string, PlanTask>;
  problems: PlanProblem[];
  /** The project's resolved label axes — the same rows /api/tasks sends; colour each card's tags (task 227). */
  axes: AxisRow[];
}

// /api/recently-done (task 198) — the Plan tab's Recently done strip: up to 20
// DONE tasks, newest first. doneDate is YYYY-MM-DD (no time of day).
export interface RecentlyDoneTask {
  id: string; title: string; type: string | null; labels: string[]; doneDate: string; done: number; total: number;
  /** In task-file order; onMain is always null (a finished task's squares stay grey, task 251). */
  boxes: TaskBox[];
}
export interface RecentlyDoneResponse { slug: string; tasks: RecentlyDoneTask[]; }

// /api/in-progress (task 265) — the All tab's per-project boxes, one row per
// registered project in registry order: its Plan `progress` tasks (the Plan
// card's own fields, core/in-progress.mjs PROGRESS_FIELDS) and its newest 10
// Recently done tasks. A project that could not be read has `error` instead.
export type InProgressTask = Pick<PlanTask, 'id' | 'title' | 'type' | 'labels' | 'status' | 'done' | 'total' | 'boxes' | 'code'
  | 'youNext' | 'youLater' | 'youSteps' | 'worktreeMissing' | 'claimedBy' | 'claimedAt' | 'claimedByOther' | 'agent'>;
export interface InProgressProject {
  slug: string; label: string;
  progress?: InProgressTask[];
  recent?: RecentlyDoneTask[];
  error?: string;
}
export interface InProgressResponse { projects: InProgressProject[]; }

// /api/daily — everything the nightly jobs left for this project, behind the
// Daily tab. The brief HISTORY is the point of keeping them: coming back after
// two weeks, one night's paragraph answers the wrong question.
export interface DailyResponse { slug: string; label: string; briefs: Brief[]; drift: Drift | null; heartbeats: Heartbeat[]; }

// One job's record that it LOOKED at this project (task 134), separate from
// whether it found anything to say. Once a quiet night correctly writes nothing,
// "quiet for a week" and "dead for a week" are the same empty page without this.
//
// An EMPTY array is not an alarm — most projects have no nightly job and never
// will. Only a heartbeat that exists and has gone stale says something is wrong.
export interface Heartbeat {
  job: string;                                  // the add-on id that wrote it
  checked: string | null;                       // local day it looked, YYYY-MM-DD
  checkedAt: string | null;                     // exact moment, ISO
  outcome: 'written' | 'unchanged' | 'failed' | null;
  note: string;                                 // one plain sentence, for a human reading the file
}

// The doc-drift report (task 119) — docs whose own area kept changing long after
// the doc did. Null when there is no report, and NO REPORT MEANS NO FINDINGS:
// the job deletes the file on a clean pass, so a stale one can never be read as
// a live finding.
export interface Drift {
  generatedAt: string | null;
  findings: number;
  examined: number;
  candidates: number;
  cost: number | null;
  markdown: string;
}

// One nightly brief (task 120). `status: 'failed'` is a run
// that COULD NOT LOOK, and must never be shown the way a quiet night is:
// `failures` counts the nights running so a third one doesn't read like a first.
export interface Brief {
  date: string | null;
  status: 'ok' | 'failed';
  carriedThrough: string | null;   // written on `date`, still current on this one
  generatedAt: string | null;
  cost: number | null;
  model: string | null;
  error: string | null;            // failed only
  // failed only — WHY, so the portal can send the owner to the right place.
  // Four come from the driver (docs/DRIVERS.md), 'unusable' from the brief job:
  //   'no-response' = nothing arrived; the agent was never reached (this is the
  //                   one that may mean a dead credential)
  //   'stalled'     = it began answering and then stopped — the credential is
  //                   demonstrably fine, so never blame it here
  //   'cancelled'   = the nightly run ended before this project's call finished
  //   'error'       = it could not run, or reported its own error
  //   'unusable'    = it answered, was paid, and that was not a brief
  failureKind: 'no-response' | 'stalled' | 'cancelled' | 'error' | 'unusable' | null;
  failures: number;                // failed only: consecutive nights
  lastGood: string | null;         // failed only: date of the last brief that worked
  markdown: string;
  lead: string;
}

// GET/POST /api/axes — the /settings axis manager (task 096, Phase 4). Edits each
// LAYER raw: scope 'shared' = machine-global ~/.cogyard/axes.json; 'project' = a
// selected project's committed <repo>/.cogyard/axes.json. Both through the write seam.
export interface AxesResponse { scope: 'shared' | 'project'; slug?: string; axes: AxisRow[]; ok?: boolean; }
export interface SaveAxesRequest { scope: 'shared' | 'project'; slug?: string; axes: AxisRow[]; }

// GET/POST /api/switches — a project's switches (task 246), stored in its task
// store's switches.json. `switches` is the resolved view (as `cogyard tasks
// switches --json` prints it); `stored` is only what the file sets.
export type RebaseSwitch = 'always' | 'ask';
export type VersionCommand = { command: string; file: string };
export type VersionSwitch = 'off' | 'minor' | 'patch' | VersionCommand;
export interface ProjectSwitchesStored { rebase?: RebaseSwitch; version?: VersionSwitch; }
export interface SwitchesResponse {
  slug: string;
  switches: {
    rebase: { value: RebaseSwitch; set: boolean };
    version: { value: VersionSwitch; set: boolean; file: string | null };
  };
  stored: ProjectSwitchesStored;
  defaults: { rebase: RebaseSwitch; version: VersionSwitch };
  problems: string[];
  ok?: boolean;
}
export interface SaveSwitchesRequest { slug: string; switches: { rebase: RebaseSwitch | null; version: VersionSwitch | null }; }

// /api/worktrees
export interface WorktreesResponse { slug: string; label: string; worktrees: any[]; }

// /api/graph
// rows is a heterogeneous list: ordinary commit rows, `kind:'worktree'` pseudo-rows
// (dirty checkouts), and `kind:'stash'` pseudo-rows (collapsed git stashes —
// stashRef/message/sha/base; see core/git-views.mjs spliceStashRows). The graph
// component's Row interface is the precise client-side shape.
export interface GraphResponse {
  slug: string; label: string; originUrl: string | null; rows: any[]; laneCount: number;
  // The folder this view reads (the checkout, or the task store) for the action
  // bar's folder link — `display` is the `~/…` form. null: no store to show.
  folder?: { path: string; display: string } | null;
  // Store mode only (?source=store, task 191). `store` is null when the project
  // has no separate task store.
  source?: 'store'; store?: StoreFacts | null; flagged?: boolean;
  flaggedCount?: number; scanned?: number; hiddenAfter?: number; days?: number;
  // Task 217: what the task link is (why `store` is null, when it is), and
  // which other projects read the same store.
  link?: StoreLink;
  sharedWith?: string[];
}

// Task store rules (task 191, core/store-audit.mjs). A flag's tone is one of the
// app-flag tones; `kind` is stable, `text` is what the chip says.
export type StoreFileClass = 'task' | 'attachment' | 'index' | 'job' | 'allowed' | 'other';
export interface StoreFlag { kind: string; tone: 'good' | 'warn' | 'bad' | 'review' | 'neutral' | 'info'; text: string; }
export interface StorePending {
  count: number; byClass: Record<StoreFileClass, number>;
  oldestMs: number | null; oldestDays: number | null; flags: StoreFlag[];
}
export interface StoreFacts {
  path: string; branch: string | null; remote: boolean; unpushed: number | null;
  lastCommit: { short: string; relDate: string | null } | null;
  pending: StorePending & { files: { path: string; status: string; cls: StoreFileClass }[] };
  flags: StoreFlag[];
}
export interface StoreWeek { days: number; commits: number; flagged: number; job: number; other: number; otherTasks: number; }

// /api/overview
export interface OverviewResponse { projects: any[]; }

// /api/commit
export interface CommitDetail {
  // status: one letter; path: where the file is now; oldPath: a rename's or copy's source (task 224).
  hash: string; author: string; date: string; subject: string; body: string; files: { status: string; path: string; oldPath?: string }[];
  // Store mode (task 191): each file's class and, for another task's file, its id.
  audit?: { flags: StoreFlag[]; files: { status: string; path: string; oldPath?: string; cls: StoreFileClass; foreignTask: string | null }[] };
}

// /api/diff · /api/workdiff · /api/wtdiff
export interface DiffResponse { patch: string; }

// /api/status
export interface ChangeFile { path: string; status?: string; oldPath?: string; }
export interface StatusResponse {
  branch: string; staged: ChangeFile[]; unstaged: ChangeFile[]; untracked: ChangeFile[]; clean: boolean;
  // Store mode (task 191): what each uncommitted file is, and the pending flags.
  audit?: { flags: StoreFlag[]; files: { path: string; status: string; cls: StoreFileClass }[] };
}

// /api/branches
export interface Branch {
  name: string; isRemote: boolean; hash: string; author: string; subject: string;
  iso: string; relDate: string; staleDays: number | null;
  aheadMain: number; behindMain: number; merged: boolean; unpushed: boolean;
  hasWorktree: boolean; worktreeName: string | null; isHead: boolean; upstream: string | null; onOrigin: boolean;
  taskId: string | null; // server-computed branch→task association (core matchBranchTask)
}
export interface BranchesResponse { main: string | null; originUrl: string | null; branches: Branch[]; }

// /api/wt-activity
export interface WtInfo { path: string; name: string; branch: string | null; isMain: boolean; lastActivity: string | null; }
export interface WtActivityResponse { slug: string; worktrees: WtInfo[]; }

// /api/tree
// `tracked: false` = "non-git" (untracked — gitignored build output or just not
// yet `git add`ed). Drives the "hide non-git" filter and the grayed row styling.
// status/oldPath = vs main; commitStatus/commitOldPath = vs one commit (task 224):
// the one asked for with ?commit=, else the last commit (= what is not committed
// yet). The Files tab's compare switch picks which to show.
export interface TreeFile {
  path: string; status: string | null; oldPath?: string;
  commitStatus: string | null; commitOldPath?: string;
  onDisk: boolean; tracked: boolean;
}
// Which comparison the Files tab shows: 'main' (default), 'head' = the last
// commit, or an older commit's sha (picked from the branch's recent commits).
export type FilesBase = string;
export interface RecentCommit { sha: string; short: string; subject: string; relDate: string; }
export interface TreeResponse {
  worktree: string; branch: string; vsRef: string | null;
  vsCommit: string | null;      // full sha commitStatus compares against
  mainCommit: RecentCommit | null; // main's tip commit (what `status` compares against)
  commits: RecentCommit[];      // the branch's newest 10, newest first
  files: TreeFile[];
}

// /api/file
export interface FileContent { content?: string; truncated?: boolean; size: number; binary?: boolean; hash?: string; }
// content is present only when the server-side prettier pass changed the buffer —
// the editor re-baselines to it so the doc matches what's actually on disk.
export interface SaveFileResult { hash: string; size: number; content?: string; }

// /api/usage — token/cost ledger rollups. costUSD was locked in at
// collection time (see core/pricing.mjs); backfilledCostUSD is the slice priced
// retroactively at current rates and rendered with an ≈ in the UI.
export interface UsageTokens { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; }
export interface UsageBucket { tokens: UsageTokens; costUSD: number; backfilledCostUSD: number; unpricedRows: number; }
export interface ProjectUsageRollup extends UsageBucket { project: string; sessions: number; models: Record<string, UsageBucket>; }
// Task 130: every ledger row is in exactly one collection, so the three add up
// to the whole ledger. `jobs` = a scheduled job's own agent calls; `outside` =
// rows under no registered project, keyed by the slug they were written under.
export interface JobUsageRollup extends UsageBucket { job: string; sessions: number; models: Record<string, UsageBucket>; }
export interface UsageResponse { projects: ProjectUsageRollup[]; jobs: JobUsageRollup[]; outside: ProjectUsageRollup[]; }
export interface TaskUsage extends UsageBucket { taskId: number | null; models: Record<string, UsageBucket>; }
export interface WorktreeUsage extends UsageBucket { worktree: string | null; sessions: number; }
export interface ProjectUsageResponse extends UsageBucket {
  project: string; sessions: number;
  models: Record<string, UsageBucket>;
  tasks: TaskUsage[];
  worktrees: WorktreeUsage[];
}

// Task → chats (task 30): which chats created/implemented/mentioned a task.
export interface TaskChat {
  sessionId: string;
  role: 'created' | 'claimed' | 'committed' | 'mentioned';
  title: string | null;   // the agent app's own name for the chat (Desktop sidebar title)
  label: string | null;   // first-prompt snippet
  startedAt: string | null;
  lastActiveAt: string | null;
  transcriptPath: string | null;
  archived: boolean;
  inferred: boolean;
}
export interface TaskChatsResponse {
  taskId: number | string;
  project: string | null;
  created: TaskChat | null;
  implemented: TaskChat[];
  mentioned: TaskChat[];
}
export interface TranscriptTurn { role: 'user' | 'assistant'; text: string; timestamp: string | null; }
export interface TaskTranscriptResponse {
  sessionId: string;
  found: boolean;
  transcriptPath: string | null;
  turns: TranscriptTurn[];
  truncated: boolean;
}
// POST /api/usage/collect
export interface CollectResult { rows: number; files: number; skippedModels: string[]; }

// /api/activity — activity views. commits: slug → localDay → count.
// projects: slug → per-local-day attention/cost cells. costUSD is spread by
// MINED hour weights; costApproxUSD is the even-spread estimate for sessions
// whose transcripts were pruned before mining — the UI renders it distinctly.
export interface ActivityDayCell { prompts: number; attentionMin: number; costUSD: number; costApproxUSD: number; }
export interface ActivityResponse {
  days: number; sinceDay: string; gapMin: number;
  commits: Record<string, Record<string, number>>;
  merges: Record<string, Record<string, string[]>>; // slug → YYYY-MM-DD → task ids that landed on the default branch that day
  projects: Record<string, { days: Record<string, ActivityDayCell> }>;
  punchcards: Record<string, Record<string, number[][]>>; // window days → slug → [weekday 0=Sun][hour 0-23] prompt counts
  // Task 130: `projects` keys are registered slugs plus two folded lanes —
  // "Scheduled tasks" (cost only) and "Outside any project". This names which
  // keys those are and what each folds together.
  lanes: Record<string, { kind: 'jobs' | 'outside'; members: string[] }>;
}
// /api/activity/day/:date — the drill-down. hours: UTC-hour key → assistant
// message count that hour. approx sessions carry firstTs/lastTs instead.
export interface ActivityDaySession {
  sessionId: string; project: string; worktree: string | null;
  taskIds: string[]; // which task(s) the session worked — claims join, mined task-file refs, worktree name
  prompts: string[]; hours: Record<string, number>; costUSD: number; approx: boolean;
  firstTs?: string; lastTs?: string;
}
export interface ActivityDayResponse { date: string; sessions: ActivityDaySession[]; prompts: Record<string, string[]>; }

// POST /api/wt/{stage,unstage,discard} · /api/open (working-tree actions)
export interface ActionResult { ok: boolean; }

// GET /api/open-targets — the editable "Open in" app list (id + label only;
// the command stays server-side in ~/.cogyard/open-targets.json).
export interface OpenTarget { id: string; label: string; }

// GET/POST /api/config + POST /api/open-targets. The /settings view +
// first-run wizard render this; the New/Add drawer prefills its form from `defaults`.
export interface CreationDefaults { kind: ProjectKind; }
export interface OpenTargetFull { id: string; label: string; exec: string; args: string[]; }
export type WeekStart = 'sunday' | 'monday';
// projectIcons: slug → image path relative to THAT project's repo root (task 114).
// The file is served by GET /api/project-icon?slug=…; an absent key means no icon.
// projectIconBorders: the slugs whose icon gets a white border behind it on the
// dark rail — an owner-set checkbox, never inferred from the artwork.
// defaultTab: the tab a project opens on (task 216) — the server resolves it to
// a visible tab, so it is never one of hiddenTabs.
export interface UiPrefs {
  weekStart: WeekStart; dayStart: number; hiddenTabs: string[]; defaultTab: string;
  projectIcons: Record<string, string>; projectIconBorders: string[];
}
export interface ConfigResponse {
  home: string; homeFromEnv: boolean;
  projectsRoot: string; projectsRootSource: 'env' | 'config' | 'default';
  version: string | null; commit: string | null;
  openTargets: OpenTargetFull[];
  defaults: CreationDefaults;
  kinds: ScaffoldKindInfo[]; // the scaffold registry rows
  ui: UiPrefs;
  // Derived server-side, never persisted (task 140): { [slug]: version } for the
  // artwork each configured icon currently resolves to. Threaded into the
  // /api/project-icon URL so re-pointing an icon — or editing the file in place —
  // changes the address and defeats the browser cache. A slug is absent when its
  // file is unreadable; callers then omit the parameter.
  projectIconVersions: Record<string, string>;
  driver: { active: string; available: string[] };
}
// GET /api/project-images — the Icon card's picker (task 140). Repo-root-relative
// image paths, sorted; nothing here is ranked or nominated as "the icon".
export interface ProjectImagesResponse {
  slug: string;
  repoPath: string;      // absolute repo root — named in the Copy-instructions brief
  extensions: string[];  // ICON_MIME's keys, so the brief's format list can't drift
  images: string[];
}
// Wire-input shape for POST /api/config — only the settable bits, all optional.
export interface SaveConfigRequest { defaults?: Partial<CreationDefaults>; ui?: Partial<UiPrefs>; projectsRoot?: string; disabledAddons?: string[]; }
export interface SaveConfigResult { ok: boolean; defaults: CreationDefaults; projectsRoot: string; projectsRootSource: string; }
export interface SaveOpenTargetsResult { ok: boolean; openTargets: OpenTargetFull[]; }

// POST /api/projects/{init,onboard}
// Kinds come from the scaffold registry — built-ins plus any
// drop-in at ~/.cogyard/scaffolds/<kind>/ — so the type is open, not a union.
export type ProjectKind = string;
export interface ScaffoldKindInfo { kind: ProjectKind; description: string; builtin: boolean; }
export interface ScaffoldRequest { path: string; kind: ProjectKind; remote?: string; }
export interface ScaffoldStep { step: string; status: string; detail: string; }
export interface ScaffoldResult {
  ok: boolean; slug: string; repoRoot: string; storePath: string; kind: ProjectKind;
  steps: ScaffoldStep[]; warnings: string[];
}

// GET /api/addons · /api/addons/status · POST /api/addons/:id/:action.
// The community add-on surface — MACHINE-LEVEL: add-ons extend cogyard itself and
// render on the global /settings page; there is no project parameter anywhere.
// A `type: 'project'` config field renders a registered-project dropdown and the
// chosen slug travels in the POST cfg like any other value. `icon` is an emoji /
// short glyph. `tier` decides execution: 'safe' runs server-side, 'manual' only
// returns the copy-paste command (core-enforced, never executed).
export type AddonTier = 'safe' | 'manual';
export interface AddonPrereq { id: string; label: string; ok: boolean; fixHint?: string; }
export interface AddonConfigField {
  key: string; label: string; type: 'string' | 'enum' | 'boolean' | 'project';
  required?: boolean; options?: string[]; default?: string | boolean; placeholder?: string;
}
export interface AddonAction { id: string; label: string; tier: AddonTier; destructive: boolean; needsConfig: boolean; }
// A walkthrough an add-on declares and the dialog renders (task 127). Some
// add-ons need a one-time setup a human performs OUTSIDE cogyard — obtaining a
// credential, installing a binary — and a fixHint string cannot carry that: it
// needs paragraphs, ordered steps, and per-step copyable commands. The add-on
// supplies the words; the dialog owns the look, so no add-on ships UI code.
export interface AddonSetupStep {
  what: string; why?: string;
  // `command` may contain the token {input}. When the step declares an `input`,
  // the dialog renders a box and substitutes what is typed into the command
  // before showing/copying it — so the owner never hand-edits a placeholder,
  // which is unusable: copy-paste-Enter writes the placeholder verbatim.
  //
  // What is typed NEVER leaves the browser: no request carries it, nothing
  // persists it. It exists only to build a line of text to copy.
  command?: string;
  input?: { label: string; placeholder?: string };
}
export interface AddonSetup {
  intro?: string[];        // rendered as lead paragraphs
  steps: AddonSetupStep[];
  warning?: string;        // something wrong RIGHT NOW (e.g. the file is unreadable)
  warningCommand?: string; // and the command that fixes it
}

export interface AddonManifest {
  id: string; label: string; description: string; icon: string | null;
  thirdParty: boolean; platforms: string[] | null; supported: boolean;
  active: boolean; // framework-level switch (config.json disabledAddons); off = inert
  // A capability this add-on gates, if any ('scheduled-jobs'). Core reads the
  // flag, never a name.
  provides: string | null;
  configSchema: AddonConfigField[]; actions: AddonAction[];
  // The owner's saved config, persisted in config.json (task 127).
  config: Record<string, unknown>;
  // A one-time setup walkthrough, when the add-on declares one and it is not
  // already satisfied. null once there is nothing left to do.
  setup: AddonSetup | null;
  prereqs: AddonPrereq[]; prereqError?: string;
  // Scheduled jobs (task 118). null = not a scheduled add-on. The Add-ons row
  // shows only a hint; the Scheduled jobs section owns the detail.
  schedule: JobSchedule | null;
  bounds: JobBounds | null;
  runnable: boolean; // declared a schedule but no runScheduled() = an add-on bug
}

// --- scheduled jobs (task 118) ------------------------------------------------
// A third execution tier beside safe/manual: unattended, on a timer. Deliberately
// not cron — one daily or weekly slot at a local wall-clock time.
export interface JobSchedule {
  every: 'day' | 'week';
  at: string;             // 'HH:MM', local
  hour: number; minute: number;
  weekday: number | null; // 'week' only; 0 = Sunday
  catchUp: boolean;       // machine asleep at the slot → run on next wake
}
export interface JobBounds { timeoutMs: number; maxUnits: number; maxCostUsd: number; }
export interface JobLogLine { at: string; line: string; }
export interface ScheduledJob {
  id: string; label: string; icon: string | null; description: string;
  schedule: JobSchedule;              // what it actually runs on
  declaredSchedule: JobSchedule | null; // what the manifest asked for
  overridden: boolean;                // schedule moved from /settings
  bounds: JobBounds;
  active: boolean; supported: boolean; runnable: boolean;
  lastRunAt: string | null; lastOutcome: 'ok' | 'error' | 'skipped' | null;
  lastSummary: string; lastError: string | null; lastDurationMs: number | null;
  runs: number; totalCost: number;
  nextRunAt: string | null; due: boolean;
  log: JobLogLine[];
  // The credential this job needs at its slot, and where to set it (task 127).
  // Belongs to the driver, not the job — the row only reports it. Null when the
  // active driver needs none.
  credential: { env: string; label: string; set: boolean; howTo: string | null; whereToSet: string } | null;
}
export interface ScheduledJobsResponse { enabled: boolean; jobs: ScheduledJob[]; }
export interface JobRunResult {
  id: string; ok: boolean; outcome: 'ok' | 'error' | 'skipped';
  summary: string; error: string | null; startedAt: string; durationMs: number; cost: number;
}
export interface AddonsCatalog { addons: AddonManifest[]; invalid: { id: string; error: string }[]; }
export interface AddonStatus {
  id: string; active: boolean; supported: boolean; enabled: boolean; healthy: boolean | null;
  summary: string; details?: unknown; prereqs?: AddonPrereq[];
}
export interface AddonStatusesResponse { statuses: AddonStatus[]; }
export interface AddonActionResult { ok: boolean; manual: boolean; message?: string; command?: string; note?: string | null; }

// --- Cleanup surface (task 117) -------------------------------------------
// What is sitting around reclaimable, per project. Two independent axes per
// worktree: DISK (regenerable build/install dirs — a build recreates them) and
// GIT STATE (the sessions-audit verdict, which is about losing work). They
// disagree on purpose and must not be collapsed in the UI.
/** PUSHED (task 174): clean, unlocked, NOT merged, but origin/<branch> is at the
 *  local head — removable like REMOVABLE, and never to be read as "merged". */
export type ReclaimVerdict = 'LIVE' | 'LOCKED' | 'DIRTY' | 'UNMERGED' | 'PUSHED' | 'REMOVABLE' | 'UNKNOWN';
export interface ReclaimDir { path: string; name: string; }
export interface ReclaimWorktree {
  name: string; path: string; branch: string | null; taskId: number | null; claimLive: boolean;
  diskKb: number; diskDirs: ReclaimDir[];
  diskEligible: boolean; diskBlockedBy: string | null;
  verdict: ReclaimVerdict | null; verdictDetail: string | null;
  removeCmd: string | null; undoCmd: string | null;
}
export interface ReclaimProject {
  slug: string; label: string; worktrees: ReclaimWorktree[];
  diskKb: number; heldKb: number; removableCount: number; error: string | null;
}
export interface ReclaimReport { projects: ReclaimProject[]; totalDiskKb: number; totalHeldKb: number; totalRemovable: number; }

// --- Cleanup process (task 117) -------------------------------------------
// One item per finished piece of WORK: a task, the worktree it ran in, and the
// chat that drove it. Keyed on the work, not on any single axis — holding that
// join is the whole point.
/** One task a chat covers, with the state the chips render. */
export interface CleanupChatTask {
  id: string;
  /** The chat WORKED on this task (task 152) — only these can hold it. The
   *  rest it only looked up. `primary` mirrors `worked`. */
  worked: boolean;
  /** How: 'committed' | 'claimed' | 'worktree' | 'created' | 'edited'. */
  workedBy: string[];
  primary: boolean;
  done: boolean;
  status: string | null;
  /** Why it still blocks archiving, when it does. */
  why: string | null;
}
export interface CleanupChat {
  sessionId: string; title: string; taskIds: string[];
  tasks: CleanupChatTask[];
  /** Present on the no-worktree-left rows: Claude's own list is ordered by
   *  recency, so this is the tiebreaker when two chats share a title. */
  lastActivityAt?: string | null;
  /** Advice only — cogyard never archives. Ready when every task the chat
   *  WORKED on is done (tasks it only looked up never hold it) and no worktree
   *  it ran in is still on disk (task 152). */
  ready: boolean; reason: string;
  /** One entry per hold: a worked task (`taskId`), a worktree the chat ran
   *  in that is still on disk (`worktree`), or a chat this one started that is
   *  still held (`chat` + its `title`, task 258). */
  waitingOn: { taskId?: string; worktree?: string; chat?: string; title?: string | null; why: string }[];
  /** The chat that started this one, when the agent driver knows (task 258). */
  parentSessionId?: string | null;
  /** In the Chats list: 0 for a top-level chat, +1 per parent above it. */
  depth?: number;
}
export interface CleanupItem {
  project: string;
  worktree: { name: string; path: string; branch: string | null; head: string | null };
  repoPath: string;
  taskId: string | null;
  taskStatus: string | null;
  /** Branch tip's commit date (ISO) — when work last happened here. The list's
   *  sort key, and the answer to "how long has this been sitting around". */
  lastCommitAt: string | null;
  verdict: ReclaimVerdict | null;
  verdictDetail: string | null;
  /** `origin/<branch>` when the verdict is PUSHED — where the unmerged work
   *  still lives once the checkout goes. null otherwise. */
  originRef?: string | null;
  /** 'remove' | 'unlock' | null — translated from the verdict, no new safety logic.
   *  'remove' for REMOVABLE and PUSHED alike. */
  action: 'remove' | 'unlock' | null;
  removeCmd: string | null; undoCmd: string | null; unlockCmd: string | null;
  chat: CleanupChat | null;
}
export interface CleanupProject {
  slug: string; label: string;
  items: CleanupItem[];
  /** Every open (non-archived) chat in this project — the full mirror of what
   *  Claude Code's own sidebar shows here, ready to archive or still held back,
   *  each carrying why (task 144). Sorted most recent activity first — Claude's sidebar order. A chat also attached to
   *  a worktree row's `.chat` appears here too, deliberately — the two answer
   *  different questions ("what drove this worktree" vs "what can I archive"). */
  chats: CleanupChat[];
  error: string | null;
}
export interface CleanupReport {
  projects: CleanupProject[]; totalRemovable: number; totalArchivable: number;
}
export interface RemoveWorktreeResult {
  ok: boolean; stage?: string; error?: string; verdict?: string;
  removed?: string; branch?: string | null; originRef?: string | null; costUSD?: number | null;
  undoCmd: string | null; gone?: boolean;
}

// GET /api/storage (task 132) — where each project's task store actually lives.
// Same report `cogyard tasks doctor` prints; `flags` is that command's FLAGS
// column verbatim, and the fields beside it are what the table never showed.
// A project's task link, `.cogyard/tasks` (core/store-health.mjs storeLinkState,
// task 169) — the same field on /api/storage rows and the /api/graph store view.
// ok = links to a store that exists; broken = links to one that doesn't;
// missing = no link; folder = a real folder in its place (a fault). `target` is
// the link's text (ok, broken), else null.
export interface StoreLink { state: 'ok' | 'broken' | 'missing' | 'folder'; target: string | null; }
export interface StorageWorktrees {
  total: number;
  /** null unless the link is ok: mounting only means something for a working link. */
  mounted: number | null;
}
export interface StorageLastCommit { short: string; relDate: string | null; }
export interface StorageRow {
  slug: string; path: string; label: string;
  /** Absolute path of the task link, `.cogyard/tasks`, in the project. */
  tasksDir: string;
  link: StoreLink;
  storePath: string;
  remote: string;
  worktrees: StorageWorktrees | null;
  flags: string[];
  storeBranch: string | null;
  storeDirty: boolean | null;
  /** null when the store has no upstream — 0 means "nothing to push". */
  unpushed: number | null;
  lastCommit: StorageLastCommit | null;
  /** Task 191: uncommitted files (by kind, oldest age) and this week's flagged commits. null without a readable store. */
  audit: { pending: StorePending; week: StoreWeek } | null;
  taskCount: number | null;
  sharedWith: string[];
}
export interface StorageDriftProject {
  slug: string; errorCount: number; warningCount: number;
  errorFiles: { file: string; errors: string[] }[];
}
export interface StorageResponse {
  rows: StorageRow[];
  drift: { projects: StorageDriftProject[]; totalErrors: number };
  /** The user's home dir — display only, so paths can render as `~/…`. */
  home: string;
}

// GET /api/publish?p=<slug> (task 170) — how a project publishes, for the
// project settings card. Field names match core/publish.mjs publishStatus().
export interface PublishDeclaration {
  declared: boolean;
  error?: string;
  deploysOnPush?: boolean;
  command?: string | null;
  manual?: string[];
  health?: string | null;
  tag?: boolean;
  requires?: string[];
  checks?: string[];
  /** Task 264: a project naming its releases has these instead of the fields above. */
  releases?: ReleaseDeclaration[];
}
/** One release (task 264). The flat form is one release with name and label null. */
export interface ReleaseDeclaration {
  name: string | null;
  label: string | null;
  /** "<prefix><version>", e.g. "web/v<version>"; null when it isn't tagged. */
  tagFormat: string | null;
  /** The files whose commits count as this release's changes; [] = every commit. */
  paths: string[];
  deploysOnPush: boolean;
  command: string | null;
  manual: string[];
  health: string | null;
  tag: boolean;
  requires: string[];
  checks: string[];
}
export interface ReleaseStatus {
  name: string | null;
  label: string | null;
  declaration: ReleaseDeclaration;
  credentials: { name: string; set: boolean }[];
  lastRelease: { tag: string; short: string | null; date: string | null; unreleased: number; paths: string[] } | null;
  live: { url: string; reachable: boolean; commit: string | null; servesTip: boolean } | null;
  ready: { ok: boolean; reason: string | null };
}
export interface PublishHistoryRow {
  at: string;
  project: string;
  /** Task 264: which release, for a project naming its releases. */
  release?: string;
  ok: boolean;
  sha?: string;
  tag?: string | null;
  previous?: string | null;
  failedAt?: string;
  reason?: string;
}
export interface PublishStatus {
  slug: string;
  declaration: PublishDeclaration;
  /** Task 264: every release, one entry for the flat form (whose fields below
   *  are that one release's). Empty when undeclared or invalid. */
  releases: ReleaseStatus[];
  /** Credential NAMES with whether each is set — never a value. */
  credentials: { name: string; set: boolean }[];
  /** origin/<branch> as of the last fetch (or the local branch with no remote). */
  tip: { ref: string; short: string; version: string | null } | null;
  lastRelease: { tag: string; short: string | null; date: string | null; unreleased: number } | null;
  live: { url: string; reachable: boolean; commit: string | null; servesTip: boolean } | null;
  /** Would `cogyard publish` go through now — its own two checks, without the
   *  fetch (as of the last fetch); `reason` is the sentence it prints when it
   *  refuses. Null when the project is undeclared or its file is invalid. */
  ready: { ok: boolean; reason: string | null } | null;
  prePushHook: string | null;
  history: PublishHistoryRow[];
  defaults: {
    verifyTimeoutMinutes: number;
    verifyPollSeconds: number;
    remote: string;
    tagFormat: string;
    logPath: string;
    branch: string | null;
  };
}
