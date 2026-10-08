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

The repository uses one GitHub deployment environment: `production`. It deploys the `production` section of `wrangler.jsonc` to the production Worker, which connects to Neon `main` through Hyperdrive and uses the production R2 bucket and configured `workers.dev` URL.

The `dev` branch is shared and does not require pull requests. Pushes to `dev` run the validation job only. Developers use local Workers with the shared Neon `dev` database; no separate deployed dev Worker or GitHub `dev` environment is required.

Production releases follow this procedure:

1. Push changes to `dev` and review the validation result.
2. Open a pull request from `dev` into protected `main`.
3. Wait for the validation status check to pass and obtain the required review.
4. Merge the pull request. Direct pushes to `main` are disabled.
5. The merge creates a push to `main`, which starts `.github/workflows/ci-cd.yml`.
6. The workflow validates the project, deploys the production Worker, and runs health and integration smoke checks. It does not modify the production database.
7. Confirm the workflow succeeds and verify the production site.

Configure the GitHub `production` environment with a required reviewer and these secrets:

- `CLOUDFLARE_API_TOKEN`: scoped to the CampusConnect Cloudflare account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account containing the Worker.

Add this environment variable:

```text
APP_ORIGIN=https://campusconnect-production.vt-campusconnect.workers.dev
```

Set `SESSION_SECRET` directly on the production Worker with Wrangler. It is not a GitHub Actions variable and is never passed to the frontend.

The production site is:

```text
https://campusconnect-production.vt-campusconnect.workers.dev/
```

## Migrations and environment variables

- `migrations/dev/` contains SQL for Neon `dev` and is applied manually by the designated maintainer when the shared dev schema changes.
- `migrations/prod/` contains production-safe SQL for Neon `main` and runs separately with `npm run migrate:prod`.
- `scripts/migrate.ts` applies files in order and records applied versions in `schema_migrations`.
- Never run dev migrations against Neon `main` or production migrations against Neon `dev` without reviewing them.
- The production GitHub Action never runs database migrations. A designated maintainer must run production migrations separately after review, a restore point, and explicit approval.
- The designated maintainer can run a production migration from a secure terminal with `npm run migrate:prod -- --database-url "$DATABASE_URL"`, then unset `DATABASE_URL`.
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
tests/                       Vitest application smoke tests
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
.github/workflows/ci-cd.yml  Validation and production deployment workflow
```
