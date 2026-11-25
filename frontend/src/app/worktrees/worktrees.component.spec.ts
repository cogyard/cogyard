import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { WorktreesComponent } from './worktrees.component';
import { StoreService } from '../services/store.service';
import { WorktreesResponse } from '../services/models';

// The Backend and Frontend columns. Every worktree has reserved ports, but one
// whose .cogyard/worktree.json names no dev server (devServer false — an Xcode
// app) has nothing listening on them, so its cells show "—" like a row with no
// ports, rather than links to nowhere. A worktree with a dev server, or one with
// no config at all (devServer null), keeps its links.
const SLUG = 'zz-163-check';
const row = (name: string, devServer: boolean | null) => ({
  path: `/repo/.claude/worktrees/${name}`, name, branch: `worktree-${name}`, head: 'abc1234', isMain: false,
  locked: false, ahead: 1, behind: 0, dirty: false, dirtyCount: 0, stale: false, staleReasons: [],
  ports: { backend: 30100, frontend: 31100, hostname: null }, devServer, claimedByTaskId: null, tasksMounted: null,
});

function ports(devServer: boolean | null): string[] {
  TestBed.inject(StoreService).sig<WorktreesResponse>(`worktrees|${SLUG}`)
    .set({ slug: SLUG, label: SLUG, worktrees: [row('wt', devServer)] });
  const f = TestBed.createComponent(WorktreesComponent);
  f.componentRef.setInput('slug', SLUG);
  f.detectChanges();
  const cells = [...(f.nativeElement as HTMLElement).querySelectorAll('tr.wt-row td.mono')].slice(1); // after Head
  return cells.map((td) => (td.querySelector('a.portlink') ? `link ${td.textContent!.trim()}` : td.textContent!.trim()));
}

describe('WorktreesComponent — the port columns', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }));

  it('a worktree with a dev server: both ports are links', () => {
    expect(ports(true)).toEqual(['link 30100', 'link 31100']);
  });

  it('a worktree whose config names no dev server: both columns show nothing', () => {
    expect(ports(false)).toEqual(['—', '—']);
  });

  it('a worktree with no config: the links stay, as before', () => {
    expect(ports(null)).toEqual(['link 30100', 'link 31100']);
  });
});
