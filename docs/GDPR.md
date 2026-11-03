# Privacy and data protection

Jiangtang is self-hosted software. The person or organisation that runs an instance decides why
personal data is processed, who may access it and how long it is kept. This document describes what
the code actually stores and transmits so that an operator can make those decisions. It is not legal
advice and it does not certify compliance with the GDPR or any other law.

The data model assumes a fresh installation. There is no upgrade path from an older installation's
database or uploads. The generic CSV, Markdown and workspace-JSON importers are data-entry tools,
not an upgrade path.

## Who is responsible for what

- **The operator is the controller.** You choose the deployment, the accounts, the retention
  window, the backup target and any external provider. The software does not create a relationship
  with a hosted service on your behalf.
- **The software ships no vendor account, no hosted service and no telemetry endpoint.** Optional
  integrations are blank in the environment template and stay inactive until you configure them.
- **The application keeps a local audit log and local search index.** Both contain copies of data
  that also exists in the operational tables; erasing a user does not automatically rewrite every
  derived copy (see [Limits of erasure](#limits-of-erasure)).

## Personal data the database holds

| Store | Typical personal data | Source |
| --- | --- | --- |
| `User` | name, email, initials, role, active flag, weekly capacity, optional image URL | `prisma/schema.prisma` |
| `Session` | IP address, user agent, expiry | `prisma/schema.prisma` |
| `Account` | password hash; provider tokens if an external identity provider is configured | `prisma/schema.prisma` |
| `Verification` | pending invitation: email, name and initials in the token payload, expires after 7 days | `app/domains/auth/users.queries.server.ts` |
| Tickets, tasks, notes, projects, time entries | free text written by users, plus reporter/assignee/author/lead references | `prisma/schema.prisma` |
| Events | title, description, organiser and contact free-text fields, room names, times; service windows with a covering user | `prisma/schema.prisma` |
| Vendors | contact name, email, phone, address | `prisma/schema.prisma` |
| Attachments | original filename, creator reference, content type and dimensions; the bytes live outside PostgreSQL | `prisma/schema.prisma` |
| `ActivityLog` | actor id, an actor snapshot (name, email, initials) and a structured detail object | `prisma/schema.prisma`, `app/lib/audit.server.ts` |
| `CalendarOutbox` | a serialized event payload (title, description, room names, times), retained as `PENDING`, `SENT` or `FAILED` rows | `prisma/schema.prisma`, `app/lib/calendar/publisher.server.ts` |
| `Chunk` | a derived text copy of the records above, including vendor contact details, project lead names and ticket/note/task bodies; optional embedding vector | `app/lib/search/sources.server.ts` |

Free-text fields are not classified automatically. A ticket description, event description, note,
vendor record or attachment filename can contain personal data because a user typed it there.

## The append-only audit log

`ActivityLog` is append-only by default. The database revokes `UPDATE` and `DELETE` from `PUBLIC`
and installs a `BEFORE UPDATE OR DELETE` trigger that raises SQLSTATE `23001`
(`restrict_violation`). The trigger is declared `ENABLE ALWAYS`, so it fires even when
`session_replication_role` is set to `replica`.

Two `SECURITY DEFINER` functions are the sanctioned exceptions:

- `pseudonymize_actor(user_id)` rewrites that actor's snapshot to initials only.
- `prune_activity_log(cutoff)` deletes audit rows older than the cutoff.

Both functions set a transaction-local `jiangtang.audit_bypass` flag for their own statements, use
`search_path = pg_catalog, pg_temp`, and are revoked from `PUBLIC`. This is the design implemented in
the `20261023000300_audit_privacy` migration. A test proves that a direct app-role `UPDATE` or
`DELETE` is still rejected while the flag is not set, including under
`session_replication_role = 'replica'` (`app/domains/auth/__tests__/gdpr.test.ts`).

**Database-level limit.** The bypass is a session setting. Anyone who can execute arbitrary SQL as
the application or migration role can set the same flag and disable the guard for their own
transaction. The trigger protects against application bugs and accidental writes; it does not
protect against a hostile database administrator. Do not set the flag outside the
`20261023000300_audit_privacy` migration; the
repository guard (`bash scripts/guards.sh`) rejects `session_replication_role` references in
application code for the same reason.

## Erasure: pseudonymization, not deletion

An administrator uses the two-step erasure page (`/admin/users/<id>/erase`). The admin must type the
target's exact email address, may not erase themselves, and may not erase the last active
administrator. The operation runs in one transaction in `app/domains/auth/gdpr.server.ts`:

1. `pseudonymize_actor` reduces every audit snapshot for that actor to an object containing only
   the initials (an empty object when the user had none) where the snapshot contained a name or
   email. Rows and attribution stay.
2. Ticket reporter links are set to `null` and the user's rows in the ticket assignee relation are
   deleted.
3. Attachment creator links are set to `null`; the attachment records and stored objects stay.
4. The `User` row is scrubbed and deactivated: name becomes `[pseudonymisiert]`, email becomes
   `erased-<id>@erased.local`, initials become `null`, and `isActive` becomes `false`. The rewritten
   email keeps the unique-email constraint satisfied without exposing the original address.
5. An audit row `UserPseudonymized` records which administrator erased which user id, in the same
   transaction.

Deactivated accounts are refused by `requireUser` on the next request
(`app/lib/auth.server.ts`). After the erasure transaction commits, the account's Better Auth
sessions are deleted as well, so no session cookie for the erased account stays valid.

### Limits of erasure

After the operation, the following data can still exist:

- The `User` row itself: id, role, weekly capacity, image URL, email-verified flag and the rewritten
  email. `Account` rows (including the password hash) remain until the operator deletes them. The
  erasure deletes the account's `Session` rows, which held the IP address and user agent.
- Other user references that are not part of the erasure path: project lead and creator,
  task creator and assignees, note author, location/inventory/vendor creator, time-entry user and
  creator, and event service-window covering user. These point at the deactivated user id.
- `ActivityLog` rows. The actor snapshot loses name and email, but the row, its action, its
  timestamps and its `data` object remain. The erasure does not rewrite arbitrary JSON detail in
  other audit rows — for example, a `UserInvited` row records the invitee's email and name.
- Operational content: ticket text, notes, tasks, event organiser/contact text, vendor contact
  details, attachments and filenames, the pending invitation rows, and calendar outbox payloads.
- Derived search chunks and embeddings. There is no automatic reindex when a user is erased, so a
  chunk can keep an old name or contact string until its source record changes and the indexer
  rewrites it.
- Backups. Deleting data in the database does not remove it from existing database backups or from
  upload archives.

Do not describe this operation as full erasure or as a complete response to a deletion request.
An operator handling such a request must review the items above, delete what policy requires, and
record why any remainder is kept.

## Retention

The only automatic retention job is for the audit log. `app/lib/retention.boot.server.ts` runs once
at boot and then daily. It prunes `ActivityLog` rows whose `occurredAt` is older than the cutoff:

- `ACTIVITY_RETENTION_DAYS` sets the window; the default is 2555 days (about seven years). An unset,
  non-numeric or non-positive value falls back to the default rather than failing silently.
- The cutoff is recomputed on every tick from the current time.
- The prune deletes audit rows only. When it deletes at least one row it writes one summary audit
  row (`ActivityLogPruned`) in the same transaction.
- Nothing else is pruned. Sessions and invitation tokens have their own expiry; operational
  records, the search index and attachments remain until deleted through the application or by the
  operator.

The default window is generous. Choosing a shorter window is a deliberate operator decision, and a
shorter window also shortens how long audit detail and old actor snapshots remain available.
Database backups are separate from in-application retention; see
[BACKUP.md](BACKUP.md) and [DEPLOY.md](DEPLOY.md).

## Uploads and encryption keys

Uploads are images (JPEG, PNG or WebP, up to 15 MB) validated by magic bytes and decoded with
`sharp`. The ingest path re-encodes the image, which removes EXIF and GPS metadata, bakes the EXIF
orientation into the pixels, and produces a thumbnail. The original filename is kept as database
metadata; the stored object name is an opaque token.

`app/lib/storage/crypto.server.ts` encrypts every stored object and thumbnail with AES-256-GCM as
`iv | authentication tag | ciphertext`. The key comes from `STORAGE_ENCRYPTION_KEY`:

- 64 hexadecimal characters are used directly. Anything else is treated as a passphrase and
  stretched with scrypt against `STORAGE_KEY_SALT` (or the source-committed default salt).
- Production Compose refuses to render without the variable, and the provider throws if it is asked
  to use a missing key in production. Development falls back to an insecure built-in key and logs a
  warning.
- The key is not stored in PostgreSQL and is not included in database backups. Keep an offline copy;
  a different key or a different salt cannot decrypt existing objects.
- Key custody, rotation and destruction are operator responsibilities. Losing the key makes the
  uploads unreadable, including after a restore.

Only the object key, not the bytes, is stored in PostgreSQL. Backups of the database therefore do
not contain uploads, and a database restore does not restore attachments.

## Data that can leave the installation

Every integration below is off when its variables are empty. Configuring one is an operator decision
and may create a processor relationship that the operator has to document.

### CalDAV push and the iCal feed

With `CALDAV_URL`, `CALDAV_USERNAME` and `CALDAV_PASSWORD` set, the outbox worker pushes one `.ics`
resource per event to the configured collection, using HTTP Basic authentication
(`app/lib/calendar/caldav.server.ts`). The payload contains the event UID, title, description, start
and end times, status/sequence, and the names of the booked rooms. The application stores no external
attendee list; the event's internal service windows (including the covering user) are not part of the
calendar payload. Free text in a title or description can still contain personal data.

With `ICAL_FEED_TOKEN` set, the same event fields are also served as a token-gated `.ics` feed;
anyone who obtains that token can read the feed. The CalDAV collection is written, not read back;
the integration is output-only.

### AI providers

Embedding, reranking and answer generation use OpenAI-compatible HTTP endpoints. They are resolved
from `EMBEDDING_*`, `RERANK_*` and `GENERATION_*` and stay inactive unless a base URL and a model are
both configured (`app/lib/ai/config.server.ts`). With a provider configured:

- Embedding sends chunk text, including any personal data in that text, to `POST /embeddings`.
- Reranking sends the search query and the candidate passages to `POST /rerank`.
- The Ask feature sends the retrieved context to `POST /chat/completions`: up to eight sources, each
  capped at 1500 characters, with a 12,000-character total cap (`app/lib/search/ask.server.ts`).
- The API key, when set, is sent as a Bearer token. Endpoints may be remote or self-hosted.

Without an AI provider, search remains lexical and works on the local index. The index itself is
always local data, even when no provider is configured.

### Error tracking and alerting

- `GLITCHTIP_DSN` enables Sentry-protocol error reporting through `@sentry/node`
  (`app/lib/observability/sentry.server.ts`). It sends exception events and a 20% trace sample. The
  SDK's `dataCollection` option is set so that user info, cookies, HTTP bodies, database query data,
  URL query strings, queue arguments, local variables in stack frames and client-address request
  headers are not sent. Still sent: the request method and path, the other request headers (the
  cookie header is removed and authorization values are replaced with `[Filtered]`), the server host
  name, the runtime and operating-system details the SDK adds, and the exception type, message and
  stack trace without local variable values. In request paths, request header values, span names and
  breadcrumb URLs, the iCal feed token and the invite token are replaced with `:token`; query
  strings and fragments are removed from URLs. The application does not scrub exception messages, so
  data that appears in an error message or stack can be included.
- `ALERT_WEBHOOK` makes the alerting sidecar post a downtime message, including the health response
  body, to a Mattermost- or Slack-compatible webhook (`docker-compose.yml`, `ops/alerting/`).
- Application logs contain request method, path (including query strings) and status, plus error
  details. Keep log storage and access under the same policy as the database.

### Backups

With a WAL-G target configured, PostgreSQL backups — including all personal data in the database —
are uploaded to that object store. Backup retention is a count of full base backups, not a number
of days. Uploads are outside WAL-G. See [BACKUP.md](BACKUP.md) for the complete recovery model.

## Operator responsibilities

At a minimum, an operator should:

- decide the legal basis, publish an appropriate privacy notice, and document processors for every
  configured integration;
- restrict administrative access, protect the environment file, and keep the storage key and backup
  credentials separate from the data they protect;
- choose and document the audit retention window, and delete other records when policy requires it;
- review erasure requests against the limits above instead of treating the admin action as complete;
- test restores, including the key needed to read uploaded files;
- keep the deployment patched and monitor the audit and application logs.

## Where this behaviour is implemented

- Erasure and pruning: `app/domains/auth/gdpr.server.ts`, `app/domains/auth/users.queries.server.ts`,
  `app/routes/_desktop.admin.users.$id_.erase/route.tsx`.
- Audit guard and privileged functions: the `20261023000300_audit_privacy` migration.
- Invariant verification: `ops/postgres/verify-invariants.sql`.
- Retention: `app/lib/retention.boot.server.ts`.
- Calendar: `app/lib/calendar/`.
- Search index: `app/lib/search/`.
- AI providers: `app/lib/ai/`.
- Upload encryption and metadata stripping: `app/lib/storage/crypto.server.ts`,
  `app/lib/storage/image.server.ts`, `app/lib/storage/fs-provider.ts`.
- Behavioural tests: `app/domains/auth/__tests__/gdpr.test.ts`,
  `app/lib/__tests__/retention.test.ts`.
