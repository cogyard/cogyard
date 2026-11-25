import { Component, computed, inject, input, signal } from '@angular/core';
import { ConfigService } from '../../services/config.service';

// A project's icon (task 271) — the one component that draws it, wherever a
// project is named: the sidebar's rows, and every project name on the All page.
// It was inline in the app shell, the sidebar being its only user (tasks 114,
// 140); this is that logic moved, unchanged.
//
// A project has an icon when /settings mapped its slug to an image inside its
// own repo (config ui.projectIcons); the file itself comes from
// /api/project-icon. The slot (this element) is drawn either way — that is
// what keeps every project NAME starting at the same x, in the sidebar and in a
// table column alike. An <img> that fails (the file deleted between config read
// and fetch) falls back to the empty slot instead of a broken-image glyph.
//
// The failure is remembered by URL, not slug (task 140): one bad save once wrote
// the project off for the life of the page, so the owner fixed the path and only
// a reload brought the icon back. A URL carries its version, so correcting the
// path asks a new question and the icon retries on its own.
//
// Size: 20px unless the place sets `--logo-size` (or the host's own width and
// height). White border behind the art, only where the icon sits on the dark
// sidebar (`onDark`): the owner's "white border" tick for the project in
// /settings, or `framed` — the selected row, where on the accent fill every
// icon needs the separation. On a white page the border can't be seen and its
// padding only shrank the art, so there the icon is always bare (owner,
// 2026-11-23: "only on the dark sidebar").
@Component({
  selector: 'app-project-logo',
  template: `@if (shown()) { <img [class.bordered]="bordered()" [src]="url()" alt="" (error)="failedUrl.set(url())" /> }`,
  styleUrl: './project-logo.component.scss',
  host: { 'aria-hidden': 'true' },
})
export class ProjectLogoComponent {
  private cfg = inject(ConfigService);
  slug = input.required<string>();
  /** The icon sits on the dark sidebar: the owner's "white border" tick applies. */
  onDark = input(false);
  /** Always draw the white backing (the sidebar's selected row). */
  framed = input(false);

  protected failedUrl = signal<string | null>(null);

  // Content-addressed (task 140): `v` changes whenever the artwork behind this
  // slug does — a different stored path, or the same file edited on disk. A
  // slug-only URL let the browser replay its cached copy after the owner saved
  // a new icon. No version (unreadable file) means no parameter; the 404 that
  // follows is the empty-slot state either way.
  url = computed(() => {
    const v = this.cfg.config()?.projectIconVersions?.[this.slug()];
    const base = `/api/project-icon?slug=${encodeURIComponent(this.slug())}`;
    return v ? `${base}&v=${encodeURIComponent(v)}` : base;
  });
  shown = computed(() => !!this.cfg.config()?.ui?.projectIcons?.[this.slug()] && this.failedUrl() !== this.url());
  bordered = computed(() => this.framed()
    || (this.onDark() && (this.cfg.config()?.ui?.projectIconBorders ?? []).includes(this.slug())));
}
