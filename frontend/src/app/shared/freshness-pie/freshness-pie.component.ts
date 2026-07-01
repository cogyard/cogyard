import { Component, inject, computed, effect, viewChild, ElementRef } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { RefreshService } from '../../services/refresh.service';
import { StoreService } from '../../services/store.service';

// Data-freshness affordance (task 008): a circle that fills radially over the
// 7s poll cycle and restarts when a response actually ARRIVES (a store write).
// Age text appears only when the data is overdue (tab was hidden or requests
// are failing); inside the normal cycle the pie alone suffices.
@Component({
  selector: 'app-freshness-pie',
  imports: [TooltipModule],
  templateUrl: './freshness-pie.component.html',
  styleUrl: './freshness-pie.component.scss',
})
export class FreshnessPieComponent {
  private store = inject(StoreService);
  private refresh = inject(RefreshService);
  private pie = viewChild<ElementRef<HTMLElement>>('pie');

  constructor() {
    // Restart the fill via the Web Animations API on every write. NOT done by
    // swapping CSS animation-names on writeCount parity: two responses landing
    // in one cycle (Branches loads two keys per tick) flip parity twice — same
    // name, no restart, pie sticks at full. Cancel-and-animate is per-write.
    // (--pie-p is a registered @property in styles.scss; interpolation needs it.)
    effect(() => {
      const write = this.store.lastWrite();
      const el = this.pie()?.nativeElement;
      if (!write || !el) return;
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(
        [{ '--pie-p': '0%' }, { '--pie-p': '100%' }] as Keyframe[],
        { duration: 7000, easing: 'linear', fill: 'forwards' },
      );
    });
  }

  staleLabel = computed(() => {
    const last = this.store.lastWrite();
    if (!last) return '';
    const s = Math.floor((this.refresh.now() - last) / 1000);
    if (s < 8) return '';
    if (s < 90) return `${s}s`;
    return `${Math.round(s / 60)}m`;
  });
}
