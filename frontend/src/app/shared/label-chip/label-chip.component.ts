import { Component, input, output } from '@angular/core';

// ONE rendering for "a task label" (task 155) — the Tasks tab's title cell (and
// its "+N more" chip) and the label-axis manager's editor (shared/axes). The
// two had been built separately (.label-chip / .ax-chip) with the same recipe.
//
//   label      the text shown
//   color      the label's axis colour from /api/axes, or null for a label no
//              axis claims (neutral grey). It is mixed against theme values
//              here, so the chip stays legible whatever colour the owner picks.
//   removable  shows an inline × that emits `remove` (the axis editor)
//
// A tooltip goes on the host (pTooltip on <app-label-chip>).
@Component({
  selector: 'app-label-chip',
  templateUrl: './label-chip.component.html',
  styleUrl: './label-chip.component.scss',
})
export class LabelChipComponent {
  label = input.required<string>();
  color = input<string | null>(null);
  removable = input(false);

  remove = output<void>();
}
