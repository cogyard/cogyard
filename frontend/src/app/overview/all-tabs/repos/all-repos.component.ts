import { Component, output, inject, computed, signal } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TableModule } from 'primeng/table';
import { OverviewResponse, ActivityResponse } from '../../../services/models';
import { StoreService } from '../../../services/store.service';
import { ConfigService } from '../../../services/config.service';
import { FlagComponent } from '../../../shared/flag/flag.component';
import { ActivityHeatmapComponent } from '../../../shared/activity-heatmap/activity-heatmap.component';
import { ActivityDayComponent } from '../../../shared/activity-day/activity-day.component';
import { ProjectLogoComponent } from '../../../shared/project-logo/project-logo.component';
import { projectColors, projectRank } from '../../../shared/activity-braid/activity-braid.component';

// The All page's Repos tab (task 266): the state of each project's repo — the
// commits-per-day heatmap over the last 52 weeks (all projects, per-project
// split on hover), above the repo half of the old project table: Tasks,
// Worktrees, Dirty, Code and Last commit, with a totals row. The Tasks column
// is the owner's call (2026-11-22, "do it with tasks"); the mock it follows is
// files/266/repos-tab-mock.html in the task store. Reads overview and activity.
@Component({
  selector: 'app-all-repos',
  imports: [TableModule, Skeleton, FlagComponent, ActivityHeatmapComponent, ActivityDayComponent, ProjectLogoComponent],
  templateUrl: './all-repos.component.html',
  styleUrls: ['../all-tab.scss', '../all-table.scss', './all-repos.component.scss'],
})
export class AllReposComponent {
  private store = inject(StoreService);
  private cfg = inject(ConfigService);
  selectProject = output<string>();

  private overview = this.store.use<OverviewResponse>(() => 'overview');
  rows = computed<any[]>(() => this.overview()?.projects ?? []);
  loading = computed(() => this.overview() === null);
  private activity = this.store.use<ActivityResponse>(() => 'activity');

  // --- The commits heatmap and the day it opens ---
  laneColors = computed<Record<string, string>>(() => { const a = this.activity(); return a ? projectColors(a) : {}; });
  laneOrder = computed<string[]>(() => { const a = this.activity(); return a ? projectRank(a) : []; });
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  drillDay = signal<string | null>(null);

  // Commits summed across all projects per day; the per-project map doubles as
  // the tooltip breakdown.
  commitsAllByDay = computed<Record<string, number>>(() => {
    const a = this.activity();
    const out: Record<string, number> = {};
    if (!a) return out;
    for (const byDay of Object.values(a.commits)) {
      for (const [d, n] of Object.entries(byDay)) out[d] = (out[d] || 0) + n;
    }
    return out;
  });
  commitsBreakdown = computed<Record<string, Record<string, number>> | null>(() => {
    const a = this.activity();
    if (!a) return null;
    const out: Record<string, Record<string, number>> = {};
    for (const [slug, byDay] of Object.entries(a.commits)) {
      for (const [d, n] of Object.entries(byDay)) {
        if (!out[d]) out[d] = {};
        out[d][slug] = n;
      }
    }
    return out;
  });

  // --- The repo table ---
  // Column sums for the totals row, over the projects that could be read.
  totals = computed(() => {
    const t = { projects: 0, tasks: 0, wt: 0, stale: 0, dirty: 0, loc: 0 };
    for (const r of this.rows()) {
      if (r.error) continue;
      t.projects++;
      t.tasks += r.tasks?.total || 0;
      t.wt += r.worktrees?.count || 0;
      t.stale += r.worktrees?.stale || 0;
      t.dirty += r.dirty || 0;
      t.loc += r.size?.loc || 0;
    }
    return t;
  });

  // Full numbers (thousands-separated) so magnitudes are visually comparable.
  fmtLoc(n: number | null | undefined): string {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  // The newest commit on main, on hover: its short hash and message.
  commitTitle(c: any): string {
    return c ? `${c.shortHash} — ${c.subject}` : '';
  }
}
