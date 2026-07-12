import { Component, signal, inject, OnInit, afterNextRender, effect, computed, viewChild } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { Toast } from 'primeng/toast';
import { Tabs, TabList, Tab as PTab } from 'primeng/tabs';
import { ApiService } from './services/api.service';
import { BadgeService } from './services/badge.service';
import { RefreshService } from './services/refresh.service';
import { EditStateService } from './services/edit-state.service';
import { ConfigService } from './services/config.service';
import { Project } from './services/models';
import { PORTAL_TABS, PortalTabId } from './shared/portal-tabs';
import { FreshnessPieComponent } from './shared/freshness-pie/freshness-pie.component';
import { TasksComponent } from './tasks/tasks.component';
import { BoardComponent } from './board/board.component';
import { BranchesComponent } from './branches/branches.component';
import { GraphComponent } from './graph/graph.component';
import { WorktreesComponent } from './worktrees/worktrees.component';
import { OverviewComponent } from './overview/overview.component';
import { CommitPanelComponent } from './shared/commit-panel/commit-panel.component';
import { FilesComponent } from './files/files.component';
import { StatsComponent } from './stats/stats.component';
import { NewProjectComponent } from './shared/new-project/new-project.component';
import { SettingsComponent } from './settings/settings.component';
// Build-stamped at build time by scripts/generate-version.mjs — the single source
// of version + commit (works in the packaged desktop app too; no /api/health call).
import versionInfo from '../version.json';

type Tab = PortalTabId;
const TAB_SET = new Set<string>(PORTAL_TABS.map((t) => t.id));

