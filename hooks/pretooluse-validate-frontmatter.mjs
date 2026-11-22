#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit) forcing guard for task stores: what a store
// may hold (task 190), and task-file frontmatter — including the status and
// claim fields and the text's park note, which only their commands change
// (tasks 228, 247, 244). It also
// refuses a hand edit to a linked worktree's launch file, which the
// session-start hook owns (task 247).
//
// FIRST, the store's contents. A file written inside a task store that the
// store rule (core/store-audit.mjs classifyStorePath) does not allow — a note,
// a mockup at the root, a handoff — is refused, naming `files/<task id>/`, the
// one place a task's attachments go. Stray files committed into stores were the
// problem task 190 cleaned up; this stops the next one at the write. (Files
// written by shell commands never reach this hook — `sync push` refuses to
// commit them, and the portal's store view flags them.)
//
// THEN, task-file frontmatter — and checkbox markers, which the validator
// treats as errors too (task 238: a retired, misspelt or incomplete marker).
// Stop malformed frontmatter at write time. Reads the hook
// JSON on stdin; if the target is a `<NNN>-*.md` task file, it reconstructs
// the post-edit content, validates it with the SAME validator as
// `tasks.mjs validate` (core/validate.mjs), and DENIES the write iff it would
// INCREASE the file's error count.
//
// Why "increase", not "any error": ~30 task files across projects already carry
// legacy schema errors. A hook that blocked on any error would make those files
// un-editable — you couldn't even edit toward correctness. Gating on a
// regression (errorsAfter > errorsBefore) means: you can always reduce or hold
// errors, never introduce new ones; a brand-new file (before = 0) must be clean.
//
// Fail-open everywhere: any parse/IO/edit-apply uncertainty exits 0 (allow). A
// guard that crashes-closed would block all editing — far worse than missing one
// bad write, which `tasks.mjs validate` / `doctor` still catch after the fact.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = dirname(fileURLToPath(import.meta.url));

function allow() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// --- read stdin ------------------------------------------------------------
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { allow(); }
let input;
try { input = JSON.parse(raw); } catch { allow(); }

const ti = input?.tool_input || {};
const fp = ti.file_path;
if (!fp) allow();

