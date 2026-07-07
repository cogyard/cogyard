// The per-project tab strip — single source of truth for ids + labels.
// The shell renders these (minus ui.hiddenTabs) and the global Settings view
// offers one visibility checkbox per row. Mirrors PORTAL_TABS in core/config.mjs,
// which validates the persisted ids server-side.
export type PortalTabId = 'tasks' | 'board' | 'branches' | 'worktrees' | 'graph' | 'files' | 'stats';

export const PORTAL_TABS: { id: PortalTabId; label: string }[] = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'board', label: 'Board' },
  { id: 'branches', label: 'Branches' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'graph', label: 'Graph' },
  { id: 'files', label: 'Files' },
  { id: 'stats', label: 'Stats' },
];
