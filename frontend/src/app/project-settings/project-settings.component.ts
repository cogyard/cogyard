import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../services/api.service';
import { StorageRow } from '../services/models';

// The "Location on disk" card, first on Admin → Info (task 249; the Admin tab
// itself is ../admin/). It was the first card of the per-project settings tab
// (task 135); the other cards of that tab — Publishing, Switches, the project
// icon, the label axes — are their own components, which Admin places on Info
// or Settings.
//
// Everything that belongs to ONE project lives under Admin; the sidebar cog's
// global page keeps machine-level settings (tab visibility, creation defaults,
// open-in targets, add-ons).
//
// First, deliberately: where the project actually is on disk. The portal
// knew the answer all along — `/api/storage` has carried the repo path since
// task 132 — but rendered only the task-store path, in a cross-project table, so
// "where does this project live?" had no answer on any screen. Projects are not
// all one level under the projects root (nested folders), so it is a real
// question and it goes first.
//
// Two sections (task 217): Code — the project's git repository — and Tasks —
// the task files, which sit in their own folder (the store) with their own git
// history. One mixed list could not say which repository a line like
// "Store git" described.
//
// Read-only, like the storage report it reads from: a problem renders with the
// command that fixes it, to run in a terminal — and with no command unless it is
// exactly right. The portal never moves a store.
//
// `flags` arrive as the CLI's FLAGS column (`cogyard tasks doctor`), which stays
// byte-stable; this maps each to plain words. A flag with no entry here shows as
// the CLI wrote it rather than disappearing.
interface Problem { section: 'code' | 'tasks'; text: string; cmd?: string; note?: string }
const PROBLEMS: { match: RegExp; to: (m: RegExpMatchArray) => Problem | null }[] = [
  { match: /^not a git repo$/, to: () => ({ section: 'code', text: 'The code folder is not a git repository.' }) },
  { match: /^no task directory$/, to: () => ({ section: 'tasks', text: 'This project has no task folder, so it shows no tasks.' }) },
  { match: /^broken symlink/, to: () => ({ section: 'tasks', text: 'The task folder is gone, so this project shows no tasks. No command fixes this — restore the folder or re-point the link.' }) },
  { match: /^relative symlink/, to: () => ({ section: 'tasks', text: 'The link to the task folder is relative, so worktrees — which live in other folders — can\'t follow it.' }) },
  { match: /^store is not a git repo$/, to: () => ({ section: 'tasks', text: 'The task folder has no git history of its own, so task changes can\'t be committed.' }) },
  { match: /^store on branch (.*) \(expected tasks\)$/, to: (m) => ({ section: 'tasks', text: `The task folder is on branch ${m[1]}, not tasks.` }) },
  { match: /^leftover (.*)$/, to: (m) => ({ section: 'tasks', text: `The task folder still holds ${m[1]}, which cogyard no longer writes — delete it.` }) },
  {
    match: /^(\d+) worktree\(s\) unmounted/,
    to: (m) => ({
      section: 'tasks',
      text: `${m[1]} worktree${m[1] === '1' ? ' has' : 's have'} no link to the task folder, so sessions there can't see the tasks`,
      cmd: 'cogyard tasks mount', note: 'run inside each of those worktrees',
    }),
  },
  {
    match: /^folder, not a link to a task store/,
    to: () => ({
      section: 'tasks',
      text: 'A real folder sits where the link to the task store should be, so worktrees can\'t share these tasks. Rename it to _tasks/, then move it into a store',
      cmd: 'cogyard tasks convert', note: 'run in the code folder after the rename',
    }),
  },
  // A fact with a row of its own: sharing has the "Also used by" row.
  { match: /^store shared with:/, to: () => null },
];

function toProblem(flag: string): Problem | null {
  for (const p of PROBLEMS) {
    const m = flag.match(p.match);
    if (m) return p.to(m);
  }
  return { section: 'tasks', text: flag };
}

@Component({
  selector: 'app-project-settings',
  templateUrl: './project-settings.component.html',
  styleUrl: './project-settings.component.scss',
})
export class ProjectSettingsComponent {
  slug = input.required<string>();

  private api = inject(ApiService);

  // The storage report's rows for this project — one per registry entry, so one.
  rows = signal<StorageRow[]>([]);
  loading = signal(true);
  failed = signal(false);
  copied = signal<string | null>(null);

  readonly store = computed(() => this.rows()[0] ?? null);

  constructor() {
    // Re-reads when the tab is opened on a different project. Not on the shared
    // refresh tick: this is settings, not a live view, and the report shells git.
    effect(() => {
      const slug = this.slug();
      this.loading.set(true);
      this.failed.set(false);
      this.api.storage(slug).subscribe({
        next: (r) => {
          this.rows.set(r.rows);
          this.loading.set(false);
        },
        error: () => { this.failed.set(true); this.loading.set(false); },
      });
    });
  }

  // There is a link (working or broken); that is when the Tasks section talks
  // about the link at all.
  readonly linked = computed(() => {
    const st = this.store()?.link.state;
    return st === 'ok' || st === 'broken';
  });

  // The task folder itself: the store a link resolves to, or where it points
  // (broken), or what sits at the link's place (folder, missing).
  tasksFolder(s: StorageRow): string {
    return s.link.state === 'ok' || s.link.state === 'broken' ? s.storePath : s.tasksDir;
  }

  // The link's name inside the code folder (`.cogyard/tasks`), from the path
  // core reports rather than a literal here.
  linkName(s: StorageRow): string {
    const td = s.tasksDir ?? '';
    return td.startsWith(s.path + '/') ? td.slice(s.path.length + 1) : td;
  }

  // Worktrees with no link — sessions there can't see the tasks.
  unmounted(s: StorageRow): number {
    const w = s.worktrees;
    return w && w.mounted !== null ? w.total - w.mounted : 0;
  }

  plural(n: number, one: string, many = one + 's'): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  private readonly problems = computed(() =>
    (this.store()?.flags ?? []).map(toProblem).filter((p): p is Problem => !!p));
  readonly codeProblems = computed(() => this.problems().filter((p) => p.section === 'code'));
  readonly taskProblems = computed(() => this.problems().filter((p) => p.section === 'tasks'));

  // Another PROJECT reading this same store.
  readonly sharedWith = computed(() => this.store()?.sharedWith ?? []);

  copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => {
        this.copied.set(text);
        setTimeout(() => { if (this.copied() === text) this.copied.set(null); }, 1500);
      },
      () => {},
    );
  }
}
