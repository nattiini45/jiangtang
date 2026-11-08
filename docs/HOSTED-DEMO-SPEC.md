# Hosted read-only demo — operations spec

Status: **specification only.** This project does not operate a hosted demo; this document is the
runbook an operator follows to run one. (The plan's locked decision §12.1 makes a public landing
and a hosted demo in scope; the landing page ships at `/welcome`, opt-in with
`LANDING_PAGE_ENABLED=1`, and the demo infrastructure is the operator's.)

## Goal

A public, read-only demo of Jiangtang at a hostname of the operator's choosing, seeded with the
demo data, reset periodically, and never writable by visitors.

## Shape

1. **One deployment of the app** per demo, reusing the production Compose stack
   ([DEPLOY.md](DEPLOY.md)): app container + PostgreSQL 18 (pgvector/pg_trgm) + Caddy for TLS.
2. **Read-only enforcement at the edge**: run Caddy with a rule that answers `POST`/`PUT`/`PATCH`/
   `DELETE` with `405` for the demo host, except `POST /api/auth/sign-in/email` and
   `POST /logout` (visitors may still sign in to a demo account to see the full UI; their writes
   are discarded by the reset). Alternatively run the app with a `READ_ONLY_DEMO=1` env flag that
   makes every action return 405 — the flag does not exist yet; implementing it is a small
   follow-up in `server.ts`'s middleware chain.
3. **Demo account**: a single seeded `demo@…` member account (not admin), created by the seed.
   Its credentials are printed on the landing page's sign-in card or the demo banner.
4. **Periodic reset**: a cron job (host-side or a sidecar container) that runs
   `pnpm db:deploy` is NOT needed at runtime; the reset is `psql -c 'DROP SCHEMA public CASCADE;
   CREATE SCHEMA public'` + grants + `DATABASE_URL=… pnpm db:deploy && DATABASE_URL=…
   DEFAULT_LOCALE=de pnpm db:seed` — the same three steps as a fresh install, because
   [README's limitations](../README.md) state fresh installations only. Run it nightly; schedule
   it outside the demo's advertised uptime window if brief downtime is unacceptable, or use a
   blue/green pair of databases behind a pgbouncer-style switch.
5. **No uploads of value**: the demo's object storage is a local disk volume on the demo host,
   wiped with the database reset.
6. **Rate limiting**: Caddy `rate_limit` zone on `/api/*` and `/login` (the auth throttle already
   keys on `X-Forwarded-For`; make sure Caddy passes it — it does by default).
7. **TLS**: Caddy's automatic HTTPS with a real hostname; the demo host must be a real DNS name.
8. **Observability**: the app's `/healthz` for the load balancer; logs to stdout; optional
   Sentry via the documented env vars, with the demo DSN separate from any real deployment.
9. **Legal**: the landing page already states self-hosting; the demo host should link the
   repository's `SECURITY.md` for responsible disclosure and carry a "demo data is reset nightly"
   note.

## Out of scope

- Multi-tenant serving of many customers from one install (see the multi-tenancy design doc when
  it lands), signup flows, billing, and any write access for visitors.
