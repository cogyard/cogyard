import { Component, input, output, inject, effect, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { Tag } from 'primeng/tag';
import { OriginLinkComponent } from '../shared/origin-link/origin-link.component';
import { ApiService } from '../services/api.service';
import { GraphResponse } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';

const LW = 18, RH = 28, DOT = 4;
const COLORS = ['#60a5fa', '#4ade80', '#fb923c', '#f472b6', '#c084fc', '#38bdf8', '#fbbf24', '#f87171'];
const MAIN = '#111827';

interface Chip { cls: string; text: string; }
interface Seg { from: number; to: number; half: string; color: number; main: boolean; wt?: boolean; stash?: boolean; }
interface Row {
  hash: string; shortHash: string; subject: string; author: string; date: string;
  col: number; onMain: boolean; segs: Seg[];
  chips: Chip[]; taskIds: string[]; cleanSubject: string;
  // working-tree pseudo-rows (kind === 'worktree'); hash is 'wt:<abs path>'
  // stash pseudo-rows (kind === 'stash'); hash is the stash ref (e.g. 'stash@{0}')
  kind?: 'worktree' | 'stash'; wtName?: string; branch?: string | null; dirtyCount?: number; isMain?: boolean;
  stashRef?: string; message?: string; base?: string;
}

@Component({
  selector: 'app-graph',
  imports: [Tag, Skeleton, OriginLinkComponent],
  templateUrl: './graph.component.html',
  styleUrl: './graph.component.scss',
})
export class GraphComponent {
  private api = inject(ApiService);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  slug = input.required<string>();
  activeHash = input<string | null>(null);
  openCommit = output<string>();
  jumpTask = output<string>();

  // The row currently open in the diff panel (commit hash or 'wt:<path>') — highlight it.
  isActive(r: Row) { const a = this.activeHash(); return !!a && r.hash.startsWith(a); }

  private cached = computed(() => this.store.sig<GraphResponse>(`graph|${this.slug()}`)());
  rows = computed<Row[]>(() => (this.cached()?.rows || []).map((r: any) => this.toRow(r)));
  laneCount = computed(() => this.cached()?.laneCount ?? 0);
  originUrl = computed(() => this.cached()?.originUrl ?? null);
  loading = computed(() => this.cached() === null);
  readonly RH = RH;

  constructor() {
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`graph|${s}`, this.api.graph(s));
    });
    // When a commit is selected (e.g. arriving from the Branches tab), scroll its
    // row into the visible area ABOVE the bottom diff dock once rendered. Scroll
    // once per selection — a background refresh swapping rows() must not re-scroll.
    effect(() => {
      const a = this.activeHash();
      this.rows();
      if (a && a !== this.scrolledHash) {
        this.scrolledHash = a;
        setTimeout(() => this.scrollActiveIntoView(), 80);
      }
      if (!a) this.scrolledHash = null;
    });
  }
  private scrolledHash: string | null = null;

  private scrollActiveIntoView() {
    const row = document.querySelector('.dag-row.active') as HTMLElement | null;
    const main = document.querySelector('main') as HTMLElement | null;
    if (!row || !main) return;
    const dock = document.querySelector('.cdock') as HTMLElement | null;
    const dockH = dock ? dock.getBoundingClientRect().height : window.innerHeight * 0.46;
    const visibleH = Math.max(120, main.clientHeight - dockH); // area not covered by the dock
    const r = row.getBoundingClientRect(), m = main.getBoundingClientRect();
    const rowOffset = (r.top - m.top) + main.scrollTop;        // row position within main's scroll
    if (r.top - m.top > 40 && r.top - m.top < visibleH - r.height) return; // already comfortably visible
    main.scrollTo({ top: Math.max(0, rowOffset - visibleH * 0.4), behavior: 'smooth' });
  }

  private toRow(r: any): Row {
    if (r.kind === 'worktree' || r.kind === 'stash') return { ...r, chips: [], taskIds: [], cleanSubject: '' };
    // taskIds + cleanSubject are computed server-side (core/git-views parseTaskTags)
    // and served on the row — the SPA consumes them, never re-parses [#NN] (task 47).
    return { ...r, chips: this.chips(r.refs || []), taskIds: r.taskIds ?? [], cleanSubject: r.cleanSubject ?? '' };
  }

  // Collapse local X + origin/X (same commit) into one "origin = X" chip.
  private chips(refs: string[]): Chip[] {
    const locals: string[] = [], remotes = new Set<string>(), tags: string[] = [];
    for (const r of refs) {
      if (r.startsWith('tag: ')) tags.push(r.slice(5));
      else if (r === 'origin/HEAD') continue;
      else if (r.startsWith('origin/')) remotes.add(r.slice(7));
      else locals.push(r);
    }
    const out: Chip[] = [], used = new Set<string>();
    const m = (name: string, base: string) => (base === 'main' || base === 'master') ? name + ' main-ref' : name;
    for (const L of locals) {
      if (remotes.has(L)) { out.push({ cls: m('synced', L), text: 'origin = ' + L }); used.add(L); }
      else out.push({ cls: m('local', L), text: L });
    }
    for (const R of remotes) if (!used.has(R)) out.push({ cls: m('remote', R), text: 'origin/' + R });
    for (const T of tags) out.push({ cls: 'tag', text: T });
    return out;
  }

  graphW(r: Row) { return Math.max(this.laneCount(), r.col + 1) * LW; }
  x(col: number) { return col * LW + LW / 2; }
  segColor(s: Seg) { return s.main ? MAIN : COLORS[s.color % COLORS.length]; }
  dotColor(r: Row) { return r.onMain ? MAIN : COLORS[r.col % COLORS.length]; }
  segPath(s: Seg) {
    const x1 = this.x(s.from), x2 = this.x(s.to);
    if (s.half === 'full') return `M${x1},0 C${x1},${RH / 2} ${x2},${RH / 2} ${x2},${RH}`;
    if (s.half === 'top') return `M${x1},0 C${x1},${RH / 4} ${x2},${RH / 4} ${x2},${RH / 2}`;
    return `M${x1},${RH / 2} C${x1},${RH * 0.75} ${x2},${RH * 0.75} ${x2},${RH}`;
  }
}
