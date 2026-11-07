/**
 * Places-domain server messages: rooms, locations, inventory (equipment +
 * stock), catalog, vendors, auth/users, attachments, transfer, storage,
 * search health, AI embedding. German is the exact original text these
 * modules threw before i18n (typographic quotes, em dashes and `{param}`
 * placeholders preserved). Schemas reference the keys via `msgKey(...)` and
 * translate at the parse edge; server code uses `tr(...)` at throw time.
 */
export const errorsPlacesDe = {
  // shared field messages
  "places.err.name.required": "Name ist erforderlich.",
  "places.err.number.positive": "Muss eine positive Zahl sein.",

  // campus / building / room
  "places.err.campus.required": "Campus ist erforderlich.",
  "places.err.campus.exists": "Dieser Campus existiert bereits.",
  "places.err.campus.nameTaken": "Ein anderer Campus trägt bereits diesen Namen.",
  "places.err.building.existsAtCampus": "Dieses Gebäude existiert an diesem Campus bereits.",
  "places.err.building.nameTakenAtCampus":
    "Ein anderes Gebäude trägt diesen Namen an diesem Campus.",
  "places.err.building.unknown": "Unbekanntes Gebäude.",
  "places.err.building.campusMismatch":
    "Der gewählte Campus stimmt nicht mit dem Campus des Gebäudes überein.",
  "places.err.building.needsCampus": "Ein Gebäude benötigt einen Campus.",
  "places.err.room.nameRequired": "Bezeichnung ist erforderlich.",
  "places.err.room.renewalOrder": "Erneuerungsbeginn liegt nach dem Ende.",
  "places.err.room.csvNameMissing": "Name fehlt.",
  "places.err.room.justCreated":
    "Ein Raum mit diesem Namen wurde soeben angelegt. Bitte erneut versuchen.",
  "places.err.room.sourceNotFound": "Quellraum nicht gefunden.",
  "places.err.room.csvRoomNotFound": "Raum „{name}“ nicht gefunden.",

  // locations
  "places.err.location.notFound": "Standort nicht gefunden.",
  "places.err.location.unknown": "Unbekannter Standort.",
  "places.err.location.deleteHasChildren":
    "„{name}“ hat noch {count} {children}. Reparentiere sie zuerst — ein Standort mit Kindern wird nicht gelöscht.",
  "places.err.location.child.one": "untergeordneten Standort",
  "places.err.location.child.other": "untergeordnete Standorte",
  "places.err.location.deleteRacedChildren":
    "„{name}“ hat seit der Prüfung Kinder bekommen und kann nicht gelöscht werden.",
  "places.err.location.alreadyThere": "Der Standort steht bereits an dieser Stelle.",
  "places.err.location.selfParent":
    "Ein Standort kann nicht sein eigener übergeordneter Standort sein.",
  "places.err.location.moveIntoSubtree":
    "„{parent}“ liegt in der Baumstruktur von „{name}“. Ein Standort kann nicht in seinen eigenen Teilbaum verschoben werden.",

  // equipment
  "places.err.equipment.unknown": "Unbekanntes Gerät.",
  "places.err.equipment.ipInvalid": "Ungültige IPv4-Adresse.",
  "places.err.equipment.macInvalid": "Ungültige MAC-Adresse.",
  "places.err.equipment.jsonInvalid": "Ungültiges JSON.",
  "places.err.equipment.fixedNeedsRoom": "Fest verbautes Gerät braucht einen Raum.",
  "places.err.equipment.poolNoRoom": "Pool-Gerät hat keinen festen Raum.",
  "places.err.equipment.csvFixedNeedsRoom": "Fest verbautes Gerät „{name}“ braucht einen Raum.",
  "places.err.equipment.selfSubstitute": "Ein Gerät kann sich nicht selbst ersetzen.",
  "places.err.equipment.retiredTarget": "Ausgemusterte Geräte können nicht ersetzt werden.",
  "places.err.equipment.badSpare":
    "Dieses Gerät ist selbst ausgemustert oder defekt und kann nicht als Ersatz dienen.",
  "places.err.equipment.alreadySubstituted": "Dieses Gerät wird bereits durch ein anderes ersetzt.",

  // stock
  "places.err.stock.notFound": "Lagerartikel nicht gefunden.",
  "places.err.stock.label.sku": "SKU",
  "places.err.stock.label.serial": "Seriennummer",
  "places.err.stock.uniqueValueTaken":
    "Diese {label} („{value}“) ist bereits einem anderen Lagerartikel zugeordnet.",
  "places.err.stock.uniqueTaken":
    "Diese {label} ist bereits einem anderen Lagerartikel zugeordnet.",
  "places.err.stock.uniqueKeyDuplicate":
    "Dieser Lagerartikel würde einen bereits vergebenen eindeutigen Schlüssel doppeln.",
  "places.err.stock.deleteLinked":
    "„{name}“ ist mit einem Gerät verknüpft. Löse die Verknüpfung zuerst — verknüpfter Lagerbestand wird nicht gelöscht.",
  "places.err.stock.deleteRacedLink":
    "„{name}“ wurde soeben mit einem Gerät verknüpft und kann nicht gelöscht werden.",
  "places.err.stock.alreadyLinkedThis": "„{name}“ ist bereits mit diesem Gerät verknüpft.",
  "places.err.stock.alreadyLinkedOther":
    "„{name}“ ist bereits mit einem anderen Gerät verknüpft. Löse die Verknüpfung zuerst.",
  "places.err.stock.linkTargetGone":
    "„{name}“ konnte nicht verknüpft werden: Das Gerät existiert nicht (mehr).",
  "places.err.stock.notLinked": "„{name}“ ist mit keinem Gerät verknüpft.",
  "places.err.stock.statusInvalid":
    "Status muss ein gültiger Wert sein (Verfügbar · Angefragt · Wartet auf Bestätigung · Verliehen · Für Veranstaltung reserviert).",
  "places.err.stock.priceInvalid": "Preis ist keine gültige Zahl (max. 2 Nachkommastellen).",
  "places.err.stock.quantityInt": "Menge muss eine ganze Zahl sein.",
  "places.err.stock.quantityNegative": "Menge darf nicht negativ sein.",
  "places.err.stock.importDuplicate":
    'Zeile {line}: {label} „{value}" ist in dieser Datei mehrfach vergeben (zuerst Zeile {first}). Ein Lagerartikel kann eine {label} nur einmal tragen.',
  "places.err.stock.importLine": "Zeile {line}: {detail}",

  // warranty sweep
  "places.err.warranty.windowPositive": "Muss eine positive Zahl an Tagen sein.",

  // frequency board
  "places.err.frequency.poolBucket": "Ohne Raum / Pool",

  // catalog (equipment models)
  "places.err.model.exists": "Dieses Modell existiert bereits.",
  "places.err.model.nameTaken": "Ein anderes Modell trägt bereits diesen Namen.",

  // vendors
  "places.err.vendor.unknown": "Unbekannter Lieferant.",

  // auth / users
  "places.err.auth.emailRequired": "Eine gültige E-Mail-Adresse ist erforderlich.",
  "places.err.auth.nameRequired": "Ein Name ist erforderlich.",
  "places.err.auth.initialsMin": "Initialen müssen mindestens 2 Zeichen lang sein.",
  "places.err.auth.initialsMax": "Initialen dürfen höchstens 6 Zeichen lang sein.",
  "places.err.auth.initialsLetters": "Initialen dürfen nur Buchstaben enthalten.",
  "places.err.auth.passwordMin": "Passwort muss mindestens 8 Zeichen lang sein.",
  "places.err.auth.passwordMax": "Passwort darf höchstens 128 Zeichen lang sein.",
  "places.err.auth.passwordMismatch": "Passwörter stimmen nicht überein.",
  "places.err.auth.confirmEmail": "Bitte bestätige die E-Mail-Adresse.",
  "places.err.auth.capacityNegative": "Kapazität darf nicht negativ sein.",
  "places.err.auth.capacityMax": "Kapazität kann höchstens 168 h/Woche sein.",
  "places.err.user.notFound": "Benutzer nicht gefunden.",
  "places.err.invite.notFound": "Einladung nicht gefunden oder abgelaufen.",
  "places.err.reset.notFound":
    "Dieser Link zum Zurücksetzen ist ungültig, abgelaufen oder wurde schon benutzt.",
  "places.err.reset.noAccount": "Kein aktives Konto mit dieser E-Mail-Adresse.",
  "places.err.reset.inactive":
    "Das Konto ist deaktiviert. Aktiviere es, bevor du einen Link zum Zurücksetzen erstellst.",
  "places.err.invite.emailTaken": "Für diese E-Mail-Adresse gibt es bereits ein Konto.",
  "places.err.invite.initialsTaken": "Die Initialen {initials} sind bereits vergeben.",
  "places.err.invite.acceptEmailTaken":
    "Für diese E-Mail-Adresse gibt es bereits ein Konto. Melde dich an oder wende dich an die Administration.",
  "places.err.invite.acceptInitialsTaken":
    "Die Initialen {initials} aus dieser Einladung sind inzwischen vergeben. Bitte die Administration um eine neue Einladung.",
  "places.err.user.lastAdmin":
    "Der letzte aktive Administrator kann nicht deaktiviert/herabgestuft werden.",

  // attachments
  "places.err.attachment.targetRequired":
    "Anhang benötigt genau ein Ziel (Raum, Gerät oder Ticket).",
  "places.err.attachment.notFound": "Anhang nicht gefunden.",

  // workspace transfer
  "places.err.transfer.invalidFile": "Die Datei ist kein gültiger jiangtang-workspace-Export.",
  "places.err.transfer.idInvalid": "keine gültige ID (cuid oder Demo-ID erwartet)",
  "places.err.transfer.dateInvalid": "kein gültiges Datum",

  // storage / images
  "places.err.storage.fileTooLarge": "Datei ist zu groß (max. {max}).",
  "places.err.storage.backendFs": "Lokales Dateisystem (verschlüsselt)",
  "places.err.storage.backendUnconfigured": "Nicht konfiguriert",
  "places.err.image.unsupported": "Nur JPEG-, PNG- oder WebP-Bilder werden unterstützt.",
  "places.err.image.processFailed":
    "Das Bild ist beschädigt oder zu groß und konnte nicht verarbeitet werden.",

  // search health (dashboard card note)
  "places.err.search.healthSemantic":
    "Semantische Suche aktiv — {embedded} von {chunks} Chunks eingebettet ({model})",
  "places.err.search.healthBroken": "Index gestört — {failed} fällige Jobs",
  "places.err.search.healthBrokenLatest": "Index gestört — {failed} fällige Jobs, zuletzt: {error}",
  "places.err.search.healthLexical":
    "Stichwortsuche aktiv — {chunks} Chunks, kein Embedding-Modell konfiguriert",

  // AI embedding provider (surfaced through the health card's latest errors)
  "places.err.ai.embeddingNonFinite": "Embedding enthält nicht-finite Werte",
  "places.err.ai.embeddingTooShort": "Embedding zu kurz: {length} statt {dimensions} Dimensionen",
  "places.err.ai.embeddingNoData": "Embedding-Antwort ohne `data[]`",
  "places.err.ai.embeddingMissingIndex": "Embedding-Antwort fehlt index {index}",

  // AI provider configuration and transport (shown on the search-index admin page)
  "places.err.ai.baseUrlMissing": "{prefix}_BASE_URL fehlt",
  "places.err.ai.baseUrlInvalid": "{prefix}_BASE_URL ist keine http(s)-URL",
  "places.err.ai.modelMissing": "{prefix}_MODEL fehlt",
  "places.err.ai.dimensionsMismatch":
    "EMBEDDING_DIMENSIONS muss {dimensions} sein — column is vector({dimensions})",
  "places.err.ai.templatePlaceholder": "{name} muss {text} enthalten",
  "places.err.ai.systemRole": "GENERATION_SYSTEM_ROLE muss 'system' oder 'merge' sein",
  "places.err.ai.unreachable": "AI endpoint nicht erreichbar: {error}",
  "places.err.ai.status": "AI endpoint antwortete {status}",
  "places.err.ai.noStream": "AI endpoint lieferte keinen Stream",
};
