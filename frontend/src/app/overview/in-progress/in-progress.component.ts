import { Component, computed, inject, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { Popover } from 'primeng/popover';
import { StoreService } from '../../services/store.service';
import { ConfigService } from '../../services/config.service';
import { InProgressProject, InProgressResponse, InProgressTask, RecentlyDoneTask } from '../../services/models';
import { TaskChipComponent } from '../../shared/task-chip/task-chip.component';
import { FlagComponent } from '../../shared/flag/flag.component';
import { AgentStateComponent } from '../../shared/agent-state/agent-state.component';
import { TaskSquaresComponent } from '../../shared/task-squares/task-squares.component';
import { WhenGroup, groupByWhen } from '../../plan/recently-done/when';

// The top of the All tab (task 265): one box per project, so the owner sees what
// is moving everywhere without going from Plan tab to Plan tab.
//
// Each box: the project's name with its last 10 closed tasks on the same line
// (the Plan tab's Recently done strip — its grouping, its chips; only whole
// chips, and "… more" lists them in a panel over the page), then each task in
// progress on two lines: chip, flags and title; the agent's state and the Plan
// card's squares. No counts anywhere (owner, 2026-11-21: "I can count myself").
//
// The data is the Plan's own (GET /api/in-progress, core/in-progress.mjs); the
// rules below only choose which projects get a box and in what order:
//   · a box in the grid for any project with a chat reporting on one of its
//     tasks, or a task closed this week or last week (the strip's own week
//     labels and Settings → week start);
//   · first the projects with a reporting chat, by their newest agent event;
//     then by their newest close; ties in registry order;
//   · inside a box, tasks with a reporting chat first (newest event first), then
//     the rest in the Plan's order;
//   · a project whose tasks are all OLD CLAIMS — no chat reporting, nothing
//     closed this week or last — is folded into one line under the grid, its box
//     shown only on "show" (owner, 2026-11-22: in the grid they took half the
//     boxes and buried the live ones; on 2026-11-21 ten of fifteen claims were
//     47–147 days old).

const RECENT = new Set(['Today', 'Yesterday', 'This week', 'Last week']);
// A chat that is reporting what it does. Archived, deleted and "no live signal"
// say nothing about now; someone else's claim (agent null) runs elsewhere.
const reporting = (t: InProgressTask) => !!t.agent && !['archived', 'deleted', 'unknown'].includes(t.agent.state);
const lastEvent = (t: InProgressTask) => t.agent?.at ?? t.agent?.since ?? 0;
const DAY = 864e5;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One group of the name line: its label glued to its first chip, so a label is
 *  never left at the end of the line without a chip after it. */
export interface StripGroup { label: string; first: RecentlyDoneTask & { note: string }; rest: (RecentlyDoneTask & { note: string })[]; }

export interface InProgressBox {
  slug: string; label: string;
  tasks: InProgressTask[];
  groups: WhenGroup[];
  strip: StripGroup[];
  live: boolean;
  recent: boolean;
  /** Days since each in-progress task was claimed (old-claim boxes show the range). */
  claimedDays: number[];
}

const range = (days: number[]) => {
  const lo = Math.min(...days), hi = Math.max(...days);
  return `${lo === hi ? lo : `${lo}–${hi}`} day${hi === 1 ? '' : 's'}`;
};

@Component({
  selector: 'app-overview-in-progress',
  imports: [NgTemplateOutlet, Skeleton, TooltipModule, Popover, TaskChipComponent, FlagComponent, AgentStateComponent, TaskSquaresComponent],
  templateUrl: './in-progress.component.html',
  styleUrl: './in-progress.component.scss',
})
export class InProgressComponent {
  private store = inject(StoreService);
  private cfg = inject(ConfigService);
  selectProject = output<string>();
  openTask = output<{ slug: string; id: string }>();

  private data = this.store.use<InProgressResponse>(() => 'in-progress');
  loading = computed(() => this.data() === null);
  private weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  readonly stripTip = 'Recently done — the last 10 closed, newest first';

  private all = computed(() => (this.data()?.projects ?? []).filter((p) => !p.error).map((p) => this.boxOf(p)));

  /** The grid: projects with a reporting chat or a recent close. */
  boxes = computed(() => {
    const newestEvent = (b: InProgressBox) => Math.max(0, ...b.tasks.filter(reporting).map(lastEvent));
    const newestClose = (b: InProgressBox) => b.groups[0]?.tasks[0]?.doneDate ?? '';
    return this.all()
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.live || b.recent)
      .sort((x, y) => Number(y.b.live) - Number(x.b.live)
        || (x.b.live ? newestEvent(y.b) - newestEvent(x.b) : newestClose(y.b).localeCompare(newestClose(x.b)))
        || x.i - y.i)
      .map(({ b }) => b);
  });

  /** Projects whose tasks are all old claims — folded under the grid. */
  oldClaims = computed(() => this.all().filter((b) => !b.live && !b.recent && b.tasks.length));
  oldSummary = computed(() => {
    const old = this.oldClaims();
    const tasks = old.reduce((n, b) => n + b.tasks.length, 0);
    const days = old.flatMap((b) => b.claimedDays);
    return `${plural(old.length, 'project')} with only old claims · ${plural(tasks, 'task')}`
      + (days.length ? ` · claimed ${range(days)} ago` : '');
  });
  showOld = signal(false);

  /** Projects with nothing in progress and nothing closed this week or last. */
  without = computed(() => this.all().filter((b) => !b.live && !b.recent && !b.tasks.length).map((b) => b.label));
  /** Projects the server could not read — named, never silently left out. */
  unreadable = computed(() => (this.data()?.projects ?? []).filter((p) => p.error));

  claimedLine(b: InProgressBox) { return b.claimedDays.length ? `claimed ${range(b.claimedDays)} ago` : ''; }

  private boxOf(p: InProgressProject): InProgressBox {
    const groups = groupByWhen(p.recent ?? [], new Date(), this.weekStart());
    const progress = p.progress ?? [];
    const live = progress.filter(reporting).sort((a, b) => lastEvent(b) - lastEvent(a));
    const tasks = [...live, ...progress.filter((t) => !reporting(t))];
    const claimedDays = progress
      .map((t) => (t.claimedAt ? Math.floor((Date.now() - Date.parse(t.claimedAt)) / DAY) : NaN))
      .filter(Number.isFinite);
    return {
      slug: p.slug, label: p.label, tasks, groups,
      strip: groups.map((g) => ({ label: g.label, first: g.tasks[0], rest: g.tasks.slice(1) })),
      live: live.length > 0,
      recent: groups.some((g) => RECENT.has(g.label)),
      claimedDays,
    };
  }

  // Which box's closed-task panel is open, for its button's word.
  openSlug = signal<string | null>(null);

  stepsText(t: InProgressTask) { return (t.youSteps ?? []).map((s) => s.text.replace(/\*\*|`/g, '')).join('\n'); }
}
