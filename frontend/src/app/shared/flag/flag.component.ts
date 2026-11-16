import { Component, booleanAttribute, input } from '@angular/core';

// ONE rendering for "a condition word" (task 155): STALE, UNPUSHED, LOCKED,
// REMOVABLE / DIRTY, ON / OFF, "prereq missing", a waiting reason, a storage
// model… Before this, each page drew its own — half as
// PrimeNG <p-tag> restyled through ::ng-deep, half as .badge spans — with the
// same red, amber and green written out as hex three times over.
//
//   tone   what the condition MEANS, never which page it is on:
//            good     fine / done / in sync (REMOVABLE, ORIGIN, enabled)
//            warn     needs a look (UNPUSHED, prereq missing, deps)
//            bad      broken (BROKEN / MISSING storage)
//            review   wants a decision, not broken (STALE, DIRTY) — pink,
//                     not the problem red
//            neutral  a plain fact (LOCKED, MAIN, local, off, the waiting reason)
//            info     worth noticing, not a problem
//            caution  construction tape: held, but nowhere to work on it
//                     (Plan's "worktree missing", task 189) — yellow/black
//          Pale tints from --app-tone-* (styles.scss), checked for red-green
//          colour blindness there. The four status hues are NOT tones: a flag
//          never says anything about a task's status.
//   face   the letter case the word is shown in — `word` UPPERCASE (the
//          default), `mono` monospace as written (ids, names, counts), `text`
//          as written.
//   wrap   let a long flag wrap inside a narrow cell (Cleanup's blocker reason)
//          instead of the chip's usual single line.
//   plain  the word in its tone's text colour with no chip around it, as
//          written — for label-beside-value rows, where a chip's padding
//          pushes its text off the column every other value starts on
//          (task 217: project settings' Location on disk and Publishing).
//
// The text is the CONTENT (<app-flag tone="review">stale</app-flag>). A tooltip
// goes on the host (pTooltip on <app-flag>), which is what the pointer enters.
export type FlagTone = 'good' | 'warn' | 'bad' | 'review' | 'neutral' | 'info' | 'caution';

@Component({
  selector: 'app-flag',
  templateUrl: './flag.component.html',
  styleUrl: './flag.component.scss',
})
export class FlagComponent {
  tone = input<FlagTone>('neutral');
  face = input<'word' | 'mono' | 'text'>('word');
  wrap = input(false);
  plain = input(false, { transform: booleanAttribute });
}
