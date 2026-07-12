import { Component, input, output, inject, effect, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { Tag } from 'primeng/tag';
import { Card } from 'primeng/card';
import { ApiService } from '../services/api.service';
import { TasksResponse } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';
import { buildBuckets, Bucket, BucketSub } from '../shared/task-buckets';

// Board view: the same four buckets as the Tasks list (task 091), laid out as
// columns of cards. Pure frontend over /api/tasks — reuses buildBuckets so
// columns and list buckets never diverge. The Done column renders its status
// sub-groups (Enough · Done · Obsolete) under sub-headers. Read-only (no
// drag-to-change-status in v1).
@Component({
  selector: 'app-board',
  imports: [Tag, Card, TooltipModule, Skeleton],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss',
})
export class BoardComponent {
  private api = inject(ApiService);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  slug = input.required<string>();
  jumpTask = output<string>();

  // Shares the 'tasks|<slug>' cache entry with the Tasks list — one fetch feeds both.
  private cached = computed(() => this.store.sig<TasksResponse>(`tasks|${this.slug()}`)());
  all = computed(() => this.cached()?.tasks ?? []);
  loading = computed(() => this.cached() === null);

  columns = computed(() => buildBuckets(this.all()));

  // One card loop in the template: bucket sub-groups when present (Done), else
  // the whole list as a single unheaded group.
  groupsOf(col: Bucket): BucketSub[] { return col.subs ?? [{ title: '', list: col.list }]; }

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`tasks|${s}`, this.api.tasks(s));
    });
  }

  // Card click jumps to the task in the Tasks list (filtered + expandable),
  // mirroring the worktrees→task jump. Falls back to title for id-less rows.
  cardClick(t: any) { this.jumpTask.emit(t.id != null ? String(t.id) : String(t.title || t.file)); }
}
