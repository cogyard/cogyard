import { Component, input, output, inject, computed, signal } from '@angular/core';
import { GitRefComponent } from '../shared/git-ref/git-ref.component';
import { TaskChipComponent } from '../shared/task-chip/task-chip.component';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { RefChipComponent } from '../shared/ref-chip/ref-chip.component';
import { FlagComponent } from '../shared/flag/flag.component';
import { TableModule } from 'primeng/table';
import { WorktreesResponse } from '../services/models';
import { StoreService } from '../services/store.service';

@Component({
  selector: 'app-worktrees',
  imports: [RefChipComponent, TableModule, TooltipModule, Skeleton, GitRefComponent, TaskChipComponent, FlagComponent],
  templateUrl: './worktrees.component.html',
  styleUrl: './worktrees.component.scss',
})
export class WorktreesComponent {
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

  private cached = this.store.use<WorktreesResponse>(() => (this.slug() ? `worktrees|${this.slug()}` : null));
  worktrees = computed<any[]>(() => this.cached()?.worktrees ?? []);
  loading = computed(() => this.cached() === null);

  // Worktrees has no change code, so every check re-downloads it as new
  // objects. PrimeNG's table tracks rows by object identity by default, so each
  // check rebuilt every row — closing an open tooltip and dropping a click that
  // landed mid-rebuild. Tracking by path keeps the rows and updates their cells.
  trackRow = (_: number, w: { path: string }) => w.path;

  // Main checkout first, then by name.
  private sorted(items: any[]) {
    return [...items].sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.name.localeCompare(b.name));
  }
  // Active (top) vs Stale (bottom). Empty sections drop.
  sections = computed(() => {
    const all = this.worktrees();
    return [
      { key: 'active', label: 'Active', list: this.sorted(all.filter((w) => !w.stale)) },
      { key: 'stale', label: 'Stale', list: this.sorted(all.filter((w) => w.stale)) },
    ]
      .map((s) => ({ ...s, count: s.list.length }))
      .filter((s) => s.count > 0);
  });
  // The rule every Stale row meets, as the server words it (core/worktrees.mjs:
  // "no commits beyond <base>" + "clean working tree" ARE the definition of
  // stale — its first two reasons). Said once under the heading instead of as a
  // flag on each row.
  staleWhy = computed(() => {
    const w = this.worktrees().find((x) => x.stale);
    return w?.staleReasons?.slice(0, 2).join(' · ') ?? '';
  });

  // The fix for an `unmounted` worktree (task 217), copied by clicking its flag;
  // the flag reads "copied" for a moment on the row that was clicked.
  readonly mountCmd = 'cogyard tasks mount';
  copied = signal<string | null>(null);
  copy(text: string, row: string) {
    navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.set(row);
        setTimeout(() => { if (this.copied() === row) this.copied.set(null); }, 1500);
      },
      () => {},
    );
  }
}
