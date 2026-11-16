import { Component, computed, input, signal } from '@angular/core';
import { TooltipModule } from 'primeng/tooltip';
import { LiveState } from '../../services/models';

// ONE rendering of "who is on this claimed task, and what is its agent doing
// right now" (task 202) — the Plan card's status line and the Tasks tab's
// Status-column detail are both this component, so they cannot drift.
//
//   Claimed by this machine's user → the driver's logo (served by the driver,
//     GET /api/drivers/<name>/logo — no agent's logo lives in the portal), a
//     dot, the state word and how long it has been in it: "running 4m",
//     "waiting 2m", "idle 18m", "error 1m", "chat archived", "chat deleted",
//     "no live signal". The words are the owner's (2026-10-13; archived /
//     deleted 2026-10-16, task 226 — there is no "closed": a chat whose
//     process ended is still in the app, and reads idle); the dot matches the Claude
//     Desktop sidebar (amber / ring); running is blinking blue and error red (owner).
//   Claimed by someone else → their initials and name and how long they have
//     held it ("Sam Rivera · 3h"); their agent runs on their machine.
//
// During an autopilot run the record is the task's own worker's, and the line
// says so: on a card (`layout="card"`) as a second line, in a table row inline.
//
// The times count up in the browser from `since`, so a ticking "4m" needs no
// refetch (core/live-state.mjs liveSignature).

// 'background' reads idle — the turn is over and the chat waits on you — with
// a note that a job it started (a dev server, a worker) is still running
// (task 229; owner chose the ring with a blue centre, 2026-10-18). The note
// shows on a Plan card only: in a table row it crowded the task's title out
// of its cell, so a row has the dot and the tooltip says it (owner).
const WORD: Record<LiveState['state'], string> = {
  working: 'running', needs: 'waiting', stopped: 'idle', background: 'idle', error: 'error',
  archived: 'chat archived', deleted: 'chat deleted', unknown: 'no live signal',
};
const MEANS: Record<LiveState['state'], string> = {
  working: 'is working — thinking or running tools',
  needs: 'is waiting on you — a permission prompt, a question or a plan to approve',
  stopped: 'finished its turn and is idle until your next message',
  background: 'finished its turn and is waiting on you; a job it started is still running in the background',
  error: 'stopped on an error',
  archived: 'chat on this task was archived',
  deleted: 'chat on this task was deleted',
  unknown: 'is not reporting what it is doing',
};

// One clock for every status line on the page, ticking twice a minute.
const now = signal(Date.now());
let ticking = false;
function startClock() {
  now.set(Date.now()); // a line made between ticks counts from now, not the last tick
  if (ticking) return;
  ticking = true;
  setInterval(() => now.set(Date.now()), 30_000);
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

@Component({
  selector: 'app-agent-state',
  imports: [TooltipModule],
  templateUrl: './agent-state.component.html',
  styleUrl: './agent-state.component.scss',
})
export class AgentStateComponent {
  live = input<LiveState | null>(null);
  claimedBy = input<string | null>(null);
  claimedAt = input<string | null>(null);
  /** Claimed by a named person who is not this machine's user. */
  other = input(false);
  layout = input<'card' | 'row'>('row');

  constructor() { startClock(); }

  word = computed(() => WORD[this.live()?.state ?? 'unknown']);
  elapsed = computed(() => {
    const since = this.live()?.since;
    return since ? ago(Math.max(0, now() - since)) : '';
  });
  heldFor = computed(() => {
    const at = this.claimedAt();
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? ago(Math.max(0, now() - t)) : '';
  });
  initials = computed(() => (this.claimedBy() || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''));
  logo = computed(() => { const d = this.live()?.driver; return d ? `/api/drivers/${encodeURIComponent(d)}/logo` : null; });
  agentName = computed(() => { const d = this.live()?.driver || 'the agent'; return d.charAt(0).toUpperCase() + d.slice(1); });
  autopilotNote = computed(() => {
    const l = this.live();
    if (!l?.autopilot) return null;
    if (l.state === 'stopped') return 'worker done — autopilot is checking it';
    if (l.state === 'needs') return 'run is stuck waiting on you';
    if (l.state === 'error') return 'worker stopped on an error';
    return null;
  });
  tip = computed(() => {
    const l = this.live();
    if (!l) return '';
    // Archived / deleted is the whole chat's, autopilot run or not.
    const gone = l.state === 'archived' || l.state === 'deleted';
    const who = l.autopilot && !gone ? `${this.agentName()}'s autopilot worker` : this.agentName();
    const why = l.state === 'error' && l.error ? `: ${l.error.replace(/_/g, ' ')}` : '';
    return `${who} ${MEANS[l.state]}${why}${this.elapsed() ? ` (${this.elapsed()})` : ''}`;
  });

  logoFailed = signal(false);
}
