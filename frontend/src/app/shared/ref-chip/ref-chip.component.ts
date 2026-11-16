import { Component, input } from '@angular/core';

// ONE rendering for "a git branch or tag name on a commit" (task 155) — the
// Graph's ref column and the main-branch chip on the Worktrees and Branches
// tabs. Before this, Graph restyled PrimeNG tags through ::ng-deep with five hex
// pairs and styles.scss carried a separate `.p-tag.badge.main-ref` for the other
// two tabs.
//
//   kind  main    the trunk (main/master, local or remote) — inverse black
//         local   a local-only branch — accent tint
//         remote  origin/<name> with no local twin — blue tint
//         synced  a local branch level with its origin twin — grey
//         tag     a release tag — GOLD ON BLACK and TAG-SHAPED (pointed left),
//                 with a gold edge that follows the point. It was green, and
//                 the shape alone did not keep it apart from an Idle task chip
//                 on the Graph; releases are rare and meant to stand out, so it
//                 now does by brightness (task 243, owner's pick 2026-11-05)
//
// The name is the CONTENT, shown as written in monospace. Colours are the
// --app-ref-* theme values (styles.scss). Not a control: a ref that navigates is
// app-git-ref's job.
export type RefKind = 'main' | 'local' | 'remote' | 'synced' | 'tag';

@Component({
  selector: 'app-ref-chip',
  templateUrl: './ref-chip.component.html',
  styleUrl: './ref-chip.component.scss',
})
export class RefChipComponent {
  kind = input.required<RefKind>();
}
