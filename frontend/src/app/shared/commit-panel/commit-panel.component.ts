import { Component, input, output, inject, effect, signal, computed } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';
import { GitRefComponent } from '../git-ref/git-ref.component';
import { Skeleton } from 'primeng/skeleton';
import { FormsModule } from '@angular/forms';
import { FlagComponent, FlagTone } from '../flag/flag.component';
import { GitStatusComponent } from '../git-status/git-status.component';
import { SelectButton } from 'primeng/selectbutton';
import { ToggleButton } from 'primeng/togglebutton';
import { Drawer } from 'primeng/drawer';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { CommitDetail, StatusResponse, ChangeFile, StoreFileClass } from '../../services/models';
import { DiffViewComponent } from '../diff-view/diff-view.component';
import { FileActionsComponent } from '../file-actions/file-actions.component';

// from = a renamed file's old path, sent with the diff request so git pairs
// the two paths instead of showing the whole file as added (task 224).
interface Sel { path: string; kind?: string; from?: string; }
interface FileGroup { title: string; kind: string; list: ChangeFile[]; }

@Component({
  selector: 'app-commit-panel',
  imports: [DiffViewComponent, FileActionsComponent, FormsModule, FlagComponent, GitStatusComponent, SelectButton, ToggleButton, Skeleton, Drawer, GitRefComponent, NgTemplateOutlet, TooltipModule],
  templateUrl: './commit-panel.component.html',
  styleUrl: './commit-panel.component.scss',
  host: { '(document:keydown.escape)': 'onEsc()' },
})
export class CommitPanelComponent {
  private api = inject(ApiService);
  private messages = inject(MessageService);
  slug = input.required<string>();
  // A commit hash, or 'wt:<abs path>' for a checkout's uncommitted-changes view.
  hash = input<string | null>(null);
  close = output<void>();
  jumpBranch = output<string>();
  jumpWorktree = output<string>();
  // The hash belongs to the project's TASK STORE, not its code repo (task 191 —
  // the Graph tab's store view). Every read then carries source=store, the
  // files come grouped by what they are, and nothing offers to change them:
  // the store view is read-only. The uncommitted row's hash is 'wt:store'.
  taskStore = input(false);

  isWorktree = computed(() => (this.hash() ?? '').startsWith('wt:'));
  // Which checkout: the path carried in the hash; null = main checkout (and
  // always null for the store, which has one working tree).
  wtPath = computed(() => (this.isWorktree() && !this.taskStore() ? this.hash()!.slice(3) : null));
  wtName = computed(() => { const p = this.wtPath(); return p ? p.split('/').pop() ?? null : null; });
  detail = signal<CommitDetail | null>(null);     // commit mode
  status = signal<StatusResponse | null>(null);   // worktree mode
  loading = signal(false);

  selected = signal<Sel | null>(null);
  mode = signal<'split' | 'unified'>('split');
  readonly modeOptions = [
    { label: 'Unified', value: 'unified' },
    { label: 'Side by side', value: 'split' },
  ];
  ignoreWs = signal(false);
  private patches = signal<Map<string, string>>(new Map());
  private diffLoading = signal(false);

  // Worktree file groups (staged / unstaged / untracked), non-empty only.
  groups = computed<FileGroup[]>(() => {
    const s = this.status();
    if (!s) return [];
    return [
      { title: 'Staged', kind: 'staged', list: s.staged },
      { title: 'Unstaged', kind: 'unstaged', list: s.unstaged },
      { title: 'Untracked', kind: 'untracked', list: s.untracked },
    ].filter((g) => g.list.length);
  });

  // Store mode (task 191): the commit's files split by what they are — the
  // server classed each one (core/store-audit.mjs); nothing is re-derived here.
  storeGroups = computed(() => {
    const a = this.detail()?.audit;
    if (!this.taskStore() || !a) return null;
    const inStore = (c: StoreFileClass) => c === 'task' || c === 'attachment' || c === 'index' || c === 'allowed';
    return [
      { title: 'Task files', list: a.files.filter((f) => inStore(f.cls)) },
      { title: 'Not task files', list: a.files.filter((f) => !inStore(f.cls)) },
    ].filter((g) => g.list.length);
  });
  // Store mode, uncommitted view: each path's class, from /api/status's audit.
  private pendingCls = computed(() => new Map((this.status()?.audit?.files ?? []).map((f) => [f.path, f.cls])));
  pendingClsOf(path: string): StoreFileClass | null { return this.pendingCls().get(path) ?? null; }
  // The chip a non-task file wears. Committed job output is a mistake (bad);
  // uncommitted job output is expected until task 187 moves it (warn).
  clsFlag(cls: StoreFileClass | null, pending = false): { tone: FlagTone; text: string } | null {
    if (cls === 'job') return { tone: pending ? 'warn' : 'bad', text: 'job output' };
    if (cls === 'other') return { tone: 'bad', text: 'not a task file' };
    return null;
  }

