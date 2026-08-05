// The per-project tab strip — single source of truth for ids + labels.
// The shell renders these (minus ui.hiddenTabs) and the global Settings view
// offers one visibility checkbox per row. Mirrors PORTAL_TABS in core/config.mjs,
// which validates the persisted ids server-side.
export type PortalTabId = 'tasks' | 'board' | 'branches' | 'worktrees' | 'graph' | 'files' | 'stats';

export const PORTAL_TABS: { id: PortalTabId; label: string; icon: string }[] = [
  { id: 'tasks', label: 'Tasks', icon: 'assets/tasks.svg' },
  { id: 'board', label: 'Board', icon: 'assets/board.svg' },
  { id: 'branches', label: 'Branches', icon: 'assets/git-branch.svg' },
  { id: 'worktrees', label: 'Worktrees', icon: 'assets/git-worktree.svg' },
  { id: 'graph', label: 'git Graph', icon: 'assets/git-graph.svg' },
  { id: 'files', label: 'Files', icon: 'assets/files.svg' },
  { id: 'stats', label: 'Stats', icon: 'assets/stats.svg' },
];
