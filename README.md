# CampusConnect

CampusConnect is a resource sharing project for Virginia Tech's CS 5614: Database Management Systems. Do not use, commit, or share sensitive personal data, credentials, or real user records. 

_Authors: Faria Binta Awal, Ashwaq Alaklabi, Rokeshuvaraj Nagarajan, & Gabriel Jackson._

## Features

- **Accounts:** sign up with a `@vt.edu` address and verify it by email. Sessions use an HttpOnly cookie. After five wrong passwords in a row, an account is locked for five minutes and the sign-in form says how long to wait.
- **Browse resources:** search and filter campus resources by type, building, date, time, and availability. Each resource page shows its location, features, weekly hours, maintenance, and reviews.
- **Availability calendar:** every resource page has a day grid of half-hour slots. Available, booked, your own, maintenance, and closed times are colored differently. Clicking an available slot opens the reservation form, prefilled with up to two hours (shortened to the gap before the next booking, maintenance, or closing time).
- **Reservations and credits:** reserve, reschedule, and cancel. Each booking costs credits, and cancellations are refunded.
- **Listings:** members who may add resources can create and manage their own listings, including images stored in Cloudflare R2.
- **Notifications:** email reminders and cancellation notices are sent through Cloudflare Workflows. The bell in the top bar opens an in-app dropdown with an unread count, per-item and bulk "mark as read", and an All/Unread filter. Review tasks appear as in-app notifications.
- **Announcements:** current maintenance notices, newly listed resources, and a centralized Reviews tab for pending resource and reservation reviews.
- **Maps:** an interactive Google Maps view of Virginia Tech's Blacksburg campus, centered on the Drillfield.
- **Admin panel** (`/admin`, admins only):
  - Overview with charts of activity, reservation status, and user roles.
  - Users: create, edit, ban or unban, promote or demote, and delete accounts.
  - Resources: view details and delete (upcoming reservations are cancelled and refunded, and the people affected are notified).
  - Reservations: a calendar of every resource's bookings, or a list view.

## Screenshots

Screenshots have not been added yet. Save images in `docs/screenshots/` and link them here. Suggested set: sign-in, browse resources, a resource page with its availability calendar, the notifications dropdown, and the admin overview.

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
   - `RESEND_API_KEY`: the development-only Resend sending key.
   - `RESEND_FROM_EMAIL`: a verified development sender address.
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

   This builds the frontend assets before starting Wrangler.

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
6. The workflow validates the project, deploys the production Worker, and checks the Neon database health endpoint. It does not modify the production database.
7. Confirm the workflow succeeds and verify the production site.

Configure the GitHub `production` environment with a required reviewer and these secrets:

- `CLOUDFLARE_API_TOKEN`: scoped to the CampusConnect Cloudflare account.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account containing the Worker.

Add this environment variable:

```text
APP_ORIGIN=https://campusconnect-production.vt-campusconnect.workers.dev
```

Set the production Resend values directly on the production Worker as well:

```sh
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put RESEND_FROM_EMAIL --env production
```

Use a separate sending key and sender for local development. Do not use a production Resend key in `.env.dev`.

The production site is:

```text
https://campusconnect-production.vt-campusconnect.workers.dev/
```

## Migrations and environment variables

- `db/migrations/` holds one ordered set of SQL files shared by every environment. `--environment dev|prod` only chooses which database the runner connects to.
- `001_schema.sql` is the single source of truth for the complete database schema, including notification read state, login lockout, review relationships, and review-notification idempotency.
- `002_seed.sql` inserts the synthetic grading/demo data after the schema is created.
- Because the schema is intentionally centralized, schema changes require updating `001_schema.sql` and recreating the target database; there are no additive schema migrations.
- `db/scripts/migrate.ts` applies files in order and records applied versions in `schema_migrations`, so already-applied files are skipped.
- `npm run migrate:dev` and `npm run migrate:prod` automatically use `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` from `.env.dev` or `.env.prod`, respectively. For example:

  ```sh
  npm run migrate:dev
  ```

- `db/scripts/reset-database.ts` can drop all tables in the selected database after an exact confirmation prompt. Use it only for an intentional reset.
- Database reset is PostgreSQL-only and never deletes or modifies objects in either Cloudflare R2 bucket. R2 images are deleted only through the authenticated listing-management flow after ownership is verified.
- Both dev and prod database commands use `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` from the selected environment file. For production, verify the Neon `main` connection string in `.env.prod` before running the command:

  ```sh
  npm run migrate:prod
  ```

