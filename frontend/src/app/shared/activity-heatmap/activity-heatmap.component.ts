import { Component, input, output, computed } from '@angular/core';
import { WeekStart } from '../../services/models';

// GitHub-style contribution heatmap (task 064): 7 rows (Sun..Sat) × N week
// columns ending today, intensity = commits that local day. Pure presentation —
// the parent hands in per-day counts (one project's, or the ALL aggregate with
// a per-project breakdown for the tooltip).

interface Cell { date: string; count: number; level: number; title: string; }
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
  // Clicking a day emits its date — consumers open a day-detail view.
  dayClick = output<string>();

  // Row index of a date under the chosen week start.
  private rowIdx(d: Date): number { return this.weekStart() === 'monday' ? (d.getDay() + 6) % 7 : d.getDay(); }
  // Mon/Wed/Fri gutter labels land on different rows per week start.
  dayLabels = computed<string[]>(() => this.weekStart() === 'monday'
    ? ['Mon', '', 'Wed', '', 'Fri', '', '']
    : ['', 'Mon', '', 'Wed', '', 'Fri', '']);

  total = computed(() => Object.values(this.byDay()).reduce((a, b) => a + b, 0));

  grid = computed<Week[]>(() => {
    const byDay = this.byDay();
    const breakdown = this.breakdown();
    const noun = this.noun();
    // GitHub-style quartile scaling: thresholds come from the quartiles of THIS
    // dataset's nonzero days, so only ~the top quarter of days render darkest —
    // a fixed scale saturates dark under heavy (agent-era) commit volumes.
    const nonzero = Object.values(byDay).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (p: number) => (nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] : 1);
    const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)];
    const level = (n: number) => (n === 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end);
    start.setDate(start.getDate() - (this.weeks() * 7 - 1) - this.rowIdx(end));
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
        let title = `${date} — ${count} ${noun}`;
        const split = breakdown ? breakdown[date] : null;
        if (count && split) {
          const parts = Object.entries(split).filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`);
          if (parts.length) title += ` (${parts.join(' · ')})`;
        }
        cells.push({ date, count, level: level(count), title });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push({ cells, month });
    }
    return weeks;
  });
}
