import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { StoreService } from '../../services/store.service';
import { ConfigService } from '../../services/config.service';
import { RecentlyDoneResponse } from '../../services/models';
import { TaskChipComponent } from '../../shared/task-chip/task-chip.component';
import { PlanCardComponent } from '../plan-card/plan-card.component';
import { groupByWhen } from './when';

// The Plan tab's Recently done strip (task 198), the first thing on the tab.
//
// Collapsed (always, on arrival — nothing is remembered; the owner, 2026-10-09):
// one line of task chips, newest first, split by when each was done
// (./when.ts), with a thin bar between groups, in a white tray that runs to
// the right edge; chips that don't fit fade out. "… more", after the tray, adds the same
// tasks as Plan cards (../plan-card) under the line, one box per group; the
// line itself stays as it is.
//
// Weeks start on the owner's Settings → "Activity week starts on" (ui.weekStart),
// the same value the Stats calendar reads. Leaving the tab destroys this
// component, so it comes back collapsed; switching project collapses it too.
// Data: GET /api/recently-done (core/recently-done.mjs).
@Component({
  selector: 'app-plan-recently-done',
  imports: [TooltipModule, TaskChipComponent, PlanCardComponent],
  templateUrl: './recently-done.component.html',
  styleUrl: './recently-done.component.scss',
})
export class RecentlyDoneComponent {
  private store = inject(StoreService);
  private cfg = inject(ConfigService);
  slug = input.required<string>();
  // Tag colours from the Plan's axes, so a done card's tags match (task 227).
  labelColors = input<Record<string, string>>({});
  jumpTask = output<string>();

  open = signal(false);
  constructor() { effect(() => { this.slug(); this.open.set(false); }); }

  private data = this.store.use<RecentlyDoneResponse>(() => (this.slug() ? `recent|${this.slug()}` : null));
  // The title's tooltip, in the words the Plan's other group titles use.
  readonly rule = 'Status is DONE, newest first by when it was closed — at most 20.';
  groups = computed(() => groupByWhen(this.data()?.tasks ?? [], new Date(), this.cfg.config()?.ui?.weekStart ?? 'sunday'));
}
