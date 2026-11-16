import { Component, inject, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ApiService } from './api.service';
import { RefreshService, CHECK_MS } from './refresh.service';
import { StoreService } from './store.service';

// The refresher's two rules, pinned against the loop that shipped with task 173:
//
//   1. A page re-rendering its rows must not make the refresher check again.
//      A row's task chip is a reader of the project's task list; re-rendering
//      destroys it and creates its replacement. If that counted as a NEW reader,
//      it fired a check, the check re-downloaded the rows (Worktrees and Graph
//      have no change code), and the rows re-rendered again — ~10 checks a
//      second on any page where a single chip held the task list.
//   2. A first-reader check asks about, and loads, only the new entry — not
//      every no-code entry on screen.
//
// The fake API answers synchronously and hands back NEW row objects on every
// load, the way a real re-download does; the host tracks rows by identity, so
// each load rebuilds them, as PrimeNG's table does by default.

@Component({ selector: 't-chip', template: '' })
class ChipStub {
  constructor() { inject(StoreService).use(() => 'tasks|p'); }
}

@Component({
  selector: 't-rows',
  imports: [ChipStub],
  template: `@for (r of rows() ?? []; track r) { <t-chip /> }`,
})
class RowsHost {
  key = input('worktrees|p');
  rows = inject(StoreService).use<{ path: string }[]>(() => this.key());
}

@Component({ selector: 't-reader', template: '' })
class Reader {
  key = input.required<string>();
  constructor() { inject(StoreService).use(() => this.key()); }
}

function fakeApi() {
  const calls = { versions: [] as string[][], worktrees: 0, tasks: 0 };
  const api = {
    // Tasks have a change code that never moves; Worktrees has none.
    versions: (keys: string[]) => {
      calls.versions.push([...keys]);
      return of(Object.fromEntries(keys.map((k) => [k, k.startsWith('tasks|') ? 'same' : null])));
    },
    worktrees: () => { calls.worktrees++; return of([{ path: '/wt/one' }]); },
    tasks: () => { calls.tasks++; return of({ tasks: [] }); },
  };
  return { api, calls };
}

describe('RefreshService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Advance fake time in small steps, letting effects and rendering run between.
  function run(ms: number, fixtures: { detectChanges(): void }[]) {
    for (let t = 0; t < ms; t += 50) {
      vi.advanceTimersByTime(50);
      for (const f of fixtures) f.detectChanges();
      TestBed.tick();
    }
  }

  it('checks once per interval on a page whose rows (and their one task chip) re-render on every load', () => {
    const { api, calls } = fakeApi();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    TestBed.inject(RefreshService);
    const host = TestBed.createComponent(RowsHost);

    run(1000, [host]); // the page's first load: rows, then the chip's task list
    expect(calls.worktrees).toBe(1);
    const before = calls.versions.length;

    run(3 * CHECK_MS, [host]);
    expect(calls.versions.length - before).toBe(3);
    expect(calls.worktrees).toBe(1 + 3);
  });

  it('a first-reader check asks about and loads only the new entry', () => {
    const { api, calls } = fakeApi();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    TestBed.inject(RefreshService);
    const host = TestBed.createComponent(RowsHost);
    run(1000, [host]);
    const worktreesBefore = calls.worktrees;
    const versionsBefore = calls.versions.length;

    const reader = TestBed.createComponent(Reader);
    reader.componentRef.setInput('key', 'tasks|q');
    run(500, [host, reader]);

    expect(calls.versions.slice(versionsBefore)).toEqual([['tasks|q']]);
    expect(calls.worktrees).toBe(worktreesBefore); // Worktrees was not re-downloaded
  });
});