// --- a worktree's launch file is the session-start hook's (task 247) ---------
// The hook rewrites a linked worktree's launch file (the preview tool's config)
// on every run, so a hand edit is silently lost — and a hand-written entry is
// how sessions papered over a hook that hadn't run (task 121). Refused in a
// LINKED worktree of a REGISTERED project only: the main checkout's file also
// holds the project's own entries, which are the owner's to edit. "Linked" is
// git's own distinction (its git dir is not the common dir), and the file's
// path comes from core/launch.mjs, so no agent's layout is spelled out here.
function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}
function linkedWorktree(dir) {
  const out = git(dir, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
  if (!out) return null;
  const [gitDir, commonDir, top] = out.split('\n').map((s) => s.trim());
  if (!gitDir || !commonDir || !top) return null;
  const abs = (p) => { try { return realpathSync(resolve(dir, p)); } catch { return resolve(dir, p); } };
  if (abs(gitDir) === abs(commonDir)) return null;      // the main working tree
  try { return { worktree: realpathSync(top), mainRoot: realpathSync(resolve(abs(commonDir), '..')) }; } catch { return null; }
}
{
  let launchPath = null;
  try { ({ launchPath } = await import(`${SELF}/../core/launch.mjs`)); } catch { launchPath = null; }
  const tail = launchPath ? '/' + launchPath('') : null;   // the file, relative to a worktree root
  if (tail && fp.endsWith(tail)) {
    const root = fp.slice(0, -tail.length);
    let here = null, rootReal = null;
    try { rootReal = realpathSync(root); here = linkedWorktree(root); } catch { here = null; }
    if (here && here.worktree === rootReal) {
      let registered = false;
      try {
        const { readRegistry } = await import(`${SELF}/../core/index.mjs`);
        const same = (p) => { try { return realpathSync(p) === here.mainRoot; } catch { return false; } };
        registered = (readRegistry() || []).some((p) => same(p.path) || (p.aliases || []).some(same));
      } catch { registered = false; }
      if (registered) {
        deny(
          `Worktree-file guard: \`${fp}\` is this worktree's launch file. The session-start hook writes it and `
          + `rewrites it on every run, so a hand edit is lost — and a hand-written entry hides a hook that hasn't run.\n\n`
          + `Fix the source instead: the project's \`.cogyard/worktree.json\` (dev_script, port_vars, preview_port_var) `
          + `or the worktree's allocation in ports.json in the cogyard home, then re-run the hook from inside the worktree:\n`
          + `  cogyard hook session-start .`,
        );
      }
    }
  }
}

// --- an edit through a link that leaves the project (task 260) ---------------
// Claude Code asks the owner's permission for any write whose path is inside
// the working folder but resolves, through a link, to somewhere outside it
// (code.claude.com/docs/en/permissions, "Writes through a symlink"). Two such
// links are cogyard's own: the project's task link (`.cogyard/tasks` → the
// shared store) and a worktree's env files (links to the main checkout's real
// files). A chat that edits through one stalls on a prompt — unattended, with
// nobody to answer it. Telling chats to use the real path (task 158) held only
// while that instruction was loaded; task 247 dropped it from the owner's
// CLAUDE.md. So this refuses the edit and names the real file, before Claude
// Code would ask. "The project" is the git top level of the chat's folder.
// Fail-open: no cwd, no repo, nothing resolvable → this rule says nothing.
function inside(p, root) { return p === root || p.startsWith(root.endsWith('/') ? root : root + '/'); }
function realOf(path) {                         // the file may not exist yet
  const rest = [];
  for (let d = path; ; d = dirname(d)) {
    try { return join(realpathSync(d), ...rest); } catch {}
    if (dirname(d) === d) return null;
    rest.unshift(basename(d));
  }
}
{
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : null;
  const top = cwd ? git(cwd, ['rev-parse', '--show-toplevel']) : null;
  let topReal = null, cwdReal = null;
  try { topReal = top ? realpathSync(top) : null; cwdReal = cwd ? realpathSync(cwd) : null; } catch { topReal = null; }
  const abs = cwd ? resolve(cwd, fp) : null;
  // The requested path with only the project's own location resolved (the
  // chat's folder may itself be reached through a link, e.g. /var → /private/var),
  // so a link INSIDE the project is still seen as one.
  let canon = abs;
  if (abs && cwdReal && inside(abs, cwd)) canon = join(cwdReal, abs.slice(cwd.length));
  if (canon && topReal && !inside(canon, topReal) && top && inside(abs, top)) canon = join(topReal, abs.slice(top.length));
  if (topReal && canon && inside(canon, topReal)) {
    const real = realOf(canon);
    if (real && real !== canon && !inside(real, topReal)) {
      // The path inside the project: the task link is `.cogyard/tasks`, or the
      // older top-level `_tasks` (task 160).
      const inProject = canon.slice(topReal.length);
      const here = linkedWorktree(topReal);
      if (inProject.startsWith('/.cogyard/tasks/') || inProject.startsWith('/_tasks/')) {
        const id = (basename(abs).match(/^(\d+(?:\.\d+)?[a-z]?)-/) || [])[1];
        deny(
          `Task-link guard: \`${abs}\` goes through this project's link to its task store, and Claude Code asks the owner's `
          + `permission for any edit through a link that leaves the project. Make the same edit at the real path:\n\n  ${real}\n\n`
          + (id ? `(That is what \`cogyard tasks find ${id}\` prints. ` : '(')
          + `Always read and edit task files at the store path, never through \`.cogyard/tasks/\`.)`,
        );
      }
      // A worktree's env files link to the main checkout's file of the same
      // name — which may itself link on, e.g. into a secrets folder (task 211).
      // Either way the file is the main checkout's, shared by every worktree.
      const twin = here ? join(here.mainRoot, inProject) : null;
      if (here && (inside(real, here.mainRoot) || (twin !== canon && realOf(twin) === real))) {
        deny(
          `Worktree-link guard: \`${abs}\` is a link in this worktree to the main checkout's own file`
          + `${twin && twin !== real ? ` \`${twin}\`` : ''}, which is really:\n\n  ${real}\n\n`
          + `That file is shared by the main checkout and every worktree, so editing it changes it for all of them — and `
          + `Claude Code asks the owner's permission for an edit through a link that leaves the worktree. `
          + `Change it only if the owner asked for exactly this change to the whole project, and then at \`${real}\`; `
          + `otherwise leave it.`,
        );
      }
      deny(
        `Link guard: \`${abs}\` resolves through a link to \`${real}\`, outside this project, and Claude Code asks the `
        + `owner's permission for any edit through such a link. Change \`${real}\` only if the owner asked for exactly `
        + `that, and then at its real path; otherwise leave it.`,
      );
    }
  }
}

