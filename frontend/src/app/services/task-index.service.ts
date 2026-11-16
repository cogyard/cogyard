import { Injectable, Signal, computed, inject } from '@angular/core';
import { StoreService } from './store.service';
import { TasksResponse } from './models';

// The one fact a #NN chip needs and no chip payload carries: what task IS that?
//
// Every tab that renders a task id (Cleanup, Graph, Worktrees, Branches, the
// Stats calendar) gets the id from its OWN endpoint — a worktree's claim, a
// commit subject's `[#NN]`, a chat's derived task set — and none of them carry
// the task's title or its status. Rather than widen five payloads with the same
// two fields, this reads the ONE payload that already has them: `GET /api/tasks`,
// cached in StoreService under `tasks|<slug>` (the same key the Tasks tab loads,
// so a visit to either warms the other).
//
// Consumers: `app-task-chip` only. If a second one appears, it reads through here
// too — the point is one lookup, not five copies of `find(t => t.id === id)`.
@Injectable({ providedIn: 'root' })
export class TaskIndexService {
  private store = inject(StoreService);

  private maps = new Map<string, Signal<Map<string, TaskRow>>>();

  /** id → the task row, for one project. Empty until the list lands. */
  index(slug: string): Signal<Map<string, TaskRow>> {
    let sig = this.maps.get(slug);
    if (!sig) {
      const src = this.store.sig<TasksResponse>(`tasks|${slug}`);
      sig = computed(() => {
        const m = new Map<string, TaskRow>();
        for (const t of src()?.tasks ?? []) if (t?.id != null) m.set(idKey(t.id), t as TaskRow);
        return m;
      });
      this.maps.set(slug, sig);
    }
    return sig;
  }

  /** One task, or null while the list is still loading / if the id is unknown. */
  get(slug: string, id: string): TaskRow | null {
    return this.index(slug)().get(idKey(id)) ?? null;
  }

  // Register the caller as a READER of the project's task list for as long as it
  // is on screen (task 173). Call from an injection context — the chip's
  // constructor. This used to fetch the list once if empty and never again, so
  // a chip on a tab that doesn't itself reload the list (Graph, Worktrees,
  // Branches, Cleanup, the Stats calendar) kept a claimed task green until you
  // visited Tasks. As a reader, the chip makes 'tasks|<slug>' a watched entry,
  // and the shared refresher reloads it whenever it changes. Ten chips are one
  // reader count and one request.
  watch(slug: () => string | null): void {
    this.store.use<TasksResponse>(() => { const s = slug(); return s ? `tasks|${s}` : null; });
  }
}

// Ids compare the way core/validate.mjs normalizeTaskId does: stores disagree on
// zero-padding (`id: 040e` in one file, `40e` from another source), so `040e`,
// `40e` and `040` / `40` must each land on one key — or a chip for a
// padded id renders unfilled, as if the task did not exist.
function idKey(id: string | number): string {
  const m = String(id).trim().match(/^0*(\d+)(?:[._]0*(\d+))?([a-z])?$/);
  return m ? `${Number(m[1])}${m[2] != null ? '.' + Number(m[2]) : ''}${m[3] || ''}` : String(id);
}

/** The subset of a /api/tasks row a chip reads. `bucket` is server-computed
 *  (core/status.mjs bucketOf) — the SPA consumes it, never re-derives it. */
export interface TaskRow {
  id: string | number;
  title: string;
  status: string;
  file: string;
  bucket: string;
  claimedByName?: string | null;
  claimedAt?: string | null;
  claimedBy?: string | null;
}
