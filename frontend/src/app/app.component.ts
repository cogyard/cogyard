import { Component, signal, inject, OnInit, afterNextRender, effect, computed, viewChild, untracked } from '@angular/core';
import { Router, NavigationEnd, NavigationExtras, UrlTree } from '@angular/router';
import { Location } from '@angular/common';
import { filter } from 'rxjs/operators';
import { Toast } from 'primeng/toast';
import { Tabs, TabList, Tab as PTab } from 'primeng/tabs';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from './services/api.service';
import { BadgeService } from './services/badge.service';
import { RefreshService } from './services/refresh.service';
import { StoreService } from './services/store.service';
import { EditStateService } from './services/edit-state.service';
import { ConfigService } from './services/config.service';
import { Project, FilesBase } from './services/models';
import { PORTAL_TABS, PortalTabId } from './shared/portal-tabs';
import { FreshnessPieComponent } from './shared/freshness-pie/freshness-pie.component';
import { TasksComponent } from './tasks/tasks.component';
import { DailyComponent } from './daily/daily.component';
import { PlanComponent } from './plan/plan.component';
import { BranchesComponent } from './branches/branches.component';
import { GraphComponent } from './graph/graph.component';
import { WorktreesComponent } from './worktrees/worktrees.component';
import { OverviewComponent } from './overview/overview.component';
import { CommitPanelComponent } from './shared/commit-panel/commit-panel.component';
import { FilesComponent } from './files/files.component';
import { NewProjectComponent } from './shared/new-project/new-project.component';
import { SettingsComponent } from './settings/settings.component';
import { AdminComponent, AdminSection, ADMIN_SECTIONS } from './admin/admin.component';
// Build-stamped at build time by scripts/generate-version.mjs — the single source
// of version + commit (works in the packaged desktop app too; no /api/health call).
import versionInfo from '../version.json';

// The project's Admin tab (task 249; it began as the settings cog, task 135) is
// deliberately NOT in PORTAL_TABS: those ids are also the legal ui.hiddenTabs
// values, and this one must never be hideable — it is the only surface a
// project's own settings have. It renders pinned to the RIGHT of the strip.
// Its inner tab is the address's fourth part: /p/<slug>/admin/<section>.
const ADMIN_TAB = 'admin';
type Tab = PortalTabId | typeof ADMIN_TAB;
const TAB_SET = new Set<string>([...PORTAL_TABS.map((t) => t.id), ADMIN_TAB]);
const ADMIN_SECTION_SET = new Set<string>(ADMIN_SECTIONS.map((s) => s.id));

// The page a URL names — its path without the query (/p/<slug>/<tab>, /all, /settings).
const pathOf = (t: UrlTree) => t.root.children['primary']?.segments.map((s) => s.path).join('/') ?? '';

