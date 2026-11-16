# UI conventions — cogyard portal

The rules a session must follow before adding or restyling any control. The
source of truth for the recipes is `frontend/src/styles.scss` (the `Buttons`
block); this doc explains when to use which and why the system exists.

## PrimeNG vs native — the dividing line

cogyard converted every custom-looking control from a styled `p-button` to a
native `<button>`, because a `p-button` restyled past recognition via
`styleClass` + `::ng-deep` inherits the theme's transitions, hover repaints, and
prod-vs-dev CSS-order differences — including a pill gray-flash that reproduced
**only in production builds**. A library button you've overridden to 100% custom
pixels is negative value: you pay the wrapper and fight its dynamics.

- **PrimeNG** — where it provides machinery expensive to rebuild: `p-table`,
  `p-select`, `p-tree`, tabs, drawers, `p-skeleton`, tooltips.
- **Native `<button>` + a shared recipe class** — every clickable control:
  switchers, links, toggles, actions. Never a styled `p-button`.
- **Plain markup in a shared chip component** — every chip (see "Chips" below).
  Never `<p-tag>`: chips were half PrimeNG tags restyled through 25 `::ng-deep`
  rules that leaned on PrimeNG's internal markup, and half `.badge` spans — the
  same drift as `p-button`, removed the same way.

## The button recipes — pick one, never invent another

Defined once in `styles.scss`. A control is a native `<button>` wearing exactly
one class. Components may add **layout** (margin, flex) and **color modifiers**
on top; they must not redefine the control's border/padding/font/hover. The
first three are the everyday recipes; `sidebar-item` is the left-rail nav row.

| Class | Use for | Modifier |
|---|---|---|
| `btn-pill` | **Pick-or-act**: switchers + standalone actions — topbar project pills, worktree selector, usage refresh. Rounded, fillable. | `.active` = selected |
| `btn-toggle` | **In-place mode/option**: Files tab changed-only / rendered / raw / diff. Compact, tinted when engaged. | `.on` = engaged |
| `btn-link` | **Navigate somewhere**: `#task`, `⎇worktree`, project name, commit. Accent underline, no chrome. | `.mono` = monospace id label · `.dim` = muted-at-rest, accent on hover (matches the Worktrees tab's links; for whole link columns) |
| `btn-primary` | **Submit a form**: Create project, Save tabs, Save defaults, Save axes. Brand indigo (`--app-primary`), deliberately NOT the orange accent — the accent means link/selected/engaged, and a submit is none of those. | — |
| `sidebar-item` | **Pick-or-act in the left rail**: the project nav rows + `All` in the sidebar. Full-width, left-aligned, squared; transparent at rest, accent-filled when selected. Lives on the dark sidebar (colors derive from `--app-topbar-fg` + `--app-accent`). | `.active` = selected |

Sanctioned one-offs (composite controls, local by design, NOT recipes to copy):
`button.commit` (Branches commit cell), `button.frow` + `button.close` (commit
panel rows / dismiss), `button.headlink` (Worktrees HEAD hash — belongs with the
commit-hash family, not the worktree/branch one), `button.row-del` (remove-this-row
in the settings list editors — Open-in targets, Label axes, the project Icon card; an
icon-only affordance inside a row, quiet at rest. Defined once in `styles.scss`
because the cards sit one above the other and had drifted into a ✕-in-a-pill and a
🗑 emoji for the same job).

### Settings cards: `.settings-card`, `.set-actions`, `.set-input`, `.ro-value` are GLOBAL

Both settings surfaces — the global page and a project's own settings tab — are
assembled from child components (`<app-settings-axes>`, `<app-project-icon>`,
`<app-settings-addons>`). Angular's emulated encapsulation means a class defined
in `settings.component.scss` is INERT inside those children — which is how the
axes card ended up with a left-aligned action row while every other card's Save
sat right. Any class a child panel wears lives in `styles.scss`, not in the
parent's SCSS. The axis manager is now rendered by both surfaces, which is the
same rule seen from the other side: a card with two parents can only be styled
from the global sheet.

### Selected vs engaged — two looks, two jobs

There are exactly **two** "this one is on" treatments. Pick by the job:

| Job | Looks like | Used by |
|---|---|---|
| **Pick an item** out of a set | solid accent fill, white text | `.btn-pill.active` — project pills, worktree selector, Files branch pills |
| **Engage a mode/option** | white chip, accent text, accent edge | `.btn-toggle.on` **and** every `p-selectbutton` segment — Files rendered/raw/edit, Flat/Grouped, group-by, Type, week-start, the drawer's Mode |

Both engaged forms read the `--app-toggle-selected-*` tokens, so they cannot
drift apart. There used to be three: the toggle used a tint fill while
the segmented control used a white chip, for the identical job.

## Process for a new button

1. Decide which of the three jobs it does (pick-or-act / mode / navigate).
2. Use that `btn-*` class on a native `<button>`. Add an icon and/or label as
   children — `btn-pill` is `inline-flex` with a gap, so `<svg>` + `<span>`
   align automatically.
3. Put only **layout/animation** in the component's SCSS (margins, icon size, a
   spinner). If you're writing `border`/`padding`/`background`/`hover` for a
   button, stop — you're forking a recipe. Extend `styles.scss` instead, and
   update this table.
