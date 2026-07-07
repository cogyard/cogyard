import { Component, output, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Drawer } from 'primeng/drawer';
import { Select } from 'primeng/select';
import { SelectButton } from 'primeng/selectbutton';
import { InputText } from 'primeng/inputtext';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { ConfigService } from '../../services/config.service';
import { ProjectKind, ScaffoldResult } from '../../services/models';

// The sidebar "New / Add existing" front door. Two trigger buttons that
// open a drawer form, which POSTs to /api/projects/{init,onboard} (the
// requireSameOrigin write seam). New = greenfield (creates the dir + skeleton);
// Add existing = onboard an existing folder (additive-only). On success emits the
// new slug so the shell can reload the project list and navigate to it.
@Component({
  selector: 'app-new-project',
  imports: [FormsModule, Drawer, Select, SelectButton, InputText],
  templateUrl: './new-project.component.html',
  styleUrl: './new-project.component.scss',
})
export class NewProjectComponent {
  private api = inject(ApiService);
  private config = inject(ConfigService);
  private toast = inject(MessageService);
  created = output<string>();

  open = signal(false);
  mode = signal<'init' | 'onboard'>('init');
  path = signal('');       // onboard: full path to an existing folder (anywhere)
  name = signal('');       // init: just the project name; the base is the projects root
  // The configured projects root (settable in /settings) — New mode composes
  // `<projectsRoot>/<name>` so the user only types a name, not the full path.
  readonly projectsRoot = computed(() => this.config.config()?.projectsRoot ?? '');
  readonly initFullPath = computed(() => `${this.projectsRoot()}/${this.name().trim()}`);
  // kind seeds from the saved creation defaults — the built-in default until
  // config loads, the persisted value once it has. start() resets it to the
  // *current* saved default, not back to a hardcoded literal. (The store model is
  // always shared — the choice was removed.)
  kind = signal<ProjectKind>(this.config.defaults().kind);
  remote = signal('');
  busy = signal(false);

  readonly modeOptions = [{ label: 'New', value: 'init' }, { label: 'Existing', value: 'onboard' }];
  // Kinds come from the scaffold registry via /api/config —
  // a drop-in scaffold appears in the drawer with no UI change.
  readonly kindOptions = computed(() =>
    (this.config.config()?.kinds ?? []).map((k) => ({ label: k.kind, value: k.kind })));
  // "What does this kind scaffold?" — the selected kind's registry description.
  readonly kindDescription = computed(() =>
    this.config.config()?.kinds.find((k) => k.kind === this.kind())?.description ?? '');

  start(mode: 'init' | 'onboard') {
    this.mode.set(mode);
    this.path.set('');
    this.name.set('');
    this.remote.set('');
    // Reset kind to the current saved default (refreshed live after a Save in
    // /settings), so the drawer prefills with what the user configured.
    this.kind.set(this.config.defaults().kind);
    this.open.set(true);
  }

  // init: a project name is enough (path = <projectsRoot>/<name>); onboard: a full path.
  canSubmit() {
    const ok = this.mode() === 'init' ? !!this.name().trim() : !!this.path().trim();
    return ok && !this.busy();
  }

  submit() {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    const isInit = this.mode() === 'init';
    const body = {
      path: isInit ? this.initFullPath() : this.path().trim(),
      kind: this.kind(),
      remote: this.remote().trim() || undefined,
    };
    const call = isInit ? this.api.initProject(body) : this.api.onboardProject(body);
    call.subscribe({
      next: (r: ScaffoldResult) => {
        this.busy.set(false);
        this.open.set(false);
        this.toast.add({
          severity: 'success',
          summary: isInit ? 'Project created' : 'Project added',
          detail: `${r.slug} → ${r.store}`,
        });
        if (r.warnings?.length) {
          for (const w of r.warnings) this.toast.add({ severity: 'warn', summary: 'Heads up', detail: w });
        }
        this.created.emit(r.slug);
      },
      error: (e) => {
        this.busy.set(false);
        this.toast.add({ severity: 'error', summary: isInit ? 'Create failed' : 'Add failed', detail: e?.error?.error || e?.message || 'request failed' });
      },
    });
  }
}
