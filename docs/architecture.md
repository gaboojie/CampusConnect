# CampusConnect Architecture

## Repository layout

- `frontend/` contains the Svelte application and browser-only helpers.
- `backend/` contains the Hono Worker entrypoint, HTTP middleware, authentication helpers, and external-service integration.
- `db/` is the database boundary. It contains the PostgreSQL client wrapper, all SQL-backed repositories, migrations, migration utilities, and database reference material.
- `tests/` contains the application and API tests.
- `public/` contains static assets copied into the Vite build.
- `roles/` holds one page per team member describing their contributions.
- `reports/` is a reserved, intentionally empty directory.

## Database boundary

Production code outside `db/` does not call `.query()` or contain runnable SQL. Backend routes obtain a database client through `db/client.ts` and delegate database work to repositories under `db/repositories/`.

The canonical migration set is:

```text
db/migrations/001_schema.sql
db/migrations/002_seed.sql
db/migrations/003_notification_read.sql
db/migrations/004_login_lockout.sql
```

`003` and `004` are additive (`ADD COLUMN IF NOT EXISTS`), so an existing database is brought up to date with `npm run migrate:dev` or `npm run migrate:prod` and does not need a reset.

Development and production use the same ordered migration files. The `--environment dev|prod` option selects the corresponding connection configuration and does not select a different SQL copy.

## Database commands

```sh
npm run migrate:dev
npm run migrate:prod
npm run db:reset -- --environment dev
```

The reset command is destructive to PostgreSQL only and requires its existing exact confirmation prompt. It does not access or delete Cloudflare R2 objects. Listing-management code handles image deletion separately after verifying the authenticated user owns the listing.

## Credits

Credit logic lives in `db/repositories/credits.ts` and uses only the existing `"User".credit_balance`, `"CreditTransaction"`, `"Resource".required_credits`, and `"Reservation"` columns.

- **Rules** (from the documented seed-data rules): a booking deducts the resource's `required_credits` once; cancelling at least 24 hours before the start (inclusive) refunds the full charge; later cancellations and no-shows are not refunded; availability-change cancellations are always refunded; rescheduling never moves credits; everyone pays, including owners and administrators. Insufficient credits returns HTTP 409. Monthly resets are not implemented.
- **Atomicity**: the reservation insert, the balance update, and the `CreditTransaction` insert run in one PostgreSQL transaction. Each credit write updates the balance and inserts the history row in a single statement (a data-modifying CTE), so they cannot drift apart.
- **Locking**: booking, rescheduling, and cancelling lock `Resource`, then `User`, then the `Reservation` row. Availability changes lock `Resource`, then the affected reservations, then their users (sorted by id). The user row lock serializes each user's credit writes, and the charge's `credit_balance >= cost` guard is a backstop against overspending.
- **Pairing a charge with its reservation**: `CreditTransaction` has no `reservation_id`. A booking stores the transaction's campus time in `Reservation.created_at`, and its charge copies that exact value. A reservation counts as charged only when exactly one reservation and exactly one `reservation_charge` row of that user share the timestamp. A missing match (bookings made before charging existed) or an ambiguous one never produces an automatic refund; ambiguous matches are logged. A booking that would reuse an existing timestamp for the same user is refused with a retryable 409. Matching by amount is never used.
- **Duplicate refunds**: a refund is written only by the transaction that moves the reservation from `confirmed` to `cancelled` (`UPDATE … WHERE status = 'confirmed'` with its row count checked), so each reservation is refunded at most once. Without a reservation link, this is enforced by the application, not by a database constraint; every refund must go through `refundReservationCharge`.
- **API**: `GET /api/credits` (balance and totals) and `GET /api/credits/transactions?page=&pageSize=&type=all|charges|refunds|grants` (20 per page by default). Both use only the session user. Reservation create and cancel responses include a `credits` object.
- **Tests**: `tests/reservations.test.ts` and `tests/credits.test.ts` run in CI with fakes. `tests/integration/credits.pg.test.ts` runs only when `CREDITS_PG_TEST_URL` points at a throwaway database whose name starts with `campusconnect_credits_test`, loaded with `001_schema.sql` and `002_seed.sql`; never point it at the shared dev or production databases.

## Entrypoints and validation

- Vite starts at `frontend/main.ts` through `index.html`.
- Wrangler deploys `backend/index.ts` and serves the generated `dist/` assets.
- `frontend/tsconfig.json` owns frontend Svelte and browser TypeScript settings.
- `backend/tsconfig.json` owns backend, database, and test TypeScript settings.
- Root `tsconfig.json` aggregates the application projects; root `tsconfig.node.json` validates Vite configuration.
- `npm run check` validates the frontend and Vite configuration.
- `npm run typecheck` validates backend, database, and test TypeScript.

`README.md` is intentionally unchanged. Its historical path descriptions may refer to the pre-refactor layout; this document is the current structure reference.
