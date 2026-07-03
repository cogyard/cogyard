import { Component, input, inject, computed, effect, signal } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { ApiService } from '../services/api.service';
import { ActivityResponse } from '../services/models';
import { StoreService } from '../services/store.service';
import { RefreshService } from '../services/refresh.service';
import { ConfigService } from '../services/config.service';
import { ActivityHeatmapComponent } from '../shared/activity-heatmap/activity-heatmap.component';
import { ActivityDayComponent } from '../shared/activity-day/activity-day.component';
import { projectColors } from '../shared/activity-braid/activity-braid.component';
import { ActivityPunchcardComponent } from '../shared/activity-punchcard/activity-punchcard.component';

// Per-project Activity tab (task 064): this project's commits heatmap —
// GitHub-graph semantics, "what landed when". The cross-project attention/cost
// braid lives on the ALL page.

@Component({
  selector: 'app-activity',
  imports: [Skeleton, ActivityHeatmapComponent, ActivityDayComponent],
  templateUrl: './activity.component.html',
  styleUrl: './activity.component.scss',
})
export class ActivityComponent {
  slug = input.required<string>();

  private api = inject(ApiService);
  private store = inject(StoreService);
  private refresh = inject(RefreshService);
  private cfg = inject(ConfigService);
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  dayStart = computed(() => this.cfg.config()?.ui?.dayStart ?? 0);

  private cached = computed(() => this.store.sig<ActivityResponse>('activity')());
  loading = computed(() => this.cached() === null);
  byDay = computed<Record<string, number>>(() => this.cached()?.commits[this.slug()] ?? {});
  laneColors = computed<Record<string, string>>(() => {
    const a = this.cached();
    return a ? projectColors(a) : {};
  });
  selectedDay = signal<string | null>(null);

  constructor() {
    effect(() => {
      this.refresh.tick();
      this.store.load('activity', this.api.activity());
    });
    // Switching projects closes any open day detail.
    effect(() => { this.slug(); this.selectedDay.set(null); });
  }
}
