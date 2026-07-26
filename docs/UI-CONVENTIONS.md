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
  `p-select`, `p-tree`, tabs, drawers, `p-tag`, `p-skeleton`, tooltips.
- **Native `<button>` + a shared recipe class** — every clickable control:
  switchers, links, toggles, actions. Never a styled `p-button`.

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
commit-hash family, not the worktree/branch one).

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
| `badge` | Small status/label pill. 10.5/600. Modifiers: `.caps` (uppercase status words), `.mono`. Also matches `.p-tag.badge` so a PrimeNG tag with `styleClass="badge"` outranks the Aura defaults without `::ng-deep`. **Colour is semantic and stays in the component; the shape never does.** |
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
