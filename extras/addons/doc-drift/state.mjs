// state.mjs — what this add-on remembers between runs, at
// $COGYARD_HOME/doc-drift.json.
//
// Why the memory is here and not in the report file: the report is DELETED when
// a project has no findings (silence must mean silence), and a run that asked
// the agent "is this doc stale?" and got a clear NO must not ask again tomorrow
// for free. Keeping the fingerprint outside the store means the expensive
// answer survives the empty report.
//
// It holds nothing authoritative — every fact in it is re-derivable by running
// the query again. Deleting this file costs one extra agent pass, nothing more.
// The same posture as the tunnel add-on's tunnels.json: the add-on owns its own
// state, core stores nothing on its behalf.

import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { HOME } from './cogyard.mjs';

const STATE_PATH = join(HOME, 'doc-drift.json');

function readState() {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

// Atomic tmp+rename — a 05:20 run writes this while status() may be reading it
// to render the Settings card.
function writeState(next) {
  mkdirSync(HOME, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, STATE_PATH);
  return next;
}

function rememberProject(slug, patch) {
  const all = readState();
  all[slug] = { ...(all[slug] || {}), ...patch };
  writeState(all);
  return all[slug];
}

function lastFingerprint(slug) {
  return readState()[slug]?.fingerprint ?? null;
}

export { STATE_PATH, readState, writeState, rememberProject, lastFingerprint };
