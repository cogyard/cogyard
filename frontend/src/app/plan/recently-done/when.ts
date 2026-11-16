import { RecentlyDoneTask } from '../../services/models';

// The Recently done strip's time groups (task 198), as a plain function so the
// week-start rule can be tested without a real Settings change.
//
//   Today · Yesterday · This week · Last week · 2 weeks ago · 3 weeks ago ·
//   then the month name (with the year when it isn't this year).
//
// `tasks` arrive newest first (core/recently-done.mjs); a group is a run of
// neighbours with the same label, so an empty group never appears. weekStart is
// Settings → "Activity week starts on" (ui.weekStart).
export interface WhenGroup { label: string; tasks: (RecentlyDoneTask & { note: string })[]; }

const DAY = 864e5;
const at = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };

export function groupByWhen(tasks: RecentlyDoneTask[], now: Date, weekStart: 'sunday' | 'monday'): WhenGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const first = weekStart === 'monday' ? 1 : 0;
  const weekOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() - first + 7) % 7));
  // Math.round: a daylight-saving change makes one "day" 23 or 25 hours.
  const label = (d: Date) => {
    const days = Math.round((today.getTime() - d.getTime()) / DAY);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const weeks = Math.round((weekOf(today).getTime() - weekOf(d).getTime()) / (7 * DAY));
    if (weeks === 0) return 'This week';
    if (weeks === 1) return 'Last week';
    if (weeks <= 3) return `${weeks} weeks ago`;
    return d.getFullYear() === today.getFullYear()
      ? d.toLocaleDateString('en-US', { month: 'long' })
      : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };
  const out: WhenGroup[] = [];
  for (const t of tasks) {
    const d = at(t.doneDate);
    const g = label(d);
    if (out.at(-1)?.label !== g) out.push({ label: g, tasks: [] });
    out.at(-1)!.tasks.push({ ...t, note: 'done ' + d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) });
  }
  return out;
}
