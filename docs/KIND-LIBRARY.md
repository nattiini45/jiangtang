# Device-kind library

The repository ships a bilingual catalog of 106 device kinds in 20 function groups for
universities and colleges, event and congress halls, councils, theatres and trade fairs.
The data lives in `app/lib/equipment-kinds/library.json`; stable keys identify entries even
after an installation renames them. Institution types narrow the list, and the core, common
and special tiers help an administrator choose. They are suggestions, not requirements.

Device kinds are normally installed explicitly. The model catalog also installs the lamp
and air-filter kinds needed by a linked projector, with their properties. In **Administration → Structure →
Device kinds → Add from the library**, choose an institution type, review the checked core
kinds and select the kinds your team needs. Common and special entries start unchecked.
Existing entries show their installed name; archived entries and occupied names cannot be
selected. The dialog shows the remaining capacity under the 80-active-kind limit.

Installation creates only the selected kinds and their missing function groups, atomically,
in library order. New names use the installation's `DEFAULT_LOCALE`, not the visitor's
language. Existing names and groups are left alone. A conflict installs nothing. Restore an
archived group before installing more kinds into it. Room types, room properties and
catalog-model categories are not part of this library.

An admin's read-write MCP token can use `list_kind_library({ institutionType? })` and
`install_library_kinds({ keys })`; see [MCP.md](MCP.md). Kinds, groups and every device or model
moved during archiving have audit records. Operators need no migration or restart.

## Properties and model values

Installed library kinds receive their properties automatically on startup and when a
kind is installed. The versioned file contains shared and kind-local
properties, bilingual labels, units, choices, levels, weights, conditions and source IDs.
`library-sources.json` holds the cited sources. Regenerate both with
`node scripts/library/export.mjs /path/to/research.json`; the research input is not shipped.
Reading definitions use `CustomField.store = READING`; their values are append-only rows,
never ordinary property values. General relations are not materialized as properties. Part
compatibility has its own relation rows, described below. Ranges store `{ min, max }` in the property's
unit; either bound may be null, but a filled minimum cannot exceed the maximum. Both empty
bounds clear the value on a form; structured writers clear it with null. Pages format ranges
in the reader's language. Catalog range values remain out of scope.

Startup also copies the former microphone kind, frequency, band, channel, lamp-change date,
colour and service-tag columns into applicable properties where no value exists. It keeps
each device's kind, and records the copy in the same audited transaction. Forms and MCP write
both representations; the frequency board prefers properties. Omitted migrated columns stay
unchanged, and clearing a property clears its former column. Lamp type and express service
code remain fixed columns. No schema migration or administrator step is required.
Legacy text that exceeds the property limit stays intact in its column and is reported by
device ID and property key in the startup log; other valid properties still copy. An edit made
by an older release during rollback does not replace an already-filled property on roll-forward.

The generic microphone also receives frequency, band, channel and colour properties so existing
units need not move to transmitter kinds. The generic control processor keeps its former colour
as a property. These compatibility links use the researched shared definitions. Ratio units are
displayed as `: 1`. Frequencies accept at most three decimal places, matching the legacy column;
new structured writes reject extra precision rather than silently rounding it. The other
microphone choices have no old enum equivalent, so their legacy `micKind` column is null.

A MODEL property is stored once in `EquipmentModel.customValues`. Every device reads the
model's value, falling back to its own value when the model has none. A device with a model
edits these properties on that model only, even when its value is empty. A device without a
model edits them itself. DEVICE properties always belong to the individual device.

`getFieldSchema` resolves row identity, type, level and option IDs against the shipped file
for the viewer's language. Unknown property keys behave as own properties; unsupported types
are skipped. The Fields tab lists library properties read-only, separate from own properties.
They do not count toward own-property limits. Library definitions, options and kind links
cannot be edited or deleted; archive hides a property without losing its values.

The reconcile runs in one audited transaction under the definition advisory lock. It only
adds rows, options and kind links, and refreshes stored names on version upgrades unless a
property has been renamed. It never changes a materialized property's type or level and
never deletes one. A matching own property on the same kind is adopted only when its type
and all its option labels match, and its unit is absent on both sides or matches the library
unit key or either translated label (ignoring case and surrounding spaces). An empty own
unit does not match a library unit. Every kind linked to the own property must also be a kind
the reconcile links the library property to in this installation; an own property with no
kind links applies to all devices and is never adopted. Its ID, position and values survive. Other collisions stay
as separate rows. New own properties and renames cannot take a library name in either language.
`LibraryState` records the applied version. A startup failure rolls back, logs an error and
leaves the application running; the next startup retries. Changes are emitted after commit.

## Model catalog

The catalog ships facts, not manufacturer descriptions or images. Each manufacturer's versioned
file lives under `app/lib/catalog/`; it is loaded lazily on the server. Records contain stable
keys, manufacturer and model names, aliases, part numbers, a library kind key, product and manual
addresses, values by library key, ports, and source addresses with retrieval dates. A manufacturer's
entries are removed if it objects to their inclusion.

