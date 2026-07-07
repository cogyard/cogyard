import { Component, input, output, inject, effect, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { Tag } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ApiService } from '../services/api.service';
import { WorktreesResponse, ProjectUsageResponse } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';

@Component({
  selector: 'app-worktrees',
  imports: [Tag, TableModule, TooltipModule, Skeleton],
  templateUrl: './worktrees.component.html',
  styleUrl: './worktrees.component.scss',
})
export class WorktreesComponent {
  private api = inject(ApiService);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  slug = input.required<string>();
  jumpTask = output<string>();
  // Row cells jump into the tab that shows that thing in context:
  // head → Graph (commit), name → Files (worktree tree), branch → Branches.
  openCommit = output<string>();
  jumpFiles = output<{ wt: string; file: string | null }>();
  jumpBranch = output<string>();

  private cached = computed(() => this.store.sig<WorktreesResponse>(`worktrees|${this.slug()}`)());
  worktrees = computed<any[]>(() => this.cached()?.worktrees ?? []);
  loading = computed(() => this.cached() === null);

  // Per-worktree cost, joined by worktree name. Deleted worktrees
  // still carry historical spend in the ledger but aren't listed here (this tab
  // is live `git worktree list`); their total shows in the summary line.
  private usage = computed(() => this.store.sig<ProjectUsageResponse>(`usage|${this.slug()}`)());
  private costByName = computed(() => {
    const m = new Map<string, number>();
    for (const w of this.usage()?.worktrees ?? []) if (w.worktree) m.set(w.worktree, w.costUSD || 0);
    return m;
  });
  cost(name: string): string {
    const c = this.costByName().get(name);
    if (!c || c <= 0) return c === 0 ? '$0' : '—';
    if (c < 0.5) return '<$1';
    return '$' + Math.round(c).toLocaleString('en-US');
  }
  projectCost = computed(() => {
    const c = this.usage()?.costUSD || 0;
    return c > 0 ? '$' + Math.round(c).toLocaleString('en-US') : null;
  });
  // Merge each worktree's numeric cost onto the row so p-table can sort the Cost
  // column. cost(name) stays the display formatter; costUSD is the
  // sort key. Worktrees with no ledger entry sort as 0 (still render '—').
  private rows = computed<any[]>(() =>
    this.worktrees().map((w) => ({ ...w, costUSD: this.costByName().get(w.name) ?? 0 })),
  );

  // Group by clone (planet projects); single repo => one group keyed ''.
  private groupByClone(items: any[]) {
    const m = new Map<string, any[]>();
    for (const w of items) {
      const k = w.clone || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(w);
    }
    for (const list of m.values()) {
      list.sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.name.localeCompare(b.name));
    }
    return [...m.entries()].map(([clone, list]) => ({ clone, list }));
  }
  // Active (top) vs Stale (bottom); each still clone-grouped. Empty sections drop.
  sections = computed(() => {
    const all = this.rows();
    return [
      { key: 'active', label: 'Active', groups: this.groupByClone(all.filter((w) => !w.stale)) },
      { key: 'stale', label: 'Stale', groups: this.groupByClone(all.filter((w) => w.stale)) },
    ]
      .map((s) => ({ ...s, count: s.groups.reduce((n, g) => n + g.list.length, 0) }))
      .filter((s) => s.count > 0);
  });
  staleCount = computed(() => this.worktrees().filter((w) => w.stale).length);

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`worktrees|${s}`, this.api.worktrees(s));
      if (s) this.store.load(`usage|${s}`, this.api.projectUsage(s));
    });
  }
}
