# Device-kind library

The repository ships a bilingual catalogue of 58 device kinds in 18 function groups for
universities and colleges, event and congress halls, councils, theatres and trade fairs.
The data lives in `app/lib/equipment-kinds/library.json`; stable keys identify entries even
after an installation renames them. Institution types narrow the list, and the core, common
and special tiers help an administrator choose. They are suggestions, not requirements.

Nothing from this library is installed automatically. In **Administration → Structure →
Device kinds → Add from the library**, choose an institution type, review the checked core
kinds and select the kinds your team needs. Common and special entries start unchecked.
Existing entries show their installed name; archived entries and occupied names cannot be
selected. The dialog shows the remaining capacity under the 80-active-kind limit.

Installation creates only the selected kinds and their missing function groups, atomically,
in library order. New names use the installation's `DEFAULT_LOCALE`, not the visitor's
language. Existing names and groups are left alone. A conflict installs nothing. Restore an
archived group before installing more kinds into it. Fields, room types, room fields and
catalogue-model categories are not part of this library slice.

An admin's read-write MCP token can use `list_kind_library({ institutionType? })` and
`install_library_kinds({ keys })`; see [MCP.md](MCP.md). Kinds, groups and every device or model
moved during archiving have audit records. Operators need no migration or restart.