@Component({
  selector: 'app-root',
  imports: [TasksComponent, PlanComponent, BranchesComponent, GraphComponent, WorktreesComponent, OverviewComponent, CommitPanelComponent, FilesComponent, NewProjectComponent, SettingsComponent, AdminComponent, FreshnessPieComponent, Toast, Tabs, TabList, PTab, DailyComponent, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  host: { '(window:resize)': 'measureHeader()' },
})
export class AppComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private location = inject(Location);
  private badge = inject(BadgeService); // instantiate the dock-badge poller
  // Injected here so the shared refresher starts with the app (task 173): it is
  // the only thing that fetches watched store entries.
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  private editState = inject(EditStateService);
  private cfg = inject(ConfigService);

  // The project list (with each project's claimed-task count for the sidebar
  // badges) is a watched store entry like any other: the refresher reloads it
  // when a task store or a repo's refs change.
  private projectsData = this.store.use<Project[]>(() => 'projects');
  projects = computed<Project[]>(() => this.projectsData() ?? []);
  // Whether /api/projects has resolved at least once. Distinguishes "not fetched
  // yet" (empty because loading) from "fetched and genuinely empty" — the root
  // redirect + wizard must only fire on the latter (redirect race).
  loaded = computed(() => this.projectsData() !== null);

  // The tab a project opens on (task 216): /settings → Portal tabs → "Open
  // projects on". The server already resolved it to a visible tab; Tasks until
  // config loads. A task link still opens Tasks — see jumpToTask.
  readonly landingTab = computed<Tab>(() => {
    const t = this.cfg.config()?.ui?.defaultTab;
    return t && PORTAL_TABS.some((p) => p.id === t) ? (t as Tab) : 'tasks';
  });

  constructor() {
    // Publish the toolbar height so the fixed commit sidebar can sit below it.
    afterNextRender(() => this.measureHeader());
    // Re-resolve the URL whenever the project list or the config lands or
    // changes — the root redirect needs both to pick the landing tab.
    effect(() => { this.projectsData(); this.cfg.config(); untracked(() => this.syncFromUrl()); });
  }

  // Per-project claimed-task count for the sidebar badge — projects with work in
  // flight. Same number the dock/web badge sums, so the per-project badges total
  // the app badge.
  claimedFor(slug: string): number { return this.projects().find((p) => p.slug === slug)?.claimed ?? 0; }

  // --- Rail icons (task 114) ---
  // A project has an icon when /settings mapped its slug to an image inside its
  // own repo (config ui.projectIcons); the file itself comes from
  // /api/project-icon. Slugs whose <img> failed (file deleted between config
  // read and fetch) are remembered so the rail falls back to the empty slot
  // instead of a broken-image glyph. The slot is rendered either way — that's
  // what keeps every project NAME starting at the same x.
  // Keyed by the failed URL, not the slug (task 140). Keyed by slug, one bad
  // save blacklisted the project for the life of the page: the owner fixed the
  // path, the rail had already written the slug off, and only a reload brought
  // the icon back. A URL carries its version, so correcting the path asks a new
  // question and the rail retries on its own.
  private iconFailed = signal<ReadonlySet<string>>(new Set());
  hasIcon(slug: string): boolean {
    return !!this.cfg.config()?.ui?.projectIcons?.[slug] && !this.iconFailed().has(this.iconUrl(slug));
  }
  /** Owner ticked "white border" for this project in /settings. */
  hasIconBorder(slug: string): boolean {
    return (this.cfg.config()?.ui?.projectIconBorders ?? []).includes(slug);
  }
  // Content-addressed (task 140): `v` changes whenever the artwork behind this
  // slug does — a different stored path, or the same file edited on disk. The
  // URL used to be slug-only, so re-pointing a project's icon produced a byte
  // -identical address and the browser replayed its cached copy: the owner saved
  // a new icon and the rail sat unchanged for a full minute with nothing to say
  // so. No version (unreadable file) means no parameter; the 404 that follows is
  // the empty-slot state either way.
  iconUrl(slug: string): string {
    const v = this.cfg.config()?.projectIconVersions?.[slug];
    const base = `/api/project-icon?slug=${encodeURIComponent(slug)}`;
    return v ? `${base}&v=${encodeURIComponent(v)}` : base;
  }
  onIconError(slug: string) { this.iconFailed.update((prev) => new Set(prev).add(this.iconUrl(slug))); }

  measureHeader() {
    const h = document.querySelector('.topbar')?.getBoundingClientRect().height;
    if (h) document.documentElement.style.setProperty('--hdr', `${Math.round(h)}px`);
  }

  // Build version shown in the sidebar foot, e.g. "v0.34.0 (aabd73f)" — build-stamped
  // (version.json), so it's correct in the web portal AND the packaged desktop app.
  readonly version = signal<string>(
    versionInfo.version
      ? `v${versionInfo.version}${versionInfo.commit ? ` (${versionInfo.commit})` : ''}`
      : '',
  );
  // A newer build is being served than the one this page runs: a page left open
  // (the desktop app's window, a pinned tab) otherwise keeps its old code until
  // someone reloads it. Shown beside the version for a click-to-reload, and
  // taken automatically the next time the owner switches tab or project (see
  // guardedNav) — that moment already throws the old page away, so loading the
  // new build there costs nothing a switch didn't. It never reloads the page
  // under someone who is just sitting on it: half-typed input, expanded rows and
  // in-flight writes are theirs. The running build is this page's main script
  // (main-<hash>.js); the dev server's main.js has no hash, so dev never compares.
  private readonly runningBuild =
    document.querySelector('script[src*="main"]')?.getAttribute('src')?.match(/main-[A-Za-z0-9]+\.js/)?.[0] ?? null;
  readonly newBuild = computed(() => {
    const served = this.refresh.servedBuild();
    return !!this.runningBuild && !!served && served !== this.runningBuild;
  });
  reloadForNewBuild() {
    if (this.editState.confirmDiscard()) location.reload();
  }
  // These mirror the URL — written only by syncFromUrl(), read by the template.
  slug = signal<string>('');
  tab = signal<Tab>('tasks');
  // Admin's inner tab (task 249) — the fourth address part; Info when absent.
  adminSection = signal<AdminSection>('info');
  // Which task the Tasks tab should OPEN on arrival (task 126). ?task=NN only
  // opens and scrolls to that row in the full list; it no longer narrows the
  // list to ids/titles containing NN behind an empty search box (task 194).
  // `seq` makes each request distinct so a repeat click still opens the row —
  // Angular fires no navigation when the URL is already ?task=NN, and a chip
  // that appears to do nothing is worse than no chip.
  taskFocus = signal<{ id: string; seq: number } | null>(null);
  private taskFocusSeq = 0;
  private focusTask(id: string) { if (id) this.taskFocus.set({ id, seq: ++this.taskFocusSeq }); }
  // The ?task= value already turned into a focus request, so a background
  // NavigationEnd (a different query param changing) doesn't re-open the row.
  private lastUrlTask = '';
  viewAll = signal<boolean>(false);
  settingsRoute = signal<boolean>(false); // URL is /settings
  panelHash = signal<string | null>(null);
  wtParam = signal<string>('');
  fileParam = signal<string>('');
  // Files tab compare base (task 224): ?base=head = vs the last commit,
  // ?base=<sha> = vs an older commit; absent = vs main.
  baseParam = signal<FilesBase>('main');
  branchParam = signal<string>('');
  // ?focus=<sha> (task 175): the commit a cross-tab link opened the Graph FOR.
  // The graph asks /api/graph to include that commit's history even when it is
  // older than the newest-250 window. Kept through in-graph clicks (openCommit
  // merges query params) so selecting another row never reshapes the graph.
  focusParam = signal<string | null>(null);
  // ?source=store&flagged=1 (task 191): the Graph tab shows the project's TASK
  // STORE instead of its code repo, optionally only the flagged commits. In the
  // URL so a link can open it directly.
  storeParam = signal<boolean>(false);
  flaggedParam = signal<boolean>(false);

  // Zero registered projects → the empty state IS the setup wizard. Whether the
  // URL is /settings or the user just landed with no projects, the same component
  // renders; `wizard` only changes its framing + shows the first-project CTA.
  readonly isWizard = computed(() => this.loaded() && this.projects().length === 0);
  readonly showSettings = computed(() => this.settingsRoute() || this.isWizard());

  // The New/Add drawer instance (in the sidebar) — the wizard CTA opens it rather
  // than rebuilding the form.
  private newProject = viewChild(NewProjectComponent);

  // The strip renders PORTAL_TABS minus ui.hiddenTabs. The current tab
  // always shows even when hidden — a deep link (e.g. /p/x/plan) must not leave
  // the user on an invisible tab. Content rendering (@switch) stays unfiltered.
  readonly tabs = computed<{ id: Tab; label: string; icon: string }[]>(() => {
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
      // Old addresses of what moved into Admin (task 249) — Stats, Cleanup, the
      // settings cog, and 'activity' (Stats' name before it was Stats) — are
      // rewritten to the Admin address in place, so an old bookmark lands on the
      // same page and Back doesn't bounce through the old address.
      const MOVED: Record<string, AdminSection> = { stats: 'stats', cleanup: 'cleanup', settings: 'info', activity: 'stats' };
      const moved = MOVED[segs[2]];
      if (moved) {
        this.router.navigate(['/p', segs[1], ADMIN_TAB, moved], { replaceUrl: true, queryParamsHandling: 'preserve' });
        return;
      }
      // Legacy alias: 'board' was replaced by 'plan' (task 179). An old
      // bookmark (/p/x/board) lands on the tab now in that slot instead of
      // falling through to the landing tab. Mirrors TAB_ID_ALIASES in
      // core/config.mjs.
      const LEGACY: Record<string, string> = { board: 'plan' };
      const seg = LEGACY[segs[2]] ?? segs[2];
      this.tab.set(TAB_SET.has(seg) ? (seg as Tab) : this.landingTab());
      if (seg === ADMIN_TAB) {
        this.adminSection.set(ADMIN_SECTION_SET.has(segs[3]) ? (segs[3] as AdminSection) : 'info');
      }
    } else {
      // root or unknown — wait until /api/projects has actually resolved before
      // deciding; otherwise the transient empty list on first load bounces us to
      // /settings and sticks there (redirect race). The subscribe
      // callback re-runs syncFromUrl once projects arrive, so this is reached
      // again with loaded=true and redirects correctly (first project, or the
      // wizard only when genuinely zero). Config too, or the first load would
      // land on Tasks before the saved landing tab arrived.
      if (!this.loaded() || !this.cfg.config()) return;
      const first = this.projects()[0]?.slug;
      this.router.navigate(first ? ['/p', first, this.landingTab()] : ['/settings'], { replaceUrl: true });
      return;
    }
    const task = qp['task'] ?? '';
    // A deep link / bookmark / back-button landing on ?task=NN opens that row
    // too — jumpToTask only covers clicks made inside the app.
    if (task && task !== this.lastUrlTask) this.focusTask(task);
    this.lastUrlTask = task;
    this.panelHash.set(qp['commit'] ?? null);
    this.wtParam.set(qp['wt'] ?? '');
    this.fileParam.set(qp['file'] ?? '');
    const base = qp['base'] ?? '';
    this.baseParam.set(base === 'head' || /^[0-9a-f]{4,40}$/i.test(base) ? base : 'main');
    this.branchParam.set(qp['branch'] ?? '');
    this.focusParam.set(qp['focus'] || null);
    this.storeParam.set(qp['source'] === 'store');
    this.flaggedParam.set(qp['flagged'] === '1');
  }

  // A New/Adopt action just created a project — reload the list and jump to it.
  onProjectCreated(slug: string) {
    this.api.projects().subscribe((ps) => {
      this.store.sig<Project[]>('projects').set(ps);
      if (ps.some((p) => p.slug === slug)) this.router.navigate(['/p', slug, this.landingTab()]);
    });
  }

  // --- Navigation (all routes through the URL) ---
  // Every nav funnels through guardedNav so an unsaved Files-tab edit
  // prompts before being dropped — the files component is destroyed on nav.
  // When a newer build is out and the click changes the page (another tab,
  // project, /all or /settings — not just a query param inside the same tab),
  // it loads the destination as a full page instead, so the switch lands on the
  // new code. The URL carries the whole view state, so nothing is lost.
  private guardedNav(commands: unknown[], extras?: NavigationExtras): boolean {
    if (!this.editState.confirmDiscard()) return false;
    const target = this.router.createUrlTree(commands, extras);
    if (this.newBuild() && pathOf(target) !== pathOf(this.router.parseUrl(this.router.url))) {
      location.assign(this.location.prepareExternalUrl(this.router.serializeUrl(target)));
      return true;
    }
    this.router.navigate(commands as string[], extras);
    return true;
  }
  onProject(slug: string) { this.guardedNav(['/p', slug, this.landingTab()]); }
  showAll() { this.guardedNav(['/all']); }
  goSettings() { this.guardedNav(['/settings']); }
  // Wizard CTA → open the existing New/Add drawer (don't rebuild the form).
  openNewProject() { this.newProject()?.start('init'); }
  setTab(t: Tab) { this.guardedNav(['/p', this.slug(), t]); }
  setAdminSection(s: AdminSection) { this.guardedNav(['/p', this.slug(), ADMIN_TAB, s]); }
  // The address of the page on screen — Admin's carries its inner tab, so a
  // query-only change (opening or closing the commit panel) keeps it.
  private here(): string[] {
    const t = this.tab();
    return t === ADMIN_TAB ? ['/p', this.slug(), t, this.adminSection()] : ['/p', this.slug(), t];
  }
  // Focus is set HERE rather than left to syncFromUrl, because clicking the same
  // chip twice leaves the URL identical and fires no navigation at all.
  jumpToTask(id: string) {
    if (!this.guardedNav(['/p', this.slug(), 'tasks'], { queryParams: { task: id } })) return;
    this.focusTask(id);
  }
  // Worktrees honors ?wt=<name> the way Branches honors ?branch= — switching tab
  // without selecting the row you clicked was the old behaviour (task 104).
  jumpToWorktree(name: string) {
    this.guardedNav(['/p', this.slug(), 'worktrees'], { queryParams: { wt: name || null } });
  }
  selectProject(slug: string) { this.guardedNav(['/p', slug, this.landingTab()]); }
  openCommit(hash: string) {
    this.router.navigate(this.here(), { queryParams: { commit: hash }, queryParamsHandling: 'merge' });
  }
  // Clicking a branch jumps to the Graph tab with that branch's tip selected.
  // `focus` makes the graph load that commit even when it is older than the
  // default window (task 175) — without it an old branch head had no row.
  openCommitInGraph(hash: string) {
    this.guardedNav(['/p', this.slug(), 'graph'], { queryParams: { commit: hash, focus: hash } });
  }
  // Branches tab honors ?branch=<name> like Graph honors ?commit= (scroll + highlight).
  jumpToBranch(name: string) {
    this.guardedNav(['/p', this.slug(), 'branches'], { queryParams: { branch: name } });
  }
  // Files tab: worktree + file selection + compare base live in the URL like ?task / ?commit.
  // A jump from another tab carries no base → vs main.
  filesNav(e: { wt: string; file: string | null; base?: FilesBase }) {
    this.guardedNav(['/p', this.slug(), 'files'], { queryParams: { wt: e.wt || null, file: e.file, base: e.base && e.base !== 'main' ? e.base : null } });
  }
  // Code ↔ task store (task 191). Switching drops the open commit (it belongs
  // to the other repo) and the code graph's ?focus.
  setGraphSource(store: boolean) {
    this.router.navigate(['/p', this.slug(), 'graph'], {
      queryParams: { source: store ? 'store' : null, flagged: null, commit: null, focus: null }, queryParamsHandling: 'merge',
    });
  }
  setGraphFlagged(on: boolean) {
    this.router.navigate(['/p', this.slug(), 'graph'], { queryParams: { flagged: on ? '1' : null, commit: null }, queryParamsHandling: 'merge' });
  }
  closePanel() {
    this.router.navigate(this.here(), { queryParams: { commit: null }, queryParamsHandling: 'merge' });
  }
}
