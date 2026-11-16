import { Component, input, computed } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';

// A prominent "open this repo's origin on GitHub" link, at the top of the
// Branches tab and first in the Graph tab's action bar. With no origin remote
// it renders nothing — unless `showNone`, which says "ORIGIN → none" instead
// (the Graph bar always starts with the origin, task 191). `inBar` drops the
// gap it keeps below itself when standing alone. The label is the owner/repo
// slug parsed from the browse URL.
@Component({
  selector: 'app-origin-link',
  imports: [TooltipModule],
  templateUrl: './origin-link.component.html',
  styleUrl: './origin-link.component.scss',
})
export class OriginLinkComponent {
  url = input.required<string | null>();
  showNone = input(false);
  inBar = input(false);

  // owner/repo from the trailing two path segments; falls back to the bare host.
  label = computed(() => {
    const u = this.url();
    if (!u) return '';
    const parts = u.replace(/^https?:\/\//, '').split('/').filter(Boolean);
    return parts.length >= 3 ? parts.slice(-2).join('/') : parts.join('/');
  });
}
