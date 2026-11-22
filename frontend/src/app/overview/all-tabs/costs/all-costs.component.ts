import { Component, output, inject, computed, signal } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TableModule } from 'primeng/table';
import { ApiService } from '../../../services/api.service';
import { OverviewResponse, UsageResponse, UsageBucket, ActivityResponse } from '../../../services/models';
import { StoreService } from '../../../services/store.service';
import { ConfigService } from '../../../services/config.service';
import { RefreshButtonComponent } from '../../../shared/refresh-button/refresh-button.component';
import { ActivityHeatmapComponent } from '../../../shared/activity-heatmap/activity-heatmap.component';
import { ActivityBraidComponent, projectColors, projectRank } from '../../../shared/activity-braid/activity-braid.component';
import { ActivityDayComponent } from '../../../shared/activity-day/activity-day.component';

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

// The All page's Costs tab (task 266): what the work cost, and nothing else —
// the cost-per-day heatmap, "Where your time went" in cost, and the cost table
// (the cost half of the old project table, with its Scheduled tasks and
// Outside any project rows). Reads usage and activity, and the overview entry
// only for the project rows the ledger joins to (slug, label, error).
@Component({
  selector: 'app-all-costs',
  imports: [TableModule, Skeleton, RefreshButtonComponent, ActivityHeatmapComponent, ActivityBraidComponent, ActivityDayComponent],
  templateUrl: './all-costs.component.html',
  styleUrls: ['../all-tab.scss', '../all-table.scss', './all-costs.component.scss'],
})
export class AllCostsComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private cfg = inject(ConfigService);
  selectProject = output<string>();

  private overview = this.store.use<OverviewResponse>(() => 'overview');
  rows = computed<any[]>(() => this.overview()?.projects ?? []);
  loading = computed(() => this.overview() === null);
  private usage = this.store.use<UsageResponse>(() => 'usage');
  activity = this.store.use<ActivityResponse>(() => 'activity');

  // --- The two day charts ---
  // One day view at a time, under whichever chart was clicked. The braid marks
  // the open day whichever chart opened it, as the one braid did on the old page.
  drill = signal<{ day: string; from: 'heat' | 'braid' } | null>(null);
  openDay(day: string, from: 'heat' | 'braid') { this.drill.set({ day, from }); }
  dayFor(from: 'heat' | 'braid'): string | null { const d = this.drill(); return d?.from === from ? d.day : null; }

  laneColors = computed<Record<string, string>>(() => { const a = this.activity(); return a ? projectColors(a) : {}; });
  laneOrder = computed<string[]>(() => { const a = this.activity(); return a ? projectRank(a) : []; });
  weekStart = computed(() => this.cfg.config()?.ui?.weekStart ?? 'sunday');

  // Daily cost summed across every project: each day's total is costUSD +
  // costApproxUSD (locked-in + estimated); the breakdown keeps the per-project
  // split for the tooltip.
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

  // --- The cost table ---
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

    const totals = { projects: 0, ...blank() };
    for (const r of rows) {
      if (r.error) continue;
      totals.projects++;
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
