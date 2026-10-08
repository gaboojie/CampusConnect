# CampusConnect

CampusConnect is a resource sharing project for Virginia Tech's CS 5614: Database Management Systems. Do not use, commit, or share sensitive personal data, credentials, or real user records. 

_Authors: Faria Binta Awal, Ashwaq Alaklabi, Rokeshuvaraj Nagarajan, & Gabriel Jackson._

## Requirements

- Node.js 22 or newer, specified by `.nvmrc`.
- Npm 10 or newer, specified in `package.json`.
- Project dependencies, specified in `package.json` and locked in `package-lock.json`.

## Local development

1. Clone the repository and enter the project directory.
2. Install the locked dependencies:

   ```sh
   npm ci
   ```

3. Create the local environment file:

   ```sh
   cp .env.dev.example .env.dev
   ```

4. Ask the project owner for access to the Cloudflare account and Neon project. Use the Neon `dev` branch only.
5. Fill `.env.dev` with:
   - `SESSION_SECRET`: a local-only value - generate one with `openssl rand -hex 32`.
   - `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`: the Neon `dev` branch connection string with TLS enabled. It must have the pooled option as unselected.
6. Authenticate Wrangler, which is used to speak with Cloudflare (you need a Cloudflare account):

   ```sh
   npx wrangler login
   ```

7. Do not apply dev migrations for every clone.

8. Start the local worker:

   ```sh
   npm run worker:dev
   ```

9. Open `http://localhost:8787/` to view the locally-hosted web application.

Run project checks with:

```sh
npm run check
npm run typecheck
npm run build
```

The dev Worker uses the Cloudflare resources named in the `dev` section of `wrangler.jsonc`. Teammates need to be added to the Cloudflare account to gain access to these resources.

## Remote deployment

Production uses the `production` section of `wrangler.jsonc`, Neon `main`, the production R2 bucket, the production Hyperdrive ID, and the configured `workers.dev` URL.

Routine production releases are merge-driven:

1. When the change is ready for release, open a pull request from `dev` into protected `main`.
2. Obtain the required review and merge the pull request into `main`. Direct pushes to `main` are disabled.
3. The GitHub Action triggered by the merge validates the project, applies `migrations/prod/` to Neon `main`, deploys the production Worker, and runs production health and integration checks.
4. Confirm the action succeeds and verify the production site.

The GitHub `production` environment should require an approved reviewer and contain the Cloudflare deployment credentials and Neon `main` migration credential. 

The production site is:

```text
https://campusconnect-production.vt-campusconnect.workers.dev/
```

## Migrations and environment variables

- `migrations/dev/` contains SQL for Neon `dev` and runs with `npm run migrate:dev`.
- `migrations/prod/` contains production-safe SQL for Neon `main` and runs with `npm run migrate:prod`.
- `scripts/migrate.ts` applies files in order and records applied versions in `schema_migrations`.
- Never run dev migrations against Neon `main` or production migrations against Neon `dev` without reviewing them.
- `.env.dev` and `.env.prod` are ignored and must never be committed.
- `.env.dev.example` documents local Worker values.
- `.env.prod.example` documents the migration-only `DATABASE_URL`.
- `SESSION_SECRET` is a Cloudflare Worker secret, not a value in `wrangler.jsonc` or the frontend.
- `wrangler.jsonc` contains non-secret environment values, R2 bucket names, Hyperdrive IDs, and Worker settings.

## Project structure

```text
src/                         Svelte frontend
src/App.svelte               Environment-aware R2/database integration page
src/app.css                  Frontend styles
worker/index.ts              Hono Worker API, health check, and asset fallback
migrations/dev/              Development SQL migrations
migrations/prod/             Production SQL migrations
scripts/migrate.ts           Transactional migration runner
scripts/fixtures/            R2 smoke-test files
wrangler.jsonc               Cloudflare Worker, R2, Hyperdrive, and environment config
package.json                 npm scripts and dependency ranges
package-lock.json            Locked npm dependency versions
.env.dev.example             Local development variable template
.env.prod.example            Production migration variable template
.nvmrc                       Recommended Node.js major version
```
