# cogyard — brand brief

Reference for producing marketing material (README, site, social cards, docs,
slides). Name chosen 2026-06-17.

## Name

**cogyard** — always one word, always lowercase, including at the start of
sentences. Never "CogYard", "Cog Yard", or "the Cogyard".

**The idea**: a *cog* is a working part of a machine (a tech, mechanical read);
a *yard* is an enclosed work area where many large things are built and
coordinated — a shipyard, a rail yard. cogyard is the workspace where the
machinery — your AI agents — runs across all your projects, with everything
coordinated and overseen from one place. It is AI-agnostic (Claude Code first,
but any agent or human plugs into the same CLI).

**One-liner**: "The yard where your agents work."
Alternates, by audience:
- Developer/README: "Markdown task files, a portal, and collision-free claims —
  for running AI agents across all your projects."
- Punchy/social: "Tasks in. Checkmarks out."

## Logo

The mark is a **wheel of six checkmarks** around an **amber four-point spark**
hub.

- The wheel: a turning cog — work cycling continuously. The six checkmarks are
  tasks completed.
- The hub: the four-point spark is the AI glyph — the live agent at the center,
  driving the wheel.
- The checkmarks have **straight edges** (flat ends, sharp corners), not
  rounded — a deliberate, crisp, technical feel.

Files (SVG, master format — scale infinitely, edit colors by find/replace):

| File | Use |
|---|---|
| `cogyard-mark.svg` | The mark on white/light backgrounds |
| `cogyard-lockup.svg` | Mark + wordmark, horizontal — README headers, site nav |

Usage rules:
- Minimum size 16 px (it is favicon-tested at that size).
- Clear space around the mark: at least the spark's width on all sides.
- Do not rotate, recolor outside the palette, add gradients/shadows, round the
  check edges, or redraw the checkmarks.
- On dark or colored backgrounds (e.g. the indigo `#3F3D9E` field), draw the
  checkmarks in white (`#FFFFFF`); keep the amber spark.
- The lockup's wordmark is a live `<text>` element in Poppins (loaded via a
  Google Fonts import) — convert to path outlines before using anywhere
  font-rendering matters or in an offline context.

## Color

| Role | Hex | Notes |
|---|---|---|
| Indigo (primary) | `#3F3D9E` | The wheel/checkmarks; headings, links, primary buttons |
| Amber (accent) | `#F59E0B` | The spark; use sparingly — one accent per surface |
| Ink | `#17162A` | Dark backgrounds, body text on light |
| Paper | `#FFFFFF` | Light backgrounds |

Rule of thumb: indigo does the work, amber marks the one live/active thing
(mirrors the logo: many indigo checks, one amber agent).

## Typography

- Wordmark and headings: **geometric sans (Poppins)**, weight 600 for the
  wordmark, lowercase. Never uppercase. Acceptable geometric alternates:
  Montserrat, Outfit, Futura.
- Body: a clean sans, weight 400.
- Code/paths: any standard mono.

## Voice

- Developer-first, plain, concrete. Say what it does: claims, worktrees,
  markdown files, ports. No "revolutionize", no "supercharge", no emoji walls.
- The agent is the worker, the user is the reviewer. Phrase benefits as
  "your agents do X; you see Y."
- Lowercase product name even in headlines.

## Asset checklist for launch (not yet produced)

- [ ] Favicon set (16/32/180 px PNG + .ico from `cogyard-mark.svg`)
- [ ] GitHub social-preview card (1280×640: dark ink bg, lockup, one-liner)
- [ ] README header (lockup + one-liner + badge row)
- [ ] npm package logo (uses mark as-is)
