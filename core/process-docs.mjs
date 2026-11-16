// core/process-docs.mjs — one process, one place (task 133).
//
// A project adopted into cogyard often already has its own merge or commit
// process, written in a doc. cogyard's skills apply there too, and nothing says
// which wins: a doc is not a channel the skills read, and a project skill named
// like a cogyard skill either never runs (cogyard installed as personal skills)
// or runs beside it (installed as a plugin). This module finds those, and moves
// a process into ONE place when the owner chooses how:
//
//   adopt — cogyard's skill runs it; the doc's section becomes a pointer.
//   keep  — the section becomes a project skill under a name that is not
//           cogyard's, cogyard's skill is turned off for the project, and the
//           doc's section becomes a pointer to it.
//   facts — cogyard's skill runs it; the section moves into the always-loaded
//           instruction file as this project's differences, and the doc's
//           section becomes a pointer.
//
// Never decides on its own: auditProcess() reports, reconcileProcess() acts on
// the outcome it is handed. Everything agent-specific (file names, the skill
// format, turning a skill off) goes through adapter.skills — no agent literal
// lives here (docs/DRIVERS.md, seam 7).

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { adapter as activeAdapter } from './drivers.mjs';
import { tryExec, execLoud, gitIdentityFlags } from './exec.mjs';

// The processes cogyard's own skills run. A doc section belongs to one when it
// RUNS that process — its signature command appears in a fenced code block, or
// inline in a numbered step — and it talks about it (in its heading, or for
// merging anywhere in it). A command merely mentioned in prose ("never `git
// merge main`") is not a step. A deploy or rollback process collides with
// nothing: cogyard has no skill that deploys (publishing is the owner's
// `cogyard publish`), so those docs stay the project's own facts.
export const AREAS = [
  {
    skill: 'merge-to-main', short: 'merge', label: 'merging', title: 'Merging',
    command: /\bgit\s+merge\b/, keyword: /\bmerg(?:e|es|ed|ing)\b/i, inHeading: false,
    triggers: '"merge to main", "merge it", "ship this branch"',
  },
  {
    skill: 'commit', short: 'commit', label: 'committing', title: 'Committing',
    command: /\bgit\s+commit\b/, keyword: /\bcommit(?:s|ting)?\b/i, inHeading: true,
    triggers: '"commit", "commit this"',
  },
];

export const OUTCOMES = ['adopt', 'keep', 'facts'];

// The marker a reconciled section carries, so a re-run sees the decision
// rather than the pointer text: <!-- cogyard:process merge-to-main=adopt 2026-11-02 -->
const MARKER_RE = /<!--\s*cogyard:process\s+([\w.-]+)=(adopt|keep|facts)(?:\s+(\d{4}-\d{2}-\d{2}))?\s*-->/g;
const marker = (skill, outcome, day) => `<!-- cogyard:process ${skill}=${outcome} ${day} -->`;

// The line every project skill that replaces a cogyard skill carries, so
// doctor can tell when cogyard's has changed since.
const HEADER_RE = /Replaces cogyard's `?([\w.-]+)`?\. Last reconciled against it: (\d{4}-\d{2}-\d{2})\./;
const header = (skill, day) => `Replaces cogyard's \`${skill}\`. Last reconciled against it: ${day}.`;

const today = () => new Date().toISOString().slice(0, 10);

// The name a project's own replacement skill gets: <slug>-<process>, lower-case
// kebab, so it can never be cogyard's name (`TripPlanner` → `tripplanner-merge`).
export function ownSkillName(slug, skill) {
  const area = AREAS.find((a) => a.skill === skill);
  const base = String(slug || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${base}-${area ? area.short : skill}`;
}

function read(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

// --- reading a doc ------------------------------------------------------------

// A doc → its sections, split at its top level of headings (H2 under a single
// H1 title, else the shallowest level). Headings inside fenced code are code
// (`# step 1` in a shell block), not headings. Each section:
//   { heading, headingLine (-1 = none), start, end }  — line indexes, end exclusive.
export function splitSections(text) {
  const lines = text.split('\n');
  const heads = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) { fence = fence === f[1] ? null : (fence || f[1]); return; }
    if (fence) return;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) heads.push({ i, level: h[1].length, text: h[2] });
  });
  let level = heads.length ? Math.min(...heads.map((h) => h.level)) : 0;
  const top = heads.filter((h) => h.level === level);
  if (top.length === 1 && top[0] === heads[0] && heads.some((h) => h.level > level)) {
    level = Math.min(...heads.filter((h) => h.level > level).map((h) => h.level));
  }
  const cuts = heads.filter((h) => h.level <= level);
  const sections = [];
  const first = cuts.length ? cuts[0].i : lines.length;
  if (first > 0) sections.push({ heading: null, headingLine: -1, start: 0, end: first });
  cuts.forEach((h, k) => {
    sections.push({ heading: h.text, headingLine: h.i, start: h.i, end: k + 1 < cuts.length ? cuts[k + 1].i : lines.length });
  });
  return { lines, sections };
}

