import { Component, computed, input } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { PlanCode, TaskBox } from '../../services/models';

// ONE rendering of a task's checkbox squares and where its code is (task 251;
// shared since task 265): the Plan card and the All tab's per-project boxes are
// both this component, so the two can't drift.
//
// One square per checkbox, in the task file's order: a ticked one black when its
// code is on main, light blue when it is only on the branch, grey when the task
// has no code state (a finished task's squares, too). At the end of the squares,
// on the same row, where the code is: `on main`, or `↑a ↓b` (commits ahead of
// and behind main) — nothing when there is no branch.
//
// The caller places it (the Plan card pins it to the card's foot); this lays
// out only the squares and the text after them.

const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

@Component({
  selector: 'app-task-squares',
  imports: [TooltipModule],
  templateUrl: './task-squares.component.html',
  styleUrl: './task-squares.component.scss',
})
export class TaskSquaresComponent {
  boxes = input.required<TaskBox[]>();
  done = input.required<number>();
  total = input.required<number>();
  /** Where the task's code is; null or `none` = no code text (a finished task). */
  code = input<PlanCode | null>(null);

  codeText = computed(() => {
    const c = this.code();
    if (c?.state === 'merged') return { kind: 'main' as const, ahead: 0, behind: 0 };
    if (c?.state === 'ahead') return { kind: 'ahead' as const, ahead: c.ahead, behind: c.behind };
    return null;
  });
  codeTip = computed(() => {
    const c = this.code();
    if (c?.state === 'merged') return c.branch
      ? `On main: ${c.branch} has nothing main lacks`
      : 'On main: its branch is gone, and main has its commits';
    if (c?.state !== 'ahead') return '';
    return `${c.branch}: ${commits(c.ahead)} main doesn't have yet`
      + (c.behind ? `; ${commits(c.behind)} behind main` : '; not behind main');
  });
}
