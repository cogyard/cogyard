import { Component, input, output, inject, effect, signal, computed, untracked, viewChild, ElementRef, afterRenderEffect, OnDestroy } from '@angular/core';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { TreeModule } from 'primeng/tree';
import { Tag } from 'primeng/tag';
import { TreeNode } from 'primeng/api';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini';
import diff from 'highlight.js/lib/languages/diff';
import { getIconForFilePath, getIconForDirectoryPath } from 'vscode-material-icons';
import { ApiService } from '../services/api.service';
import { WtInfo, TreeFile, WtActivityResponse, TreeResponse } from '../services/models';
import { RefreshService } from '../services/refresh.service';
import { StoreService } from '../services/store.service';
import { EditStateService } from '../services/edit-state.service';
import { DiffViewComponent } from '../shared/diff-view/diff-view.component';
import { FileActionsComponent } from '../shared/file-actions/file-actions.component';
// Type-only — the editor module itself is dynamic-import'd on first Edit click
// so CodeMirror stays out of the main bundle.
import type { EditorHandle } from './editor';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('python', python);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('diff', diff);

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', html: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss',
  sh: 'bash', zsh: 'bash', bash: 'bash',
  py: 'python', yml: 'yaml', yaml: 'yaml', md: 'markdown',
  sql: 'sql', toml: 'ini', ini: 'ini', conf: 'ini', plist: 'xml',
  diff: 'diff', patch: 'diff',
};
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico']);
const ext = (p: string) => (p.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';

// Per-node payload carried in TreeNode.data.
interface Row {
  kind: 'dir' | 'file';
  path: string;       // full repo-relative path
  status?: string | null;
  onDisk?: boolean;
  tracked?: boolean;   // files only — false = non-git (untracked/ignored)
  full?: boolean;      // changed-only mode: label is the full path
  hasChanges?: boolean; // dirs only — any changed descendant
}

@Component({
  selector: 'app-files',
  imports: [DiffViewComponent, FileActionsComponent, FormsModule, ToggleSwitch, TreeModule, Tag, TooltipModule, Skeleton],
  templateUrl: './files.component.html',
  styleUrl: './files.component.scss',
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class FilesComponent implements OnDestroy {
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);
  private editState = inject(EditStateService);

  slug = input.required<string>();
  wt = input<string>('');     // worktree name from ?wt= ('' = main)
  file = input<string>('');   // selected file from ?file=
  nav = output<{ wt: string; file: string | null }>();

  // Gitignored files (node_modules, dist…) are lazy: the default tree the
  // server sends excludes them (~1k entries); the full listing (~220k entries,
  // ~25 MB on a big repo) is fetched only when the user flips "show gitignored".
  // Not persisted — a remembered ON would silently re-fetch the heavy tree on
  // every visit, which is exactly the cost the toggle exists to make deliberate.
  showIgnored = signal(false);
  toggleShowIgnored() { this.showIgnored.set(!this.showIgnored()); }

  private cachedWts = computed(() => this.store.sig<WtActivityResponse>(`wt-activity|${this.slug()}`)());
  private cachedLean = computed(() => this.store.sig<TreeResponse>(`tree|${this.slug()}|${this.selectedWt()}`)());
  private cachedFull = computed(() => this.store.sig<TreeResponse>(`tree|${this.slug()}|${this.selectedWt()}|ig`)());
  // While the full tree loads, the lean tree stays on screen (spinner on the
  // toggle signals the wait); once landed, the full tree swaps in.
  private cachedTree = computed(() =>
    this.showIgnored() ? (this.cachedFull() ?? this.cachedLean()) : this.cachedLean());
  worktrees = computed<WtInfo[]>(() => this.cachedWts()?.worktrees ?? []);
  treeFiles = computed<TreeFile[]>(() => this.cachedTree()?.files ?? []);
  vsRef = computed(() => this.cachedTree()?.vsRef ?? null);
  loadingTree = computed(() => this.cachedTree() === null);
  loadingIgnored = computed(() => this.showIgnored() && this.cachedFull() === null);

  changedOnly = signal(false);
  private expandOverride = signal<Map<string, boolean>>(new Map());

  // Dark mode for the viewing area only (tree/pills stay light). Persisted.
  dark = signal(localStorage.getItem('cogyard-files-dark') === '1');
  toggleDark() {
    const d = !this.dark();
    this.dark.set(d);
    localStorage.setItem('cogyard-files-dark', d ? '1' : '0');
  }

  // Content pane state
  content = signal<string | null>(null);
  binary = signal(false);
  truncated = signal(false);
  size = signal(0);
  loadingFile = signal(false);
  missing = signal(false);
  view = signal<'rendered' | 'raw' | 'diff'>('raw');
  patch = signal<string | null>(null);

  // Edit mode. `content` doubles as the saved baseline: dirty means
  // the editor doc differs from it; save/reload move it forward.
  editing = signal(false);
  dirty = signal(false);
  saving = signal(false);
  conflict = signal(false);
  saveError = signal<string | null>(null);
  loadingEditor = signal(false);
  baseHash = signal<string | null>(null);
  // Soft-wrap long lines in the editor. Persisted like the dark switch.
  wrap = signal(localStorage.getItem('cogyard-files-wrap') === '1');
  toggleWrap() {
    const w = !this.wrap();
    this.wrap.set(w);
    localStorage.setItem('cogyard-files-wrap', w ? '1' : '0');
  }
  private editor: EditorHandle | null = null;
  private editorHost = viewChild<ElementRef<HTMLElement>>('cmHost');
  // Editable = a loaded, on-disk, non-binary, non-image, non-truncated text file
  // (a truncated buffer must never round-trip a save — it would amputate the file).
  canEdit = computed(() =>
    !!this.file() && !this.isImage() && !this.binary() && !this.truncated() &&
    !this.missing() && this.content() != null && !!this.baseHash() &&
    this.selected()?.onDisk !== false);

  // main first (primary clone first), then by latest activity desc.
  // Wall-clock "now", ticked on a timer (not read live in the template). The
  // pill "last activity" label is derived from THIS inside a computed so a
  // single change-detection cycle sees one stable value — reading Date.now()
  // straight from the template interpolation caused NG0100 when an async CD
  // pass crossed a minute boundary (task 084).
  private now = signal(Date.now());
  private nowTimer = setInterval(() => this.now.set(Date.now()), 30_000);
  pills = computed(() => {
    const nowMs = this.now();
    const ws = [...this.worktrees()];
    ws.sort((a, b) =>
      (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) ||
      (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    return ws.map((w) => ({ ...w, when: this.relTime(w.lastActivity, nowMs) }));
  });
  selectedWt = computed(() => this.wt() || (this.pills().find((w) => w.isMain)?.name ?? ''));
  // Absolute checkout path of the selected worktree — what the /api action
  // endpoints expect (the pills carry it; selectedWt is only the name).
  selectedWtPath = computed(() => this.worktrees().find((w) => w.name === this.selectedWt())?.path ?? null);

  // Worktree pills clamp to two rows; a "… more" toggle reveals the rest. The
  // toggle only shows when the full row set actually overflows two rows, measured
  // after render (scrollHeight is the full content height even while clamped).
  private pillsEl = viewChild<ElementRef<HTMLElement>>('pillsRow');
  pillsExpanded = signal(false);
  pillsOverflow = signal(false);
  twoRowPx = signal(0);

  changedCount = computed(() => this.treeFiles().filter((f) => f.status).length);
  private statusByPath = computed(() => new Map(this.treeFiles().map((f) => [f.path, f])));
  selected = computed(() => (this.file() ? this.statusByPath().get(this.file()) ?? null : null));

  isImage = computed(() => !!this.file() && IMAGE_EXT.has(ext(this.file())));
  isMd = computed(() => ext(this.file()) === 'md');
  imageUrl = computed(() => this.api.fileUrl(this.slug(), this.selectedWt(), this.file()));

  // p-tree node model built from the flat path list. Dirs expanded by default
  // in small trees; per-dir toggles override either way (expandOverride map
  // stays the source of truth so rebuilt trees keep their expansion state).
  treeNodes = computed<TreeNode[]>(() => {
    const files = this.treeFiles();
    if (this.changedOnly()) {
      return files.filter((f) => f.status).map((f) => ({
        key: f.path, label: f.path, leaf: true,
        data: { kind: 'file', path: f.path, status: f.status, onDisk: f.onDisk, tracked: f.tracked, full: true },
      }));
    }
    const defaultOpen = files.length <= 250;
    const override = this.expandOverride();
    const isOpen = (dir: string) => override.get(dir) ?? defaultOpen;
    const changedDirs = new Set<string>();
    // Dirs holding ≥1 tracked file are "git" dirs; the rest (node_modules, dist…)
    // are non-git and gray out like non-git files.
    const trackedDirs = new Set<string>();
    for (const f of files) {
      const segs = f.path.split('/');
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/');
        if (f.status) changedDirs.add(dir);
        if (f.tracked) trackedDirs.add(dir);
      }
    }
    interface Node { dirs: Map<string, Node>; files: TreeFile[]; }
    const root: Node = { dirs: new Map(), files: [] };
    for (const f of files) {
      const segs = f.path.split('/');
      let n = root;
      for (let i = 0; i < segs.length - 1; i++) {
        if (!n.dirs.has(segs[i])) n.dirs.set(segs[i], { dirs: new Map(), files: [] });
        n = n.dirs.get(segs[i])!;
      }
      n.files.push(f);
    }
    const walk = (n: Node, prefix: string): TreeNode[] => {
      const out: TreeNode[] = [];
      for (const [name, child] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const dirPath = prefix ? `${prefix}/${name}` : name;
        out.push({
          key: dirPath, label: name, leaf: false, expanded: isOpen(dirPath),
          children: walk(child, dirPath),
          data: { kind: 'dir', path: dirPath, hasChanges: changedDirs.has(dirPath), tracked: trackedDirs.has(dirPath) },
        });
      }
      for (const f of n.files.sort((a, b) => a.path.localeCompare(b.path))) {
        out.push({
          key: f.path, label: f.path.split('/').pop()!, leaf: true,
          data: { kind: 'file', path: f.path, status: f.status, onDisk: f.onDisk, tracked: f.tracked },
        });
      }
      return out;
    };
    return walk(root, '');
  });

  // The selected p-tree node mirrors the ?file= URL state.
  selectedNode = computed<TreeNode | null>(() => {
    const f = this.file();
    if (!f) return null;
    const find = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.key === f) return n;
        if (n.children) { const hit = find(n.children); if (hit) return hit; }
      }
      return null;
    };
    return find(this.treeNodes());
  });

  // Rendered body for text files: markdown preview / syntax-highlighted code.
  rendered = computed<SafeHtml | null>(() => {
    const c = this.content();
    if (c == null) return null;
    if (this.isMd() && this.view() === 'rendered') {
      return this.san.bypassSecurityTrustHtml(marked.parse(c) as string);
    }
    const lang = LANG_BY_EXT[ext(this.file())];
    if (!lang) return null; // plain <pre> fallback in the template
    return this.san.bypassSecurityTrustHtml(hljs.highlight(c, { language: lang }).value);
  });

  constructor() {
    // Worktree pills + file tree re-load on the shared refresh tick (quiet —
    // cached data stays on screen, expansion overrides survive). The open
    // file's CONTENT is deliberately not auto-refreshed: re-fetching mid-read
    // would yank the scroll position out from under you.
    effect(() => {
      const s = this.slug();
      this.refresh.tick();
      if (s) this.store.load(`wt-activity|${s}`, this.api.wtActivity(s));
    });
    effect(() => {
      const s = this.slug(), w = this.selectedWt(), ig = this.showIgnored();
      this.refresh.tick();
      if (s) this.store.load(`tree|${s}|${w}${ig ? '|ig' : ''}`, this.api.tree(s, w, ig));
    });
    effect(() => {
      const s = this.slug(), w = this.selectedWt(), f = this.file();
      this.view.set(this.isMd() ? 'rendered' : 'raw');
      this.patch.set(null);
      if (s && f) this.loadFile(s, w, f); else this.resetContent();
    });
    // Measure whether the worktree pills overflow two rows (post-render, so the
    // DOM reflects the current pill set). Reads pills()/pillsExpanded() as deps;
    // writes only overflow/twoRowPx (not read here) so it can't loop.
    afterRenderEffect(() => {
      this.pills(); this.pillsExpanded();
      const el = this.pillsEl()?.nativeElement;
      if (!el) return;
      const first = el.firstElementChild as HTMLElement | null;
      const rowH = first?.offsetHeight ?? 24;
      const gap = parseFloat(getComputedStyle(el).rowGap) || 6;
      const twoRows = rowH * 2 + gap;
      this.twoRowPx.set(twoRows);
      this.pillsOverflow.set(el.scrollHeight > twoRows + 2);
    });
    // Auto-expand ancestors of a deep-linked selection. The override map is
    // read via untracked() — this effect keys off file() only, else writing
    // the map it just read would re-trigger it forever.
    effect(() => {
      const f = this.file();
      if (!f || !f.includes('/')) return;
      const m = new Map(untracked(this.expandOverride));
      const segs = f.split('/');
      for (let i = 1; i < segs.length; i++) m.set(segs.slice(0, i).join('/'), true);
      this.expandOverride.set(m);
    });
    // Mount CodeMirror once edit mode is on AND its host div has rendered
    // (viewChild signals update post-render, so this fires at the right time).
    effect(() => {
      const host = this.editorHost()?.nativeElement;
      if (this.editing() && host && !this.editor) this.mountEditor(host);
    });
    // The pane's dark switch / wrap toggle restyle the live editor in place.
    effect(() => { const d = this.dark(); this.editor?.setDark(d); });
    effect(() => { const w = this.wrap(); this.editor?.setWrap(w); });
    // Publish dirty state for the app-shell nav guard (tab/project switches).
    effect(() => this.editState.dirty.set(this.dirty()));
  }

  ngOnDestroy() {
    clearInterval(this.nowTimer);
    this.editState.dirty.set(false);
    this.editor?.destroy();
    this.editor = null;
  }

  onBeforeUnload(e: BeforeUnloadEvent) {
    if (this.dirty()) e.preventDefault();
  }

  private resetContent() {
    this.stopEdit();
    this.content.set(null); this.binary.set(false); this.truncated.set(false);
    this.size.set(0); this.missing.set(false); this.loadingFile.set(false);
    this.baseHash.set(null);
  }
  private loadFile(slug: string, wt: string, path: string) {
    this.resetContent();
    if (IMAGE_EXT.has(ext(path))) return; // <img> loads it directly
    this.loadingFile.set(true);
    this.api.file(slug, wt, path).subscribe({
      next: (d) => {
        this.content.set(d.content ?? null);
        this.binary.set(!!d.binary);
        this.truncated.set(!!d.truncated);
        this.size.set(d.size);
        this.baseHash.set(d.hash ?? null);
        this.loadingFile.set(false);
      },
      error: () => { this.missing.set(true); this.loadingFile.set(false); },
    });
  }

  // --- Edit mode ----------------------------------------------------

  async startEdit() {
    if (this.editing() || !this.canEdit() || this.loadingEditor()) return;
    this.loadingEditor.set(true);
    try {
      await import('./editor'); // warm the lazy chunk before showing the host
    } finally {
      this.loadingEditor.set(false);
    }
    this.saveError.set(null);
    this.editing.set(true); // the host div renders; the mount effect attaches
  }
  private async mountEditor(host: HTMLElement) {
    const { mountEditor } = await import('./editor'); // already loaded — instant
    if (!this.editing() || this.editor) return;
    this.editor = mountEditor(host, {
      doc: this.content() ?? '',
      fileExt: ext(this.file()),
      dark: this.dark(),
      wrap: this.wrap(),
      onDocChanged: (doc) => this.dirty.set(doc !== this.content()),
      onSave: () => this.save(),
    });
  }
  private stopEdit() {
    this.editor?.destroy();
    this.editor = null;
    this.editing.set(false); this.dirty.set(false);
    this.saving.set(false); this.conflict.set(false); this.saveError.set(null);
  }
  cancelEdit() {
    if (!this.editState.confirmDiscard()) return;
    this.stopEdit();
  }
  save() {
    const hash = this.baseHash();
    if (!this.editor || !this.dirty() || this.saving() || !hash) return;
    const doc = this.editor.getDoc();
    this.saving.set(true); this.saveError.set(null);
    this.api.saveFile(this.slug(), this.selectedWt(), this.file(), doc, hash).subscribe({
      next: (r) => {
        this.saving.set(false);
        // r.content present = the server-side prettier pass reshaped the buffer;
        // re-baseline the editor to exactly what's on disk.
        const onDisk = r.content ?? doc;
        if (r.content != null) this.editor?.setDoc(r.content);
        this.content.set(onDisk); // new baseline — stay in edit mode
        this.baseHash.set(r.hash);
        this.size.set(r.size);
        this.dirty.set(false); this.conflict.set(false);
        this.patch.set(null); // stale the cached diff — content changed
        this.refreshTree();
      },
      error: (e) => {
        this.saving.set(false);
        if (e.status === 409) this.conflict.set(true);
        else this.saveError.set(e.error?.error || 'save failed');
      },
    });
  }
  // Conflict path: drop local edits and re-baseline from what's on disk now.
  reloadFromDisk() {
    this.api.file(this.slug(), this.selectedWt(), this.file()).subscribe((d) => {
      this.content.set(d.content ?? null);
      this.baseHash.set(d.hash ?? null);
      this.size.set(d.size);
      this.editor?.setDoc(d.content ?? '');
      this.dirty.set(false); this.conflict.set(false);
    });
  }
  private refreshTree() {
    const s = this.slug(), w = this.selectedWt(), ig = this.showIgnored();
    this.store.load(`tree|${s}|${w}${ig ? '|ig' : ''}`, this.api.tree(s, w, ig));
  }

  // Switching worktree drops back to the lean tree — each heavy listing is an
  // explicit per-worktree opt-in, never carried along on a pill click.
  selectWt(name: string) { this.showIgnored.set(false); this.nav.emit({ wt: name, file: null }); }
  // Whole-row click: files navigate, dirs toggle (original UX, beyond p-tree's
  // chevron-only toggling).
  onNodeSelect(node: TreeNode) {
    if (node.data?.kind === 'dir') { this.toggleDir(node.data.path); return; }
    this.nav.emit({ wt: this.selectedWt(), file: node.data.path });
  }
  onNodeExpanded(node: TreeNode) { if (node.data?.kind === 'dir') this.setDirOpen(node.data.path, true); }
  onNodeCollapsed(node: TreeNode) { if (node.data?.kind === 'dir') this.setDirOpen(node.data.path, false); }
  private setDirOpen(dir: string, open: boolean) {
    const m = new Map(this.expandOverride());
    m.set(dir, open);
    this.expandOverride.set(m);
  }
  private toggleDir(dir: string) {
    const cur = this.expandOverride().get(dir) ?? this.treeFiles().length <= 250;
    this.setDirOpen(dir, !cur);
  }
  setView(v: 'rendered' | 'raw' | 'diff') {
    this.view.set(v);
    if (v === 'diff' && this.patch() == null) {
      this.api.wtdiff(this.slug(), this.selectedWt(), this.file()).subscribe((d) => this.patch.set(d.patch));
    }
  }

  // Material Icon Theme SVGs (copied to assets/material-icons by angular.json).
  icon(r: Row): string {
    const name = r.kind === 'dir' ? getIconForDirectoryPath(r.path) : getIconForFilePath(r.path);
    return `assets/material-icons/${name}.svg`;
  }

  relTime(iso: string | null, nowMs: number = Date.now()): string {
    if (!iso) return '—';
    const s = (nowMs - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 129600) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1 << 20)).toFixed(1)} MB`;
  }
}