// The commands a section RUNS: every non-comment line of its fenced blocks, and
// the inline code of its numbered steps. Plus whether those make an ordered
// sequence — a block of two or more commands, or two or more numbered steps
// with code in them.
function stepsOf(lines) {
  const commands = [];
  let fence = null;
  let block = 0;
  let longest = 0;
  let numberedWithCode = 0;
  for (const line of lines) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) {
      if (fence === f[1]) { fence = null; longest = Math.max(longest, block); }
      else if (!fence) { fence = f[1]; block = 0; }
      continue;
    }
    if (fence) {
      const t = line.trim();
      if (t && !t.startsWith('#')) { commands.push(t); block++; }
      continue;
    }
    if (/^\s*\d+[.)]\s/.test(line)) {
      const code = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      if (code.length) { numberedWithCode++; commands.push(...code); }
    }
  }
  if (fence) longest = Math.max(longest, block);
  return { commands, ordered: longest >= 2 || numberedWithCode >= 2 };
}

// Which of cogyard's processes a section runs, or null.
function areaOf(section, lines) {
  const body = lines.slice(section.start, section.end);
  if (body.some((l) => /<!--\s*cogyard:process\s/.test(l))) return null; // already reconciled
  const { commands, ordered } = stepsOf(body);
  if (!ordered) return null;
  const code = commands.join('\n');
  const heading = section.heading || '';
  const text = body.join('\n');
  for (const a of AREAS) {
    if (!a.command.test(code)) continue;
    if (a.keyword.test(heading) || (!a.inHeading && a.keyword.test(text))) return a;
  }
  return null;
}

// The files a project's process could be written in: the agent's instruction
// files, and the project's docs/*.md.
function docFiles(repoRoot, skills) {
  const files = [...(skills.instructionFiles(repoRoot) || [])];
  try {
    for (const f of readdirSync(join(repoRoot, 'docs')).sort()) {
      if (f.toLowerCase().endsWith('.md')) files.push(`docs/${f}`);
    }
  } catch {}
  return [...new Set(files)];
}

// --- the audit ----------------------------------------------------------------

