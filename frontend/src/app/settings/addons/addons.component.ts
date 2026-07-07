import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Dialog } from 'primeng/dialog';
import { Select } from 'primeng/select';
import { InputText } from 'primeng/inputtext';
import { Checkbox } from 'primeng/checkbox';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { AddonManifest, AddonStatus, AddonAction, AddonActionResult, AddonsCatalog } from '../../services/models';

// The Add-ons section of the global /settings page — add-ons extend
// COGYARD ITSELF, so their one home is this machine-level view. Rendered as a
// COMPACT LIST (one row per installed add-on: icon, name, activation switch,
// status pill, one-line summary); a row's Configure opens a DIALOG holding the
// add-on's whole interaction surface — prereq checklist, config form (from
// configSchema), tiered action buttons, inline results. The page never grows
// with the add-on count; the dialog is generated from the manifest, so no
// add-on ships UI code.
//
// The row switch is the FRAMEWORK's install≠activate toggle (config.json
// disabledAddons, saved through POST /api/config): off = listed but inert, no
// add-on code runs. 'safe' actions POST and show the result inline; 'manual'
// actions never execute — the dialog shows the exact copy-paste command. A
// `type: 'project'` config field renders as a dropdown of registered projects;
// the chosen slug travels in cfg (the only project awareness anywhere).
@Component({
  selector: 'app-settings-addons',
  imports: [FormsModule, Dialog, Select, InputText, Checkbox, ToggleSwitch],
  templateUrl: './addons.component.html',
  styleUrl: './addons.component.scss',
})
export class AddonsComponent {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  catalog = signal<AddonsCatalog | null>(null);
  statuses = signal<AddonStatus[]>([]);
  projectOptions = signal<{ label: string; value: string }[]>([]);
  busy = signal<string | null>(null); // "<addonId>/<actionId>" while a POST is in flight
  savingToggle = signal<string | null>(null); // addon id while its switch saves
  // The add-on whose dialog is open (null = closed).
  openId = signal<string | null>(null);
  // Per-add-on config drafts (seeded from configSchema defaults) and the last
  // action result, rendered inside the dialog.
  cfg = signal<Record<string, Record<string, unknown>>>({});
  results = signal<Record<string, AddonActionResult>>({});
  copiedFor = signal<string | null>(null);

  readonly openAddon = computed<AddonManifest | null>(() =>
    this.catalog()?.addons.find((a) => a.id === this.openId()) ?? null);

  constructor() {
    this.reloadCatalog();
    // Options for `type: 'project'` config fields.
    this.api.projects().subscribe((ps) => this.projectOptions.set(ps.map((p) => ({ label: p.label, value: p.slug }))));
    this.refresh();
  }

  private reloadCatalog() {
    this.api.addons().subscribe((c) => {
      this.catalog.set(c);
      this.cfg.update((prev) => {
        const drafts: Record<string, Record<string, unknown>> = {};
        for (const a of c.addons) {
          drafts[a.id] = prev[a.id] ?? {};
          for (const f of a.configSchema) {
            if (drafts[a.id][f.key] === undefined) drafts[a.id][f.key] = f.default ?? (f.type === 'boolean' ? false : '');
          }
        }
        return drafts;
      });
    });
  }

  refresh() {
    this.api.addonStatuses().subscribe((r) => this.statuses.set(r.statuses));
  }

  statusFor(id: string): AddonStatus | undefined { return this.statuses().find((s) => s.id === id); }

  // Row pill: one word per state, framework switch first.
  pillFor(a: AddonManifest): { text: string; cls: string } {
    if (!a.active) return { text: 'off', cls: 'off' };
    if (!a.supported) return { text: 'not on this OS', cls: 'off' };
    const s = this.statusFor(a.id);
    if (!s) return { text: '…', cls: 'off' };
    if (s.enabled && s.healthy === false) return { text: 'unhealthy', cls: 'warn' };
    if (s.enabled) return { text: 'enabled', cls: 'on' };
    return { text: 'idle', cls: 'off' };
  }
  prereqBroken(a: AddonManifest): boolean { return a.active && a.supported && a.prereqs.some((p) => !p.ok); }

  // Framework activation switch → config.json disabledAddons via POST /api/config.
  setActive(a: AddonManifest, on: boolean) {
    const disabled = (this.catalog()?.addons ?? [])
      .filter((x) => (x.id === a.id ? !on : !x.active))
      .map((x) => x.id);
    this.savingToggle.set(a.id);
    this.api.saveConfig({ disabledAddons: disabled }).subscribe({
      next: () => { this.savingToggle.set(null); this.reloadCatalog(); this.refresh(); },
      error: (e) => {
        this.savingToggle.set(null);
        this.reloadCatalog(); // revert the switch to server truth
        this.toast.add({ severity: 'error', summary: 'Toggle failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  openDialog(a: AddonManifest) { if (a.active && a.supported) this.openId.set(a.id); }
  closeDialog() { this.openId.set(null); }

  setCfg(id: string, key: string, value: unknown) {
    this.cfg.update((all) => ({ ...all, [id]: { ...all[id], [key]: value } }));
  }
  strValue(id: string, key: string): string { return String(this.cfg()[id]?.[key] ?? ''); }
  boolValue(id: string, key: string): boolean { return this.cfg()[id]?.[key] === true; }

  // THE one validator: required config fields that are still blank. The field's
  // required marker and every needsConfig button's disabled state both read this.
  missingRequired(a: AddonManifest): string[] {
    const values = this.cfg()[a.id] ?? {};
    return a.configSchema
      .filter((f) => f.required && f.type !== 'boolean' && !String(values[f.key] ?? '').trim())
      .map((f) => f.key);
  }
  canRun(a: AddonManifest, act: AddonAction): boolean {
    if (this.busy()) return false;
    return !act.needsConfig || this.missingRequired(a).length === 0;
  }

  run(a: AddonManifest, act: AddonAction) {
    if (!this.canRun(a, act)) return;
    this.busy.set(`${a.id}/${act.id}`);
    this.api.runAddonAction(a.id, act.id, this.cfg()[a.id] ?? {}).subscribe({
      next: (r) => {
        this.busy.set(null);
        this.results.update((all) => ({ ...all, [a.id]: r }));
        if (!r.manual) this.refresh(); // a safe action may have changed the add-on's state
      },
      error: (e) => {
        this.busy.set(null);
        this.toast.add({ severity: 'error', summary: `${a.label}: ${act.label} failed`, detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  copyCommand(id: string, command: string) {
    navigator.clipboard?.writeText(command).then(() => {
      this.copiedFor.set(id);
      setTimeout(() => this.copiedFor.set(null), 1500);
    });
  }

  optionRows(options?: string[]) { return (options ?? []).map((o) => ({ label: o, value: o })); }
}
