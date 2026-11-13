---
version: 1
slug: "app-routes-desktop-functions-index-route-tsx"
primary_target: "app/routes/_desktop.functions._index/route.tsx"
related_targets: ["app/routes/m.functions._index/route.tsx", "app/components/rooms/function-list.tsx"]
---

# Functions with known faults

Mode: Operate. Extend the existing Fluid Functionalism application, not its visual identity.

The technician scans thirty affected room/function pairs, finds a room or function, and opens
its evidence. Room identity retains about thirty characters before the evidence column
takes the remaining width. Function, state and age stay aligned at 1280 pixels with the sidebar open. Location is in the
room's full-name tooltip and in the campus/building filters, rather than two extra columns.
Oldest evidence comes first; the age header reverses it. Unknown starts retain their explicit
date fallback. Open faults and faulty devices share the evidence column, with full text in
its tooltip and links to the room's function block.
The compact known-fixes count opens the same block without taking width from the room name.

The phone uses the same query in a single-column list, with filters and the sort picker
behind a disclosure. Room number and building remain visible to distinguish similar names.
Empty results say no fault is known, never that the room works. Keep neutral unconfirmed
states out of this list. Verify both languages and densities at 1280 and 1920, plus 390 on
the phone. Preserve DESIGN.md and the incumbent primitives.
