import { Component, input, output, inject, effect, computed } from '@angular/core';
import { GitRefComponent } from '../shared/git-ref/git-ref.component';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { Tag } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ApiService } from '../services/api.service';
import { WorktreesResponse } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';

@Component({
  selector: 'app-worktrees',
  imports: [Tag, TableModule, TooltipModule, Skeleton, GitRefComponent],
  templateUrl: './worktrees.component.html',
  styleUrl: './worktrees.component.scss',
})
export class WorktreesComponent {
  private api = inject(ApiService);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  slug = input.required<string>();
  activeWorktree = input<string | null>(null);
  jumpTask = output<string>();
  isActive(w: { name: string }) { const a = this.activeWorktree(); return !!a && w.name === a; }
  // Row cells jump into the tab that shows that thing in context:
  // head → Graph (commit), name → Files (worktree tree), branch → Branches.
  openCommit = output<string>();
  jumpFiles = output<{ wt: string; file: string | null }>();
  jumpBranch = output<string>();

  private cached = computed(() => this.store.sig<WorktreesResponse>(`worktrees|${this.slug()}`)());
  worktrees = computed<any[]>(() => this.cached()?.worktrees ?? []);
  loading = computed(() => this.cached() === null);

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
    const all = this.worktrees();
    return [
      { key: 'active', label: 'Active', groups: this.groupByClone(all.filter((w) => !w.stale)) },
      { key: 'stale', label: 'Stale', groups: this.groupByClone(all.filter((w) => w.stale)) },
    ]
      .map((s) => ({ ...s, count: s.groups.reduce((n, g) => n + g.list.length, 0) }))
      .filter((s) => s.count > 0);
  });

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`worktrees|${s}`, this.api.worktrees(s));
    });
  }
}
