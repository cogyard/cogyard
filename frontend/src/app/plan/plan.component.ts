import { Component, computed, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { StoreService } from '../services/store.service';
import { PlanBox, PlanClash, PlanResponse, PlanTask } from '../services/models';
import { TaskChipComponent } from '../shared/task-chip/task-chip.component';
import { FlagComponent } from '../shared/flag/flag.component';
import { QuickLookComponent } from './quick-look/quick-look.component';
import { PlanCardComponent } from './plan-card/plan-card.component';
import { RecentlyDoneComponent } from './recently-done/recently-done.component';
import { crossRef, isCross } from './cross-ref';

// The Plan tab (task 179; replaced the Board). What's left in a project, each
// open task in exactly one group by one plain rule — the same rules
// core/plan.mjs computes and states in its header, repeated here as each group
// title's tooltip so the page can always say why a card is where it is:
//   In progress · Can start · Waiting for a task to finish · Waiting on another
//   project · Built — needs your look · Parked (every other PARKED task; a card
//   says what it waits on, if anything).
// Only depends_on makes a task wait (task 239). What a task shares with another
// — files, resources — is for the Autopilot filter, never a group or a card line
// (owner, 2026-11-09: the list could be huge).
//
// A card is ./plan-card (task 198). Filters dim, never hide; a dimmed card's
// tooltip says which filter it fails and why. A click opens the quick look
// (./quick-look).
interface Filter { key: string; label: string; rule: string; test: (t: PlanTask) => boolean; why?: (t: PlanTask) => string; }

@Component({
  selector: 'app-plan',
  imports: [NgTemplateOutlet, Skeleton, TooltipModule, TaskChipComponent, FlagComponent, QuickLookComponent, PlanCardComponent, RecentlyDoneComponent],
  templateUrl: './plan.component.html',
  styleUrl: './plan.component.scss',
})
export class PlanComponent {
  private store = inject(StoreService);
  slug = input.required<string>();
  jumpTask = output<string>();

  private cached = this.store.use<PlanResponse>(() => (this.slug() ? `plan|${this.slug()}` : null));
  plan = computed(() => this.cached());
  loading = computed(() => this.cached() === null);
  // label → its axis colour, first axis wins (the Tasks tab's axisLookup rule);
  // a label in no axis is absent and its chip shows grey (task 227).
  labelColors = computed(() => {
    const m: Record<string, string> = {};
    for (const ax of this.plan()?.axes ?? []) for (const l of ax.labels) if (!(l in m)) m[l] = ax.color;
    return m;
  });

  readonly rules: Record<string, string> = {
    progress: 'Claimed by a chat. A card flagged "worktree missing" is still claimed, but its worktree was removed.',
    can: 'Nothing it depends on is unfinished. Two of these may share a file or a resource — either can go first; the Autopilot filter shows which can start beside what is in progress. The task more others wait on comes first.',
    dep: 'Its depends_on lists a task that is not finished yet.',
    other: 'Its depends_on lists a task in another project that is not finished yet.',
    look: 'Parked, and built: its branch has commits not yet on main, or 80% or more of its checkboxes are ticked.',
    parked: 'Status is PARKED — a deliberate hold; someone un-parks it.',
  };
  readonly filters: Filter[] = [
    { key: 'me', label: 'Needs me next', rule: 'Its next unticked checkbox is marked (you: …).', test: (t) => !!t.youNext },
    { key: 'auto', label: 'Autopilot',
      rule: 'No unticked checkbox is marked (you: …), and it shares no file or resource with a task in progress — autopilot can start it now and finish it (you still sign off at merge).',
      test: (t) => !t.youSteps.length && !this.sharesWithRunning(t).length,
      why: (t) => [
        ...(t.youSteps.length ? ['A checkbox is marked (you: …)'] : []),
        ...this.sharesWithRunning(t).map((c) => `Shares ${[...c.files, ...(c.resources ?? [])].join(', ')} with #${c.id}, in progress`),
      ].join('; ') },
    { key: 'quick', label: 'Quick', rule: '7 or fewer checkboxes left.', test: (t) => t.size === 'quick' },
    { key: 'long', label: 'Long pull', rule: '15 or more checkboxes left.', test: (t) => t.size === 'long' },
    { key: 'ext', label: 'Blocks another project', rule: "Another project's task lists this one in its depends_on.", test: (t) => t.blocksOther.length > 0 },
  ];

  on = signal<ReadonlySet<string>>(new Set());
  open = signal<PlanTask | null>(null);

  t(id: string): PlanTask { return this.plan()!.tasks[id]; }
  isOn(key: string) { return this.on().has(key); }
  toggle(key: string) {
    const next = new Set(this.on());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.on.set(next);
  }
  // The tasks in progress, and what a task shares with them — only those, never
  // every open task it overlaps (task 239).
  private running = computed(() => new Set(this.plan()?.groups.progress ?? []));
  sharesWithRunning(t: PlanTask): PlanClash[] {
    const r = this.running();
    return r.has(t.id) ? [] : (t.clash ?? []).filter((c) => r.has(c.id));
  }
  // Every chosen filter must hold (they narrow together).
  dim(t: PlanTask): boolean { return [...this.on()].some((k) => !this.filters.find((f) => f.key === k)!.test(t)); }
  // A dimmed card's tooltip: each chosen filter it fails, and why.
  dimWhy(t: PlanTask): string {
    return this.filters.filter((f) => this.on().has(f.key) && !f.test(t))
      .map((f) => `Not ${f.label}${f.why ? ' — ' + f.why(t) : ''}`).join('. ');
  }

  count(v: (string | PlanBox)[]): number { return v.reduce((n, x) => n + (typeof x === 'string' ? 1 : x.tasks.length), 0); }
  // The tooltip on a waiting box's "waiting on".
  why(kind: 'dep' | 'other', b: PlanBox): string {
    return kind === 'dep' ? `Its depends_on lists ${b.after.join(', ')}`
      : `Its depends_on lists ${b.after.join(', ')}, in another project`;
  }
  isCross = isCross;
  crossRef = crossRef;
}
