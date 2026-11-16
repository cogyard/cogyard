import { TestBed } from '@angular/core/testing';
import { AgentStateComponent } from './agent-state.component';
import { LiveState } from '../../services/models';

// What a claimed task's status line says (task 202), per the approved mockups:
// your own claim → logo, state word, time; someone else's → their name; an
// autopilot worker's → the autopilot note, on its own line on a card and inline
// in a table row.

function render(inputs: { live?: LiveState | null; claimedBy?: string | null; claimedAt?: string | null; other?: boolean; layout?: 'card' | 'row' }) {
  const f = TestBed.createComponent(AgentStateComponent);
  for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
  f.detectChanges();
  return f.nativeElement as HTMLElement;
}
const live = (state: LiveState['state'], extra: Partial<LiveState> = {}): LiveState =>
  ({ driver: 'claude', state, since: Date.now() - 4 * 60_000, at: Date.now(), autopilot: false, ...extra });
const text = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ').trim();

describe('AgentStateComponent', () => {
  it('your own claim: the driver logo, the state word and how long', () => {
    const el = render({ live: live('working') });
    expect(el.querySelector('img.logo')!.getAttribute('src')).toBe('/api/drivers/claude/logo');
    expect(el.querySelector('.live')!.getAttribute('data-state')).toBe('working');
    expect(text(el)).toBe('running4m');
  });

  it('names every state in plain words', () => {
    expect(text(render({ live: live('needs') }))).toBe('waiting4m');
    expect(text(render({ live: live('stopped') }))).toBe('idle4m');
    expect(text(render({ live: live('background') }))).toBe('idle4m'); // a row: the dot says it, not words
    expect(text(render({ live: live('error', { error: 'rate_limit' }) }))).toBe('error4m');
    expect(text(render({ live: live('archived', { since: null }) }))).toBe('chat archived');
    expect(text(render({ live: live('deleted', { since: null }) }))).toBe('chat deleted');
    expect(text(render({ live: live('unknown', { since: null }) }))).toBe('no live signal');
  });

  // Idle with a job it started still running (task 229): its own dot state
  // everywhere; the note on a card only — in a table row it crowded the title.
  it('idle with a background job: the note on a card, the dot alone in a row, the tooltip in both', () => {
    const card = render({ layout: 'card', live: live('background') });
    expect(card.querySelector('.live')!.getAttribute('data-state')).toBe('background');
    expect(text(card)).toBe('idle4m· background job running'); // spaced by the line's gap, not text
    const row = render({ layout: 'row', live: live('background') });
    expect(row.querySelector('.live')!.getAttribute('data-state')).toBe('background');
    expect(row.querySelector('.bg-note')).toBeNull();
    expect(render({ layout: 'card', live: live('stopped') }).querySelector('.bg-note')).toBeNull();

    // Make the state BEFORE the component: creating it resets the shared clock,
    // so a `since` taken after that is up to a few ms younger than 4m and the
    // tooltip floors to "3m" (flaked on CI after task 229 merged).
    const bg = live('background');
    const f = TestBed.createComponent(AgentStateComponent);
    f.componentRef.setInput('live', bg);
    f.detectChanges();
    expect(f.componentInstance.tip()).toBe('Claude finished its turn and is waiting on you; a job it started is still running in the background (4m)');
  });

  it('someone else\'s claim: their initials and name, how long they have held it, no live state', () => {
    const el = render({ live: null, other: true, claimedBy: 'Sam Rivera', claimedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect(el.querySelector('.ava')!.textContent!.trim()).toBe('SR');
    expect(text(el)).toBe('SRSam Rivera · 3h');
    expect(el.querySelector('.live')).toBeNull();
  });

  // The note is a sibling of the state on a card (its own line: .line.card is a
  // column), and inside the state's own row in a table.
  const note = (el: HTMLElement, where: string) => text(el.querySelector(where) as HTMLElement);
  it('autopilot on a card: a second line with the note for a finished or stuck worker', () => {
    const card = (state: LiveState['state']) => render({ layout: 'card', live: live(state, { autopilot: true }) });
    expect(card('working').querySelector('.line.card')).not.toBeNull();
    expect(note(card('working'), '.line.card > .hint.sm')).toBe('autopilot');
    expect(note(card('stopped'), '.line.card > .hint.sm')).toBe('autopilot · worker done — autopilot is checking it');
    expect(note(card('needs'), '.line.card > .hint.sm')).toBe('autopilot · run is stuck waiting on you');
  });

  it('autopilot in a table row: inline, after the time', () => {
    const el = render({ layout: 'row', live: live('working', { autopilot: true }) });
    expect(el.querySelector('.line.card')).toBeNull();
    expect(note(el, '.live > .hint.sm')).toBe('· autopilot');
  });

  it('nothing to show: renders nothing', () => {
    expect(text(render({ live: null }))).toBe('');
  });
});
