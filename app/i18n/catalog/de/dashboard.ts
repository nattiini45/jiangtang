/** Dashboard, activity feed, quick entry page chrome and the import/export hub. */
export const dashboardDe = {
  "dashboard.meta": "Übersicht · Jiangtang",
  "dashboard.subtitle": "Dein Arbeitstag in Jiangtang — fällig, blockiert, zugewiesen.",
  "dashboard.quickLinks": "Schnellzugriff",
  "dashboard.quick.entry": "Eintrag erfassen",

  "dashboard.empty.title": "Der Arbeitsbereich ist noch leer.",
  "dashboard.empty.body":
    "Lege eine Aufgabe, ein Projekt oder eine Notiz an — oder lade den Demo-Workspace, um dich umzusehen.",
  "dashboard.empty.newTask": "Aufgabe anlegen",
  "dashboard.empty.newProject": "Projekt anlegen",
  "dashboard.empty.newNote": "Notiz anlegen",
  "dashboard.demo.load": "Demo-Workspace laden",
  "dashboard.demo.loading": "Lade Demo-Workspace…",
  "dashboard.demo.loaded": "Demo-Workspace geladen — {created} neu, {skipped} bereits vorhanden.",

  "dashboard.due.title": "Heute fällig",
  "dashboard.due.allTasks": "Alle Aufgaben →",
  "dashboard.due.overdue": "{count} überfällig",
  "dashboard.due.none": "Heute fällt nichts an.",
  "dashboard.due.more": "+{count} weitere",

  "dashboard.blocked.title": "Blockiert",
  "dashboard.blocked.link": "Blockierte Aufgaben →",
  "dashboard.blocked.none": "Nichts blockiert.",
  "dashboard.blocked.waitingOn": "wartet auf: {titles}",

  "dashboard.mine.title": "Meine Arbeit",
  "dashboard.mine.link": "Alle meine Aufgaben →",
  "dashboard.mine.summary": "{tasks} Aufgaben · {tickets} Tickets · Σ {effort}",
  "dashboard.mine.none": "Dir ist nichts zugewiesen.",

  "dashboard.recent.title": "Zuletzt geändert",
  "dashboard.recent.link": "Gesamte Aktivität →",

  "dashboard.storage.title": "Speicher & Index",
  "dashboard.storage.attachments": "Anhänge",
  "dashboard.storage.totalSize": "Gesamtgröße",
  "dashboard.storage.backend": "Backend",
  "dashboard.storage.index": "Index",
  "dashboard.storage.indexLink": "Suchindex →",

  "activity.meta": "Aktivität · Jiangtang",
  "activity.subtitle":
    "Alles, was im Workspace passiert — Aufgaben, Tickets, Notizen und mehr in echter Zeitfolge.",
  "activity.filterByPerson": "Nach Person filtern",
  "activity.allPeople": "Alle Personen",
  "activity.filterSubmit": "Filtern",
  "activity.empty.title": "Keine Aktivität für diese Filter.",
  "activity.empty.hint": "Zeitraum oder Typ-Filter anpassen.",
  "activity.grouped": "{count} Einträge zusammengefasst",
  "activity.loadOlder": "Ältere laden",

  "quickEntry.meta": "Schnellerfassung · Jiangtang",
  "quickEntry.subtitle": "Eintrag protokollieren — offen oder bereits erledigt.",
  "quickEntry.submit": "Eintrag erfassen",
  "quickEntry.submitting": "Erfassen…",

  "importHub.meta": "Import / Export · Jiangtang",
  "importHub.subtitle":
    "Alle Importwege an einem Ort — plus der versionierte JSON-Export des gesamten Workspace.",
  "importHub.rooms.title": "Räume (CSV)",
  "importHub.rooms.hint": "Raum-CSV: Nummer, Gebäude, Kapazität, Ausstattung.",
  "importHub.equipment.title": "Geräte (CSV)",
  "importHub.equipment.hint": "Gerätemodelle und Instanzen mit Seriennummern und Standort.",
  "importHub.stock.title": "Lager (CSV)",
  "importHub.stock.hint": "Lagerbestände: SKU, Modell, Zustand, Lagerort.",
  "importHub.tasks.title": "Aufgaben (CSV)",
  "importHub.tasks.hint":
    "title,status,priority,start,due,estimate,labels,assignees,project — atomar pro Datei.",
  "importHub.notes.title": "Notizen (Markdown)",
  "importHub.notes.hint": "Ordner mit .md-Dateien; Frontmatter-Tags werden übernommen.",
  "importHub.export.title": "Workspace exportieren",
  "importHub.export.body":
    "Projekte, Aufgaben (inkl. Zuweisungen und Blockierungen) und Notizen als versionierte JSON-Datei — {format} v1.",
  "importHub.export.download": "JSON-Export herunterladen",
  "importHub.import.title": "Workspace importieren",
  "importHub.import.body":
    "Eine {format}-Datei einlesen — atomar: unbekannte Referenzen oder ein Blockierungskreis verwerfen den gesamten Import.",
  "importHub.import.fileAria": "Workspace-JSON-Datei auswählen",
  "importHub.import.submitting": "Importiere…",
  "importHub.import.done":
    "Importiert: {projects} Projekte, {tasks} Aufgaben, {notes} Notizen, {edges} Abhängigkeiten.",
};
