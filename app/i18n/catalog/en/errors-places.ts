import type { errorsPlacesDe } from "../de/errors-places";

/** English twin of `errors-places.ts` (de): same keys, product English. */
export const errorsPlacesEn = {
  // shared field messages
  "places.err.name.required": "Name is required.",
  "places.err.number.positive": "Must be a positive number.",

  // campus / building / room
  "places.err.campus.required": "Campus is required.",
  "places.err.campus.exists": "This campus already exists.",
  "places.err.campus.nameTaken": "Another campus already has this name.",
  "places.err.building.existsAtCampus": "This building already exists at this campus.",
  "places.err.building.nameTakenAtCampus": "Another building already has this name at this campus.",
  "places.err.building.unknown": "Unknown building.",
  "places.err.building.campusMismatch": "The selected campus does not match the building's campus.",
  "places.err.building.needsCampus": "A building needs a campus.",
  "places.err.room.nameRequired": "Name is required.",
  "places.err.room.renewalOrder": "Renewal start is after the end.",
  "places.err.room.csvNameMissing": "Name is missing.",
  "places.err.room.justCreated": "A room with this name was just created. Please try again.",
  "places.err.room.sourceNotFound": "Source room not found.",
  "places.err.room.csvRoomNotFound": 'Room "{name}" not found.',

  // locations
  "places.err.location.notFound": "Location not found.",
  "places.err.location.unknown": "Unknown location.",
  "places.err.location.deleteHasChildren":
    '"{name}" still has {count} {children}. Reparent them first — a location with children is not deleted.',
  "places.err.location.child.one": "child location",
  "places.err.location.child.other": "child locations",
  "places.err.location.deleteRacedChildren":
    '"{name}" gained children since the check and cannot be deleted.',
  "places.err.location.alreadyThere": "The location is already in this place.",
  "places.err.location.selfParent": "A location cannot be its own parent.",
  "places.err.location.moveIntoSubtree":
    '"{parent}" is inside the tree of "{name}". A location cannot be moved into its own subtree.',

  // equipment
  "places.err.equipment.unknown": "Unknown device.",
  "places.err.equipment.ipInvalid": "Invalid IPv4 address.",
  "places.err.equipment.macInvalid": "Invalid MAC address.",
  "places.err.equipment.jsonInvalid": "Invalid JSON.",
  "places.err.equipment.fixedNeedsRoom": "A fixed device needs a room.",
  "places.err.equipment.poolNoRoom": "A pooled device has no fixed room.",
  "places.err.equipment.csvFixedNeedsRoom": 'Fixed device "{name}" needs a room.',
  "places.err.equipment.selfSubstitute": "A device cannot replace itself.",
  "places.err.equipment.retiredTarget": "Retired devices cannot be replaced.",
  "places.err.equipment.badSpare":
    "This device is itself retired or faulty and cannot serve as a replacement.",
  "places.err.equipment.alreadySubstituted":
    "This device is already being replaced by another one.",

  // stock
  "places.err.stock.notFound": "Stock item not found.",
  "places.err.stock.label.sku": "SKU",
  "places.err.stock.label.serial": "serial number",
  "places.err.stock.uniqueValueTaken":
    'This {label} ("{value}") is already assigned to another stock item.',
  "places.err.stock.uniqueTaken": "This {label} is already assigned to another stock item.",
  "places.err.stock.uniqueKeyDuplicate":
    "This stock item would duplicate an already assigned unique key.",
  "places.err.stock.deleteLinked":
    '"{name}" is linked to a device. Unlink it first — linked stock is not deleted.',
  "places.err.stock.deleteRacedLink": '"{name}" was just linked to a device and cannot be deleted.',
  "places.err.stock.alreadyLinkedThis": '"{name}" is already linked to this device.',
  "places.err.stock.alreadyLinkedOther":
    '"{name}" is already linked to another device. Unlink it first.',
  "places.err.stock.linkTargetGone": '"{name}" could not be linked: the device no longer exists.',
  "places.err.stock.notLinked": '"{name}" is not linked to any device.',
  "places.err.stock.statusInvalid":
    "Status must be a valid value (Available · Requested · Awaiting confirmation · On loan · Reserved for event).",
  "places.err.stock.priceInvalid": "Price is not a valid number (max. 2 decimal places).",
  "places.err.stock.quantityInt": "Quantity must be a whole number.",
  "places.err.stock.quantityNegative": "Quantity must not be negative.",
  "places.err.stock.importDuplicate":
    'Line {line}: {label} "{value}" is assigned more than once in this file (first on line {first}). A stock item can carry a {label} only once.',
  "places.err.stock.importLine": "Line {line}: {detail}",

  // warranty sweep
  "places.err.warranty.windowPositive": "Must be a positive number of days.",

  // frequency board
  "places.err.frequency.poolBucket": "No room / pool",

  // catalog (equipment models)
  "places.err.model.exists": "This model already exists.",
  "places.err.model.nameTaken": "Another model already has this name.",

  // vendors
  "places.err.vendor.unknown": "Unknown vendor.",

  // auth / users
  "places.err.auth.emailRequired": "A valid email address is required.",
  "places.err.auth.nameRequired": "A name is required.",
  "places.err.auth.initialsMin": "Initials must be at least 2 characters long.",
  "places.err.auth.initialsMax": "Initials must be at most 6 characters long.",
  "places.err.auth.initialsLetters": "Initials may only contain letters.",
  "places.err.auth.passwordMin": "Password must be at least 8 characters long.",
  "places.err.auth.passwordMismatch": "Passwords do not match.",
  "places.err.auth.confirmEmail": "Please confirm the email address.",
  "places.err.auth.capacityNegative": "Capacity must not be negative.",
  "places.err.auth.capacityMax": "Capacity can be at most 168 h per week.",
  "places.err.user.notFound": "User not found.",
  "places.err.invite.notFound": "This invitation was not found or has expired.",
  "places.err.user.lastAdmin": "The last active administrator cannot be deactivated or demoted.",

  // attachments
  "places.err.attachment.targetRequired":
    "An attachment needs exactly one target (room, device or ticket).",
  "places.err.attachment.notFound": "Attachment not found.",

  // workspace transfer
  "places.err.transfer.invalidFile": "The file is not a valid jiangtang-workspace export.",
  "places.err.transfer.idInvalid": "not a valid ID (cuid or demo ID expected)",
  "places.err.transfer.dateInvalid": "not a valid date",

  // storage / images
  "places.err.storage.fileTooLarge": "File is too large (max. {max}).",
  "places.err.storage.backendFs": "Local filesystem (encrypted)",
  "places.err.storage.backendUnconfigured": "Not configured",
  "places.err.image.unsupported": "Only JPEG, PNG or WebP images are supported.",
  "places.err.image.processFailed": "The image is damaged or too large and could not be processed.",

  // search health (dashboard card note)
  "places.err.search.healthSemantic":
    "Semantic search active — {embedded} of {chunks} chunks embedded ({model})",
  "places.err.search.healthBroken": "Index broken — {failed} failed jobs",
  "places.err.search.healthBrokenLatest": "Index broken — {failed} failed jobs, latest: {error}",
  "places.err.search.healthLexical":
    "Keyword search active — {chunks} chunks, no embedding model configured",

  // AI embedding provider (surfaced through the health card's latest errors)
  "places.err.ai.embeddingNonFinite": "Embedding contains non-finite values",
  "places.err.ai.embeddingTooShort":
    "Embedding too short: {length} instead of {dimensions} dimensions",
  "places.err.ai.embeddingNoData": "Embedding response without `data[]`",
  "places.err.ai.embeddingMissingIndex": "Embedding response is missing index {index}",

  // AI provider configuration and transport (shown on the search-index admin page)
  "places.err.ai.baseUrlMissing": "{prefix}_BASE_URL is missing",
  "places.err.ai.baseUrlInvalid": "{prefix}_BASE_URL is not an http(s) URL",
  "places.err.ai.modelMissing": "{prefix}_MODEL is missing",
  "places.err.ai.dimensionsMismatch":
    "EMBEDDING_DIMENSIONS must be {dimensions} — column is vector({dimensions})",
  "places.err.ai.templatePlaceholder": "{name} must contain {text}",
  "places.err.ai.systemRole": "GENERATION_SYSTEM_ROLE must be 'system' or 'merge'",
  "places.err.ai.unreachable": "AI endpoint unreachable: {error}",
  "places.err.ai.status": "AI endpoint responded {status}",
  "places.err.ai.noStream": "AI endpoint returned no stream",
} satisfies Record<keyof typeof errorsPlacesDe, string>;
