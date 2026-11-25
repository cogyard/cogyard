import { Component, inject, computed } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { CHECK_MS, RefreshService } from '../../services/refresh.service';

// Data-freshness note: plain text in the sidebar's foot row saying how long ago
// the portal last confirmed with the server that what is on screen is current
// (RefreshService.lastCheck, the last SUCCESSFUL check). It shows only when that
// is overdue — the window was hidden, or the server isn't answering — and is
// empty the rest of the time, so the 1-second clock repaints nothing then.
//
// It used to sit beside a circle that filled over each 10 s cycle. Task 277
// removed the circle: an animated gradient can't run off the page's main thread,
// so it repainted every frame and cost about half a CPU core while visible.
@Component({
  selector: 'app-freshness-note',
  imports: [TooltipModule],
  templateUrl: './freshness-note.component.html',
  styleUrl: './freshness-note.component.scss',
})
export class FreshnessNoteComponent {
  private refresh = inject(RefreshService);

  readonly tooltip = `Time since the portal last reached the server — it checks every ${CHECK_MS / 1000}s`;

  staleLabel = computed(() => {
    const last = this.refresh.lastCheck();
    if (!last) return '';
    const s = Math.floor((this.refresh.now() - last) / 1000);
    if (s < CHECK_MS / 1000 + 3) return ''; // within one cycle (+ slack) is not overdue
    if (s < 90) return `${s}s`;
    return `${Math.round(s / 60)}m`;
  });
}
