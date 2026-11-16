import { Component, inject, computed, effect, viewChild, ElementRef } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { CHECK_MS, RefreshService } from '../../services/refresh.service';

// Data-freshness affordance: a circle that fills radially over the refresh
// cycle and restarts on every SUCCESSFUL CHECK — the moment the portal last
// confirmed with the server that what is on screen is current. (It used to
// restart when data arrived; since task 173 unchanged data is not re-sent, so
// "arrived" would read as stale while the data is in fact current.)
// Age text appears only when the data is overdue (tab was hidden or checks are
// failing); inside the normal cycle the pie alone suffices.
@Component({
  selector: 'app-freshness-pie',
  imports: [TooltipModule],
  templateUrl: './freshness-pie.component.html',
  styleUrl: './freshness-pie.component.scss',
})
export class FreshnessPieComponent {
  private refresh = inject(RefreshService);
  private pie = viewChild<ElementRef<HTMLElement>>('pie');

  constructor() {
    // Restart the fill via the Web Animations API on every check. NOT done by
    // swapping CSS animation-names on a counter's parity: two restarts in one
    // cycle flip parity twice — same name, no restart, pie sticks at full.
    // Cancel-and-animate is per-restart.
    // (--pie-p is a registered @property in styles.scss; interpolation needs it.)
    effect(() => {
      const checked = this.refresh.lastCheck();
      const el = this.pie()?.nativeElement;
      if (!checked || !el || typeof el.animate !== 'function') return; // no Web Animations (jsdom)
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(
        [{ '--pie-p': '0%' }, { '--pie-p': '100%' }] as Keyframe[],
        { duration: CHECK_MS, easing: 'linear', fill: 'forwards' },
      );
    });
  }

  staleLabel = computed(() => {
    const last = this.refresh.lastCheck();
    if (!last) return '';
    const s = Math.floor((this.refresh.now() - last) / 1000);
    if (s < CHECK_MS / 1000 + 3) return ''; // within one cycle (+ slack) is not overdue
    if (s < 90) return `${s}s`;
    return `${Math.round(s / 60)}m`;
  });
}
