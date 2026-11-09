---
name: Jiangtang
description: The implemented Fluid Functionalism interface
colors:
  light-floor: "#fafafa"
  light-surface-2: "#fcfcfc"
  light-raised: "#ffffff"
  light-foreground: "#171717"
  light-muted: "#f0f0f0"
  light-muted-foreground: "#616161"
  light-focus-accent: "#4573e6"
  light-input: "#8f8f8f"
  light-checkbox-ring: "#8f8f8f"
  light-destructive: "oklch(0.55 0.22 25)"
  light-status-operational: "oklch(0.52 0.15 150)"
  light-status-fault: "oklch(0.53 0.22 25)"
  light-status-warning: "oklch(0.53 0.12 70)"
  light-status-info: "oklch(0.52 0.16 250)"
  light-status-review: "oklch(0.55 0.16 300)"
  light-status-foreground: "oklch(0.99 0 0)"
  dark-floor: "#171717"
  dark-surface-2: "#1e1e1e"
  dark-surface-3: "#252525"
  dark-surface-4: "#2c2c2c"
  dark-surface-5: "#333333"
  dark-surface-6: "#3a3a3a"
  dark-surface-7: "#414141"
  dark-surface-8: "#484848"
  dark-foreground: "#ededed"
  dark-muted: "#262626"
  dark-muted-foreground: "#a8a8a8"
  dark-focus-accent: "#6b97ff"
  dark-input: "#7a7a7a"
  dark-checkbox-ring: "#7a7a7a"
  dark-destructive: "oklch(0.7 0.19 25)"
  dark-status-operational: "oklch(0.72 0.16 150)"
  dark-status-fault: "oklch(0.68 0.2 25)"
  dark-status-warning: "oklch(0.78 0.14 75)"
  dark-status-info: "oklch(0.7 0.14 250)"
  dark-status-review: "oklch(0.75 0.13 300)"
  dark-status-foreground: "oklch(0.16 0 0)"
typography:
  display:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "28px"
    fontWeight: 700
    lineHeight: "34px"
  title:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: 550
    lineHeight: "22px"
  subtitle:
    fontSize: "14px"
    lineHeight: "20px"
  body:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  caption:
    fontSize: "12px"
    lineHeight: "16px"
  micro:
    fontSize: "11px"
    lineHeight: "14px"
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
spacing:
  control-px: "12px"
  button-px: "16px"
  row-py: "8px"
  gap: "8px"
components:
  button-primary:
    backgroundColor: "var(--primary)"
    textColor: "var(--primary-foreground)"
    rounded: "{rounded.md}"
    height: "var(--control-h)"
    padding: "0 var(--button-px)"
  input:
    backgroundColor: "var(--card)"
    textColor: "var(--foreground)"
    rounded: "{rounded.md}"
    height: "var(--control-h)"
    padding: "0 var(--control-px)"
  card:
    backgroundColor: "var(--card)"
    textColor: "var(--card-foreground)"
    rounded: "{rounded.lg}"
---

# Jiangtang design system

## Overview

**Creative North Star: "Fluid Functionalism"**

This records the existing system, not a redesign. [Engineering conventions](docs/conventions.md)
name the system; [app/app.css](app/app.css) defines its tokens. React 19, Tailwind v4, locally
adapted shadcn/ui primitives and Lucide are the implemented stack (`package.json`, `components.json`).

**Key Characteristics:**

- Neutral surfaces with shadow-defined elevation and translucent interaction overlays.
- One variable sans-serif family, role-based sizes and a shared control-height ladder.
- A functional blue accent for focus and selection, separate from semantic status colors.

The frontmatter captures default-density primitives and explicit theme values. Runtime CSS remains
the implementation authority; theme-aware component entries use its variables rather than freezing
one theme. `.impeccable/design.json` carries extracted shadow, motion and component metadata.

## Colors

### Direction and authority

The Operate palette is calm, achromatic and restrained: neutral surfaces and actions, one blue
functional accent, and color only where it encodes state. This refines Fluid Functionalism rather
than replacing it. The existing surface ladder, foregrounds, accent and four operational hues
are preserved. Review gets a distinct violet so it no longer shares the open-task blue; priority
uses the existing semantic hues rather than another palette.

