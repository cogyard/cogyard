import { DestroyRef, Injectable, Signal, WritableSignal, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable } from 'rxjs';

// Signal store: one cached signal per data key ('tasks|cogyard',
// 'graph|claw', 'overview', …). Views render straight from the cached signal —
// so returning to a tab paints the last-known data instantly.
//
// ONE STORE, MANY READERS, ONE REFRESHER (task 173). Components never fetch on a
// timer. They call use(key) to say "I read this entry while I'm on screen"; the
// store counts readers per entry, and RefreshService — the only refresher —
// periodically asks the server which watched entries changed and reloads those
// (entries.ts says how to fetch each kind). Before this, each tab reloaded only
// the keys it owned, so data read on a tab that didn't own it (the task chips on
// Graph/Worktrees/…) went stale until you visited a tab that did.
// Plain signals, no NGXS/NgRx: state here is read-only server data.
@Injectable({ providedIn: 'root' })
export class StoreService {
  private cache = new Map<string, WritableSignal<any>>();
  private inflight = new Set<string>();
  private readers = new Map<string, number>();
  // Entries that gained their first reader since RefreshService last took them.
  private fresh = new Set<string>();

  // Epoch ms of the last response written into the cache.
  readonly lastWrite = signal(0);
  /** Bumps whenever an entry gains its FIRST reader — RefreshService checks right
   *  away then, so a newly shown entry loads without waiting for the next tick. */
  readonly newReader = signal(0);

  // Stable signal for a key; null until the first load lands.
  sig<T>(key: string): WritableSignal<T | null> {
    let s = this.cache.get(key);
    if (!s) { s = signal<T | null>(null); this.cache.set(key, s); }
    return s as WritableSignal<T | null>;
  }

  // Fetch into the key's signal unless a fetch for it is already in flight.
  // Errors keep the last good data — the next check retries.
  load<T>(key: string, fetch$: Observable<T>): void {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    fetch$.subscribe({
      next: (d) => { this.sig<T>(key).set(d); this.lastWrite.set(Date.now()); },
      error: () => this.inflight.delete(key),
      complete: () => this.inflight.delete(key),
    });
  }

  /** Register the calling component (or service) as a reader of the entry `key()`
   *  names — re-registering when it changes, releasing on destroy — and return
   *  that entry's data. Call from an injection context (a field initializer or
   *  constructor). A null key reads nothing. */
  use<T>(key: () => string | null): Signal<T | null> {
    let held: string | null = null;
    const release = () => { if (held) this.release(held); held = null; };
    effect(() => {
      const k = key();
      untracked(() => {
        if (k === held) return;
        release();
        if (k) { this.acquire(k); held = k; }
      });
    });
    inject(DestroyRef).onDestroy(release);
    return computed(() => { const k = key(); return k ? this.sig<T>(k)() : null; });
  }

  /** The entries something on screen is reading right now. */
  watched(): string[] { return [...this.readers.keys()]; }

  /** The entries that gained their first reader since the last call, and still
   *  have one — what the first-reader check is about. Clears the list. */
  takeFresh(): string[] {
    const keys = [...this.fresh].filter((k) => this.readers.has(k));
    this.fresh.clear();
    return keys;
  }

  private acquire(key: string) {
    const n = this.readers.get(key) ?? 0;
    this.readers.set(key, n + 1);
    if (n === 0) { this.fresh.add(key); this.newReader.update((v) => v + 1); }
  }
  // Released after the current render, not on the spot. When a list re-renders,
  // a row's reader is destroyed and its replacement registers a moment later in
  // the same render. Released at once, the entry dropped to zero readers in
  // between, the replacement counted as a FIRST reader, and that fired a check —
  // which re-downloads Graph/Worktrees (they have no change code), re-rendering
  // the rows again: a ~10/s loop that swallowed clicks and flickered tooltips
  // wherever a single task chip held a project's task list.
  private release(key: string) {
    setTimeout(() => {
      const n = (this.readers.get(key) ?? 0) - 1;
      if (n > 0) this.readers.set(key, n); else this.readers.delete(key);
    });
  }
}
