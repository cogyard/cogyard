# UI conventions — cogyard portal

The rules a session must follow before adding or restyling any control. The
source of truth for the recipes is `frontend/src/styles.scss` (the `Buttons`
block); this doc explains when to use which and why the system exists.

## PrimeNG vs native — the dividing line

Task 021 converted every custom-looking control from a styled `p-button` to a
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
| `sidebar-item` | **Pick-or-act in the left rail**: the project nav rows + `All` in the sidebar. Full-width, left-aligned, squared; transparent at rest, accent-filled when selected. Lives on the dark sidebar (colors derive from `--app-topbar-fg` + `--app-accent`). | `.active` = selected |

Sanctioned one-offs (composite controls, local by design, NOT recipes to copy):
`button.commit` (Branches commit cell), `button.frow` + `button.close` (commit
panel rows / dismiss).

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

## Colors / tokens

Never hardcode a hex in a component. Everything reads `var(--app-*)` from the
`:root` knobs at the top of `styles.scss` (`--app-accent`, `--app-border`,
`--app-surface`, `--app-fg-dim`, the `--app-accent-tint*` family, …). Changing
the whole portal's accent is a one-line edit there.
