/** User-facing error messages of the work domains: tasks, projects, notes, time, tickets, events. German = the exact original text. */
export const errorsWorkDe = {
  // ── Shared field validation (zod schemas) ──────────────────────────────────
  "work.err.titleRequired": "Titel ist erforderlich.",
  "work.err.titleTooLong": "Titel ist zu lang.",
  "work.err.nameRequired": "Name ist erforderlich.",
  "work.err.noteTooLong": "Notiz ist zu lang.",
  "work.err.invalidDate": "Ungültiges Datum.",
  "work.err.csvDayFormat": "Ungültiges Datum — erwartet JJJJ-MM-TT oder TT.MM.JJJJ.",
  "work.err.dueBeforeStart": "Fälligkeitsdatum darf nicht vor dem Startdatum liegen.",
  "work.err.minutesInteger": "Minuten müssen ganzzahlig sein.",
  "work.err.minutesNegative": "Minuten dürfen nicht negativ sein.",
  "work.err.dateFormat": "Datum im Format JJJJ-MM-TT.",
  "work.err.timeFormat": "Uhrzeit im Format SS:MM.",
  "work.err.endsAfterStart": "Ende muss nach dem Beginn liegen.",
  "work.err.colorFormat": "Farbe muss die Form #RRGGBB haben.",
  "work.err.invalidClientId": "Keine gültige ID (cuid-Form erwartet).",
  "work.err.csv.statusUnknown":
    "Unbekannter Status — Enum-Wert oder Bezeichnung (Deutsch/Englisch) erwartet.",
  "work.err.csv.priorityUnknown":
    "Unbekannte Priorität — Enum-Wert oder Bezeichnung (Deutsch/Englisch) erwartet.",
  "work.err.csv.assigneeUnknown":
    "assignees: „{key}“ ist kein bekanntes Kürzel und keine bekannte E-Mail.",
  "work.err.csv.projectUnknown": "project: „{slug}“ ist kein bekannter Projekt-Slug.",

  // ── Not-found / unknown references (domain throws) ─────────────────────────
  "work.err.task.notFound": "Aufgabe nicht gefunden.",
  "work.err.task.unknown": "Unbekannte Aufgabe.",
  "work.err.task.locationUnknown": "Unbekannter Ort.",
  "work.err.project.notFound": "Projekt nicht gefunden.",
  "work.err.project.unknown": "Unbekanntes Projekt.",
  "work.err.note.notFound": "Notiz nicht gefunden.",
  "work.err.note.authorRequired": "Notiz benötigt einen angemeldeten Autor.",
  "work.err.noteImport.authorRequired": "Notiz-Import benötigt einen angemeldeten Autor.",
  "work.err.note.alreadyArchived": "Die Notiz ist bereits archiviert.",
  "work.err.note.notArchived": "Die Notiz ist nicht archiviert.",
  "work.err.note.locationUnknown": "Unbekannter Standort.",
  "work.err.ticket.notFound": "Ticket nicht gefunden.",
  "work.err.event.notFound": "Veranstaltung nicht gefunden.",
  "work.err.event.roomBookingNotFound": "Raumbuchung nicht gefunden.",
  "work.err.event.equipmentNotFound": "Gerät nicht gefunden.",
  "work.err.event.allocationNotFound": "Zuteilung nicht gefunden.",
  "work.err.event.serviceWindowNotFound": "Servicefenster nicht gefunden.",
  "work.err.timeEntry.notFound": "Zeiteintrag nicht gefunden.",
  "work.err.unknownUser": "Unbekannter Benutzer.",
  "work.err.time.unknownUser": "Unbekannter Nutzer.",

  // ── Task rules ─────────────────────────────────────────────────────────────
  "work.err.task.selfParent": "Eine Aufgabe kann nicht ihre eigene übergeordnete Aufgabe sein.",
  "work.err.task.parentInSubtree":
    "„{parentTitle}“ liegt im Teilbaum von „{title}“. Eine Aufgabe kann nicht in ihre eigene Unteraufgabe verschoben werden.",
  "work.err.task.statusAlready": "Die Aufgabe hat diesen Status bereits.",
  "work.err.task.betweenItself": "Eine Aufgabe kann nicht zwischen sich selbst liegen.",
  "work.err.task.besideItself": "Eine Aufgabe kann nicht neben sich selbst liegen.",
  "work.err.task.notInLane": "„{title}“ liegt nicht in dieser Spalte.",
  "work.err.laneChanged": "Die Spalte hat sich geändert — bitte neu laden.",
  "work.err.task.deleteWithSubtasks.one":
    "„{title}“ hat noch {count} Unteraufgabe. Verschiebe sie zuerst — eine Aufgabe mit Unteraufgaben wird nicht gelöscht.",
  "work.err.task.deleteWithSubtasks.other":
    "„{title}“ hat noch {count} Unteraufgaben. Verschiebe sie zuerst — eine Aufgabe mit Unteraufgaben wird nicht gelöscht.",
  "work.err.task.alreadyLinkedToTicket": "„{title}“ ist bereits mit einem Ticket verknüpft.",
  "work.err.task.notLinkedToTicket": "„{title}“ ist mit keinem Ticket verknüpft.",
  "work.err.ticket.alreadyLinkedToTask": "„{title}“ ist bereits mit einer Aufgabe verknüpft.",
  "work.err.task.selfBlocker": "Eine Aufgabe kann nicht durch sich selbst blockiert werden.",
  "work.err.task.blockerExists": "Diese Blockierung besteht bereits.",
  "work.err.task.blockerMissing": "Diese Blockierung besteht nicht.",
  "work.err.task.cycle":
    "„{taskTitle}“ blockiert „{blockerTitle}“ bereits mittelbar — diese Abhängigkeit würde einen Kreis schließen.",

  // ── Project rules ──────────────────────────────────────────────────────────
  "work.err.project.selfParent": "Ein Projekt kann nicht sein eigenes übergeordnetes Projekt sein.",
  "work.err.project.parentInSubtree":
    "„{parentName}“ liegt im Teilbaum von „{name}“. Ein Projekt kann nicht in sein eigenes Teilprojekt verschoben werden.",
  "work.err.project.statusAlready": "Das Projekt hat diesen Status bereits.",
  "work.err.project.deleteWithSubprojects.one":
    "„{name}“ hat noch {count} Teilprojekt. Verschiebe sie zuerst — ein Projekt mit Teilprojekten wird nicht gelöscht.",
  "work.err.project.deleteWithSubprojects.other":
    "„{name}“ hat noch {count} Teilprojekte. Verschiebe sie zuerst — ein Projekt mit Teilprojekten wird nicht gelöscht.",
  "work.err.project.subprojectsSinceCheck":
    "„{name}“ hat seit der Prüfung Teilprojekte bekommen und kann nicht gelöscht werden.",

  // ── Ticket rules ───────────────────────────────────────────────────────────
  "work.err.ticket.priorityRange": "Priorität 1–3.",
  "work.err.ticket.resolutionRequiredResolved": "Lösung angeben, wenn bereits erledigt.",
  "work.err.ticket.resolvedBeforeOccurred": "Lösungszeit liegt vor dem Auftreten.",
  "work.err.ticket.resolutionRequired": "Lösung angeben.",
  "work.err.ticket.invalidTransition": "Ungültiger Statuswechsel von {from} zu {to}.",
  "work.err.ticket.noReviewLane": "Tickets haben keine Review-Spalte.",

  // ── Event rules ────────────────────────────────────────────────────────────
  "work.err.event.dateTimeRequired": "Datum und Uhrzeit erforderlich.",
  "work.err.event.roomRequired": "Raum ist erforderlich.",
  "work.err.event.equipmentRequired": "Gerät ist erforderlich.",
  "work.err.event.cancelled": "Eine stornierte Veranstaltung kann nicht mehr geändert werden.",
  "work.err.event.roomAlreadyBooked": "Der Raum ist in diesem Zeitraum bereits belegt.",
  "work.err.event.equipmentAlreadyAllocated":
    "Dieses Gerät ist in diesem Zeitraum bereits zugeteilt.",
  "work.err.event.onlyPooled": "Nur bewegliche (gepoolte) Geräte können zugeteilt werden.",
  "work.err.event.retiredEquipment": "Ausgemustertes Gerät kann nicht zugeteilt werden.",

  // ── Time rules ─────────────────────────────────────────────────────────────
  "work.err.time.onlyOwnEntries": "Nur eigene Zeiteinträge können bearbeitet werden.",
  "work.err.time.timerAlreadyRunning": "Es läuft bereits ein Timer — zuerst stoppen.",
  "work.err.time.timerRequired": "Timer benötigt einen angemeldeten Nutzer.",
  "work.err.time.noTimerRunning": "Es läuft kein Timer.",
  "work.err.time.entryAuthorRequired": "Zeiteintrag benötigt einen angemeldeten Nutzer.",

  // ── CSV / workspace / markdown import ──────────────────────────────────────
  "work.err.import.row": "Zeile {line}: {errors}",
  "work.err.import.taskLabel": "Aufgabe {index} („{title}“)",
  "work.err.import.projectLabel": "Projekt {index} („{slug}“)",
  "work.err.import.noteLabel": "Notiz {index} („{title}“)",
  "work.err.import.duplicateId": "doppelte ID in der Datei.",
  "work.err.import.duplicateSlug": "doppelter Slug in der Datei.",
  "work.err.import.projectSlugUnknown": "projectSlug „{slug}“ ist kein bekanntes Projekt.",
  "work.err.import.parentSlugUnknown": "parentSlug „{slug}“ ist kein bekanntes Projekt.",
  "work.err.import.parentTaskIdUnknown": "parentTaskId „{id}“ ist unbekannt.",
  "work.err.import.taskIdUnknown": "Aufgabe „{id}“ ist unbekannt.",
  "work.err.import.blockerUnknown": "blocker „{blockerId}“ (für „{taskId}“) ist unbekannt.",
  "work.err.import.assigneeUnknown": "assignee „{email}“ ist kein bekannter Nutzer.",
  "work.err.import.leadEmailUnknown": "leadEmail „{email}“ ist kein bekannter Nutzer.",
  "work.err.import.slugTaken": "Slug „{slug}“ gehört bereits einem anderen Projekt.",
  "work.err.import.selfParentTask": "kann nicht ihre eigene Elternaufgabe sein.",
  "work.err.import.selfParentProject": "kann nicht sein eigenes Elternprojekt sein.",
  "work.err.import.locationIdUnknown": "locationId „{id}“ ist unbekannt.",
  "work.err.import.fileEmpty": "„{file}“: Datei ist leer.",
  "work.err.import.fileUnreadable": "Datei ist nicht lesbar.",
  "work.err.import.fileError": "„{file}“: {message}",
  "work.err.import.fileProjectSlugUnknown": "„{file}“: „{slug}“ ist kein bekannter Projekt-Slug.",
  "work.err.import.fileLocationUnknown": "„{file}“: „{id}“ ist kein bekannter Standort.",
};
