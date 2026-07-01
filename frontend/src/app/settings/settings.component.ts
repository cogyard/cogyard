import { Component, inject, signal, input, output, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Select } from 'primeng/select';
import { SelectButton } from 'primeng/selectbutton';
import { InputText } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ApiService } from '../services/api.service';
import { ConfigService } from '../services/config.service';
import { ProjectKind, StoreKind, OpenTargetFull } from '../services/models';

// The /settings view AND the first-run setup wizard (task 060) — the same form,
// `wizard` just swaps the framing + shows the "add your first project" CTA. Every
// settable field renders pre-filled with its resolved value; writable fields Save
// through POST /api/config / /api/open-targets, then refresh ConfigService so the
// New/Add drawer prefills with the new values without a reload. COGYARD_HOME and
// the integration are read-only (the integration field is a selector-in-waiting
// for task 061 — rendered as a plain label until a 2nd adapter exists).
@Component({
  selector: 'app-settings',
  imports: [FormsModule, Select, SelectButton, InputText],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private api = inject(ApiService);
  private cfg = inject(ConfigService);
  private toast = inject(MessageService);

  /** Wizard framing (empty-state) vs the plain /settings view. */
  wizard = input(false);
  /** Wizard CTA — the shell opens the existing New/Add drawer. */
  addProject = output<void>();

  readonly config = this.cfg.config;

  // Editable drafts, (re)seeded from the resolved config whenever it loads or is
  // refreshed after a Save. Until config resolves they hold the built-in defaults.
  kind = signal<ProjectKind>('single');
  store = signal<StoreKind>('shared');
  projectsRoot = signal('');
  targets = signal<OpenTargetFull[]>([]);
  savingConfig = signal(false);
  savingTargets = signal(false);
  copied = signal(false);

  readonly kindOptions: { label: string; value: ProjectKind }[] = [
    { label: 'single', value: 'single' }, { label: 'fullstack', value: 'fullstack' },
    { label: 'static', value: 'static' }, { label: 'library', value: 'library' },
  ];
  readonly storeOptions = [{ label: 'shared', value: 'shared' as const }, { label: 'normal', value: 'normal' as const }];

  constructor() {
    effect(() => {
      const c = this.config();
      if (!c) return;
      this.kind.set(c.defaults.kind);
      this.store.set(c.defaults.store);
      this.projectsRoot.set(c.projectsRoot);
      this.targets.set(c.openTargets.map((t) => ({ ...t, args: [...t.args] })));
    });
  }

  // Single source of truth for the Save-defaults button's enabled state and the
  // (only) required marker: projectsRoot must be non-empty (the API rejects blank).
  canSaveConfig() { return !!this.projectsRoot().trim() && !this.savingConfig(); }

  saveConfig() {
    if (!this.canSaveConfig()) return;
    this.savingConfig.set(true);
    this.api.saveConfig({ defaults: { kind: this.kind(), store: this.store() }, projectsRoot: this.projectsRoot().trim() }).subscribe({
      next: () => {
        this.savingConfig.set(false);
        this.cfg.reload(); // refresh so the New/Add drawer prefills with the new defaults
        this.toast.add({ severity: 'success', summary: 'Settings saved', detail: 'Defaults + projects root persisted to config.json' });
      },
      error: (e) => {
        this.savingConfig.set(false);
        this.toast.add({ severity: 'error', summary: 'Save failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  // --- Open-in target list editor ---
  setTargetField(i: number, field: 'id' | 'label' | 'exec', value: string) {
    this.targets.update((rows) => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  }
  setTargetArgs(i: number, value: string) {
    const args = value.trim().split(/\s+/).filter(Boolean);
    this.targets.update((rows) => rows.map((r, j) => (j === i ? { ...r, args } : r)));
  }
  argsText(t: OpenTargetFull) { return t.args.join(' '); }
  addTarget() { this.targets.update((rows) => [...rows, { id: '', label: '', exec: '', args: [] }]); }
  removeTarget(i: number) { this.targets.update((rows) => rows.filter((_, j) => j !== i)); }

  saveTargets() {
    this.savingTargets.set(true);
    this.api.saveOpenTargets(this.targets()).subscribe({
      next: () => {
        this.savingTargets.set(false);
        this.cfg.reload();
        this.toast.add({ severity: 'success', summary: 'Open-in targets saved' });
      },
      error: (e) => {
        this.savingTargets.set(false);
        this.toast.add({ severity: 'error', summary: 'Save failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  // COGYARD_HOME is env/CLI-only (it's where config.json itself lives) — offer the
  // command to move it rather than an editable field.
  homeCommand() { return `export COGYARD_HOME=${this.config()?.home ?? ''}`; }
  copyHome() {
    navigator.clipboard?.writeText(this.homeCommand()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
