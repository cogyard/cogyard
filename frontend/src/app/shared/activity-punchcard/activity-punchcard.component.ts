import { Component, input, computed, signal } from '@angular/core';
import { WeekStart } from '../../services/models';

// Punch card (task 064): weekday rows × hour-of-day columns, intensity = the
// owner's prompt counts — "when am I most active". Attention only (prompts),
// not labor. Row order honors the week-start preference; scaling is quartile
// (same idea as the heatmap) over nonzero cells.

interface PCell { count: number; level: number; title: string; }
interface PRow { day: string; cells: PCell[]; }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Hour label in the BROWSER's locale — "8 AM" for am/pm locales, "08" for
// 24-hour ones. No setting needed; the system already knows.
export function fmtHour(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
}

const WINDOWS = [
  { key: '7', label: 'Week', sub: 'past week' },
  { key: '28', label: 'Month', sub: 'past month' },
  { key: '91', label: '3 months', sub: 'past 3 months' },
  { key: '366', label: 'Year', sub: 'past year' },
];

@Component({
  selector: 'app-activity-punchcard',
  imports: [],
  templateUrl: './activity-punchcard.component.html',
  styleUrl: './activity-punchcard.component.scss',
})
export class ActivityPunchcardComponent {
  // window days ("7" | "28" | "91" | "366") → aggregated 7×24 matrix.
  matrices = input<Record<string, number[][]>>({});
  weekStart = input<WeekStart>('sunday');
  readonly windows = WINDOWS;
  window = signal('91');
  matrix = computed<number[][]>(() => this.matrices()[this.window()] ?? []);
  windowSub = computed(() => WINDOWS.find((w) => w.key === this.window())?.sub ?? '');
  // First hour on the axis (ui.dayStart) — people's days don't start at midnight.
  dayStart = input(0);

  // Axis labels every 4 columns, showing the ACTUAL hour after rotation.
  hourMarks = computed(() => [0, 4, 8, 12, 16, 20].map((slot) => ({ slot, label: fmtHour((this.dayStart() + slot) % 24) })));

  rows = computed<PRow[]>(() => {
    const m = this.matrix();
    if (!m.length) return [];
    const nonzero = m.flat().filter((n) => n > 0).sort((a, b) => a - b);
    const q = (p: number) => (nonzero.length ? nonzero[Math.min(nonzero.length - 1, Math.floor(p * nonzero.length))] : 1);
    const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)];
    const level = (n: number) => (n === 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4);
    const order = this.weekStart() === 'monday' ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    const start = this.dayStart();
    const hours = Array.from({ length: 24 }, (_, i) => (start + i) % 24);
    return order.map((d) => ({
      day: DAYS[d],
      cells: hours.map((h) => {
        const count = (m[d] || [])[h] || 0;
        return {
          count,
          level: level(count),
          title: `${DAYS[d]} ${fmtHour(h)}–${fmtHour((h + 1) % 24)} — ${count} prompt${count === 1 ? '' : 's'}`,
        };
      }),
    }));
  });

  total = computed(() => this.matrix().flat().reduce((a, b) => a + b, 0));

  // The single busiest (weekday, hour) — surfaced in the header.
  peak = computed(() => {
    const m = this.matrix();
    let best = { d: 0, h: 0, n: 0 };
    m.forEach((row, d) => row.forEach((n, h) => { if (n > best.n) best = { d, h, n }; }));
    return best.n ? `peak: ${DAYS[best.d]} ${fmtHour(best.h)}` : '';
  });
}
