import { Component, input, output, inject, effect, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectButton } from 'primeng/selectbutton';
import { FlagComponent } from '../shared/flag/flag.component';
import { GitRefComponent } from '../shared/git-ref/git-ref.component';
import { TaskChipComponent } from '../shared/task-chip/task-chip.component';
import { Skeleton } from 'primeng/skeleton';
import { RefChipComponent, RefKind } from '../shared/ref-chip/ref-chip.component';
import { OriginLinkComponent } from '../shared/origin-link/origin-link.component';
import { GraphResponse, StoreFlag } from '../services/models';
import { StoreService } from '../services/store.service';
import { ApiService } from '../services/api.service';
import { MessageService } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';

const LW = 18, RH = 28, DOT = 4;
const COLORS = ['#60a5fa', '#4ade80', '#fb923c', '#f472b6', '#c084fc', '#38bdf8', '#fbbf24', '#f87171'];
const MAIN = '#111827';

interface Chip { kind: RefKind; text: string; }
interface Seg { from: number; to: number; half: string; color: number; main: boolean; wt?: boolean; stash?: boolean; }
interface Row {
  hash: string; shortHash: string; subject: string; author: string; date: string;
  col: number; onMain: boolean; segs: Seg[];
  chips: Chip[]; taskIds: string[]; cleanSubject: string;
  // working-tree pseudo-rows (kind === 'worktree'); hash is 'wt:<abs path>'
  // stash pseudo-rows (kind === 'stash'); hash is the stash ref (e.g. 'stash@{0}')
  kind?: 'worktree' | 'stash' | 'pending'; wtName?: string; branch?: string | null; dirtyCount?: number; isMain?: boolean;
  stashRef?: string; message?: string; base?: string;
  // Task store mode (task 191): each commit's rule flags; the flagged-only view's
  // count of clean commits hidden above a row; the pending row's file list.
  flags?: StoreFlag[]; hiddenBefore?: number; count?: number; files?: string[];
}

@Component({
  selector: 'app-graph',
  imports: [RefChipComponent, Skeleton, OriginLinkComponent, GitRefComponent, TaskChipComponent, FlagComponent, SelectButton, FormsModule, TooltipModule],
  templateUrl: './graph.component.html',
  styleUrl: './graph.component.scss',
})
export class GraphComponent {
  private store = inject(StoreService);
  private api = inject(ApiService);
  private messages = inject(MessageService);
  slug = input.required<string>();
  activeHash = input<string | null>(null);
  // The commit a link opened the graph FOR (?focus=, task 175): the API then
  // includes its history even when it is older than the newest-250 window.
  // Its own cache key, so the unfocused graph's cached rows never stand in for
  // a focused load that has not landed yet.
  focus = input<string | null>(null);
  // Task 191: show the project's TASK STORE instead of its code repo, and
  // optionally only the commits that broke the store rules. Both live in the
  // URL (?source=store&flagged=1), owned by the app shell.
  taskStore = input(false);
  flagged = input(false);
  setTaskStore = output<boolean>();
  setFlagged = output<boolean>();
  private key = computed(() => this.taskStore()
    ? `storegraph|${this.slug()}|${this.flagged() ? 'flagged' : 'all'}`
    : (this.focus() ? `graph|${this.slug()}|${this.focus()}` : `graph|${this.slug()}`));
  openCommit = output<string>();
  jumpBranch = output<string>();
  jumpWorktree = output<string>();
  jumpTask = output<string>();

  // The row currently open in the diff panel (commit hash or 'wt:<path>') — highlight it.
  // Prefix matching is for commits only (a short hash selects the full one). A
  // worktree lives INSIDE the main checkout, so 'wt:<main path>' is a prefix of
  // every worktree's 'wt:' value — selecting the main checkout would light up
  // every worktree row too. Any 'wt:' value on either side demands exact equality.
  isActive(r: Row) {
    const a = this.activeHash();
    if (!a) return false;
    if (a.startsWith('wt:') || r.hash.startsWith('wt:')) return r.hash === a;
    return r.hash.startsWith(a);
  }

