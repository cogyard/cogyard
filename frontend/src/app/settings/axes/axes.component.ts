import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Select } from 'primeng/select';
import { InputText } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { AxisRow } from '../../services/models';

// The Label-axes section of the global /settings page (task 096, Phase 4). An
// axis is a named, colored bundle of sibling labels; this manager curates each
// LAYER of the map separately — the machine-global shared map, or a chosen
// project's committed .cogyard/axes.json — since they resolve as overlays and
// must be edited independently. Read/curate only: it never creates tasks, it
// just assigns labels to axes, renames axes, and sets axis colors, then writes
// the layer's axes.json through POST /api/axes (the same guarded write seam).
//
// A neutral color is applied when an axis has none, so the color input always
// shows a value; labels are edited as removable chips (type + Enter to add).
@Component({
  selector: 'app-settings-axes',
  imports: [FormsModule, Select, InputText],
  templateUrl: './axes.component.html',
  styleUrl: './axes.component.scss',
})
export class AxesComponent {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  // Scope selector: '' = the shared machine-global map; else a project slug.
  scope = signal<string>('');
  scopeOptions = signal<{ label: string; value: string }[]>([{ label: 'Shared (all projects)', value: '' }]);

  // The editable draft for the current scope. Reloaded whenever the scope changes.
  axes = signal<AxisRow[]>([]);
  loading = signal(false);
  saving = signal(false);

  private readonly NEUTRAL = '#8a8f98';

  readonly isShared = computed(() => this.scope() === '');

  constructor() {
    this.api.projects().subscribe((ps) => {
      this.scopeOptions.set([{ label: 'Shared (all projects)', value: '' },
        ...ps.map((p) => ({ label: p.label, value: p.slug }))]);
    });
    // Load the selected layer whenever the scope changes.
    effect(() => { this.scope(); this.load(); });
  }

  private load() {
    this.loading.set(true);
    const scope = this.scope();
    const req = scope ? this.api.axesFor('project', scope) : this.api.axesFor('shared');
    req.subscribe({
      next: (r) => {
        // Clone into an editable draft; default a missing color so the picker shows one.
        this.axes.set((r.axes ?? []).map((a) => ({ name: a.name, color: a.color || this.NEUTRAL, labels: [...a.labels] })));
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Load failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  addAxis() { this.axes.update((rows) => [...rows, { name: '', color: '#4f8cff', labels: [] }]); }
  removeAxis(i: number) { this.axes.update((rows) => rows.filter((_, j) => j !== i)); }
  setName(i: number, name: string) { this.axes.update((rows) => rows.map((r, j) => (j === i ? { ...r, name } : r))); }
  setColor(i: number, color: string) { this.axes.update((rows) => rows.map((r, j) => (j === i ? { ...r, color } : r))); }

  // Assign a label to an axis — type it and Enter. Trimmed, de-duped within the
  // axis. This is how a previously-Ungrouped label gets moved under an axis.
  addLabel(i: number, value: string) {
    const l = (value || '').trim();
    if (!l) return;
    this.axes.update((rows) => rows.map((r, j) => (j === i && !r.labels.includes(l) ? { ...r, labels: [...r.labels, l] } : r)));
  }
  removeLabel(i: number, label: string) {
    this.axes.update((rows) => rows.map((r, j) => (j === i ? { ...r, labels: r.labels.filter((x) => x !== label) } : r)));
  }

  // The one validator: every axis needs a non-empty name before we can save.
  readonly invalid = computed(() => this.axes().some((a) => !a.name.trim()));
  canSave() { return !this.invalid() && !this.saving() && !this.loading(); }

  save() {
    if (!this.canSave()) return;
    this.saving.set(true);
    const scope = this.scope();
    const body = scope ? { scope: 'project' as const, slug: scope, axes: this.axes() }
      : { scope: 'shared' as const, axes: this.axes() };
    this.api.saveAxes(body).subscribe({
      next: (r) => {
        this.saving.set(false);
        // Reflect the server's sanitized result (dropped bad rows, tidied colors).
        this.axes.set((r.axes ?? []).map((a) => ({ name: a.name, color: a.color || this.NEUTRAL, labels: [...a.labels] })));
        this.toast.add({ severity: 'success', summary: 'Axes saved', detail: scope ? `${scope}/.cogyard/axes.json` : '~/.cogyard/axes.json' });
      },
      error: (e) => {
        this.saving.set(false);
        this.toast.add({ severity: 'error', summary: 'Save failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }
}
