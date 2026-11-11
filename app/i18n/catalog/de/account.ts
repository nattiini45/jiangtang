/** The signed-in user's own account page. */
export const accountDe = {
  "account.meta": "Mein Konto · Jiangtang",
  "account.title": "Mein Konto",
  "account.subtitle": "Deine Angaben und dein Passwort.",
  "account.name": "Name",
  "account.email": "E-Mail",
  "account.initials": "Initialen",
  "account.role": "Rolle",
  "account.menu": "Mein Konto",
  "account.password.heading": "Passwort ändern",
  "account.password.intro":
    "Du bleibst in diesem Browser angemeldet; alle anderen Sitzungen werden abgemeldet.",
  "account.password.current": "Aktuelles Passwort",
  "account.password.new": "Neues Passwort",
  "account.password.confirm": "Neues Passwort bestätigen",
  "account.password.submit": "Passwort ändern",
  "account.password.changed": "Passwort geändert. Andere Sitzungen wurden abgemeldet.",
  "account.password.err.currentRequired": "Bitte gib dein aktuelles Passwort ein.",
  "account.password.err.currentWrong": "Das aktuelle Passwort ist falsch.",
  "account.twoFactor.heading": "Zwei-Faktor-Authentifizierung",
  "account.twoFactor.intro":
    "Beim Anmelden fragt Jiangtang zusätzlich nach einem Code aus einer Authenticator-App.",
  "account.twoFactor.statusOn": "Aktiv.",
  "account.twoFactor.statusOff": "Nicht eingerichtet.",
  "account.twoFactor.required":
    "Für Admins ist die Zwei-Faktor-Authentifizierung Pflicht. Richte sie ein, um weiterzuarbeiten.",
  "account.twoFactor.password": "Passwort",
  "account.twoFactor.start": "Einrichten",
  "account.twoFactor.scan":
    "Scanne den QR-Code mit deiner Authenticator-App oder gib den Schlüssel von Hand ein.",
  "account.twoFactor.qrLabel": "QR-Code für die Authenticator-App",
  "account.twoFactor.secret": "Schlüssel",
  "account.twoFactor.backupCodes": "Backup-Codes",
  "account.twoFactor.backupHint":
    "Jeder Code funktioniert einmal, falls du die App nicht zur Hand hast. Bewahre sie sicher auf; sie werden nur jetzt angezeigt.",
  "account.twoFactor.code": "Code aus der App",
  "account.twoFactor.confirm": "Bestätigen und aktivieren",
  "account.twoFactor.enabled":
    "Zwei-Faktor-Authentifizierung ist aktiv. Bewahre die Backup-Codes sicher auf.",
  "account.twoFactor.manageIntro":
    "Zum Deaktivieren oder für neue Backup-Codes brauchst du dein Passwort.",
  "account.twoFactor.disable": "Deaktivieren",
  "account.twoFactor.disabled": "Zwei-Faktor-Authentifizierung ist deaktiviert.",
  "account.twoFactor.regenerate": "Neue Backup-Codes erstellen",
  "account.twoFactor.regenerated":
    "Neue Backup-Codes erstellt. Die alten funktionieren nicht mehr.",
  "account.twoFactor.err.codeRequired": "Bitte gib den Code ein.",
  "account.twoFactor.err.codeInvalid": "Der Code ist ungültig.",
  "account.twoFactor.err.alreadyEnabled": "Die Zwei-Faktor-Authentifizierung ist bereits aktiv.",
  "account.twoFactor.err.enrolmentExpired": "Die Einrichtung ist abgelaufen. Bitte starte sie neu.",
  "account.tokens.heading": "Persönliche Zugriffstokens",
  "account.tokens.connection.address": "MCP-Adresse",
  "account.tokens.connection.heading": "Client verbinden",
  "account.tokens.connection.copy": "Kopieren",
  "account.tokens.connection.copyNamed": "{name} kopieren",
  "account.tokens.connection.copied": "Kopiert.",
  "account.tokens.connection.copyFailed":
    "Kopieren hat nicht geklappt. Markiere den Text und kopiere ihn von Hand.",
  "account.tokens.connection.environment":
    "Erstelle oben einen Token und speichere ihn auf deinem Computer als Umgebungsvariable JIANGTANG_MCP_TOKEN. Starte den Client so, dass ihm diese Variable zur Verfügung steht; eine vom Desktop gestartete App übernimmt die Terminal-Umgebung möglicherweise nicht. Verbinde nur Clients, denen du vertraust, und lass Werkzeugaufrufe weiterhin bestätigen.",
  "account.tokens.connection.header": "Header zur Authentifizierung:",
  "account.tokens.connection.claudeLabel": "Claude Code · .mcp.json",
  "account.tokens.connection.cursorLabel": "Cursor · mcp.json",
  "account.tokens.connection.claude":
    "Claude Code: Füge dies in die .mcp.json in deinem Projektordner ein. Öffne dann /mcp in Claude Code, um die Verbindung zu prüfen. Das ist JSON, kein Terminalbefehl, und funktioniert auch unter Windows.",
  "account.tokens.connection.cursor":
    "Cursor: Ergänze damit die .cursor/mcp.json in deinem Benutzerordner (%USERPROFILE% unter Windows). Verbinde den Server dann in Cursor neu. Behalte vorhandene Servereinträge bei.",
  "account.tokens.connection.oauth":
    "Clients, die nur eine OAuth-Anmeldung unterstützen, etwa ChatGPT-Connectors, können sich noch nicht verbinden.",
  "account.tokens.inactive": "Für ein inaktives Konto können keine Zugriffstoken erstellt werden.",
  "account.tokens.intro":
    "Verbinde einen KI-Client über MCP mit Jiangtang. Jeder Token nutzt die Berechtigungen deines Kontos.",
  "account.tokens.name": "Tokenname",
  "account.tokens.nameHint":
    "Wähle einen Namen, an dem du den Client oder die Verbindung erkennst.",
  "account.tokens.scope": "Zugriff",
  "account.tokens.scopeHint":
    "Nur lesen erlaubt das Anzeigen und Suchen. Lesen und schreiben erlaubt auch Änderungen im Rahmen deiner Kontoberechtigungen.",
  "account.tokens.readOnly": "Nur lesen",
  "account.tokens.readWrite": "Lesen und schreiben",
  "account.tokens.create": "Token erstellen",
  "account.tokens.creating": "Token wird erstellt…",
  "account.tokens.created": "Token erstellt",
  "account.tokens.warning": "Kopiere diesen Token jetzt. Er wird nicht erneut angezeigt.",
  "account.tokens.securityHint":
    "Halte ihn geheim: Wer ihn hat, kann den gewählten Zugriff nutzen. Widerrufe ihn, falls er offengelegt wird.",
  "account.tokens.secret": "Dein neuer Token",
  "account.tokens.copy": "Token kopieren",
  "account.tokens.copied": "Token kopiert.",
  "account.tokens.copyFailed":
    "Der Token konnte nicht kopiert werden. Markiere und kopiere ihn von Hand.",
  "account.tokens.hide": "Token ausblenden",
  "account.tokens.yours": "Deine Tokens",
  "account.tokens.empty": "Noch keine Tokens. Erstelle einen, um einen MCP-Client zu verbinden.",
  "account.tokens.emptyOthers": "Keine Tokens von anderen Konten.",
  "account.tokens.createdAt": "Erstellt",
  "account.tokens.lastUsedAt": "Zuletzt verwendet",
  "account.tokens.neverUsed": "Noch nicht verwendet",
  "account.tokens.status": "Status",
  "account.tokens.active": "Aktiv",
  "account.tokens.revokedAt": "Widerrufen am {date}",
  "account.tokens.revoke": "Widerrufen",
  "account.tokens.revokeNamed": "Token {name} widerrufen",
  "account.tokens.confirmRevoke":
    "„{name}“ widerrufen? Clients mit diesem Token verlieren sofort den Zugriff. Das kann nicht rückgängig gemacht werden.",
  "account.tokens.revoked": "Token widerrufen. Er kann nicht mehr auf Jiangtang zugreifen.",
  "account.tokens.owner": "Inhaber: {name}",
  "account.tokens.all": "Tokens anderer Konten ({count})",
  "account.tokens.allHint":
    "Als Admin kannst du auch Tokens anderer Konten sehen und widerrufen. Die geheimen Tokenwerte werden hier nie angezeigt.",
};
