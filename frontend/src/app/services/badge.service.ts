import { Injectable, inject } from '@angular/core';
import { ApiService } from './api.service';

const POLL_MS = 60_000;

// Dock badge for Safari "Add to Dock" web apps (and any browser supporting the
// Badging API): claimed tasks across all projects — the projects with work in
// flight right now (task 85; was unmerged worktrees).
//
// SINGLE WRITER PER SURFACE. Inside the Electron desktop shell the NATIVE poller
// (extras/desktop/main.mjs pollTick) owns the dock badge; this renderer service stays
// out of its way. Two writers on one dock badge — even when they "should" agree
// — is exactly the 14↔7 flip bug: the native side and this renderer once summed
// DIFFERENT metrics (unmerged worktrees vs claimed tasks), each overwriting the
// other on its timer. Both now sum `claimed`, but the real fix is still one writer.
// So in the shell this is a no-op; in a plain browser / "Add to Dock" PWA there is
// NO native writer, so the renderer is the sole one.
//
// Runs on its own timer, deliberately NOT the shared RefreshService — that one
// pauses while the tab is hidden, and hidden/backgrounded is exactly when the
// badge matters. No-op where navigator.setAppBadge doesn't exist.
@Injectable({ providedIn: 'root' })
export class BadgeService {
  private api = inject(ApiService);

  constructor() {
    if (!('setAppBadge' in navigator)) return;
    // In the Electron desktop shell the native poller is the sole badge writer
    // (see above) — the renderer must not also write it, or the two fight.
    if (/\bElectron\//.test(navigator.userAgent)) return;
    // Safari only shows badges once notifications are allowed; permission
    // requests need a user gesture, so piggyback on the first click.
    document.addEventListener('click', () => {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    }, { once: true });
    this.refresh();
    setInterval(() => this.refresh(), POLL_MS);
  }

  private refresh() {
    // /api/projects carries each project's claimed-task count (frontmatter read,
    // no git) — cheap to poll. Same number the desktop dock badge sums.
    this.api.projects().subscribe({
      next: (ps) => {
        const n = ps.reduce((sum, p) => sum + (p.claimed || 0), 0);
        if (n > 0) navigator.setAppBadge?.(n);
        else navigator.clearAppBadge?.();
      },
      error: () => {}, // offline/server restart: keep the last badge rather than flashing it away
    });
  }
}
