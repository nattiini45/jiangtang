# What works in a room is derived per function, and functions are data

Status: accepted

A team that looks after many rooms needs to know, for each room, what works and what doesn't, with
the device behind it, and to see across all rooms what doesn't work. Faults arrive in several ways
(a call, an e-mail, a person in the room, a monitoring system), and rooms are checked on rounds.
Rooms record a typed status and a free-text note of known issues. The question was where a room's
working state comes from, how it stays honest when sources disagree, and how to describe what a
room should do without building one kind of room into the code.

## Decision

- **Functions are data.** A function (picture, sound and microphones, control, ...) is a row with
  a library key, named in both languages by the shipped library like a library property, and
  mapped to the device kinds that serve it. Each mapping is a carrier (the function needs one
  working unit) or a path device (the signal passes through it). Function groups are not used
  for this: they are cut by device, and one function crosses several of them. A team renames,
  hides, maps and adds functions; the library adds a function once a carrier kind is installed
  or a shipped room type expects it. Expectations stay complete when a kind is not installed.
- **Room types are data.** A room type lists the functions its rooms should have. A room adds or
  drops a function against its type with a note. A room without a type expects what its devices
  serve.
- **The state is derived, never stored.** One server function computes each room's function
  states from its devices' status, its open faults, the newest check and any state set by hand.
  Hall pages, lists, rounds and the MCP tools all read it.
- **Evidence, then confirmation.** Open faults and faulty devices decide between doesn't work,
  limited and ok. Ok counts as works only when a check newer than all evidence and inside the
  confirmation window confirms it; otherwise it shows as no known fault. A missing function is a
  gap, not a fault.
- **The newest human statement wins.** A state set by hand holds until newer evidence arrives or
  its end date passes. Conflicts are settled when they arise: a passing check on a function with
  an open fault asks whether the fault is solved.
- **Machines report, people confirm.** Monitoring opens and closes faults; it never confirms that a
  function works.
- **A fault is a ticket.** It gains a function, an impact, a channel and a flag that keeps its
  resolution as a known fix for the room. Known fixes are the room's resolved faults and repair
  records with that flag.

## Consequences

- No stored state can drift from its evidence, and there is no cache to rebuild; the function
  reads a few queries and computes in memory, which holds for rooms in the hundreds.
- A room never shows green without a recent check, so a new installation starts neutral and a
  round turns rooms green.
- Path devices can only make a function limited until signal paths are read from port
  connections.
- The typed room status and the known-issues note stay; the note moves into known fixes by hand,
  and both can be retired in a later release.
- Room types ship with all their expected functions. Missing carrier kinds do not hide those
  expectations, and assigning a type never installs device kinds or creates devices.
- The domain gives new incidents an impact (limited when unspecified) and rejects impact on
  other ticket types. The database restricts impact values but allows it to be empty on any
  type or retained when an older release changes the type. This keeps rollback writes working
  without silently clearing evidence in a trigger.