// What a project's process looks like next to cogyard's skills. Report only —
// nothing is written. → {
//   collisions: [{ file, heading, skill, start, end }]  a process section no
//               skill replaces, beside cogyard's <skill>;
//   reconciled: [{ file, skill, outcome, day }]         decisions already made;
//   shadowed:   [{ name, file, verdict, detail, fix }]  a project skill or
//               command with a cogyard skill's or command's name — 'never-runs'
//               | 'runs-beside' | 'neither-runs' | 'one-runs';
//   stale:      [{ name, file, replaces, reconciled, changed }]  a project skill
//               reconciled before cogyard's skill last changed;
//   outcomes:   the outcomes this agent can carry out;
//   install:    how cogyard's skills reach the agent here }
export function auditProcess(repoRoot, { adapter = activeAdapter, slug } = {}) {
  const skills = adapter.skills;
  const install = skills.install(repoRoot);
  const shipped = new Map(skills.shipped().map((s) => [s.name, s]));
  const projectSkills = skills.projectSkills(repoRoot);

  // Project skills that say which cogyard skill they replace.
  const replacing = [];
  for (const p of projectSkills) {
    const m = (read(join(repoRoot, p.file)) || '').match(HEADER_RE);
    if (m) replacing.push({ ...p, replaces: m[1], reconciled: m[2] });
  }

  const collisions = [];
  const reconciled = [];
  for (const file of docFiles(repoRoot, skills)) {
    const text = read(join(repoRoot, file));
    if (text == null) continue;
    for (const m of text.matchAll(MARKER_RE)) reconciled.push({ file, skill: m[1], outcome: m[2], day: m[3] || null });
    const { lines, sections } = splitSections(text);
    for (const s of sections) {
      const a = areaOf(s, lines);
      if (a) collisions.push({ file, heading: s.heading, skill: a.skill, start: s.start, end: s.end });
    }
  }

  // A process a project skill really replaces is not a second authority: that
  // skill carries the header, and cogyard's is turned off (or, under a plugin,
  // the always-loaded file says which to use — a "keep" marker).
  const replaced = new Set(replacing
    .filter((r) => skills.isOff(repoRoot, r.replaces, { cogyard: true }) || reconciled.some((x) => x.skill === r.replaces && x.outcome === 'keep'))
    .map((r) => r.replaces));

  // How each of cogyard's is installed, by name (task 218). Personally it is
  // normally `cogyard-<name>` (personalName), which takes no one's name, so a
  // project skill or command named <name> loads beside it, as under the
  // plugin. Only a link an older install made under the bare <name> still
  // hides a project's own (bareSkills / bareCommands). An adapter without
  // the lists falls back to `personal` meaning bare, the old behaviour.
  const shippedCommands = new Set((skills.shippedCommands ? skills.shippedCommands() : []).map((c) => c.name));
  const personalName = skills.personalName || ((n) => n);
  const personalSkill = (n) => (install.personalSkills ? install.personalSkills.includes(n) : install.personal);
  const personalCommand = (n) => (install.personalCommands ? install.personalCommands.includes(n) : false);
  const bareSkill = (n) => (install.bareSkills ? install.bareSkills.includes(n) : install.personal);
  const bareCommand = (n) => (install.bareCommands ? install.bareCommands.includes(n) : false);
  // Installed so that it loads beside a project's <name>: the plugin, or a
  // personal install under the prefixed name.
  const beside = (n, isSkill) => install.plugin
    || (isSkill ? personalSkill(n) && !bareSkill(n) : personalCommand(n) && !bareCommand(n));
  const besideRun = (n) => skills.invocation(n, { cogyard: true, plugin: install.plugin && !personalSkill(n) && !personalCommand(n) });
  const plugged = (n) => skills.invocation(n, { cogyard: true, plugin: true });
  // The bare name is cogyard's only until its older link is moved.
  const moveHint = (n) => (skills.installCommand ? `re-run \`${skills.installCommand}\` — it moves cogyard's to ${skills.invocation(n, { cogyard: true })}, after which this one runs beside it — and ` : '');

  const shadowed = [];
  for (const p of projectSkills) {
    if (shipped.has(p.name)) {
      const rename = ownSkillName(slug, p.name);
      const fix = `rename it (e.g. ${rename}), turn cogyard's ${p.name} off for this project and put "${header(p.name, '<date>')}" at its top — or delete it`;
      if (bareSkill(p.name) && skills.isOff(repoRoot, p.name)) {
        shadowed.push({ name: p.name, file: p.file, verdict: 'neither-runs', detail: `it is turned off along with cogyard's ${p.name}, which has the same name — neither runs`, fix: `${moveHint(p.name)}${fix}` });
      } else if (bareSkill(p.name)) {
        shadowed.push({ name: p.name, file: p.file, verdict: 'never-runs', detail: `it never runs — cogyard's ${p.name}, installed as a personal skill under its bare name by an older install, wins over a project skill of the same name`, fix: `${moveHint(p.name)}${fix}` });
      } else if (beside(p.name, true)) {
        shadowed.push({ name: p.name, file: p.file, verdict: 'runs-beside', detail: `it runs beside cogyard's ${besideRun(p.name)} — both apply and nothing says which wins`, fix });
      }
    } else if (shippedCommands.has(p.name) && bareCommand(p.name) && !install.plugin) {
      // A project SKILL against cogyard's bare-named personal COMMAND: the
      // agent's rules say a skill beats a command file and a personal one
      // beats a project's, not which wins here — only one of the two runs.
      shadowed.push({ name: p.name, file: p.file, verdict: 'one-runs', detail: `it has the name of cogyard's /${p.name} command, installed as a personal command under its bare name by an older install — only one of the two runs`, fix: `${moveHint(p.name)}rename it if it should not run beside cogyard's` });
    }
    // A project skill that took cogyard's personal name itself.
    for (const n of [...shipped.keys()].filter((x) => personalName(x) !== x && personalName(x) === p.name && personalSkill(x) && !bareSkill(x))) {
      shadowed.push({ name: p.name, file: p.file, verdict: 'never-runs', detail: `it never runs — it has the name of cogyard's ${skills.invocation(n, { cogyard: true })}, a personal skill, which wins over a project skill of the same name`, fix: `rename it — names starting ${personalName('')} are cogyard's` });
    }
  }

  // The project's own commands (task 218): a command shares the skills' names,
  // so cogyard's skill OR command of that name takes it.
  for (const c of skills.projectCommands ? skills.projectCommands(repoRoot) : []) {
    const isSkill = shipped.has(c.name);
    if (!isSkill && !shippedCommands.has(c.name)) continue;
    const fix = `rename it (e.g. ${ownSkillName(slug, c.name)}) or delete it`;
    if (isSkill ? bareSkill(c.name) : bareCommand(c.name)) {
      shadowed.push({
        name: c.name, file: c.file, verdict: 'never-runs',
        detail: isSkill
          ? `it never runs — cogyard's ${c.name}, installed as a personal skill under its bare name by an older install, wins over a command file of the same name`
          : `it never runs — cogyard's /${c.name}, installed as a personal command under its bare name by an older install, wins over a project command of the same name`,
        fix: `${moveHint(c.name)}${fix}`,
      });
    } else if (beside(c.name, isSkill)) {
      shadowed.push({ name: c.name, file: c.file, verdict: 'runs-beside', detail: `it runs beside cogyard's ${besideRun(c.name)} — both apply and nothing says which wins`, fix });
    }
  }

  const stale = [];
  for (const r of replacing) {
    const c = shipped.get(r.replaces);
    if (c && c.changed && c.changed > r.reconciled) stale.push({ name: r.name, file: r.file, replaces: r.replaces, reconciled: r.reconciled, changed: c.changed });
  }

  const outcomes = ['adopt'];
  if (skills.supported) outcomes.push('keep');
  if (skills.alwaysLoaded) outcomes.push('facts');

  return {
    collisions: collisions.filter((c) => !replaced.has(c.skill)),
    reconciled, shadowed, stale, outcomes, install,
  };
}

