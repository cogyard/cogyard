import { Component, output, inject, computed, signal } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { FlagComponent } from '../shared/flag/flag.component';
import { TableModule } from 'primeng/table';
import { ApiService } from '../services/api.service';
import { OverviewResponse, UsageResponse, UsageBucket, ActivityResponse } from '../services/models';
import { RefreshButtonComponent } from '../shared/refresh-button/refresh-button.component';
import { ActivityHeatmapComponent } from '../shared/activity-heatmap/activity-heatmap.component';
import { ActivityBraidComponent, projectColors, projectRank } from '../shared/activity-braid/activity-braid.component';
import { ActivityDayComponent } from '../shared/activity-day/activity-day.component';
import { ActivityPunchcardComponent } from '../shared/activity-punchcard/activity-punchcard.component';
import { StoreService } from '../services/store.service';
import { ConfigService } from '../services/config.service';

type Money = { cost: number; bf: number }; // bf retained for future use; not shown

// Map an exact model id onto its main family (the column grouping). All Opus
// point versions collapse to "Opus", etc.
function family(model: string): string {
  if (/opus/.test(model)) return 'Opus';
  if (/sonnet/.test(model)) return 'Sonnet';
  if (/haiku/.test(model)) return 'Haiku';
  if (/fable/.test(model)) return 'Fable';
  if (/mythos/.test(model)) return 'Mythos';
  return 'Other';
}

// Column order = model price tier, most expensive on the LEFT (Fable/Mythos
// $10·in/$50·out → Opus $5/$25 → Sonnet $3/$15 → Haiku $1/$5). Not spend order.
const PRICE_RANK: Record<string, number> = { Fable: 0, Mythos: 0, Opus: 1, Sonnet: 2, Haiku: 3, Other: 9 };

