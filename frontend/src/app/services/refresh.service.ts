import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { tap } from 'rxjs';
import { ApiService } from './api.service';
import { StoreService } from './store.service';
import { fetchFor } from './entries';

// 10 s (owner, 2026-10-06): the worst-case wait for any change to show, since
// nothing is pushed. Graph/Worktrees/Files have no change code and are
// re-downloaded every check, so this also sets their cost — at 10 s they cost
// ~70% of the old 7 s polling; every other entry is only re-sent when it changes.
export const CHECK_MS = 10000;
const CLOCK_MS = 1000; // 1s so relative-time labels tick visibly

// The portal's ONE refresher (task 173; design: docs/LIVE-UPDATES.md).
//
// Components never fetch on a timer: they register as readers of store entries
// (StoreService.use). Every CHECK_MS — and on focus, on becoming visible and on
// coming back online — this sends the watched entries to GET /api/versions,
// which answers a short code per entry computed from file metadata. An entry is
// reloaded only when its code differs from the one it had when last loaded; an
// entry with no code (null — Graph, Worktrees, Files) is reloaded on every
// check, exactly like the old poll. The periodic checks pause while the window
// is hidden, as polling always did.
//
// When an entry gains its first reader, a check runs at once for THAT entry
// only. It used to check everything watched, so a newly shown entry also
// re-downloaded every no-code entry on screen — and when re-rendering those
// made a reader look new again, the two fed each other in a ~10/s loop.
@Injectable({ providedIn: 'root' })
export class RefreshService {
  private api = inject(ApiService);
  private store = inject(StoreService);

  /** Epoch ms of the last successful check — what the topbar freshness pie shows. */
  readonly lastCheck = signal(0);
  /** Coarse clock for re-rendering relative-time labels. */
  readonly now = signal(Date.now());
  /** The SPA build the server serves now (its main script's name), from the
   *  '@build' field every check carries; null until known or when unbuilt. */
  readonly servedBuild = signal<string | null>(null);

  // entry → the code it had when its data was last loaded by a check.
  private loadedAt = new Map<string, string>();
  private checking = false;
  private again = false;          // a full check was asked for while one ran
  private againFresh = new Set<string>(); // first-reader entries that arrived meanwhile
  private timer: ReturnType<typeof setInterval> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else { this.check(); this.start(); }
    });
    window.addEventListener('focus', () => this.check());
    window.addEventListener('online', () => this.check());
    // A newly shown entry loads now, not at the next tick. Batched to the end of
    // the current task: a page registers several entries in one render (the
    // shell's project list and config, a tab and its chips), and they should
    // share one check rather than race several.
    effect(() => { this.store.newReader(); untracked(() => this.checkSoon()); });
    // The periodic timer runs only while the window is visible. A window opened
    // in the background still loads what it shows (the first-reader check above
    // is not gated); it just doesn't keep re-checking until it is looked at.
    if (!document.hidden) this.start();
  }

  private soon: ReturnType<typeof setTimeout> | null = null;
  private checkSoon() {
    if (this.soon) return;
    this.soon = setTimeout(() => { this.soon = null; this.check(this.store.takeFresh()); });
  }

  /** Ask the server which entries changed; reload those. With no argument it
   *  checks every watched entry; with `only`, just those (the first-reader
   *  check). Coalesces: a check requested while one is running runs once more
   *  when it finishes — a full one if any full one was asked for. */
  check(only?: string[]) {
    if (this.checking) {
      if (only) for (const k of only) this.againFresh.add(k); else this.again = true;
      return;
    }
    const keys = only ?? this.store.watched();
    if (!keys.length) return;
    this.checking = true;
    this.api.versions(keys).subscribe({
      next: (codes) => {
        if (codes['@build'] !== undefined) this.servedBuild.set(codes['@build']);
        for (const key of keys) {
          const fetch$ = fetchFor(this.api, key);
          if (!fetch$) continue;
          const code = codes[key] ?? null;
          if (code === null) this.store.load(key, fetch$);
          else if (this.loadedAt.get(key) !== code) {
            this.store.load(key, fetch$.pipe(tap(() => this.loadedAt.set(key, code))));
          }
        }
        // The freshness pie means "everything on screen was checked": a
        // first-reader check counts only when it covered every watched entry
        // (a page's first load, where everything is new).
        if (!only || this.store.watched().every((k) => keys.includes(k))) this.lastCheck.set(Date.now());
      },
      error: () => this.done(), // server restarting / offline: the next check retries
      complete: () => this.done(),
    });
  }

  private done() {
    this.checking = false;
    if (this.again) {
      this.again = false; this.againFresh.clear(); // a full check covers them
      this.check();
    } else if (this.againFresh.size) {
      const fresh = [...this.againFresh].filter((k) => this.store.watched().includes(k));
      this.againFresh.clear();
      this.check(fresh);
    }
  }

  private start() {
    if (!this.timer) this.timer = setInterval(() => this.check(), CHECK_MS);
    if (!this.clock) this.clock = setInterval(() => this.now.set(Date.now()), CLOCK_MS);
  }
  private stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.clock) { clearInterval(this.clock); this.clock = null; }
  }
}
