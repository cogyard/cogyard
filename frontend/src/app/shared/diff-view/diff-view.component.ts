import { Component, input, computed } from '@angular/core';

// Reusable unified-diff renderer. Takes a raw patch string (`git show`/`git diff`)
// and renders it either side-by-side or unified, with per-line numbers and
// word-level highlighting of the exact changed characters. Shared by the commit
// panel and the working-tree view.

const MAX_LINES = 4000; // safety cap on parsed patch lines

interface Seg { t: string; ch: boolean; }                 // word segment; ch = changed
interface Cell { no: number | null; cls: string; segs: Seg[] | null; content: string; }
interface SplitRow { kind: 'pair' | 'hunk'; left: Cell | null; right: Cell | null; text: string; }
interface UniRow { kind: 'line' | 'meta' | 'hunk'; oldNo: number | null; newNo: number | null; cls: string; marker: string; segs: Seg[] | null; content: string; }

// Token-level diff (LCS over words/punct/space) → changed-flagged segments per side.
function wordDiff(a: string, b: string): { a: Seg[]; b: Seg[] } {
  const tok = (s: string) => s.match(/\s+|\w+|[^\s\w]/g) ?? [];
  const A = tok(a), B = tok(b);
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const aS: Seg[] = [], bS: Seg[] = [];
  let i = 0, j = 0;
  const push = (arr: Seg[], t: string, ch: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.ch === ch) last.t += t; else arr.push({ t, ch });
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { push(aS, A[i], false); push(bS, B[j], false); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(aS, A[i], true); i++; }
    else { push(bS, B[j], true); j++; }
  }
  while (i < n) { push(aS, A[i], true); i++; }
  while (j < m) { push(bS, B[j], true); j++; }
  return { a: aS, b: bS };
}

@Component({
  selector: 'app-diff-view',
  templateUrl: './diff-view.component.html',
  styleUrl: './diff-view.component.scss',
})
export class DiffViewComponent {
  patch = input<string>('');
  mode = input<'split' | 'unified'>('split');

  private model = computed(() => this.parse(this.patch()));
  splitRows = computed(() => this.model().split);
  uniRows = computed(() => this.model().uni);
  binary = computed(() => this.model().binary);
  empty = computed(() => !this.model().split.length && !this.model().uni.length);

  private parse(raw: string): { split: SplitRow[]; uni: UniRow[]; binary: boolean } {
    const split: SplitRow[] = [];
    const uni: UniRow[] = [];
    if (!raw || !raw.trim()) return { split, uni, binary: false };
    const all = raw.split('\n').slice(0, MAX_LINES);
    const binary = all.some((l) => l.startsWith('Binary files') || l.includes('GIT binary patch'));

    let oldNo = 0, newNo = 0;
    let pendDel: { no: number; content: string }[] = [];
    let pendAdd: { no: number; content: string }[] = [];

    const flush = () => {
      const k = Math.max(pendDel.length, pendAdd.length);
      for (let i = 0; i < k; i++) {
        const d = pendDel[i], a = pendAdd[i];
        let dSeg: Seg[] | null = null, aSeg: Seg[] | null = null;
        if (d && a) { const w = wordDiff(d.content, a.content); dSeg = w.a; aSeg = w.b; }
        split.push({
          kind: 'pair', text: '',
          left: d ? { no: d.no, cls: 'del', segs: dSeg, content: d.content } : null,
          right: a ? { no: a.no, cls: 'add', segs: aSeg, content: a.content } : null,
        });
        if (d) uni.push({ kind: 'line', oldNo: d.no, newNo: null, cls: 'del', marker: '-', segs: dSeg, content: d.content });
        if (a) uni.push({ kind: 'line', oldNo: null, newNo: a.no, cls: 'add', marker: '+', segs: aSeg, content: a.content });
      }
      pendDel = []; pendAdd = [];
    };

    const isMeta = (l: string) =>
      l.startsWith('diff --git') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ') ||
      l.startsWith('new file') || l.startsWith('deleted file') || l.startsWith('rename ') ||
      l.startsWith('similarity ') || l.startsWith('Binary files') || l.startsWith('\\ No newline');

    for (const l of all) {
      if (l.startsWith('@@')) {
        flush();
        const m = l.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) { oldNo = +m[1]; newNo = +m[2]; }
        split.push({ kind: 'hunk', left: null, right: null, text: l });
        uni.push({ kind: 'hunk', oldNo: null, newNo: null, cls: 'hunk', marker: '', segs: null, content: l });
        continue;
      }
      // File-header noise (diff --git / index / --- / +++ / new file / rename /
      // Binary files / etc.) is dropped — the filename is already shown above and
      // line numbers are in the gutters. Keep only @@ hunk separators.
      if (isMeta(l)) { flush(); continue; }
      if (l.startsWith('-')) { pendDel.push({ no: oldNo++, content: l.slice(1) }); continue; }
      if (l.startsWith('+')) { pendAdd.push({ no: newNo++, content: l.slice(1) }); continue; }
      // context line (starts with a space, or a blank line in the patch)
      flush();
      const content = l.startsWith(' ') ? l.slice(1) : l;
      split.push({ kind: 'pair', text: '', left: { no: oldNo, cls: 'ctx', segs: null, content }, right: { no: newNo, cls: 'ctx', segs: null, content } });
      uni.push({ kind: 'line', oldNo, newNo, cls: 'ctx', marker: ' ', segs: null, content });
      oldNo++; newNo++;
    }
    flush();
    return { split, uni, binary };
  }
}
