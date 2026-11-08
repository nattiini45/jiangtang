---
version: 1
slug: "app-routes-desktop-events-index-route-tsx"
primary_target: "app/routes/_desktop.events._index/route.tsx"
related_targets: ["app/routes/m.events._index/route.tsx","app/components/events/booking-calendar.tsx","app/routes/_desktop.events.new/route.tsx","app/routes/m.events.new/route.tsx"]
---

# Events calendar

Mode: Operate. Extend the signed-in Events surface and mobile agenda inside the existing Fluid Functionalism system. The Captain confirmed week-first navigation, a free-space-first rooms view, an optional task strip and the existing booking forms. No new visual world or system-token change is approved.

## Direction contract

THESIS: Show operational commitments and bookable gaps together; do not duplicate a generic personal calendar without its rooms and equipment.

OWN-WORLD: Keep the incumbent Inter roles, neutral surfaces, shared status dots, density-aware controls and light/dark tokens. Calendar rules measure time, not decoration.

STORY: Find the selected period, identify a commitment or a free room-hour, then open the event or its conflict-checked creation form.

FIRST VIEWPORT: The existing Events heading and new-event action lead into month/week/day/rooms/list switches, period navigation and resource filters. One calendar surface shows the working day from morning; the mobile surface is a date-led agenda at 390px.

FORM: Precisely scoped extension of the application surface, using the approved Monday-first week grid, month grid and horizontal room rows. A seed reference does not apply: this precisely specified local extension required no concept roll, so none was run.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints and proof

Berlin civil-day boundaries must retain the 23-hour March and 25-hour October days. Slot links carry exact instants when needed. Active room occupancy must never disappear under event filters. All routes authenticate independently; loading/error/empty states, keyboard navigation, both locales and themes, range-query tests and screenshot cases are part of delivery. Keep the list and existing booking invariants; no drag-to-reschedule, recurrence or two-way sync.
