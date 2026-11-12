export const fieldsDe = {
  "fields.columns.title": "Spalten",
  "fields.columns.help": "Für alle im Team · {count} von 12 Spalten. Der Name bleibt zuerst.",
  "fields.columns.allKinds": "Alle Gerätearten",
  "fields.columns.up": "{name} nach oben",
  "fields.columns.down": "{name} nach unten",
  "fields.columns.reset": "Zurücksetzen",
  "fields.columns.saved": "Spalten für das Team gespeichert.",
  "fields.columns.invalid":
    "Wähle höchstens 12 Spalten und lasse den Namen an erster Stelle. Lade die Liste bei Bedarf neu.",
  "fields.type.TEXT": "Text",
  "fields.type.LONG_TEXT": "Langer Text",
  "fields.type.NUMBER": "Zahl",
  "fields.type.BOOLEAN": "Ja/Nein",
  "fields.type.DATE": "Datum",
  "fields.type.LINK": "Link",
  "fields.type.CHOICE": "Auswahl",
  "fields.type.MULTI_CHOICE": "Mehrfachauswahl",
  "fields.moreDetails": "Weitere Angaben",
  "fields.form.unset": "Nicht angegeben",
  "fields.form.yes": "Ja",
  "fields.form.no": "Nein",
  "fields.form.clear": "Auswahl leeren",
  "fields.form.search": "Optionen für {name} durchsuchen",
  "fields.form.hidden":
    "{count} gespeicherte Werte bleiben verborgen. Sie erscheinen wieder, wenn die bisherige Geräteart gewählt wird.",
  "fields.form.archivedSelection":
    "Die Auswahl enthält archivierte Optionen. Bei einer Änderung bleiben nur aktive Optionen erhalten.",
  "fields.values.more": "{count} weitere Angaben anzeigen",
  "fields.values.less": "Weniger anzeigen",
  "fields.values.show": "Angaben anzeigen",
  "fields.values.hide": "Angaben ausblenden",
  "fields.values.forDevice": "Angaben zu {name}",
  "fields.values.openAll": "Alle Angaben aufklappen",
  "fields.values.closeAll": "Alle Angaben zuklappen",
  "fields.values.newTab": "Öffnet in neuem Tab",
  "fields.error.encoding": "Ungültige Unicode-Zeichen oder Nullzeichen entfernen.",
  "fields.error.type":
    "Nur Text zu Langtext und Einfachauswahl zu Mehrfachauswahl (oder zurück) sind möglich. Ein neues Feld für einen anderen Typ anlegen.",
  "fields.error.multiple":
    "{count} Datensätze haben mehrere Werte. Die Auswahl auf einen Wert reduzieren, bevor der Feldtyp geändert wird.",
  "fields.error.unknown": "Dieses Feld gibt es nicht. Das aktuelle Datensatzschema abrufen.",
  "fields.error.archived": "Dieses Feld ist archiviert. Es zuerst wiederherstellen.",
  "fields.error.applicable":
    "Dieses Feld gilt nicht für die Geräteart. Das passende Datensatzschema verwenden.",
  "fields.error.number": "Eine endliche Zahl mit höchstens 6 Nachkommastellen eingeben.",
  "fields.error.value": "Der Wert passt nicht zum Feldtyp. Das Datensatzschema prüfen.",
  "fields.error.option": "Eine aktive Option aus der Liste wählen, ohne doppelte Werte.",
  "fields.error.inUse":
    "Dieses Feld hat noch Werte. Es wiederherstellen und für die betroffenen Datensätze gültig machen, bevor die Werte geleert werden, oder es archiviert lassen.",
  "fields.error.optionInUse":
    "Diese Option wird noch verwendet. Das Feld wiederherstellen und für die betroffenen Datensätze gültig machen, bevor die Werte geleert werden, oder die Option archivieren.",
  "fields.limit.text":
    "Text darf höchstens 200 Zeichen enthalten. Den Text kürzen oder ein Langtextfeld verwenden.",
  "fields.limit.longText":
    "Langtext darf höchstens 4.000 Zeichen enthalten. Den Text kürzen oder eine Notiz verlinken.",
  "fields.limit.bytes":
    "Werte dürfen pro Datensatz höchstens 32 KB belegen. Werte kürzen, leeren oder durch einen Link ersetzen.",
  "fields.option.retired": "{label} (archiviert)",
  "fields.limit.fields":
    "Höchstens 40 aktive Felder pro Datensatz. Ein Feld archivieren oder auf andere Gerätearten beschränken.",
  "fields.limit.total": "Höchstens 120 Felder pro Bereich. Ein ungenutztes Feld löschen.",
  "fields.limit.options":
    "Höchstens 50 aktive Optionen pro Feld. Eine Option archivieren oder löschen.",
  "fields.limit.totalOptions": "Höchstens 200 Optionen pro Feld. Eine ungenutzte Option löschen.",
  "fields.error.roomKinds": "Raumfelder gelten für alle Räume. Gerätearten entfernen.",
  "fields.error.kind":
    "Eine Geräteart fehlt, ist archiviert oder doppelt. Aktive Gerätearten auswählen.",
  "fields.error.unit": "Nur Zahlenfelder haben eine Einheit. Die Einheit entfernen.",
  "fields.error.choice": "Nur Auswahlfelder haben Optionen. Ein Auswahlfeld verwenden.",
} as const;
