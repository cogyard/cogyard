// Wire shapes for the cogyard /api endpoints — 1:1 with the server's JSON.
// The service file (api.service.ts) exports only the client class; every
// response/entity type lives here. New endpoint = new interface here first.

// /api/health
export interface HealthResponse { ok: boolean; commit: string | null; version: string | null; projects: number; }

// /api/projects
export interface Project { slug: string; label: string; unmerged?: number; }

// /api/tasks
export interface TasksResponse { slug: string; label: string; tasks: any[]; }

// /api/worktrees
export interface WorktreesResponse { slug: string; label: string; worktrees: any[]; }

// /api/graph
// rows is a heterogeneous list: ordinary commit rows, `kind:'worktree'` pseudo-rows
// (dirty checkouts), and `kind:'stash'` pseudo-rows (collapsed git stashes —
// stashRef/message/sha/base; see core/git-views.mjs spliceStashRows). The graph
// component's Row interface is the precise client-side shape.
export interface GraphResponse { slug: string; label: string; originUrl: string | null; rows: any[]; laneCount: number; }

// /api/overview
export interface OverviewResponse { projects: any[]; }

// /api/commit
export interface CommitDetail { hash: string; author: string; date: string; subject: string; body: string; files: { status: string; path: string }[]; }

// /api/diff · /api/workdiff · /api/wtdiff
export interface DiffResponse { patch: string; }

// /api/status
export interface ChangeFile { path: string; status?: string; oldPath?: string; }
export interface StatusResponse { branch: string; staged: ChangeFile[]; unstaged: ChangeFile[]; untracked: ChangeFile[]; clean: boolean; }

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
export interface WtInfo { path: string; name: string; branch: string | null; isMain: boolean; clone: string | null; lastActivity: string | null; }
export interface WtActivityResponse { slug: string; worktrees: WtInfo[]; }

// /api/tree
// `tracked: false` = "non-git" (untracked — gitignored build output or just not
// yet `git add`ed). Drives the "hide non-git" filter and the grayed row styling.
export interface TreeFile { path: string; status: string | null; oldPath?: string; onDisk: boolean; tracked: boolean; }
export interface TreeResponse { worktree: string; branch: string; vsRef: string | null; files: TreeFile[]; }

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
export interface UsageResponse { projects: ProjectUsageRollup[]; }
export interface TaskUsage extends UsageBucket { taskId: number | null; models: Record<string, UsageBucket>; }
export interface WorktreeUsage extends UsageBucket { worktree: string | null; sessions: number; }
export interface ProjectUsageResponse extends UsageBucket {
  project: string; sessions: number;
  models: Record<string, UsageBucket>;
  tasks: TaskUsage[];
  worktrees: WorktreeUsage[];
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
}
// /api/activity/day/:date — the drill-down. hours: UTC-hour key → assistant
// message count that hour. approx sessions carry firstTs/lastTs instead.
export interface ActivityDaySession {
  sessionId: string; project: string; worktree: string | null;
  taskIds: string[]; // which task(s) the session worked — claims join, mined _tasks/NNN refs, worktree name
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
// Shared is the only store model; the field was removed from the
// creation form. `defaults` from /api/config may still carry a `store: 'shared'`
// — it's simply ignored client-side.
export interface CreationDefaults { kind: ProjectKind; }
export interface OpenTargetFull { id: string; label: string; exec: string; args: string[]; }
export type WeekStart = 'sunday' | 'monday';
export interface UiPrefs { weekStart: WeekStart; dayStart: number; hiddenTabs: string[]; }
export interface ConfigResponse {
  home: string; homeFromEnv: boolean;
  projectsRoot: string; projectsRootSource: 'env' | 'config' | 'default';
  version: string | null; commit: string | null;
  openTargets: OpenTargetFull[];
  defaults: CreationDefaults;
  kinds: ScaffoldKindInfo[]; // the scaffold registry rows
  ui: UiPrefs;
  driver: { active: string; available: string[] };
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
  ok: boolean; slug: string; repoRoot: string; store: string; kind: ProjectKind;
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
export interface AddonManifest {
  id: string; label: string; description: string; icon: string | null;
  thirdParty: boolean; platforms: string[] | null; supported: boolean;
  active: boolean; // framework-level switch (config.json disabledAddons); off = inert
  configSchema: AddonConfigField[]; actions: AddonAction[];
  prereqs: AddonPrereq[]; prereqError?: string;
}
export interface AddonsCatalog { addons: AddonManifest[]; invalid: { id: string; error: string }[]; }
export interface AddonStatus {
  id: string; active: boolean; supported: boolean; enabled: boolean; healthy: boolean | null;
  summary: string; details?: unknown; prereqs?: AddonPrereq[];
}
export interface AddonStatusesResponse { statuses: AddonStatus[]; }
export interface AddonActionResult { ok: boolean; manual: boolean; message?: string; command?: string; note?: string | null; }