// cogyard's own names that the agent keeps for its built-in commands (task
// 218). Machine-wide, not per project: a personal skill or command under such
// a name replaces the built-in everywhere. Checks the name each is (or would
// be) installed under personally — `cogyard-<name>`, plus the bare <name> while
// an older install's link holds it. → [{ name, as, kind, why, personal }],
// `as` the clashing name, `personal` = installed under it now (it replaces the
// built-in today); not personal = the install leaves it out. Report only.
export function auditReservedNames({ adapter = activeAdapter, repoRoot = process.cwd() } = {}) {
  const skills = adapter.skills;
  const reserved = new Map((skills.reservedNames ? skills.reservedNames() : []).map((r) => [r.name, r.why]));
  if (!reserved.size) return [];
  const install = skills.install(repoRoot);
  const personalName = skills.personalName || ((n) => n);
  const out = [];
  const check = (name, kind, personal, bare) => {
    const prefixed = personalName(name);
    if (reserved.has(prefixed)) out.push({ name, as: prefixed, kind, why: reserved.get(prefixed), personal: personal && !(bare && prefixed !== name) });
    if (bare && prefixed !== name && reserved.has(name)) out.push({ name, as: name, kind, why: reserved.get(name), personal: true });
  };
  for (const { name } of skills.shipped()) check(name, 'skill', (install.personalSkills || []).includes(name), (install.bareSkills || []).includes(name));
  for (const { name } of skills.shippedCommands ? skills.shippedCommands() : []) check(name, 'command', (install.personalCommands || []).includes(name), (install.bareCommands || []).includes(name));
  return out;
}

