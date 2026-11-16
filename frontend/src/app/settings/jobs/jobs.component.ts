import { Component, inject, input, signal, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Select } from 'primeng/select';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { ScheduledJob, JobSchedule } from '../../services/models';
import { FlagComponent } from '../../shared/flag/flag.component';

// The scheduling block of ONE add-on's row in /settings.
//
// It WAS its own section, on the reasoning that an add-on row asks "is this
// installed and on?" while a job row asks "did it run last night?". The owner
// reversed that on 2026-08-20: two sections meant one capability appearing
// twice, and the answer to "where do I configure the nightly brief?" was "in
// two places". A scheduled task is not a separate thing from the add-on that
// declares it — it IS the add-on, running.
//
// So this renders inside the add-on's row when that add-on declared a schedule,
// and nothing anywhere when it did not. Activation stays on the row's switch:
// one capability, one on/off, one place — which is now literally true.
@Component({
  selector: 'app-settings-job',
  imports: [FormsModule, Select, FlagComponent],
  templateUrl: './jobs.component.html',
  styleUrl: './jobs.component.scss',
})
export class JobsComponent {
  // The job for the add-on this block sits in. The parent fetched it — one
  // request for the page, not one per row.
  job = input.required<ScheduledJob>();
  // A run finished or a schedule moved: the parent re-reads, so the row and its
  // block never disagree about when the next run is.
  changed = output<void>();

  private api = inject(ApiService);
  private toast = inject(MessageService);
  running = signal<string | null>(null);   // job id while its run is in flight
  savingTime = signal<string | null>(null); // job id while its schedule saves
  openLog = signal<string | null>(null);    // job id whose log is expanded
  editing = signal<string | null>(null);    // job id whose schedule form is open
  draft = signal<{ every: 'day' | 'week'; at: string; weekday: number }>({ every: 'day', at: '05:00', weekday: 1 });

  readonly everyOptions = [{ label: 'Every day', value: 'day' }, { label: 'Every week', value: 'week' }];
  readonly weekdayOptions = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    .map((label, value) => ({ label, value }));

  private reload() { this.changed.emit(); }

  // One word per state, same grammar as the add-on row's pill.
  pill(j: ScheduledJob): { text: string; cls: string } {
    if (!j.active) return { text: 'off', cls: 'off' };
    if (!j.supported) return { text: 'not on this OS', cls: 'off' };
    if (!j.runnable) return { text: 'no entry point', cls: 'warn' };
    if (this.running() === j.id) return { text: 'running', cls: 'warn' };
    if (j.lastOutcome === 'error') return { text: 'failed', cls: 'warn' };
    if (j.lastOutcome === 'skipped') return { text: 'skipped', cls: 'off' };
    if (j.lastOutcome === 'ok') return { text: 'ok', cls: 'on' };
    return { text: 'never run', cls: 'off' };
  }

  scheduleText(s: JobSchedule): string {
    return s.every === 'day' ? `Daily at ${s.at}`
      : `${this.weekdayOptions[s.weekday ?? 1].label}s at ${s.at}`;
  }

  // Relative where it helps ("4h ago"), absolute where precision matters.
  when(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    const ago = Math.abs(mins);
    const rel = ago < 1 ? 'just now'
      : ago < 60 ? `${ago}m`
      : ago < 60 * 24 ? `${Math.round(ago / 60)}h`
      : `${Math.round(ago / (60 * 24))}d`;
    if (rel === 'just now') return rel;
    return mins > 0 ? `${rel} ago` : `in ${rel}`;
  }

  cost(n: number): string { return n > 0 ? `$${n.toFixed(2)}` : '—'; }

  runNow(j: ScheduledJob) {
    if (!j.active || !j.runnable || this.running()) return;
    this.running.set(j.id);
    this.api.runJob(j.id).subscribe({
      next: (r) => {
        this.running.set(null);
        this.reload();
        if (!r.ok) {
          this.toast.add({ severity: 'warn', summary: `${j.label} did not finish`, detail: r.error || 'no reason given' });
        }
      },
      error: (e) => {
        this.running.set(null);
        this.toast.add({ severity: 'error', summary: `${j.label} failed to start`, detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  edit(j: ScheduledJob) {
    this.draft.set({ every: j.schedule.every, at: j.schedule.at, weekday: j.schedule.weekday ?? 1 });
    this.editing.set(this.editing() === j.id ? null : j.id);
  }
  setDraft<K extends keyof ReturnType<typeof this.draft>>(key: K, value: ReturnType<typeof this.draft>[K]) {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  saveSchedule(j: ScheduledJob) {
    const d = this.draft();
    this.savingTime.set(j.id);
    this.api.setJobSchedule(j.id, { every: d.every, at: d.at, weekday: d.weekday }).subscribe({
      next: () => { this.savingTime.set(null); this.editing.set(null); this.reload(); },
      error: (e) => {
        this.savingTime.set(null);
        this.toast.add({ severity: 'error', summary: 'Schedule not saved', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  // Back to whatever the add-on's manifest declares.
  resetSchedule(j: ScheduledJob) {
    this.savingTime.set(j.id);
    this.api.setJobSchedule(j.id, null).subscribe({
      next: () => { this.savingTime.set(null); this.editing.set(null); this.reload(); },
      error: (e) => {
        this.savingTime.set(null);
        this.toast.add({ severity: 'error', summary: 'Reset failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }

  toggleLog(id: string) { this.openLog.set(this.openLog() === id ? null : id); }
}
