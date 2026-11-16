import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import { AppComponent } from './app.component';
import { routes } from './app.routes';
import { ConfigResponse } from './services/models';

// The shell's smoke test: does the portal boot, and does the sidebar fill from
// /api/projects. Two assertions against a forty-tab app — it is a boot check,
// not coverage, and is worth having only because a shell that fails to
// construct takes every other page with it.
//
// Since task 173 nothing fetches on construction. The shell and ConfigService
// register as READERS of the 'projects' and 'config' store entries; on the
// first change detection those registrations run, the shared refresher checks
// GET /api/versions for the watched entries, and only then loads the ones whose
// code is new — here, both. So the order is: one /api/versions, then
// /api/config and /api/projects. A test that forgets any of them fails in
// `verify()` rather than where the mistake is.

const CONFIG: Partial<ConfigResponse> = {
  home: '/tmp/.cogyard',
  homeFromEnv: false,
  projectsRoot: '/tmp/gitroot',
  projectsRootSource: 'default',
  version: '0.0.0-test',
  commit: null,
  openTargets: [],
  defaults: { kind: 'single' },
  kinds: [],
  driver: { active: 'none', available: [] },
};

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), MessageService],
    }).compileComponents();
  });

  afterEach(() => {
    // verify() in a `try` with the reset in `finally`: when it throws, the
    // TestBed must still be torn down, or the next test dies on "Cannot
    // configure the test module when the test module has already been
    // instantiated" and ONE real failure is reported as two. That cascade is
    // what made this file look twice as broken as it was.
    const http = TestBed.inject(HttpTestingController);
    try {
      http.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render the shell heading and load the project list', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    const http = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    await new Promise((r) => setTimeout(r)); // first-reader checks are batched to the end of the task

    const check = http.expectOne((r) => r.url === '/api/versions');
    expect(check.request.params.getAll('k')?.sort()).toEqual(['config', 'projects']);
    check.flush({ config: 'c1', projects: 'p1' });
    http.expectOne('/api/config').flush(CONFIG);
    http.expectOne('/api/projects').flush([{ slug: 'cogyard', label: 'cogyard' }]);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('cogyard');
    const buttons = [...compiled.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(buttons).toContain('cogyard');
  });
});
