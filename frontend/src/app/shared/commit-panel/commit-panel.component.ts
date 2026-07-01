import { Component, input, output, inject, effect, signal, computed } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { FormsModule } from '@angular/forms';
import { Tag } from 'primeng/tag';
import { SelectButton } from 'primeng/selectbutton';
import { ToggleButton } from 'primeng/togglebutton';
import { Drawer } from 'primeng/drawer';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { CommitDetail, StatusResponse, ChangeFile } from '../../services/models';
import { DiffViewComponent } from '../diff-view/diff-view.component';
import { FileActionsComponent } from '../file-actions/file-actions.component';

interface Sel { path: string; kind?: string; }
interface FileGroup { title: string; kind: string; list: ChangeFile[]; }

@Component({
  selector: 'app-commit-panel',
  imports: [DiffViewComponent, FileActionsComponent, FormsModule, Tag, SelectButton, ToggleButton, Skeleton, Drawer],
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

  isWorktree = computed(() => (this.hash() ?? '').startsWith('wt:'));
  // Which checkout: the path carried in the hash; null = main checkout.
  wtPath = computed(() => (this.isWorktree() ? this.hash()!.slice(3) : null));
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
      this.selected.set(null);
      this.patches.set(new Map());
      this.detail.set(null);
      this.status.set(null);
      if (!h) return;
      this.loading.set(true);
      const sub = h.startsWith('wt:')
        ? this.api.status(slug, h.slice(3)).subscribe({
            next: (s) => {
              this.status.set(s);
              this.loading.set(false);
              const g = [s.staged.map((f) => ['staged', f] as const), s.unstaged.map((f) => ['unstaged', f] as const), s.untracked.map((f) => ['untracked', f] as const)].flat();
              if (g.length) this.selectFile(g[0][1].path, g[0][0]);
            },
            error: () => this.loading.set(false),
          })
        : this.api.commit(slug, h).subscribe({
            next: (d) => {
              this.detail.set(d);
              this.loading.set(false);
              if (d.files?.length) this.selectFile(d.files[0].path);
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
  statusClass(s: string | undefined) { return 's-' + (s ? s[0] : 'A'); }
  isSelected(path: string, kind?: string) { const s = this.selected(); return !!s && s.path === path && s.kind === kind; }

  selectFile(path: string, kind?: string) {
    this.selected.set({ path, kind });
    this.fetch({ path, kind });
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
    const obs = this.isWorktree()
      ? this.api.workdiff(this.slug(), sel.path, sel.kind || 'unstaged', this.ignoreWs(), this.wtPath())
      : this.api.diff(this.slug(), h, sel.path, this.ignoreWs());
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
        if (g.length) this.selectFile(g[0][1].path, g[0][0]);
      },
      error: (e) => {
        const msg = e?.error?.error || e?.message || 'Refresh failed';
        this.messages.add({ severity: 'error', summary: 'Refresh failed', detail: String(msg), life: 4000 });
      },
    });
  }
}