export function describeReservedNames(found, { adapter = activeAdapter } = {}) {
  const how = adapter.skills.installCommand ? `\`${adapter.skills.installCommand}\`` : 'the personal install';
  return found.map((f) => {
    const plugged = adapter.skills.invocation(f.name, { cogyard: true, plugin: true });
    return f.personal
      ? `cogyard's ${f.kind} ${f.name} is installed as the personal ${f.kind} ${f.as}, the name of ${f.why}, so it replaces it. Fix: remove that personal ${f.kind} and use the cogyard plugin, where it is ${plugged} — or rename cogyard's`
      : `cogyard's ${f.kind} ${f.name} would be the personal ${f.kind} ${f.as}, the name of ${f.why}. ${how} leaves it out; the cogyard plugin has it as ${plugged}. Rename cogyard's so a personal install can carry it`;
  });
}

// The audit as one line per finding, for onboard's warnings and doctor.
export function describeAudit(audit) {
  const out = [];
  for (const c of audit.collisions) {
    out.push(`${c.file}${c.heading ? ` ("${c.heading}")` : ''} holds a ${labelOf(c.skill)} process beside cogyard's ${c.skill} skill, and nothing says which wins — choose at \`cogyard onboard\`, or move it by hand (docs/PROJECT-INIT.md, "One process, one place")`);
  }
  for (const s of audit.shadowed) out.push(`${s.file}: ${s.detail}. Fix: ${s.fix}`);
  for (const s of audit.stale) out.push(`${s.file} replaces cogyard's ${s.replaces}, last reconciled ${s.reconciled}; cogyard's changed on ${s.changed} — compare them, then move the date`);
  return out;
}

function labelOf(skill) {
  return (AREAS.find((a) => a.skill === skill) || { label: skill }).label;
}

// --- acting on a decision -----------------------------------------------------