@Component({
  selector: 'app-overview',
  imports: [FlagComponent, TableModule, Skeleton, RefreshButtonComponent, ActivityHeatmapComponent, ActivityBraidComponent, ActivityDayComponent, ActivityPunchcardComponent],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
})
export class OverviewComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private cfg = inject(ConfigService);
  selectProject = output<string>();

  private cached = this.store.use<OverviewResponse>(() => 'overview');
  rows = computed<any[]>(() => this.cached()?.projects ?? []);
  loading = computed(() => this.cached() === null);

  // Task 120: the opening paragraph of each project's newest brief, so the
  // cross-project glance is paragraphs rather than a table of counts. Failed
  // ones lead — a project nobody could look at is the thing to act on, and it
  // must never queue behind eleven projects that are merely quiet. Empty when
  // no project has a brief, and the page then renders exactly as it did before.
  // A FAILED brief has no lead paragraph — its body is the alarm block, and
  // leadParagraph deliberately skips headings and blockquotes. Filtering on the
  // lead alone therefore dropped exactly the card that most needed to be here,
  // making an unobserved project look like a project with nothing to say. That
  // is the absence this whole feature is organized against, so failures qualify
  // on being failures; briefAlarm() supplies their text.
  briefs = computed(() => this.rows()
    .filter((p) => p.brief && (p.brief.lead || p.brief.status === 'failed'))
    .sort((a, a2) => (a2.brief.status === 'failed' ? 1 : 0) - (a.brief.status === 'failed' ? 1 : 0)));
  private usage = this.store.use<UsageResponse>(() => 'usage');

  // Closed by default. This page is "where does every project stand" as a table;
  // a dozen paragraphs above it is something you open when you want it, not the
  // first thing you meet (owner, 2026-09-03).
  dailyOpen = signal(false);
  toggleDaily() { this.dailyOpen.update((v) => !v); }

  // What survives being closed. A quiet project contributes a count and nothing
  // else — that is the whole point of collapsing it. A project nobody could
  // brief is named in the header, because a closed section must not be able to
  // hide the one state that needs acting on.
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
  // was the last active day." He is right that the stamp is redundant on this
  // page: a date that has not moved says the same thing without a clause, and a
  // dozen of those clauses is the noise that made the section unreadable. The
  // stamp still renders on the project's own Daily tab, where a run of nights is
  // the subject and the range is the point.
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

  // --- Activity views ---
  activity = this.store.use<ActivityResponse>(() => 'activity');
  // Aggregate commits across all projects for the ALL heatmap; the raw
  // per-project map doubles as the tooltip breakdown.
  commitsAllByDay = computed<Record<string, number>>(() => {
    const a = this.activity();
    const out: Record<string, number> = {};
    if (!a) return out;
    for (const byDay of Object.values(a.commits)) {
      for (const [d, n] of Object.entries(byDay)) out[d] = (out[d] || 0) + n;
    }
    return out;
  });
  commitsBreakdown = computed<Record<string, Record<string, number>> | null>(() => {
    const a = this.activity();
    if (!a) return null;
    const out: Record<string, Record<string, number>> = {};
    for (const [slug, byDay] of Object.entries(a.commits)) {
      for (const [d, n] of Object.entries(byDay)) {
        if (!out[d]) out[d] = {};
        out[d][slug] = n;
      }
    }
    return out;
  });
  // Same aggregation for daily cost: each day's total is costUSD + costApproxUSD
  // (locked-in + estimated) summed across every project; breakdown keeps the
  // per-project split for the tooltip.
  private dayCost = (c: { costUSD: number; costApproxUSD: number }) => (c.costUSD || 0) + (c.costApproxUSD || 0);
  costAllByDay = computed<Record<string, number>>(() => {
    const a = this.activity();
    const out: Record<string, number> = {};
    if (!a) return out;
    for (const { days } of Object.values(a.projects)) {
      for (const [d, cell] of Object.entries(days)) out[d] = (out[d] || 0) + this.dayCost(cell);
    }
    return out;
  });
  costBreakdown = computed<Record<string, Record<string, number>> | null>(() => {
    const a = this.activity();
    if (!a) return null;
    const out: Record<string, Record<string, number>> = {};
    for (const [slug, { days }] of Object.entries(a.projects)) {
      for (const [d, cell] of Object.entries(days)) {
        const v = this.dayCost(cell);
        if (!v) continue;
        if (!out[d]) out[d] = {};
        out[d][slug] = (out[d][slug] || 0) + v;
      }
    }
    return out;
  });
  // Cell text: bare number (no $ — the legend + header make the unit clear),
  // abbreviated ≥1k to stay legible. Header/tooltip use fmtHeatFull for the
  // exact dollar figure.
  fmtHeatCell = (n: number): string => {
    if (!n || n <= 0) return '';
    if (n < 0.5) return '<1';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(Math.round(n));
  };
  fmtHeatFull = (n: number): string => {
    if (!n || n <= 0) return '$0';
    if (n < 0.5) return '<$1';
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  // Stable per-project lane colors, shared by the braid and the drill-down.
  laneColors = computed<Record<string, string>>(() => {
    const a = this.activity();
    return a ? projectColors(a) : {};
  });
  laneOrder = computed<string[]>(() => {
    const a = this.activity();
    return a ? projectRank(a) : [];
  });
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');
  dayStart = computed(() => this.cfg.config()?.ui?.dayStart ?? 0);
  drillDay = signal<string | null>(null);
  // Per window, the 7×24 prompt matrix aggregated across all projects.
  punchcardAll = computed<Record<string, number[][]>>(() => {
    const a = this.activity();
    const out: Record<string, number[][]> = {};
    if (!a?.punchcards) return out;
    for (const [win, bySlug] of Object.entries(a.punchcards)) {
      const agg = Array.from({ length: 7 }, () => Array(24).fill(0));
      for (const m of Object.values(bySlug)) {
        m.forEach((row, d) => row.forEach((n, h) => { agg[d][h] += n; }));
      }
      out[win] = agg;
    }
    return out;
  });

  // One pass over the ledger: the ordered family columns present, each
  // project's cost split by family + total, and the column sums for the totals
  // row. The server maps rows written under a project's old (alias) slugs to
  // the project, so an exact slug match is the whole join.
  //
  // Task 130: the ledger also carries scheduled jobs' own agent calls and usage
  // that belongs to no registered project. Both render below the projects and
  // both are IN the grand total — a row with no project to sit under used to be
  // dropped from it, which is the whole reason this exists.
  agg = computed(() => {
    const u = this.usage();
    const ledger = u?.projects ?? [];
    const jobsLedger = u?.jobs ?? [];
    const outsideLedger = u?.outside ?? [];
    const rows = this.rows();

    const present = new Set<string>();
    for (const p of [...ledger, ...jobsLedger, ...outsideLedger]) for (const m of Object.keys(p.models)) present.add(family(m));
    const families = [...present].sort((a, z) => (PRICE_RANK[a] ?? 9) - (PRICE_RANK[z] ?? 9) || a.localeCompare(z));

    const blankFam = () => Object.fromEntries(families.map((f) => [f, { cost: 0, bf: 0 }])) as Record<string, Money>;
    type Split = { total: Money; fam: Record<string, Money> };
    const blank = (): Split => ({ total: { cost: 0, bf: 0 }, fam: blankFam() });
    const add = (into: Split, models: Record<string, UsageBucket>) => {
      for (const [m, b] of Object.entries(models)) {
        const k = family(m);
        into.fam[k].cost += b.costUSD || 0; into.fam[k].bf += b.backfilledCostUSD || 0;
        into.total.cost += b.costUSD || 0; into.total.bf += b.backfilledCostUSD || 0;
      }
      return into;
    };
    const addSplit = (into: Split, s: Split) => {
      into.total.cost += s.total.cost; into.total.bf += s.total.bf;
      for (const f of families) { into.fam[f].cost += s.fam[f].cost; into.fam[f].bf += s.fam[f].bf; }
    };

    const perSlug = new Map<string, Split>();
    for (const r of rows) {
      const s = blank();
      for (const p of ledger.filter((x) => x.project === r.slug)) add(s, p.models);
      perSlug.set(r.slug, s);
    }

    const jobs = jobsLedger.map((j) => ({ id: j.job, ...add(blank(), j.models) }));
    const jobsTotal = blank();
    for (const j of jobs) addSplit(jobsTotal, j);

    const outsideSlugs = outsideLedger.map((p) => ({ slug: p.project, ...add(blank(), p.models) }));
    const outside = outsideSlugs.length ? { ...blank(), slugs: outsideSlugs } : null;
    if (outside) for (const s of outsideSlugs) addSplit(outside, s);

    const totals = { tasks: 0, wt: 0, dirty: 0, loc: 0, projects: 0, ...blank() };
    for (const r of rows) {
      if (r.error) continue;
      totals.projects++;
      totals.tasks += r.tasks?.total || 0;
      totals.wt += r.worktrees?.count || 0;
      totals.dirty += r.dirty || 0;
      totals.loc += r.size?.loc || 0;
      addSplit(totals, perSlug.get(r.slug)!);
    }
    addSplit(totals, jobsTotal);
    if (outside) addSplit(totals, outside);
    return { families, perSlug, totals, jobs, jobsTotal, outside };
  });

  // The outside-any-project line is one folded row; this opens it to the
  // folders it is made of.
  outsideOpen = signal(false);
  toggleOutside() { this.outsideOpen.update((v) => !v); }

  famCost(slug: string, fam: string): Money | null {
    return this.agg().perSlug.get(slug)?.fam[fam] ?? null;
  }
  totalCost(slug: string): Money | null {
    return this.agg().perSlug.get(slug)?.total ?? null;
  }

  // Whole dollars, thousands-separated. Zero → em dash; sub-dollar → "<$1"
  // (rounding it to "$0" would read as nothing spent).
  fmtCost(m: Money | null | undefined): string {
    if (!m || m.cost <= 0) return '—';
    if (m.cost < 0.5) return '<$1';
    return '$' + Math.round(m.cost).toLocaleString('en-US');
  }

  // Full numbers (thousands-separated) so magnitudes are visually comparable.
  fmtLoc(n: number | null | undefined): string {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  // Ad-hoc refresh: harvest new transcript content server-side, then re-fetch.
  collecting = signal(false);
  collectNow() {
    if (this.collecting()) return;
    this.collecting.set(true);
    this.api.collectUsage().subscribe({
      next: () => { this.store.load('usage', this.api.usage()); this.collecting.set(false); },
      error: () => this.collecting.set(false),
    });
  }
}