// Only NNN-prefixed task markdown in a task directory; never the generated
// index. Matches the link path (project/.cogyard/tasks/NNN-*.md, or the older
// project/_tasks/NNN-*.md — task 160) and the resolved store path
// (<COGYARD_PROJECTS_ROOT>/_tasks/<slug>/NNN-*.md).
const inTaskDir = fp.includes('/_tasks/') || fp.includes('/.cogyard/tasks/');
if (!inTaskDir) allow();

// --- load the engine from this script's own checkout -----------------------
let taskFromContent, loadTasks, introducedErrors, classifyStorePath, discoverProjects, canonicalStore, parkRecordKey;
try {
  ({ taskFromContent, loadTasks, introducedErrors, classifyStorePath, discoverProjects, canonicalStore, parkRecordKey } = await import(`${SELF}/../core/index.mjs`));
} catch { allow(); }

// The path inside its store, or null when the file is not provably in one.
// Through a project's link the store is certain; any other path is matched
// against the registered projects' stores (canonicalStore — the one place a
// store's location is defined). The file and its folder may not exist yet, so
// the nearest existing ancestor is resolved and the rest re-joined.
function storeRelative(path) {
  const LINK = '/.cogyard/tasks/';
  const at = path.lastIndexOf(LINK);
  if (at !== -1) return path.slice(at + LINK.length);
  let real = null;
  const rest = [];
  for (let d = path; ; d = dirname(d)) {
    try { real = join(realpathSync(d), ...rest); break; } catch {}
    if (dirname(d) === d) return null;
    rest.unshift(basename(d));
  }
  for (const p of discoverProjects()) {
    const store = canonicalStore(p.path);
    if (store && real.startsWith(store + '/')) return real.slice(store.length + 1);
  }
  return null;
}

let rel = null;
try { rel = storeRelative(fp); } catch { rel = null; }
if (rel != null) {
  const cls = classifyStorePath(rel);
  if (!['task', 'attachment', 'allowed'].includes(cls)) {
    deny(
      `Task-store guard: \`${rel}\` is not something a task store holds. A store holds task files `
      + `(\`NNN-<slug>.md\`), \`axes.json\`, \`switches.json\`, and each task's attachments under \`files/<task id>/\` `
      + `(any file type — e.g. \`files/190/${basename(rel)}\`; the folder is created by the write). `
      + `Put it in the folder of the task it belongs to, or outside the store if it belongs to no task.`,
    );
  }
  // An attachment is the task's file, not a task: never validated as one, even
  // when its name starts with a digit (`files/043/043-schema-verify.sql`).
  if (cls === 'attachment') allow();
}
if (!/^\d.*\.md$/.test(basename(fp))) allow();

// There is no job-output exemption any more. The nightly jobs used to write
// briefs into `_tasks/briefs/<date>.md`, and a date-named file passes the
// filename test above, so this guard needed a directory exemption for it. Task
// 187 moved every job's output to $COGYARD_HOME (core/job-output.mjs), outside
// task-store path, so nothing but task files reaches this point.

// A content STRING is parsed into a task by core/frontmatter.mjs
// taskFromContent — the same parse every reader loads tasks through.

const current = existsSync(fp) ? readFileSync(fp, 'utf8') : null;

// Another chat's claimed task is that chat's to edit (task 260). The rule was
// "go through the user, never edit another task's file" (pickup-task); it held
// only in chats that had loaded the skill. A claim's chat is this machine's
// record (claims.json, written by `env claim`, which records the chat that ran
// it); the editing chat is the `session_id` Claude Code hands every hook. Both
// known and different, on a task whose file says it is claimed → refused.
// Unknown on either side (a human's shell, a claim from another machine, a
// claim record older than this rule's id format) → this rule says nothing.
if (rel != null && current != null) {
  const me = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  let holder = null, t = null;
  try {
    t = taskFromContent(fp, current);
    const claimedAt = t?.frontmatter?.env?.claimed_at;
    if (me && claimedAt) {
      const { localClaim } = await import(`${SELF}/../core/claims.mjs`);
      holder = localClaim(fp, t.frontmatter.id)?.session || null;
    }
  } catch { holder = null; }
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (holder && UUID.test(holder) && holder !== me) {
    const id = t.frontmatter.id ?? '<id>';
    const env = t.frontmatter.env || {};
    deny(
      `Claim guard: task ${id} (${basename(fp)}) is claimed by another chat (${holder}`
      + `${env.claimed_by ? `, ${env.claimed_by}` : ''}, since ${env.claimed_at}). Only the chat holding a claim edits its task file.\n\n`
      + `  • Tell the owner what should change in task ${id} and why, with a message they can paste into that chat.\n`
      + `  • If the owner told you to take task ${id} over (or that chat is finished), take the claim first:\n`
      + `      cogyard env claim ${fp} <this chat's id> --force\n`
      + `    then make the edit.`,
    );
  }
}

