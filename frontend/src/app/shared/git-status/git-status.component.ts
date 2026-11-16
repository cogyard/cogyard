import { Component, computed, input } from '@angular/core';

// ONE rendering for "a file's git status letter" (task 155) — the Files tab's
// tree and header, and the commit panel's file lists. The two disagreed before:
// Files drew tinted PrimeNG tags, the commit panel coloured bare letters, and an
// untracked file was green in one and grey in the other.
//
//   code  git's status code (A, M, D, R, C, T, or ? for untracked). ONE letter
//         is shown, never git's similarity score (task 224: "R097" meant nothing
//         to a reader). The server already sends one letter — every reader of
//         git's status output goes through core/git-file-status.mjs — so the
//         first-letter cut here is only a last guard.
//            A added · M modified · D deleted · R/C/T renamed, copied, type
//            changed · ? untracked (on disk, not in git) · anything else grey
//
// Colours are the --app-git-* theme values (styles.scss), one hue family each:
// added blue, modified yellow, deleted red, renamed violet, untracked grey.
@Component({
  selector: 'app-git-status',
  templateUrl: './git-status.component.html',
  styleUrl: './git-status.component.scss',
})
export class GitStatusComponent {
  code = input.required<string | null | undefined>();

  readonly letter = computed(() => (this.code() || '').charAt(0).toUpperCase());
  readonly key = computed(() => {
    const c = this.letter();
    if (c === 'A' || c === 'M' || c === 'D') return c.toLowerCase();
    if (c === 'R' || c === 'C' || c === 'T') return 'r';
    return 'u';
  });
}
