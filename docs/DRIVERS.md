# Drivers — driving cogyard with any agent

cogyard's engine (`core/`) and CLI (`cli/`) are **agent-agnostic**: any agent —
Claude Code today, Codex / Ollama / a human tomorrow — drives the same task /
claim / port / worktree machinery by calling `cli/tasks.mjs` and `cli/env.mjs`.

Several things in the engine are inherently agent-specific, though, and a
different agent would not satisfy them. cogyard moves all of them behind a small
**adapter** interface so the shared engine asks the *active* driver instead of
hardcoding Claude Code:

| Seam | What's agent-specific | Engine consumers |
|------|-----------------------|------------------|
| **worktree** | the on-disk layout + branch prefix an agent uses for its worktrees (Claude: `<repo>/.claude/worktrees/<name>`, `claude/*`) | `core/usage.mjs`, `hooks/worktree-ports.mjs`, `hooks/worktree-session.mjs`, `cli/tunnel.mjs` |
| **transcripts** | where the agent stores session transcripts, how to parse one into token rows, and how to read one as a conversation | `core/usage.mjs`, `cli/usage.mjs`, `core/task-chats.mjs`, `core/chat-read.mjs` (`cogyard sessions show` / `search`) |
| **pricing** | the agent's model-id → price table + shorthand aliases | `core/pricing.mjs` |
| **sessions** | the agent app's own chat metadata | `core/cleanup.mjs`, `core/sessions-audit.mjs` |
| **agent** | how to run the agent headlessly, with no tools, for a scheduled job — **and the credential it authenticates with**, since every job needs the same one and its name is an agent literal | `core/addons/jobs.mjs` (via `ctx.agent`), and the add-on that surfaces it |

## How it resolves — `core/drivers.mjs`

`core/drivers.mjs` resolves and loads the **active adapter once at import**
(top-level await) and exports it as `adapter`. Every engine consumer imports that
resolved object and uses it synchronously.

Resolution order:

1. `COGYARD_DRIVER` env var (`claude`, `none`, or any `drivers/<name>`).
2. `~/.cogyard/config.json` → `{ "driver": "<name>" }`.
3. **Auto-detect** — the first `drivers/<name>/adapter.mjs` whose `detect()`
   returns true claims the environment. (Claude's `detect()` is true under Claude
   Code or when `~/.claude` exists.)
4. **Fallback: the built-in no-op adapter** (`NOOP` in `core/drivers.mjs`).

The no-op adapter ships inside `core/` so the CLI and portal run with **no agent
active at all** — a plain human user gets a working engine; the usage tab simply
has nothing to harvest and degrades gracefully.

## The adapter contract

A driver is a directory `drivers/<name>/` containing an `adapter.mjs` whose
default export is an object with this shape. Every field is required; an
unsupported seam returns the documented "off" value rather than throwing.

