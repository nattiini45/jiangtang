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
