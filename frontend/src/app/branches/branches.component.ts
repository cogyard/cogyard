import { Component, input, output, inject, effect, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { Tag } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { OriginLinkComponent } from '../shared/origin-link/origin-link.component';
import { ApiService } from '../services/api.service';
import { Branch, BranchesResponse } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';

const STALE_DAYS = 30; // highlight branches untouched longer than this

@Component({
  selector: 'app-branches',
  imports: [Tag, TableModule, TooltipModule, Skeleton, OriginLinkComponent],
  templateUrl: './branches.component.html',
  styleUrl: './branches.component.scss',
})
export class BranchesComponent {
  private api = inject(ApiService);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  slug = input.required<string>();
  // Set from ?branch= (arriving from the Worktrees tab) — scroll its row into
  // view and highlight it, mirroring graph's activeHash. Matches across sections.
  activeBranch = input<string | null>(null);
  openCommit = output<string>();
  jumpWorktree = output<string>();
  jumpTask = output<string>();

  isActive(b: Branch) { const a = this.activeBranch(); return !!a && b.name === a; }

  private cached = computed(() => this.store.sig<BranchesResponse>(`branches|${this.slug()}`)());
  main = computed(() => this.cached()?.main ?? null);
  originUrl = computed(() => this.cached()?.originUrl ?? null);
  all = computed<Branch[]>(() => this.cached()?.branches ?? []);
  loading = computed(() => this.cached() === null);
  readonly staleDays = STALE_DAYS;

  mergedCount = computed(() => this.all().filter((b) => b.merged).length);
  staleCount = computed(() => this.all().filter((b) => this.isStale(b)).length);

  // Active (local, unmerged) on top, Merged (local, merged into main) below,
  // Remote last. Each list keeps the server's last-activity-desc order; main is
  // pinned to the top of Active (and never counts as "merged" against itself).
  sections = computed(() => {
    const merged = (b: Branch) => b.merged && !this.isMainRow(b);
    const local = this.all().filter((b) => !b.isRemote);
    const active = local.filter((b) => !merged(b));
    active.sort((a, b) => (this.isMainRow(b) ? 1 : 0) - (this.isMainRow(a) ? 1 : 0));
    return [
      { key: 'active', label: 'Active', list: active },
      { key: 'merged', label: 'Merged', list: local.filter(merged) },
      { key: 'remote', label: 'Remote', list: this.all().filter((b) => b.isRemote) },
    ]
      .filter((s) => s.list.length)
      .map((s) => ({ ...s, count: s.list.length }));
  });

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (!s) return;
      this.store.load(`branches|${s}`, this.api.branches(s));
    });
    // Scroll the active branch row into view once per selection — a background
    // refresh swapping the table must not re-scroll. Mirrors graph.component.
    effect(() => {
      const a = this.activeBranch();
      this.sections();
      if (a && a !== this.scrolledBranch) {
        this.scrolledBranch = a;
        setTimeout(() => this.scrollActiveIntoView(), 80);
      }
      if (!a) this.scrolledBranch = null;
    });
  }
  private scrolledBranch: string | null = null;

  private scrollActiveIntoView() {
    const row = document.querySelector('.bt-row.active') as HTMLElement | null;
    const main = document.querySelector('main') as HTMLElement | null;
    if (!row || !main) return;
    const r = row.getBoundingClientRect(), m = main.getBoundingClientRect();
    if (r.top - m.top > 40 && r.bottom - m.top < main.clientHeight) return; // already visible
    const rowOffset = (r.top - m.top) + main.scrollTop;
    main.scrollTo({ top: Math.max(0, rowOffset - main.clientHeight * 0.35), behavior: 'smooth' });
  }

  isStale(b: Branch) { return b.staleDays != null && b.staleDays > STALE_DAYS; }
  isMainRow(b: Branch) { return !b.isRemote && b.name === this.main(); }
}