```js
// drivers/<name>/adapter.mjs
export default {
  name: '<name>',

  // Is THIS driver active for the current environment?
  // Used only by core/drivers.mjs auto-detection (step 3 above). Keep it
  // cheap and side-effect-free.
  detect() { return /* boolean */ },

  // Was THIS process started by your agent (one of its tool calls), rather than
  // by a human's shell? Narrower than detect(): having the agent INSTALLED is
  // not the agent RUNNING this command. core/drivers.mjs `agentSession()` asks
  // every installed driver, and owner-only commands (`cogyard publish`) refuse
  // when one says yes (the task-close overrides first check the owner's own
  // words through transcripts.ownerTurns). Usually an environment variable your agent sets in the
  // shells it spawns. A guard against an agent doing it by habit, not a
  // security boundary — a process can always clear its own environment.
  inSession() { return /* boolean */ },

  // The id of the agent chat that started THIS process, or null when your agent
  // doesn't expose one. It must be the same id the agent passes to
  // `cogyard env claim <file> <session-id>`: core/drivers.mjs
  // `currentSessionId()` asks every installed driver, and a plain
  // `cogyard tasks sync push` that names no files uses the answer to tell this chat's claimed
  // task files from another chat's. null is safe — the push then
  // leaves every task file another chat has claimed alone.
  sessionId() { return '<id>' /* | null */ },

  // --- seam 1: worktree -----------------------------------------------------
  worktree: {
    // Given ANY checkout path, return {parentRepo, name} when it is one of this
    // agent's worktrees, else null. (The generic worktree-config marker —
    // .cogyard/worktree.json — is handled by the engine; this is the agent-SPECIFIC positional
    // fallback that identifies the project root + worktree name from the path.)
    detect(path) { return { parentRepo: '<abs repo root>', name: '<worktree>' } /* | null */ },
    // Branch-name prefix this agent uses for worktree branches (metadata).
    branchPrefix: '<prefix>/' /* | null */,
  },

  // --- seam 2: transcripts --------------------------------------------------
  transcripts: {
    supported: true,                 // false → usage harvesting is a no-op
    root() { return '<abs dir>' },   // where transcripts live (or null)
    list() { return [/* abs file paths */] },          // every transcript file
    findBySession(sessionId) { return [/* abs paths */] }, // this session's transcript(s)
    // Optional: logs of helper agents this session spawned, whose
    // actions count as the session's own work. Omit if your agent has none.
    findHelpersBySession(sessionId) { return [/* abs paths */] },
    // One raw transcript line (string) → normalized record, or null to skip.
    //   { sessionId, cwd, usage, prompt }  — sessionId/cwd may be null on a line.
    //   usage (the billable turn, or null):
    //     { model, timestamp, dedupeKey, tokens }
    //   tokens: { input, output, cacheRead, cacheWrite5m, cacheWrite1h }
    //     (the ledger's fixed token shape — map your agent's fields onto it;
    //      leave cache tiers 0 if your agent has no prompt caching).
    //   prompt (a HUMAN prompt event, or null — the attention signal):
    //     { timestamp, dedupeKey }
    //     Emit it ONLY for messages the human actually typed — not tool results,
    //     not injected/meta lines. If your agent's log can't tell those apart,
    //     always return null: the attention views then show nothing for this
    //     agent instead of counting machine noise as human attention.
    //   commands / filesWritten (optional, [] when unknown): the
    //     shell commands this line's own tool calls RAN, and the file paths its
    //     own edit/write tool calls targeted. Only the agent's ACTIONS — never
    //     text it read, quoted or was shown. The engine reads `[#NN]` commit
    //     tags from `commands` and task-file edits from `filesWritten`; an
    //     agent that can't report them simply earns neither signal.
    parseLine(line) { return { sessionId, cwd, usage, prompt, commands, filesWritten } /* | null */ },
    // The first HUMAN prompt text in a transcript file — a chat's LABEL, for the
    // task→chats lookup (core/task-chats.mjs). Skips tool results and meta
    // lines, and returns the words, capped short. Bounded head-read only. null
    // when unreadable or none.
    //   Injected text is skipped PER BLOCK, not per line: an agent
    //   app may put a note of its own (a reminder, a status line) in front of
    //   what the human typed, inside the same line. Leave the injected parts
    //   out and keep the typed ones; a line counts as typed when anything typed
    //   is left. firstHumanLabel and readTurns share one rule for this, so a
    //   chat's label and its shown turns never disagree.
    firstHumanLabel(file) { return '<≤100-char label>' /* | null */ },
    // A transcript file → the readable conversation, for the portal's chat
    // viewer and `cogyard sessions show` / `search`. Ordered turns, the human's
    // typed prompts and the agent's own text only (no tool calls, tool output,
    // reasoning or injected text — injected blocks left out one by one, as for
    // firstHumanLabel, so a typed message with a note in front still shows).
    // Bounded: at most opts.maxTurns turns (default 600), each cut to
    // opts.maxChars (default 8000); `truncated` says the turn limit was hit.
    // Pass Infinity for both to read the whole chat. This is the ONLY place a
    // transcript is read for display — nothing in core/ parses the format.
    readTurns(file, { maxTurns, maxChars } = {}) {
      return { turns: [{ role: 'user' /* | 'assistant' */, text, timestamp }], truncated: false };
    },
    // Everything the OWNER typed in one chat (by session id), oldest first —
    // the words core/owner-words.mjs checks before an agent may run an
    // owner-only task command the owner told it to run (`close --enough
    // --asked "<their words>"`). Stricter than readTurns, because
    // these words authorize something: only lines your agent marks as typed by
    // a person; never the agent's text, tool output, a skill/command's
    // expanded body (its arguments were written by the agent), a summary, a
    // helper agent's line, or a message from another chat. Cut pasted text
    // and injected blocks out of a typed line. If your log can't tell typed
    // lines apart, return [] — the commands then stay refused for your agent,
    // and the owner runs them from their own terminal.
    ownerTurns(sessionId) { return ['<what the owner typed>'] },
    // Every chat's MAIN transcript under root (default root()), helper logs
    // excluded. `root` lets the engine read a COPY of the transcript folder
    // with the same layout — the chat-archive add-on's
    // ($COGYARD_HOME/chat-archive/conversations/). One chat may
    // appear more than once if your agent can keep several files for it.
    sessionFiles(root) { return [{ sessionId, file }] },
    // Several transcript files for ONE chat → the one to read (or null for
    // none). Claude Code keeps a file per folder a chat worked in, and the
    // copies can differ in length, so it picks the most messages, ties → the
    // newest. An agent with one file per chat returns files[0].
    pickFullest(files) { return '<abs path>' /* | null */ },
  },

  // --- seam 3: pricing ------------------------------------------------------
  // The engine (core/pricing.mjs) owns the cache-tier math and version-locking;
  // the adapter only supplies the data:
  pricing: {
    // Newest first. `models` keys are the exact model strings parseLine emits.
    // This is the offline SEED — what pricing falls back to before any sync and
    // whenever the feed is unreachable. It is also a FLOOR: a synced version is
    // stored as seed ⊕ feed, so a model the feed doesn't carry keeps this rate
    // rather than dropping to unpriced.
    versions: [{ version, effective, source, models: {
      // Rates are $ per MILLION tokens. input + output are required; the three
      // cache tiers are OPTIONAL and override the engine's fallback ratios
      // (read 0.1x / 5m write 1.25x / 1h write 2x of input — Anthropic's
      // published multipliers). State them if your provider prices cache on its
      // own schedule; omit them and the ratios apply.
      '<model-id>': { input, output, cacheRead?, cacheWrite5m?, cacheWrite1h? },
    } }],
    aliases: { /* shorthand → full model id */ },

    // OPTIONAL. Where live rates come from. Omit it and the seed table is all
    // there is — which goes stale the day a new model ships, pricing its work at
    // null (and $0 in the portal) until someone hand-edits the table.
    //
    // Fetch and shape only: no filesystem, no caching, no policy. The engine
    // (core/pricing.mjs → syncPricing) decides whether anything changed, writes
    // your table into $COGYARD_HOME/pricing.json under YOUR driver name (every
    // driver gets its own entry; nobody clobbers anybody), and reprices rows the
    // new rates unblock.
    // THROW on any failure — the engine keeps the last known-good table, which
    // is why a broken feed can never un-price existing work.
    async sync() { return { models: { '<model-id>': { input, output } }, source: '<url>' } },
  },

  // --- seam 4: sessions ------------------------------------------------------
  // The agent app's own chat metadata, for `cogyard sessions audit`,
  // `cogyard cleanup chat`, and whether a claimed task's chat was archived or
  // deleted (the portal's live state).
  // Reads are unrestricted. The ONE sanctioned write is archive(): flip a
  // single chat's archived flag (reversible UI state, no data) — used only by
  // `cleanup chat`'s interactively-confirmed path. Nothing else in the
  // engine may write through this seam, and transcripts are never touched.
  sessions: {
    supported: true,                 // false → the chat reports find nothing
    // Optional: the folder the agent app keeps this metadata in (or null) —
    // for a job that copies the store as-is rather than reading it, such as
    // the chat-archive add-on. Omit it and such a job copies conversations only.
    root() { return '<abs dir>' },
    // Every chat, newest first, ONE row per chat:
    //   { title, sessionId, cwd, isArchived, lastActivityAt /* ISO | null */,
    //     priorSessionIds /* optional: transcript ids the chat used before
    //     its current sessionId — e.g. after a rewind. A ledger row recorded
    //     under one of them still resolves to this chat's title. */
    //     parentSessionId /* optional: the chat that started this one (a side
    //     session, a worker), as a sessionId of another row; null or omitted
    //     for a chat the person started. */
    //     rootSessionId /* optional: the top chat of that tree, as a sessionId.
    //     The Cleanup report nests children under their parent, files a child
    //     run in an unregistered folder under its top chat's project, and holds
    //     a parent while a child is held. A driver that omits both: every chat
    //     is top-level, exactly as before. */ }
    list() { return [/* rows */] },
    listArchived() { return [/* archived subset */] },
    // For each chat id, what the OWNER did with it in the app:
    //   'open' (still there) · 'archived' · 'deleted' · 'unknown' (can't tell).
    // The portal shows "chat archived" / "chat deleted" from this and nothing
    // else, so answer 'deleted' only when the app really no longer has the
    // chat, and 'unknown' rather than guess. One call covers many ids; the
    // engine asks at most once a minute.
    status(ids) { return { '<id>': 'open' } },
    // Mark one chat archived; return the flag re-read from the store so the
    // caller can verify the write stuck (the agent app owns the store and a
    // concurrent app write may win).
    archive(sessionId) { return true },
    // Optional: bring the agent app to the front on one chat — a click on the
    // driver logo beside a claimed task (Plan, All, Tasks). Writes nothing.
    // Never throw: return { ok: true } once the app has been asked, or
    // { ok: false, reason } with a few plain words the portal shows beside
    // the logo ("chat is archived", "not a chat in the app"). Omit it and
    // the logo is not clickable.
    open(sessionId) { return { ok: true } },
  },

  // --- seam 5: agent ---------------------------------------------------------
  // Run the agent headlessly for a SCHEDULED JOB (see docs/ADDONS.md). The
  // caller supplies every input in `prompt`; the agent gets NO tools and no
  // filesystem access, and returns text. That is the contract, not an
  // implementation detail: with no tools there is no permission surface, so an
  // unattended nightly run can never touch a repo. An agent that cannot be run
  // without tools reports `supported: false` rather than relaxing this.
  agent: {
    supported: true,                 // false → scheduled jobs needing an agent report it and skip

    // THE CREDENTIAL your agent authenticates with, or null if it needs none.
    // It belongs HERE, not to any add-on: this adapter is what spawns the agent,
    // every scheduled job needs the same one variable, and the variable's name
    // is an agent-specific literal — which is the whole reason this seam exists.
    // Declaring it per-add-on duplicates it and puts your literal inside
    // community code.
    //
    // The owner puts the VALUE in the credential store (docs/CONFIGURATION.md);
    // the engine loads that into the environment at start, so the process you
    // spawn inherits it. cogyard never mints, refreshes, or reads it — `howTo`
    // is printed for the owner to run themselves. The portal shows only whether
    // the variable resolves, and only through an add-on that asks for it —
    // core renders no credential UI, because nothing in core calls an agent.
    credential: {
      env: 'YOUR_AGENT_TOKEN',       // the environment variable your CLI reads
      label: 'Your Agent token',     // shown on the Machine card
      howTo: 'your-agent login --print-token',  // how the owner obtains one
    },

    // MUST NOT prompt for input. MUST terminate when `signal` aborts. MUST NOT
    // throw — every failure comes back as { ok: false, error }, including the
    // agent's own errors (not-logged-in, rate limited, model unavailable).
    // `cost` is USD for this call when the agent reports it, else null.
    // `cwd`, when given, is the folder to run the agent in; unset, run it
    // somewhere neutral. The scheduled-job runner passes each job its own
    // empty folder under $COGYARD_HOME/run/ so the usage ledger can file the
    // call under the job — honour it if your transcripts record a cwd.
    //   { prompt: string, signal?: AbortSignal, model?: string,
    //     silenceMs?: number, ceilingMs?: number, cwd?: string }
    //     → { ok, text, cost, model, error, failure, elapsedMs, ttfbMs }
    async run({ prompt, signal, model, silenceMs, ceilingMs, cwd }) {
      return { ok: true, text: '<prose>', cost: 0.01, model: '<id>', error: null,
               failure: null, elapsedMs: 12345, ttfbMs: 800 };
    },
  },

  // --- seam 6: liveState -----------------------------------------------------
  // What the agent is doing right now, for the Plan and Tasks tabs' live line
  // on each claimed task (working / needs you / stopped / background / error; "chat
  // archived" / "chat deleted" come from sessions.status). The
  // agent's own hooks run `cogyard hook live-state` on each event, with the
  // raw hook input on stdin; the engine hands it to parseHook and files the
  // result under $COGYARD_HOME/live/ (core/live-state.mjs). An agent with no
  // hooks reports supported: false, and its claimed tasks read "no live signal".
  liveState: {
    supported: true,                 // false → claimed tasks show state "unknown"
    // An image the portal shows beside the state, so a task worked by this
    // agent is recognisable at a glance. An agent's logo is usually its
    // maker's trademark, so DON'T bundle one: name where a public copy lives
    // in logoSource, and your driver's install step downloads it into
    // $COGYARD_HOME/drivers/<name>/ with core/driver-logo.mjs fetchDriverLogo()
    // (an SVG that could run script is refused). `logo` is an optional
    // bundled file — only for a mark you may redistribute — and wins when
    // present. Served by GET /api/drivers/<name>/logo; with neither, no logo.
    logo: null,                      // or '<abs path>/logo.svg'
    logoSource: { url: 'https://…/logo.svg', fill: '#RRGGBB' /* optional: colours a one-colour mark */ },
    // One hook input (already JSON-parsed) → one neutral event, or null to
    // ignore it:
    //   { session,            // the chat's id — the same id `env claim` records
    //     agent,              // a subagent's id when the event came from one, else null
    //     state,              // 'working' | 'needs' | 'stopped' | 'background' | 'error' | 'ended'
    //     error?,             // for 'error': the agent's error type (e.g. rate_limit)
    //     spawn?,             // { agent, task }: the chat just started a worker
    //                         // for task <task> (autopilot names each worker
    //                         // "task NNN"), so that worker's events land on it
    //     backgroundDone? }   // true on a worker's 'stopped' when the agent says
    //                         // the CHAT has nothing left running in the background
    // 'working' = running · 'needs' = waiting on the human (a permission
    // prompt, a question, a plan to approve) · 'stopped' = idle ·
    // 'background' = idle, but a job the chat started is still running (a dev
    // server, a worker): the turn ended, so it is NOT 'working', which would
    // read "running" for as long as a server stays up. A later
    // waking event makes it 'working'; backgroundDone or the process ending
    // makes it 'stopped'. Only emit it when the agent's own event lists the
    // running job. · 'error' = the turn ended on an error. 'ended' with agent null = the chat's
    // PROCESS ended (Claude's SessionEnd): the chat and its workers read idle.
    // There is no "closed" — an agent app may end an idle chat's process by
    // itself, and the chat is still there. Whether the owner archived or
    // deleted the chat is sessions.status()'s answer, never a hook event's.
    // Map only events your agent DOCUMENTS. Never infer a state from silence
    // or from the agent app's private files: a state the portal shows must be
    // one the agent actually reported.
    // MUST NOT throw on input it does not recognise — return null. It runs on
    // every tool call, so keep it to field reads.
    parseHook(input) { return { session, agent, state } /* | null */ },
  },

  // --- seam 7: skills --------------------------------------------------------
  // Where a project's process can live for this agent, and which of cogyard's
  // skills reach it. core/process-docs.mjs uses it to find a
  // project's merge or commit process that sits beside cogyard's (in an
  // instruction file the skills never read, or in a project skill named like
  // cogyard's), and to move it into one place when the owner chooses at
  // onboard. Paths are relative to the repo. An agent with no skill channel
  // reports supported: false; the check then reads only docs/*.md.
  skills: {
    supported: true,
    // The instruction file the agent always loads at the repo root, where a
    // project's facts go when cogyard's skill stays in charge (or null).
    alwaysLoaded: '<file>',
    // The agent's instruction files in a repo, the always-loaded one first.
    instructionFiles(repoRoot) { return ['<file>', /* … */] },
    // The project's own skills.
    projectSkills(repoRoot) { return [{ name: '<skill>', file: '<path>' }] },
    // The project's own commands, if the agent has a separate command format
    // that shares the skills' names. Optional; [] when it has none.
    projectCommands(repoRoot) { return [{ name: '<command>', file: '<path>' }] },
    // Where a new project skill <name> is written.
    projectSkillFile(name) { return '<path>' },
    // A skill file's whole text in the agent's format.
    renderSkill({ name, description, body }) { return '<text>' },
    // What the owner types to run a skill; `cogyard` = one of cogyard's own,
    // `plugin` = cogyard installed as a plugin (some agents namespace those).
    invocation(name, { cogyard, plugin }) { return '/<name>' },
    // The command that installs cogyard's skills as personal ones (or null).
    installCommand: '<command>',
    // The name cogyard's skill or command <name> gets when installed as a
    // personal one — distinct from any name a person, a project or the agent
    // uses (the Claude driver: `cogyard-<name>`). Optional; the name itself.
    personalName(name) { return '<name>' },
    // How cogyard's skills reach the agent for this repo. `personal`: some
    // are installed as personal skills. `plugin`: they are the plugin's.
    // personalSkills / personalCommands: which are installed personally.
    // bareSkills / bareCommands: those an older install put under the bare
    // <name> rather than personalName(<name>) — they still beat a project's
    // own skill or command of that name; the rest load beside it.
    install(repoRoot) { return { personal: true, personalSkills: ['<skill>'], personalCommands: ['<command>'], bareSkills: [], bareCommands: [], plugin: false } },
    // The skills this driver ships, each with the day it last changed
    // (YYYY-MM-DD, or null) — a project skill reconciled before that is stale.
    shipped() { return [{ name: '<skill>', changed: '<day>' }] },
    // The commands this driver ships (optional; [] when it ships none).
    shippedCommands() { return [{ name: '<command>' }] },
    // Names the agent keeps for its own commands, which a personal skill or
    // command of cogyard's must not take, each with why. The list
    // is the driver's — core never names an agent's built-ins. Optional; [].
    reservedNames() { return [{ name: '<name>', why: '<sentence>' }] },
    // Is skill <name> turned off for this repo? The settings file that does
    // it, or null. `cogyard: true` = cogyard's skill <name>, under whatever
    // name it is installed.
    isOff(repoRoot, name, { cogyard }) { return '<path>' /* | null */ },
    // Turn skill <name> off for this repo, changing nothing else in the
    // settings file. The file written, or null when already off. Throws if
    // the agent can't turn a skill off per project. `cogyard: true` = cogyard's
    // skill <name>, leaving a project skill of that name on.
    turnOff(repoRoot, name, { cogyard }) { return '<path>' /* | null */ },
  },
};
```

### Supervising the call — silence, not duration

A caller cannot judge an agent by wall-clock alone. Different projects are
different sizes, so any fixed cap is a guess: set it low and it kills work that
was going fine, set it high and a dead server burns the whole run before anyone
notices. Both are guesses because a call that emits nothing until it finishes
offers no information to supervise.

So `run()` takes two bounds, and the FIRST one is the real mechanism:

| bound | meaning | who it catches |
|---|---|---|
| `silenceMs` | abort when no output has arrived for this long | a call that has stopped producing — the actual failure |
| `ceilingMs` | abort after this long no matter what | a pathological stream that dribbles forever |

A driver whose agent streams should reset the silence window on **every byte**
from the child, so a call that is progressing is never killed however long the
work legitimately takes. A driver whose agent cannot stream should ignore
`silenceMs` and honour `ceilingMs` only — the caller then gets the old
wall-clock behaviour, which is worse but honest, rather than a silence window
that is secretly a duration cap.

`elapsedMs` and `ttfbMs` (time to the first byte, `null` when nothing ever
arrived) are returned on **every** result, success or failure. They are how
slowness becomes data instead of something inferred from gaps between log lines.

### The failure vocabulary

`failure` is `null` when `ok` is true, and otherwise names WHAT WENT WRONG, so a
caller can say something truer than "it failed". `error` stays a human sentence;
`failure` is the machine-readable kind. Every driver uses the same four words —
they describe the shape of the failure, not anything about a particular agent:

| `failure` | what happened | what it tells the owner |
|---|---|---|
| `no-response` | nothing ever arrived — `ttfbMs` is `null` | the agent was never reached: a dead credential, no network, a server that is down |
| `stalled` | output began, then stopped before an answer | the call wedged mid-answer; the credential is fine |
| `cancelled` | the caller's `signal` aborted | the run itself was shutting down; this call was never given its chance |
| `error` | anything else: the agent's own error envelope, a missing binary, a spawn failure, output that was not a result | read `error` — it is specific |

A fifth kind, `unusable`, belongs to the CALLER, not to a driver: the agent
answered, was paid, and the answer was not the thing that was asked for. A
driver cannot know that, because it does not know what the caller wanted.

**Killing means killing.** A driver that aborts a call must make sure the child
actually dies, not merely that a signal was sent. Node's `spawn(…, {signal})`
sends one `SIGTERM` and reports `AbortError` immediately, so a child that
declines to honour it survives while the caller is told the call ended —
measured on the Claude driver 2026-09-04, where the promise settled in 10ms and
the child was still alive a second later, still holding the parent's stdio
pipes. In an always-on process that is a leak. Escalate to `SIGKILL` after a
grace period.

### The built-in no-op adapter (reference for "off" values)

```js
{
  name: 'none',
  detect() { return false },
  inSession() { return false },
  sessionId() { return null },
  worktree:    { detect() { return null }, branchPrefix: null },
  transcripts: { supported: false, root() { return null }, list() { return [] },
                 findBySession() { return [] }, sessionFiles() { return [] },
                 pickFullest(files) { return (files && files[0]) || null },
                 parseLine() { return null }, firstHumanLabel() { return null },
                 readTurns() { return { turns: [], truncated: false } },
                 ownerTurns() { return [] } },
  pricing:     { versions: [], aliases: {} },   // no sync() — nothing to sync
  sessions:    { supported: false, root() { return null }, listArchived() { return [] },
                 status(ids) { return Object.fromEntries(ids.map((id) => [id, 'unknown'])) } },
  agent:       { supported: false, credential: null,
                 async run() { return { ok: false, text: '', cost: null, model: null,
                                        error: 'no agent driver active', failure: 'error',
                                        elapsedMs: 0, ttfbMs: null } } },
  skills:      { supported: false, alwaysLoaded: null, instructionFiles() { return [] },
                 projectSkills() { return [] }, projectCommands() { return [] },
                 projectSkillFile() { return null },
                 renderSkill() { throw … }, invocation(name) { return name },
                 installCommand: null, personalName(name) { return name },
                 install() { return { personal: false, personalSkills: [], personalCommands: [], bareSkills: [], bareCommands: [], plugin: false } },
                 shipped() { return [] }, shippedCommands() { return [] }, reservedNames() { return [] },
                 isOff() { return null }, turnOff() { throw … } },
}
```

With the no-op adapter: worktree detection falls back to the engine's generic
markers + registry/basename; `collectUsage()` harvests nothing (usage AND
activity); `priceFor()` returns `{ costUSD: null }` so tokens still ledger but
cost is never invented; a scheduled job that needs an agent reports "no agent
driver active" on its Settings row instead of running. The portal's
attention/cost activity views render empty; the commits heatmap (pure git) keeps
working with no agent at all.

## Adding an agent

1. Create `drivers/<name>/adapter.mjs` implementing the contract above.
2. Implement `detect()` so it claims only environments your agent actually runs in.
3. Ship your driver files (skills / commands / hooks / instructions) in whatever
   shape your agent consumes — see `drivers/claude/` for the reference, which
   is also packaged as a Claude Code plugin.
4. Select it with `COGYARD_DRIVER=<name>` or `~/.cogyard/config.json`, or rely
   on auto-detect.

The contract is the only coupling — the engine never imports your adapter by name.
