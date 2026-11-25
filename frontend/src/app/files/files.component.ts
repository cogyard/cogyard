import { Component, input, output, inject, effect, signal, computed, untracked, viewChild, ElementRef, afterRenderEffect, OnDestroy } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { map, finalize } from 'rxjs';
import { Skeleton } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { Select } from 'primeng/select';
import { SelectButton } from 'primeng/selectbutton';
import { RefChipComponent } from '../shared/ref-chip/ref-chip.component';
import { TreeModule } from 'primeng/tree';
import { GitStatusComponent } from '../shared/git-status/git-status.component';
import { TreeNode } from 'primeng/api';
import { renderMarkdown } from '../shared/markdown';
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
import { WtInfo, TreeFile, WtActivityResponse, TreeResponse, FilesBase, FileLink } from '../services/models';
import { StoreService } from '../services/store.service';
import { EditStateService } from '../services/edit-state.service';
import { DiffViewComponent } from '../shared/diff-view/diff-view.component';
import { FileActionsComponent } from '../shared/file-actions/file-actions.component';
import { HtmlFrameComponent } from './html-frame/html-frame.component';
import { LinkMarkComponent } from './link-mark/link-mark.component';
import { LinkPanelComponent } from './link-panel/link-panel.component';
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
const HTML_EXT = new Set(['html', 'htm']);
const ext = (p: string) => (p.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';

// A tree answer's file list with the server's hash of it (task 270). Two are the
// same list when the hashes match; with no hash (an older server) they never
// are, so the tree redraws on every answer as it used to.
type FileList = { hash: string; files: TreeFile[] } | null;
const sameList = (a: FileList, b: FileList) => a === b || (!!a?.hash && a.hash === b?.hash);
const fileListOf = (t: TreeResponse | null): FileList => (t ? { hash: t.filesHash, files: t.files } : null);

// How the open file is shown. 'rendered' = markdown preview, or an HTML page
// with its scripts on; 'no-scripts' = an HTML page with its scripts off.
type FileView = 'rendered' | 'no-scripts' | 'raw' | 'diff';

// Per-node payload carried in TreeNode.data.
interface Row {
  kind: 'dir' | 'file';
  path: string;       // full repo-relative path
  status?: string | null;
  onDisk?: boolean;
  tracked?: boolean;   // files only — false = non-git (untracked/ignored)
  full?: boolean;      // changed-only mode: label is the full path
  hasChanges?: boolean; // dirs only — any changed descendant
  link?: FileLink;     // files only — the entry is a link (task 269)
}

@Component({
  selector: 'app-files',
  imports: [DiffViewComponent, FileActionsComponent, HtmlFrameComponent, LinkMarkComponent, LinkPanelComponent, FormsModule, ToggleSwitch, Select, SelectButton, RefChipComponent, TreeModule, GitStatusComponent, TooltipModule, Skeleton],
  templateUrl: './files.component.html',
  styleUrl: './files.component.scss',
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class FilesComponent implements OnDestroy {
  private api = inject(ApiService);
  private san = inject(DomSanitizer);
  private store = inject(StoreService);
  private editState = inject(EditStateService);

  slug = input.required<string>();
  wt = input<string>('');     // worktree name from ?wt= ('' = main)
  file = input<string>('');   // selected file from ?file=
  // What every status in the tab compares against (task 224), from ?base=:
  // 'main' (default) = committed + uncommitted differences from main;
  // 'head' = only what is not committed yet. The tree letters, folder dots,
  // hide-unchanged filter, counts and the diff all follow it.
  base = input<FilesBase>('main');
  nav = output<{ wt: string; file: string | null; base: FilesBase }>();

  // Gitignored files (node_modules, dist…) are lazy: the default tree the
  // server sends excludes them (~1k entries); the full listing (~220k entries,
  // ~25 MB on a big repo) is fetched only when the user flips "show gitignored".
  // Not persisted — a remembered ON would silently re-fetch the heavy tree on
  // every visit, which is exactly the cost the toggle exists to make deliberate.
  showIgnored = signal(false);
  toggleShowIgnored() { this.showIgnored.set(!this.showIgnored()); }

  private cachedWts = this.store.use<WtActivityResponse>(() => (this.slug() ? `wt-activity|${this.slug()}` : null));
  // The watched entry is always the normal listing, switch on or off: the
  // refresher re-downloads it on every check, so edits show within 10 s.
  private cachedTree = this.store.use<TreeResponse>(() => (this.slug() ? this.treeKey(false) : null));
  // With "show gitignored" on, the gitignored listing (`…|ig`) is loaded once,
  // with no reader, so the refresher never re-downloads it (task 270): it is
  // fetched again only when the switch is turned on, or when the worktree or
  // the compared commit changes while it is on (owner's choice, 2026-11-23 — a
  // new gitignored file shows after turning the switch off and on). The tree
  // shows the normal listing plus that listing's gitignored entries.
  private cachedIgnored = computed(() => (this.showIgnored() && this.slug() ? this.store.sig<TreeResponse>(this.treeKey(true))() : null));
  // The gitignored listing's entry name while its fetch is in flight.
  private ignoredPending = signal<string | null>(null);
  // The tree entry's name: an older commit picked in the compare dropdown
  // (task 224) is part of it — the server works out each file's status against
  // that commit. 'head' / 'main' need none (the tree always compares vs main
  // and, by default, vs the last commit).
  private compareCommit = computed(() => (/^[0-9a-f]{4,40}$/i.test(this.base()) ? this.base() : null));
  private treeKey(ignored: boolean) {
    const c = this.compareCommit();
    return `tree|${this.slug()}|${this.selectedWt()}${ignored ? '|ig' : ''}${c ? `|c=${c}` : ''}`;
  }
  worktrees = computed<WtInfo[]>(() => this.cachedWts()?.worktrees ?? []);
  // The tree is re-downloaded on every live-update check (no change code, by
  // the 2026-10-06 decision in docs/LIVE-UPDATES.md), and each answer is a new
  // object. The file list keeps its identity while the answer's filesHash is
  // unchanged, so the tree keeps its rows and a click never lands on a row that
  // was just thrown away (task 270). The commit list and vsRef still follow
  // every answer.
  private fileList = computed(() => fileListOf(this.cachedTree()), { equal: sameList });
  private ignoredList = computed(() => fileListOf(this.cachedIgnored()), { equal: sameList });
  // The normal listing, plus — switch on — the gitignored listing's gitignored
  // entries (not tracked, no status) that the normal listing lacks. The normal
  // listing wins for any path in both, and nothing else is taken from the
  // gitignored one: it is fetched once, so a file deleted or renamed since would
  // linger from it, where the normal listing is at most 10 s old.
  treeFiles = computed<TreeFile[]>(() => {
    const files = this.fileList()?.files;
    if (!files) return [];
    const ignored = this.ignoredList()?.files;
    if (!ignored) return files;
    const have = new Set(files.map((f) => f.path));
    return files.concat(ignored.filter((f) => !f.tracked && !f.status && !f.commitStatus && !have.has(f.path)));
  });
  vsRef = computed(() => this.cachedTree()?.vsRef ?? null);
  loadingTree = computed(() => this.cachedTree() === null);
  // The compare dropdown's commit list outlives a tree load (task 224): picking
  // an older commit asks for a new tree, and without this the list emptied to
  // just "main" until it arrived — it looked like the pick had not taken. Kept
  // per worktree, so another worktree's commits never show.
  private lastCommitList = signal<{ wt: string; tree: TreeResponse } | null>(null);
  private commitListTree = computed(() => {
    const t = this.cachedTree();
    if (t) return t;
    const last = this.lastCommitList();
    return last && last.wt === `${this.slug()}|${this.selectedWt()}` ? last.tree : null;
  });
  loadingIgnored = computed(() => this.showIgnored() && this.ignoredPending() === this.treeKey(true));

  // "hide unchanged files" (was the "changed only" button, task 224): the tree
  // lists only files with a status under the current compare base.
  hideUnchanged = signal(false);
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
  view = signal<FileView>('raw');
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

  // main first, then by latest activity desc.
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

  // Comparing against a commit (the last one, or an older one picked from the
  // dropdown) rather than main.
  onCommitSide = computed(() => this.base() !== 'main');
  // A file's status / rename source under the chosen compare base.
  statusOf(f: TreeFile): string | null { return this.onCommitSide() ? f.commitStatus : f.status; }
  private oldPathOf(f: TreeFile): string | undefined { return this.onCommitSide() ? f.commitOldPath : f.oldPath; }
  // Both counts, so each side of the compare switch shows its own.
  countMain = computed(() => this.treeFiles().filter((f) => f.status).length);
  countCommit = computed(() => this.treeFiles().filter((f) => f.commitStatus).length);
  changedCount = computed(() => (this.onCommitSide() ? this.countCommit() : this.countMain()));
  // The one compare dropdown: main on top, then the branch's newest 10
  // commits. The newest is 'head' (the last commit = only what is not
  // committed yet); the rest go by sha.
  compareOptions = computed(() => {
    const t = this.commitListTree();
    const m = t?.mainCommit;
    const opts = [
      { value: 'main', name: t?.vsRef || 'main', short: m?.short ?? '', subject: m?.subject ?? '', relDate: m?.relDate ?? '', main: true, last: false },
      ...(t?.commits ?? []).map((c, i) => ({
        value: i === 0 ? 'head' : c.sha, name: '', short: c.short, subject: c.subject, relDate: c.relDate, main: false, last: i === 0,
      })),
    ];
    // A commit named by the URL that is not (yet) in the list — a deep link
    // opened before the tree arrived — still shows as the choice.
    const b = this.base();
    if (this.compareCommit() && !opts.some((o) => o.value === b)) {
      opts.push({ value: b, name: '', short: b.slice(0, 7), subject: '', relDate: '', main: false, last: false });
    }
    return opts;
  });
  // What the base is called in labels: "main" (the repo's default branch name),
  // "last commit", or an older commit's short sha.
  baseLabel = computed(() => {
    const b = this.base();
    if (b === 'main') return this.vsRef() || 'main';  // the branch name, not its sha
    if (b === 'head') return 'last commit';
    return this.compareOptions().find((o) => o.value === b)?.short ?? b.slice(0, 7);
  });
  // A file that only exists vs main (deleted before the compared commit) is not
  // part of the tree when comparing against a commit — it isn't there and
  // nothing since touches it.
  private visibleFiles = computed(() =>
    this.onCommitSide() ? this.treeFiles().filter((f) => f.onDisk || f.commitStatus) : this.treeFiles());
  private statusByPath = computed(() => new Map(this.treeFiles().map((f) => [f.path, f])));
  selected = computed(() => (this.file() ? this.statusByPath().get(this.file()) ?? null : null));
  selectedStatus = computed(() => { const s = this.selected(); return s ? this.statusOf(s) : null; });
  // The open entry's link (task 269): from the tree, else from the file's own
  // answer (a deep link read before the tree arrived).
  private fileLink = signal<FileLink | null>(null);
  link = computed(() => this.selected()?.link ?? this.fileLink());
  // A link the right side explains instead of opening: to a folder, broken, or
  // leading out of the repo (app-link-panel). A link to a file inside the repo
  // opens as a file, with "link →" in its bar.
  linkPanel = computed(() => { const l = this.link(); return !!l && (l.kind !== 'file' || !l.inside); });
  linkIcon = computed(() => { const l = this.link(); return l ? this.icon({ kind: 'file', path: this.file(), link: l }) : ''; });

  // The file bar's view choices: rendered (markdown; an HTML page with and
  // without its scripts), the file itself (raw text, or the image), and the
  // diff when the file has a change against the compare base.
  viewOptions = computed(() => {
    const opts: { label: string; value: FileView }[] = [];
    if (this.isMd() && !this.binary()) opts.push({ label: 'rendered', value: 'rendered' });
    if (this.canRenderHtml()) {
      opts.push({ label: 'rendered', value: 'rendered' });
      opts.push({ label: 'no scripts', value: 'no-scripts' });
    }
    opts.push({ label: this.isImage() ? 'image' : this.binary() ? 'file' : 'raw', value: 'raw' });
    if (this.selectedStatus()) opts.push({ label: `diff vs ${this.baseLabel()}`, value: 'diff' });
    return opts;
  });
  isImage = computed(() => !!this.file() && IMAGE_EXT.has(ext(this.file())));
  isMd = computed(() => ext(this.file()) === 'md');
  isHtml = computed(() => HTML_EXT.has(ext(this.file())));
  // An HTML page renders from its own address on the raw route, not from the
  // (1 MB-capped) text loaded here, so a large page renders too.
  canRenderHtml = computed(() => this.isHtml() && !this.binary());
  // The page is shown by app-html-frame (sandboxed; why and its limits are
  // there), never injected into the portal's DOM like markdown. The address
  // uses the ?wt= value as given ('' = main, which the route resolves) so it
  // doesn't change — and reload the page — when the worktree list arrives;
  // savedRev changes only on a save, so the frame reloads then and only then.
  private savedRev = signal<string | null>(null);
  // The raw route's key, read once (it changes only when the server restarts).
  private rawKey = toSignal(this.api.rawKey().pipe(map((r) => r.key)), { initialValue: null });
  htmlSrc = computed(() => {
    const k = this.rawKey();
    return k ? this.api.rawUrl(k, this.slug(), this.wt(), this.file(), this.savedRev()) : null;
  });
  htmlFrame = computed(() => this.canRenderHtml() && (this.view() === 'rendered' || this.view() === 'no-scripts'));
  // The full-size link: the page in a tab of its own, at the same address,
  // where a page that fits itself to the window gets a whole window. The
  // route's sandbox header keeps it walled off there too.
  openFullSize() {
    const k = this.rawKey();
    if (k) window.open(this.api.rawUrl(k, this.slug(), this.wt(), this.file()), '_blank', 'noopener');
  }
  // The view a file opens on: rendered (for an HTML page, scripts on — most
  // pages need them to lay themselves out) for markdown and HTML, else the file.
  private defaultView(): FileView {
    return this.isMd() || this.isHtml() ? 'rendered' : 'raw';
  }
  imageUrl = computed(() => this.api.fileUrl(this.slug(), this.selectedWt(), this.file()));

  // p-tree node model built from the flat path list. Dirs expanded by default
  // in small trees; per-dir toggles override either way (expandOverride map
  // stays the source of truth so rebuilt trees keep their expansion state).
  treeNodes = computed<TreeNode[]>(() => {
    const files = this.visibleFiles();
    const statusOf = (f: TreeFile) => this.statusOf(f);
    if (this.hideUnchanged()) {
      return files.filter(statusOf).map((f) => ({
        key: f.path, label: f.path, leaf: true,
        data: { kind: 'file', path: f.path, status: statusOf(f), onDisk: f.onDisk, tracked: f.tracked, full: true, link: f.link },
      }));
    }
    const defaultOpen = files.length <= 250;
    const override = this.expandOverride();
    const isOpen = (dir: string) => override.get(dir) ?? defaultOpen;
    const changedDirs = new Set<string>();
    // Dirs holding ≥1 tracked file are "git" dirs; the rest (node_modules, dist…)
    // are non-git and gray out like non-git files.
    const trackedDirs = new Set<string>();
    // Dirs holding ≥1 untracked-not-ignored ('?') file — they carry a muted '?'
    // badge, mirroring the file badge so an all-untracked dir isn't left blank.
    const untrackedDirs = new Set<string>();
    for (const f of files) {
      const segs = f.path.split('/');
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/');
        // Only REAL git changes light the amber dir dot. An untracked '?' file
        // (OS junk, tool output) is not a change worth flagging up the tree —
        // else a non-git dir like .playwright-mcp looks like it has commits.
        const s = statusOf(f);
        if (s && s !== '?') changedDirs.add(dir);
        if (s === '?') untrackedDirs.add(dir);
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
          data: { kind: 'dir', path: dirPath, hasChanges: changedDirs.has(dirPath), tracked: trackedDirs.has(dirPath), untracked: untrackedDirs.has(dirPath) },
        });
      }
      for (const f of n.files.sort((a, b) => a.path.localeCompare(b.path))) {
        out.push({
          key: f.path, label: f.path.split('/').pop()!, leaf: true,
          data: { kind: 'file', path: f.path, status: statusOf(f), onDisk: f.onDisk, tracked: f.tracked, link: f.link },
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
      // Relative images load from beside the file, on the raw route (task 263).
      // A file with images waits for the route's key (asked for once, when the
      // tab opens) rather than ask the portal's own address for them first.
      const k = this.rawKey(), slug = this.slug(), wt = this.wt();
      if (!k && /<img\b|!\[/i.test(c)) return null;
      return renderMarkdown(this.san, c, k ? { file: this.file(), url: (p) => this.api.rawUrl(k, slug, wt, p) } : undefined);
    }
    const lang = LANG_BY_EXT[ext(this.file())];
    if (!lang) return null; // plain <pre> fallback in the template
    return this.san.bypassSecurityTrustHtml(hljs.highlight(c, { language: lang }).value);
  });

  constructor() {
    // Worktree pills + file tree are watched entries (cachedWts / cachedTree
    // above): the shared refresher re-loads them quietly — cached data stays on
    // screen, expansion overrides survive. The open file's CONTENT is
    // deliberately not auto-refreshed: re-fetching mid-read would yank the
    // scroll position out from under you.
    effect(() => {
      const s = this.slug(), w = this.selectedWt(), f = this.file();
      this.view.set(this.defaultView());
      this.patch.set(null);
      this.savedRev.set(null);
      if (s && f) this.loadFile(s, w, f); else this.resetContent();
    });
    // "show gitignored" on: fetch the gitignored listing once (cachedIgnored
    // says when). treeKey reads the worktree and the compared commit, so this
    // re-runs when either changes while the switch is on — and never on a check.
    effect(() => {
      if (!this.showIgnored() || !this.slug()) return;
      const key = this.treeKey(true), s = this.slug(), w = this.selectedWt(), c = this.compareCommit();
      untracked(() => {
        this.ignoredPending.set(key);
        // A fetch already in flight for this entry is kept (the store drops the
        // new one); its own finalize clears the spinner for the same key.
        this.store.load(key, this.api.tree(s, w, true, c).pipe(
          finalize(() => { if (this.ignoredPending() === key) this.ignoredPending.set(null); })));
      });
    });
    // Remember the last tree that arrived, for the compare dropdown's list.
    effect(() => {
      const t = this.cachedTree();
      if (t) this.lastCommitList.set({ wt: `${untracked(this.slug)}|${untracked(this.selectedWt)}`, tree: t });
    });
    // A compare-base flip drops the cached diff. An open diff re-fetches
    // against the new base — or, when the file has no change against it,
    // falls back to the file view (there is no diff to show).
    effect(() => {
      this.base();
      untracked(() => {
        this.patch.set(null);
        if (this.view() !== 'diff') return;
        if (this.selectedStatus()) this.fetchPatch();
        else this.view.set(this.defaultView());
      });
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
    this.baseHash.set(null); this.fileLink.set(null);
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
        this.fileLink.set(d.link ?? null);
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
        this.savedRev.set(r.hash); // a rendered HTML page reloads with the save
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
  // After a save: the normal listing, which carries the saved file's status
  // (switch on or off — the gitignored listing is only ever loaded on switch-on).
  private refreshTree() {
    this.store.load(this.treeKey(false), this.api.tree(this.slug(), this.selectedWt(), false, this.compareCommit()));
  }

  // Switching worktree drops back to the lean tree — each heavy listing is an
  // explicit per-worktree opt-in, never carried along on a pill click. A picked
  // older commit belongs to this worktree's branch, so it drops back to the
  // last commit there.
  selectWt(name: string) {
    this.showIgnored.set(false);
    this.nav.emit({ wt: name, file: null, base: this.compareCommit() ? 'head' : this.base() });
  }
  // The compare dropdown: same worktree and file, other base.
  setBase(b: FilesBase) {
    if (b !== this.base()) this.nav.emit({ wt: this.selectedWt(), file: this.file() || null, base: b });
  }
  // Whole-row click: files navigate, dirs toggle (original UX, beyond p-tree's
  // chevron-only toggling).
  onNodeSelect(node: TreeNode) {
    if (node.data?.kind === 'dir') { this.toggleDir(node.data.path); return; }
    this.nav.emit({ wt: this.selectedWt(), file: node.data.path, base: this.base() });
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
  setView(v: FileView) {
    this.view.set(v);
    if (v === 'diff' && this.patch() == null) this.fetchPatch();
  }
  private fetchPatch() {
    const sel = this.selected();
    const base = this.base();
    this.api.wtdiff(this.slug(), this.selectedWt(), this.file(), false, base, sel ? this.oldPathOf(sel) : null)
      // A base flip mid-request must not paint the other base's diff.
      .subscribe((d) => { if (this.base() === base) this.patch.set(d.patch); });
  }

  // Material Icon Theme SVGs (copied to assets/material-icons by angular.json).
  // A link shows the icon of what it points at (task 269): a folder icon for a
  // link to a folder, the plain file icon for a broken one.
  icon(r: Row): string {
    const k = r.link?.kind;
    const name = r.kind === 'dir' || k === 'dir' ? getIconForDirectoryPath(r.path)
      : k === 'broken' ? 'file' : getIconForFilePath(r.path);
    return `assets/material-icons/${name}.svg`;
  }
  // The row's hover text; a link adds where it goes.
  rowTip(r: Row): string {
    return r.link ? `${r.path} → ${r.link.target}` : r.path;
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
