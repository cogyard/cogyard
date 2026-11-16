// archive.mjs — copy the agent's chat stores into the archive, never deleting.
//
// The whole job is "add and update, never remove": when the agent deletes a
// conversation, the archive keeps it and the manifest marks it gone from source.
// Nothing here writes inside a source tree — it reads source files and writes
// only under the archive folder.
//
// Layout:
//   <archive>/<tree>/<path relative to the tree's root>   the copies
//   <archive>/manifest.json                               one entry per copy
//   <archive>/heartbeat.md                                "I looked", every run
//
// A changed file is recopied whole. When the source has SHRUNK below the copy
// we already hold, the agent rewrote it rather than appended to it, so the old
// copy is set aside as <file>.kept-<stamp> before the new one lands — replacing
// it would be deletion by another name. (Claude Code does rewrite conversations:
// its own `<id>.jsonl.superseded-<ms>` files are the evidence.)

import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MANIFEST = 'manifest.json';
const HEARTBEAT = 'heartbeat.md';
const TMP_SUFFIX = '.chat-archive-tmp';

// --- manifest -------------------------------------------------------------------

function readManifest(archiveDir) {
  try {
    const m = JSON.parse(readFileSync(join(archiveDir, MANIFEST), 'utf8'));
    if (m && typeof m === 'object' && m.files && typeof m.files === 'object') return m;
  } catch { /* first run, or unreadable — rebuilt from the copies on disk */ }
  return { version: 1, files: {} };
}

// Atomic tmp+rename: status() may be reading this while a run replaces it.
function writeManifest(archiveDir, manifest) {
  mkdirSync(archiveDir, { recursive: true });
  const path = join(archiveDir, MANIFEST);
  writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 1) + '\n');
  renameSync(`${path}.tmp`, path);
}

// --- heartbeat --------------------------------------------------------------------
//
// The docs/ADDONS.md heartbeat format (job, checked, checked_at, outcome + one
// sentence), written at the archive rather than into a project's task store:
// this job watches the machine, not a project, so there is no Daily tab for it
// to appear on. It is still the file that says "it ran, and here is what it
// found", including on a night when nothing changed.

function writeHeartbeat(archiveDir, jobId, { date, outcome, note }) {
  mkdirSync(archiveDir, { recursive: true });
  const path = join(archiveDir, HEARTBEAT);
  const body = [
    '---',
    `job: ${jobId}`,
    `checked: ${date}`,
    `checked_at: ${new Date().toISOString()}`,
    `outcome: ${outcome}`,
    '---',
    '',
    note,
    '',
  ].join('\n');
  writeFileSync(`${path}.tmp`, body);
  renameSync(`${path}.tmp`, path);
}

function readHeartbeat(archiveDir) {
  try {
    const text = readFileSync(join(archiveDir, HEARTBEAT), 'utf8');
    const fm = {};
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) return null;
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return { ...fm, note: m[2].trim() };
  } catch { return null; }
}

// --- walking a source tree ----------------------------------------------------------

// Every regular file under root, as paths relative to it. Symlinks are skipped
// (they can point anywhere, including back into the archive); an unreadable
// folder is reported and skipped rather than ending the walk.
function walk(root, onError) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); }
    catch (e) { onError(rel || '.', e); continue; }
    for (const d of entries) {
      const child = rel ? join(rel, d.name) : d.name;
      if (d.isDirectory()) stack.push(child);
      else if (d.isFile() && !d.name.endsWith(TMP_SUFFIX)) out.push(child);
    }
  }
  return out.sort();
}

function sha256(file) {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', fail).on('data', (c) => h.update(c)).on('end', () => ok(h.digest('hex')));
  });
}

// Seconds, not milliseconds: the copy's mtime is set from the source's, and a
// filesystem round-trip can lose the sub-second part.
const secs = (ms) => Math.floor(Number(ms) / 1000);

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function inside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

// --- one tree ---------------------------------------------------------------------

