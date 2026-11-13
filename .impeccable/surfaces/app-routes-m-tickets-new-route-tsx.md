---
version: 1
slug: "app-routes-m-tickets-new-route-tsx"
primary_target: "app/routes/m.tickets.new/route.tsx"
related_targets: ["app/components/rooms/room-functions.tsx", "app/routes/m.rooms.$slug/route.tsx"]
---

# Room functions and phone faults

Mode: Operate. Extend the existing application world, without changing its visual system.

The room page leads with a compact function list: neutral without confirmation, amber for
limited and red for not working. Each row keeps the cause and device evidence beside the
state. Device names wrap as a group and truncate individually; the room remains readable
with twenty devices and a sidebar at 1280 pixels.

From a room, reporting takes four taps: Report fault, function, impact, Save. The phone form
keeps the room first, uses large radio tiles for functions and impact, and puts optional
photo, device and title behind a disclosure. An optional note stays visible. Offline,
the form remains in place and explicitly says it has not saved. No optimistic success.

Check the hall in both languages and densities at 1280 and 1920 pixels. Check capture at
390 pixels, including offline and saving, with a synthetic seventy-room installation and
sixteen devices in the target room. Preserve DESIGN.md and the existing token primitives.
