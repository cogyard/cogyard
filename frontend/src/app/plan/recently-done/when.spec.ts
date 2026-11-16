import { groupByWhen } from './when';

// The strip's time groups (task 198). "Now" is Friday 9 October 2026, local time.
const NOW = new Date(2026, 9, 9, 15, 0);
const t = (id: string, doneDate: string) => ({ id, title: id, type: null, labels: [], doneDate, done: 1, total: 1, boxes: [{ done: true, onMain: null }] });
const labels = (ids: [string, string][], ws: 'sunday' | 'monday') =>
  groupByWhen(ids.map(([id, d]) => t(id, d)), NOW, ws).map((g) => `${g.label}: ${g.tasks.map((x) => x.id).join(' ')}`);

describe('groupByWhen', () => {
  it('walks Today → Yesterday → weeks → months, newest first, leaving out empty groups', () => {
    expect(labels([
      ['1', '2026-10-09'], ['2', '2026-10-08'], ['3', '2026-10-06'], ['4', '2026-10-01'],
      ['5', '2026-09-23'], ['6', '2026-09-16'], ['7', '2026-09-10'], ['8', '2026-07-03'], ['9', '2025-12-20'],
    ], 'monday')).toEqual([
      'Today: 1', 'Yesterday: 2', 'This week: 3', 'Last week: 4',
      '2 weeks ago: 5', '3 weeks ago: 6', 'September: 7', 'July: 8', 'Dec 2025: 9',
    ]);
  });

  it('follows the Settings week start: Sunday 4 Oct is this week from Sunday, last week from Monday', () => {
    const tasks: [string, string][] = [['1', '2026-10-05'], ['2', '2026-10-04'], ['3', '2026-09-27']];
    expect(labels(tasks, 'monday')).toEqual(['This week: 1', 'Last week: 2', '2 weeks ago: 3']);
    expect(labels(tasks, 'sunday')).toEqual(['This week: 1 2', 'Last week: 3']);
  });

  it('puts the day each task was done in its chip note', () => {
    expect(groupByWhen([t('1', '2026-10-06')], NOW, 'monday')[0].tasks[0].note).toBe('done Tue 6 Oct');
  });
});
