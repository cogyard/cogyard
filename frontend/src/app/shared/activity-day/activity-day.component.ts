import { Component, input, output, inject, signal, computed, effect } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { ActivityDayResponse, ActivityDaySession } from '../../services/models';
import { fmtHour } from '../activity-punchcard/activity-punchcard.component';

// Single-day drill-down: the braid zoomed into one local day.
// Per session — YOUR prompt ticks (exact timestamps, the attention signal)
// over the agent's active hours (labor). Attention hops between lanes; labor
// genuinely overlaps, and the amber strip marks hours where ≥2 sessions ran
// at once. Approximated sessions (pruned transcripts) render as muted spans.

interface SessionRow {
  session: ActivityDaySession;
  label: string;
  color: string;
  blocks: { leftPct: number; widthPct: number }[]; // active hours (mined)
  ticks: { leftPct: number; title: string }[];     // prompt timestamps
  span: { leftPct: number; widthPct: number } | null; // approx fallback
}

@Component({
  selector: 'app-activity-day',
  imports: [],
  templateUrl: './activity-day.component.html',
  styleUrl: './activity-day.component.scss',
  // Escape closes the drill-down, matching its close button. Guarded
  // on an open date so it's a no-op when nothing is showing.
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class ActivityDayComponent {
  date = input<string | null>(null);
  colors = input<Record<string, string>>({});
  // Project order from the braid (projectRank) so the drill-down lanes match it.
  order = input<string[]>([]);
  // When set, the view scopes to one project (the per-project Stats tab).
  project = input<string | null>(null);
  closed = output<void>();

  private api = inject(ApiService);
  data = signal<ActivityDayResponse | null>(null);
  loading = signal(false);

  constructor() {
    effect(() => {
      const d = this.date();
      this.data.set(null);
      if (!d) return;
      this.loading.set(true);
      this.api.activityDay(d).subscribe({
        next: (r) => { this.data.set(r); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
    });
  }

  readonly hourMarks = [0, 4, 8, 12, 16, 20, 24].map((h) => ({ h, label: h === 24 ? fmtHour(0) : fmtHour(h) }));

  // Fraction of the local day [0..1] for an ISO timestamp.
  private dayFrac(ts: string): number {
    const d = new Date(ts);
    return (d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600) / 24;
  }
  // A UTC hour bucket ("2026-07-02T14") → its local start hour on this day.
  private localHour(k: string): number { return new Date(k + ':00:00.000Z').getHours(); }

  title = computed(() => {
    const d = this.date();
    if (!d) return '';
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  });

  // The day's sessions, scoped to the project filter when one is set.
  private sessions = computed<ActivityDaySession[]>(() => {
    const r = this.data();
    if (!r) return [];
    const p = this.project();
    return p ? r.sessions.filter((s) => s.project === p) : r.sessions;
  });

  summary = computed(() => {
    if (!this.data()) return '';
    const sessions = this.sessions();
    const projects = new Set(sessions.map((s) => s.project));
    const prompts = sessions.reduce((n, s) => n + s.prompts.length, 0);
    const cost = sessions.reduce((n, s) => n + s.costUSD, 0);
    const scope = this.project() ? '' : ` · ${projects.size} projects`;
    return `${sessions.length} sessions${scope} · ${prompts} prompts · $${cost.toFixed(2)}`;
  });

  rows = computed<SessionRow[]>(() => {
    const r = this.data();
    const date = this.date();
    if (!r || !date) return [];
    const colors = this.colors();
    // Match the braid's lane order (projectRank), then chronological within a
    // project. The server returns alphabetical; the braid order wins here.
    const rank = this.order();
    const pos = (p: string) => { const i = rank.indexOf(p); return i === -1 ? rank.length : i; };
    const startOf = (s: ActivityDaySession) => {
      const hs = Object.keys(s.hours).sort();
      return hs.length ? hs[0] : (s.firstTs || '');
    };
    const sessions = [...this.sessions()].sort((a, b) => pos(a.project) - pos(b.project) || startOf(a).localeCompare(startOf(b)));
    return sessions.map((s) => {
      const color = colors[s.project] || 'var(--app-fg-muted)';
      const hours = Object.keys(s.hours).map((k) => this.localHour(k)).sort((a, b) => a - b);
      // Coalesce consecutive active hours into blocks.
      const blocks: { leftPct: number; widthPct: number }[] = [];
      for (const h of hours) {
        const last = blocks[blocks.length - 1];
        if (last && Math.round((last.leftPct + last.widthPct) / (100 / 24)) === h) last.widthPct += 100 / 24;
        else blocks.push({ leftPct: h * (100 / 24), widthPct: 100 / 24 });
      }
      const ticks = s.prompts.map((ts) => ({
        leftPct: this.dayFrac(ts) * 100,
        title: new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      }));
      let span: SessionRow['span'] = null;
      if (s.approx && s.firstTs && s.lastTs) {
        const from = new Date(s.firstTs) < new Date(date + 'T00:00:00') ? 0 : this.dayFrac(s.firstTs);
        const to = new Date(s.lastTs) > new Date(date + 'T23:59:59') ? 1 : this.dayFrac(s.lastTs);
        span = { leftPct: from * 100, widthPct: Math.max((to - from) * 100, 0.5) };
      }
      const base = s.worktree && s.worktree !== s.project ? `${s.project} · ${s.worktree}` : s.project;
      const tasks = (s.taskIds || []).map((id) => '#' + id).join(' ');
      return {
        session: s,
        label: tasks ? `${base} · ${tasks}` : base,
        color, blocks, ticks, span,
      };
    });
  });

  // Hours (local 0..23) where ≥2 sessions had mined activity — parallel labor.
  parallel = computed<boolean[]>(() => {
    const out = Array(24).fill(0);
    if (!this.data()) return out.map(() => false);
    for (const s of this.sessions()) {
      const seen = new Set<number>();
      for (const k of Object.keys(s.hours)) seen.add(this.localHour(k));
      for (const h of seen) out[h]++;
    }
    return out.map((n) => n >= 2);
  });

  hasParallel = computed(() => this.parallel().some(Boolean));

  onEscape() { if (this.date()) this.closed.emit(); }
}