4. Icons are inline SVG (e.g. the refresh control's feather `rotate-cw`); a
   unicode glyph like `⟳` renders as an illegible blob at control sizes — don't.
5. Reusable controls that carry behavior (busy state, emitted event) become a
   shared component under `frontend/src/app/shared/` (see `refresh-button/`).

## The text + chip recipes — same rule as buttons

Defined once in `styles.scss`. **Component SCSS is layout-only: margins, flex,
padding, borders, and semantic COLOR. It never re-declares `font-size` /
`font-weight` / `text-transform` / `letter-spacing`.** If you are writing those
in a component, you are forking a recipe — extend `styles.scss` instead and add
a row here.

**The ramp is 11 / 12 / 14 / 16 / 20.** Every tier is one visible step
from its neighbours, and no two share a size. Pick the tier by what the text *is*,
then check it outranks anything nested inside it — a widget header must never
render larger than the section heading above it.

| Class | Use for |
|---|---|
| `page-title` | Page header (Settings, drawers). 20/700. |
| `card-title` | Card / panel / page-section title. 16/700. |
| `card-hint` | Hint line under a card title. 12. |
| `widget-title` | Activity/stats widget header (braid, day, punchcard, heatmap, calendar, commit subject). 14/600. |
| `section-label` | Full-width uppercase SECTION divider (task-status buckets, worktree clone groups). 12/600 caps. |
| `eyebrow` | Uppercase micro-label: column heads, field labels, small group heads. 11/600 caps. |
| `hint` · `hint.sm` | Muted caption / note / sub-line. 12 · 11.5. |
| `mono` | Inline monospace id / hash / count label. 11.5. |
| `badge` | The chip's shape: SQUARE, 3px corners, 10.5/600. Modifiers: `.caps` (uppercase status words), `.mono`. Worn only inside the six shared chip components (see "Chips"); colour comes from that component's `--app-*` theme values, never from page CSS. |
| `field` | Label-over-control stack; its control fills the width. |

Justified exceptions (do NOT fold these into a recipe): chart axis micro-labels,
icon/glyph sizes, rendered markdown and code blocks, the brand wordmark, and the
`axis-super` colored band. (Table data-cell density used to be on this list; it
is now a shared rule — see below.)

## The spacing scale — pick a step, never invent a value

`--app-space-1..6` in `styles.scss`. Component SCSS picks a step; it does not
write a raw px value for a gap or a vertical margin.

| Token | Value | Use for |
|---|---|---|
| `--app-space-1` | 2px | Hairline stacks (tight label-over-value pairs). |
| `--app-space-2` | 4px | Inside a control. |
| `--app-space-3` | 8px | Between related inline items — the workhorse. |
| `--app-space-4` | 12px | Between controls in a row / toolbar. |
| `--app-space-5` | 16px | Between blocks in a panel. |
| `--app-space-6` | 24px | Between major sections. |

The portal previously used 14 distinct `gap` values with no rationale.

**The two standing exceptions**, both of which keep raw px and carry a comment
where they sit:
- **Chart cell gaps** in the activity widgets (heatmap / braid / punchcard) and
  the calendar day grid. Those 1–3px values size a data visualisation; snapping
  them to the ramp resizes the chart.
- **`margin-left` / `margin-right` icon nudges** (a 3px shove on a glyph, a 1px
  baseline correction). Optical, local, and not spacing rhythm.

## Table density — one rule, and it lives in the theme's tokens

Every portal table renders at **30px rows · `5px 10px` cells · 12.5px**, defined
once in the shared `p-table` chrome in `styles.scss`. Component SCSS owns column
widths, state colours, and truncation — never height, padding, or font-size.

**Set cell padding through PrimeNG's tokens, not a `padding:` rule.** Every table
is `size="small"`, so the theme emits
`.p-datatable.p-datatable-sm .p-datatable-tbody > tr > td` at specificity (0,3,2).
Anything you write either loses to that or ties and loses on source order, because
the theme stylesheet is injected later. That is exactly how four components ended
up shipping a `padding: 5px 10px` that never reached the screen. Set
`--p-datatable-body-cell-sm-padding` / `--p-datatable-header-cell-sm-padding`
instead and the theme's own rule produces your value.

One exception worth knowing: Overview's `.totals-row` is `<td>` inside `<thead>`,
so it matches neither the shared tbody rule nor the theme's `th` rule. It states
the density itself and must be kept in step by hand.

**Every table needs a `min-width`.** With `table-layout: fixed` and percentage
columns, a table with no floor always computes to exactly its container width, so
the container's `overflow-x` can never fire — columns get crushed to zero instead,
and a `nowrap` header paints on top of its neighbour. Give the table a
`min-width` (the sum of its column minimums) and `min-width` the percentage
columns; the shared chrome supplies the `overflow-x: auto`.

## Colors / tokens

Never hardcode a hex in a component. Everything reads `var(--app-*)` from the
`:root` knobs at the top of `styles.scss` (`--app-accent`, `--app-border`,
`--app-surface`, `--app-fg-dim`, the `--app-accent-tint*` family, …). Changing
the whole portal's accent is a one-line edit there.

## Referring to a thing — use its shared component, never fresh markup

Two kinds of thing are named over and over across the portal, and each has ONE
component that renders it. A tab that needs to show one imports the component; it
does not write its own chip, link, or pill. Both exist for the same reason: the
same thing had drifted into four to six different looks across the tabs, with
different click behaviour in each, and whether it was clickable at all depended
only on which page you were looking at.

| Thing | Component | Contract |
|---|---|---|
| a worktree · a branch | `app-git-ref` (`shared/git-ref/`) | kind icon + name; the name opens that kind's home tab (Worktrees / Branches), except ON that tab, where `linked=false` renders plain text |
| a task | `app-task-chip` (`shared/task-chip/`) | `show="id"`: the `#NN` chip, always a control: opens the task on the Tasks tab **expanded**; filled by the task's status; tooltip carries STATUS · ACTION (where the caller knows it) · TITLE, as terse words, never sentences. `show="status"`: the status WORD, a label, not a control (see "Chips") |

`app-task-chip` resolves the title and status ITSELF, from `TaskIndexService` (one
read of `GET /api/tasks`, cached per project) — a caller passes the id, the
project slug, and at most the extra facts its own context knows (`role` + `how`
for Cleanup's "did this chat work on it, and by which actions", `note` for a
blocking reason). Do not widen another endpoint to carry a task title.

The fill is picked by the server-computed bucket (`data-bucket` on the chip →
the `--app-status-*` tokens in `styles.scss`, each a solid fill paired with its
own text colour): **Idle green · Claimed blue · Waiting yellow ·
Done/Enough/Obsolete light grey**. "Idle" is the displayed word for the `ready`
bucket (open, unclaimed, deps met). The palette is chosen to stay distinct under
red-green colour blindness; recolour only in the tokens. A page must never invent
its own done/not-done colouring — Cleanup did, using the parked amber for "open",
and that page-local dialect is what the shared component replaced.

## Chips — one component per job, and there is no ad-hoc chip

A chip is a small square label. Every chip on every page is one of these six
components; a page that needs a chip imports the one whose JOB it is and never
writes `.badge` markup or chip colours itself. Chips are square (3px) so they
never read as buttons, which are rounded pills. Every colour is an `--app-*`
theme value in `styles.scss :root`, each group checked there for red-green colour
blindness.

| Job — what the chip tells you | Component | Inputs |
|---|---|---|
| A task (its id, or its status word) | `app-task-chip` (`shared/task-chip/`) | `id`, `slug`, `show: 'id' \| 'status'`, `state` (a status with no task: the Tasks tab's grouped headings), `role`, `how`, `note`; emits `open` |
| How a chat touched a task | `app-action-chip` (`shared/action-chip/`) | `kind: 'claimed' \| 'created' \| 'committed' \| 'edited' \| 'looked-up'` (the wire's `mentioned` is accepted and shown as "looked up") |
| A condition word | `app-flag` (`shared/flag/`) | `tone: 'good' \| 'warn' \| 'bad' \| 'review' \| 'neutral' \| 'info' \| 'caution'`, `face: 'word' \| 'mono' \| 'text'`, `wrap`; text via content; tooltip on the host |
| A branch or tag name on a commit | `app-ref-chip` (`shared/ref-chip/`) | `kind: 'main' \| 'local' \| 'remote' \| 'synced' \| 'tag'`; name via content. A release tag is gold on black and tag-shaped (pointed left) |
| A task label | `app-label-chip` (`shared/label-chip/`) | `label`, `color` (the axis colour or null), `removable`; emits `remove` |
| A file's git status letter | `app-git-status` (`shared/git-status/`) | `code` (A, M, D, R…, C, T, `?`) |

**The four status hues — Idle green, Claimed blue, Waiting yellow, Done grey —
mean TASK STATUS and nothing else.** Only `app-task-chip` wears them. An action
chip is neutral grey with the task chip's worked-on ring (the same rule), and
flag tones are pale tints, so no other chip can be mistaken for a status. A
release tag (`app-ref-chip kind="tag"`) is gold on black — black fill, gold text,
a gold edge — not green: when it was green its pointed shape alone did not keep
it apart from an Idle chip on the Graph, and releases are rare and meant to stand
out (owner's pick, 2026-11-05). So no ref or flag wears a status hue.

One sanctioned exception (owner's pick): the `caution` tone is SOLID
construction-tape yellow on black, used only for the Plan card's "worktree
missing" flag, and the card's striped border is drawn in the same two
`--app-tone-caution*` values. It sits close to the Waiting yellow (ΔE 18), so
the word and the black are what tell it apart. Do not reuse it for anything
else.

`app-task-chip show="status"` splits the closed bucket back into its three
statuses — DONE (grey, darker text), ENOUGH (lighter grey), OBSOLETE (no fill, an
outline) — because the word is where that difference is asked for; the `#NN`
chip keeps one done grey.

One sanctioned exception: Cleanup's colour key wears the task chip's own
`.tchip` classes on plain spans, so the key is drawn by the very rules it
explains and cannot drift from the rows below it.

Not chips (so not in the table): buttons, code spans, `kbd` keys, commit-hash
links, the sidebar count bubble (`.si-badge`), and the grey `.chat-flag` notes
("inferred", "archived") beside a chat.
