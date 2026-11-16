import { Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { Brief } from '../services/models';

// ONE nightly brief, rendered as a card (task 120).
//
// It lived above the task list for a day. The owner's verdict, 2026-08-20: it
// made the page he WORKS in less usable, and someone deep in a project does not
// want it — the brief is what you read when you come BACK, so it earns a tab of
// its own and the Tasks page goes back to being the Tasks page. The card is now
// used many-at-a-time, newest open and the days before it collapsed.
//
// Two states that must never be confused with each other:
//   * WRITTEN — three paragraphs an agent wrote after reading the tasks, the
//     commits and the last session, with its evidence collapsed underneath.
//   * FAILED — a run that could not look. Rendered as an alarm, in its own
//     colour, with the reason and an escalating message. "Nothing happened" and
//     "I could not look" looking alike is the exact failure this design exists
//     to prevent: a brief's failure mode is ABSENCE, and absence is what a
//     person does not notice.
//
// No brief at all renders NOTHING — no empty state, no placeholder, no "install
// the add-on" nag. Most projects will never have one and the page must look
// exactly as it did before this existed.
@Component({
  selector: 'app-brief-card',
  imports: [],
  templateUrl: './brief-card.component.html',
  styleUrl: './brief-card.component.scss',
})
export class BriefCardComponent {
  private san = inject(DomSanitizer);

  brief = input.required<Brief | null>();
  // The newest brief opens; the days behind it are titles until you want one.
  // Reading back through a week should be a scan of dates, not a wall of prose.
  open = input<boolean>(true);

  failed = computed(() => this.brief()?.status === 'failed');

  private toggled = signal<boolean | null>(null);
  collapsed = computed(() => {
    const t = this.toggled();
    return t === null ? !this.open() : t;
  });
  toggle() { this.toggled.set(!this.collapsed()); }

  // The stored markdown carries its own `# project — date` heading (it is a
  // standalone file, readable in any editor). The panel has a header of its
  // own, so that line is dropped here rather than shown twice.
  //
  // MEMOIZED ON THE TEXT, and that is not an optimization — it is the fix for a
  // real bug (owner, 2026-08-20: "I open it and it auto closes by itself after a
  // few seconds"). The portal re-polls every 7s, so `brief()` arrives as a new
  // object each time even when the file has not changed. A plain computed then
  // produced a new SafeHtml, Angular replaced the innerHTML, and the native
  // <details> inside it was destroyed and rebuilt — CLOSED — under whoever was
  // reading it. Returning the same instance for the same text leaves the DOM,
  // and its open/closed state, alone.
  private lastMd: string | null = null;
  private lastHtml: SafeHtml = '';
  html = computed<SafeHtml>(() => {
    const md = (this.brief()?.markdown || '').replace(/^#[^\n]*\n+/, '');
    if (md !== this.lastMd) {
      this.lastMd = md;
      this.lastHtml = this.san.bypassSecurityTrustHtml(marked.parse(md) as string);
    }
    return this.lastHtml;
  });

  // "14 Aug" / "14 Aug · still current 16 Aug" — the carry-forward stamp, which
  // is how a quiet fortnight reads as one brief with a date range rather than
  // fourteen copies of the same paragraph.
  when = computed(() => {
    const b = this.brief();
    if (!b?.date) return '';
    const day = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const carried = b.carriedThrough && b.carriedThrough !== b.date ? ` · still current ${day(b.carriedThrough)}` : '';
    return `${day(b.date)}${carried}`;
  });

  // One line, escalating with the number of nights — the panel's own version of
  // what the file says, so the alarm is legible without opening anything.
  alarm = computed(() => {
    const b = this.brief();
    const n = b?.failures || 1;
    const kind = b?.failureKind;

    // Each kind gets its own sentence, because they send the owner to different
    // places (task 138). Before that they all read alike — every cause arrived
    // as "aborted" — so a night the model merely wedged looked exactly like a
    // night the credential died.

    // The agent ran, was paid, and did not answer with a brief: a prompt or
    // model problem, not a credential one.
    if (kind === 'unusable') {
      return n <= 1 ? 'The agent did not write a brief last night.'
        : `The agent has not written a brief for ${n} nights — it answers, but not with one.`;
    }
    // Output began and then stopped, so the agent was reached and authenticated.
    // This line must never imply the credential is at fault.
    if (kind === 'stalled') {
      return n <= 1 ? 'The agent started answering last night and then stopped.'
        : `The agent has stopped mid-answer ${n} nights running — it connects each time, so this is not the credential.`;
    }
    // Nothing arrived at all. THIS is the one that may point at the credential.
    if (kind === 'no-response') {
      if (n <= 1) return 'The agent could not be reached last night.';
      if (n === 2) return 'The agent could not be reached two nights running — check the credential.';
      return `The agent has not been reachable for ${n} nights — assume the portal has lost its agent credential.`;
    }
    // The run itself was stopped. Nothing to fix on the agent.
    if (kind === 'cancelled') {
      return 'The nightly run ended before this project was briefed.';
    }
    if (n <= 1) return 'No brief could be written last night.';
    if (n === 2) return 'No brief for two nights running.';
    return `No brief for ${n} nights running — this project has been unobserved that long.`;
  });

  cost = computed(() => {
    const c = this.brief()?.cost;
    return typeof c === 'number' && c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`) : '';
  });
}
