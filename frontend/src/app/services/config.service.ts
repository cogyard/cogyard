import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import { ConfigResponse, CreationDefaults } from './models';

// Resolved machine config (task 060), shared app-wide. Loaded once at startup and
// re-fetched after any Save so the New/Add drawer prefills with the saved defaults
// without a page reload (the "once set, it refills this UI" requirement). The
// `defaults` signal is what the drawer reads; `config` carries the full picture
// the /settings view + first-run wizard render.
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private api = inject(ApiService);

  /** The full resolved config, or null until the first load resolves. */
  readonly config = signal<ConfigResponse | null>(null);
  /** Creation defaults for the New/Add drawer; the built-ins until config loads. */
  readonly defaults = signal<CreationDefaults>({ kind: 'single', store: 'shared' });

  constructor() { this.reload(); }

  /** Fetch /api/config and publish it. Call after a Save to refresh dependents. */
  reload() {
    this.api.config().subscribe({
      next: (c) => { this.config.set(c); this.defaults.set(c.defaults); },
      error: () => { /* keep the last good config (or built-in defaults) on a blip */ },
    });
  }
}
