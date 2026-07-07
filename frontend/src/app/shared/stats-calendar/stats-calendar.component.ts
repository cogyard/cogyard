import { Component, input, output, computed, signal } from '@angular/core';
import { WeekStart, ActivityDayCell } from '../../services/models';

// Month-grid calendar for the Stats tab — a real month view rendered
// ALONGSIDE the commits heatmap (not replacing it). Each day cell mixes three
// metrics the user asked to see together: machine cost ($, approx rendered
// distinctly), commit count, and a #NN badge per task that LANDED on the default
// branch that day. Hand-rolled grid (no calendar dep, like the heatmap/punchcard).
// Respects weekStart; prev/next nav; opens on the current month.

interface DayCell {
  date: string | null; // null = padding cell outside the month
  dom: number;
  costUSD: number;
  costApproxUSD: number;
  commits: number;
  taskIds: string[];
  today: boolean;
}

function dayKey(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(m + 1)}-${p(d)}`;
}

@Component({
  selector: 'app-stats-calendar',
  imports: [],
  templateUrl: './stats-calendar.component.html',
  styleUrl: './stats-calendar.component.scss',
})
export class StatsCalendarComponent {
  cost = input<Record<string, ActivityDayCell>>({});
  commits = input<Record<string, number>>({});
  merges = input<Record<string, string[]>>({});
  weekStart = input<WeekStart>('sunday');
  // A #NN badge click jumps to that task on the Tasks tab; a cell click opens
  // the same day drill-down the heatmap uses.
  taskClick = output<string>();
  dayClick = output<string>();

  // Month cursor — defaults to the current month.
  private cursor = signal<{ y: number; m: number }>(this.thisMonth());
  private thisMonth() { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; }

  monthLabel = computed(() =>
    new Date(this.cursor().y, this.cursor().m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }));

  weekdayLabels = computed<string[]>(() => {
    const base = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return this.weekStart() === 'monday' ? [...base.slice(1), base[0]] : base;
  });

  // Don't page past the current month — there's no future data.
  atCurrentMonth = computed(() => {
    const n = this.thisMonth();
    return this.cursor().y === n.y && this.cursor().m === n.m;
  });

  prevMonth() { this.cursor.update((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 })); }
  nextMonth() { if (!this.atCurrentMonth()) this.cursor.update((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 })); }
  goToday() { this.cursor.set(this.thisMonth()); }

  weeks = computed<DayCell[][]>(() => {
    const { y, m } = this.cursor();
    const cost = this.cost();
    const commits = this.commits();
    const merges = this.merges();
    const firstDow = new Date(y, m, 1).getDay(); // 0=Sun
    const lead = this.weekStart() === 'monday' ? (firstDow + 6) % 7 : firstDow;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const n = new Date();
    const todayKey = dayKey(n.getFullYear(), n.getMonth(), n.getDate());
    const pad = (): DayCell => ({ date: null, dom: 0, costUSD: 0, costApproxUSD: 0, commits: 0, taskIds: [], today: false });

    const cells: DayCell[] = [];
    for (let i = 0; i < lead; i++) cells.push(pad());
    for (let d = 1; d <= daysInMonth; d++) {
      const date = dayKey(y, m, d);
      const c = cost[date];
      cells.push({
        date, dom: d,
        costUSD: c?.costUSD ?? 0,
        costApproxUSD: c?.costApproxUSD ?? 0,
        commits: commits[date] ?? 0,
        taskIds: merges[date] ?? [],
        today: date === todayKey,
      });
    }
    while (cells.length % 7 !== 0) cells.push(pad());
    const weeks: DayCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  });

  // Whole-dollar formatting, matching the usage table + worktree cost cells.
  fmtCost(n: number): string {
    if (!n || n <= 0) return '';
    if (n < 0.5) return '<$1';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
}
