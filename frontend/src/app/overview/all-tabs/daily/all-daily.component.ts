import { Component, output, inject, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { OverviewResponse } from '../../../services/models';
import { StoreService } from '../../../services/store.service';
import { ProjectLogoComponent } from '../../../shared/project-logo/project-logo.component';

// The All page's Daily tab (task 266): the opening paragraph of each project's
// newest nightly brief (task 120) — what was the "Daily Overview" panel. It was
// folded on the old page only because twelve paragraphs pushed the project
// table down (owner, 2026-09-03); on a tab of its own nothing is below it, so
// it is open. Reads the overview entry (its `brief` field) only.
@Component({
  selector: 'app-all-daily',
  imports: [Skeleton, ProjectLogoComponent],
  templateUrl: './all-daily.component.html',
  styleUrls: ['../all-tab.scss', './all-daily.component.scss'],
})
export class AllDailyComponent {
  private store = inject(StoreService);
  selectProject = output<string>();

  private overview = this.store.use<OverviewResponse>(() => 'overview');
  private rows = computed<any[]>(() => this.overview()?.projects ?? []);
  loading = computed(() => this.overview() === null);

  // Failed ones lead — a project nobody could look at is the thing to act on,
  // and it must never queue behind eleven projects that are merely quiet.
  // A FAILED brief has no lead paragraph — its body is the alarm block, and
  // leadParagraph deliberately skips headings and blockquotes. Filtering on the
  // lead alone therefore dropped exactly the card that most needed to be here,
  // making an unobserved project look like a project with nothing to say. That
  // is the absence this whole feature is organized against, so failures qualify
  // on being failures; briefAlarm() supplies their text.
  briefs = computed(() => this.rows()
    .filter((p) => p.brief && (p.brief.lead || p.brief.status === 'failed'))
    .sort((a, a2) => (a2.brief.status === 'failed' ? 1 : 0) - (a.brief.status === 'failed' ? 1 : 0)));

  // How many projects have a brief, and how many could not be briefed at all.
  dailySummary = computed(() => {
    const rows = this.briefs();
    const failed = rows.filter((p) => p.brief.status === 'failed').length;
    const n = `${rows.length} project${rows.length === 1 ? '' : 's'}`;
    return failed ? `${n} · ${failed} could not be briefed` : n;
  });

  // The date the brief was WRITTEN, and nothing else.
  //
  // It used to append "· still current 16 Aug" — the carry-forward stamp, which
  // is the system saying "nothing has happened since". The owner's answer
  // (2026-09-03): "just give me the last written brief with date. i'll know that
  // was the last active day." A date that has not moved says the same thing
  // without a clause, and a dozen of those clauses is the noise that made the
  // section unreadable. The stamp still renders on the project's own Daily tab,
  // where a run of nights is the subject and the range is the point.
  briefWhen(b: any): string {
    if (!b?.date) return '';
    return new Date(`${b.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  // A failed brief has no paragraph to show, so the row says what happened
  // instead — and says it louder each night, because "no news" and "nobody
  // could look" must never read the same way on this page.
  briefAlarm(b: any): string {
    const n = b?.failures || 1;
    const why = b?.error ? ` (${b.error})` : '';
    // Five failure kinds, five different things to go and fix — see the Brief
    // type. Collapsing them would point the owner at the wrong one, which is
    // exactly what "aborted" did for every cause before task 138.
    if (b?.failureKind === 'unusable') {
      return n <= 1 ? `The agent did not write a brief last night${why}.`
        : `No brief for ${n} nights — the agent answers, but not with one${why}.`;
    }
    // Reached and answering, then silent. Not a credential problem.
    if (b?.failureKind === 'stalled') {
      return n <= 1 ? `The agent started answering last night and stopped${why}.`
        : `Stopped mid-answer ${n} nights running — it connects each time${why}.`;
    }
    // Nothing arrived. This is the one that may mean a dead credential.
    if (b?.failureKind === 'no-response') {
      if (n <= 1) return `The agent could not be reached last night${why}.`;
      if (n === 2) return `Unreachable two nights running — check the credential${why}.`;
      return `Unreachable for ${n} nights — the portal has probably lost its agent credential${why}.`;
    }
    if (b?.failureKind === 'cancelled') {
      return `The nightly run ended before this project was briefed${why}.`;
    }
    if (n <= 1) return `No brief could be written last night${why}.`;
    if (n === 2) return `No brief for two nights running${why}.`;
    return `No brief for ${n} nights running — unobserved that long${why}.`;
  }
}
