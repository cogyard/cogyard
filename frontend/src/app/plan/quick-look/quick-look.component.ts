import { Component, HostListener, computed, effect, inject, input, output } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '../../services/api.service';
import { StoreService } from '../../services/store.service';
import { PlanTask, TaskChat, TaskChatsResponse } from '../../services/models';
import { TaskChipComponent } from '../../shared/task-chip/task-chip.component';
import { ActionChipComponent } from '../../shared/action-chip/action-chip.component';
import { FlagComponent } from '../../shared/flag/flag.component';
import { TYPE_ICONS } from '../../shared/task-buckets';

// The Plan tab's quick look (task 179): click a card, see what the task is
// without leaving the page. No labels on anything — each line is recognisable
// by its form: the type icon leads the title; the status line carries the task
// chip and its progress; the owner's steps wear the same flags as the card; the
// chats are the Tasks tab's CHATS rows; the last paragraph is "What this is".
// Dismiss with ✕, Escape or a click outside (the transcript popup's pattern).
@Component({
  selector: 'app-plan-quick-look',
  imports: [TooltipModule, TaskChipComponent, ActionChipComponent, FlagComponent],
  templateUrl: './quick-look.component.html',
  styleUrl: './quick-look.component.scss',
})
export class QuickLookComponent {
  private api = inject(ApiService);
  private store = inject(StoreService);
  task = input.required<PlanTask>();
  slug = input.required<string>();
  close = output<void>();
  openTask = output<string>();

  readonly typeIcons = TYPE_ICONS;

  constructor() {
    // The chats are the Tasks tab's lookup and cache entry (chats|slug|id) —
    // loaded on open, shared with that tab.
    effect(() => {
      const t = this.task(), s = this.slug();
      if (t && s) this.store.load(`chats|${s}|${t.id}`, this.api.taskChats(s, t.id));
    });
  }

  private chatsRes = computed(() => this.store.sig<TaskChatsResponse>(`chats|${this.slug()}|${this.task().id}`)());
  loading = computed(() => this.chatsRes() === null);
  // The chat that created it, then the ones that worked on it (claimed or committed).
  chats = computed<TaskChat[]>(() => {
    const c = this.chatsRes();
    return c ? [...(c.created ? [c.created] : []), ...c.implemented] : [];
  });
  pct = computed(() => (this.task().total ? Math.round((this.task().done / this.task().total) * 100) : 0));
  shortId(c: TaskChat) { return c.sessionId ? c.sessionId.slice(0, 8) : '????????'; }
  plain(s: string) { return String(s).replace(/\*\*|`/g, ''); }

  @HostListener('document:keydown.escape') onEscape() { this.close.emit(); }
}