`app/app.css` owns every application color. `@theme inline` exposes the runtime variables as
Tailwind utilities; `.dark` remaps roles, not components. Existing hex neutrals/accent stay exact
to avoid conversion drift. Semantic chromatic values are independently authored OKLCH, not
exports from a palette service. UI Colors and Realtime Colors may preview values only.

`color-scheme` follows the selected theme so native date-picker icons, select popups and other
browser-drawn controls do not keep light-mode ink on a dark field.

### Neutral ramp and roles

| Token                | Light     | Dark      | Role                                                                     |
| -------------------- | --------- | --------- | ------------------------------------------------------------------------ |
| `--surface-1`        | `#fafafa` | `#171717` | Floor; `--background` aliases it                                         |
| `--surface-2`        | `#fcfcfc` | `#1e1e1e` | Second elevation; dark `--card`                                          |
| `--surface-3`        | `#ffffff` | `#252525` | Light `--card`; `--popover` in both themes                               |
| `--surface-4`        | `#ffffff` | `#2c2c2c` | Higher neutral elevation                                                 |
| `--surface-5`        | `#ffffff` | `#333333` | Higher neutral elevation                                                 |
| `--surface-6`        | `#ffffff` | `#3a3a3a` | Reserved existing elevation step                                         |
| `--surface-7`        | `#ffffff` | `#414141` | Reserved existing elevation step                                         |
| `--surface-8`        | `#ffffff` | `#484848` | Reserved existing elevation step                                         |
| `--foreground`       | `#171717` | `#ededed` | Body, icons and badge labels                                             |
| `--muted`            | `#f0f0f0` | `#262626` | Neutral inset fill                                                       |
| `--muted-foreground` | `#616161` | `#a8a8a8` | Secondary text, placeholders and neutral dots                            |
| `--input`            | `#8f8f8f` | `#7a7a7a` | Identifying control outlines, outlined buttons and project-chip outlines |

`--primary` aliases the foreground value and `--primary-foreground` the opposite floor value:
primary buttons remain neutral, not blue. `--card-foreground`, `--popover-foreground`,
`--secondary-foreground` and `--accent-foreground` alias `--foreground`.

`--overlay` is the black/white RGB channel tuple. Hover/selected overlays use black at 4%/7%
in light mode and white at 6%/10% in dark mode. Tint/tint-hover use black at 6%/9% or white at
10%/14%. `--secondary` aliases `--tint`; shadcn `--accent` aliases `--hover`, **not** the blue.
`--border` is black/white at 9%, for decorative dividers, chart grids and panel separation only.
It must not identify a control: input outlines formerly measured only 1.41:1 light / 1.53:1 dark
against their card fills, so they now use the stronger `--input` values above.

The five `--shadow-1`…`--shadow-5` elevation tokens retain their existing neutral formulas:
light outlines are black 6%, with black drop shadows 4–14%; dark outlines are white 6–8%,
with black drop shadows 30–50%. They separate layers, not controls. Do not globally strengthen
`--border` or shadows to solve an input-boundary problem.

### Accent, actions and controls

| Token                               | Light                 | Dark                 | Role                                                            |
| ----------------------------------- | --------------------- | -------------------- | --------------------------------------------------------------- |
| `--fluid-accent`                    | `#4573e6`             | `#6b97ff`            | Focus, checked switch and selection details; never body text    |
| `--focus-ring`, `--ring`            | Accent                | Accent               | 2px keyboard focus indicator                                    |
| `--checkbox-ring`, `--switch-track` | Input                 | Input                | Unchecked control boundary                                      |
| `--switch-thumb`                    | `--surface-3`         | `--background`       | Thumb distinct from both off and on tracks                      |
| `--destructive`                     | `oklch(0.55 0.22 25)` | `oklch(0.7 0.19 25)` | Destructive action fill, validation text and invalid-field ring |
| `--destructive-foreground`          | `oklch(0.99 0 0)`     | `oklch(0.16 0 0)`    | Label on destructive fill                                       |

`--destructive-hover` mixes the action fill at 88% with black, preserving the existing interaction
in both themes. Text selection mixes the accent at 30% with transparency. `--checkmark` is the
existing SVG tick, with strokes matching each theme's foreground. `--switch-shadow` is the
existing black 20% thumb shadow. Disabled opacity remains 50%; inactive controls are exempt
from AA contrast, not evidence that the enabled token can be weakened.

### Semantic states and priorities

