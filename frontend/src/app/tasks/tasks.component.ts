import { Component, input, output, inject, effect, signal, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Select } from 'primeng/select';
import { SelectButton } from 'primeng/selectbutton';
import { MultiSelect } from 'primeng/multiselect';
import { InputText } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { marked } from 'marked';
import { ApiService } from '../services/api.service';
import { TasksResponse, ProjectUsageResponse, TaskUsage } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';
import { BUCKET_FILTERS, CATEGORIES, CATEGORY_ICONS, buildBuckets, bucketKeyOf } from '../shared/task-buckets';
import { UsageBreakdownComponent } from '../shared/usage-breakdown/usage-breakdown.component';

@Component({
  selector: 'app-tasks',
  imports: [FormsModule, Select, SelectButton, MultiSelect, InputText, TableModule, TooltipModule, Skeleton, UsageBreakdownComponent],
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

  // Cached data renders instantly on tab return; spinner only before the
  // very first response for this project ever lands.
  private cached = computed(() => this.store.sig<TasksResponse>(`tasks|${this.slug()}`)());
  all = computed(() => this.cached()?.tasks ?? []);
  loading = computed(() => this.cached() === null);
  // Bucket filter (task 091) — replaced the old status filter: the buckets ARE
  // the grouping now, and status only distinguishes Done's sub-groups.
  bucketFilter = signal('');
  categoryFilter = signal('');           // '' = all categories
  labelFilter = signal<string[]>([]);    // OR-match: task shown if it has any selected label
  search = signal('');
  // Flat (single list, sorted by task number) vs Grouped (the four buckets). Default grouped.
  view = signal<'flat' | 'grouped'>('grouped');
  readonly viewOptions = [{ label: 'Flat', value: 'flat' }, { label: 'Grouped', value: 'grouped' }];
  expanded = signal<Set<string>>(new Set());
  readonly bucketOptions = BUCKET_FILTERS.map((b) => ({
    label: b ? b.charAt(0).toUpperCase() + b.slice(1) : 'All buckets', value: b }));
  readonly categoryIcons = CATEGORY_ICONS;
  readonly categoryOptions = [{ label: 'All categories', value: '' },
    ...CATEGORIES.map((c) => ({ label: `${CATEGORY_ICONS[c]} ${c}`, value: c }))];

  // Category icon + labels read straight off the parsed frontmatter (fm), the
  // same passthrough the template already uses for fm.depends_on — no API change.
  categoryIcon(t: any): string { return this.categoryIcons[t?.fm?.category] || ''; }
  labelsOf(t: any): string[] { return Array.isArray(t?.fm?.labels) ? t.fm.labels : []; }
  // At most 3 label chips render inline; the rest collapse into a "+N" chip
  // whose tooltip lists them — so chips never silently fall off the row edge.
  visibleLabels(t: any): string[] { return this.labelsOf(t).slice(0, 3); }
  hiddenLabels(t: any): string[] { return this.labelsOf(t).slice(3); }

  // Distinct labels present across the loaded tasks — drives the label filter's
  // option list. Empty until tasks actually carry labels.
  labelOptions = computed(() => {
    const set = new Set<string>();
    for (const t of this.all()) for (const l of this.labelsOf(t)) set.add(l);
    return [...set].sort().map((l) => ({ label: l, value: l }));
  });

  // Token/cost usage for this project — feeds the per-task USAGE
  // box in expanded rows. The project-level table lives on the Stats tab.
  usage = computed(() => this.store.sig<ProjectUsageResponse>(`usage|${this.slug()}`)());

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`tasks|${s}`, this.api.tasks(s));
      if (s) this.store.load(`usage|${s}`, this.api.projectUsage(s));
    });
    effect(() => { this.slug(); this.expanded.set(new Set()); }); // collapse on project switch
  }

  taskUsage(t: any): TaskUsage | null {
    if (t?.id == null) return null;
    return this.usage()?.tasks?.find((u) => u.taskId === t.id) ?? null;
  }

  // Whole dollars, thousands-separated (matches the overview + usage table).
  usageCost(b: { costUSD: number } | null | undefined): string {
    const total = b?.costUSD || 0;
    if (total <= 0) return '$0';
    if (total < 0.5) return '<$1';
    return '$' + Math.round(total).toLocaleString('en-US');
  }

  filtered = computed(() => {
    const bf = this.bucketFilter();
    const cf = this.categoryFilter();
    const lf = this.labelFilter();
    const q = (this.search() || this.externalFilter() || '').toLowerCase();
    return this.all().filter((t) => {
      if (bf && bucketKeyOf(t) !== bf) return false;
      if (cf && t.fm?.category !== cf) return false;
      if (lf.length && !this.labelsOf(t).some((l) => lf.includes(l))) return false;
      if (q && !(String(t.id ?? '').toLowerCase().includes(q) || String(t.title ?? '').toLowerCase().includes(q))) return false;
      return true;
    });
  });

  buckets = computed(() => buildBuckets(this.filtered()));

  // Flat view: all filtered tasks in one list, sorted by task number.
  flat = computed(() => [...this.filtered()].sort(
    (a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''), undefined, { numeric: true })));

  // One rendering path for both modes: grouped = the four buckets (Done
  // flattened into its status sub-groups, separator above the first); flat = a
  // single headerless section sorted by task number. The template renders one
  // p-table per section — the section `key` picks that bucket's columns.
  sections = computed<{ key: string; title: string; list: any[]; separatorAbove: boolean }[]>(() => {
    if (this.view() === 'flat') return [{ key: 'flat', title: '', list: this.flat(), separatorAbove: false }];
    const out: { key: string; title: string; list: any[]; separatorAbove: boolean }[] = [];
    for (const b of this.buckets()) {
      if (!b.subs) out.push({ key: b.key, title: b.title, list: b.list, separatorAbove: false });
      else b.subs.forEach((s, i) => out.push({ key: b.key, title: s.title, list: s.list, separatorAbove: i === 0 }));
    }
    return out;
  });

  // Relative claim age for the Who column ("since 2 days ago"); falls back to
  // the plain date once it's old enough that day-counting stops being useful.
  since(t: any): string {
    if (!t.claimedAt) return '';
    const days = Math.floor((Date.now() - new Date(t.claimedAt).getTime()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    if (days < 61) return `${Math.round(days / 7)} weeks ago`;
    return new Date(t.claimedAt).toLocaleDateString();
  }

  // p-table's expandedRowKeys shape (keyed by dataKey = file).
  expandedKeys = computed(() => Object.fromEntries([...this.expanded()].map((f) => [f, true])));

  trackByFile = (_: number, t: any) => t.file;

  isExpanded(t: any) { return this.expanded().has(t.file); }
  // Every row (incl. unknown / pre-frontmatter) just expands read-only. Such
  // files are migrated by asking Claude, not via the portal (backfill removed
  // in a prior version).
  toggle(t: any) {
    const s = new Set(this.expanded());
    s.has(t.file) ? s.delete(t.file) : s.add(t.file);
    this.expanded.set(s);
  }

  // Named bodyHtml (not body): a #body template ref in the p-table shadows
  // component members inside the template scope.
  bodyHtml(t: any): SafeHtml { return this.san.bypassSecurityTrustHtml(marked.parse(t.bodyMd || '*(no body)*') as string); }
  worktreeName(t: any): string | null { return t.worktreeName || null; }

  // Claim holder line: "name · since <date> · session <id>" — the
  // name is the team-facing identity; the session id stays for debugging.
  claimTooltip(t: any): string {
    const parts: string[] = [t.claimedByName || 'claimed'];
    if (t.claimedAt) parts.push(`since ${new Date(t.claimedAt).toLocaleString()}`);
    if (t.claimedBy) parts.push(`session ${t.claimedBy}`);
    return parts.join(' · ');
  }
}
