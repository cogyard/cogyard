import { Routes } from '@angular/router';

// URL is the source of truth for navigation. These are componentless routes —
// the App shell parses the active URL (segments + query) to drive which view +
// project + task + commit panel render, rather than projecting routed
// components into an outlet. Shapes:
//   /                       → redirected to the first project's tasks
//   /all                    → all-projects overview
//   /p/:slug/:tab           → tab ∈ tasks | board | worktrees | graph
//     ?task=NN              → filter the Tasks list to a task
//     ?commit=hash          → open the commit side panel
export const routes: Routes = [
  { path: 'all', children: [] },
  { path: 'settings', children: [] }, // /settings view + the empty-state setup wizard (task 060)
  { path: 'p/:slug/:tab', children: [] },
  { path: '', pathMatch: 'full', children: [] },
  { path: '**', children: [] },
];
