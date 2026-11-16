import { TestBed } from '@angular/core/testing';
import { PlanComponent } from './plan.component';
import { StoreService } from '../services/store.service';
import { PlanClash, PlanResponse, PlanTask } from '../services/models';

// The Plan tab's Autopilot filter (task 239): with the filter on, a task is
// dimmed while it shares a file or a resource with a task IN PROGRESS, and not
// otherwise; sharing never makes it wait.
//
// The plans below are what `cogyard tasks plan --json` returned during a real
// claim → release run on a throwaway store (2026-11-14): tasks 1 and 2 list the
// same file (shared.js); 3 and 4 list the same resource (prod-db) and no file.
// Across the run only who was in progress changed — every task's clash list,
// and "Can start" for whoever wasn't claimed, stayed exactly as below.
const SLUG = 'zz-239-check';
const clash = (id: string, files: string[], resources: string[]): PlanClash => ({ id, files, resources });
const task = (id: string, c: PlanClash): PlanTask =>
  ({ id, status: 'OPEN', youNext: null, youSteps: [], clash: [c], size: 'quick', blocksOther: [] }) as unknown as PlanTask;
const TASKS: Record<string, PlanTask> = {
  1: task('1', clash('2', ['shared.js'], [])),
  2: task('2', clash('1', ['shared.js'], [])),
  3: task('3', clash('4', [], ['prod-db'])),
  4: task('4', clash('3', [], ['prod-db'])),
};
const IDS = ['1', '2', '3', '4'];
const plan = (progress: string[]): PlanResponse => ({
  slug: SLUG, label: SLUG, parked: [], problems: [], axes: [], tasks: TASKS,
  groups: { progress, can: IDS.filter((id) => !progress.includes(id)), dep: [], other: [], look: [] },
}) as unknown as PlanResponse;

function planTab(p: PlanResponse, autopilot = true) {
  TestBed.inject(StoreService).sig<PlanResponse>(`plan|${SLUG}`).set(p);
  const f = TestBed.createComponent(PlanComponent);
  f.componentRef.setInput('slug', SLUG);
  const c = f.componentInstance;
  if (autopilot) c.toggle('auto');
  return c;
}
const dimmed = (c: PlanComponent) => IDS.filter((id) => c.dim(c.t(id)));

describe('PlanComponent — the Autopilot filter (task 239)', () => {
  it('nothing claimed: nothing is dimmed, and nobody waits', () => {
    const c = planTab(plan([]));
    expect(dimmed(c)).toEqual([]);
    expect(c.plan()!.groups.can).toEqual(IDS);
  });

  it('claim 1 (shares a file with 2): 2 is dimmed and says why; it is still "Can start", not waiting', () => {
    const c = planTab(plan(['1']));
    expect(dimmed(c)).toEqual(['2']);
    expect(c.dimWhy(c.t('2'))).toBe('Not Autopilot — Shares shared.js with #1, in progress');
    expect(c.plan()!.groups.can).toContain('2');
    expect(c.plan()!.groups.dep).toEqual([]);
  });

  it('release 1: 2 is no longer dimmed', () => {
    expect(dimmed(planTab(plan([])))).toEqual([]);
  });

  it('claim 3 (shares the resource prod-db with 4, no file): 4 is dimmed and says why; not waiting', () => {
    const c = planTab(plan(['3']));
    expect(dimmed(c)).toEqual(['4']);
    expect(c.dimWhy(c.t('4'))).toBe('Not Autopilot — Shares prod-db with #3, in progress');
    expect(c.plan()!.groups.can).toContain('4');
    expect(c.plan()!.groups.dep).toEqual([]);
  });

  it('release 3: 4 is no longer dimmed', () => {
    expect(dimmed(planTab(plan([])))).toEqual([]);
  });

  it('with the filter off, a claim dims nothing', () => {
    expect(dimmed(planTab(plan(['1']), false))).toEqual([]);
  });
});
