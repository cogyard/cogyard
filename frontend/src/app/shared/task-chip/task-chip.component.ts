import { Component, computed, inject, input, output } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { TaskIndexService } from '../../services/task-index.service';
import { TaskState, bucketKeyOf, taskStateOf, taskStateWord } from '../task-buckets';

// ONE rendering for "a task", used everywhere a #NN or a task's status word
// appears. The id chip and the status word are the same thing — a task,
// coloured by its status — showing a different face, so they are one component
// with a `show` input (task 155; was app-task-ref, task 126).
//
// Before task 126 the id chip rendered four different ways across eight places
// — an accent-underlined link on Graph / Worktrees / Branches and in Cleanup's
// Task column, a plain pill on the Stats calendar, and a DEAD tinted pill in
// Cleanup's chat column and its ready-to-archive list — and the one page that
// coloured its chips did so by a done/not-done rule of its own. Before task 155
// the Tasks tab drew its status words with a second set of rules (.st-*).
//
// The contract:
//   show="id"      [#NN] — a BUTTON that opens the task on the Tasks tab.
//                  Filled by the task's bucket, FOUR colours: Idle · Claimed ·
//                  Waiting · Done (DONE/ENOUGH/OBSOLETE all wear the done grey).
//                  Unfilled when the id resolves to no task. Tooltip: STATUS ·
//                  action · title · note. `role="primary"` adds the worked-on ring.
//   show="status"  the status WORD (IDLE, CLAIMED, WAITING, DONE, ENOUGH,
//                  OBSOLETE) — a SPAN, not clickable. The three active states
//                  are the id chip's colours; the closed ones get three greys
//                  of one family. Tooltip: the claim holder when claimed.
//                  `state` stands in for `id` where the chip names a status
//                  rather than one task (the Tasks tab's grouped-by-status
//                  headings) — the heading and the row badge are then the same
//                  element, so they cannot look different.
//
// Title and status are RESOLVED here (TaskIndexService), never passed in — that
// is what stops the call sites drifting again. A caller supplies only what its
// own context knows: the id, and optionally the role/note that context adds
// (Cleanup knows which task a chat actually drove, and why one still blocks
// archiving; nothing else does).
//
// The chip's LOOK (.tchip / .tchip-primary / data-bucket / data-state) lives in
// styles.scss — Cleanup's colour key wears the same classes on spans.
@Component({
  selector: 'app-task-chip',
  imports: [TooltipModule],
  templateUrl: './task-chip.component.html',
  styleUrl: './task-chip.component.scss',
})
export class TaskChipComponent {
  id = input<string | number | null>(null);
  /** The project the id belongs to — the lookup is per-project. */
  slug = input.required<string>();
  /** Which face: the #NN control, or the status word. */
  show = input<'id' | 'status'>('id');
  /** show="status" with no id: the status this chip names (a section heading). */
  state = input<TaskState | null>(null);
  /** Cleanup's ring: a task the chat worked on vs one it only looked up (task 152). */
  role = input<'primary' | 'referenced' | null>(null);
  /** Which actions made it "worked on", as single words (commit, claim, …). */
  how = input<string | null>(null);
  /** Extra tooltip field — Cleanup's "why this still blocks archiving". */
  note = input<string | null>(null);

  open = output<string>();

  private tasks = inject(TaskIndexService);

  constructor() {
    // The chip READS the task list, so it registers as a reader: the list loads
    // if nothing has yet (Cleanup opened straight from the sidebar, say), and
    // the shared refresher keeps it current on every tab (task 173).
    this.tasks.watch(() => this.slug());
  }

  readonly key = computed(() => String(this.id() ?? ''));
  private row = computed(() => (this.id() == null ? null : this.tasks.get(this.slug(), this.key())));

  /** null → no fill. An unresolved id must not borrow a status it may not have. */
  readonly bucket = computed(() => {
    const r = this.row();
    return r ? bucketKeyOf(r) : null;
  });

  /** The six-way state for the status word; null when nothing resolves. */
  readonly current = computed<TaskState | null>(() => {
    const given = this.state();
    if (given) return given;
    const r = this.row();
    return r ? taskStateOf(r) : null;
  });
  readonly word = computed(() => {
    const s = this.current();
    return s ? taskStateWord(s) : '?';
  });

  // Terse fields, not sentences (task 154): STATUS · action · title · note.
  // The id is already on the chip, so it isn't repeated here.
  //
  // STATUS is the word the chip's COLOUR stands for — IDLE, CLAIMED, WAITING,
  // or the closed status (DONE / ENOUGH / OBSOLETE) — the same word
  // show="status" prints. NOT the task file's raw `status` field: an idle task
  // and a claimed one are both OPEN there, and a task waiting on a dependency is
  // OPEN too, so a blue chip read "OPEN" and a yellow one "PARKED".
  readonly tip = computed(() => {
    const r = this.row();
    if (!r) return 'unknown task';
    const role = this.role();
    const how = this.how();
    const action = role === 'primary' ? (how ? `worked on: ${how}` : 'worked on')
      : role === 'referenced' ? 'looked up' : null;
    return [taskStateWord(taskStateOf(r)).toUpperCase(), action, r.title, this.note()]
      .filter(Boolean).join(' · ');
  });

  // The status word already says the status; what it can add is WHO holds a
  // claim (name · since · session), so the tooltip exists only when claimed.
  readonly statusTip = computed(() => {
    const r = this.row();
    if (!r || this.current() !== 'claimed') return '';
    const parts: string[] = [r.claimedByName || 'claimed'];
    if (r.claimedAt) parts.push(`since ${new Date(r.claimedAt).toLocaleString()}`);
    if (r.claimedBy) parts.push(`session ${r.claimedBy}`);
    return parts.join(' · ');
  });
}
