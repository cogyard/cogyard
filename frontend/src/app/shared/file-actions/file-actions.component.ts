import { Component, input, output, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { Menu } from 'primeng/menu';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { MenuItem, MessageService, ConfirmationService } from 'primeng/api';
import { ApiService } from '../../services/api.service';

// Toolbar actions for the current file, shared by the Graph diff dock and the
// Files pane (task 12):
//   • "Open in ▾" — opens the file in an external app (VS Code / Finder / …),
//     built from the editable ~/.cogyard/open-targets.json list the server
//     exposes at /api/open-targets. On the Graph page it also offers "Open in
//     cogyard" (jump to the Files viewer). Both pages.
//   • "Discard" — discard a working-tree file (tracked: git restore; untracked:
//     delete), confirmed. Shown ONLY when `discardKind` is set, i.e. the Graph
//     worktree panel (Ben does stage/unstage via Claude, not the portal).
// The server resolves the open-target *id* to its command, so this only ever
// sends an id — never a raw command.
@Component({
  selector: 'app-file-actions',
  imports: [Menu, ConfirmDialog],
  providers: [ConfirmationService],
  templateUrl: './file-actions.component.html',
  styleUrl: './file-actions.component.scss',
})
export class FileActionsComponent {
  private api = inject(ApiService);
  private router = inject(Router);
  private messages = inject(MessageService);
  private confirm = inject(ConfirmationService);

  slug = input.required<string>();
  path = input.required<string>();          // repo-relative file path
  worktree = input<string | null>(null);    // abs checkout path (for /api/*)
  worktreeName = input<string | null>(null); // worktree name (for cogyard nav)
  line = input<number | null>(null);
  onGraph = input(false);                    // adds "Open in cogyard"
  // The file's working-tree group ('staged'|'unstaged'|'untracked') — set only
  // by the Graph worktree panel. null = no Discard button (e.g. Files page).
  discardKind = input<string | null>(null);
  changed = output<void>();                  // emitted after a discard

  canDiscard = computed(() => !!this.discardKind());

  private openTargets = signal<MenuItem[]>([]);
  openItems = computed<MenuItem[]>(() => {
    const items = [...this.openTargets()];
    if (this.onGraph()) {
      items.push({ separator: true });
      items.push({ label: 'Open in cogyard', command: () => this.openInCogyard() });
    }
    return items;
  });

  constructor() {
    // The target list is small and changes rarely — fetch once.
    this.api.openTargets().subscribe({
      next: (ts) => this.openTargets.set(ts.map((t) => ({ label: t.label, command: () => this.runOpen(t.id) }))),
      error: () => this.openTargets.set([]),
    });
  }

  private runOpen(targetId: string) {
    this.api.openFile(this.slug(), this.path(), targetId, this.line(), this.worktree()).subscribe({
      next: () => {},
      error: (e) => this.toastErr(e),
    });
  }

  private openInCogyard() {
    this.router.navigate(['/p', this.slug(), 'files'], { queryParams: { wt: this.worktreeName() || '', file: this.path() } });
  }

  // DESTRUCTIVE: confirm, then discard. Untracked files are deleted on disk.
  discard() {
    const path = this.path();
    const untracked = this.discardKind() === 'untracked';
    this.confirm.confirm({
      header: 'Discard changes?',
      message: `${untracked ? 'Delete untracked file' : 'Discard changes to'} ${path}? This is irreversible.`,
      acceptLabel: 'Discard',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger p-button-sm',
      rejectButtonStyleClass: 'p-button-text p-button-sm',
      accept: () => this.api.wtDiscard(this.slug(), path, untracked, this.worktree()).subscribe({
        next: () => { this.messages.add({ severity: 'success', summary: 'Discarded', life: 1200 }); this.changed.emit(); },
        error: (e) => this.toastErr(e),
      }),
    });
  }

  private toastErr(e: any) {
    const msg = e?.error?.error || e?.message || 'Action failed';
    this.messages.add({ severity: 'error', summary: 'Action failed', detail: String(msg), life: 4000 });
  }
}
