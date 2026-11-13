# Backend changes: password change and admin panel

This document covers every backend change made for the profile dropdown and
password change, and for the admin panel. Frontend changes are listed briefly at
the end. **No database schema or migration changes were made.**

## Summary

| Area | File | Change |
| --- | --- | --- |
| Auth | `worker/auth.ts` | **Edited**: new `validateChangePasswordInput` and its types |
| Auth | `worker/index.ts` | **Edited**: new `POST /api/auth/change-password` |
| Admin | `worker/admin.ts` | **New**: read-only queries and query validation for the admin API |
| Admin | `worker/index.ts` | **Edited**: admin role guard and four `GET /api/admin/*` routes (placed before the static-asset catch-all) |
| Tests | `tests/admin.test.ts` | **New**: 17 tests for the admin API |
| Tests | `tests/auth.test.ts` | **Edited**: one test for password-change validation |
| Tests | `tests/support/fakeReadDatabase.ts` | **Edited**: test helper (see below) |

`worker/auth.ts` only gained the validator; the change-password endpoint reuses
its existing `hashPassword`, `verifyPassword` and `hashSessionToken`.

Code layout follows the existing files: request validation lives in `auth.ts`
(like `validateSignupInput`), each route is an inline handler in `index.ts` with
the same `databaseUnavailable` / `withDatabase` / `try-catch` shape as the other
routes, and the admin queries sit in their own module like `announcements.ts`
and `reservations.ts`.

`wrangler.jsonc` was already modified before this work (the `"remote": true`
line was removed from the R2 binding). It is not part of these changes.

---

## 1. Change password

### `POST /api/auth/change-password` (`worker/index.ts`)

Requires a logged-in session (it is not in `PUBLIC_API_PATHS`, so the global
auth middleware protects it).

**Request body (JSON)**

```json
{ "currentPassword": "...", "newPassword": "...", "confirmPassword": "..." }
```

**Validation (HTTP 400 with `{ error, fieldErrors }`)**

| Field | Rule |
| --- | --- |
| `currentPassword` | Required |
| `newPassword` | 8–128 characters; must differ from the current password |
| `confirmPassword` | Must equal `newPassword` |

**Behaviour**

0. `validateChangePasswordInput` (in `worker/auth.ts`) checks the body.
1. Loads the caller's `password_hash` from `"User"` (user id comes from the
   session, never from the request body).
2. Verifies `currentPassword` against it. If wrong: HTTP 400,
   `fieldErrors.currentPassword = "Your current password is incorrect."`.
3. Inside one transaction (`BEGIN` / `COMMIT`, `ROLLBACK` on error):
   - `UPDATE "User" SET password_hash = <new pbkdf2 hash>`
   - `DELETE FROM "Session"` for this user **except the current session**, so
     other devices are signed out and this one stays logged in.
4. Returns `200 { "message": "Your password has been updated." }`.

**Other responses**: `401` no or expired session, `503` database error or
database not configured.

---

## 2. Admin API

### Access control (`worker/index.ts`)

`app.use("/api/admin/*", ...)` runs after the global authentication middleware.
If `c.get("user").role !== "admin"` it returns
`403 { "error": "Administrator access required." }` and **no database query for
the requested data is made**. An unauthenticated request gets `401` from the
global middleware first.

The "admin" role is the existing `"User".role` column (values in use:
`student`, `staff`, `admin`). The seeded account `cc_admin` has role `admin`.
To make another account an admin:

```sql
UPDATE "User" SET role = 'admin' WHERE username = '<username>';
```

All admin routes are **read-only**. Responses never include `password_hash`,
session tokens or verification tokens.

### Routes

All list routes take `page` (default 1) and `pageSize` (default 25, max 100) and
return `{ items, total, page, pageSize }`. Invalid parameters return `400`.

| Method and path | Query parameters | Returns |
| --- | --- | --- |
| `GET /api/admin/stats` | none | `{ stats: { users: { total, verified, unverified, banned, byRole }, resources: { total }, reservations: { total, byStatus } } }` |
| `GET /api/admin/users` | `search` (username or email, case-insensitive), `role` (`student`/`staff`/`admin`), `status` (`active`/`unverified`/`banned`), `page`, `pageSize` | page of users, newest first |
| `GET /api/admin/users/:id` | none | `{ user }` with extra `creditLastReset`, `resourcesOwned`, `reservationCounts`; `404` if not found, `400` if the id is invalid |
| `GET /api/admin/reservations` | `status` (`confirmed`/`active`/`completed`/`cancelled`), `page`, `pageSize` | page of reservations with user and resource, latest start first |

