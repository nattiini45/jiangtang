# Device-kind library

The repository ships a bilingual catalog of 58 device kinds in 18 function groups for
universities and colleges, event and congress halls, councils, theatres and trade fairs.
The data lives in `app/lib/equipment-kinds/library.json`; stable keys identify entries even
after an installation renames them. Institution types narrow the list, and the core, common
and special tiers help an administrator choose. They are suggestions, not requirements.

Device kinds are not installed automatically. In **Administration → Structure →
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

Installed projectors receive their library properties automatically on startup and when a
kind is installed. The versioned file contains shared properties, the projector's own
properties, bilingual labels, units, choices, levels, weights, conditions and source IDs.
`library-sources.json` holds the cited sources. Regenerate both with
`node scripts/library/export.mjs /path/to/research.json`; the research input is not shipped.
Readings, relations and ranges are not materialized in this release. `RANGE` is reserved in
the database enum one release before any row uses it.

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