  private cached = this.store.use<GraphResponse>(() => (this.slug() ? this.key() : null));
  rows = computed<Row[]>(() => (this.cached()?.rows || []).map((r: any) => this.toRow(r)));
  laneCount = computed(() => this.cached()?.laneCount ?? 0);
  originUrl = computed(() => this.cached()?.originUrl ?? null);
  loading = computed(() => this.cached() === null);
  // Store mode: the store's own facts (null = no separate store), how many
  // commits the last-30-days scan flagged, and how many clean ones sit below
  // the last flagged row.
  storeFacts = computed(() => this.cached()?.store ?? null);
  noStore = computed(() => this.taskStore() && this.cached() !== null && !this.cached()?.store);
  // Why there is no store (task 217): 'broken' / 'missing' = there are no
  // tasks to show at all; 'folder' = a stray folder where the link should be.
  linkState = computed(() => this.cached()?.link?.state ?? null);
  linkTarget = computed(() => this.cached()?.link?.target ?? null);
  sharedWith = computed(() => this.cached()?.sharedWith ?? []);
  hiddenAfter = computed(() => this.cached()?.hiddenAfter ?? 0);
  days = computed(() => this.cached()?.days ?? 30);
  readonly sourceOptions = [{ label: 'Code', value: false }, { label: 'Task store', value: true }];
  filterOptions = computed(() => [
    { label: 'All commits', value: false },
    { label: `Flagged only · ${this.cached()?.flaggedCount ?? '…'}`, value: true },
  ]);
  // The folder this view reads — the checkout, or the task store — for the
  // action bar's folder link. null when there is no store to show.
  folder = computed(() => this.cached()?.folder ?? null);
  // Reveal it in Finder through the existing open-target action (same-origin
  // POST /api/open, server-contained). `.` = the folder itself.
  revealFolder(path: string) {
    const req = this.taskStore()
      ? this.api.openTaskFile(this.slug(), '.', 'finder')
      : this.api.openFile(this.slug(), '.', 'finder');
    req.subscribe({
      error: (e) => this.messages.add({ severity: 'error', summary: 'Could not open folder', detail: e?.error?.error || path, life: 4000 }),
    });
  }
  plural(n: number, one: string, many: string) { return n === 1 ? one : many; }
  readonly RH = RH;

  constructor() {
    // When a commit is selected (e.g. arriving from the Branches tab), scroll its
    // row into the visible area ABOVE the bottom diff dock once rendered. Scroll
    // once per selection — a background refresh swapping rows() must not re-scroll.
    // A selection only counts as scrolled once the scroll has actually HAPPENED.
    // Being in rows() is not enough: a few hundred rows (a ?focus= load appends
    // past the window) can take longer to reach the DOM than any fixed delay,
    // and a lookup that found no row used to mark the selection done anyway, so
    // nothing ever retried. Now a bounded retry polls for the rendered row.
    effect(() => {
      const a = this.activeHash();
      const rows = this.rows();
      if (!a) { this.scrolledHash = null; return; }
      if (a === this.scrolledHash || a === this.scrollPending) return;
      if (!rows.some((r) => this.isActive(r))) return;
      this.scrollPending = a;
      this.tryScroll(a, 0);
    });
  }
  private scrolledHash: string | null = null;
  private scrollPending: string | null = null; // a retry loop is running for this selection
  private static readonly SCROLL_TRIES = 20;
  private static readonly SCROLL_EVERY_MS = 100;

