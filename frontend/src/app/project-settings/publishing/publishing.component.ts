import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { PublishStatus } from '../../services/models';
import { FlagComponent } from '../../shared/flag/flag.component';

// How this project publishes (task 170) — a card on the project's own settings
// tab. Pushing to main deploys nothing; publishing is `cogyard publish <project>`
// run by the owner in a terminal, one fixed sequence (docs/PUBLISH.md).
//
// READ-ONLY, deliberately, and with no Publish button: a button in the portal
// can't tell the owner from an agent calling the same URL, and a publish's
// manual steps ("Press Deploy…" → Done?) need someone at a terminal. The
// declaration is a committed file in the project's repo, so it is edited there.
//
// Everything shown comes from GET /api/publish (core/publish.mjs publishStatus),
// including the defaults — the same constants the CLI runs with, so what this
// card says a publish does is what it does.
@Component({
  selector: 'app-project-publishing',
  imports: [FlagComponent],
  templateUrl: './publishing.component.html',
  styleUrl: './publishing.component.scss',
})
export class PublishingComponent {
  slug = input.required<string>();

  private api = inject(ApiService);

  status = signal<PublishStatus | null>(null);
  loading = signal(true);
  failed = signal(false);
  copied = signal<string | null>(null);

  constructor() {
    // Re-reads when the tab opens on another project. Not on the refresh tick:
    // it asks the project's /health over the network.
    effect(() => {
      const slug = this.slug();
      this.loading.set(true);
      this.failed.set(false);
      this.api.publishStatus(slug).subscribe({
        next: (s) => { this.status.set(s); this.loading.set(false); },
        error: () => { this.failed.set(true); this.loading.set(false); },
      });
    });
  }

  readonly decl = computed(() => this.status()?.declaration ?? null);
  /** Declared and readable — the only state with steps, health and defaults to show. */
  readonly usable = computed(() => { const d = this.decl(); return !!d && d.declared && !d.error; });
  readonly publishCmd = computed(() => `cogyard publish ${this.slug()}`);

  /** The deploy steps in the order a publish runs them. */
  readonly steps = computed(() => {
    const d = this.decl();
    if (!d) return [] as { kind: 'command' | 'manual'; text: string }[];
    return [
      ...(d.command ? [{ kind: 'command' as const, text: d.command }] : []),
      ...(d.manual ?? []).map((text) => ({ kind: 'manual' as const, text })),
    ];
  });

  when(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.set(text);
        setTimeout(() => { if (this.copied() === text) this.copied.set(null); }, 1500);
      },
      () => {},
    );
  }
}
