import { Component, input, output, inject, effect, signal, computed, HostListener } from '@angular/core';
import { GitRefComponent } from '../shared/git-ref/git-ref.component';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { SelectButton } from 'primeng/selectbutton';
import { InputText } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { marked } from 'marked';
import { ApiService } from '../services/api.service';
import { TasksResponse, ProjectUsageResponse, TaskUsage, TaskChatsResponse, TaskChat, AxisRow } from '../services/models';
import { TranscriptModalComponent } from './transcript-modal/transcript-modal.component';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';
import { TYPES, TYPE_ICONS } from '../shared/task-buckets';
import { UsageBreakdownComponent } from '../shared/usage-breakdown/usage-breakdown.component';

// One rendered block in the task list. `superHeader` (category mode) is the colored
// axis band drawn above the first label-lane of an axis; `isSub` marks a label lane
// (indented, smaller header); `color` tints the header dot; `icon` leads type headers.
interface TaskSection {
  key: string;
  title: string;
  icon?: string;
  color?: string | null;
  list: any[];
  superHeader?: { name: string; color: string | null } | null;
  isSub?: boolean;
}

// The Tasks list. Three independent dimensions, each with ONE clear job (the
// task-096 redesign):
//   · status   (Ready/Claimed/Waiting/Done) — always a COLUMN, never grouped
//   · type     (feature/maintenance/bug/docs) — a radio filter, an always-shown
//                icon, and a grouping option (the DEFAULT grouping)
//   · category (the label axes: Surface/Subsystem/…/Ungrouped) — a filter, a
//                grouping option, and the label-chip colors
// Controls: row 1 = Flat|Grouped + (when grouped) group-by Type|Category + the
// Type radio; row 2 = the Category filter + search. Every row in every view
// carries the same columns (type icon · colored labels · Sub · Deps · Status),
// so switching views never hides information.
@Component({
  selector: 'app-tasks',
  imports: [FormsModule, SelectButton, InputText, TableModule, TooltipModule, Skeleton, UsageBreakdownComponent, GitRefComponent, TranscriptModalComponent],
  templateUrl: './tasks.component.html',
  styleUrl: './tasks.component.scss',
})
export class TasksComponent {
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);

  slug = input.required<string>();
  externalFilter = input<string>('');
  jumpWorktree = output<string>();
  jumpBranch = output<string>();

  // Cached data renders instantly on tab return; spinner only before the
  // very first response for this project ever lands.
  private cached = computed(() => this.store.sig<TasksResponse>(`tasks|${this.slug()}`)());
  all = computed(() => this.cached()?.tasks ?? []);
  loading = computed(() => this.cached() === null);

  // --- View controls ---
  // Flat (one list by #) vs Grouped (sections). Default Grouped.
  mode = signal<'flat' | 'grouped'>('grouped');
  readonly modeOptions = [{ label: 'Flat', value: 'flat' }, { label: 'Grouped', value: 'grouped' }];
  // When grouped: by Status (default), Type, or Category (the label axes).
  groupBy = signal<'status' | 'type' | 'category'>('status');
  readonly groupByOptions = [{ label: 'Status', value: 'status' }, { label: 'Type', value: 'type' }, { label: 'Category', value: 'category' }];
  // When grouped by Category: pick ONE category — an axis, or the Ungrouped
  // bucket (un-curated labels). Shown as a select button; defaults to the first
  // axis (see the effect in the constructor). No "All": stacking every axis was
  // noise, and one-category-at-a-time keeps each label-lane legible.
  static readonly UNGROUPED = '__ungrouped__';
  axisSelect = signal('');
  axisOptions = computed(() => [
    ...this.axes().map((a) => ({ label: a.name, value: a.name })),
    { label: 'Ungrouped', value: TasksComponent.UNGROUPED },
  ]);

  // --- Filters ---
  typeFilter = signal('');       // '' = All; else one of TYPES
  search = signal('');

  readonly typeIcons = TYPE_ICONS;
  // Type radio: All + one segment per type. Icon + word (icon-only was unreadable
  // — the theme's selected/unselected segments are near-identical, so the word
  // carries both "which type" and "is it selected").
  readonly typeFilterOptions = [{ label: 'All', value: '' },
    ...TYPES.map((t) => ({ label: `${TYPE_ICONS[t]} ${this.titleCase(t)}`, value: t }))];
  expanded = signal<Set<string>>(new Set());

  // Type icon + labels read straight off the parsed frontmatter (fm).
  typeIcon(t: any): string { return this.typeIcons[t?.fm?.type] || ''; }
  labelsOf(t: any): string[] { return Array.isArray(t?.fm?.labels) ? t.fm.labels : []; }
  // When grouped by a single category, the label-lanes already name that
  // category's labels — repeating them as row chips is noise. Drop just those
  // (axis-selected → the axis's labels; Ungrouped → the un-mapped labels); chips
  // from OTHER categories still carry information and stay.
  private laneLabelFilter = computed(() => {
    if (this.mode() !== 'grouped' || this.groupBy() !== 'category') return null;
    const sel = this.axisSelect();
    if (sel === TasksComponent.UNGROUPED) return { ungrouped: true, labels: new Set<string>() };
    return { ungrouped: false, labels: new Set(this.axes().find((a) => a.name === sel)?.labels ?? []) };
  });
  rowLabels(t: any): string[] {
    const f = this.laneLabelFilter();
    const labs = this.labelsOf(t);
    if (!f) return labs;
    const lu = this.axisLookup();
    return labs.filter((l) => (f.ungrouped ? l in lu : !f.labels.has(l)));
  }
  visibleLabels(t: any): string[] { return this.rowLabels(t).slice(0, 3); }
  hiddenLabels(t: any): string[] { return this.rowLabels(t).slice(3); }
  // The type icon is redundant on rows already sectioned by type (the header
  // carries it), so drop it only in that one case — it stays everywhere else.
  showRowType = computed(() => !(this.mode() === 'grouped' && this.groupBy() === 'type'));
  // Status is EITHER the grouping OR a column, never both. So the Status column
  // shows only when we're not already grouped by status; then it sits right after
  // ID (see the template). Grouped by status → no column, the section headers carry it.
  showStatusColumn = computed(() => !(this.mode() === 'grouped' && this.groupBy() === 'status'));

  // === Label axes / "category" (task 096) ===
  axes = computed<AxisRow[]>(() => this.cached()?.axes ?? []);
  // label → { axis, color }, first-wins in resolved axis order. Absent = Ungrouped.
  axisLookup = computed(() => {
    const m: Record<string, { axis: string; color: string }> = {};
    for (const ax of this.axes()) for (const l of ax.labels) if (!(l in m)) m[l] = { axis: ax.name, color: ax.color };
    return m;
  });
  labelColor(l: string): string | null { return this.axisLookup()[l]?.color ?? null; }

  // --- Status column (task 096): status is a column, folding in the old
  // per-bucket detail (who / why / done-date). ---
  private titleCase(s: string) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }
  statusLabel(t: any): string {
    const b = t.bucket;
    if (b === 'done') return this.titleCase(String(t.status || 'Done')); // DONE/ENOUGH/OBSOLETE
    return this.titleCase(String(b || 'unknown'));                        // Ready/Claimed/Waiting
  }
  statusDetail(t: any): string {
    switch (t.bucket) {
      case 'claimed': return t.claimedByName || '';
      case 'waiting': return t.waitingWhy || '';
      case 'done': return t.fm?.done_date || '';
      default: return '';
    }
  }
  statusClass(t: any): string { return `st-${t.bucket || 'unknown'}`; }

  // Token/cost usage for this project — feeds the per-task USAGE box in expanded rows.
  usage = computed(() => this.store.sig<ProjectUsageResponse>(`usage|${this.slug()}`)());

  // Per-task cost keyed by task id, for the sortable Cost column. Attribution is
  // claim-window based (core/usage.mjs): only work done while the task was claimed
  // lands here — unclaimed work sits in the ledger's own '(no task)' bucket.
  // Accurate for pickup-task/autopilot runs; a rough floor otherwise.
  private costByTaskId = computed(() => {
    const m = new Map<unknown, number>();
    for (const u of this.usage()?.tasks ?? []) if (u.taskId != null) m.set(u.taskId, u.costUSD || 0);
    return m;
  });

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`tasks|${s}`, this.api.tasks(s));
      if (s) this.store.load(`usage|${s}`, this.api.projectUsage(s));
    });
    effect(() => { this.slug(); this.expanded.set(new Set()); }); // collapse on project switch
    // Keep the axis SelectButton on a valid option — default to the first AXIS
    // once axes load (never the trailing Ungrouped sentinel), and re-anchor if the
    // current pick vanishes on project switch. Wait for axes: defaulting while the
    // list is still empty would latch onto Ungrouped and stick.
    effect(() => {
      const axes = this.axes();
      if (!axes.length) return;
      if (!this.axisOptions().some((o) => o.value === this.axisSelect())) this.axisSelect.set(axes[0].name);
    });
  }

  taskUsage(t: any): TaskUsage | null {
    if (t?.id == null) return null;
    return this.usage()?.tasks?.find((u) => u.taskId === t.id) ?? null;
  }

  usageCost(b: { costUSD: number } | null | undefined): string {
    const total = b?.costUSD || 0;
    if (total <= 0) return '$0';
    if (total < 0.5) return '<$1';
    return '$' + Math.round(total).toLocaleString('en-US');
  }

  filtered = computed(() => {
    const tf = this.typeFilter();
    const q = (this.search() || this.externalFilter() || '').toLowerCase();
    const cost = this.costByTaskId();
    return this.all()
      .filter((t) => {
        if (tf && t.fm?.type !== tf) return false;
        if (q && !(String(t.id ?? '').toLowerCase().includes(q) || String(t.title ?? '').toLowerCase().includes(q))) return false;
        return true;
      })
      // Merge each task's ledger cost on (costUSD) so p-table can sort the Cost
      // column; 0 when the task has no ledger entry.
      .map((t) => ({ ...t, costUSD: cost.get(t.id) ?? 0 }));
  });

  private byId = (a: any, c: any) => String(a.id ?? '').localeCompare(String(c.id ?? ''), undefined, { numeric: true });

  // Every section carries the SAME columns; only the sectioning differs.
  sections = computed<TaskSection[]>(() => {
    const f = this.filtered();
    if (this.mode() === 'flat') return [{ key: 'flat', title: '', list: [...f].sort(this.byId) }];
    if (this.groupBy() === 'category') return this.categorySections(f);
    if (this.groupBy() === 'type') return this.typeSections(f);
    return this.statusSections(f);
  });

  // Grouped by Status — sections in workflow order (active first, closed last),
  // each header wearing the status color. The Status column keeps the per-row
  // detail; only the redundant badge hides (showStatusBadge).
  private static STATUS_ORDER = ['Ready', 'Claimed', 'Waiting', 'Enough', 'Done', 'Obsolete'];
  // Header-dot colors reference the global CSS vars (styles.scss) — no hardcoded
  // hex here, so recoloring a status is a one-line edit in the theme file.
  private static STATUS_COLOR: Record<string, string> = {
    Ready: 'var(--app-status-ready)', Claimed: 'var(--app-status-claimed)', Waiting: 'var(--app-status-waiting)',
    Enough: 'var(--app-status-done)', Done: 'var(--app-status-done)', Obsolete: 'var(--app-status-done)',
  };
  private statusSections(f: any[]): TaskSection[] {
    const groups = new Map<string, any[]>();
    for (const t of f) {
      const s = this.statusLabel(t);
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s)!.push(t);
    }
    const out: TaskSection[] = [];
    for (const s of TasksComponent.STATUS_ORDER) {
      const list = groups.get(s);
      if (list?.length) out.push({ key: 'status/' + s, title: s, color: TasksComponent.STATUS_COLOR[s] ?? 'var(--app-status-done)', list: list.sort(this.byId) });
    }
    for (const [s, list] of groups) { // any off-order status still renders, last
      if (!TasksComponent.STATUS_ORDER.includes(s)) out.push({ key: 'status/' + s, title: s, color: 'var(--app-status-done)', list: list.sort(this.byId) });
    }
    return out;
  }

  // Grouped by Type — one section per type (feature/maintenance/bug/docs), the
  // header wearing the type icon; a trailing "Other" for any off-enum type.
  private typeSections(f: any[]): TaskSection[] {
    const out: TaskSection[] = [];
    for (const t of TYPES) {
      const list = f.filter((x) => x.fm?.type === t).sort(this.byId);
      if (list.length) out.push({ key: 'type/' + t, title: this.titleCase(t), icon: TYPE_ICONS[t], list, color: null });
    }
    const known = new Set(TYPES);
    const other = f.filter((x) => !known.has(x.fm?.type)).sort(this.byId);
    if (other.length) out.push({ key: 'type/other', title: 'Other', icon: '', list: other, color: null });
    return out;
  }

  // Grouped by Category — TWO levels: a colored axis (category) header, then one
  // lane per actual label under it (in the axis's own label order), each lane the
  // tasks carrying that label — the workable per-area lane. A task with several
  // labels appears in each of its labels' lanes (that's the point). Trailing
  // Ungrouped: a lane per in-use label that no axis claims, then an (unlabeled)
  // lane. Only labels with at least one matching task appear.
  private categorySections(f: any[]): TaskSection[] {
    // The axis SelectButton picks ONE category: the Ungrouped bucket, or a single axis.
    const sel = this.axisSelect();
    if (sel === TasksComponent.UNGROUPED) return this.ungroupedSections(f);
    const out: TaskSection[] = [];
    for (const ax of this.axes().filter((a) => a.name === sel)) {
      let first = true;
      for (const label of ax.labels) {
        const list = f.filter((t) => this.labelsOf(t).includes(label)).sort(this.byId);
        if (!list.length) continue;
        out.push({
          key: ax.name + '/' + label, title: label, color: ax.color, isSub: true, list,
          superHeader: first ? { name: ax.name, color: ax.color } : null,
        });
        first = false;
      }
    }
    return out;
  }

  // Ungrouped: a lane per in-use label that no axis claims, then an (unlabeled)
  // catch-all lane. The un-curated backlog the owner maps into axes over time.
  private ungroupedSections(f: any[]): TaskSection[] {
    const out: TaskSection[] = [];
    const lu = this.axisLookup();
    const unmapped = new Map<string, any[]>();
    const unlabeled: any[] = [];
    for (const t of f) {
      const labs = this.labelsOf(t);
      if (!labs.length) { unlabeled.push(t); continue; }
      for (const l of labs) {
        if (lu[l]) continue; // mapped → already shown under its axis lane
        if (!unmapped.has(l)) unmapped.set(l, []);
        unmapped.get(l)!.push(t);
      }
    }
    let firstU = true;
    for (const label of [...unmapped.keys()].sort()) {
      out.push({
        key: 'Ungrouped/' + label, title: label, color: null, isSub: true, list: unmapped.get(label)!.sort(this.byId),
        superHeader: firstU ? { name: 'Ungrouped', color: null } : null,
      });
      firstU = false;
    }
    if (unlabeled.length) {
      out.push({
        key: 'Ungrouped/(unlabeled)', title: '(unlabeled)', color: null, isSub: true, list: unlabeled.sort(this.byId),
        superHeader: firstU ? { name: 'Ungrouped', color: null } : null,
      });
    }
    return out;
  }

  // Relative claim age ("since 2 days ago") for the Status column's Claimed detail.
  since(t: any): string {
    if (!t.claimedAt) return '';
    const days = Math.floor((Date.now() - new Date(t.claimedAt).getTime()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 61) return `${Math.round(days / 7)} weeks ago`;
    return new Date(t.claimedAt).toLocaleDateString();
  }

  expandedKeys = computed(() => Object.fromEntries([...this.expanded()].map((f) => [f, true])));
  trackByFile = (_: number, t: any) => t.file;
  isExpanded(t: any) { return this.expanded().has(t.file); }
  toggle(t: any) {
    const s = new Set(this.expanded());
    if (s.has(t.file)) s.delete(t.file);
    else { s.add(t.file); this.loadChats(t); }
    this.expanded.set(s);
  }

  // Escape collapses whichever row is under the mouse — scoped to hover (not a
  // "collapse all", not tied to activation order) since multiple rows can be
  // expanded at once. No-op if the hovered row is already collapsed, or nothing
  // is hovered.
  hoveredFile = signal<string | null>(null);
  @HostListener('document:keydown.escape') onEscape() {
    const f = this.hoveredFile();
    if (!f || !this.expanded().has(f)) return;
    const s = new Set(this.expanded());
    s.delete(f);
    this.expanded.set(s);
  }

  // Chats that created/implemented/mentioned this task (task 30). Lazy — loaded
  // when the row expands (the created-side spawns git), cached per (slug, id) so
  // re-expanding is instant.
  private loadChats(t: any) {
    const s = this.slug();
    if (s && t?.id != null) this.store.load(`chats|${s}|${t.id}`, this.api.taskChats(s, t.id));
  }
  chats(t: any): TaskChatsResponse | null {
    if (t?.id == null) return null;
    return this.store.sig<TaskChatsResponse>(`chats|${this.slug()}|${t.id}`)();
  }
  // Every chat across the three buckets, ordered oldest-activity first
  // (ascending lastActiveAt) — role is shown by the chip, not the position.
  allChats(t: any): TaskChat[] {
    const c = this.chats(t);
    if (!c) return [];
    return [...(c.created ? [c.created] : []), ...c.implemented, ...c.mentioned]
      .sort((a, b) => String(a.lastActiveAt || '').localeCompare(String(b.lastActiveAt || '')));
  }
  shortId(c: TaskChat): string { return c.sessionId ? c.sessionId.slice(0, 8) : '????????'; }
  chatDate(c: TaskChat): string {
    const iso = c.lastActiveAt || c.startedAt;
    return iso ? iso.slice(0, 10) : '';
  }
  // Click-to-copy the reader command for a chat — kept as a secondary affordance
  // for reading in a terminal; the row itself now opens the transcript in-portal.
  copyBencc(c: TaskChat, ev?: Event) {
    ev?.stopPropagation();
    if (c.sessionId) navigator.clipboard?.writeText(`bencc show ${this.shortId(c)}`);
  }

  // --- in-portal transcript viewer (task 30 follow-up) ---
  // The clicked chat opens in the TranscriptModal popup (its own component);
  // this only tracks which chat is open.
  openChat = signal<TaskChat | null>(null);
  openTranscript(c: TaskChat) { if (c.sessionId) this.openChat.set(c); }
  closeTranscript() { this.openChat.set(null); }

  bodyHtml(t: any): SafeHtml { return this.san.bypassSecurityTrustHtml(marked.parse(t.bodyMd || '*(no body)*') as string); }
  worktreeName(t: any): string | null { return t.worktreeName || null; }

  claimTooltip(t: any): string {
    const parts: string[] = [t.claimedByName || 'claimed'];
    if (t.claimedAt) parts.push(`since ${new Date(t.claimedAt).toLocaleString()}`);
    if (t.claimedBy) parts.push(`session ${t.claimedBy}`);
    return parts.join(' · ');
  }
}
