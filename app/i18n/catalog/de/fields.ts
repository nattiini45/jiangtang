export const fieldsDe = {
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
    "Diese Option wird noch verwendet. Das Feld wiederherstellen und für die betroffenen Datensätze gültig machen, bevor die Werte geleert werden, oder die Option stilllegen.",
  "fields.limit.text":
    "Text darf höchstens 200 Zeichen enthalten. Den Text kürzen oder ein Langtextfeld verwenden.",
  "fields.limit.longText":
    "Langtext darf höchstens 4.000 Zeichen enthalten. Den Text kürzen oder eine Notiz verlinken.",
  "fields.limit.bytes":
    "Eigene Werte dürfen pro Datensatz höchstens 32 KB belegen. Werte kürzen, leeren oder durch einen Link ersetzen.",
  "fields.option.retired": "{label} (stillgelegt)",
  "fields.limit.fields":
    "Höchstens 40 aktive Felder pro Datensatz. Ein Feld archivieren oder auf andere Gerätearten beschränken.",
  "fields.limit.total": "Höchstens 120 Felder pro Bereich. Ein ungenutztes Feld löschen.",
  "fields.limit.options":
    "Höchstens 50 aktive Optionen pro Feld. Eine Option stilllegen oder löschen.",
  "fields.limit.totalOptions": "Höchstens 200 Optionen pro Feld. Eine ungenutzte Option löschen.",
  "fields.error.roomKinds": "Raumfelder gelten für alle Räume. Gerätearten entfernen.",
  "fields.error.kind":
    "Eine Geräteart fehlt, ist archiviert oder doppelt. Aktive Gerätearten auswählen.",
  "fields.error.unit": "Nur Zahlenfelder haben eine Einheit. Die Einheit entfernen.",
  "fields.error.choice": "Nur Auswahlfelder haben Optionen. Ein Auswahlfeld verwenden.",
} as const;
