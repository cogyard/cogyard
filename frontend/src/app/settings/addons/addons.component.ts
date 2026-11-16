import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Dialog } from 'primeng/dialog';
import { Select } from 'primeng/select';
import { InputText } from 'primeng/inputtext';
import { Checkbox } from 'primeng/checkbox';
import { ToggleSwitch } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { JobsComponent } from '../jobs/jobs.component';
import { FlagComponent, FlagTone } from '../../shared/flag/flag.component';
import { AddonManifest, AddonStatus, AddonAction, AddonActionResult, AddonsCatalog, ScheduledJob } from '../../services/models';

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
  imports: [FormsModule, Dialog, Select, InputText, Checkbox, ToggleSwitch, JobsComponent, FlagComponent],
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
  saving = signal<string | null>(null); // addon id while its config saves
  savedFor = signal<string | null>(null); // addon id, briefly, after a save lands
  // The add-on whose dialog is open (null = closed).
  openId = signal<string | null>(null);
  // Another section asking for one to be opened — a scheduled task reaching its
  // own settings. The dialog can open an add-on this list does not render.
  openRequest = input<{ id: string; n: number } | null>(null);
  // A switch moved. Sections whose visibility depends on an add-on being on
  // (Scheduled tasks) reload rather than waiting for a page refresh.
  changed = output<void>();
  // Per-add-on config drafts (seeded from configSchema defaults) and the last
  // action result, rendered inside the dialog.
  // Scheduled jobs, by add-on id. A scheduled task is not a separate thing from
  // the add-on that declares it — it IS the add-on, running — so its schedule,
  // last run, cost and log render inside that add-on's row (owner, 2026-08-20,
  // collapsing what used to be a second section). One request for the page.
  jobs = signal<Record<string, ScheduledJob>>({});
  jobFor(id: string): ScheduledJob | null { return this.jobs()[id] ?? null; }

  cfg = signal<Record<string, Record<string, unknown>>>({});
  results = signal<Record<string, AddonActionResult>>({});
  copiedFor = signal<string | null>(null);

  // What the owner typed into a setup step's input, keyed "<addonId>:<stepIndex>".
  // IN MEMORY ONLY: never saved, never sent, never logged. It exists so the
  // command below the box can be a real line instead of a placeholder the owner
  // has to hand-edit — which is unusable, because copy-paste-Enter writes the
  // placeholder verbatim.
  private setupInputs = signal<Record<string, string>>({});
  setupInput(id: string, i: number) { return this.setupInputs()[`${id}:${i}`] ?? ''; }
  setSetupInput(id: string, i: number, v: string) {
    this.setupInputs.update((all) => ({ ...all, [`${id}:${i}`]: v }));
  }

  // The command with {input} substituted. Until something is typed it shows the
  // token itself, so the shape of the line is visible before it is usable.
  stepCommand(id: string, i: number, st: { command?: string }) {
    const v = this.setupInput(id, i).trim();
    return (st.command ?? '').replace('{input}', v || '{input}');
  }
  // A command still holding {input} is not copyable — copying it would hand back
  // the same trap the placeholder was.
  stepReady(id: string, i: number, st: { command?: string }) {
    return !(st.command ?? '').includes('{input}') || !!this.setupInput(id, i).trim();
  }

  readonly openAddon = computed<AddonManifest | null>(() =>
    this.catalog()?.addons.find((a) => a.id === this.openId()) ?? null);

  constructor() {
    effect(() => {
      const req = this.openRequest();
      if (!req) return;
      const a = this.catalog()?.addons.find((x) => x.id === req.id);
      if (a) this.openDialog(a);
    });
    this.reloadCatalog();
    this.reloadJobs();
    // Options for `type: 'project'` config fields.
    this.api.projects().subscribe((ps) => this.projectOptions.set(ps.map((p) => ({ label: p.label, value: p.slug }))));
    this.refresh();
  }

  reloadJobs() {
    this.api.jobs().subscribe((r) => {
      const by: Record<string, ScheduledJob> = {};
      for (const j of r.jobs) by[j.id] = j;
      this.jobs.set(by);
    });
  }

  private reloadCatalog() {
    this.api.addons().subscribe((c) => {
      this.catalog.set(c);
      // Seed from the SERVER's resolved config (task 127) — persisted values
      // with schema defaults already filled in — rather than from the last
      // draft. Before config was persisted these drafts were the only copy and
      // died on reload; now the file is the truth and this is a view of it.
      const drafts: Record<string, Record<string, unknown>> = {};
      for (const a of c.addons) {
        drafts[a.id] = { ...(a.config ?? {}) };
        for (const f of a.configSchema) {
          if (drafts[a.id][f.key] === undefined) drafts[a.id][f.key] = f.default ?? (f.type === 'boolean' ? false : '');
        }
      }
      this.cfg.set(drafts);
    });
  }

  // Recheck. Reloads the CATALOG too, not just statuses: prereqs live on the
  // manifest, so a prereq that has just been satisfied (a credential added, a
  // tool installed) only clears if the catalog is re-read.
  refresh() {
    this.reloadCatalog();
    this.api.addonStatuses().subscribe((r) => this.statuses.set(r.statuses));
  }

  // Rows for THIS list. An add-on that declares a schedule is a job, and jobs
  // are listed in the Scheduled tasks section — showing it here too gave one
  // job five controls (scheduled / prereq missing / enabled / configure /
  // switch) and no hint that any of them related to each other.
  // Every installed add-on, scheduled or not. This used to exclude the scheduled
  // ones because they had a section of their own; with that section merged back
  // in (owner, 2026-08-20) the filter hid exactly the rows the merge was for.
  listedAddons(all: AddonManifest[]): AddonManifest[] { return all; }

  statusFor(id: string): AddonStatus | undefined { return this.statuses().find((s) => s.id === id); }

  // Row pill: one word per state, framework switch first.
  pillFor(a: AddonManifest): { text: string; tone: FlagTone } {
    if (!a.active) return { text: 'off', tone: 'neutral' };
    if (!a.supported) return { text: 'not on this OS', tone: 'neutral' };
    const s = this.statusFor(a.id);
    if (!s) return { text: '…', tone: 'neutral' };
    if (s.enabled && s.healthy === false) return { text: 'unhealthy', tone: 'warn' };
    if (s.enabled) return { text: 'enabled', tone: 'good' };
    return { text: 'idle', tone: 'neutral' };
  }
  prereqBroken(a: AddonManifest): boolean { return a.active && a.supported && a.prereqs.some((p) => !p.ok); }

  // Framework activation switch → config.json disabledAddons via POST /api/config.
  setActive(a: AddonManifest, on: boolean) {
    const disabled = (this.catalog()?.addons ?? [])
      .filter((x) => (x.id === a.id ? !on : !x.active))
      .map((x) => x.id);
    this.savingToggle.set(a.id);
    this.api.saveConfig({ disabledAddons: disabled }).subscribe({
      next: () => { this.savingToggle.set(null); this.reloadCatalog(); this.refresh(); this.changed.emit(); },
      error: (e) => {
        this.savingToggle.set(null);
        this.reloadCatalog(); // revert the switch to server truth
        this.toast.add({ severity: 'error', summary: 'Toggle failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  openDialog(a: AddonManifest) { if (a.active && a.supported) this.openId.set(a.id); }
  closeDialog() {
    const id = this.openId();
    if (id) this.flushSave(id); // never lose an edit to the closing animation
    this.openId.set(null);
  }

  setCfg(id: string, key: string, value: unknown) {
    this.cfg.update((all) => ({ ...all, [id]: { ...all[id], [key]: value } }));
    this.queueSave(id);
  }

  // --- persistence (task 127) -------------------------------------------------
  // Config used to live only here, in a browser signal: the dialog held it, sent
  // it in the body of a manually-triggered action, and forgot it on reload — so
  // the nightly run, which nobody triggers, never saw a single setting the owner
  // changed. Every edit now writes through to config.json.
  //
  // Debounced because the string fields save per keystroke otherwise; flushed on
  // close so a fast Escape can't outrun the timer.
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private queueSave(id: string) {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(id, setTimeout(() => this.saveCfg(id), 500));
  }

  private flushSave(id: string) {
    if (!this.saveTimers.has(id)) return;
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    this.saveCfg(id);
  }

  private saveCfg(id: string) {
    this.saveTimers.delete(id);
    const a = this.catalog()?.addons.find((x) => x.id === id);
    if (!a) return;
    // Declared keys only — an undeclared one is refused server-side.
    const values: Record<string, unknown> = {};
    for (const f of a.configSchema) {
      const v = this.cfg()[id]?.[f.key];
      if (v !== undefined) values[f.key] = v;
    }
    this.saving.set(id);
    this.api.saveAddonConfig(id, values).subscribe({
      next: () => {
        this.saving.set(null);
        this.savedFor.set(id);
        setTimeout(() => { if (this.savedFor() === id) this.savedFor.set(null); }, 1500);
      },
      error: (e) => {
        this.saving.set(null);
        this.toast.add({ severity: 'error', summary: `${a.label}: settings not saved`, detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
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
