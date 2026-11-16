// ~/.cogyard/addons/chat-archive/addon.mjs — a copy of every chat that the agent
// cannot delete.
//
// THE PROBLEM. An agent's chats hold decisions, dead ends and the reasoning
// behind code, and their only home is the agent's own folders on this machine.
// Claude Code deletes conversations older than a setting (30 days by default),
// and one changed setting or a new machine brings that back. Time Machine helps,
// but it thins old backups, so a file deleted long ago ages out of it too.
//
// THE ANSWER. Once a day, copy every conversation and every chat record into
// $COGYARD_HOME/chat-archive/, adding and updating, never removing. When the
// agent deletes a file, the copy stays and the manifest marks it gone from
// source. Where the stores live is the driver's to say (transcripts.root() and
// sessions.root()) — nothing here names an agent's folder.
//
// THE DESTINATION IS FIXED, deliberately (owner, 2026-10-06): it lives under
// COGYARD_HOME so there is no setting to forget and no second folder to
// remember. Getting it off this machine (a NAS) is a separate, later step.
//
// IT NEVER WRITES INTO THE AGENT'S FOLDERS. It reads them and writes only under
// the archive. No agent call, no network, no cost.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, cogyardCore } from './cogyard.mjs';
import { readHeartbeat, readManifest, runArchive, writeHeartbeat } from './archive.mjs';

const ARCHIVE_DIR = join(HOME, 'chat-archive');

// The two stores, by the names they get inside the archive.
const CONVERSATIONS = 'conversations';
const CHAT_RECORDS = 'chat-records';

// The engine, loaded once in the background so prereqs() — which the loader
// calls synchronously — can name the source folders once it is here. Until
// then prereqs() simply has less to say; the run itself awaits it properly.
let loadedCore = null;
cogyardCore().then((c) => { loadedCore = c; }, () => {});

function treesFrom(core) {
  const a = core?.adapter;
  return [
    { name: CONVERSATIONS, root: a?.transcripts?.supported ? a.transcripts.root() : null },
    { name: CHAT_RECORDS, root: typeof a?.sessions?.root === 'function' ? a.sessions.root() : null },
  ];
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// Local wall-clock date — same rule as the other jobs' dayStamp.
function dayStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const manifest = {
  id: 'chat-archive',
  label: 'Chat archive',
  description: 'Once a day, copies every agent conversation and chat record into ~/.cogyard/chat-archive/. It adds and updates, never deletes: when the agent removes a chat, the copy stays.',
  icon: '🗄️',
  thirdParty: false,

  // 04:40 local, clear of the other nightly jobs (05:00, 05:20). Daily is ample:
  // the agent's own deletion window is measured in weeks. catchUp on — a laptop
  // asleep at 04:40 is the normal case.
  schedule: { every: 'day', at: '04:40', catchUp: true },

  // No agent call: this job only reads and copies files, so it never needs the
  // agent's credential and its row must never warn about one.
  needsAgent: false,

  // Core aborts the run at timeoutMs. A first run copies a few GB; later runs
  // copy only what changed. maxUnits/maxCostUsd mean nothing to a file copy.
  bounds: { timeoutMs: 30 * 60 * 1000 },

  configSchema: [],

  status() {
    const m = readManifest(ARCHIVE_DIR);
    const entries = Object.values(m.files);
    const hb = readHeartbeat(ARCHIVE_DIR);
    if (!entries.length && !hb) {
      return { enabled: false, healthy: null, summary: 'not run yet', details: { archive: ARCHIVE_DIR } };
    }
    const gone = entries.filter((e) => e.goneFromSource && !e.keptFrom).length;
    const kept = entries.filter((e) => e.keptFrom).length;
    const bits = [`${plural(entries.length - kept, 'file')} kept`];
    if (gone) bits.push(`${gone.toLocaleString('en-US')} gone from the agent's folders`);
    if (hb?.checked) bits.push(`last looked ${hb.checked}`);
    return {
      enabled: true,
      healthy: hb ? hb.outcome !== 'failed' : null,
      summary: bits.join(' · '),
      details: { archive: ARCHIVE_DIR, files: entries.length - kept, goneFromSource: gone, previousVersionsKept: kept, lastOutcome: hb?.outcome || null },
    };
  },

  prereqs() {
    const rows = [];
    if (!loadedCore) return rows;
    for (const t of treesFrom(loadedCore)) {
      const label = t.name === CONVERSATIONS ? 'The agent\'s conversations folder' : 'The agent app\'s chat records folder';
      if (!t.root) {
        rows.push({
          id: t.name, label, ok: t.name !== CONVERSATIONS,
          fixHint: t.name === CONVERSATIONS
            ? 'No agent driver is active, so there is nothing to copy.'
            : 'The active driver does not say where its chat records live; only conversations are copied.',
        });
        continue;
      }
      const found = existsSync(t.root);
      rows.push({ id: t.name, label: `${label} (${t.root})`, ok: found, fixHint: found ? undefined : `Not found at ${t.root} — nothing from it will be copied until it exists.` });
    }
    return rows;
  },

  // Unattended. No prompts, nothing that waits for a human. Idempotent: a re-run
  // with nothing new copies nothing and still records that it looked.
  async runScheduled(cfg = {}, ctx = {}) {
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    const date = dayStamp();

    let core;
    try { core = await cogyardCore(); } catch (e) {
      const error = String((e && e.message) || e);
      log(error);
      writeHeartbeat(ARCHIVE_DIR, manifest.id, { date, outcome: 'failed', note: `Tried to look on ${date} but could not reach cogyard's engine, so nothing was copied.` });
      return { ok: false, summary: 'cannot reach cogyard\'s engine', error };
    }

    const trees = treesFrom(core);
    if (!trees.some((t) => t.root)) {
      log('no agent driver active — nothing to copy');
      return { ok: false, skipped: true, summary: 'no agent driver active', error: 'no agent driver active' };
    }

    let r;
    try {
      r = await runArchive({ archiveDir: ARCHIVE_DIR, trees, signal: ctx.signal, log });
    } catch (e) {
      const error = String((e && e.message) || e);
      log(error);
      writeHeartbeat(ARCHIVE_DIR, manifest.id, { date, outcome: 'failed', note: `Looked on ${date} and could not finish: ${error}` });
      return { ok: false, summary: 'could NOT copy — see the log', error };
    }

    // The counts, in the order a person wants them: problems first.
    const facts = `${plural(r.copied, 'file')} copied, ${r.current.toLocaleString('en-US')} already current`
      + (r.goneTotal ? `, ${r.goneTotal.toLocaleString('en-US')} gone from source (${r.goneNow} new tonight)` : '')
      + (r.kept ? `, ${plural(r.kept, 'previous version')} kept` : '');
    const alarms = [];
    if (r.aborted) alarms.push('run stopped before it finished');
    if (r.failed) alarms.push(`${plural(r.failed, 'file')} could NOT be copied`);
    if (r.missing.includes(CONVERSATIONS)) alarms.push('conversations folder not found');

    const outcome = alarms.length ? 'failed' : r.copied || r.kept ? 'written' : 'unchanged';
    writeHeartbeat(ARCHIVE_DIR, manifest.id, {
      date,
      outcome,
      note: `Looked on ${date}: ${facts}.${alarms.length ? ` Problems: ${alarms.join('; ')}.` : ''}`,
    });

    return {
      ok: !alarms.length,
      skipped: !alarms.length && !r.copied && !r.kept,
      summary: alarms.length ? `${alarms.join(', ')} · ${facts}` : facts,
      error: alarms.length ? alarms.join('; ') : undefined,
    };
  },
};

export default manifest;
