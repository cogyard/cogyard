import { Component, input, output } from '@angular/core';
import { Tabs, TabList, Tab as PTab } from 'primeng/tabs';
import { InProgressComponent } from './in-progress/in-progress.component';
import { AllAttentionComponent } from './all-tabs/attention/all-attention.component';
import { AllCostsComponent } from './all-tabs/costs/all-costs.component';
import { AllDailyComponent } from './all-tabs/daily/all-daily.component';
import { AllReposComponent } from './all-tabs/repos/all-repos.component';

// The All page (task 266): five inner tabs, one question each, in the same tab
// box as a project's Admin tab (.tab-box in styles.scss). It used to be one long
// scroll — the per-project boxes, the nightly briefs, a project table that mixed
// task counts, repo state and money, and five charts, two of them serving two
// questions at once. Now:
//   Plan       task 265's per-project boxes            (in-progress)
//   Attention  where your own time went                (activity)
//   Costs      what the work cost                      (usage, activity, overview)
//   Daily      each project's nightly brief            (overview)
//   Repos      the state of each project's repo        (overview, activity)
// Each tab's page is its own component under all-tabs/ and registers only the
// store entries it reads, so opening one tab fetches nothing another needs.
//
// The inner tab is the address's second part — /all/<section> — so the app
// shell owns it like every other piece of view state: it parses the URL into
// `section` and this component only asks to change it. Bare /all is Plan.
export type AllSection = 'plan' | 'attention' | 'costs' | 'daily' | 'repos';

export const ALL_SECTIONS: { id: AllSection; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'attention', label: 'Attention' },
  { id: 'costs', label: 'Costs' },
  { id: 'daily', label: 'Daily' },
  { id: 'repos', label: 'Repos' },
];

@Component({
  selector: 'app-overview',
  imports: [Tabs, TabList, PTab, InProgressComponent, AllAttentionComponent, AllCostsComponent, AllDailyComponent, AllReposComponent],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
})
export class OverviewComponent {
  section = input<AllSection>('plan');
  readonly sections = ALL_SECTIONS;
  sectionChange = output<AllSection>();
  selectProject = output<string>();
  /** A task chip in the per-project boxes (task 265): open that project's task. */
  openTask = output<{ slug: string; id: string }>();
}
