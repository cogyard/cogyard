import { Component, input, signal, computed, effect, inject, untracked, OnDestroy } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Skeleton } from 'primeng/skeleton';

// A project's HTML page, shown in the Files tab (task 262). The page loads from
// its own address on the raw route (/api/raw/<project>/<worktree>/<path>), so
// the stylesheets, images and scripts beside it load from the project's folder.
//
// The sandbox is the route's `Content-Security-Policy: sandbox allow-scripts`
// header (`sandbox` alone with `?scripts=0`), never allow-same-origin: the page
// runs in an origin of its own, here or in a tab of its own — it can't reach
// the portal's DOM, can't read /api, and can't write through /api. The iframe
// has NO `sandbox` attribute because the desktop app's Browser pane blocks a
// sandboxed frame from loading any address (net::ERR_BLOCKED_BY_CLIENT); the
// header walls the page off the same way, in every browser.
//
// Known limits: a page that fetch()es files beside it itself is refused (that
// needs CORS, which the server never sends — Babel `src` scripts are the
// exception, inlined by the route); an absolute path (/x.css) resolves against
// the portal's root; the pane's dark switch doesn't reach inside the page.
@Component({
  selector: 'app-html-frame',
  imports: [Skeleton],
  templateUrl: './html-frame.component.html',
  styleUrl: './html-frame.component.scss',
})
export class HtmlFrameComponent implements OnDestroy {
  private san = inject(DomSanitizer);

  src = input.required<string>();   // the page's raw-route address
  scripts = input(true);
  title = input('');

  // A skeleton covers the frame until the page's load event, so a page waiting
  // on web fonts or a CDN never shows as a blank white box. A page whose load
  // never comes (a request that hangs) is shown anyway after LOAD_CAP_MS.
  loaded = signal(false);
  private static readonly LOAD_CAP_MS = 8000;
  private cap: ReturnType<typeof setTimeout> | undefined;

  // Scripts off = the route's stricter header, asked for in the address.
  safeSrc = computed<SafeResourceUrl>(() => {
    const s = this.src();
    return this.san.bypassSecurityTrustResourceUrl(this.scripts() ? s : `${s}${s.includes('?') ? '&' : '?'}scripts=0`);
  });

  constructor() {
    effect(() => {
      this.src(); this.scripts();
      untracked(() => {
        this.loaded.set(false);
        clearTimeout(this.cap);
        this.cap = setTimeout(() => this.loaded.set(true), HtmlFrameComponent.LOAD_CAP_MS);
      });
    });
  }

  onLoad() {
    clearTimeout(this.cap);
    this.loaded.set(true);
  }

  ngOnDestroy() { clearTimeout(this.cap); }
}