| Semantic fill token | Light OKLCH     | Dark OKLCH      | Solid-label contrast light / dark |
| ------------------- | --------------- | --------------- | --------------------------------- |
| `--status-success`  | `0.52 0.15 150` | `0.72 0.16 150` | 5.01 / 8.37                       |
| `--status-danger`   | `0.53 0.22 25`  | `0.68 0.2 25`   | 5.66 / 6.17                       |
| `--status-warning`  | `0.53 0.12 70`  | `0.78 0.14 75`  | 5.27 / 9.52                       |
| `--status-info`     | `0.52 0.16 250` | `0.7 0.14 250`  | 5.35 / 7.30                       |
| `--status-review`   | `0.55 0.16 300` | `0.75 0.13 300` | 5.08 / 8.37                       |

Each has a `-foreground` pair: `oklch(0.99 0 0)` light and `oklch(0.16 0 0)` dark.
`--status-operational` and `--status-fault` (including their foregrounds) are domain-compatible
aliases for success and danger. Destructive actions keep their existing, slightly different red
steps; neither is another accent.

Actual status badges use **neutral foreground text on a 15% semantic tint**, with a full-strength
colored dot. They do not use colored text on that tint. `app/lib/status.ts` owns the mappings:

| Task state              | Tone                     | Priority            | Text token                            |
| ----------------------- | ------------------------ | ------------------- | ------------------------------------- |
| Backlog                 | Neutral tint / muted dot | Dringend / URGENT   | `--priority-urgent` → danger          |
| Offen / TODO            | Info                     | Hoch / HIGH         | `--priority-high` → warning           |
| In Arbeit / IN_PROGRESS | Warning                  | Mittel / MEDIUM     | `--priority-medium` → foreground      |
| Im Review / IN_REVIEW   | Review                   | Niedrig / LOW       | `--priority-low` → muted foreground   |
| Blockiert / BLOCKED     | Danger                   | Niedrigste / LOWEST | `--priority-low` → muted foreground   |
| Erledigt / DONE         | Success                  | Unset               | No priority color or invented default |
| Abgebrochen / CANCELLED | Neutral tint / muted dot |                     |                                       |

Other domain status mappings remain unchanged. Status labels, priority words, blocked icons and
chart labels/dashes remain non-color cues; color never substitutes for the value's text.
Account and admin confirmation notices also use neutral foreground on their info tint: the
former blue-on-blue text measured only 4.43:1 on a light card.

### Charts, user colors and fixed media surfaces

`--chart-primary` aliases the accent (bars and actual burndown); `--chart-secondary` aliases
muted foreground (axis text, dashed ideal line and dependency arrows). `--chart-complete` is
`oklch(0.62 0 0)` light / `oklch(0.6 0 0)` dark: a quieter neutral than the active blue, still
visible over the tinted project band. Completed marks previously reused low-contrast input gray.
`--chart-critical` aliases danger (overdue marks and today line); `--chart-grid` aliases the
decorative border. The project range band and tooltip cursor use `--tint`; tooltip surfaces use
popover tokens. Grid/band contrast is not a data encoding: labeled axes and visible marks carry
the information.
Tooltip item text explicitly uses popover foreground rather than Recharts' series color: the
light blue series is a valid 4.33:1 mark, but not a 4.5:1 text color.

Event-room timeline bars retain primary at 70% with a full primary border; service windows use
info/warning at 70% or muted foreground at 40%, with full-strength matching borders. Equipment
availability uses `--chart-booked`: info at 75% light / 70% dark over its neutral-tint track and
in its booked legend, on card surfaces only. Its track contrast is 3.17:1 light / 3.04:1 dark.
The former light 70% fill measured only 2.94:1 against the track. These
alpha variants are intentional data fills, not new hues.

Project colors are user-entered hex data, not semantic system colors: preserve stored values
and show the project name beside them. An input-token outline keeps even white/black chips
visible in either theme; arbitrary user colors are not certified as meaningful indicators.
The project-form hex placeholder is an example, not a palette definition.

`--scrim` centralizes the existing black 30% light / 50% dark modal veil. `--qr-paper` stays white
in both themes for black QR modules, including 2FA; `--camera-preview` stays black behind video.
Root `theme-color` metadata uses literal floor colors; the static PWA manifest uses the light
`#fafafa` launch background/chrome, while iOS startup images follow the OS light/dark floor.
Browser chrome cannot resolve CSS variables. Those literals,
the raster app icons/screenshots and the SVG checkmark are intentional media/API
exceptions, not permission to add per-component hex colors. Synthetic test/seed color data is
not a UI token.

