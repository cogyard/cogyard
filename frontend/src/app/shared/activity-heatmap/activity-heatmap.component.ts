import { Component, input, output, computed, viewChild, ElementRef, afterNextRender } from '@angular/core';
import { WeekStart } from '../../services/models';

// GitHub-style contribution heatmap: 7 rows (Sun..Sat) × N week
// columns ending today, intensity = commits that local day. Pure presentation —
// the parent hands in per-day counts (one project's, or the ALL aggregate with
// a per-project breakdown for the tooltip).
//
// A day's value need not be a commit count: pass `valueLabel` to render the
// value INSIDE each cell (e.g. a dollar figure) and `titleFmt` to format the
// value everywhere text appears (header total, tooltip, per-project split).
// Both default off, so the commits heatmap renders exactly as before.

interface Cell { date: string; count: number; level: number; title: string; label: string; }
interface Week { cells: (Cell | null)[]; month: string | null; }

function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

@Component({
  selector: 'app-activity-heatmap',
  imports: [],
  templateUrl: './activity-heatmap.component.html',
  styleUrl: './activity-heatmap.component.scss',
})
export class ActivityHeatmapComponent {
  byDay = input<Record<string, number>>({});
  // date → slug → count; when present, tooltips list the per-project split.
  breakdown = input<Record<string, Record<string, number>> | null>(null);
  weeks = input(52);
  noun = input('commits');
  weekStart = input<WeekStart>('sunday');
  // In-cell value formatter. When set, each nonzero cell shows this string
  // (e.g. "$142", "1k"); when null, cells are colour-only (commits mode).
  valueLabel = input<((n: number) => string) | null>(null);
  // Value formatter for text surfaces (header total, tooltip, per-project
  // split). When null, those read "<count> <noun>" as before.
  titleFmt = input<((n: number) => string) | null>(null);
  // Clicking a day emits its date — consumers open a day-detail view.
  dayClick = output<string>();

  // The horizontally-scrolling grid opens pinned to today (the right edge)
  // instead of the oldest week, so the user isn't scrolling to "now" every
  // time. One-time on mount: the grid always spans a fixed `weeks` columns, so
  // its width is stable and later data loads don't move the scroll position.
  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  constructor() {
    afterNextRender(() => {
      const el = this.scroller()?.nativeElement;
      if (el) el.scrollLeft = el.scrollWidth;
    });
  }

  // Row index of a date under the chosen week start.
  private rowIdx(d: Date): number { return this.weekStart() === 'monday' ? (d.getDay() + 6) % 7 : d.getDay(); }
  // Mon/Wed/Fri gutter labels land on different rows per week start.
  dayLabels = computed<string[]>(() => this.weekStart() === 'monday'
    ? ['Mon', '', 'Wed', '', 'Fri', '', '']
    : ['', 'Mon', '', 'Wed', '', 'Fri', '']);

  total = computed(() => Object.values(this.byDay()).reduce((a, b) => a + b, 0));

  // Header total: formatted value when a titleFmt is supplied, else "<n> <noun>".
  headerText = computed(() => {
    const t = this.total();
    const f = this.titleFmt();
    return f ? f(t) : `${t.toLocaleString()} ${this.noun()}`;
  });

  grid = computed<Week[]>(() => {
    const byDay = this.byDay();
    const breakdown = this.breakdown();
    const noun = this.noun();
    const vlabel = this.valueLabel();
    const tfmt = this.titleFmt();
    // GitHub-style quartile scaling: thresholds come from the quartiles of THIS
    // dataset's nonzero days, so only ~the top quarter of days render darkest —
    // a fixed scale saturates dark under heavy (agent-era) commit volumes.
    const nonzero = Object.values(byDay).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (p: number) => (nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] : 1);
    const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)];
    const level = (n: number) => (n === 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    // Window back `weeks` from today, but don't render empty columns before the
    // first day that has data — a new/sparse dataset (e.g. cost, which only
    // begins when session mining started) would otherwise open on months of
    // blank cells. Clamp the start forward to the week of the earliest data day.
    const start = new Date(end);
    start.setDate(start.getDate() - (this.weeks() * 7 - 1) - this.rowIdx(end));
    const dataDays = Object.keys(byDay).filter((d) => byDay[d] > 0).sort();
    if (dataDays.length) {
      const [y, m, d] = dataDays[0].split('-').map(Number);
      const firstWeek = new Date(y, m - 1, d);
      firstWeek.setDate(firstWeek.getDate() - this.rowIdx(firstWeek));
      if (firstWeek > start) start.setTime(firstWeek.getTime());
    }
    const weeks: Week[] = [];
    let lastMonth = -1;
    let lastLabelWeek = -9; // suppress labels closer than 3 weeks (they collide)
    const cur = new Date(start);
    while (cur <= end) {
      const cells: (Cell | null)[] = [];
      let month: string | null = null;
      for (let d = 0; d < 7; d++) {
        if (cur > end) { cells.push(null); continue; }
        if (d === 0 && cur.getMonth() !== lastMonth) {
          if (weeks.length - lastLabelWeek >= 3) {
            month = cur.toLocaleString('en-US', { month: 'short' });
            lastLabelWeek = weeks.length;
          }
          lastMonth = cur.getMonth();
        }
        const date = dayKey(cur);
        const count = byDay[date] || 0;
        let title = tfmt ? `${date} — ${tfmt(count)}` : `${date} — ${count} ${noun}`;
        const split = breakdown ? breakdown[date] : null;
        if (count && split) {
          const parts = Object.entries(split).filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1]).map(([s, n]) => (tfmt ? `${s} ${tfmt(n)}` : `${s} ${n}`));
          if (parts.length) title += ` (${parts.join(' · ')})`;
        }
        const label = vlabel && count > 0 ? vlabel(count) : '';
        cells.push({ date, count, level: level(count), title, label });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push({ cells, month });
    }
    return weeks;
  });
}
