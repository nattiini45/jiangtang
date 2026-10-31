/**
 * Retrieval eval fixture. Authored by hand — do not edit to make a failing
 * query pass; a failing query is a retrieval finding, not a fixture bug.
 *
 * The corpus is a small AV / facility-management workspace in German, shaped
 * like the real one: exact identifiers (serials, SKUs, IPs, MACs, e-mail
 * addresses, room codes) beside prose that uses different words for the same
 * thing (Beamer / Projektor, Mikrofon / Handsender, Hörschleife / Ringschleife).
 *
 * `kind` says which retrieval property a query exercises:
 *   - "exact"      an identifier that must match lexically (sparse arm);
 *   - "keyword"    ordinary words shared by query and document;
 *   - "fuzzy"      a mistyped / truncated identifier (trigram arm);
 *   - "paraphrase" no content word in common with the target — only the dense
 *                  arm can find it. In `pnpm test` the dense arm is the
 *                  deterministic `conceptEmbedding` below, so these queries test
 *                  the PIPELINE (fusion carries a dense-only hit into the top 3),
 *                  not a real model's quality.
 */

export interface EvalDoc {
  id: string;
  title: string;
  text: string;
}

export interface EvalQuery {
  q: string;
  kind: "exact" | "keyword" | "fuzzy" | "paraphrase";
  /** Must appear among the top 3 results. */
  expect: string;
}

export const EVAL_DOCS: readonly EvalDoc[] = [
  {
    id: "e1",
    title: "Shure ULXD4 Empfänger H 1",
    text: "Funkempfänger Shure ULXD4, Seriennummer SN-ULX-0001, Frequenzband G51 (470–534 MHz), eingebaut im Rack von Hörsaal H 1.",
  },
  {
    id: "e2",
    title: "Sennheiser EW 100 G4 Handsender",
    text: "Handsender Sennheiser EW 100 G4, Seriennummer 0A1B2C3D, Band A (516–558 MHz), liegt im Lager D.01.01.",
  },
  {
    id: "e3",
    title: "Epson EB-L1505U Filterreinigung",
    text: "Laserprojektor Epson EB-L1505U in Hörsaal H 2. Den Luftfilter alle 2000 Betriebsstunden reinigen; ein Leuchtmitteltausch entfällt.",
  },
  {
    id: "e4",
    title: "HDMI-Kabel 10 m",
    text: "Artikelnummer CAB-HDMI-10, Bestand 12 Stück, Lager D.01.01, geliefert von Demo-Ersatzteile GmbH.",
  },
  {
    id: "e5",
    title: "Ticket: Ton fällt aus in H 1",
    text: "Während der Vorlesung bricht die Funkstrecke in Hörsaal H 1 regelmäßig ab. Ursache war ein LTE-Repeater im Band G51; der Kanal wurde gewechselt.",
  },
  {
    id: "e6",
    title: "Netzwerk-Switch Medientechnik Demo-Gebäude A",
    text: "Cisco Catalyst 9200 in Raum D.01.02, IP-Adresse 192.0.2.40, MAC 02:00:00:11:3A:B7.",
  },
  {
    id: "e7",
    title: "Projekt: Erstsemesterbegrüßung 2026",
    text: "Anfrage der Fachbereich Demo nach AV-Unterstützung für die Erstsemesterbegrüßung im Audimax: zwei Funkmikrofone und ein Livestream.",
  },
  {
    id: "e8",
    title: "Aufgabe: Livestream-Encoder Audimax konfigurieren",
    text: "Den Encoder für den Livestream aus dem Audimax einrichten, das RTMP-Ziel eintragen und die Bitrate auf 6 Mbit/s setzen.",
  },
  {
    id: "e9",
    title: "Notiz: Checkliste Veranstaltungsaufbau",
    text: "## Vor der Veranstaltung\n- Akkus der Funkmikrofone laden\n- Beamer 30 Minuten vorher einschalten\n\n## Nach der Veranstaltung\n- Funkmikrofone zurück ins Lager bringen",
  },
  {
    id: "e10",
    title: "Lieferant Demo-Ersatzteile GmbH",
    text: "Ansprechpartnerin Demo Kontakt, E-Mail ersatzteile@demo-ersatzteile.example, Telefon 0000 000000.",
  },
  {
    id: "e11",
    title: "Yamaha TF1 Digitalmischpult",
    text: "Digitalmischpult Yamaha TF1, Seriennummer YTF1-0001, Garantie bis 31.03.2027.",
  },
  {
    id: "e12",
    title: "Hörsaal H 2 Ausstattung",
    text: "Hörsaal H 2 hat 180 Sitzplätze, einen Laserprojektor, eine Dokumentenkamera und eine induktive Höranlage.",
  },
  {
    id: "e13",
    title: "Ticket: Dokumentenkamera ohne Bild",
    text: "Die Dokumentenkamera in Hörsaal H 2 liefert kein Signal an Eingang 3 der Kreuzschiene. Das HDMI-Kabel wurde getauscht, seitdem funktioniert sie wieder.",
  },
  {
    id: "e14",
    title: "Ladestation für Handsender",
    text: "Ladestation mit 8 Schächten für die Sennheiser-Handsender, steht im Lager D.01.01.",
  },
  {
    id: "e15",
    title: "Notiz: Interferenzen im Band G51",
    text: "Seit dem Umbau stören neue Mobilfunkanlagen das Band G51. Empfehlung: auf Band A ausweichen.",
  },
  {
    id: "e16",
    title: "Aufgabe: Ringschleife H 2 jährlich messen",
    text: "Jährliche Messung der induktiven Ringschleife in Hörsaal H 2 nach DIN EN 60118-4 und Protokoll ablegen.",
  },
  {
    id: "e17",
    title: "Projekt: Ersatz Projektor Audimax",
    text: "Anfrage zum Ersatz des Projektors im Audimax; ein Angebot bei Demo-Ersatzteile GmbH ist angefragt.",
  },
  {
    id: "e18",
    title: "Lager D.01.01",
    text: "Zentrales Lager der Medientechnik in Demo-Gebäude A, Ebene 11, Raum 04. Der Schlüssel liegt beim Pförtner.",
  },
  {
    id: "e19",
    title: "Ticket: Handsender rauscht in D.02.03",
    text: "Der Handsender im Seminarraum D.02.03 rauscht stark. Die Antenne am Empfänger war lose und wurde festgeschraubt.",
  },
  {
    id: "e20",
    title: "Veranstaltung: Tag der offenen Tür",
    text: "Samstag, 14.11.2026, im Audimax und in Hörsaal H 1; Technikbetreuung von 8 bis 16 Uhr.",
  },
];

