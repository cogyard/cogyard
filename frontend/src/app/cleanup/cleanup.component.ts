import { Component, inject, signal, computed, input, output, effect, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { tap } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { TableModule } from 'primeng/table';
import { Checkbox } from 'primeng/checkbox';
import { Dialog } from 'primeng/dialog';
import { Skeleton } from 'primeng/skeleton';
import { FlagComponent, FlagTone } from '../shared/flag/flag.component';
import { Tooltip } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';
import { ApiService } from '../services/api.service';
import { StoreService } from '../services/store.service';
import { GitRefComponent } from '../shared/git-ref/git-ref.component';
import { TaskChipComponent } from '../shared/task-chip/task-chip.component';
import { CleanupChat, CleanupItem, CleanupProject, CleanupReport } from '../services/models';

// How a chat worked on a task (core/cleanup.mjs workedTasks), as the single
// words the chip's tooltip lists after "worked on:" (task 154 — words, not
// sentences).
const WORKED_BY_WORDS: Record<string, string> = {
  committed: 'commit', claimed: 'claim', worktree: 'worktree',
  created: 'created', edited: 'edited',
};

// The Cleanup tab — the whole cleanup process for ONE project.
// The UI is driven BY the process; it is not a view of available data with a
// process fitted over it afterwards.
//
// PER-PROJECT, not global. An earlier draft was a global page beside Settings,
// on the reasoning that the backlog spans every repo at once — but cleanup is
// done from inside one project, and placement follows how the work is actually
// done rather than what the data makes possible. A cross-project list nobody
// reads in that shape does not solve the visibility problem, it relocates it.
//
// THE PROCESS, in the order the page presents it:
//   1. See what's hanging around in this project.
//   2. Remove the worktrees you're done with — here, verified. "Remove
//      worktrees" turns on checkboxes (removable rows only); tick several and
//      remove them in one confirm. The browser still sends one request per
//      worktree, so each gets the server's own name check and verification.
//   3. The page then names the chats that became safe to archive.
//   4. Archive those in Claude's own UI. One visit, at the end.
//
// TWO CONSTRAINTS THE UI MUST HONOUR, both mechanical rather than stylistic:
//
// The portal can NEVER archive a chat. The desktop app owns the flag and
// clobbers external writes, so there is no archive button and there never will
// be — the page names the chat and stops. Anything that looks like an archive
// control here would be a lie.
//
// A chat can cover SEVERAL tasks, so it is safe to archive only when every task
// in it is done and none still has a worktree. Archiving on one task's
// completion buries a conversation another open task still needs. The page
// states which tasks a chat covers and what it's waiting on, because that is
// the judgement that cannot be made from memory — and it is the reason this
// surface exists rather than a list of worktrees.
//
// Vocabulary is closed: chats are ARCHIVED, worktrees are REMOVED, the whole
// thing is CLEANUP. ONE deliberate exception, and only one: the confirm
// dialog's final button says DELETE worktree. At the point of consent the
// blunter word is the honest one — it is the moment the checkout stops
// existing. Everywhere else — row buttons, headings, toasts, this file — a
// worktree is removed.
@Component({
  selector: 'app-cleanup',
  imports: [FormsModule, TableModule, Checkbox, Dialog, Skeleton, FlagComponent, Tooltip, GitRefComponent, TaskChipComponent],
  templateUrl: './cleanup.component.html',
  styleUrl: './cleanup.component.scss',
})
export class CleanupComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  private toast = inject(MessageService);

  /** The project whose cleanup this is. Set by the shell from the URL. */
  slug = input.required<string>();

  // Deciding whether work is finished means looking at the work — the task file
  // and the worktree's real state. Same jumps every other tab emits, so a row is
  // a starting point for that check rather than a dead end. (No branch jump: the
  // branch column was cut as derivable-from-the-name, and Worktrees links to
  // Branches anyway, one hop away.)
  jumpTask = output<string>();
  jumpWorktree = output<string>();

  // Cached in StoreService, like every other tab (task 126). This one used to
  // call the API directly and flip a local `loading` flag, which meant EVERY
  // visit blanked the page to skeletons for the length of the request — and this
  // request is the most expensive one in the portal (a git verdict per worktree).
  // Reading from the cache paints what you last saw instantly and swaps the
  // fresh report in behind it.
  //
  // Deliberately NOT wired to RefreshService's 7s tick, which is what the other
  // tabs do: this report shells out to git once per worktree, and re-running
  // that every 7 seconds for an open tab is a disk-thrashing background job
  // nobody asked for. It loads on arrival, and Refresh is right there.
  readonly report = computed(() => this.store.sig<CleanupReport>(`cleanup|${this.slug()}`)());

  /** Why the last fetch failed, when there is no cached report to fall back on.
   *  StoreService deliberately swallows errors to keep the last good data, which
   *  is right for a refresh and wrong for a first load: `loading` is derived from
   *  "no data yet", so without this a failed first request left the page
   *  skeleton-ing forever, which reads as "still working". */
  readonly loadError = signal<string | null>(null);
  readonly loading = computed(() => this.report() === null && !this.loadError());

  /** Worktrees removed in THIS visit — so the row can flip to its "now archive
   *  the chat" state without a full reload stealing the user's place. */
  readonly justRemoved = signal<Set<string>>(new Set());

  // --- selecting mode (task 148) --------------------------------------------
  // Gmail-style: the table has no per-row remove buttons. "Remove worktrees"
  // switches it into selecting mode, where only removable rows get a checkbox —
  // anything that can't be cleaned up has none, so it can't be ticked.
  readonly selecting = signal(false);
  /** Paths of the ticked worktrees. */
  readonly selected = signal<Set<string>>(new Set());

  // --- the confirm gate -----------------------------------------------------
  // The dialog lists every worktree it will remove, and its Delete button is
  // the consent. It used to add a "Yes — delete it" checkbox on top (task 129):
  // a second click saying what the first already said. The server runs its own
  // check (each request must name its worktree in `confirm`), which is the real
  // boundary.
  readonly pending = signal<CleanupItem[]>([]);
  readonly removing = signal(false);
  /** Which of `pending` is being sent now, 1-based, for the Delete button. */
  readonly progress = signal(0);

  // Every project, empty ones included (task 150): an empty table renders with
  // its heading and a "nothing here" row, so "nothing to clean" never looks
  // like "the page broke".
  readonly projects = computed(() => this.report()?.projects ?? []);

  readonly totalRemovable = computed(() => this.report()?.totalRemovable ?? 0);
  // READY chats only — `p.chats` now carries every open chat, most of them
  // still held; the badge counts things there is something to DO about.
  readonly totalArchivable = computed(() =>
    this.projects().reduce((n, p) => n + p.chats.filter((c) => c.ready).length + this.readyChatsIn(p).length, 0));

  /** The report object the removed-in-this-visit set belongs to. A fresh report
   *  has already dropped those worktrees, so the optimistic marks are spent. */
  private markedFor: CleanupReport | null = null;

  constructor() {
    // Load when the shell switches project — the tab instance is reused.
    effect(() => { this.slug(); untracked(() => this.load()); });
    effect(() => {
      const r = this.report();
      if (r && r !== this.markedFor) {
        this.markedFor = r;
        untracked(() => { this.justRemoved.set(new Set()); this.pruneSelection(); });
      }
    });
  }

  load() {
    const s = this.slug();
    if (!s) return;
    // Through the store so the result is cached, but the failure still reaches
    // the user twice over: a toast (right when a REFRESH fails and the page can
    // keep showing the last good report) and `loadError` (right when there is
    // nothing to show and the page must say so instead of spinning).
    this.store.load(`cleanup|${s}`, this.api.cleanup(s).pipe(tap({
      next: () => this.loadError.set(null),
      error: (e) => { this.loadError.set(this.reason(e)); this.fail(e); },
    })));
  }

  /** Retry after a failed first load: back to the skeleton, then try again. */
  retry() {
    this.loadError.set(null);
    this.load();
  }

  // --- the process, as ordering --------------------------------------------
  // Two keys, in this order:
  //
  // 1. What you can DO. Rows you can act on come first — REMOVABLE and PUSHED
  //    together, one group (owner, task 174), told apart by their chips; if they interleaved
  //    with blocked ones you'd scan past things you can't touch to find the
  //    ones you can. The blocked rows are then ordered by what their verdict
  //    ASKS of you: DIRTY has your uncommitted work in it, UNMERGED has work
  //    that hasn't landed, LIVE is hands-off entirely, UNKNOWN is unreadable.
  //    (This replaces a split on "has a waiting chat", which wasn't an action
  //    difference at all — it just scattered DIRTY and UNMERGED among each
  //    other for no reason a reader could follow.)
  //
  // 2. Newest first, oldest at the bottom, by the branch
  //    tip's commit date — when you last actually worked there. core sorts the
  //    list that way already; this only re-applies it within each group.
  private static readonly BLOCKED_ORDER = ['DIRTY', 'UNMERGED', 'LIVE', 'UNKNOWN'];
  private rank(i: CleanupItem): number {
    if (i.action === 'remove') return 0;
    if (i.action === 'unlock') return 1;
    const k = CleanupComponent.BLOCKED_ORDER.indexOf(String(i.verdict));
    return 2 + (k === -1 ? CleanupComponent.BLOCKED_ORDER.length : k);
  }
  itemsOf(p: CleanupProject): CleanupItem[] {
    return [...p.items].sort((a, b) =>
      this.rank(a) - this.rank(b)
      || String(b.lastCommitAt || '').localeCompare(String(a.lastCommitAt || ''))
      || a.worktree.name.localeCompare(b.worktree.name));
  }

  /** Chats that became archivable because their worktree went in this visit. */
  readyChatsIn(p: CleanupProject): CleanupChat[] {
    const out: CleanupChat[] = [];
    for (const i of p.items) {
      if (!i.chat || !this.isRemoved(i)) continue;
      // Re-check readiness against what's gone NOW: removing this worktree may
      // have been the last thing the chat was waiting on.
      const stillWaiting = i.chat.waitingOn.filter((w) => !(w.why === 'worktree still on disk'
        && (w.worktree === i.worktree.name || (w.taskId != null && w.taskId === i.taskId))));
      if (!stillWaiting.length && !out.some((c) => c.sessionId === i.chat!.sessionId)) {
        out.push({ ...i.chat, ready: true, waitingOn: [],
          tasks: i.chat.tasks.map((t) => ({ ...t, done: true, why: null })) });
      }
    }
    return out;
  }

  isRemoved(i: CleanupItem) { return this.justRemoved().has(i.worktree.path); }

  // --- selection -------------------------------------------------------------
  canSelect(i: CleanupItem) { return i.action === 'remove' && !this.isRemoved(i); }
  isSelected(i: CleanupItem) { return this.selected().has(i.worktree.path); }
  toggle(i: CleanupItem, on: boolean) { this.setSelected([i], on); }
  selectableIn(p: CleanupProject) { return p.items.filter((i) => this.canSelect(i)); }
  private setSelected(items: CleanupItem[], on: boolean) {
    this.selected.update((s) => {
      const n = new Set(s);
      for (const i of items) on ? n.add(i.worktree.path) : n.delete(i.worktree.path);
      return n;
    });
  }
  /** The ticked rows, in the order the table shows them. */
  readonly selectedItems = computed(() => {
    const sel = this.selected();
    return this.projects().flatMap((p) => this.itemsOf(p)).filter((i) => sel.has(i.worktree.path) && this.canSelect(i));
  });
  /** A fresh report drops ticks for rows that are gone or no longer removable. */
  private pruneSelection() { this.selected.set(new Set(this.selectedItems().map((i) => i.worktree.path))); }

  startSelecting() { this.selecting.set(true); }
  stopSelecting() { this.selecting.set(false); this.selected.set(new Set()); }

  // A held row's per-task chips already carry their own `why` (task 126,
  // rendered via app-task-chip's `note`), but a chat with ZERO known tasks has
  // no chip to carry anything, and scanning many rows for the pattern across
  // several task chips is slower than one label per row. This distills
  // `waitingOn` into ONE of the task 144 blocker kinds — never raw prose — so
  // the four kinds (worktree on disk / task not done / no task found / ready)
  // read at a glance in a fixed-width column. "Task not done", not "task
  // open": a task can be OPEN or PARKED and both block equally (isClosed()'s
  // rule) — a chat waiting on even one PARKED task is not "TASK OPEN", and
  // that word would be wrong on the row, not just imprecise. When a chat is
  // blocked by more than one kind at once, "worktree on disk" wins the badge:
  // it is the self-clearing kind (remove the worktree in the table above and
  // it's gone), so it is the more useful thing to surface at a glance — the
  // full mix, statuses included, is still on the task chips beside it.
  //
  // Task 152: the tag NAMES what it waits on — `waiting on #4, #19` instead of
  // the bare "task not done"; a worktree the chat ran in that is still on disk
  // reads `worktree on disk`, with the worktree itself named beside it
  // (heldByWorktrees). "No task found" is gone: a chat that worked on no task
  // and ran in no worktree still on disk is READY.
  blockerKind(c: CleanupChat): string {
    if (c.ready) return 'ready';
    if (this.heldByWorktrees(c).length) return 'worktree on disk';
    return `waiting on #${c.waitingOn.filter((w) => w.taskId).map((w) => w.taskId).join(', #')}`;
  }
  heldByWorktrees(c: CleanupChat): string[] {
    return c.waitingOn.filter((w) => w.worktree).map((w) => w.worktree!);
  }

  // The chip's tooltip fields this page knows (task 154). HOW the chat worked
  // on it — the words after "worked on:" — and why it still holds the chat.
  // Nothing for a looked-up task: "looked up" is the whole story.
  chipHow(t: CleanupChat['tasks'][number]): string | null {
    if (!t.worked) return null;
    return (t.workedBy || []).map((w) => WORKED_BY_WORDS[w] || w).join(', ') || null;
  }
  // "status OPEN" only repeats the status the tooltip already leads with, so it
  // is dropped; the one other reason is shortened to words.
  chipNote(t: CleanupChat['tasks'][number]): string | null {
    if (!t.worked || !t.why || t.why.startsWith('status ')) return null;
    return t.why === 'worktree still on disk' ? 'worktree on disk' : t.why;
  }

  // The chip's tooltip used to be built here (`taskCue`), out of the id, a role
  // sentence and a state word — everything except the one thing a bare number
  // can't tell you, the task's TITLE, which this payload doesn't carry. It now
  // lives in app-task-chip, which resolves the title from the task index and is
  // handed only what THIS page knows: which task the chat drove (`primary`) and
  // why one still blocks archiving (`why`). Task 126.

  // --- removal --------------------------------------------------------------
  askRemoveSelected() { const items = this.selectedItems(); if (items.length) this.pending.set(items); }
  cancelRemove() { if (!this.removing()) this.pending.set([]); }

  /** One request per worktree, in sequence: each runs the server's own checks
   *  and git work, and running them side by side against the same repo would
   *  have them fight over its lock. A refusal on one (it changed since the
   *  page loaded) does not stop the rest — it gets its own toast. */
  async confirmRemove() {
    const items = this.pending();
    if (!items.length || this.removing()) return;
    this.removing.set(true);
    const removed: { item: CleanupItem; undoCmd: string | null }[] = [];
    for (const [n, i] of items.entries()) {
      this.progress.set(n + 1);
      try {
        // `confirm` is the worktree's own name, filled from the row. The server
        // compares it against the worktree it resolved, so a request that
        // hasn't decided WHICH worktree it means cannot pass.
        const res = await firstValueFrom(this.api.removeWorktree(i.project, i.worktree.path, i.worktree.name));
        if (!res.ok) { this.notRemoved(i, res.error); continue; }
        removed.push({ item: i, undoCmd: res.undoCmd });
        this.justRemoved.update((s) => new Set(s).add(i.worktree.path));
      } catch (e) {
        // A refusal arrives as 409 with the ladder's own words — surface those
        // rather than a generic failure, so the reason is actionable.
        this.notRemoved(i, this.reason(e));
      }
    }
    this.removing.set(false);
    this.pending.set([]);
    this.stopSelecting();
    if (removed.length === 1) {
      const { item: i, undoCmd } = removed[0];
      this.toast.add({ severity: 'success', summary: `Removed ${i.worktree.name}`,
        detail: `Branch ${i.worktree.branch} intact${i.verdict === 'PUSHED' ? ` (not merged; also on ${this.originOf(i)})` : ''}. Undo: ${undoCmd}`, life: 9000 });
    } else if (removed.length > 1) {
      this.toast.add({ severity: 'success', summary: `Removed ${removed.length} worktrees`,
        detail: 'Their branches are intact.', life: 9000 });
    }
  }

  private notRemoved(i: CleanupItem, why: string | undefined) {
    this.toast.add({ severity: 'error', summary: `Not removed: ${i.worktree.name}`, detail: why, life: 10000 });
  }

  copy(text: string | null, what: string) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => this.toast.add({ severity: 'success', summary: 'Copied', detail: what, life: 1800 }),
      () => this.toast.add({ severity: 'error', summary: 'Copy failed', detail: what }));
  }

  /** The worktree's own task, when its chat's task list doesn't already
   *  include it — so the one Tasks column shows every id exactly once. */
  ownTaskApart(i: CleanupItem): boolean {
    return !!i.taskId && !(i.chat?.tasks ?? []).some((t) => t.id === i.taskId);
  }

  verdictTone(v: string | null): FlagTone {
    switch (v) {
      case 'REMOVABLE': return 'good';
      // Removable, but NOT the green "done" tone: backed up on origin is not
      // landed (owner, task 174). A plain fact, so neutral.
      case 'PUSHED': return 'neutral';
      case 'UNMERGED': return 'warn';
      case 'DIRTY': return 'review';   // wants a decision, not broken (owner, 2026-09-28)
      case 'LOCKED': return 'warn';
      default: return 'neutral';   // LIVE and anything new: a plain fact
    }
  }

  /** The chip's words. Each verdict reads as its own name, except PUSHED,
   *  which must not pass for merged at a glance. */
  verdictLabel(v: string | null): string {
    return v === 'PUSHED' ? 'pushed, not merged' : String(v ?? '');
  }

  /** The origin ref a PUSHED row's work survives on. */
  originOf(i: CleanupItem): string {
    return i.originRef || `origin/${i.worktree.branch}`;
  }

  /** The server's own words when it sent any, else the transport's. */
  private reason(e: unknown): string {
    const err = e as { error?: { error?: string }; message?: string };
    return String(err?.error?.error || err?.message || e);
  }

  private fail(e: unknown) {
    this.toast.add({ severity: 'error', summary: 'Cleanup', detail: this.reason(e) });
  }
}