Generate Epson's 140 projector records with `node scripts/catalog/epson.mjs /path/to/inputs`.
The input folder contains `epson-models.json`, `epson-specs.json`, `epson-checked.json` (the checked
pilot ports), `epson-ports.json`, and `epson-control.json`. Research files are not shipped. Only
verified model facts are mapped; data-sheet rows supply normal-mode or unqualified single-value
white and colour light output.
Brightness keeps its measurement standard; lens shift uses the positive limit of the standard
lens configuration. Ranges, parts and unsupported properties stay out. Port rows keep the source's
named connector groups, not an inferred number of individual sockets. An assumed connector is
included only for RS-232C, Ethernet/LAN or HDBaseT; the converter reports how many other rows it
omitted. Regenerate the property library from version 3 before converting these records; only
explicit `help_de` and `help_en` become help text, never research job descriptions.

After the property reconcile, startup links an unlinked installation model only when manufacturer,
name and kind match exactly one catalog record, ignoring case and surrounding spaces. A link
fills missing model values, the manual address and an empty port list; devices without ports
receive the model's ports through the same copy function used when adding a device. The device
form combines installation models with catalog search results, returning at most 30 catalog
options per search and never offering an existing model twice. Picking a catalog option creates
or reuses the installation model in the device's audited save transaction.

A link stores its version and a snapshot of what it supplied, including values by library key.
On a higher version, a value, name, manual address or complete model port list is corrected only
while it still equals that snapshot. House edits stay. An administrator can unlink on the model
page or through MCP: supplied values, manual and model ports still matching the snapshot are
removed, but house edits and copied device ports stay. The model's required name stays. An exact
match can be linked again by a subsequent startup. The model page cites the manufacturer,
product page and retrieval date without visually separating catalog values from house values.
Startup errors roll back and are logged without preventing application startup. Audit rows stay
append-only; the activity feed folds each system startup step into a readable Jiangtang entry,
including property rows written by earlier releases.

## Parts and stock

The library includes the 40 researched accessory kinds and the lamp, filter, lens and
battery kinds, with their properties. A part model uses the ordinary model page. Its
compatibility rows point from the device model to the part model; the page shows those
models, other compatible catalog models and every matching device in the workspace.
Models with devices appear first. A projector's page inherits these
rows from its selected model. A compatibility link does not claim that a part is fitted.

`scripts/catalog/parts.mjs` exports only verified lamp and air-filter part numbers from
the researched model records. The 32 part models and 159 compatibility rows ship in
`app/lib/catalog/parts.json`, each fit with its manufacturer's source address. Unknown
quantities stay unknown. A laser projector has no invented replacement lamp: its data
sheet shows the light source, while its parts list shows the verified filter.
Picking or reconciling a catalog projector installs its part models and fits in the same
audited transaction. Repeating the reconcile writes nothing. Unlinking removes the
catalog-supplied fits but retains stock and house-entered fits. Startup failure rolls back
and never prevents the app from starting. An unusable part (for example, an archived kind
or an ambiguous model identity) rolls back to its own savepoint, is logged and retries on
the next reconcile; the host model and other parts still land.

Stock remains `InventoryItem`, linked through the nullable `modelId`. Existing stock is
assigned explicitly on its stock page, never guessed from a name or SKU. New stock can
be received on the part's page. Only stock not linked to a tracked device, with a positive quantity and an
available or unrecorded status counts; loaned, requested and reserved items do not.
Taking one from a chosen stock row decrements it atomically and records the part number,
device and before/after counts in both stock and device histories. Concurrent attempts
cannot take the same last unit. Taking a part alone does not claim it was installed. Use
**Replace part** to record an installation and reset its matching counter atomically with
the withdrawal. Orders and prices are not part of this workflow.

## Readings and service limits

The library supplies 36 reading definitions for its installed kinds: hours, battery levels,
versions, reported states and other observations. Enter a value and its observation time on
the device's readings page, on the phone, or inline during a round. An observation records
its source, person and time separately from its insertion time. Corrections append another
row. The latest observation wins; ties use insertion time and then ID. History shows the
latest 100 entries. Retiring a device keeps its reading history.

`EquipmentReading` and its same-transaction audit are append-only. PostgreSQL rejects updates
and deletes with an ENABLE ALWAYS trigger; referenced devices, definitions, people and part
models cannot be deleted out from underneath a reading. Typed entries cannot claim network
provenance. Network polling is not implemented. A round can still accept optional readings
after its function checks have completed; this does not reopen or change the checks.

`reading-rules.json` connects counters to applicable model lives and part intervals. Projector
light-source hours use the appropriate rated life, not the eco-mode figure. Filter models can
record a replacement interval in operating hours; it is empty until supplied by the team.
Only a known fitted part, or an unambiguous compatible part, contributes its interval. No
reading, interval, battery-health threshold or projected usage is invented. The smallest
applicable recorded limit wins. A stock installation appends zero only for its matching
counter and records the part model; a filter change never resets light-source hours.

The device, home and full due list share the same projection. `READING_DUE_MARGIN_PERCENT`
sets the remaining-life margin for **Due soon** (0–100, default 10). At the limit the device
is **Due**. Readings older than 365 days explicitly lower confidence; the due list puts
stale readings first, then the most overdue ratio, then the oldest observation. It does not
create recurring inspection plans or predict missing readings.
