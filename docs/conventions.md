# Engineering conventions

These are the seams the application is built on. They are small on purpose: changing one of them
changes a guarantee that tests, database constraints or both depend on. The user interface is
available in English and German; code, comments and public documentation are English. Times are
stored in UTC and displayed in `Europe/Berlin`.

## Imports and module boundaries

- Import application code through the `~/*` alias.
- Server-only modules use the `.server.ts` suffix. The bundler keeps them out of the client build;
  do not import them from components.
- Never import `@prisma/client` directly. Use the generated client at `~/generated/prisma/client`.
  `bash scripts/guards.sh` rejects direct imports outside `app/generated/`.
- The single database client is `db` (with the transaction type `Tx`) from `~/lib/db.server`.

## Mutations and the audit funnel

- Every domain mutation runs through `txWithAudit(actor, (tx, audit) => …)` from
  `~/lib/audit.server`. The work and its audit row commit or roll back together.
- Write the audit row with the supplied `audit({ action, entityType, entityId, data? })`. Use the
  constants from `ENTITY_TYPE`; history lookups match their string values case-sensitively.
- Raw `db.$transaction` in `app/domains/` is banned and checked by `scripts/guards.sh`. A new
  transaction helper needs a review, not a local exception.
- `ActivityLog` is append-only. Do not `UPDATE` or `DELETE` it, and do not set the
  `jiangtang.audit_bypass` flag outside the `20261023000300_audit_privacy` migration. The only
  sanctioned writers are
  `pseudonymize_actor` and `prune_activity_log`.
- Bookable atoms (`EventRoomBooking`, `EquipmentAllocation`) are inserted through
  `insertOrConflict(() => …)` from `~/lib/booking.server`, which turns PostgreSQL `23P01` into a typed
  `BookingConflictError` and therefore HTTP 409. The `EXCLUDE` constraints are the authority; a UI
  pre-check is only an accelerator.
- After the transaction resolves, publish the change with
  `emitChange({ entityType, id, op })` from `~/lib/realtime/emit.server`. It issues a PostgreSQL
  `NOTIFY`; calling it before commit can notify subscribers about a rolled-back write.

## Validation and error responses

- `parseForm(request, schema)` from `~/lib/validation.server` returns typed data or throws
  `ValidationError` (HTTP 422). `safeParseForm` returns `{ success, fieldErrors, formErrors }` for
  inline form errors.
- Map exceptions with `toErrorResponse(error)` from `~/lib/errors.server`: validation errors become
  422, `BookingConflictError`/`23P01` become 409, `NotFoundError` becomes 404, a thrown `Response`
  passes through, everything else becomes 500.
- In actions and loaders, wrap the body in `try { … } catch (error) { throw toErrorResponse(error); }`
  so the status reaches the route boundary.

## Route error boundaries

Every feature route, or the layout above it, re-exports the shared boundary:

```tsx
import { RouteErrorBoundary } from "~/components/route-error-boundary";
export { RouteErrorBoundary as ErrorBoundary };
```

A layout-level export catches everything beneath it. Add a leaf export only when that route needs a
different boundary. Pair it with `toErrorResponse` so 404/409/422 are rendered with their real
status.

## Time

- Instants are `timestamptz`; a JavaScript `Date` is a UTC instant.
- Use `~/lib/time.server` for conversions:
  - `berlinLocalToUtc("2026-07-01T10:00")` interprets a `datetime-local` value as Berlin wall-clock.
  - `utcToBerlinLocal(date)` fills a `datetime-local` input from an instant.
- Display with `formatDateTime(locale, date)`, `formatDate`, `formatTime` and `formatRange` from
  `~/i18n/format`: they follow the visitor's language and always use the Europe/Berlin wall clock.
- Booking ranges are half-open `[start, end)`. Back-to-back bookings that only touch do not conflict.

## Internationalisation

- Every user-visible string goes through `useT()` (components) or `t(locale, key)` / `tr(key)`
  (server code). Keys are dot paths grouped by area, for example `rooms.list.empty`.
- Add each key to both `app/i18n/catalog/de/<area>.ts` and `app/i18n/catalog/en/<area>.ts`. The
  German catalog defines the `MessageKey` type, so an unknown key fails `pnpm typecheck`, and
  `app/i18n/__tests__/messages.test.ts` fails when the two key sets or their `{placeholders}` differ.
- Do not concatenate translated fragments. Use `{placeholder}` parameters, and `tRich` from
  `~/i18n/rich` when a placeholder is a React node.
- User-entered data is never translated. Enum values stay stable identifiers; their labels live in
  the catalogs.

## User interface

The interface follows the Fluid Functionalism design rules (fluidfunctionalism.com). The tokens live
in `app/app.css`; the primitives in `app/components/ui/` already apply them.

