---
version: 1
slug: "app-routes-desktop-rooms-index-route-tsx"
primary_target: "app/routes/_desktop.rooms._index/route.tsx"
related_targets: ["app/routes/_desktop.inventory._index/route.tsx", "app/components/data-grid"]
---

# Room and device lists

Mode: Operate. A technician compares the team's properties across rooms and devices.
An administrator chooses one ordered set of columns for the installation.

## Direction contract

THESIS: Put column selection beside the list it changes, without exposing configuration
to members or adding another settings screen.

OWN-WORLD: Inherit Fluid Functionalism, neutral surfaces, native inputs, shared buttons,
Inter typography and density tokens. No new visual identity or assets.

STORY: Choose columns, read typed values, sort them, then narrow rooms by device kind.

FIRST VIEWPORT: Preserve the heading and creation action. The secondary Columns button
opens an anchored panel of checked columns followed by available columns. Each property
shows its type and device kinds. Up/down controls make ordering explicit. Filters stay
above one framed grid; only that frame scrolls sideways, with the name pinned.

FORM: Precisely specified local extension, code-led; no concept roll. The brief fixes
the structure and constraints. Retain long-name ellipses and let the name grow at 1920 px.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification

Check both languages and densities at 1280 px with the sidebar open and at 1920 px.
Exercise twelve columns and 300 rows, keyboard ordering, filtering, empty cells, and
member access. The existing DESIGN.md remains authoritative and unchanged.
