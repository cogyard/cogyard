import { Component, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';

// ONE rendering for "a worktree" or "a branch", used everywhere either appears.
//
// Before this existed the same worktree name rendered six different ways across
// the portal (accent mono link + icon on Tasks/Branches, a neutral sans link on
// Worktrees, a pill on Files, a grey static chip on Board, a bold static span on
// Graph, muted plain text in the commit panel) — and whether it was clickable at
// all depended only on which tab you were looking at. Branch names were just as
// scattered. Task 104.
//
// The contract, same for both kinds:
//   [kind icon] name
//   · the NAME navigates to that kind's home tab (Worktrees / Branches)…
//   · …except ON its home tab, where `linked=false` renders it as plain text —
//     a link to the page you are already on is noise.
//
// There is deliberately NO per-row "files" shortcut. It was tried as a 12px
// glyph (unreadable as a control) and then as a labelled link (a wall of
// identical "files" text down 262 rows, and its width pushed the table into
// horizontal scroll). The Files tab has its own worktree selector; that is the
// way in. Owner call, 2026-07-19.
@Component({
  selector: 'app-git-ref',
  imports: [TooltipModule, NgTemplateOutlet],
  templateUrl: './git-ref.component.html',
  styleUrl: './git-ref.component.scss',
})
export class GitRefComponent {
  kind = input.required<'worktree' | 'branch'>();
  name = input.required<string | null | undefined>();
  /** false on the kind's own tab — the name is shown but goes nowhere. */
  linked = input(true);

  open = output<string>();
}