@Component({
  selector: 'app-root',
  imports: [TasksComponent, BoardComponent, BranchesComponent, GraphComponent, WorktreesComponent, OverviewComponent, CommitPanelComponent, FilesComponent, StatsComponent, NewProjectComponent, SettingsComponent, FreshnessPieComponent, Toast, Tabs, TabList, PTab],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  host: { '(window:resize)': 'measureHeader()' },
})
export class AppComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private badge = inject(BadgeService); // instantiate the dock-badge poller
  private refresh = inject(RefreshService);
  private editState = inject(EditStateService);
  private cfg = inject(ConfigService);

  constructor() {
    // Publish the toolbar height so the fixed commit sidebar can sit below it.
    afterNextRender(() => this.measureHeader());
    // Load + refresh the project list (which carries each project's claimed-task
    // count for the sidebar badges) on the shared tick. /api/projects is cheap —
    // the claimed count is a frontmatter file-read server-side (no git) — so
    // polling it costs ~nothing.
    effect(() => {
      this.refresh.tick();
      this.api.projects().subscribe((ps) => { this.projects.set(ps); this.loaded.set(true); this.syncFromUrl(); });
    });
  }

  // Per-project claimed-task count for the sidebar badge — projects with work in
  // flight. Same number the dock/web badge sums, so the per-project badges total
  // the app badge.
  claimedFor(slug: string): number { return this.projects().find((p) => p.slug === slug)?.claimed ?? 0; }
  measureHeader() {
    const h = document.querySelector('.topbar')?.getBoundingClientRect().height;
    if (h) document.documentElement.style.setProperty('--hdr', `${Math.round(h)}px`);
  }

  projects = signal<Project[]>([]);
  // Whether /api/projects has resolved at least once. Distinguishes "not fetched
  // yet" (empty because loading) from "fetched and genuinely empty" — the root
  // redirect + wizard must only fire on the latter (redirect race).
  loaded = signal<boolean>(false);
  // Build version shown in the sidebar foot, e.g. "v0.34.0 (aabd73f)" — build-stamped
  // (version.json), so it's correct in the web portal AND the packaged desktop app.
  readonly version = signal<string>(
    versionInfo.version
      ? `v${versionInfo.version}${versionInfo.commit ? ` (${versionInfo.commit})` : ''}`
      : '',
  );
  // These mirror the URL — written only by syncFromUrl(), read by the template.
  slug = signal<string>('');
  tab = signal<Tab>('tasks');
  taskFilter = signal<string>('');
  viewAll = signal<boolean>(false);
  settingsRoute = signal<boolean>(false); // URL is /settings
  panelHash = signal<string | null>(null);
  wtParam = signal<string>('');
  fileParam = signal<string>('');
  branchParam = signal<string>('');

  // Zero registered projects → the empty state IS the setup wizard. Whether the
  // URL is /settings or the user just landed with no projects, the same component
  // renders; `wizard` only changes its framing + shows the first-project CTA.
  readonly isWizard = computed(() => this.loaded() && this.projects().length === 0);
  readonly showSettings = computed(() => this.settingsRoute() || this.isWizard());

  // The New/Add drawer instance (in the sidebar) — the wizard CTA opens it rather
  // than rebuilding the form.
  private newProject = viewChild(NewProjectComponent);

  // The strip renders PORTAL_TABS minus ui.hiddenTabs. The current tab
  // always shows even when hidden — a deep link (e.g. /p/x/board) must not leave
  // the user on an invisible tab. Content rendering (@switch) stays unfiltered.
  readonly tabs = computed<{ id: Tab; label: string }[]>(() => {
    const hidden = new Set(this.cfg.config()?.ui?.hiddenTabs ?? []);
    return PORTAL_TABS.filter((t) => !hidden.has(t.id) || t.id === this.tab());
  });

  ngOnInit() {
    // URL drives state: re-parse on every navigation (incl. browser back/forward).
    // The project list itself is loaded + refreshed by the effect in the
    // constructor (which also calls syncFromUrl once projects are known).
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.syncFromUrl());
    this.syncFromUrl();
  }

  // Parse the current URL into view state. The one place these signals are set.
  private syncFromUrl() {
    const tree = this.router.parseUrl(this.router.url);
    const segs = tree.root.children['primary']?.segments.map((s) => s.path) ?? [];
    const qp = tree.queryParams;
    this.settingsRoute.set(segs[0] === 'settings');
    if (segs[0] === 'settings') {
      this.viewAll.set(false);
    } else if (segs[0] === 'all') {
      this.viewAll.set(true);
    } else if (segs[0] === 'p' && segs[1]) {
      this.viewAll.set(false);
      this.slug.set(segs[1]);
      // Legacy redirect: the tab formerly known as 'activity' is now 'stats'
      // (full rename). Old bookmarks (/p/x/activity) resolve to the
      // stats tab instead of falling through to the default (tasks).
      const seg = segs[2] === 'activity' ? 'stats' : segs[2];
      this.tab.set((TAB_SET.has(seg) ? seg : 'tasks') as Tab);
    } else {
      // root or unknown — wait until /api/projects has actually resolved before
      // deciding; otherwise the transient empty list on first load bounces us to
      // /settings and sticks there (redirect race). The subscribe
      // callback re-runs syncFromUrl once projects arrive, so this is reached
      // again with loaded=true and redirects correctly (first project, or the
      // wizard only when genuinely zero).
      if (!this.loaded()) return;
      const first = this.projects()[0]?.slug;
      this.router.navigate(first ? ['/p', first, 'tasks'] : ['/settings'], { replaceUrl: true });
      return;
    }
    this.taskFilter.set(qp['task'] ?? '');
    this.panelHash.set(qp['commit'] ?? null);
    this.wtParam.set(qp['wt'] ?? '');
    this.fileParam.set(qp['file'] ?? '');
    this.branchParam.set(qp['branch'] ?? '');
  }

  // A New/Adopt action just created a project — reload the list and jump to it.
  onProjectCreated(slug: string) {
    this.api.projects().subscribe((ps) => {
      this.projects.set(ps);
      if (ps.some((p) => p.slug === slug)) this.router.navigate(['/p', slug, 'tasks']);
    });
  }

  // --- Navigation (all routes through the URL) ---
  // Every nav funnels through guardedNav so an unsaved Files-tab edit
  // prompts before being dropped — the files component is destroyed on nav.
  private guardedNav(commands: unknown[], extras?: object) {
    if (!this.editState.confirmDiscard()) return;
    this.router.navigate(commands as string[], extras);
  }
  onProject(slug: string) { this.guardedNav(['/p', slug, 'tasks']); }
  showAll() { this.guardedNav(['/all']); }
  goSettings() { this.guardedNav(['/settings']); }
  // Wizard CTA → open the existing New/Add drawer (don't rebuild the form).
  openNewProject() { this.newProject()?.start('init'); }
  setTab(t: Tab) { this.guardedNav(['/p', this.slug(), t]); }
  jumpToTask(id: string) { this.guardedNav(['/p', this.slug(), 'tasks'], { queryParams: { task: id } }); }
  jumpToWorktree(_name: string) { this.guardedNav(['/p', this.slug(), 'worktrees']); }
  selectProject(slug: string) { this.guardedNav(['/p', slug, 'tasks']); }
  openCommit(hash: string) {
    this.router.navigate(['/p', this.slug(), this.tab()], { queryParams: { commit: hash }, queryParamsHandling: 'merge' });
  }
  // Clicking a branch jumps to the Graph tab with that branch's tip selected.
  openCommitInGraph(hash: string) {
    this.guardedNav(['/p', this.slug(), 'graph'], { queryParams: { commit: hash } });
  }
  // Branches tab honors ?branch=<name> like Graph honors ?commit= (scroll + highlight).
  jumpToBranch(name: string) {
    this.guardedNav(['/p', this.slug(), 'branches'], { queryParams: { branch: name } });
  }
  // Files tab: worktree + file selection live in the URL like ?task / ?commit.
  filesNav(e: { wt: string; file: string | null }) {
    this.guardedNav(['/p', this.slug(), 'files'], { queryParams: { wt: e.wt || null, file: e.file } });
  }
  closePanel() {
    this.router.navigate(['/p', this.slug(), this.tab()], { queryParams: { commit: null }, queryParamsHandling: 'merge' });
  }
}
