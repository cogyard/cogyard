import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  Project, TasksResponse, DailyResponse, PlanResponse, RecentlyDoneResponse, WorktreesResponse, GraphResponse, OverviewResponse, InProgressResponse,
  CommitDetail, DiffResponse, StatusResponse, BranchesResponse,
  WtActivityResponse, TreeResponse, FilesBase, FileContent, SaveFileResult, UsageResponse, ProjectUsageResponse, TaskChatsResponse, TaskTranscriptResponse, CollectResult,
  ActivityResponse, ActivityDayResponse,
  HealthResponse, ActionResult, OpenTarget, ScaffoldRequest, ScaffoldResult,
  ConfigResponse, SaveConfigRequest, SaveConfigResult, OpenTargetFull, SaveOpenTargetsResult, ProjectImagesResponse,
  AddonsCatalog, AddonStatusesResponse, AddonActionResult,
  ScheduledJobsResponse, JobRunResult, JobSchedule,
  AxesResponse, SaveAxesRequest, StorageResponse, PublishStatus, SwitchesResponse, SaveSwitchesRequest,
  ReclaimReport, CleanupReport, RemoveWorktreeResult,
} from './models';

// Thin client over the cogyard API (proxied to :7440 in dev). No business
// logic here — the server owns it (backed by the in-repo core/ data layer).
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private p(slug: string) { return encodeURIComponent(slug); }

  health(): Observable<HealthResponse> { return this.http.get<HealthResponse>('/api/health'); }
  // One change code per cache entry (task 173): null = the server has no code
  // for it, so poll it. Repeated `k=` params, one per entry.
  versions(keys: string[]): Observable<Record<string, string | null>> {
    return this.http.get<Record<string, string | null>>('/api/versions', { params: { k: keys } });
  }
  projects(): Observable<Project[]> { return this.http.get<Project[]>('/api/projects'); }
  tasks(slug: string): Observable<TasksResponse> { return this.http.get<TasksResponse>(`/api/tasks?p=${this.p(slug)}`); }
  daily(slug: string): Observable<DailyResponse> { return this.http.get<DailyResponse>(`/api/daily?p=${this.p(slug)}`); }
  plan(slug: string): Observable<PlanResponse> { return this.http.get<PlanResponse>(`/api/plan?p=${this.p(slug)}`); }
  recentlyDone(slug: string): Observable<RecentlyDoneResponse> { return this.http.get<RecentlyDoneResponse>(`/api/recently-done?p=${this.p(slug)}`); }
  worktrees(slug: string): Observable<WorktreesResponse> { return this.http.get<WorktreesResponse>(`/api/worktrees?p=${this.p(slug)}`); }
  // focus: a commit sha/ref whose history must be included even beyond the
  // newest-250 window (task 175). Omitted = the default window.
  graph(slug: string, focus?: string | null): Observable<GraphResponse> {
    const f = focus ? `&focus=${encodeURIComponent(focus)}` : '';
    return this.http.get<GraphResponse>(`/api/graph?p=${this.p(slug)}${f}`);
  }
  // The project's TASK STORE as a graph (task 191): its commits with rule
  // flags, a pending row, the store's facts. flagged = flagged commits of the
  // last 30 days only.
  storeGraph(slug: string, flagged: boolean): Observable<GraphResponse> {
    return this.http.get<GraphResponse>(`/api/graph?p=${this.p(slug)}&source=store${flagged ? '&flagged=1' : ''}`);
  }
  overview(): Observable<OverviewResponse> { return this.http.get<OverviewResponse>('/api/overview'); }
  // The All tab's per-project boxes (task 265): core/in-progress.mjs.
  inProgress(): Observable<InProgressResponse> { return this.http.get<InProgressResponse>('/api/in-progress'); }
  // The cleanup process (task 117). No `du` anywhere in this one — git state
  // and the ledgers only — so it is safe to load on page open.
  cleanup(slug?: string): Observable<CleanupReport> {
    return this.http.get<CleanupReport>(`/api/cleanup${slug ? `?p=${this.p(slug)}` : ''}`);
  }
  // `confirm` MUST be the worktree's own name; the server compares it against
  // the resolved worktree and refuses otherwise. The caller fills it from the
  // worktree it is acting on — the human's consent is the dialog's checkbox,
  // and this value is how the REQUEST proves which worktree it means.
  removeWorktree(slug: string, worktreePath: string, confirm: string): Observable<RemoveWorktreeResult> {
    return this.http.post<RemoveWorktreeResult>('/api/cleanup/worktree', { slug, worktreePath, confirm });
  }
  // Disk sizes — OPTIONAL extra, not part of the process. sizes=false skips the
  // du/find walk; `slug` scopes it to one project so a pass stays short.
  reclaim(sizes = true, slug?: string): Observable<ReclaimReport> {
    const q = new URLSearchParams();
    if (!sizes) q.set('sizes', '0');
    if (slug) q.set('p', slug);
    const s = q.toString();
    return this.http.get<ReclaimReport>(`/api/reclaim${s ? '?' + s : ''}`);
  }
  // store = read the project's task store instead of its checkout (task 191).
  private src(store?: boolean) { return store ? '&source=store' : ''; }
  private from(oldPath?: string | null) { return oldPath ? `&from=${encodeURIComponent(oldPath)}` : ''; }
  commit(slug: string, h: string, store = false): Observable<CommitDetail> { return this.http.get<CommitDetail>(`/api/commit?p=${this.p(slug)}&h=${h}${this.src(store)}`); }
  // from = a renamed file's old path, so the diff pairs the two (task 224).
  diff(slug: string, h: string, path: string, ignoreWs = false, store = false, from?: string | null): Observable<DiffResponse> {
    return this.http.get<DiffResponse>(`/api/diff?p=${this.p(slug)}&h=${h}&path=${encodeURIComponent(path)}${this.from(from)}${ignoreWs ? '&w=1' : ''}${this.src(store)}`);
  }
  // worktree: absolute checkout path (from the graph's worktree rows); omitted = main checkout.
  status(slug: string, worktree?: string | null, store = false): Observable<StatusResponse> {
    return this.http.get<StatusResponse>(`/api/status?p=${this.p(slug)}${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}${this.src(store)}`);
  }
  branches(slug: string): Observable<BranchesResponse> { return this.http.get<BranchesResponse>(`/api/branches?p=${this.p(slug)}`); }
  workdiff(slug: string, path: string, kind: string, ignoreWs = false, worktree?: string | null, store = false, from?: string | null): Observable<DiffResponse> {
    return this.http.get<DiffResponse>(`/api/workdiff?p=${this.p(slug)}&path=${encodeURIComponent(path)}${this.from(from)}&kind=${kind}${ignoreWs ? '&w=1' : ''}${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}${this.src(store)}`);
  }
  wtActivity(slug: string): Observable<WtActivityResponse> { return this.http.get<WtActivityResponse>(`/api/wt-activity?p=${this.p(slug)}`); }
  // ignored=true also lists gitignored files (node_modules, dist…) — a much
  // heavier response, fetched lazily when the user asks for it.
  // commit = compare commitStatus against this commit instead of the last one (task 224).
  tree(slug: string, wt: string, ignored = false, commit?: string | null): Observable<TreeResponse> {
    return this.http.get<TreeResponse>(`/api/tree?p=${this.p(slug)}&wt=${encodeURIComponent(wt)}${ignored ? '&ig=1' : ''}${commit ? `&commit=${encodeURIComponent(commit)}` : ''}`);
  }
  file(slug: string, wt: string, path: string): Observable<FileContent> {
    return this.http.get<FileContent>(this.fileUrl(slug, wt, path));
  }
  // Save an edited buffer. baseHash = the hash the GET served; the
  // server 409s (with currentHash) if the file changed on disk since.
  saveFile(slug: string, wt: string, path: string, content: string, baseHash: string): Observable<SaveFileResult> {
    return this.http.post<SaveFileResult>('/api/file', { p: slug, wt, path, content, baseHash });
  }
  // Direct URL (images are served raw — usable as an <img src>).
  fileUrl(slug: string, wt: string, path: string): string {
    return `/api/file?p=${this.p(slug)}&wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}`;
  }
  // The raw route's key (task 262): every /api/raw address starts with it.
  rawKey(): Observable<{ key: string }> { return this.http.get<{ key: string }>('/api/raw-key'); }
  // A worktree file at its own address (task 262), so a page served from it
  // loads the files beside it. Each segment is encoded (a slug may hold "/").
  // rev = anything that changes when the file does (its hash); the route
  // ignores the query, the frame reloads on it.
  rawUrl(key: string, slug: string, wt: string, path: string, rev?: string | null): string {
    const segs = [key, slug, wt, ...path.split('/')].map(encodeURIComponent).join('/');
    return `/api/raw/${segs}${rev ? `?v=${encodeURIComponent(rev)}` : ''}`;
  }
  activity(days = 366): Observable<ActivityResponse> { return this.http.get<ActivityResponse>(`/api/activity?days=${days}`); }
  activityDay(date: string): Observable<ActivityDayResponse> { return this.http.get<ActivityDayResponse>(`/api/activity/day/${date}`); }
  usage(): Observable<UsageResponse> { return this.http.get<UsageResponse>('/api/usage'); }
  projectUsage(slug: string): Observable<ProjectUsageResponse> {
    return this.http.get<ProjectUsageResponse>(`/api/usage/project/${this.p(slug)}`);
  }
  // Task → chats (task 30). Lazy: loaded when a task row expands (the created-
  // side spawns git), not folded into the project usage bulk load.
  taskChats(slug: string, id: number | string): Observable<TaskChatsResponse> {
    return this.http.get<TaskChatsResponse>(`/api/usage/task/${this.p(slug)}/${id}/chats`);
  }
  // One chat's readable transcript, for the in-portal viewer (task 30 follow-up).
  taskTranscript(sessionId: string): Observable<TaskTranscriptResponse> {
    return this.http.get<TaskTranscriptResponse>(`/api/usage/chat/${this.p(sessionId)}/transcript`);
  }
  // Ad-hoc transcript harvest (the refresh button). Idempotent server-side.
  collectUsage(): Observable<CollectResult> { return this.http.post<CollectResult>('/api/usage/collect', {}); }
  // base 'head' = against the last commit instead of main (task 224).
  wtdiff(slug: string, wt: string, path: string, ignoreWs = false, base: FilesBase = 'main', from?: string | null): Observable<DiffResponse> {
    return this.http.get<DiffResponse>(`/api/wtdiff?p=${this.p(slug)}&wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}${base !== 'main' ? `&base=${encodeURIComponent(base)}` : ''}${this.from(from)}${ignoreWs ? '&w=1' : ''}`);
  }

  // --- Working-tree actions — the only mutating/exec POSTs. The
  // server gates each on Origin + path containment. `worktree` is the absolute
  // checkout path (same value the status/workdiff reads carry); omitted = main.
  // (stage/unstage are server-side endpoints but unused by the portal UI —
  // staging is done via Claude; the portal only surfaces discard.)
  wtDiscard(slug: string, path: string, untracked: boolean, worktree?: string | null): Observable<ActionResult> {
    return this.http.post<ActionResult>('/api/wt/discard', { slug, path, untracked, worktree });
  }
  // target = an open-target id from /api/open-targets (e.g. 'vscode', 'finder').
  openFile(slug: string, path: string, target: string, line?: number | null, worktree?: string | null): Observable<ActionResult> {
    return this.http.post<ActionResult>('/api/open', { slug, path, target, line, worktree });
  }
  openTargets(): Observable<OpenTarget[]> { return this.http.get<OpenTarget[]>('/api/open-targets'); }
  // A task file lives in the task store, not the checkout — `store: true` sends
  // the server down its assertInStore containment instead of assertInProject,
  // which by design refuses anything behind the task-store link (.cogyard/tasks, or _tasks) (task 132).
  // `file` is the bare filename: the store is flat.
  openTaskFile(slug: string, file: string, target: string): Observable<ActionResult> {
    return this.http.post<ActionResult>('/api/open', { slug, path: file, target, store: true });
  }
  // Project creation/adoption — through the requireSameOrigin write seam.
  initProject(body: ScaffoldRequest): Observable<ScaffoldResult> { return this.http.post<ScaffoldResult>('/api/projects/init', body); }
  onboardProject(body: ScaffoldRequest): Observable<ScaffoldResult> { return this.http.post<ScaffoldResult>('/api/projects/onboard', body); }

  // Config/settings — the resolved config picture + its two writers,
  // all through the same write seam.
  config(): Observable<ConfigResponse> { return this.http.get<ConfigResponse>('/api/config'); }
  saveConfig(body: SaveConfigRequest): Observable<SaveConfigResult> { return this.http.post<SaveConfigResult>('/api/config', body); }
  saveOpenTargets(targets: OpenTargetFull[]): Observable<SaveOpenTargetsResult> { return this.http.post<SaveOpenTargetsResult>('/api/open-targets', targets); }
  // Every image file in a project's repo — the Icon card's picker (task 140).
  projectImages(slug: string): Observable<ProjectImagesResponse> {
    return this.http.get<ProjectImagesResponse>('/api/project-images', { params: { slug } });
  }

  // Label axes (task 096) — the /settings axis manager. Per-layer raw reads +
  // writes, through the same write seam. scope 'shared' = machine-global;
  // 'project' = a chosen project's committed .cogyard/axes.json.
  axesFor(scope: 'shared' | 'project', slug?: string): Observable<AxesResponse> {
    const q = scope === 'project' ? `?scope=project&p=${this.p(slug ?? '')}` : '?scope=shared';
    return this.http.get<AxesResponse>(`/api/axes${q}`);
  }
  saveAxes(body: SaveAxesRequest): Observable<AxesResponse> { return this.http.post<AxesResponse>('/api/axes', body); }

  // A project's switches (task 246) — the project settings Switches card.
  switches(slug: string): Observable<SwitchesResponse> {
    return this.http.get<SwitchesResponse>(`/api/switches?p=${this.p(slug)}`);
  }
  saveSwitches(body: SaveSwitchesRequest): Observable<SwitchesResponse> {
    return this.http.post<SwitchesResponse>('/api/switches', body);
  }

  // Where one project's code and task store really live (tasks 132, 135, 217),
  // for its settings tab's Location on disk. Per project only: the
  // cross-project table it once also fed is gone (task 217).
  storage(slug: string): Observable<StorageResponse> {
    return this.http.get<StorageResponse>(`/api/storage?p=${this.p(slug)}`);
  }

  // How a project publishes (task 170) — read-only, for the project settings
  // card. Publishing itself is `cogyard publish` in the owner's terminal.
  publishStatus(slug: string): Observable<PublishStatus> {
    return this.http.get<PublishStatus>(`/api/publish?p=${this.p(slug)}`);
  }

  // Add-ons — machine-level, rendered on the global /settings page.
  // POST goes through the same write seam; 'manual'-tier actions only ever
  // return the command to copy-paste. No project parameter anywhere — a
  // project-targeting add-on carries the slug inside cfg (type:'project' field).
  addons(): Observable<AddonsCatalog> { return this.http.get<AddonsCatalog>('/api/addons'); }
  addonStatuses(): Observable<AddonStatusesResponse> {
    return this.http.get<AddonStatusesResponse>('/api/addons/status');
  }
  runAddonAction(id: string, action: string, cfg: Record<string, unknown>): Observable<AddonActionResult> {
    return this.http.post<AddonActionResult>(`/api/addons/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, cfg);
  }
  // Persist the add-on's config (task 127). Declared keys only; never a
  // credential — config.json is world-readable.
  saveAddonConfig(id: string, cfg: Record<string, unknown>): Observable<{ ok: boolean; id: string; config: Record<string, unknown> }> {
    return this.http.post<{ ok: boolean; id: string; config: Record<string, unknown> }>(`/api/addons/${encodeURIComponent(id)}/config`, cfg);
  }

  // Scheduled jobs (task 118) — add-ons that declared a `schedule`.
  jobs(): Observable<ScheduledJobsResponse> { return this.http.get<ScheduledJobsResponse>('/api/jobs'); }
  runJob(id: string): Observable<JobRunResult> {
    return this.http.post<JobRunResult>(`/api/jobs/${encodeURIComponent(id)}/run`, {});
  }
  // Pass null to clear the override and fall back to the manifest's declaration.
  setJobSchedule(id: string, schedule: Partial<JobSchedule> | null): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/schedule`,
      schedule === null ? { schedule: null } : schedule);
  }
}
