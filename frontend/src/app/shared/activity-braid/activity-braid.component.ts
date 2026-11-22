import { Component, input, output, computed, signal, effect, ElementRef, viewChild } from '@angular/core';
import { ActivityResponse, ActivityDayCell } from '../../services/models';

// The intertwine braid (a "lasagna plot"): one lane per project on a
// shared day axis, cell shade = that day's metric — attention (the user's
// prompt minutes, mined) or cost (machine spend). A breadth strip below counts
// projects active per day. Clicking a day emits it for the drill-down.
// Cost cells that are wholly/partly APPROXIMATED (pruned transcripts, even
// day-spread) render hatched so estimated eras don't masquerade as mined ones.
//
// The metric is an input, with no switch (task 266): the All page shows it in
// attention on its Attention tab and in cost on its Costs tab. It once had an
// Attention | Cost toggle, back when one braid served both questions.

export type BraidMetric = 'attention' | 'cost';
type Metric = BraidMetric;
const MAX_LANES = 10;

interface BraidCell { date: string; level: number; approx: boolean; title: string; }
interface Lane { slug: string; title: string; color: string; cells: BraidCell[]; }

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Stable, metric-INDEPENDENT project ranking (total attention, cost as
// tiebreak). Both the lane order and the lane colors derive from it, so the
// attention braid and the cost braid put every project in the same row with
// the same colour and only shade the cells differently — that's what makes the
// two metrics visually comparable. Shared with the day drill-down so its
// session order and colors match the braid.
export function projectRank(a: ActivityResponse): string[] {
  return Object.entries(a.projects).map(([slug, p]) => {
    let att = 0, cost = 0;
    for (const c of Object.values(p.days)) { att += c.attentionMin; cost += c.costUSD + c.costApproxUSD; }
    return { slug, att, cost };
  }).sort((x, y) => y.att - x.att || y.cost - x.cost).map((x) => x.slug);
}
export function projectColors(a: ActivityResponse): Record<string, string> {
  const out: Record<string, string> = {};
  projectRank(a).forEach((slug, i) => { out[slug] = `var(--app-cat-${(i % 8) + 1})`; });
  return out;
}

@Component({
  selector: 'app-activity-braid',
  imports: [],
  templateUrl: './activity-braid.component.html',
  styleUrl: './activity-braid.component.scss',
})
export class ActivityBraidComponent {
  activity = input<ActivityResponse | null>(null);
  selectedDay = input<string | null>(null);
  metric = input<Metric>('attention');
  dayClick = output<string>();

  // "(N more)" fold, expandable on click.
  expanded = signal(false);
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // Newest days sit at the right edge — start there.
    effect(() => {
      this.lanes();
      const el = this.scroller()?.nativeElement;
      if (el) queueMicrotask(() => { el.scrollLeft = el.scrollWidth; });
    });
  }

  // All local days from the rollup's window start (first day with any data)
  // through today.
  days = computed<string[]>(() => {
    const a = this.activity();
    if (!a) return [];
    let first: string | null = null;
    for (const p of Object.values(a.projects)) {
      for (const d of Object.keys(p.days)) if (!first || d < first) first = d;
    }
    if (!first) return [];
    const out: string[] = [];
    const cur = new Date(first + 'T12:00:00');
    const today = dayKey(new Date());
    while (dayKey(cur) <= today) { out.push(dayKey(cur)); cur.setDate(cur.getDate() + 1); }
    return out;
  });

  // Fixed, interpretable intensity steps (not data-normalized): attention in
  // minutes, cost in dollars.
  private level(metric: Metric, cell: ActivityDayCell): number {
    if (metric === 'attention') {
      const m = cell.attentionMin;
      return m <= 0 ? 0 : m < 15 ? 1 : m < 60 ? 2 : m < 180 ? 3 : 4;
    }
    const c = cell.costUSD + cell.costApproxUSD;
    return c <= 0 ? 0 : c < 2 ? 1 : c < 10 ? 2 : c < 40 ? 3 : 4;
  }

  // The number of folded-away projects (for the "(N more)" affordance).
  foldedCount = computed(() => Math.max(projectRank(this.activity() ?? { projects: {} } as ActivityResponse).length - MAX_LANES, 0));

  lanes = computed<Lane[]>(() => {
    const a = this.activity();
    if (!a) return [];
    const metric = this.metric();
    const days = this.days();
    // Metric-independent order: a project has the same row in either metric.
    const rank = projectRank(a);
    const colors = projectColors(a);
    const top = this.expanded() ? rank : rank.slice(0, MAX_LANES);
    const rest = this.expanded() ? [] : rank.slice(MAX_LANES);
    const laneDefs = top.map((x) => ({ slug: x, members: [x], color: colors[x] }));
    if (rest.length) laneDefs.push({ slug: `(${rest.length} more)`, members: rest, color: 'var(--app-fg-muted)' });

    // A folded lane (task 130) says on hover what it is made of.
    const folded = (slug: string) => {
      const l = a.lanes?.[slug];
      if (!l) return slug;
      const what = l.kind === 'jobs' ? "cogyard's own scheduled agent calls — cost only, never attention" : 'sessions run outside every registered project';
      return `${slug}: ${what}\n${l.members.join(', ')}`;
    };
    return laneDefs.map((def) => ({
      slug: def.slug,
      title: folded(def.slug),
      color: def.color,
      cells: days.map((date) => {
        let attentionMin = 0, prompts = 0, costUSD = 0, costApproxUSD = 0;
        for (const m of def.members) {
          const c = a.projects[m]?.days[date];
          if (!c) continue;
          attentionMin += c.attentionMin; prompts += c.prompts; costUSD += c.costUSD; costApproxUSD += c.costApproxUSD;
        }
        const cell = { attentionMin, prompts, costUSD, costApproxUSD };
        const approx = metric === 'cost' && costApproxUSD > 0;
        const title = metric === 'attention'
          ? `${def.slug} · ${date} — ${Math.round(attentionMin)} min attention, ${prompts} prompts`
          : `${def.slug} · ${date} — $${(costUSD + costApproxUSD).toFixed(2)}${approx ? ' (≈ estimated)' : ''}`;
        return { date, level: this.level(metric, cell), approx, title };
      }),
    }));
  });

  // Breadth: how many projects (lanes' members included) were active each day.
  breadth = computed<{ date: string; count: number }[]>(() => {
    const a = this.activity();
    if (!a) return [];
    const metric = this.metric();
    return this.days().map((date) => {
      let count = 0;
      for (const p of Object.values(a.projects)) {
        const c = p.days[date];
        if (c && (metric === 'attention' ? c.attentionMin > 0 : c.costUSD + c.costApproxUSD > 0)) count++;
      }
      return { date, count };
    });
  });

  // The header's tooltip: how the lanes are ordered, then what this braid's
  // metric measures — the explanation the Attention and Cost switch buttons
  // carried before the switch went.
  metricTitle = computed(() => 'Lane order = total attention (descending), cost as tiebreak — the same in the attention and the cost braid, so a project keeps its row and its colour on both. Colors follow the ranking, so a project keeps its color everywhere.\n'
    + (this.metric() === 'attention'
      ? 'Attention: your own prompts, gap-coalesced into engaged minutes (a floor: reading without prompting leaves no signal).'
      : "Cost: machine effort — each session's locked-in cost, spread across days by mined per-hour activity; hatched = estimated (transcript pruned before mining)."));

  toggleExpand() { this.expanded.update((v) => !v); }
  isFoldLane(slug: string) { return slug.endsWith(' more)'); }
}
