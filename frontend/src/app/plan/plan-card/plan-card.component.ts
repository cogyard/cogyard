import { Component, computed, input, output } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { PlanTask } from '../../services/models';
import { TaskChipComponent } from '../../shared/task-chip/task-chip.component';
import { FlagComponent } from '../../shared/flag/flag.component';
import { AgentStateComponent } from '../../shared/agent-state/agent-state.component';
import { LabelChipComponent } from '../../shared/label-chip/label-chip.component';
import { TaskSquaresComponent } from '../../shared/task-squares/task-squares.component';
import { TYPE_ICONS } from '../../shared/task-buckets';
import { crossLabel, crossRef, isCross } from '../cross-ref';

// One task card on the Plan tab (task 198; was a template inside
// plan.component.html). Used by the Plan's groups AND by the Recently done
// strip's expanded view (../recently-done), so a card looks the same wherever
// it sits.
//
// What it shows, top to bottom: the type icon (the Tasks tab's glyph), the task
// chip (+ "worktree missing", task 189) and the task's category tags coloured
// by their axis (task 227); the title; on a claimed task who holds it and what
// its agent is doing now (task 202); what a PARKED task waits on; "frees" + the
// tasks waiting on it; what it blocks in other projects; "files unknown"; a
// flag when a step is the owner's (checkboxes marked `(you: …)` — "next" when
// the next unticked box is theirs, "later" when one further down is), on its
// own line just above the squares (task 227); and one square per checkbox, in
// the task file's order (task 251): a ticked one black when its code is on
// main, light blue when it is only on the branch, grey when the task has no
// code state (no green when every box is ticked). At the end of the squares,
// on the same row, where the code is: `on main`, or `↑a ↓b` (commits ahead of
// and behind main) — nothing when there is no branch.
//
// It decides nothing about clicks: `select` says the card was clicked (the Plan
// opens its quick look), `openTask` says a chip inside it was. Dimming, and the
// reason shown as the dimmed card's tooltip, come in from the Plan's filters.
//
// A finished task (the strip) has only id, title, type, labels, checkbox
// counts and boxes (with no code state); every other field is optional and
// reads as empty. Tag colours come in
// from the Plan (`labelColors`, built from /api/plan's axes); a tag missing
// from it is in no axis and shows grey.
export type PlanCardTask = Pick<PlanTask, 'id' | 'title' | 'done' | 'total' | 'boxes'> & Partial<PlanTask>;

const EMPTY: Pick<PlanTask, 'type' | 'labels' | 'status' | 'unmet' | 'waitedOnBy' | 'blocksOther' | 'youNext' | 'youLater' | 'youSteps' | 'filesUnknown' | 'worktreeMissing' | 'claimedBy' | 'claimedAt' | 'claimedByOther' | 'agent' | 'code'> = {
  type: null, labels: [], status: '', unmet: [], waitedOnBy: [], blocksOther: [], youNext: null, youLater: [], youSteps: [], filesUnknown: false, worktreeMissing: false,
  claimedBy: null, claimedAt: null, claimedByOther: false, agent: null,
  code: { state: 'none', ahead: 0, behind: 0, branch: null },
};
@Component({
  selector: 'app-plan-card',
  imports: [TooltipModule, TaskChipComponent, FlagComponent, AgentStateComponent, LabelChipComponent, TaskSquaresComponent],
  templateUrl: './plan-card.component.html',
  styleUrl: './plan-card.component.scss',
})
export class PlanCardComponent {
  task = input.required<PlanCardTask>();
  slug = input.required<string>();
  dim = input(false);
  /** Why the Plan's filters dimmed it — the dimmed card's tooltip (task 239). */
  dimWhy = input('');
  labelColors = input<Record<string, string>>({});
  select = output<void>();
  openTask = output<string>();

  t = computed(() => ({ ...EMPTY, ...this.task() }));
  // The squares are t().boxes as sent — one per checkbox, the task's size and how
  // far along it is at once (owner's pick, 2026-10-06; a bar of work LEFT made a
  // finished task look barely started), in file order so where the open work
  // sits shows (task 251; they were ticked-first before). Drawn, with the code
  // text after them, by the shared app-task-squares (task 265).
  typeIcon = computed(() => TYPE_ICONS[this.t().type ?? ''] ?? null);
  colorOf(label: string): string | null { return this.labelColors()[label] ?? null; }
  stepsText = computed(() => this.t().youSteps.map((s) => s.text.replace(/\*\*|`/g, '')).join('\n'));

  isCross = isCross;
  crossRef = crossRef;
  crossLabel = crossLabel;
}
