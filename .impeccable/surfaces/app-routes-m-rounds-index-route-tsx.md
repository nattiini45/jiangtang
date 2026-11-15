---
version: 1
slug: "app-routes-m-rounds-index-route-tsx"
primary_target: "app/routes/m.rounds._index/route.tsx"
related_targets: ["app/components/rooms/round-pages.tsx", "app/components/rooms/room-check.tsx", "app/components/rooms/function-state-dialog.tsx", "app/routes/_desktop.rounds.$id/route.tsx"]
---

# Rounds and confirmation

Mode: Operate. Preserve the application palette, density ladder and type hierarchy.
Start from all rooms with expected functions; an explicit room selection defines the round.
Building filtering selects the visible scope. Lists support seventy rooms, grouped by building
and ordered by room number. Room names take the extra width at 1920; at 1280 with the sidebar
open they truncate, never push progress or actions offscreen. Both languages and densities apply.

On the phone, each function shows its devices and three large actions. A tap saves a check;
notes and photos stay behind a disclosure. Known fixes appear before the actions. Passing an
unhealthy function exposes explicit choices to resolve faults and restore devices; evidence
is never silently dismissed. An offline tap never claims success. Check at 390 pixels with
sixteen devices and five functions in the target room. Green means a recent human confirmation
or an explicitly named state set by hand. An expired confirmation becomes neutral.

Use UI SDK for new controls, keeping the existing control styles and photo capture.
The stock UI SDK dialog handles the admin's state, reason and optional Berlin end date.
Expected functions remain visible without a carrier but have no result controls. Gaps require
no check, and installed extra functions stay checkable. If no functions can be checked, a
separate finish action completes that room without claiming any function works.
