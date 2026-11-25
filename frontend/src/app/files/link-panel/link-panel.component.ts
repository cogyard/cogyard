import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { FileLink } from '../../services/models';
import { TaskIndexService } from '../../services/task-index.service';
import { LinkMarkComponent } from '../link-mark/link-mark.component';

// The Files tab's right side for a link it can't open as a file — a link to a
// folder, a broken link, or one leading outside the repo (task 269, the owner's
// pick from the options sheet). It used to say "Not on disk in this worktree",
// which was wrong: the link is on disk, it points elsewhere. This says where it
// points, whether anything is there, and — for the project's task link — what
// it is, with a way to the Tasks tab. It never reads inside the target.
const TASK_LINK = '.cogyard/tasks';

@Component({
  selector: 'app-link-panel',
  imports: [LinkMarkComponent],
  templateUrl: './link-panel.component.html',
  styleUrl: './link-panel.component.scss',
})
export class LinkPanelComponent {
  private router = inject(Router);
  private tasks = inject(TaskIndexService);

  slug = input.required<string>();
  path = input.required<string>();   // the link's repo-relative path
  link = input.required<FileLink>();
  src = input.required<string>();    // the icon of what it points at (the tree row's)

  isTaskLink = computed(() => this.path() === TASK_LINK);
  broken = computed(() => this.link().kind === 'broken');
  heading = computed(() => {
    const l = this.link();
    if (l.kind === 'broken') return 'Broken link';
    const where = l.inside ? 'inside' : 'outside';
    return l.kind === 'dir' ? `Link to a folder ${where} this repo` : `Link to a file ${where} this repo`;
  });
  // The task link's count, from the project's task list (null while it loads).
  taskCount = computed(() => {
    if (!this.isTaskLink()) return null;
    const n = this.tasks.index(this.slug())().size;
    return n > 0 ? n : null;
  });

  constructor() {
    // Read the project's task list only for the task link (task 173's reader model).
    this.tasks.watch(() => (this.isTaskLink() ? this.slug() : null));
  }

  openTasks() { this.router.navigate(['/p', this.slug(), 'tasks']); }
}