  // Poll (up to SCROLL_TRIES x SCROLL_EVERY_MS) until the active row is in the
  // DOM AND sits above the dock, then mark the selection done. The check runs
  // again after each scroll, so a scroll that was clamped or interrupted (the
  // dock or the spacer still arriving) is re-issued instead of trusted. Stops
  // early if the selection changed. Gives up quietly: if the row was found it
  // still counts as done (a refresh must never re-scroll); if it never rendered,
  // the pending mark is cleared so the next rows() swap may try again.
  private tryScroll(a: string, n: number, found = false) {
    setTimeout(() => {
      if (this.activeHash() !== a) { if (this.scrollPending === a) this.scrollPending = null; return; }
      const st = this.scrollActiveIntoView();
      if (st === 'done') { this.scrolledHash = a; this.scrollPending = null; return; }
      const seen = found || st === 'scrolled';
      if (n + 1 < GraphComponent.SCROLL_TRIES) { this.tryScroll(a, n + 1, seen); return; }
      if (seen) this.scrolledHash = a;
      this.scrollPending = null;
    }, n === 0 ? 80 : GraphComponent.SCROLL_EVERY_MS);
  }

  // 'missing' = the active row is not in the DOM yet; 'scrolled' = a scroll
  // toward it was just issued; 'done' = it is in view above the dock, or main
  // is already where it would be scrolled to (nothing more to gain).
  private scrollActiveIntoView(): 'missing' | 'scrolled' | 'done' {
    const row = document.querySelector('.dag-row.active') as HTMLElement | null;
    const main = document.querySelector('main') as HTMLElement | null;
    if (!row || !main) return 'missing';
    // The dock is fixed to the viewport bottom. Its HEIGHT (not its top) is
    // read, because it may still be sliding in; its top is then derived from
    // the viewport, and only the part of main below that top is covered.
    const dock = document.querySelector('.cdock-drawer, .cdock') as HTMLElement | null;
    // A row is only scrolled to while a commit is open, so the dock IS open:
    // a not-yet-laid-out drawer (0 tall) falls back to its CSS height, 46vh.
    const dockH = (dock && dock.getBoundingClientRect().height) || window.innerHeight * 0.46;
    const r = row.getBoundingClientRect(), m = main.getBoundingClientRect();
    const covered = Math.max(0, Math.min(main.clientHeight, m.bottom - (window.innerHeight - dockH)));
    const visibleH = Math.max(120, main.clientHeight - covered); // area of main above the dock
    if (r.top - m.top > 40 && r.top - m.top < visibleH - r.height) return 'done'; // already comfortably visible
    const rowOffset = (r.top - m.top) + main.scrollTop;        // row position within main's scroll
    // Reachable for the LAST rows too (an appended ?focus= commit is always
    // last): the template's .dock-spacer gives main room to scroll them up.
    const maxTop = Math.max(0, main.scrollHeight - main.clientHeight);
    const target = Math.min(maxTop, Math.max(0, rowOffset - visibleH * 0.4));
    if (Math.abs(main.scrollTop - target) < 2) return 'done';
    main.scrollTo({ top: target, behavior: 'smooth' });
    return 'scrolled';
  }

  private toRow(r: any): Row {
    // Pseudo-rows have no commit subject to parse; a worktree row's taskIds come
    // from the checkout's claim (computed server-side), a stash row has none.
    if (r.kind === 'worktree') return { ...r, chips: [], taskIds: r.taskIds || [], cleanSubject: '' };
    if (r.kind === 'stash') return { ...r, chips: [], taskIds: [], cleanSubject: '' };
    if (r.kind === 'pending') return { ...r, chips: [], taskIds: [], cleanSubject: '' };
    // taskIds + cleanSubject are computed server-side (core/git-views parseTaskTags)
    // and served on the row — the SPA consumes them, never re-parses [#NN].
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
    // the trunk wears its own kind whichever side it is on — local, remote or both
    const m = (kind: RefKind, base: string): RefKind => (base === 'main' || base === 'master') ? 'main' : kind;
    // release tags lead — a milestone outranks branch pointers on the same commit
    for (const T of tags) out.push({ kind: 'tag', text: T });
    for (const L of locals) {
      if (remotes.has(L)) { out.push({ kind: m('synced', L), text: 'origin = ' + L }); used.add(L); }
      else out.push({ kind: m('local', L), text: L });
    }
    for (const R of remotes) if (!used.has(R)) out.push({ kind: m('remote', R), text: 'origin/' + R });
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
