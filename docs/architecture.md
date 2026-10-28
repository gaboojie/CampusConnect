# CampusConnect Architecture

## Repository layout

- `frontend/` contains the Svelte application and browser-only helpers.
- `backend/` contains the Hono Worker entrypoint, HTTP middleware, authentication helpers, and external-service integration.
- `db/` is the database boundary. It contains the PostgreSQL client wrapper, all SQL-backed repositories, migrations, migration utilities, and database reference material.
- `tests/` contains the application and API tests.
- `public/` contains static assets copied into the Vite build.
- `reports/` and `roles/` are reserved, intentionally empty directories.

## Database boundary

Production code outside `db/` does not call `.query()` or contain runnable SQL. Backend routes obtain a database client through `db/client.ts` and delegate database work to repositories under `db/repositories/`.

The canonical migration set is:

```text
db/migrations/001_schema.sql
db/migrations/002_seed.sql
```

Development and production use the same ordered migration files. The `--environment dev|prod` option selects the corresponding connection configuration and does not select a different SQL copy.

## Database commands

```sh
npm run migrate:dev
npm run migrate:prod
npm run db:reset -- --environment dev
```

The reset command is destructive to PostgreSQL only and requires its existing exact confirmation prompt. It does not access or delete Cloudflare R2 objects. Listing-management code handles image deletion separately after verifying the authenticated user owns the listing.

## Entrypoints and validation

- Vite starts at `frontend/main.ts` through `index.html`.
- Wrangler deploys `backend/index.ts` and serves the generated `dist/` assets.
- `frontend/tsconfig.json` owns frontend Svelte and browser TypeScript settings.
- `backend/tsconfig.json` owns backend, database, and test TypeScript settings.
- Root `tsconfig.json` aggregates the application projects; root `tsconfig.node.json` validates Vite configuration.
- `npm run check` validates the frontend and Vite configuration.
- `npm run typecheck` validates backend, database, and test TypeScript.

`README.md` is intentionally unchanged. Its historical path descriptions may refer to the pre-refactor layout; this document is the current structure reference.
