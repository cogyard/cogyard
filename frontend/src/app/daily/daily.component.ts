import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Skeleton } from 'primeng/skeleton';
import { marked } from 'marked';
import { ActivityResponse, Brief, DailyResponse, Heartbeat } from '../services/models';
import { ConfigService } from '../services/config.service';
import { StoreService } from '../services/store.service';
import { ActivityHeatmapComponent } from '../shared/activity-heatmap/activity-heatmap.component';
import { BriefCardComponent } from './brief-card.component';

// The Daily tab — a project's daily record. CORE and PERMANENT: it renders for
// every project whether or not any nightly job is installed, and its content is
// whatever has been written into the task store.
//
// That inversion is the owner's (2026-08-20) and it is what keeps the add-ons
// simple. An add-on does not contribute a panel, register a tab, or know the
// portal exists — it writes a file, and this page reads it. The two jobs that
// write these files today (project-brief, task 120; doc-drift, task 119) could
// both be uninstalled and this tab would still be here, empty and correct.
//
// The question it answers is the one the portal never could: you have been away
// from a project for two weeks, and you want to know what happened while you
// were gone. Two nightly jobs answer halves of that, so both live here:
//
//   · the BRIEFS (this task)  — what happened, where it stands, what's next.
//     Kept as a run of days, because one night's paragraph answers "what
//     happened last night", which is not the question.
//   · DOC DRIFT (task 119)    — what quietly went out of date while you were
//     gone. Deferred off this surface on 2026-08-19 until the findings proved
//     worth reading, and asked for on 2026-08-20.
//
// TASK 134 added the two things that make a run of QUIET days readable, once
// quiet days correctly stopped writing briefs:
//
//   · the COMMITS CHART at the top — where the action was, at a glance, so the
//     day worth reading can be picked out instead of scrolled to. Click a day to
//     read the brief covering it; Escape comes back to the list.
//   · the HEARTBEAT line — proof something still looks at this project. Without
//     it, "quiet for a week" and "the job died a week ago" are the same empty
//     page, and a brief's failure mode is ABSENCE, which is what a person does
//     not notice.
//
// Deliberately NOT the landing tab. Someone working in a project every day
// already knows all of this; it is for coming back. (The brief spent a day
// pinned above the task list, which made the page you work in carry something
// you only want when you return — owner, 2026-08-20.)
//
// Empty is an ORDINARY state here, not a failure: most projects have nothing in
// the store and never will.
@Component({
  selector: 'app-daily',
  imports: [Skeleton, BriefCardComponent, ActivityHeatmapComponent],
  templateUrl: './daily.component.html',
  styleUrl: './daily.component.scss',
  // Escape leaves a day and returns to the list of nights — the same gesture,
  // and the same host binding, the Stats tab's day drill-down uses.
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class DailyComponent {
  private store = inject(StoreService);
  private san = inject(DomSanitizer);
  private cfg = inject(ConfigService);

  slug = input.required<string>();

  private cached = this.store.use<DailyResponse>(() => (this.slug() ? `daily|${this.slug()}` : null));
  briefs = computed(() => this.cached()?.briefs ?? []);
  drift = computed(() => this.cached()?.drift ?? null);
  heartbeats = computed<Heartbeat[]>(() => this.cached()?.heartbeats ?? []);
  loading = computed(() => this.cached() === null);
  empty = computed(() => !this.loading() && !this.briefs().length && !this.drift() && !this.heartbeats().length);

  // --- the commits chart (task 134) -----------------------------------------
  // The same component and the same data the Stats tab draws — one commits
  // heatmap in the portal, not two that drift apart. Shared store key, so
  // visiting both tabs is one request.
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  private activity = this.store.use<ActivityResponse>(() => 'activity');
  commitsByDay = computed<Record<string, number>>(() => this.activity()?.commits?.[this.slug()] ?? {});

  // Drift is collapsed by default: it is a standing list, not news. You open it
  // when you want to know what rotted, which is not every visit.
  driftOpen = signal(false);
  toggleDrift() { this.driftOpen.update((v) => !v); }

  // The report's own markdown, rendered verbatim rather than re-derived, so what
  // you read in the portal is exactly what is in ~/.cogyard/drift/<slug>.md. Its H1 is
  // dropped — the section heading here already says what it is.
  // Memoized on the text for the same reason as the brief card's: a 7-second
  // poll must not rebuild this DOM, or anything the reader has scrolled to or
  // opened inside it moves under them.
  private lastDriftMd: string | null = null;
  private lastDriftHtml: SafeHtml = '';
  driftHtml = computed<SafeHtml>(() => {
    const md = (this.drift()?.markdown || '').replace(/^#[^\n]*\n+/, '');
    if (md !== this.lastDriftMd) {
      this.lastDriftMd = md;
      this.lastDriftHtml = this.san.bypassSecurityTrustHtml(marked.parse(md) as string);
    }
    return this.lastDriftHtml;
  });

  // "3 docs look stale" — the count belongs on a standing list, unlike in a
  // brief, where a sentence that could have been produced by counting is cut.
  driftSummary = computed(() => {
    const d = this.drift();
    if (!d) return '';
    const n = d.findings;
    const when = d.generatedAt ? ` · checked ${String(d.generatedAt).slice(0, 10)}` : '';
    return `${n} doc${n === 1 ? '' : 's'} look${n === 1 ? 's' : ''} stale${when}`;
  });

  // --- one day, picked out of the chart --------------------------------------
  //
  // A brief dated D does NOT cover day D. It narrates everything since the
  // PREVIOUS brief, so it covers the half-open range (previous brief's date, D].
  // Now that quiet days write nothing, that range is routinely a week long, and
  // pretending day→brief is an identity would show "no brief" for most days of a
  // fortnight that is in fact fully narrated.
  //
  // So a clicked day resolves to the OLDEST brief dated on or after it — the
  // first one whose narration had reached that day. A day newer than every brief
  // has genuinely not been written up yet; that resolves to null and the template
  // says so rather than rendering a blank panel.
  selectedDay = signal<string | null>(null);
  pickDay(date: string) { this.selectedDay.set(date); }
  onEscape() { if (this.selectedDay()) this.selectedDay.set(null); }

  selectedBrief = computed<Brief | null>(() => {
    const d = this.selectedDay();
    if (!d) return null;
    // briefs are newest-first, so the last one still dated >= d is the oldest.
    let hit: Brief | null = null;
    for (const b of this.briefs()) { if (b.date && b.date >= d) hit = b; }
    return hit;
  });

  // What that day looked like when no brief reaches it — a real state, not an
  // error: work landed after the last brief was written, or before the job was
  // ever installed.
  selectedDayLabel = computed(() => {
    const d = this.selectedDay();
    if (!d) return '';
    const n = this.commitsByDay()[d] || 0;
    return `${this.longDay(d)} · ${n} commit${n === 1 ? '' : 's'}`;
  });

  // --- which night opens (task 134) ------------------------------------------
  //
  // Coming back after a fortnight away, the brief that should be open is the one
  // covering the last day something actually LANDED — not simply the newest file.
  // "Something landed" is commits, the owner's own definition (2026-08-25) and
  // the signal the chart above draws, so the chart and the open panel agree.
  //
  // Falls back to the newest brief when no brief's range contains a commit day:
  // a project can be genuinely worked without committing, and an empty page
  // would be a worse answer than a slightly stale one.
  openIndex = computed(() => {
    const rows = this.briefs();
    const days = Object.keys(this.commitsByDay()).filter((d) => this.commitsByDay()[d] > 0).sort();
    if (!rows.length || !days.length) return 0;
    for (let i = 0; i < rows.length; i += 1) {
      const to = rows[i].date;
      const from = rows[i + 1]?.date ?? '';   // exclusive lower bound; '' = open-ended
      if (!to) continue;
      if (days.some((d) => d <= to && d > from)) return i;
    }
    return 0;
  });

  // The run of days this covers, e.g. "15 – 19 Aug". The tab's own answer to
  // "how far back does this go", so nobody has to scroll to the bottom to find
  // out whether the fortnight they missed is even here.
  span = computed(() => {
    const rows = this.briefs();
    if (rows.length < 2) return '';
    const oldest = this.shortDay(rows[rows.length - 1].date);
    const newest = this.shortDay(rows[0].date);
    return oldest && newest && oldest !== newest ? `${oldest} – ${newest}` : '';
  });

  // --- is anything still watching this project? (task 134) -------------------
  //
  // The heartbeat exists because a quiet night now writes nothing, and silence
  // is therefore no longer evidence of anything. Three states, and the quiet one
  // is the point of the feature — it is the affirmative "yes, it ran, and there
  // was nothing to say" that an empty page cannot give you.
  //
  // NO heartbeat renders NOTHING. Most projects have no nightly job and never
  // will, and a job predating this feature has not written one yet; alarming on
  // either would make the alarm meaningless before it ever meant anything.
  // ONE LINE PER JOB, not one line for the project (task 139). Two jobs watch a
  // project — the brief and doc drift — and they fail independently: the brief
  // can be running perfectly while drift has been dead for a week. A single line
  // taken from the newest heartbeat would report the healthy one and hide the
  // dead one, which is this feature's own failure mode turned inward.
  //
  // Each job's line says what IT concluded, because "nothing had happened" and
  // "no doc looks stale" are different sentences about different things and
  // neither can stand in for the other.
  watch = computed<{ tone: 'quiet' | 'alarm'; text: string }[]>(() => {
    const out: { tone: 'quiet' | 'alarm'; text: string }[] = [];
    for (const hb of this.heartbeats()) {
      if (!hb.checked) continue;
      const age = this.daysSince(hb.checked);
      if (age === null) continue;
      const who = this.jobLabel(hb.job);

      // Scheduled daily with catch-up, so one missed night is a laptop that was
      // asleep, not a fault. Three is a fault.
      if (age >= 3) {
        out.push({ tone: 'alarm', text: `${who} has not looked at this project since ${this.shortDay(hb.checked)} — ${age} days.` });
        continue;
      }
      if (hb.outcome === 'unchanged') {
        const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : this.shortDay(hb.checked);
        out.push({ tone: 'quiet', text: `${who} checked ${when} — ${this.nothingToSay(hb.job)}` });
        continue;
      }
      if (age === 2) out.push({ tone: 'quiet', text: `${who} last checked ${this.shortDay(hb.checked)}.` });
      // Checked today and it wrote (or failed): the brief or the drift section
      // IS the evidence, and a line here would be a second voice saying it.
    }
    return out;
  });

  // The job ids are add-on ids, which are not sentences. Unknown ids fall back
  // to the raw id rather than being dropped — a job this portal has never heard
  // of is exactly the one whose silence should still be visible.
  private jobLabel(job: string): string {
    if (job === 'project-brief') return 'The brief';
    if (job === 'doc-drift') return 'Doc drift';
    return job;
  }

  private nothingToSay(job: string): string {
    return job === 'doc-drift'
      ? 'no doc looks stale.'
      : 'nothing had happened, so no brief was written.';
  }

  private shortDay(s: string | null): string {
    return s ? new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
  }

  private longDay(s: string): string {
    return new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Whole local days between a YYYY-MM-DD and today. Local, because the brief's
  // own date stamp is local wall-clock (store.mjs dayStamp) and comparing it
  // against a UTC today would report "yesterday" for half of every evening.
  private daysSince(date: string): number | null {
    const then = new Date(`${date}T12:00:00`);
    if (Number.isNaN(then.getTime())) return null;
    const now = new Date();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    return Math.round((noon.getTime() - then.getTime()) / 86400000);
  }

  constructor() {
    // Switching projects closes any open day, the same way the Stats tab does.
    effect(() => { this.slug(); this.selectedDay.set(null); });
  }
}
