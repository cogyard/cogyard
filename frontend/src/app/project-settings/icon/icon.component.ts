import { Component, inject, input, signal, computed, effect, untracked, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Checkbox } from 'primeng/checkbox';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { ConfigService } from '../../services/config.service';

// This project's rail icon (task 114) — a card on the project's own settings tab
// (task 135). It used to be a table of every registered project on the global
// /settings page, which is where it lived only because no per-project surface
// existed; one project's icon is a setting OF that project.
//
// The path is relative to this project's repo root; the file is served by
// GET /api/project-icon. Persisted as config ui.projectIcons through the same
// POST /api/config every other settings card saves through — and the whole map
// is sent, this project's key edited in place, so saving here can never drop
// another project's icon.
//
// WHAT TASK 140 ADDED, and why each part exists:
//
//  * The preview follows the DRAFT, not the saved value. It used to point at
//    /api/project-icon, which reads config — so typing a path changed nothing on
//    screen and the only feedback came after writing to config.
//  * It previews on BOTH backgrounds. The rail is indigo, but the SELECTED row
//    forces a white plate behind the icon, so artwork has to survive both. One
//    swatch could not show that, and nothing else in the portal said it: the
//    owner set a black-on-transparent logo, saw a white rectangle, and had no
//    way to learn that the file was fine and the contrast was not.
//  * A picker lists the repo's images. Free text stays — the picker offers,
//    nothing pre-fills. That is the line task 114 drew (no auto-detection) and
//    it is intact; see the header of core/project-icons.mjs.
//  * Copy instructions hands a project's own agent the whole spec. The both
//    -backgrounds rule is impossible to guess and was written down nowhere.
@Component({
  selector: 'app-project-icon',
  imports: [FormsModule, InputText, Checkbox],
  templateUrl: './icon.component.html',
  styleUrl: './icon.component.scss',
})
export class ProjectIconComponent implements OnDestroy {
  slug = input.required<string>();

  private api = inject(ApiService);
  private cfg = inject(ConfigService);
  private toast = inject(MessageService);

  /** Draft path for THIS project; seeded from the saved config, edited in place. */
  path = signal<string>('');
  border = signal(false);
  saving = signal(false);

  /** The repo's image files, for the picker. Empty until the fetch resolves. */
  images = signal<string[]>([]);
  pickerOpen = signal(false);
  /** The "what works here" panel. Closed by default — a settings card is not a manual. */
  helpOpen = signal(false);
  private repoPath = signal<string>('');
  private extensions = signal<string[]>([]);

  // Draft validation (task 140). 'idle' = empty field, nothing to say.
  // 'checking' while the probe is in flight, so a slow answer doesn't read as a
  // silent pass. 'ok' carries a blob URL BOTH swatches render — one fetch, and
  // no second opinion about whether the file resolved.
  private state = signal<'idle' | 'checking' | 'ok' | 'bad'>('idle');
  private message = signal<string>('');
  private blobUrl = signal<string>('');
  private probe = 0; // generation counter — a slow probe must not overwrite a newer one

  checking = computed(() => this.state() === 'checking');
  valid = computed(() => this.state() === 'ok');
  problem = computed(() => (this.state() === 'bad' ? this.message() : ''));
  previewSrc = computed(() => this.blobUrl());
  /** Draft differs from what's stored — the swatches are showing something unsaved. */
  dirty = computed(() => this.path().trim() !== this.savedPath());

  constructor() {
    // Seed (and re-seed after a save, or when the tab opens on another project)
    // from the resolved config. The writes are untracked: this effect must depend
    // on the CONFIG only. Letting it also depend on what it writes is how the
    // first cut of this card spun — seeding reached the probe, the probe touched
    // its own signals, and the effect re-ran on its own output, thousands of
    // requests deep.
    effect(() => {
      const c = this.cfg.config();
      const slug = this.slug();
      if (!c) return;
      untracked(() => {
        this.path.set(c.ui?.projectIcons?.[slug] ?? '');
        this.border.set((c.ui?.projectIconBorders ?? []).includes(slug));
      });
    });

    // Probe whichever path is in the field — typed, picked, or just seeded. Its
    // own effect, reading exactly two signals, so there is one code path for
    // "the draft changed" no matter who changed it.
    effect(() => {
      const rel = this.path().trim();
      const slug = this.slug();
      untracked(() => this.schedule(slug, rel));
    });

    // The picker's candidates, per project.
    effect(() => {
      const slug = this.slug();
      untracked(() => {
        this.pickerOpen.set(false);
        this.api.projectImages(slug).subscribe({
          next: (r) => { this.images.set(r.images); this.repoPath.set(r.repoPath); this.extensions.set(r.extensions); },
          error: () => { this.images.set([]); },
        });
      });
    });
  }

  ngOnDestroy() { clearTimeout(this.timer); this.revoke(); }

  setPath(value: string) { this.path.set(value); }
  clear() { this.setPath(''); }
  choose(rel: string) { this.setPath(rel); this.pickerOpen.set(false); }
  togglePicker() { this.pickerOpen.update((o) => !o); }
  /** A picker row's thumbnail — the same draft-preview endpoint, one path each. */
  thumbUrl(rel: string) {
    return `/api/project-icon?slug=${encodeURIComponent(this.slug())}&path=${encodeURIComponent(rel)}`;
  }

  // Typing is a keystroke at a time; the probe waits for a pause so the field
  // isn't answering a question the owner is still asking. An empty field needs
  // no round trip and clears immediately.
  private timer: ReturnType<typeof setTimeout> | undefined;
  private schedule(slug: string, rel: string) {
    clearTimeout(this.timer);
    if (!rel) { this.probe++; this.revoke(); this.state.set('idle'); this.message.set(''); return; }
    this.state.set('checking');
    this.timer = setTimeout(() => this.check(slug, rel), 250);
  }

