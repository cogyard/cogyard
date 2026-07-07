import { Component, inject, signal, input, output, effect, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Select } from 'primeng/select';
import { SelectButton } from 'primeng/selectbutton';
import { InputText } from 'primeng/inputtext';
import { Checkbox } from 'primeng/checkbox';
import { MessageService } from 'primeng/api';
import { ApiService } from '../services/api.service';
import { ConfigService } from '../services/config.service';
import { ProjectKind, OpenTargetFull, WeekStart } from '../services/models';
import { fmtHour } from '../shared/activity-punchcard/activity-punchcard.component';
import { PORTAL_TABS } from '../shared/portal-tabs';
import { AddonsComponent } from './addons/addons.component';

// The /settings view AND the first-run setup wizard — the same form,
// `wizard` just swaps the framing + shows the "add your first project" CTA. Every
// settable field renders pre-filled with its resolved value; writable fields Save
// through POST /api/config / /api/open-targets, then refresh ConfigService so the
// New/Add drawer prefills with the new values without a reload. COGYARD_HOME and
// the driver are read-only (the driver field is a selector-in-waiting
// — rendered as a plain label until a 2nd adapter exists).
@Component({
  selector: 'app-settings',
  imports: [FormsModule, Select, SelectButton, InputText, Checkbox, AddonsComponent],
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
  weekStart = signal<WeekStart>('sunday');
  dayStart = signal(0);
  projectsRoot = signal('');
  targets = signal<OpenTargetFull[]>([]);
  savingConfig = signal(false);
  savingTargets = signal(false);
  savingTabs = signal(false);
  copied = signal(false);

  // Tab visibility — one checkbox per strip tab; checked = visible.
  // Persisted inverted as ui.hiddenTabs. Every tab is hideable: this view (the
  // sidebar cog) is the un-hide surface, so there's no lock-out.
  readonly portalTabs = PORTAL_TABS;
  hiddenTabs = signal<ReadonlySet<string>>(new Set());
  tabVisible(id: string) { return !this.hiddenTabs().has(id); }
  setTabVisible(id: string, visible: boolean) {
    this.hiddenTabs.update((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Kinds come from the scaffold registry via /api/config —
  // a drop-in scaffold appears here with no UI change. Empty until config loads
  // (the whole form is behind @if(config()) anyway).
  readonly kindOptions = computed(() =>
    (this.config()?.kinds ?? []).map((k) => ({ label: k.kind, value: k.kind })));
  // The one description line under the picker — reads the selected kind's row.
  readonly kindDescription = computed(() =>
    this.config()?.kinds.find((k) => k.kind === this.kind())?.description ?? '');
  readonly weekStartOptions = [{ label: 'Sunday (GitHub)', value: 'sunday' as const }, { label: 'Monday', value: 'monday' as const }];
  readonly dayStartOptions = Array.from({ length: 24 }, (_, h) => ({ label: fmtHour(h), value: h }));

  constructor() {
    effect(() => {
      const c = this.config();
      if (!c) return;
      this.kind.set(c.defaults.kind);
      this.weekStart.set(c.ui?.weekStart ?? 'sunday');
      this.dayStart.set(c.ui?.dayStart ?? 0);
      this.projectsRoot.set(c.projectsRoot);
      this.hiddenTabs.set(new Set(c.ui?.hiddenTabs ?? []));
      this.targets.set(c.openTargets.map((t) => ({ ...t, args: [...t.args] })));
    });
  }

  // Single source of truth for the Save-defaults button's enabled state and the
  // (only) required marker: projectsRoot must be non-empty (the API rejects blank).
  canSaveConfig() { return !!this.projectsRoot().trim() && !this.savingConfig(); }

  saveConfig() {
    if (!this.canSaveConfig()) return;
    this.savingConfig.set(true);
    this.api.saveConfig({ defaults: { kind: this.kind() }, ui: { weekStart: this.weekStart(), dayStart: this.dayStart() }, projectsRoot: this.projectsRoot().trim() }).subscribe({
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

  // Persist only ui.hiddenTabs — the server merge-patches it into the ui block,
  // so the other prefs (weekStart/dayStart) are untouched by this save.
  saveTabs() {
    this.savingTabs.set(true);
    this.api.saveConfig({ ui: { hiddenTabs: [...this.hiddenTabs()] } }).subscribe({
      next: () => {
        this.savingTabs.set(false);
        this.cfg.reload(); // the shell's tab strip reads ConfigService — refresh applies it live
        this.toast.add({ severity: 'success', summary: 'Tab visibility saved' });
      },
      error: (e) => {
        this.savingTabs.set(false);
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