### Measured contrast contract

Ratios below are WCAG relative-luminance ratios from browser-resolved sRGB colors (rounded to
two decimals). Text requires 4.5:1; identifying controls, icons, dots and chart marks require 3:1.
The contract covers floor, card and popover, including badge alpha compositing. It does not
certify input outlines on `--surface-5`, `--muted`, selected or tint-hover fills. The command
palette and mobile More menu use higher surfaces, but do not currently place input-token
outlines on those fills. Measure new control placements rather than extending this guarantee.

| Pair                                    | Light       | Dark        |
| --------------------------------------- | ----------- | ----------- |
| Body / card                             | 17.93       | 14.24       |
| Secondary or placeholder / card         | 6.19        | 7.01        |
| Primary label / fill                    | 17.18       | 15.31       |
| Input or checkbox outline / card        | 3.23        | 3.88        |
| Input outline / popover                 | 3.23        | 3.57        |
| Focus ring or primary chart mark / card | 4.33        | 5.95        |
| Switch thumb / off track                | 3.23        | 4.18        |
| Switch thumb / on track                 | 4.33        | 6.40        |
| Destructive label / fill (hover)        | 5.30 (6.91) | 6.70 (4.85) |
| Success dot / badge tint on card        | 4.17        | 5.53        |
| Danger dot / badge tint on card         | 4.42        | 4.40        |
| Warning dot / badge tint on card        | 4.42        | 6.15        |
| Info dot / badge tint on card           | 4.43        | 4.98        |
| Review dot / badge tint on card         | 4.28        | 5.51        |

Badge-label contrast on card is at least 13.63 light / 10.72 dark. High/urgent priority text on
card measures 5.41/5.81 light and 8.16/5.29 dark; medium/low use the normal text roles.
The light input/focus contrasts against the floor are 3.10/4.15; the dark input/focus contrasts
against popover are 3.57/5.47. The functional blue is not approved for ordinary light-theme text.

`e2e/color-contrast.spec.ts` asserts the role pairs in both themes on desktop and `/m`, including
solid labels, tinted badge dots/labels, primary/destructive fills, switch states and chart marks.
Run it with the normal axe sweep (`pnpm test:e2e e2e/a11y.spec.ts e2e/color-contrast.spec.ts`)
and inspect the `@screens` captures. Axe alone does not measure every non-text boundary.

## Typography

Inter Variable is imported from Fontsource with weight and optical-size axes. Normal text uses
weight 400 and optical size 14; headings/selected text use 550 and optical size 18; the page title
uses 700 and optical size 25. `font-medium` and `font-semibold` both resolve to 550.

| Role     | Tailwind alias        | Comfortable size / line height | Compact size / line height |
| -------- | --------------------- | ------------------------------ | -------------------------- |
| Display  | `text-xl`, `text-2xl` | 28 / 34px                      | 24 / 30px                  |
| Title    | `text-lg`             | 16 / 22px                      | 15 / 20px                  |
| Subtitle | `text-base`           | 14 / 20px                      | 13 / 18px                  |
| Body     | `text-sm`             | 13 / 20px                      | 12 / 18px                  |
| Caption  | `text-xs`             | 12 / 16px                      | 11 / 14px                  |
| Micro    | `type-micro`          | 11 / 14px                      | 10 / 12px                  |

Named `type-*` utilities expose the same roles. `nums` enables tabular numerals for numbers and
times. Identifiers use the system monospace stack in `--font-mono`; prose does not. Conventions
exclude uppercase labels, tracking and arbitrary font sizes. Coarse-pointer inputs, textareas and
selects step to 16px to avoid iOS focus zoom without changing control height.

## Layout

The desktop shell (`app/components/layout/app-shell.tsx`) supplies sidebar navigation, a header
and scrolling content. The mobile shell (`app/components/mobile/mobile-shell.tsx`) is a separate
route surface with bottom navigation, safe-area padding and comfortable density pinned locally.
It is not a scaled desktop table. Feature routes own their grids and wrapping; there is no single
global content-column template or custom Tailwind breakpoint scale.

