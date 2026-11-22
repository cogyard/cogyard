import { Routes } from '@angular/router';

// URL is the source of truth for navigation. These are componentless routes —
// the App shell parses the active URL (segments + query) to drive which view +
// project + task + commit panel render, rather than projecting routed
// components into an outlet. Shapes:
//   /                       → redirected to the first project's tasks
//   /all                    → all-projects overview, its Plan tab
//   /all/:section           → the All page's inner tab (overview/overview.component.ts);
//                             a missing or unknown one is Plan
//   /p/:slug/:tab           → tab ∈ PORTAL_TABS (shared/portal-tabs.ts); legacy ids alias forward
//   /p/:slug/admin/:section → the Admin tab's inner tab (admin/admin.component.ts);
//                             bare /p/:slug/admin is its Info tab
//     ?task=NN              → filter the Tasks list to a task
//     ?commit=hash          → open the commit side panel
export const routes: Routes = [
  { path: 'all', children: [] },
  { path: 'all/:section', children: [] },
  { path: 'settings', children: [] }, // /settings view + the empty-state setup wizard
  { path: 'p/:slug/:tab', children: [] },
  { path: 'p/:slug/:tab/:section', children: [] },
  { path: '', pathMatch: 'full', children: [] },
  { path: '**', children: [] },
];
