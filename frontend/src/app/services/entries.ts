import { Observable } from 'rxjs';
import { ApiService } from './api.service';

// The one table that says how to fetch each kind of cache entry (task 173).
// Components name an entry ('tasks|<slug>', 'graph|<slug>|<focus>', …) through
// StoreService.use(); only RefreshService fetches, and it asks here how. Entry
// names are also what GET /api/versions takes (core/versions.mjs), so a new kind
// of entry is added in three places: this table, the reader, and — if it can be
// fingerprinted cheaply — core/versions.mjs. Without the last it is simply polled.
//
// Entries a page loads on demand (Cleanup, a task's chats, a transcript, the
// Settings panes) are not in here: they are loaded when opened, not watched.
export function fetchFor(api: ApiService, key: string): Observable<unknown> | null {
  const [kind, slug, ...rest] = key.split('|');
  switch (kind) {
    case 'projects': return api.projects();
    case 'config': return api.config();
    case 'overview': return api.overview();
    case 'activity': return api.activity();
    case 'usage': return slug ? api.projectUsage(slug) : api.usage();
    case 'tasks': return slug ? api.tasks(slug) : null;
    case 'daily': return slug ? api.daily(slug) : null;
    case 'plan': return slug ? api.plan(slug) : null;
    case 'recent': return slug ? api.recentlyDone(slug) : null;
    case 'branches': return slug ? api.branches(slug) : null;
    case 'worktrees': return slug ? api.worktrees(slug) : null;
    case 'graph': return slug ? api.graph(slug, rest[0] || null) : null;
    // The task store's graph (task 191) — 'storegraph|<slug>|flagged' or '|all'.
    // No change code in core/versions.mjs, so it is re-fetched on every check,
    // like the code graph: a new store commit shows without a reload.
    case 'storegraph': return slug ? api.storeGraph(slug, rest[0] === 'flagged') : null;
    case 'wt-activity': return slug ? api.wtActivity(slug) : null;
    // 'tree|<slug>|<wt>[|ig][|c=<sha>]' — c= = the commit the Files tab compares against (task 224)
    case 'tree': return slug ? api.tree(slug, rest[0] ?? '', rest.includes('ig'), rest.find((r) => r.startsWith('c='))?.slice(2) || null) : null;
    default: return null;
  }
}
