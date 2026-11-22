import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { PublishStatus, ReleaseStatus } from '../../services/models';
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

  // Task 264: a project can name several releases (a device's firmware and its
  // website). The server sends every one in `releases` — the flat form as one,
  // nameless release — so the "To publish" part is drawn once per release from
  // the same code. "Right now" keeps its single-release layout for the flat
  // form and becomes one group per release when the project names them.

  /** Does the project name its releases? */
  readonly multi = computed(() => !!this.status()?.declaration.releases);

  /** The labels of the releases a push to main puts live. */
  readonly onPush = computed(() =>
    (this.status()?.releases ?? []).filter((r) => r.declaration.deploysOnPush).map((r) => r.label ?? ''));

  /** The command that publishes this release. */
  cmdOf(r: ReleaseStatus): string {
    return r.name ? `cogyard publish ${this.slug()} ${r.name}` : `cogyard publish ${this.slug()}`;
  }

  /** The tag a publish of this release would set, from its pattern and main's
   *  version; null when it isn't tagged or main has no version. */
  tagNameOf(r: ReleaseStatus): string | null {
    const s = this.status();
    if (!s || !r.declaration.tagFormat || !s.tip?.version) return null;
    return r.declaration.tagFormat.replace('<version>', s.tip.version);
  }

  /** Would a publish of this release go through now (the server's own check).
   *  Not ready, the card names no version: it would be refused. */
  isReadyOf(r: ReleaseStatus): boolean {
    return !!r.ready?.ok;
  }

  /** "To publish v2.9.0" (or "To publish Website web/v2.9.0") when a publish
   *  would go through, else "To publish" (or "To publish Website"). */
  headingOf(r: ReleaseStatus): string {
    const base = r.label ? `To publish ${r.label}` : 'To publish';
    const tag = this.tagNameOf(r);
    return this.isReadyOf(r) && tag ? `${base} ${tag}` : base;
  }

  /** The ready line when a publish would go through: only what cogyard checks
   *  (main against origin as of the last fetch, and the version), never a
   *  promise about checks inside the project's own deploy step. */
  readyTextOf(r: ReleaseStatus): string {
    const s = this.status();
    if (!s) return '';
    const branch = s.defaults.branch ?? 'main';
    const base = `${branch[0].toUpperCase()}${branch.slice(1)} matches ${s.defaults.remote} (as of the last fetch)`;
    const tag = this.tagNameOf(r);
    if (!tag) return `${base}.`;
    const last = r.lastRelease?.tag;
    if (last === tag) return `${base}, and ${tag} is already on this commit, so this is a safe re-run.`;
    if (last) return `${base}, and ${s.tip?.version} is newer than ${last}.`;
    return `${base}, and nothing has been released yet.`;
  }

  /** "11 Website changes since" when the release lists its paths (only commits
   *  touching them count), else "16 commits since". */
  sinceText(r: ReleaseStatus): string {
    const n = r.lastRelease?.unreleased ?? 0;
    const s = n === 1 ? '' : 's';
    return r.lastRelease?.paths.length ? `${n} ${r.label} change${s} since` : `${n} commit${s} since`;
  }

  /** "nothing since in firmware/, platformio.ini" when the release lists its paths. */
  nothingSinceText(r: ReleaseStatus): string {
    const p = r.lastRelease?.paths ?? [];
    return p.length ? `nothing since in ${p.join(', ')}` : 'nothing since';
  }

  /** A recorded publish's release label, for the history list. */
  releaseLabel(name: string | undefined): string {
    if (!name) return '';
    return this.status()?.releases.find((r) => r.name === name)?.label ?? name;
  }

  /** A health URL without its scheme, for the "Watches …" step. */
  host(url: string): string {
    return url.replace(/^https?:\/\//, '');
  }

  /** Just the host of a health URL, for a release group's heading. */
  hostOnly(url: string): string {
    try { return new URL(url).host; } catch { return this.host(url); }
  }

  /** The deploy steps in the order a publish runs them. */
  stepsOf(r: ReleaseStatus): { kind: 'command' | 'manual'; text: string }[] {
    const d = r.declaration;
    return [
      ...(d.command ? [{ kind: 'command' as const, text: d.command }] : []),
      ...(d.manual ?? []).map((text) => ({ kind: 'manual' as const, text })),
    ];
  }

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
