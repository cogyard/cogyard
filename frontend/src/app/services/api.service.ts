import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  Project, TasksResponse, WorktreesResponse, GraphResponse, OverviewResponse,
  CommitDetail, DiffResponse, StatusResponse, BranchesResponse,
  WtActivityResponse, TreeResponse, FileContent, SaveFileResult, UsageResponse, ProjectUsageResponse, CollectResult,
  ActivityResponse, ActivityDayResponse,
  HealthResponse, ActionResult, OpenTarget, ScaffoldRequest, ScaffoldResult,
  ConfigResponse, SaveConfigRequest, SaveConfigResult, OpenTargetFull, SaveOpenTargetsResult,
  AddonsCatalog, AddonStatusesResponse, AddonActionResult,
} from './models';

// Thin client over the cogyard API (proxied to :7440 in dev). No business
// logic here — the server owns it (backed by the in-repo core/ data layer).
@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private p(slug: string) { return encodeURIComponent(slug); }

  health(): Observable<HealthResponse> { return this.http.get<HealthResponse>('/api/health'); }
  projects(): Observable<Project[]> { return this.http.get<Project[]>('/api/projects'); }
  tasks(slug: string): Observable<TasksResponse> { return this.http.get<TasksResponse>(`/api/tasks?p=${this.p(slug)}`); }
  worktrees(slug: string): Observable<WorktreesResponse> { return this.http.get<WorktreesResponse>(`/api/worktrees?p=${this.p(slug)}`); }
  graph(slug: string): Observable<GraphResponse> { return this.http.get<GraphResponse>(`/api/graph?p=${this.p(slug)}`); }
  overview(): Observable<OverviewResponse> { return this.http.get<OverviewResponse>('/api/overview'); }
  commit(slug: string, h: string): Observable<CommitDetail> { return this.http.get<CommitDetail>(`/api/commit?p=${this.p(slug)}&h=${h}`); }
  diff(slug: string, h: string, path: string, ignoreWs = false): Observable<DiffResponse> {
    return this.http.get<DiffResponse>(`/api/diff?p=${this.p(slug)}&h=${h}&path=${encodeURIComponent(path)}${ignoreWs ? '&w=1' : ''}`);
  }
  // worktree: absolute checkout path (from the graph's worktree rows); omitted = main checkout.
  status(slug: string, worktree?: string | null): Observable<StatusResponse> {
    return this.http.get<StatusResponse>(`/api/status?p=${this.p(slug)}${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}`);
  }
  branches(slug: string): Observable<BranchesResponse> { return this.http.get<BranchesResponse>(`/api/branches?p=${this.p(slug)}`); }
  workdiff(slug: string, path: string, kind: string, ignoreWs = false, worktree?: string | null): Observable<DiffResponse> {
    return this.http.get<DiffResponse>(`/api/workdiff?p=${this.p(slug)}&path=${encodeURIComponent(path)}&kind=${kind}${ignoreWs ? '&w=1' : ''}${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}`);
  }
  wtActivity(slug: string): Observable<WtActivityResponse> { return this.http.get<WtActivityResponse>(`/api/wt-activity?p=${this.p(slug)}`); }
  // ignored=true also lists gitignored files (node_modules, dist…) — a much
  // heavier response, fetched lazily when the user asks for it.
  tree(slug: string, wt: string, ignored = false): Observable<TreeResponse> {
    return this.http.get<TreeResponse>(`/api/tree?p=${this.p(slug)}&wt=${encodeURIComponent(wt)}${ignored ? '&ig=1' : ''}`);
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
  activity(days = 366): Observable<ActivityResponse> { return this.http.get<ActivityResponse>(`/api/activity?days=${days}`); }
  activityDay(date: string): Observable<ActivityDayResponse> { return this.http.get<ActivityDayResponse>(`/api/activity/day/${date}`); }
  usage(): Observable<UsageResponse> { return this.http.get<UsageResponse>('/api/usage'); }
  projectUsage(slug: string): Observable<ProjectUsageResponse> {
    return this.http.get<ProjectUsageResponse>(`/api/usage/project/${this.p(slug)}`);
  }
  // Ad-hoc transcript harvest (the refresh button). Idempotent server-side.
  collectUsage(): Observable<CollectResult> { return this.http.post<CollectResult>('/api/usage/collect', {}); }
  wtdiff(slug: string, wt: string, path: string, ignoreWs = false): Observable<DiffResponse> {
    return this.http.get<DiffResponse>(`/api/wtdiff?p=${this.p(slug)}&wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(path)}${ignoreWs ? '&w=1' : ''}`);
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
  // Project creation/adoption — through the requireSameOrigin write seam.
  initProject(body: ScaffoldRequest): Observable<ScaffoldResult> { return this.http.post<ScaffoldResult>('/api/projects/init', body); }
  onboardProject(body: ScaffoldRequest): Observable<ScaffoldResult> { return this.http.post<ScaffoldResult>('/api/projects/onboard', body); }

  // Config/settings — the resolved config picture + its two writers,
  // all through the same write seam.
  config(): Observable<ConfigResponse> { return this.http.get<ConfigResponse>('/api/config'); }
  saveConfig(body: SaveConfigRequest): Observable<SaveConfigResult> { return this.http.post<SaveConfigResult>('/api/config', body); }
  saveOpenTargets(targets: OpenTargetFull[]): Observable<SaveOpenTargetsResult> { return this.http.post<SaveOpenTargetsResult>('/api/open-targets', targets); }

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
}
