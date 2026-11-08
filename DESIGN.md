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
  light-input: "#d9d9d9"
  light-checkbox-ring: "#8f8f8f"
  light-destructive: "oklch(0.55 0.22 25)"
  light-status-operational: "oklch(0.52 0.15 150)"
  light-status-fault: "oklch(0.53 0.22 25)"
  light-status-warning: "oklch(0.53 0.12 70)"
  light-status-info: "oklch(0.52 0.16 250)"
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
  dark-input: "#3d3d3d"
  dark-checkbox-ring: "#7a7a7a"
  dark-destructive: "oklch(0.7 0.19 25)"
  dark-status-operational: "oklch(0.72 0.16 150)"
  dark-status-fault: "oklch(0.68 0.2 25)"
  dark-status-warning: "oklch(0.78 0.14 75)"
  dark-status-info: "oklch(0.7 0.14 250)"
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

The light surface ladder is `--surface-1` through `--surface-8`: the floor, second step and white
from step 3 onward. Dark mode uses eight progressively lighter neutral steps. `--background`
uses step 1. Cards use step 3 in light mode and step 2 in dark mode; popovers use step 3.

Text uses `--foreground` and `--muted-foreground`, with `--destructive` for errors. Primary buttons
are neutral foreground-colored fills with inverse text, not blue buttons. `--fluid-accent` drives
`--focus-ring`, switch tracks and selection details; conventions prohibit accent-colored text.
`--accent` is a hover-overlay alias, not the blue accent.

Hover/selected overlays are black at 4%/7% in light mode and white at 6%/10% in dark mode. Tint and
tint-hover are black at 6%/9% or white at 10%/14%. Borders are black/white at 9%. These runtime
formulas are in `app/app.css`; do not replace them with opaque grays.

Operational, fault, warning and info colors have paired foregrounds for each theme.
`app/lib/status.ts` maps domain statuses to those tokens. Preserve these measured status colors
rather than inventing a new palette for each feature.

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
