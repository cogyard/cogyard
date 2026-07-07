import { Injectable, signal } from '@angular/core';

const INTERVAL_MS = 7000;
const CLOCK_MS = 1000; // 1s so the "updated Ns ago" age counter ticks visibly

// Shared auto-refresh clock. Views re-run their load() whenever
// tick changes; reads are quiet (no spinner, no UI-state reset). Polling
// pauses while the tab is hidden and bumps immediately on return/focus.
@Injectable({ providedIn: 'root' })
export class RefreshService {
  /** Increments every interval while the tab is visible. Read it in a view's load effect. */
  readonly tick = signal(0);
  /** Epoch ms of the last tick — what the "updated …" affordance is based on. */
  readonly lastRefresh = signal(Date.now());
  /** Coarse clock for re-rendering relative-time labels. */
  readonly now = signal(Date.now());

  private timer: ReturnType<typeof setInterval> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else { this.bump(); this.start(); }
    });
    window.addEventListener('focus', () => this.bump());
    this.start();
  }

  bump() {
    this.tick.update((n) => n + 1);
    this.lastRefresh.set(Date.now());
    this.now.set(Date.now());
  }

  private start() {
    if (!this.timer) this.timer = setInterval(() => this.bump(), INTERVAL_MS);
    if (!this.clock) this.clock = setInterval(() => this.now.set(Date.now()), CLOCK_MS);
  }
  private stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.clock) { clearInterval(this.clock); this.clock = null; }
  }
}