- Surfaces: a panel is `bg-card shadow-surface-2 rounded-lg`, a popup `shadow-surface-3`, a dialog
  `shadow-surface-5`. Elevation comes from the shadow, not a border. Hover and selected states are
  the `bg-hover` and `bg-selected` overlays.
- One accent, `--fluid-accent`, for focus rings, the switch track and selection details. It is never
  text. Status colors come from `statusToken` in `~/lib/status`.
- Sizes: controls and rows share one height (`h-control`, 36px, or 28px in the compact density).
  `text-xs`, `text-sm`, `text-base`, `text-lg` and `text-xl` map to the caption, body, subtitle,
  title and display roles. Do not use arbitrary font sizes.
- Text uses two colors, `text-foreground` and `text-muted-foreground`, plus `text-destructive` for
  errors. Three weights: normal, `font-semibold` for headings and selected items, `font-bold` for the
  page `<h1>` only. No uppercase or letter-spacing. `font-mono` is for identifiers (asset tags,
  serials, codes); numbers and times use `nums`.
- Motion uses the three tiers in `~/lib/springs` and animates only `transform` and `opacity`. The
  root `MotionConfig` honours reduced motion. Lists of links or buttons may use `useFluidHover`;
  drag boards and virtualized grids do not.

## Slugs

- `deriveSlug(name)` from `~/lib/slug.server` transliterates German characters (`ä` → `ae`,
  `ß` → `ss`). `ensureUniqueSlug(name, exists)` appends `-2`, `-3`, … on collision.
- Use the helper rather than a local slug function so the importer and the self-service forms produce
  the same identifiers.

## Routing and boot modules

- Routing is filesystem-based through `flatRoutes()` in `app/routes.ts`. Never edit that file.
- Desktop routes live under the pathless `_desktop` layout; the mobile PWA uses the `m` prefix.
  Add `app/routes/_desktop.<feature>/route.tsx` and `app/routes/m.<feature>/route.tsx`.
- Boot modules are auto-discovered from `app/**/*.boot.server.ts`. Export
  `register(app, ctx)`; do not edit `server.ts`. Boot modules run in ascending `order` (default 0),
  ties broken by filename. Use a negative order for middleware that must be mounted before routes.
- A boot module that starts a timer must `unref()` it and clear it in `ctx.onShutdown(...)`.

## Storage

- All uploads go through the `StorageProvider` seam in `~/lib/storage`. Store the object key in
  PostgreSQL; never store file bytes in the database.
- The filesystem provider validates magic bytes, accepts JPEG/PNG/WebP up to 15 MB, strips EXIF/GPS
  by re-encoding, and encrypts the object and its thumbnail with AES-256-GCM.
- `STORAGE_ENCRYPTION_KEY` is required in production. A changed key or salt makes existing objects
  unreadable; it is not a cache that can be regenerated.

## Search index

- `Chunk` rows are derived data. The indexer writes them without audit rows; never treat the index as
  the source of truth.
- Source changes trigger a reindex, and a periodic reconcile sweep repairs anything a missed
  notification skipped. If you add a source type, add it to `source-types.ts`,
  `sources.server.ts` and the realtime mapping.
- Embeddings are optional. Without an AI provider the lexical arm still works; the index must not
  require an external service to function.
- The index contains copies of user-entered text. When you add a field to a source document, assume
  it is searchable and therefore copied.

## Migrations and SQL invariants

- Migrations are canonical and append-only. Do not edit, rename, squash or reorder a migration that
  has been applied anywhere. Add a new migration instead.
- Prisma cannot express triggers, `SECURITY DEFINER` functions, generated columns, `EXCLUDE`
  constraints or `ENABLE ALWAYS`. Those statements are hand-written into the baseline's own
  `migration.sql` files (`prisma/migrations/20261023000100_core_schema` through
  `20261023000600_time_tracking_constraints`), beside the Prisma-generated ones.
- The generated `during` column carries both booking `EXCLUDE` constraints. Never drop it;
  `scripts/guards.sh` fails a migration that contains an executable `DROP COLUMN "during"`.
- The `20261023000300_audit_privacy` migration defines the audit guard, the privileged functions
  and the `jiangtang.audit_bypass` flag. Do not reintroduce `session_replication_role` as a bypass.
- `ops/postgres/verify-invariants.sql` runs after `prisma migrate deploy` and fails the deploy when
  an unmodelled invariant is missing. When you add one, add its catalog check there too.
- `prisma.config.ts` derives a shadow database for `migrate dev`. It must never equal
  `DATABASE_URL`, because equality resets the development database.

## Checks before review

- `bash scripts/guards.sh` for the architectural guards. Run `bash scripts/guards.sh --self-test`
  when you touch the guard itself.
- `pnpm typecheck`, `pnpm lint` and the relevant Vitest files. A database-backed change needs a test
  that exercises the constraint or transaction, not only a unit mock.
- Formatting is described in [CONTRIBUTING.md](../CONTRIBUTING.md). Do not mix a repository-wide
  reformat into a functional change.
