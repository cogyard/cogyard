import { Injectable, WritableSignal, signal } from '@angular/core';
import { Observable } from 'rxjs';

// Signal store (task 8): one cached signal per data key ('tasks|cogyard',
// 'graph|claw', 'overview', …). Views render straight from the cached signal —
// so returning to a tab paints the last-known data instantly — and call load()
// (on slug change / refresh tick) to quietly swap fresh data in behind it.
// Plain signals, no NGXS/NgRx: state here is read-only server data; revisit if
// task 12's write actions ever need optimistic client mutations.
@Injectable({ providedIn: 'root' })
export class StoreService {
  private cache = new Map<string, WritableSignal<any>>();
  private inflight = new Set<string>();

  // Epoch ms of the last response written into the cache — i.e. when the data
  // on screen actually arrived. Feeds the topbar data-freshness pie.
  readonly lastWrite = signal(0);

  // Stable signal for a key; null until the first load lands.
  sig<T>(key: string): WritableSignal<T | null> {
    let s = this.cache.get(key);
    if (!s) { s = signal<T | null>(null); this.cache.set(key, s); }
    return s as WritableSignal<T | null>;
  }

  // Fetch into the key's signal unless a fetch for it is already in flight.
  // Errors keep the last good data — the next tick retries.
  load<T>(key: string, fetch$: Observable<T>): void {
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    fetch$.subscribe({
      next: (d) => { this.sig<T>(key).set(d); this.lastWrite.set(Date.now()); },
      error: () => this.inflight.delete(key),
      complete: () => this.inflight.delete(key),
    });
  }
}
