import { Component, input, output } from '@angular/core';
import { Tabs, TabList, Tab as PTab } from 'primeng/tabs';
import { ProjectSettingsComponent } from '../project-settings/project-settings.component';
import { PublishingComponent } from '../project-settings/publishing/publishing.component';
import { SwitchesComponent } from '../project-settings/switches/switches.component';
import { ProjectIconComponent } from '../project-settings/icon/icon.component';
import { AxesComponent } from '../shared/axes/axes.component';
import { StatsComponent } from '../stats/stats.component';
import { CleanupComponent } from '../cleanup/cleanup.component';

// A project's Admin tab (task 249) — the tab pinned to the right of the strip,
// which was the icon-only "project settings" cog (task 135). It holds what is
// about looking after the project rather than the work in it, under its own row
// of inner tabs: Info (things you only read), Settings (things you change), and
// Stats and Cleanup, which used to be top-level tabs and moved in unchanged.
//
// The inner tab is the address's fourth part — /p/<slug>/admin/<section> — so
// the app shell owns it like every other piece of view state: it parses the
// URL into `section` and this component only asks to change it.
export type AdminSection = 'info' | 'settings' | 'stats' | 'cleanup';

export const ADMIN_SECTIONS: { id: AdminSection; label: string }[] = [
  { id: 'info', label: 'Info' },
  { id: 'settings', label: 'Settings' },
  { id: 'stats', label: 'Stats' },
  { id: 'cleanup', label: 'Cleanup' },
];

@Component({
  selector: 'app-admin',
  imports: [Tabs, TabList, PTab, ProjectSettingsComponent, PublishingComponent, SwitchesComponent, ProjectIconComponent, AxesComponent, StatsComponent, CleanupComponent],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss',
})
export class AdminComponent {
  slug = input.required<string>();
  section = input<AdminSection>('info');

  readonly sections = ADMIN_SECTIONS;

  sectionChange = output<AdminSection>();
  jumpTask = output<string>();
  jumpWorktree = output<string>();
}
