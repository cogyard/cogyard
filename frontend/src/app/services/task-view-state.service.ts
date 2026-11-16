import { Injectable } from '@angular/core';

// One saved snapshot of the Tasks tab's view controls (mode / grouping /
// category-axis / type filter / search). NOT server data and NOT row-expansion
// (that stays transient) — just the knobs the user set.
export interface TaskViewState {
  mode: 'flat' | 'grouped';
  groupBy: 'status' | 'type' | 'category';
  axisSelect: string;
  typeFilter: string;
  search: string;
}

// Remembers each project's Tasks-tab view controls so they stick when you leave
// the tab and come back. The Tasks component is destroyed on tab switch (the
// shell renders tabs via @switch), so its own signals reset every time; this
// root singleton outlives that teardown and is keyed by project slug, so the
// settings are both sticky AND per-project. Backed by localStorage (one key per
// project, `cogyard-taskview-<slug>`, matching the `cogyard-files-*` convention),
// so the settings also survive a full page reload; the in-memory Map is just a
// read-through cache over it.
@Injectable({ providedIn: 'root' })
export class TaskViewStateService {
  private bySlug = new Map<string, TaskViewState>();
  private key(slug: string) { return `cogyard-taskview-${slug}`; }

  get(slug: string): TaskViewState | undefined {
    const hit = this.bySlug.get(slug);
    if (hit) return hit;
    // Cold cache (e.g. first read after a page reload): hydrate from storage.
    try {
      const raw = localStorage.getItem(this.key(slug));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as TaskViewState;
      this.bySlug.set(slug, parsed);
      return parsed;
    } catch { return undefined; }   // malformed/blocked storage → behave as "no saved state"
  }

  set(slug: string, state: TaskViewState): void {
    this.bySlug.set(slug, state);
    try { localStorage.setItem(this.key(slug), JSON.stringify(state)); } catch { /* storage full/blocked: in-memory still sticks */ }
  }
}