export const EVAL_QUERIES: readonly EvalQuery[] = [
  { q: "SN-ULX-0001", kind: "exact", expect: "e1" },
  { q: "CAB-HDMI-10", kind: "exact", expect: "e4" },
  { q: "ersatzteile@demo-ersatzteile.example", kind: "exact", expect: "e10" },
  { q: "ersatzteile", kind: "exact", expect: "e10" },
  { q: "192.0.2.40", kind: "exact", expect: "e6" },
  { q: "02:00:00:11:3A:B7", kind: "exact", expect: "e6" },
  { q: "YTF1-0001", kind: "exact", expect: "e11" },
  { q: "Funkstrecke bricht ab H 1", kind: "keyword", expect: "e5" },
  { q: "Garantie Yamaha Mischpult", kind: "keyword", expect: "e11" },
  { q: "Wo ist das Lager D.01.01", kind: "keyword", expect: "e18" },
  { q: "Livestream Encoder", kind: "keyword", expect: "e8" },
  { q: "Interferenzen Band G51", kind: "keyword", expect: "e15" },
  { q: "SN-ULX-000", kind: "fuzzy", expect: "e1" },
  { q: "Mikrofon hat Störgeräusche", kind: "paraphrase", expect: "e19" },
  { q: "Beamer Wartung", kind: "paraphrase", expect: "e3" },
  { q: "Hörschleife prüfen", kind: "paraphrase", expect: "e16" },
];

/**
 * Concept table for the deterministic test embedder. Each concept lists the
 * surface forms (lower-case, whole words after splitting on non-letters/digits)
 * that map to it. A text's embedding is the L2-normalised bag of its concepts,
 * so two texts that share a concept but no word are close.
 */
export const CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  mikrofon: [
    "mikrofon",
    "mikrofone",
    "handsender",
    "funkmikrofon",
    "funkmikrofone",
    "handmikrofon",
  ],
  rauschen: ["rauscht", "rauschen", "störgeräusche", "störgeräusch", "brummt", "knackt"],
  projektor: ["beamer", "projektor", "projektors", "laserprojektor"],
  wartung: [
    "wartung",
    "reinigen",
    "reinigung",
    "filterreinigung",
    "messen",
    "messung",
    "prüfen",
    "prüfung",
  ],
  hoeranlage: [
    "hörschleife",
    "ringschleife",
    "höranlage",
    "induktionsschleife",
    "induktiven",
    "induktive",
  ],
  funk: ["funkstrecke", "funkempfänger", "empfänger", "band", "frequenzband"],
  stream: ["livestream", "encoder", "rtmp", "stream"],
  lager: ["lager", "lagerort", "ladestation"],
};
