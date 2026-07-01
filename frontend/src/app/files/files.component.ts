import { Component, input, output, inject, effect, signal, computed, untracked, viewChild, ElementRef, afterRenderEffect } from '@angular/core';
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
import { DiffViewComponent } from '../shared/diff-view/diff-view.component';
import { FileActionsComponent } from '../shared/file-actions/file-actions.component';

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
})
export class FilesComponent {
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  private refresh = inject(RefreshService);
  private store = inject(StoreService);

  slug = input.required<string>();
  wt = input<string>('');     // worktree name from ?wt= ('' = main)
  file = input<string>('');   // selected file from ?file=
  nav = output<{ wt: string; file: string | null }>();

  private cachedWts = computed(() => this.store.sig<WtActivityResponse>(`wt-activity|${this.slug()}`)());
  private cachedTree = computed(() => this.store.sig<TreeResponse>(`tree|${this.slug()}|${this.selectedWt()}`)());
  worktrees = computed<WtInfo[]>(() => this.cachedWts()?.worktrees ?? []);
  treeFiles = computed<TreeFile[]>(() => this.cachedTree()?.files ?? []);
  vsRef = computed(() => this.cachedTree()?.vsRef ?? null);
  loadingTree = computed(() => this.cachedTree() === null);

  changedOnly = signal(false);
  private expandOverride = signal<Map<string, boolean>>(new Map());

  // VSCode-style "hide non-git" filter. Default OFF (show everything, including
  // untracked/gitignored). Persisted; new users have no key → false.
  hideNonGit = signal(localStorage.getItem('cogyard-files-hidenongit') === '1');
  toggleHideNonGit() {
    const h = !this.hideNonGit();
    this.hideNonGit.set(h);
    localStorage.setItem('cogyard-files-hidenongit', h ? '1' : '0');
  }
  // Source list the tree is built from; the full treeFiles() still backs
  // statusByPath/selected so deep-linked non-git files resolve with the filter on.
  private visibleFiles = computed(() =>
    this.hideNonGit() ? this.treeFiles().filter((f) => f.tracked) : this.treeFiles());
  nonGitCount = computed(() => this.treeFiles().filter((f) => !f.tracked).length);

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

  // main first (primary clone first), then by latest activity desc.
  pills = computed(() => {
    const ws = [...this.worktrees()];
    ws.sort((a, b) =>
      (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) ||
      (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    return ws;
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
    const files = this.visibleFiles();
    if (this.changedOnly()) {
      return files.filter((f) => f.status).map((f) => ({
        key: f.path, label: f.path, leaf: true,
        data: { kind: 'file', path: f.path, status: f.status, onDisk: f.onDisk, tracked: f.tracked, full: true },
      }));
    }
    // Default open/closed keys off the FULL tree size, not the filtered list, so
    // toggling "hide non-git" never silently expands/collapses everything.
    const defaultOpen = this.treeFiles().length <= 250;
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
      const s = this.slug(), w = this.selectedWt();
      this.refresh.tick();
      if (s) this.store.load(`tree|${s}|${w}`, this.api.tree(s, w));
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
  }

  private resetContent() {
    this.content.set(null); this.binary.set(false); this.truncated.set(false);
    this.size.set(0); this.missing.set(false); this.loadingFile.set(false);
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
        this.loadingFile.set(false);
      },
      error: () => { this.missing.set(true); this.loadingFile.set(false); },
    });
  }

  selectWt(name: string) { this.nav.emit({ wt: name, file: null }); }
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

  relTime(iso: string | null): string {
    if (!iso) return '—';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
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