- If a database still has an older migration history (for example `001_init`, `003_authentication`, or `004_email_verification`), those version names no longer match the files in `db/migrations/`. Reset that database before running the migrations.
- Never run dev migrations against Neon `main` or production migrations against Neon `dev` without reviewing them.
- The production GitHub Action never runs database migrations. A designated maintainer must run production migrations separately after review, a restore point, and explicit approval.
- The designated maintainer can run a production migration from a secure terminal using `.env.prod`; production migrations must target Neon `main`, not the dev branch.
- `.env.dev` and `.env.prod` are ignored and must never be committed.
- `.env.dev.example` documents local Worker values.
- `.env.prod.example` documents the migration-only `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`.
- `GOOGLE_MAPS_JAVASCRIPT_API_KEY` is an optional Worker secret used by the authenticated Maps tab. Add it to `.env.dev` for local development. For production, create a restricted Maps JavaScript API key and run `npx wrangler secret put GOOGLE_MAPS_JAVASCRIPT_API_KEY --env production`.
- `GOOGLE_MAPS_MAP_ID` is a public map configuration value declared in `wrangler.jsonc`. Replace `DEMO_MAP_ID` with a production JavaScript Map ID before adding Advanced Markers.
- `GOOGLE_PLACES_API_KEY` is a server-only Worker secret used only after a user selects a CampusConnect building with a stored Google Place ID. Restrict it to Places API (New), add it to `.env.dev` for local development, and configure production with `npx wrangler secret put GOOGLE_PLACES_API_KEY --env production`. It is never returned to the browser.
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL` are server-only Worker secrets and must be configured separately for dev and production. Do not share or commit them.
- `wrangler.jsonc` contains non-secret environment values, R2 bucket names, Hyperdrive IDs, and Worker settings.

## Authentication prototype

The public landing page provides login and signup for `@vt.edu` addresses. New accounts must verify their email before receiving a seven-day, HttpOnly session cookie backed by the `"Session"` table. Verification tokens are single-use and have no timestamp-based expiration. Seeded demo accounts use the shared demo password documented in `002_seed.sql`.

The authentication API is:

- `POST /api/auth/signup`
- `POST /api/auth/verify-email`
- `POST /api/auth/resend-verification`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

The Neon database health endpoint remains public. Other `/api/*` requests require a valid session.

After five consecutive wrong passwords for a verified account, `POST /api/auth/login` answers `429` with a `Retry-After` header and the message "Too many failed sign-in attempts. Please wait 5 minutes before trying again." Even the correct password is refused until the lock ends. A successful sign-in resets the count. Attempts on unknown usernames or unverified accounts are not counted.

Other signed-in routes include `GET /api/calendar` (day availability), `GET /api/notifications` with `POST /api/notifications/:id/read` and `POST /api/notifications/read-all` (the notifications dropdown), and the admin-only `/api/admin/*` routes.

To reset the dev database, the command automatically uses `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` from `.env.dev`; confirm the prompt when asked:

```sh
npm run db:reset -- --environment dev
```

To reset production, run the command below, then type `RESET PROD` when prompted. It automatically uses `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` from `.env.prod`; verify the Neon branch and database before confirming.

```sh
npm run db:reset -- --environment prod
```

To administer a user, provide exactly one username, one action, and the target environment. The command loads the connection string from the selected `.env.dev` or `.env.prod` file:

```sh
npm run admin:command -- --user maya_r --ban true --env dev
npm run admin:command -- --user maya_r --delete --env dev
npm run admin:command -- --user maya_r --can_add_resources false --env dev
npm run admin:command -- --user maya_r --role admin --env prod
```

The command accepts exactly one action: `--ban true|false`, `--delete`, `--can_add_resources true|false`, or `--role admin|user`. The `user` role maps to the database's `student` role. Use `--help` to print the full usage text. Deletion permanently removes the user and dependent database rows, including credit transactions; SQL cannot remove corresponding R2 image objects.

If email delivery is unavailable, an administrator can verify one active user directly in PostgreSQL:

```sh
npm run verify:user-email -- --user maya_r --env dev
npm run verify:user-email -- --user maya_r --env prod
```

This command requires both `--user` and `--env`, loads only the selected environment's connection string, locks the matching user row, sets `email_verified_at` to the database timestamp, and invalidates any unused email-verification token. It refuses banned or deleted accounts and does not create a session or change any other account fields.

## Project structure

```text
README.md                    Project description, features, and setup instructions
docs/                        Architecture notes, diagrams, and report materials
db/                          Database boundary
db/client.ts                 PostgreSQL client wrapper
db/repositories/             All SQL-backed queries (admin, auth, calendar, inbox, notifications, resources, ...)
db/migrations/               Ordered SQL: schema, seed data, notification read state, login lockout, review backfill
db/scripts/                  migrate.ts, reset-database.ts, and admin-command.ts
db/reference/                Seed images and data-source notes
backend/                     Server-side code
backend/index.ts             Hono Worker API, middleware, and asset fallback
backend/auth.ts              Password, session-token, and signup validation helpers
backend/notification-workflow.ts  Cloudflare Workflow that sends notification emails
frontend/                    Svelte interface
frontend/App.svelte          Header, sign-in and sign-up, and the app/admin switch
frontend/components/         Layouts, sections, calendar, charts, dialogs, and the notification bell
frontend/lib/                API client, routes, shared types, and formatting helpers
frontend/app.css             Frontend styles
roles/                       Each member's contributions (one page per member)
reports/                     Reserved for report files
tests/                       Vitest application and API tests
public/                      Static assets copied into the build
wrangler.jsonc               Cloudflare Worker, R2, Hyperdrive, and environment config
package.json                 npm scripts and dependency ranges
package-lock.json            Locked npm dependency versions
.env.dev.example             Local development variable template
.env.prod.example            Production migration variable template
.nvmrc                       Recommended Node.js major version
.github/workflows/ci-cd.yml  Validation and production deployment workflow
```
