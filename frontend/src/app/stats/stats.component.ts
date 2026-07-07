import { Component, input, output, inject, computed, effect, signal } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { ApiService } from '../services/api.service';
import { ActivityResponse, ActivityDayCell, ProjectUsageResponse } from '../services/models';
import { StoreService } from '../services/store.service';
import { RefreshService } from '../services/refresh.service';
import { ConfigService } from '../services/config.service';
import { ActivityHeatmapComponent } from '../shared/activity-heatmap/activity-heatmap.component';
import { ActivityDayComponent } from '../shared/activity-day/activity-day.component';
import { StatsCalendarComponent } from '../shared/stats-calendar/stats-calendar.component';
import { projectColors } from '../shared/activity-braid/activity-braid.component';
import { UsageBreakdownComponent } from '../shared/usage-breakdown/usage-breakdown.component';
import { RefreshButtonComponent } from '../shared/refresh-button/refresh-button.component';

// Per-project Stats tab (renamed from Activity): this project's
// commits heatmap — GitHub-graph semantics, "what landed when" — plus the
// project's token/cost usage table. The cross-project attention/cost
// braid lives on the ALL page. The tab id/label/URL is "stats"; the data it
// reads (/api/activity, ActivityResponse) keeps the "activity" name — that
// describes activity-over-time, not the tab.

@Component({
  selector: 'app-stats',
  imports: [Skeleton, ActivityHeatmapComponent, ActivityDayComponent, StatsCalendarComponent, UsageBreakdownComponent, RefreshButtonComponent],
  templateUrl: './stats.component.html',
  styleUrl: './stats.component.scss',
})
export class StatsComponent {
  slug = input.required<string>();
  // A calendar #NN merge badge click bubbles up to the shell, which routes to
  // the Tasks tab with that task selected (same jump the other tabs use).
  jumpTask = output<string>();

  private api = inject(ApiService);
  private store = inject(StoreService);
  private refresh = inject(RefreshService);
  private cfg = inject(ConfigService);
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  dayStart = computed(() => this.cfg.config()?.ui?.dayStart ?? 0);

  private cached = computed(() => this.store.sig<ActivityResponse>('activity')());
  loading = computed(() => this.cached() === null);
  byDay = computed<Record<string, number>>(() => this.cached()?.commits[this.slug()] ?? {});
  // Per-day merged-task ids + per-day cost cells for the calendar.
  mergesByDay = computed<Record<string, string[]>>(() => this.cached()?.merges?.[this.slug()] ?? {});
  costByDay = computed<Record<string, ActivityDayCell>>(() => this.cached()?.projects?.[this.slug()]?.days ?? {});
  laneColors = computed<Record<string, string>>(() => {
    const a = this.cached();
    return a ? projectColors(a) : {};
  });
  // Two independent day drill-downs so each opens directly under what was
  // clicked: heatmapDay under the commits heatmap, calDay
  // under the calendar.
  selectedDay = signal<string | null>(null);
  calDay = signal<string | null>(null);

  // Token/cost usage for this project — the project-level table,
  // moved here from the Tasks tab. Same store key as the Tasks
  // tab's per-task USAGE boxes, so both load into one signal.
  usage = computed(() => this.store.sig<ProjectUsageResponse>(`usage|${this.slug()}`)());

  constructor() {
    effect(() => {
      this.refresh.tick();
      this.store.load('activity', this.api.activity());
      const s = this.slug();
      if (s) this.store.load(`usage|${s}`, this.api.projectUsage(s));
    });
    // Switching projects closes any open day detail.
    effect(() => { this.slug(); this.selectedDay.set(null); this.calDay.set(null); });
  }

  // Ad-hoc refresh: harvest new transcript content server-side, then re-fetch.
  collecting = signal(false);
  collectNow() {
    if (this.collecting()) return;
    this.collecting.set(true);
    this.api.collectUsage().subscribe({
      next: () => { this.store.load(`usage|${this.slug()}`, this.api.projectUsage(this.slug())); this.collecting.set(false); },
      error: () => this.collecting.set(false),
    });
  }

  // Whole dollars, thousands-separated (matches the overview + usage table).
  usageCost(b: { costUSD: number } | null | undefined): string {
    const total = b?.costUSD || 0;
    if (total <= 0) return '$0';
    if (total < 0.5) return '<$1';
    return '$' + Math.round(total).toLocaleString('en-US');
  }
}