// Carry out the owner's choice for every collision with cogyard's <skill>.
// Writes the files and commits exactly them. → { changed: [rel paths], notes:
// [lines for the owner], removed: [{ file, heading, text }], commit }.
export function reconcileProcess(repoRoot, { skill, outcome, collisions, adapter = activeAdapter, slug, day = today(), commit = true } = {}) {
  const area = AREAS.find((a) => a.skill === skill);
  if (!area) throw new Error(`unknown process "${skill}" (one of: ${AREAS.map((a) => a.skill).join(', ')})`);
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome "${outcome}" (one of: ${OUTCOMES.join(', ')})`);
  const skills = adapter.skills;
  if (outcome === 'keep' && !skills.supported) throw new Error('"keep" needs an agent with project skills; none is active');
  if (outcome === 'facts' && !skills.alwaysLoaded) throw new Error('"facts" needs an agent with an always-loaded instruction file; none is active');
  const mine = (collisions || []).filter((c) => c.skill === skill);
  if (!mine.length) return { changed: [], notes: [], removed: [], commit: null };

  const install = skills.install(repoRoot);
  const changed = new Set();
  const notes = [];
  const removed = [];
  const cogyardRun = skills.invocation(skill, { cogyard: true, plugin: install.plugin && !install.personal });
  const own = ownSkillName(slug, skill);
  const ownRun = skills.invocation(own);

  const pointer = {
    adopt: `${area.title} is cogyard's \`${skill}\` skill — run \`${cogyardRun}\`, or ask for it in your own words. The steps that were here were replaced on ${day} so this project has one ${area.label} process; they are in git history.`,
    keep: `${area.title} is this project's \`${own}\` skill (\`${ownRun}\`); cogyard's \`${skill}\` is turned off here. The steps that were here moved into that skill on ${day}.`,
    facts: `${area.title} is cogyard's \`${skill}\` skill (\`${cogyardRun}\`), read alongside this project's differences in \`${skills.alwaysLoaded}\`. The steps that were here moved there on ${day}.`,
  }[outcome];

  // Each doc's sections, last first, so earlier line numbers stay valid.
  const byFile = new Map();
  for (const c of mine) byFile.set(c.file, [...(byFile.get(c.file) || []), c]);
  for (const [file, cs] of byFile) {
    const abs = join(repoRoot, file);
    const lines = readFileSync(abs, 'utf8').split('\n');
    const fromHere = [];
    for (const c of [...cs].sort((a, b) => b.start - a.start)) {
      const bodyFrom = c.heading == null ? c.start : c.start + 1;
      fromHere.unshift({ file, heading: c.heading, text: lines.slice(bodyFrom, c.end).join('\n').trim() });
      lines.splice(bodyFrom, c.end - bodyFrom, '', marker(skill, outcome, day), pointer, '');
    }
    removed.push(...fromHere);
    writeFileSync(abs, lines.join('\n'));
    changed.add(file);
  }
  const source = removed.map((r) => `\`${r.file}\`${r.heading ? ` ("${r.heading}")` : ''}`).join(', ');

  if (outcome === 'adopt') {
    notes.push(`The old ${area.label} steps are gone from ${source}. Anything in them that is still true and that cogyard's ${skill} doesn't know (what a push deploys, an extra check) belongs in ${skills.alwaysLoaded || 'the project\'s instructions'} — move it by hand; the text is in git history.`);
  }

  if (outcome === 'keep') {
    const rel = skills.projectSkillFile(own);
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) throw new Error(`${rel} already exists — pick another name by hand, or remove it first`);
    const body = [
      `# ${own} — this project's ${area.label} process`,
      '',
      header(skill, day),
      '',
      `This skill is this project's whole ${area.label} process, moved here from ${source} on ${day}. cogyard's \`${skill}\` is turned off in this project, so nothing else applies: keep this file complete on its own. When cogyard's \`${skill}\` changes, compare the two and move the date above — \`cogyard tasks doctor\` says when it is behind.`,
      '',
      ...removed.map((r) => (removed.length > 1 && r.heading ? `## ${r.heading}\n\n${r.text}` : r.text)),
    ].join('\n');
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, skills.renderSkill({
      name: own,
      description: `This project's ${area.label} process, replacing cogyard's ${skill} (turned off here). Use it whenever cogyard's ${skill} would apply — ${area.triggers}.`,
      body,
    }));
    changed.add(rel);
    const off = skills.turnOff(repoRoot, skill, { cogyard: true });
    if (off) changed.add(off);
    if (install.plugin) {
      const plugged = skills.invocation(skill, { cogyard: true, plugin: true });
      notes.push(`cogyard is installed as a plugin here, so ${plugged} stays loaded — a plugin is on or off as a whole. ${skills.alwaysLoaded} now says to use ${own} instead.`);
      appendTo(repoRoot, skills.alwaysLoaded, [
        '',
        `## ${area.title}`,
        '',
        marker(skill, 'keep', day),
        `For ${area.label}, use this project's \`${own}\` skill (\`${ownRun}\`), not cogyard's \`${plugged}\`.`,
        '',
      ].join('\n'));
      changed.add(skills.alwaysLoaded);
    }
  }

  if (outcome === 'facts') {
    const quoted = removed.map((r) => r.text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')).join('\n>\n');
    appendTo(repoRoot, skills.alwaysLoaded, [
      '',
      `## ${area.title} — this project's differences from cogyard's \`${skill}\``,
      '',
      marker(skill, 'facts', day),
      `cogyard's \`${skill}\` skill runs ${area.label} in this project. The quote below was this project's own ${area.label} process, moved here from ${source} on ${day}. Keep only what differs from cogyard's skill (what a push deploys, an extra check) and delete the rest; where it still contradicts the skill, the skill's steps are what run.`,
      '',
      quoted,
      '',
    ].join('\n'));
    changed.add(skills.alwaysLoaded);
    notes.push(`${skills.alwaysLoaded} now quotes the old ${area.label} steps under "${area.title} — this project's differences". Trim it to what really differs from cogyard's ${skill}.`);
  }

  const paths = [...changed];
  let sha = null;
  if (commit) {
    for (const p of paths) execLoud(`git add -- ${JSON.stringify(p)}`, { cwd: repoRoot });
    execLoud(`git ${gitIdentityFlags(repoRoot)}commit -q -m ${JSON.stringify(`chore: one ${area.label} process — ${outcome} (cogyard onboard)`)} -- ${paths.map((p) => JSON.stringify(p)).join(' ')}`, { cwd: repoRoot });
    sha = tryExec('git rev-parse --short HEAD', { cwd: repoRoot });
  }
  return { changed: paths, notes, removed, commit: sha };
}

function appendTo(repoRoot, rel, text) {
  const abs = join(repoRoot, rel);
  const was = read(abs) || '';
  writeFileSync(abs, (was && !was.endsWith('\n') ? was + '\n' : was) + text);
}