// Copy one source tree into <archiveDir>/<name>/. Mutates `files` (the manifest's
// map) and returns the counts for this tree.
async function archiveTree({ name, source, archiveDir, files, now, signal, log }) {
  const r = { name, copied: 0, current: 0, kept: 0, failed: 0, goneNow: 0, goneTotal: 0, aborted: false };
  const nowIso = now.toISOString();
  const seen = new Set();

  const rels = walk(source, (rel, e) => { r.failed += 1; log(`${name}: could not read folder ${rel} — ${e.code || e.message}`); });

  for (const rel of rels) {
    if (signal?.aborted) { r.aborted = true; break; }
    const key = `${name}/${rel.split(sep).join('/')}`;
    seen.add(key);
    const src = join(source, rel);
    const target = join(archiveDir, name, rel);

    let st;
    try { st = lstatSync(src); } catch { continue; } // vanished mid-walk; next run sees it gone
    if (!st.isFile()) continue;

    const entry = files[key];
    // What we hold for this file. With no manifest entry (a lost manifest), the
    // copy on disk speaks for itself.
    let held = entry && existsSync(target) ? entry : null;
    if (!held && existsSync(target)) {
      const t = statSync(target);
      held = { size: t.size, mtimeMs: t.mtimeMs };
    }

    if (held && held.size === st.size && secs(held.mtimeMs) === secs(st.mtimeMs)) {
      r.current += 1;
      files[key] = { ...(entry || { firstSeen: nowIso, copiedAt: null, sha256: null }), size: st.size, mtimeMs: Math.floor(st.mtimeMs), lastSeen: nowIso, goneFromSource: null };
      continue;
    }

    try {
      // The source shrank below the copy we hold: set the copy aside first.
      if (held && st.size < held.size) {
        const keptKey = `${key}.kept-${stamp(now)}`;
        renameSync(target, `${target}.kept-${stamp(now)}`);
        files[keptKey] = { ...(entry || held), keptFrom: key, keptAt: nowIso };
        r.kept += 1;
        log(`${key}: source is smaller than the copy — previous copy kept as ${keptKey.slice(name.length + 1)}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}${TMP_SUFFIX}`;
      copyFileSync(src, tmp);
      utimesSync(tmp, st.atime, st.mtime);
      renameSync(tmp, target);
      files[key] = {
        size: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
        sha256: await sha256(target),
        firstSeen: entry?.firstSeen || nowIso,
        lastSeen: nowIso,
        copiedAt: nowIso,
        goneFromSource: null,
      };
      r.copied += 1;
    } catch (e) {
      r.failed += 1;
      log(`${key}: could not copy — ${e.code || e.message}`);
    }
  }

  // Gone from source: only judged after a COMPLETE walk, so an aborted run can
  // never mark files gone that it simply did not reach.
  if (!r.aborted) {
    for (const [key, entry] of Object.entries(files)) {
      if (!key.startsWith(`${name}/`) || entry.keptFrom || seen.has(key)) continue;
      if (!entry.goneFromSource) { entry.goneFromSource = nowIso; r.goneNow += 1; log(`${key}: gone from source — the copy is kept`); }
      r.goneTotal += 1;
    }
  }
  return r;
}

// --- a whole run --------------------------------------------------------------------

// trees: [{ name, root }] — root null/missing means that store is not available
// on this machine (no driver, or the agent app never installed). Returns the
// per-tree counts plus totals; writes the manifest even on a partial run, so
// what WAS copied is recorded.
async function runArchive({ archiveDir, trees, now = new Date(), signal, log = () => {} }) {
  for (const t of trees) {
    if (t.root && (inside(archiveDir, t.root) || inside(t.root, archiveDir))) {
      throw new Error(`refusing to run: the archive (${archiveDir}) and the ${t.name} folder (${t.root}) overlap`);
    }
  }

  const manifest = readManifest(archiveDir);
  const results = [];
  const missing = [];
  for (const t of trees) {
    if (signal?.aborted) break;
    if (!t.root || !existsSync(t.root)) { missing.push(t.name); continue; }
    results.push(await archiveTree({ name: t.name, source: t.root, archiveDir, files: manifest.files, now, signal, log }));
  }
  writeManifest(archiveDir, manifest);

  const total = (k) => results.reduce((n, r) => n + r[k], 0);
  return {
    trees: results,
    missing,
    copied: total('copied'),
    current: total('current'),
    kept: total('kept'),
    failed: total('failed'),
    goneNow: total('goneNow'),
    goneTotal: total('goneTotal'),
    aborted: results.some((r) => r.aborted) || !!signal?.aborted,
    held: Object.keys(manifest.files).length,
  };
}

export { MANIFEST, HEARTBEAT, readManifest, writeManifest, writeHeartbeat, readHeartbeat, walk, archiveTree, runArchive };