  // Probe the draft path and keep the bytes. Fetching rather than pointing an
  // <img> at the URL buys the REASON a path failed — the endpoint distinguishes
  // "no such file" from "not an image" from "escapes the project", and an <img>
  // error event says only that something went wrong. It also means ONE request
  // feeds both swatches, off one blob.
  private async check(slug: string, rel: string) {
    const gen = ++this.probe;
    this.revoke();
    try {
      const url = `/api/project-icon?slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(rel)}`;
      const res = await fetch(url);
      if (gen !== this.probe) return; // a newer keystroke already owns the field
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        this.state.set('bad');
        this.message.set(body?.error || (res.status === 404 ? 'no such file in this repo' : 'could not read that file'));
        return;
      }
      const blob = await res.blob();
      if (gen !== this.probe) return;
      this.blobUrl.set(URL.createObjectURL(blob));
      this.state.set('ok');
      this.message.set('');
    } catch {
      if (gen !== this.probe) return;
      this.state.set('bad');
      this.message.set('could not reach the server');
    }
  }

  private revoke() {
    const u = this.blobUrl();
    if (u) URL.revokeObjectURL(u);
    this.blobUrl.set('');
  }

  private savedPath() { return this.cfg.config()?.ui?.projectIcons?.[this.slug()] ?? ''; }

  // The brief the owner pastes into an agent working inside this project. Every
  // number in it is read from the live CSS and the API rather than retyped here:
  // a brief that drifts from what the rail actually does is worse than none.
  copyInstructions() {
    const css = getComputedStyle(document.documentElement);
    const railBg = (css.getPropertyValue('--app-sidebar-bg').trim() || '#3f3d9e');
    const slot = document.querySelector('.sidebar-item .si-icon');
    const px = slot ? Math.round(slot.getBoundingClientRect().width) : 20;
    const exts = this.extensions().length ? this.extensions() : ['.svg', '.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.avif'];
    const repo = this.repoPath() || '(this project\'s repo root)';

    const text = [
      `Make (or find) a logo for the project "${this.slug()}" so it renders correctly in the cogyard sidebar.`,
      ``,
      `REPO: ${repo}`,
      `The image must live inside that repo. Report the path RELATIVE TO THE REPO ROOT.`,
      ``,
      `WHERE IT RENDERS`,
      `- A ${px}x${px} px slot in a vertical sidebar, scaled with object-fit: contain.`,
      `- The artwork is shown as-is. Nothing resizes it, recolours it, adds a`,
      `  background, or converts the format.`,
      ``,
      `THE PART THAT IS EASY TO GET WRONG — IT MUST WORK ON TWO BACKGROUNDS`,
      `- Idle row:     the sidebar's indigo, ${railBg}`,
      `- Selected row: a white rounded plate placed behind the icon`,
      `A single-ink glyph on a transparent background therefore FAILS one of the`,
      `two: black art vanishes on the indigo, white art vanishes on the white`,
      `plate. Artwork that works in both states either carries its own background`,
      `(a filled tile or circle in a brand colour, with the mark knocked out of`,
      `it), or is two-tone / outlined so some part of it contrasts either way.`,
      `Check your artwork against BOTH before reporting back.`,
      ``,
      `FORMAT`,
      `- Accepted: ${exts.join(' ')}`,
      `- SVG preferred. It is rendered inside an <img>, so it CANNOT inherit page`,
      `  CSS: currentColor and external CSS variables will not resolve. Every`,
      `  colour must be a literal value in the file.`,
      `- Raster: at least 64x64 and roughly square. Wide artwork letterboxes into a`,
      `  thin sliver inside a square slot.`,
      ``,
      `PATH RULES`,
      `- Repo-root-relative (e.g. public/favicon.svg or branding/icon.svg).`,
      `- Absolute paths and ".." segments are rejected.`,
      ``,
      `IF A LOGO ALREADY EXISTS in this repo, do not generate a new one. Say where`,
      `it is and whether it satisfies the two-background rule above.`,
      ``,
      `REPORT BACK: the repo-root-relative path, verbatim, so it can be pasted into`,
      `cogyard's Icon field. Also say whether it needs the "white border" option`,
      `ticked — that puts a white plate behind the icon on idle rows too, which`,
      `helps artwork drawn for white backgrounds.`,
    ].join('\n');

    navigator.clipboard.writeText(text).then(
      () => this.toast.add({ severity: 'success', summary: 'Instructions copied', detail: 'Paste them into an agent working in this project.' }),
      () => this.toast.add({ severity: 'error', summary: 'Copy failed', detail: 'The browser refused clipboard access.' }),
    );
  }

  save() {
    this.saving.set(true);
    const slug = this.slug();
    const cfg = this.cfg.config();
    // Read-modify-write the WHOLE map: the server sanitizes, so a blank value
    // drops this project's key rather than leaving it in config.json — and every
    // other project's entry travels back untouched.
    const icons = { ...(cfg?.ui?.projectIcons ?? {}), [slug]: this.path() };
    const borders = new Set(cfg?.ui?.projectIconBorders ?? []);
    if (this.border() && this.path().trim()) borders.add(slug); else borders.delete(slug);

    this.api.saveConfig({ ui: { projectIcons: icons, projectIconBorders: [...borders] } }).subscribe({
      next: () => {
        this.saving.set(false);
        this.cfg.reload(); // the rail reads ConfigService — the icon appears without a reload
        this.toast.add({ severity: 'success', summary: 'Project icon saved' });
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Save failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }
}