**User object fields**: `userId`, `username`, `email`, `phoneNumber`, `role`,
`createdAt`, `emailVerifiedAt`, `creditBalance`, `isBanned`, `canAddResources`,
`emailNotificationsOn`, `textNotificationsOn`, and a derived `status`:

- `banned` if `is_banned` is true
- otherwise `unverified` if `email_verified_at` is null
- otherwise `active`

### `worker/admin.ts` (new)

- **Validation**: `parseAdminUserQuery`, `parseAdminReservationQuery`,
  shared paging rules and allow-lists for role and status.
- **Queries**: `listUsers`, `getUserDetail`, `listReservations`,
  `getStats`.
- **Safety**: every value is passed as a bound parameter (`$1`, `$2`, …); no SQL
  is built from user input. `%`, `_` and `\` in the search term are escaped so
  they match literally.
- **Totals**: list queries use `COUNT(*) OVER()` so the total comes back in the
  same query as the page.
- **Timestamps**: reservation and resource times are returned as campus
  wall-clock strings without a time zone suffix (same convention as the existing
  resource and announcement APIs). User timestamps are ISO strings.
- **Routes in `worker/index.ts`**: each handler checks the `DB` binding
  (`503 "Database is not configured"`), calls `withDatabase`, and maps a query
  failure to `503` with a route-specific message, like the existing routes.

---

## 3. Tests

`tests/admin.test.ts` (new, 17 tests) covers:

- query validation (defaults, page-size cap, rejected role/status/page values)
- `401` without a session; `403` for `student` and `staff` on every admin route,
  with no data query run
- user list: filters passed as bound parameters, total/page, derived status,
  no `password`/`token` in the response, read-only SQL, LIKE escaping
- user detail: counts, `404`, `400`
- stats and reservations shapes
- `503` when a query fails

`tests/auth.test.ts` (edited): adds "validates password changes" for
`validateChangePasswordInput`.

`tests/support/fakeReadDatabase.ts` (edited, test helper only):

- the session-lookup responder now also requires `FROM "Session"` in the SQL, so
  admin queries that begin with `SELECT u.user_id` are not mistaken for it
- new `sessionRole` property (default `student`) so tests can sign in as an admin

Result: 6 test files, 136 tests passing. The change-password route itself has no
automated test yet (only its validator).

---

## 4. Frontend changes (for reference)

- **Profile dropdown**: `src/components/ProfileMenu.svelte` (new) with Profile
  details, Admin panel (admins only), Back to CampusConnect (inside admin), and
  Sign out. Wired into `src/App.svelte`; styles in `src/app.css`.
- **Profile page**: `src/components/sections/ProfileSection.svelte` now has a
  change-password form that calls `POST /api/auth/change-password`.
- **Admin panel**, served at the path `/admin` (the existing single-page-app
  fallback in `wrangler.jsonc` already serves `index.html` for it). Pages use
  hash routes inside it: `/admin#/overview`, `#/users`, `#/users/<id>`,
  `#/reservations`, and `#/resources` (a "Coming soon" page with no backend).
  - `src/lib/adminRoutes.ts`, `src/components/AdminLayout.svelte` (mirrors
    `routes.ts` and `AppLayout.svelte`)
  - `src/components/sections/` gains `AdminOverviewSection`,
    `AdminUsersSection`, `AdminUserDetailSection`, `AdminReservationsSection`;
    shared `src/components/Pagination.svelte`
  - `src/components/Sidebar.svelte` now accepts a `hrefFor` prop so it can serve
    both the app and the admin panel.
  - Types added to `src/lib/types.ts`.
- A non-admin who opens `/admin` sees an "Administrator access required" page,
  and the API refuses them with `403` regardless.

## 5. Not included

- No admin write actions (ban/unban, role changes, credit edits). Say if you want
  these; they would need new `PATCH` routes and audit consideration.
- No schema changes or migrations.