| Density token  | Comfortable | Compact |
| -------------- | ----------- | ------- |
| `--control-h`  | 36px        | 28px    |
| `--control-px` | 12px        | 10px    |
| `--button-px`  | 16px        | 12px    |
| `--row-py`     | 8px         | 5px     |
| `--gap`        | 8px         | 4px     |
| `--icon`       | 16px        | 14px    |

Density is selected by `data-density`; the desktop preference is cookie-backed. Controls use
`h-control`, `px-control`, `px-button`, `py-row`, `gap-ladder` and `size-icon` instead of independent
per-screen scales. This documents current dimensions, not a claim that all touch targets meet 44px.

## Elevation & Depth

Elevation comes from shadows rather than an added panel border: panels use `shadow-surface-2`,
popups step 3 and, per conventions, dialogs step 5. The command palette and mobile sheet use that
top step; there is no shared dialog primitive. There are five shadow tokens in each theme, combining a thin
outline with increasing drop shadows; the full formulas remain in `app/app.css` and the sidecar.
The eight background levels and five shadow levels are different scales.

Motion tiers in `app/lib/springs.ts` are fast (80ms, 60ms exit), moderate (160ms, 120ms exit) and
slow (240ms, 160ms exit). Transform/opacity motion uses these tiers; color/shadow/weight changes
use short CSS transitions. Button press fill collapses its 1px spread in 80ms and releases over
180ms. Root `MotionConfig` honors reduced motion (`app/root.tsx`); this is not proof that every
independent CSS animation has a reduced-motion alternative.

## Shapes

Controls use 8px corners (`rounded-md`), panels/popups 12px (`rounded-lg`) and dialogs 16px
(`rounded-xl`). Insets preserve concentric corners: 8px inside a 12px container inset by 4px.
Smaller 4px and 6px steps exist for keycaps and badges. Do not flatten the whole scale to one radius.

## Components

- **Buttons:** primary, secondary, tertiary, ghost, destructive and link variants. The aliases
  `default`/`outline` and `sm`/`lg` preserve shadcn call-site compatibility. Default size follows
  density; compact/icon-compact are 28px. Labels remain semibold except the normal-weight link variant; SVG strokes grow from 1.5 to 2
  on hover. Disabled controls have no pointer events and 50% opacity.
- **Fields:** `Input`, `Textarea` and `Select` share a card fill, inset input ring, 8px corners,
  muted placeholder and an `aria-invalid` destructive ring. Global `:focus-visible` uses a 2px
  focus ring, normally offset by 2px; fields remove that offset.
- **Cards:** semantic sections with card fill, a step-2 shadow and 12px corners. Headers use 16px
  horizontal and 12px vertical padding; title is a subtitle-role `h2`.
- **Badges:** neutral tint and foreground; status badges use the domain mapping. Badges are 24px
  high (20px compact) with 6px corners, not controls.
- **Navigation:** desktop groups links as Work, Rooms & equipment, Operations and Data & admin
  (`work`, `places`, `service`, `admin` in `app/components/layout/nav.ts`).
  Hover and selected overlays share the global tokens; Lucide supplies navigation icons. The
  mobile shell uses a distinct bottom navigation and overflow menu.
- **States:** `app/components/states/empty-state.tsx` is the shared empty-state pattern. Existing routes
  are not yet consistent about using it. Route navigation has a progress indicator; this baseline
  does not claim skeleton components exist.

Theme persistence is `light`, `dark` or `system` in the `theme` cookie (`app/lib/theme.server.ts`).
The `.dark` class on `html` switches variables. A pre-paint script in `app/root.tsx` resolves system
preference; class-based Tailwind dark variants follow the same class.

## Do's and Don'ts

### Do

- Do use the shared tokens, primitives and status mapping before adding a local variant.
- Do preserve both themes and density steps when adjusting an operational screen.
- Do translate interface copy through the German and English catalogs; leave user data unchanged.
- Do keep operational evidence and familiar controls ahead of decoration.

### Don't

- Don't use the blue functional accent as body text or replace neutral primary buttons with it.
- Don't introduce arbitrary type scales, tracked uppercase labels or independent status colors.
- Don't add marketing decoration to the app: Magic UI, React Bits, Lottie, unDraw illustrations
  and Haikei backgrounds are excluded from operational screens.
- Don't copy Realtime Colors exports; use it only to preview independently chosen colors.

The scope and provenance of resource decisions are recorded in
[Design resource decisions](docs/DESIGN-DECISIONS.md). The parked `/welcome` page is not authority
for adding marketing effects to the application.