  patch = computed(() => {
    const sel = this.selected();
    return sel ? (this.patches().get(this.key(sel)) ?? '') : '';
  });
  isDiffLoading = computed(() => this.diffLoading());

  constructor() {
    // onCleanup unsubscribes the prior request before the next hash change fires,
    // so HttpClient CANCELS the superseded XHR — fixes (a) out-of-order responses
    // painting the wrong commit and (b) rapid clicks clogging the connection pool
    // (the "shows up slowly" symptom). Both subscriptions carry an error handler
    // that clears `loading`; without it a transient failure (e.g. the API mid-
    // restart) left the panel stuck on the skeleton forever — the "not at all".
    effect((onCleanup) => {
      const h = this.hash();
      const slug = this.slug();
      const store = this.taskStore();
      this.selected.set(null);
      this.patches.set(new Map());
      this.detail.set(null);
      this.status.set(null);
      if (!h) return;
      this.loading.set(true);
      const sub = h.startsWith('wt:')
        ? this.api.status(slug, store ? null : h.slice(3), store).subscribe({
            next: (s) => {
              this.status.set(s);
              this.loading.set(false);
              const g = [s.staged.map((f) => ['staged', f] as const), s.unstaged.map((f) => ['unstaged', f] as const), s.untracked.map((f) => ['untracked', f] as const)].flat();
              if (g.length) this.selectFile(g[0][1].path, g[0][0], g[0][1].oldPath);
            },
            error: () => this.loading.set(false),
          })
        : this.api.commit(slug, h, store).subscribe({
            next: (d) => {
              this.detail.set(d);
              this.loading.set(false);
              if (d.files?.length) this.selectFile(d.files[0].path, undefined, d.files[0].oldPath);
            },
            error: () => this.loading.set(false),
          });
      onCleanup(() => sub.unsubscribe());
    });
  }

  private key(sel: Sel) { return `${sel.kind ?? ''} ${sel.path} ${this.ignoreWs() ? 'w' : ''}`; }
  onEsc() { if (this.hash()) this.close.emit(); }
  dirOf(path: string) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(0, i + 1) : ''; }
  baseOf(path: string) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(i + 1) : path; }
  dirParts(path: string) { return this.dirOf(path).match(/[^/]*\//g) ?? []; }
  isSelected(path: string, kind?: string) { const s = this.selected(); return !!s && s.path === path && s.kind === kind; }
  // A rename's old path for its "from" line, minus the leading folders it
  // shares with the new path: docs/a/x.md → docs/b/x.md reads "from a/x.md".
  fromLabel(path: string, oldPath: string) {
    const a = oldPath.split('/'), b = path.split('/');
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    return a.slice(i).join('/');
  }

  selectFile(path: string, kind?: string, from?: string) {
    this.selected.set({ path, kind, from });
    this.fetch({ path, kind, from });
  }
  toggleWs() {
    this.ignoreWs.update((v) => !v);
    const s = this.selected();
    if (s) this.fetch(s);
  }
  setMode(m: 'split' | 'unified') { this.mode.set(m); }

  private fetch(sel: Sel) {
    const h = this.hash();
    if (!h) return;
    const k = this.key(sel);
    if (this.patches().has(k)) return;
    this.diffLoading.set(true);
    const store = this.taskStore();
    const obs = this.isWorktree()
      ? this.api.workdiff(this.slug(), sel.path, sel.kind || 'unstaged', this.ignoreWs(), this.wtPath(), store, sel.from)
      : this.api.diff(this.slug(), h, sel.path, this.ignoreWs(), store, sel.from);
    obs.subscribe({
      next: (r) => { const m = new Map(this.patches()); m.set(k, r.patch || ''); this.patches.set(m); this.diffLoading.set(false); },
      error: () => { const m = new Map(this.patches()); m.set(k, ''); this.patches.set(m); this.diffLoading.set(false); },
    });
  }

  // --- Working-tree actions -------------------------------------------------

  // After a stage/unstage/discard from the dock toolbar's <app-file-actions>,
  // re-fetch the worktree status: re-select the first file (groups may have
  // changed) and drop the now-stale cached diffs.
  onActionChanged() {
    const h = this.hash();
    if (!h?.startsWith('wt:')) return;
    this.api.status(this.slug(), this.wtPath()).subscribe({
      next: (s) => {
        this.status.set(s);
        this.selected.set(null);
        this.patches.set(new Map());
        const g = [s.staged.map((f) => ['staged', f] as const), s.unstaged.map((f) => ['unstaged', f] as const), s.untracked.map((f) => ['untracked', f] as const)].flat();
        if (g.length) this.selectFile(g[0][1].path, g[0][0], g[0][1].oldPath);
      },
      error: (e) => {
        const msg = e?.error?.error || e?.message || 'Refresh failed';
        this.messages.add({ severity: 'error', summary: 'Refresh failed', detail: String(msg), life: 4000 });
      },
    });
  }
}