// Reconstruct the would-be content from the tool input.
function applyEdit(src, oldS, newS, all) {
  if (oldS === '') return null;            // ambiguous insert — let it through
  if (!src.includes(oldS)) return null;    // can't locate anchor — fail open
  return all ? src.split(oldS).join(newS) : src.replace(oldS, newS);
}

let resulting;
if (ti.content != null) {                  // Write (full file)
  resulting = ti.content;
} else if (Array.isArray(ti.edits)) {       // MultiEdit
  let s = current ?? '';
  for (const e of ti.edits) {
    const r = applyEdit(s, e.old_string ?? '', e.new_string ?? '', !!e.replace_all);
    if (r == null) allow();
    s = r;
  }
  resulting = s;
} else if (ti.old_string != null) {         // Edit
  const r = applyEdit(current ?? '', ti.old_string, ti.new_string ?? '', !!ti.replace_all);
  if (r == null) allow();
  resulting = r;
} else {
  allow();
}

// Closing and reopening go through their commands, never a hand edit (task 228).
// `cogyard tasks close` / `reopen` set status + done_date, release the claim,
// keep the body's status line true and commit — and the overrides are the
// owner's. An agent that hand-edited `status: ENOUGH` → `DONE` skipped all of
// that and credited the owner in the commit. So, in an existing task file: a
// status change into or out of DONE/ENOUGH, or any done_date change, is denied.
// A brand-new file (no frontmatter yet — `next-id` leaves an empty one) passes:
// authoring a task is write-task's job, not a status change. OBSOLETE passes:
// no command owns it. PARKED is owned by park / unpark (task 244), below.
const CLOSED_BY_COMMAND = new Set(['DONE', 'ENOUGH']);
{
  const was = current != null ? taskFromContent(fp, current) : null;
  const now = taskFromContent(fp, resulting);
  if (was?.hasFrontmatter && was.frontmatter && now.hasFrontmatter && now.frontmatter) {
    const s0 = was.frontmatter.status ?? null, s1 = now.frontmatter.status ?? null;
    const d0 = was.frontmatter.done_date ?? null, d1 = now.frontmatter.done_date ?? null;
    const statusMove = s0 !== s1 && (CLOSED_BY_COMMAND.has(s0) || CLOSED_BY_COMMAND.has(s1));
    const dateMove = String(d0) !== String(d1);
    // Parking and un-parking go through their commands (task 244): `cogyard
    // tasks park` / `unpark` set the status AND write or end the text's live
    // `> **PARKED <date> — <reason>**` note together, keep the status line true,
    // release the claim and commit. By hand, the two drifted apart (one task
    // went OPEN, closed, reopened — its note still saying PARKED). So a status
    // change into or out of PARKED is denied, and so is any change to a live
    // park note's record (its date and bold reason — core/park.mjs
    // parkRecordKey; a remark after the bold stays editable). A close or reopen
    // is reported by the guard below, whichever it is.
    if (!statusMove) {
      const parkMove = s0 !== s1 && (s0 === 'PARKED' || s1 === 'PARKED');
      const noteMove = parkRecordKey(was.body || '') !== parkRecordKey(now.body || '');
      if (parkMove || noteMove) {
        const id = now.frontmatter.id ?? was.frontmatter.id ?? '<id>';
        const what = parkMove
          ? `\`status: ${s0}\` → \`status: ${s1}\``
          : 'a change to the live `> **PARKED <date> — <reason>**` note';
        deny(
          `Park guard: ${what} in ${basename(fp)} is a park or an un-park, and those are never hand edits.\n\n`
          + `  • park it → \`cogyard tasks park ${id} "<what it waits for>"\` (sets PARKED, writes the note, releases the claim, commits)\n`
          + `  • the wait is over → \`cogyard tasks unpark ${id} "<what was seen>"\` (sets OPEN, turns the note into "Parked <date> – <date>: …" and "Un-parked <date>: …", commits)\n`
          + `  • status and note disagree already → \`cogyard tasks validate ${id}\` names the command that fixes it\n\n`
          + `A park is the owner's hold: end one only when what it waits for has happened, and say what was seen.`,
        );
      }
    }
    if (statusMove || dateMove) {
      const id = now.frontmatter.id ?? was.frontmatter.id ?? '<id>';
      const what = statusMove ? `\`status: ${s0}\` → \`status: ${s1}\`` : `\`done_date: ${d0}\` → \`done_date: ${d1}\``;
      deny(
        `Task-status guard: ${what} in ${basename(fp)} is a close or a reopen, and those are never hand edits.\n\n`
        + `  • close it → \`cogyard tasks close ${id}\` (sets status + done_date, releases the claim, commits)\n`
        + `  • it refuses over open boxes → settle each with (dropped: why) / (moved: <id>) / (optional) `
        + `ONLY if the owner decided so; otherwise leave it open and say what's left. \`--enough\` / \`--force\` run only when the owner said so in this chat — pass their words with \`--asked "…"\`\n`
        + `  • undo a close → \`cogyard tasks reopen ${id} --why "<reason>"\`\n\n`
        + `Never set status or done_date by hand, and never credit the owner with a change they did not make.`,
      );
    }
  }
}

