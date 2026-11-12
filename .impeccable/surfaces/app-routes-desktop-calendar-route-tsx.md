---
version: 1
slug: "app-routes-desktop-calendar-route-tsx"
primary_target: "app/routes/_desktop.calendar/route.tsx"
related_targets: ["app/routes/m.calendar/route.tsx", "app/components/events/booking-calendar.tsx", "app/routes/_desktop.events._index/route.tsx", "app/routes/m.events._index/route.tsx"]
---

# Workspace calendar and event lists

Mode: Operate. The calendar is a top-level item directly after Overview, not a view inside
Events. Keep the incumbent Inter roles, neutral surfaces, shared status dots, density-aware
controls and both themes. This is a specified extension of the established operational surface,
not a new visual world; no concept round or token change is needed.

THESIS: Plan the team's week in one place, alongside the dates it keeps on rooms and equipment.

STORY: Choose a period, see commitments and dated work together, open a record, or choose an
empty slot to create a conflict-checked event. Events remains a plain list, upcoming first,
then past, with title, time, named rooms, status and a link to the event's calendar day.

FIRST VIEWPORT: Calendar heading and new-event action, month/week/day/rooms switches, period
navigation, date/status/resource filters and one Show control. Text identifies each kind; colour
is supplementary. The Show control groups events, setup and teardown, tasks, projects, room and
equipment dates, and faults. All start enabled except faults. No source/layer/field jargon.

FORM: A Monday-first month grid with three entries and an overflow count that opens the day;
week/day grids with a whole-day band above hours; a free-space-first rooms timeline that never
hides real occupancy; a date-led mobile agenda at `/m/calendar`. Choice and filters persist in
the address. `/m/events` is a separate event list. One source registry owns the kinds, not UI
switch statements. Log timestamps are not calendar content.

MAXIMUM: Expect tens of entries per day and about seventy rooms. Month cells remain bounded;
the whole-day band scrolls when full. The day and mobile agenda retain every matching entry.
At 1280px with the sidebar open, controls wrap and the week fits without a page-level horizontal
scroll. At 1920px, the event title column grows. Long names wrap or ellipsize with full titles.

PROOF: Berlin DST days retain 23/25 hours. Occupancy and booking invariants stay intact. Verify
range sources, active/applicable team dates, address compatibility, pending navigation, whole-day
bands, overflow drilling, event lists and the mobile agenda. Inspect 1280/1920px, both locales,
themes and densities with a day containing at least ten entries. Public-safe synthetic captures
and an independent diff review finish the change.
