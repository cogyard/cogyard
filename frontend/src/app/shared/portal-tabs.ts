// The per-project tab strip — single source of truth for ids + labels.
// The shell renders these (minus ui.hiddenTabs) and the global Settings view
// offers one visibility checkbox per row. Mirrors PORTAL_TABS in core/config.mjs,
// which validates the persisted ids server-side.
//
// Stats and Cleanup are not here (task 249): they look after the project rather
// than the work in it, so they are inner tabs of the Admin tab pinned to the
// strip's right (admin/admin.component.ts), which is never hideable.
export type PortalTabId = 'daily' | 'tasks' | 'plan' | 'branches' | 'worktrees' | 'graph' | 'files';

export const PORTAL_TABS: { id: PortalTabId; label: string; icon: string }[] = [
  // First on purpose (owner, 2026-08-20): the tab you open when you come BACK to
  // a project after time away. It is NOT the landing tab — every navigation
  // still lands on Tasks — because someone deep in a project does not need it,
  // and the brief spent a day pinned above the task list proving that.
  //
  // "Daily", not "Brief": it holds whatever the nightly jobs left for this
  // project, not one job's output. It is CORE and PERMANENT — it renders here
  // whether or not any job is installed, and an add-on's whole integration is
  // writing a file into the task store (owner, 2026-08-20). That is what keeps
  // the add-ons simple: none of them contributes a panel, owns a tab, or knows
  // the portal exists.
  { id: 'daily', label: 'Daily', icon: 'assets/daily.svg' },
  { id: 'tasks', label: 'Tasks', icon: 'assets/tasks.svg' },
  // Replaced the status-column Board (owner, 2026-10-06, task 179): what's left
  // in the order it can run. Old /p/x/board links and a hidden 'board' carry over
  // (TAB_ID_ALIASES in core/config.mjs; the URL alias in app.component.ts).
  { id: 'plan', label: 'Plan', icon: 'assets/plan.svg' },
  { id: 'branches', label: 'Branches', icon: 'assets/git-branch.svg' },
  { id: 'worktrees', label: 'Worktrees', icon: 'assets/git-worktree.svg' },
  { id: 'graph', label: 'git Graph', icon: 'assets/git-graph.svg' },
  { id: 'files', label: 'Files', icon: 'assets/files.svg' },
];
