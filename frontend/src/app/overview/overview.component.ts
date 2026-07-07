import { Component, output, inject, effect, computed, signal } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { Tag } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ApiService } from '../services/api.service';
import { OverviewResponse, UsageResponse, ActivityResponse } from '../services/models';
import { RefreshButtonComponent } from '../shared/refresh-button/refresh-button.component';
import { ActivityHeatmapComponent } from '../shared/activity-heatmap/activity-heatmap.component';
import { ActivityBraidComponent, projectColors, projectRank } from '../shared/activity-braid/activity-braid.component';
import { ActivityDayComponent } from '../shared/activity-day/activity-day.component';
import { ActivityPunchcardComponent } from '../shared/activity-punchcard/activity-punchcard.component';
import { RefreshService } from '../services/refresh.service';
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
  imports: [Tag, TableModule, Skeleton, RefreshButtonComponent, ActivityHeatmapComponent, ActivityBraidComponent, ActivityDayComponent, ActivityPunchcardComponent],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
})
export class OverviewComponent {
  private api = inject(ApiService);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  private cfg = inject(ConfigService);
  selectProject = output<string>();

  private cached = computed(() => this.store.sig<OverviewResponse>('overview')());
  rows = computed<any[]>(() => this.cached()?.projects ?? []);
  loading = computed(() => this.cached() === null);
  private usage = computed(() => this.store.sig<UsageResponse>('usage')());

  constructor() {
    effect(() => {
      this.refresh.tick();
      this.store.load('overview', this.api.overview());
      this.store.load('usage', this.api.usage());
      this.store.load('activity', this.api.activity());
    });
  }

  // --- Activity views ---
  activity = computed(() => this.store.sig<ActivityResponse>('activity')());
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
  // row. Multi-clone projects collapse to one overview slug while the ledger
  // keys per-clone registry slugs (e.g. `proj__clone`) — match by
  // slug or "slug__" prefix and sum.
  agg = computed(() => {
    const ledger = this.usage()?.projects ?? [];
    const rows = this.rows();

    const present = new Set<string>();
    for (const p of ledger) for (const m of Object.keys(p.models)) present.add(family(m));
    const families = [...present].sort((a, z) => (PRICE_RANK[a] ?? 9) - (PRICE_RANK[z] ?? 9) || a.localeCompare(z));

    const blankFam = () => Object.fromEntries(families.map((f) => [f, { cost: 0, bf: 0 }])) as Record<string, Money>;
    const perSlug = new Map<string, { total: Money; fam: Record<string, Money> }>();
    for (const r of rows) {
      const fam = blankFam();
      const total: Money = { cost: 0, bf: 0 };
      for (const p of ledger.filter((x) => x.project === r.slug || x.project.startsWith(r.slug + '__'))) {
        for (const [m, b] of Object.entries(p.models)) {
          const k = family(m);
          fam[k].cost += b.costUSD || 0; fam[k].bf += b.backfilledCostUSD || 0;
          total.cost += b.costUSD || 0; total.bf += b.backfilledCostUSD || 0;
        }
      }
      perSlug.set(r.slug, { total, fam });
    }

    const totals = { tasks: 0, wt: 0, dirty: 0, loc: 0, projects: 0, total: { cost: 0, bf: 0 } as Money, fam: blankFam() };
    for (const r of rows) {
      if (r.error) continue;
      totals.projects++;
      totals.tasks += r.tasks?.total || 0;
      totals.wt += r.worktrees?.count || 0;
      totals.dirty += r.dirty || 0;
      totals.loc += r.size?.loc || 0;
      const ps = perSlug.get(r.slug)!;
      totals.total.cost += ps.total.cost; totals.total.bf += ps.total.bf;
      for (const f of families) { totals.fam[f].cost += ps.fam[f].cost; totals.fam[f].bf += ps.fam[f].bf; }
    }
    return { families, perSlug, totals };
  });

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
