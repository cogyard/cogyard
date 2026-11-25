import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { SelectButton } from 'primeng/selectbutton';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { RebaseSwitch, SwitchesResponse, VersionSwitch } from '../../services/models';

// This project's switches (task 246) — a card on the project's own settings
// tab, under Publishing. Three of them: whether merging and resuming a task
// rebase onto main without asking, what merging does to the version, and
// (task 276) whether merging checks the project's decisions log, and where it is.
//
// The values live in the project's task store (switches.json), so every
// worktree sees a change at once. GET/POST /api/switches; the defaults come
// from the server (core/switches.mjs), never from here — what this card calls
// the default is what the skills do.
//
// A switch the project doesn't set shows its default and says so. Choosing a
// value sets it; "use the default" unsets it again.
type VersionKind = 'off' | 'minor' | 'patch' | 'command';

@Component({
  selector: 'app-project-switches',
  imports: [FormsModule, InputText, SelectButton],
  templateUrl: './switches.component.html',
  styleUrl: './switches.component.scss',
})
export class SwitchesComponent {
  slug = input.required<string>();

  private api = inject(ApiService);
  private toast = inject(MessageService);

  data = signal<SwitchesResponse | null>(null);
  loading = signal(true);
  failed = signal(false);
  saving = signal(false);
  copied = signal(false);
  /** Saved since the card loaded — the file is in the store but not committed. */
  savedOnce = signal(false);

  // The draft. null = not set for this project (the default applies).
  rebase = signal<RebaseSwitch | null>(null);
  versionKind = signal<VersionKind | null>(null);
  command = signal('');
  file = signal('');
  // The decisions log: on = the check is set for this project (it is off by
  // default — there is no "set to off"), logPath = the file it names.
  logOn = signal(false);
  logPath = signal('');

  readonly rebaseOptions = [
    { label: 'Always', value: 'always' },
    { label: 'Ask', value: 'ask' },
  ];
  readonly versionOptions = [
    { label: 'Off', value: 'off' },
    { label: 'Minor', value: 'minor' },
    { label: 'Patch', value: 'patch' },
    { label: 'Own command', value: 'command' },
  ];
  readonly logOptions = [
    { label: 'Off', value: 'off' },
    { label: 'Check merges', value: 'on' },
  ];

  constructor() {
    effect(() => {
      const slug = this.slug();
      untracked(() => this.load(slug));
    });
  }

  private load(slug: string) {
    this.loading.set(true);
    this.failed.set(false);
    this.savedOnce.set(false);
    this.api.switches(slug).subscribe({
      next: (r) => { this.seed(r); this.loading.set(false); },
      error: () => { this.failed.set(true); this.loading.set(false); },
    });
  }

  private seed(r: SwitchesResponse) {
    this.data.set(r);
    this.rebase.set(r.stored.rebase ?? null);
    const v = r.stored.version;
    if (v == null) {
      this.versionKind.set(null);
      this.command.set(''); this.file.set('');
    } else if (typeof v === 'object') {
      this.versionKind.set('command');
      this.command.set(v.command); this.file.set(v.file);
    } else {
      this.versionKind.set(v);
      this.command.set(''); this.file.set('');
    }
    const log = r.stored.decisions_log;
    this.logOn.set(log != null);
    this.logPath.set(log ?? '');
  }

  // What the selectors show: the draft, else the default.
  readonly rebaseShown = computed(() => this.rebase() ?? this.data()?.defaults.rebase ?? 'always');
  readonly versionShown = computed<VersionKind>(() => this.versionKind() ?? this.kindOf(this.data()?.defaults.version ?? 'off'));

  private kindOf(v: VersionSwitch): VersionKind { return typeof v === 'object' ? 'command' : v; }

  /** The draft as the API takes it: null = unset. */
  private draftVersion(): VersionSwitch | null {
    const k = this.versionKind();
    if (k == null) return null;
    if (k === 'command') return { command: this.command().trim(), file: this.file().trim() };
    return k;
  }

  readonly commandIncomplete = computed(() =>
    this.versionShown() === 'command' && (!this.command().trim() || !this.file().trim()));

  /** The decisions-log draft as the API takes it: null = off (unset). */
  private draftLog(): string | null { return this.logOn() ? this.logPath().trim() : null; }
  readonly logShown = computed<'off' | 'on'>(() => (this.logOn() ? 'on' : 'off'));
  readonly logIncomplete = computed(() => this.logOn() && !this.logPath().trim());

  readonly dirty = computed(() => {
    const d = this.data();
    if (!d) return false;
    return JSON.stringify({ r: this.rebase(), v: this.draftVersion(), l: this.draftLog() })
      !== JSON.stringify({ r: d.stored.rebase ?? null, v: d.stored.version ?? null, l: d.stored.decisions_log ?? null });
  });

  // Ignored entries in the file also make it saveable: saving rewrites the file
  // with only what the card shows, which is how they get cleaned out.
  readonly canSave = computed(() =>
    (this.dirty() || !!this.data()?.problems.length) && !this.saving() && !this.commandIncomplete() && !this.logIncomplete());

  readonly commitCmd = 'cogyard tasks sync push "switches" -- switches.json';

  setRebase(v: RebaseSwitch) { this.rebase.set(v); }
  setVersion(k: VersionKind) { this.versionKind.set(k); }
  resetRebase() { this.rebase.set(null); }
  resetVersion() { this.versionKind.set(null); this.command.set(''); this.file.set(''); }
  setLog(v: 'off' | 'on') { this.logOn.set(v === 'on'); }

  describe(v: VersionSwitch | undefined | null): string {
    if (v == null) return '';
    if (typeof v === 'object') return 'own command';
    return v;
  }

  save() {
    this.saving.set(true);
    this.api.saveSwitches({ slug: this.slug(), switches: { rebase: this.rebase(), version: this.draftVersion(), decisions_log: this.draftLog() } }).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.seed(r);
        this.savedOnce.set(true);
        this.toast.add({ severity: 'success', summary: 'Switches saved' });
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Save failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => { this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); },
      () => {},
    );
  }
}
