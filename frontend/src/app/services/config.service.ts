import { Injectable, computed, inject } from '@angular/core';
import { ApiService } from './api.service';
import { StoreService } from './store.service';
import { ConfigResponse, CreationDefaults } from './models';

// Resolved machine config, shared app-wide. A watched store entry ('config',
// task 173): the shared refresher reloads it whenever config.json, the
// open-in targets, the registry or a project icon file changes — so a change
// made from the CLI or another window arrives here too (it used to load once at
// startup and never again). reload() after a Save fetches it immediately. The
// `defaults` signal is what the New/Add drawer reads; `config` carries the full
// picture the /settings view + first-run wizard render.
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private api = inject(ApiService);
  private store = inject(StoreService);

  /** The full resolved config, or null until the first load resolves. */
  readonly config = this.store.use<ConfigResponse>(() => 'config');
  /** Creation defaults for the New/Add drawer; the built-ins until config loads. */
  readonly defaults = computed<CreationDefaults>(() => this.config()?.defaults ?? { kind: 'single' });

  /** Fetch /api/config now. Call after a Save to refresh dependents. A failed
   *  fetch keeps the last good config (or the built-in defaults). */
  reload() { this.store.load('config', this.api.config()); }
}
