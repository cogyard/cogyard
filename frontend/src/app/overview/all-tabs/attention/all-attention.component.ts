import { Component, inject, computed, signal } from '@angular/core';
import { ActivityResponse } from '../../../services/models';
import { StoreService } from '../../../services/store.service';
import { ConfigService } from '../../../services/config.service';
import { ActivityBraidComponent, projectColors, projectRank } from '../../../shared/activity-braid/activity-braid.component';
import { ActivityDayComponent } from '../../../shared/activity-day/activity-day.component';
import { ActivityPunchcardComponent } from '../../../shared/activity-punchcard/activity-punchcard.component';

// The All page's Attention tab (task 266): where your own time went, and
// nothing about money — "Where your time went" in attention, the day it opens
// on a click (your prompts over the agent's working hours), and the
// hour-of-week chart of your prompts. Reads the activity entry only.
@Component({
  selector: 'app-all-attention',
  imports: [ActivityBraidComponent, ActivityDayComponent, ActivityPunchcardComponent],
  templateUrl: './all-attention.component.html',
  styleUrls: ['../all-tab.scss'],
})
export class AllAttentionComponent {
  private store = inject(StoreService);
  private cfg = inject(ConfigService);

  activity = this.store.use<ActivityResponse>(() => 'activity');

  // Stable per-project lane colours and order, shared by the braid and the day view.
  laneColors = computed<Record<string, string>>(() => { const a = this.activity(); return a ? projectColors(a) : {}; });
  laneOrder = computed<string[]>(() => { const a = this.activity(); return a ? projectRank(a) : []; });
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  dayStart = computed(() => this.cfg.config()?.ui?.dayStart ?? 0);
  drillDay = signal<string | null>(null);

  // Per window, the 7×24 prompt matrix summed across all projects.
  punchcardAll = computed<Record<string, number[][]>>(() => {
    const a = this.activity();
    const out: Record<string, number[][]> = {};
    if (!a?.punchcards) return out;
    for (const [win, bySlug] of Object.entries(a.punchcards)) {
      const agg = Array.from({ length: 7 }, () => Array(24).fill(0));
      for (const m of Object.values(bySlug)) {
        m.forEach((row, d) => row.forEach((n, h) => { agg[d][h] += n; }));
      }
      out[win] = agg;
    }
    return out;
  });
}