// Claiming and releasing go through their commands, never a hand edit (task
// 247). `cogyard env claim` / `release` write the file's half of a claim
// (`env.branch`, `env.claimed_at`, `env.claimed_by`), record this machine's half
// in claims.json, commit it, and on a team store pull first and push — so two
// sessions can't both win. A hand edit does none of that. So: any change to one
// of those three fields is denied — setting, changing or clearing it — as is a
// brand-new file that arrives with one set. A new file with all three null (how
// write-task authors one) passes.
const CLAIM_FIELDS = ['claimed_at', 'claimed_by', 'branch'];
{
  const envOf = (t) => {
    const e = t?.hasFrontmatter && t.frontmatter ? t.frontmatter.env : null;
    return e && typeof e === 'object' && !Array.isArray(e) ? e : {};
  };
  const now = taskFromContent(fp, resulting);
  if (now.hasFrontmatter && now.frontmatter) {
    const e0 = envOf(current != null ? taskFromContent(fp, current) : null);
    const e1 = envOf(now);
    const val = (v) => (v == null ? null : String(v));
    const moved = CLAIM_FIELDS.filter((k) => val(e0[k]) !== val(e1[k]));
    if (moved.length) {
      const what = moved.map((k) => `\`env.${k}: ${val(e0[k])}\` → \`env.${k}: ${val(e1[k])}\``).join(', ');
      deny(
        `Claim guard: ${what} in ${basename(fp)} is a claim or a release, and those are never hand edits.\n\n`
        + `  • claim it → \`cogyard env claim <task-file> <session-id>\`\n`
        + `  • release it → \`cogyard env release <task-file>\`\n\n`
        + `Both are atomic and commit the change themselves, so parallel sessions can't both hold a task. `
        + `Leave \`branch\`, \`claimed_at\` and \`claimed_by\` exactly as they are in this edit.`,
      );
    }
  }
}

// Validate candidate against its siblings (excludes the target so its own row
// isn't double-counted); compare to the file's current error count.
const dir = dirname(fp);
let siblings = [];
try { siblings = loadTasks(dir).filter((t) => t.path !== fp); } catch { siblings = []; }
const fileBase = basename(fp);

// core/validate.mjs introducedErrors — the one regression rule, which
// `sync push` also applies at commit (task 222).
const introduced = introducedErrors(siblings, current != null ? taskFromContent(fp, current) : null, taskFromContent(fp, resulting));

if (introduced.length) {
  const list = introduced.map((e) => `  • ${e}`).join('\n');
  deny(
    `Task-file guard: this write would introduce ${introduced.length} new schema error(s) in ${fileBase}:\n${list}\n\n`
    + `Fix the frontmatter or checkbox markers so the file validates, then retry. Run \`cogyard tasks validate\` to check. `
    + `(Pre-existing errors are allowed through — this only blocks NEW ones.)`,
  );
}

allow();
