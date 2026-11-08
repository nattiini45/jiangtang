---
version: 1
slug: "app-routes-desktop-route-tsx"
primary_target: "app/routes/_desktop/route.tsx"
related_targets: ["app/routes/m/route.tsx", "app/components", "app/routes"]
---

# Application surface

## Scope and mode

Mode: Operate. Applies to the signed-in desktop route tree and the separate `/m` mobile PWA.
The job is to find, capture and update operational work, rooms, equipment and bookings. Preserve
the existing Fluid Functionalism implementation; this is a documentation baseline, not a new
surface concept or a redesign.

## Constraints

Use PRODUCT.md for product truth and DESIGN.md for the incumbent visual system. Keep both
languages, light/dark themes, density behavior and the mobile shell. German is the team's intended
installation language, selected through DEFAULT_LOCALE=de; do not change the upstream fallback.
Make long operational titles and empty/error/pending states understandable without decorative
assets. Do not borrow the parked `/welcome` page's marketing treatment.

## Current review scope

Dashboard, tasks, board, tickets, rooms, events/calendar, inventory and mobile capture/lists.
Findings belong to the baseline audit report; no UI change is approved by this brief.
