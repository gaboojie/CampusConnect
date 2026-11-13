import type { DatabaseClient } from "../client";
import { isVtEmail } from "../../backend/auth";
import { deleteAccount } from "./auth";
import {
  createReservationCancellationNotification,
  skipPendingReservationReminders,
} from "./notifications";
import {
  CAMPUS_NOW_SQL,
  getResourceDetails,
  localTimestampSql,
  type ResourceDetails,
  type Validation,
} from "./resources";

// Queries and writes behind the /api/admin/* endpoints. The password hash, session
// tokens and verification tokens are never selected.

export const ADMIN_ROLES = ["student", "staff", "admin"] as const;
export const USER_STATUSES = ["active", "banned", "unverified"] as const;
export const RESERVATION_STATUSES = ["confirmed", "active", "completed", "cancelled"] as const;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export type PageQuery = { page: number; pageSize: number };

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminUserQuery = PageQuery & {
  search: string;
  role: string | null;
  status: string | null;
};

export type AdminReservationQuery = PageQuery & { status: string | null };

export type AdminUser = {
  userId: number;
  username: string;
  email: string;
  role: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  creditBalance: number;
  isBanned: boolean;
  canAddResources: boolean;
  emailNotificationsOn: boolean;
  status: string;
};

export type AdminUserDetail = AdminUser & {
  creditLastReset: string;
  resourcesOwned: number;
  reservationCounts: Record<string, number>;
};

export type AdminReservation = {
  id: number;
  status: string;
  startTime: string;
  endTime: string;
  createdAt: string;
  user: { id: number; username: string };
  resource: { id: number; name: string };
};

export type AdminStats = {
  users: { total: number; verified: number; unverified: number; banned: number; byRole: Record<string, number> };
  resources: { total: number };
  reservations: { total: number; byStatus: Record<string, number> };
  // Bookings made and accounts created per campus day, oldest first.
  activity: Array<{ date: string; reservations: number; signups: number }>;
};

function parsePage(params: URLSearchParams): Validation<PageQuery> {
  const pageRaw = (params.get("page") ?? "").trim();
  const sizeRaw = (params.get("pageSize") ?? "").trim();

  if (pageRaw && (!/^\d+$/.test(pageRaw) || Number(pageRaw) < 1)) {
    return { ok: false, error: "Page must be a positive whole number." };
  }
  if (sizeRaw && (!/^\d+$/.test(sizeRaw) || Number(sizeRaw) < 1)) {
    return { ok: false, error: "Page size must be a positive whole number." };
  }

  return {
    ok: true,
    value: {
      page: pageRaw ? Number(pageRaw) : 1,
      pageSize: sizeRaw ? Math.min(Number(sizeRaw), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
    },
  };
}

export function parseAdminUserQuery(params: URLSearchParams): Validation<AdminUserQuery> {
  const page = parsePage(params);
  if (!page.ok) return page;

  const role = (params.get("role") ?? "").trim();
  const status = (params.get("status") ?? "").trim();

  if (role && !ADMIN_ROLES.includes(role as (typeof ADMIN_ROLES)[number])) {
    return { ok: false, error: "Role must be one of: student, staff, admin." };
  }
  if (status && !USER_STATUSES.includes(status as (typeof USER_STATUSES)[number])) {
    return { ok: false, error: "Status must be one of: active, banned, unverified." };
  }

  return {
    ok: true,
    value: {
      ...page.value,
      search: (params.get("search") ?? "").trim().slice(0, 100),
      role: role || null,
      status: status || null,
    },
  };
}

export function parseAdminReservationQuery(
  params: URLSearchParams,
): Validation<AdminReservationQuery> {
  const page = parsePage(params);
  if (!page.ok) return page;

  const status = (params.get("status") ?? "").trim();
  if (status && !RESERVATION_STATUSES.includes(status as (typeof RESERVATION_STATUSES)[number])) {
    return { ok: false, error: "Status must be one of: confirmed, active, completed, cancelled." };
  }

  return { ok: true, value: { ...page.value, status: status || null } };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

// Campus wall-clock timestamps are returned without a time zone suffix.
function wallClock(value: string | Date): string {
  return typeof value === "string" ? value.slice(0, 19).replace(" ", "T") : value.toISOString().slice(0, 19);
}

type UserRow = {
  user_id: number;
  username: string;
  email: string;
  role: string;
  created_at: string | Date;
  email_verified_at: string | Date | null;
  credit_balance: number;
  credit_last_reset?: string | Date;
  is_banned: boolean;
  can_add_resources: boolean;
  email_notifications_on: boolean;
  total?: string | number;
};

function serializeAdminUser(row: UserRow): AdminUser {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    emailVerifiedAt: iso(row.email_verified_at),
    creditBalance: row.credit_balance,
    isBanned: row.is_banned,
    canAddResources: row.can_add_resources,
    emailNotificationsOn: row.email_notifications_on,
    status: row.is_banned ? "banned" : row.email_verified_at ? "active" : "unverified",
  };
}

const USER_COLUMNS = `
  u.user_id, u.username, u.email, u.role, u.created_at,
  u.email_verified_at, u.credit_balance, u.credit_last_reset, u.is_banned,
  u.can_add_resources, u.email_notifications_on
`;

export async function listUsers(
  client: DatabaseClient,
  query: AdminUserQuery,
): Promise<Page<AdminUser>> {
  const result = await client.query<UserRow>(
    `
      SELECT ${USER_COLUMNS}, COUNT(*) OVER() AS total
      FROM "User" AS u
      WHERE u.is_account_deleted = FALSE
        AND ($1 = '' OR u.username ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR u.role = $2)
        AND (
          $3::text IS NULL
          OR ($3 = 'banned' AND u.is_banned)
          OR ($3 = 'unverified' AND NOT u.is_banned AND u.email_verified_at IS NULL)
          OR ($3 = 'active' AND NOT u.is_banned AND u.email_verified_at IS NOT NULL)
        )
      ORDER BY u.created_at DESC, u.user_id DESC
      LIMIT $4 OFFSET $5
    `,
    [
      escapeLike(query.search),
      query.role,
      query.status,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ],
  );

  return {
    items: result.rows.map(serializeAdminUser),
    total: result.rows.length > 0 ? Number(result.rows[0].total) : 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getUserDetail(
  client: DatabaseClient,
  userId: number,
): Promise<AdminUserDetail | null> {
  const userResult = await client.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM "User" AS u WHERE u.user_id = $1`,
    [userId],
  );
  const row = userResult.rows[0];
  if (!row) return null;

  const [owned, reservations] = await Promise.all([
    client.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM "Resource" WHERE owner_id = $1`,
      [userId],
    ),
    client.query<{ status: string; count: string | number }>(
      `SELECT status, COUNT(*) AS count FROM "Reservation" WHERE user_id = $1 GROUP BY status`,
      [userId],
    ),
  ]);

  return {
    ...serializeAdminUser(row),
    creditLastReset: new Date(row.credit_last_reset as string | Date).toISOString().slice(0, 10),
    resourcesOwned: Number(owned.rows[0]?.count ?? 0),
    reservationCounts: Object.fromEntries(
      reservations.rows.map((entry) => [entry.status, Number(entry.count)]),
    ),
  };
}

export async function listReservations(
  client: DatabaseClient,
  query: AdminReservationQuery,
): Promise<Page<AdminReservation>> {
  const result = await client.query<{
    reservation_id: number;
    status: string;
    start_time: string | Date;
    end_time: string | Date;
    created_at: string | Date;
    user_id: number;
    username: string;
    resource_id: number;
    resource_name: string;
    total: string | number;
  }>(
    `
      SELECT
        r.reservation_id, r.status, r.start_time, r.end_time, r.created_at,
        u.user_id, u.username, res.resource_id, res.name AS resource_name,
        COUNT(*) OVER() AS total
      FROM "Reservation" AS r
      JOIN "User" AS u ON u.user_id = r.user_id
      JOIN "Resource" AS res ON res.resource_id = r.resource_id
      WHERE ($1::text IS NULL OR r.status = $1)
      ORDER BY r.start_time DESC, r.reservation_id DESC
      LIMIT $2 OFFSET $3
    `,
    [query.status, query.pageSize, (query.page - 1) * query.pageSize],
  );

  return {
    items: result.rows.map((row) => ({
      id: row.reservation_id,
      status: row.status,
      startTime: wallClock(row.start_time),
      endTime: wallClock(row.end_time),
      createdAt: wallClock(row.created_at),
      user: { id: row.user_id, username: row.username },
      resource: { id: row.resource_id, name: row.resource_name },
    })),
    total: result.rows.length > 0 ? Number(result.rows[0].total) : 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export const ACTIVITY_DAYS = 14;

export async function getStats(client: DatabaseClient): Promise<AdminStats> {
  const [users, roles, resources, reservations, activity] = await Promise.all([
    client.query<{ total: string | number; verified: string | number; unverified: string | number; banned: string | number }>(
      `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL) AS verified,
          COUNT(*) FILTER (WHERE email_verified_at IS NULL) AS unverified,
          COUNT(*) FILTER (WHERE is_banned) AS banned
        FROM "User"
      `,
    ),
    client.query<{ role: string; count: string | number }>(
      `SELECT role, COUNT(*) AS count FROM "User" GROUP BY role`,
    ),
    client.query<{ count: string | number }>(`SELECT COUNT(*) AS count FROM "Resource"`),
    client.query<{ status: string; count: string | number }>(
      `SELECT status, COUNT(*) AS count FROM "Reservation" GROUP BY status`,
    ),
    // One row per campus day for the last ACTIVITY_DAYS days, oldest first.
    client.query<{ day: string; reservations: string | number; signups: string | number }>(
      `
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
          (SELECT COUNT(*) FROM "Reservation" AS r WHERE r.created_at::date = d.day) AS reservations,
          (SELECT COUNT(*) FROM "User" AS u WHERE u.created_at::date = d.day) AS signups
        FROM (
          SELECT generate_series(
            ${CAMPUS_NOW_SQL}::date - ($1::integer - 1),
            ${CAMPUS_NOW_SQL}::date,
            interval '1 day'
          )::date AS day
        ) AS d
        ORDER BY d.day
      `,
      [ACTIVITY_DAYS],
    ),
  ]);

  const byStatus = Object.fromEntries(
    reservations.rows.map((row) => [row.status, Number(row.count)]),
  );
  const userRow = users.rows[0];

  return {
    users: {
      total: Number(userRow?.total ?? 0),
      verified: Number(userRow?.verified ?? 0),
      unverified: Number(userRow?.unverified ?? 0),
      banned: Number(userRow?.banned ?? 0),
      byRole: Object.fromEntries(roles.rows.map((row) => [row.role, Number(row.count)])),
    },
    resources: { total: Number(resources.rows[0]?.count ?? 0) },
    reservations: {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
    },
    activity: activity.rows.map((row) => ({
      date: row.day,
      reservations: Number(row.reservations),
      signups: Number(row.signups),
    })),
  };
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

export type FieldValidation<T> =
  | { ok: true; value: T }
  | { ok: false; fieldErrors: Record<string, string> };

export type AdminResult<T> =
  | { ok: true; value: T; notificationIds?: number[] }
  | { ok: false; status: 400 | 404 | 409; error: string };

export type AdminCreateUserInput = {
  username: string;
  email: string;
  password: string;
  role: string;
  canAddResources: boolean;
  emailNotificationsOn: boolean;
};

export type AdminUpdateUserInput = {
  username?: string;
  email?: string;
  role?: string;
  isBanned?: boolean;
  canAddResources?: boolean;
  emailNotificationsOn?: boolean;
};

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/;
const INITIAL_CREDITS = 20;

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function checkUsername(value: unknown, errors: Record<string, string>): string | undefined {
  const username = typeof value === "string" ? value.trim() : "";
  if (!USERNAME_PATTERN.test(username)) {
    errors.username = "Use 3–32 letters, numbers, or underscores.";
    return undefined;
  }
  return username;
}

function checkEmail(value: unknown, errors: Record<string, string>): string | undefined {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isVtEmail(email) || email.length > 254) {
    errors.email = "Use a valid Virginia Tech email ending in @vt.edu.";
    return undefined;
  }
  return email;
}

function checkRole(value: unknown, errors: Record<string, string>): string | undefined {
  if (typeof value !== "string" || !ADMIN_ROLES.includes(value as (typeof ADMIN_ROLES)[number])) {
    errors.role = "Role must be one of: student, staff, admin.";
    return undefined;
  }
  return value;
}

function checkFlag(
  value: unknown,
  field: string,
  errors: Record<string, string>,
): boolean | undefined {
  if (typeof value !== "boolean") {
    errors[field] = "Must be true or false.";
    return undefined;
  }
  return value;
}

export function parseAdminCreateUser(body: unknown): FieldValidation<AdminCreateUserInput> {
  const values = asRecord(body);
  if (!values) return { ok: false, fieldErrors: { form: "Enter the requested account details." } };

  const errors: Record<string, string> = {};
  const username = checkUsername(values.username, errors);
  const email = checkEmail(values.email, errors);
  const role = values.role === undefined ? "student" : checkRole(values.role, errors);
  const canAddResources =
    values.canAddResources === undefined ? true : checkFlag(values.canAddResources, "canAddResources", errors);
  const emailNotificationsOn =
    values.emailNotificationsOn === undefined
      ? true
      : checkFlag(values.emailNotificationsOn, "emailNotificationsOn", errors);
  const password = typeof values.password === "string" ? values.password : "";

  if (password.length < 8 || password.length > 128) {
    errors.password = "Use a password between 8 and 128 characters.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };

  return {
    ok: true,
    value: {
      username: username as string,
      email: email as string,
      password,
      role: role as string,
      canAddResources: canAddResources as boolean,
      emailNotificationsOn: emailNotificationsOn as boolean,
    },
  };
}

export function parseAdminUpdateUser(body: unknown): FieldValidation<AdminUpdateUserInput> {
  const values = asRecord(body);
  if (!values) return { ok: false, fieldErrors: { form: "Enter the fields to change." } };

  const errors: Record<string, string> = {};
  const input: AdminUpdateUserInput = {};

  if (values.username !== undefined) input.username = checkUsername(values.username, errors);
  if (values.email !== undefined) input.email = checkEmail(values.email, errors);
  if (values.role !== undefined) input.role = checkRole(values.role, errors);
  if (values.isBanned !== undefined) input.isBanned = checkFlag(values.isBanned, "isBanned", errors);
  if (values.canAddResources !== undefined) {
    input.canAddResources = checkFlag(values.canAddResources, "canAddResources", errors);
  }
  if (values.emailNotificationsOn !== undefined) {
    input.emailNotificationsOn = checkFlag(values.emailNotificationsOn, "emailNotificationsOn", errors);
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  if (Object.keys(input).length === 0) {
    return { ok: false, fieldErrors: { form: "Change at least one field." } };
  }
  return { ok: true, value: input };
}

// Admin-created accounts are verified immediately (the administrator vouches for
// the address), so no verification email or token is involved.
export async function createUser(
  client: DatabaseClient,
  input: Omit<AdminCreateUserInput, "password"> & { passwordHash: string },
): Promise<AdminUserDetail> {
  await client.query("BEGIN");
  try {
    const created = await client.query<{ user_id: number }>(
      `
        INSERT INTO "User" (
          username, email, password_hash, role, credit_balance, credit_last_reset,
          is_banned, can_add_resources, email_notifications_on, email_verified_at
        )
        VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, FALSE, $6, $7, CURRENT_TIMESTAMP)
        RETURNING user_id
      `,
      [
        input.username,
        input.email,
        input.passwordHash,
        input.role,
        INITIAL_CREDITS,
        input.canAddResources,
        input.emailNotificationsOn,
      ],
    );
    const userId = created.rows[0]?.user_id;
    if (userId === undefined) throw new Error("Account creation did not return a user");

    await client.query(
      `INSERT INTO "CreditTransaction" (user_id, amount, transaction_type) VALUES ($1, $2, 'initial_grant')`,
      [userId, INITIAL_CREDITS],
    );
    await client.query("COMMIT");

    const detail = await getUserDetail(client, userId);
    if (!detail) throw new Error("Created user could not be loaded");
    return detail;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const UPDATE_COLUMNS: Record<keyof AdminUpdateUserInput, string> = {
  username: "username",
  email: "email",
  role: "role",
  isBanned: "is_banned",
  canAddResources: "can_add_resources",
  emailNotificationsOn: "email_notifications_on",
};

// Administrators cannot lock themselves out: no banning or demoting their own
// account, so at least one active administrator always remains.
export async function updateUser(
  client: DatabaseClient,
  actingAdminId: number,
  userId: number,
  input: AdminUpdateUserInput,
): Promise<AdminResult<AdminUserDetail>> {
  if (userId === actingAdminId) {
    if (input.isBanned === true) {
      return { ok: false, status: 409, error: "You can't ban your own account." };
    }
    if (input.role !== undefined && input.role !== "admin") {
      return { ok: false, status: 409, error: "You can't remove your own administrator role." };
    }
  }

  const existing = await client.query<{ is_account_deleted: boolean }>(
    `SELECT is_account_deleted FROM "User" WHERE user_id = $1`,
    [userId],
  );
  if (existing.rows.length === 0) return { ok: false, status: 404, error: "User not found." };
  if (existing.rows[0].is_account_deleted) {
    return { ok: false, status: 409, error: "This account was deleted and can't be edited." };
  }

  const assignments: string[] = [];
  const values: unknown[] = [userId];
  for (const key of Object.keys(UPDATE_COLUMNS) as Array<keyof AdminUpdateUserInput>) {
    if (input[key] === undefined) continue;
    values.push(input[key]);
    assignments.push(`${UPDATE_COLUMNS[key]} = $${values.length}`);
  }

  await client.query(
    `UPDATE "User" SET ${assignments.join(", ")} WHERE user_id = $1 AND is_account_deleted = FALSE`,
    values,
  );

  const detail = await getUserDetail(client, userId);
  return detail
    ? { ok: true, value: detail }
    : { ok: false, status: 404, error: "User not found." };
}

// Same soft delete a user gets from "Delete account": personal data, sessions and
// the profile image are removed, while reservation history and owned resources
// stay. An administrator can't delete their own account from here.
export async function deleteUserAccount(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  actingAdminId: number,
  userId: number,
): Promise<AdminResult<null>> {
  if (userId === actingAdminId) {
    return { ok: false, status: 409, error: "You can't delete your own account from the admin panel." };
  }

  const existing = await client.query<{ username: string; is_account_deleted: boolean }>(
    `SELECT username, is_account_deleted FROM "User" WHERE user_id = $1`,
    [userId],
  );
  const row = existing.rows[0];
  if (!row) return { ok: false, status: 404, error: "User not found." };
  if (row.is_account_deleted) {
    return { ok: false, status: 409, error: "This account is already deleted." };
  }

  const deleted = await deleteAccount(client, bucket, userId, row.username);
  return deleted
    ? { ok: true, value: null }
    : { ok: false, status: 409, error: "This account changed while deleting. Reload and try again." };
}

// ---------------------------------------------------------------------------
// Resource management
// ---------------------------------------------------------------------------

export type AdminResourceQuery = PageQuery & { search: string };

export type AdminResource = {
  id: number;
  name: string;
  building: { id: number; name: string };
  category: { id: number; name: string };
  owner: { id: number; username: string };
  createdAt: string;
  upcomingReservations: number;
};

export function parseAdminResourceQuery(params: URLSearchParams): Validation<AdminResourceQuery> {
  const page = parsePage(params);
  if (!page.ok) return page;
  return {
    ok: true,
    value: { ...page.value, search: (params.get("search") ?? "").trim().slice(0, 100) },
  };
}

export async function listAdminResources(
  client: DatabaseClient,
  query: AdminResourceQuery,
): Promise<Page<AdminResource>> {
  const result = await client.query<{
    resource_id: number;
    name: string;
    building_id: number;
    building_name: string;
    category_id: number;
    category_name: string;
    owner_id: number;
    username: string;
    created_at: string | Date;
    upcoming: string | number;
    total: string | number;
  }>(
    `
      SELECT
        r.resource_id, r.name, b.building_id, b.building_name, c.category_id, c.category_name,
        u.user_id AS owner_id, u.username, r.created_at,
        (
          SELECT COUNT(*) FROM "Reservation" AS rv
          WHERE rv.resource_id = r.resource_id
            AND rv.status = 'confirmed'
            AND rv.end_time > ${CAMPUS_NOW_SQL}
        ) AS upcoming,
        COUNT(*) OVER() AS total
      FROM "Resource" AS r
      JOIN "Building" AS b ON b.building_id = r.building_id
      JOIN "ResourceCategory" AS c ON c.category_id = r.category_id
      JOIN "User" AS u ON u.user_id = r.owner_id
      WHERE ($1 = '' OR r.name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%'
             OR b.building_name ILIKE '%' || $1 || '%')
      ORDER BY r.created_at DESC, r.resource_id DESC
      LIMIT $2 OFFSET $3
    `,
    [escapeLike(query.search), query.pageSize, (query.page - 1) * query.pageSize],
  );

  return {
    items: result.rows.map((row) => ({
      id: row.resource_id,
      name: row.name,
      building: { id: row.building_id, name: row.building_name },
      category: { id: row.category_id, name: row.category_name },
      owner: { id: row.owner_id, username: row.username },
      createdAt: new Date(row.created_at).toISOString(),
      upcomingReservations: Number(row.upcoming),
    })),
    total: result.rows.length > 0 ? Number(result.rows[0].total) : 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export type AdminResourceDetail = ResourceDetails & {
  owner: { id: number; username: string };
  reservationCounts: Record<string, number>;
  upcomingReservations: number;
};

// The public details plus what only an administrator needs: the owner's id and
// how many reservations the resource has in each state.
export async function getAdminResourceDetail(
  client: DatabaseClient,
  resourceId: number,
): Promise<AdminResourceDetail | null> {
  const details = await getResourceDetails(client, resourceId);
  if (!details) return null;

  const [owner, counts, upcoming] = await Promise.all([
    client.query<{ user_id: number; username: string }>(
      `
        SELECT u.user_id, u.username
        FROM "Resource" AS r
        JOIN "User" AS u ON u.user_id = r.owner_id
        WHERE r.resource_id = $1
      `,
      [resourceId],
    ),
    client.query<{ status: string; count: string | number }>(
      `SELECT status, COUNT(*) AS count FROM "Reservation" WHERE resource_id = $1 GROUP BY status`,
      [resourceId],
    ),
    client.query<{ count: string | number }>(
      `
        SELECT COUNT(*) AS count FROM "Reservation"
        WHERE resource_id = $1 AND status = 'confirmed' AND end_time > ${CAMPUS_NOW_SQL}
      `,
      [resourceId],
    ),
  ]);

  const ownerRow = owner.rows[0];
  if (!ownerRow) return null;

  return {
    ...details,
    owner: { id: ownerRow.user_id, username: ownerRow.username },
    reservationCounts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
    upcomingReservations: Number(upcoming.rows[0]?.count ?? 0),
  };
}

type DeletedResource = { cancelledReservations: number };

// Deletes any resource. A reservation that is in progress blocks the delete (same
// rule as owners). Upcoming confirmed reservations are cancelled and refunded, and
// each booker gets a cancellation notice. The notice is detached from the
// reservation first, because the reservation row is removed with the resource.
export async function deleteResource(
  client: DatabaseClient,
  bucket: R2Bucket | undefined,
  resourceId: number,
): Promise<AdminResult<DeletedResource>> {
  let committed = false;

  await client.query("BEGIN");
  try {
    const found = await client.query<{
      name: string;
      required_credits: number;
      image_id: number | null;
      object_key: string | null;
    }>(
      `
        SELECT r.name, r.required_credits, img.image_id, img.object_key
        FROM "Resource" AS r
        LEFT JOIN "ImageMetadata" AS img ON img.image_id = r.resource_image_id
        WHERE r.resource_id = $1
        FOR UPDATE OF r
      `,
      [resourceId],
    );
    const resource = found.rows[0];
    if (!resource) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, error: "Resource not found." };
    }

    const active = await client.query<{ start_time: string; end_time: string }>(
      `
        SELECT ${localTimestampSql("start_time")} AS start_time, ${localTimestampSql("end_time")} AS end_time
        FROM "Reservation"
        WHERE resource_id = $1 AND status = 'confirmed'
          AND start_time <= ${CAMPUS_NOW_SQL} AND end_time > ${CAMPUS_NOW_SQL}
        ORDER BY start_time
        LIMIT 1
      `,
      [resourceId],
    );
    if (active.rows[0]) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        status: 409,
        error: `This resource can't be deleted while a reservation is in progress (${active.rows[0].start_time}–${active.rows[0].end_time}).`,
      };
    }

    const upcoming = await client.query<{
      reservation_id: number;
      user_id: number;
      start_time: string;
      end_time: string;
    }>(
      `
        SELECT reservation_id, user_id,
               ${localTimestampSql("start_time")} AS start_time,
               ${localTimestampSql("end_time")} AS end_time
        FROM "Reservation"
        WHERE resource_id = $1 AND status = 'confirmed' AND start_time > ${CAMPUS_NOW_SQL}
        ORDER BY user_id, reservation_id
        FOR UPDATE
      `,
      [resourceId],
    );

    const notificationIds: number[] = [];
    if (upcoming.rows.length > 0) {
      const userIds = [...new Set(upcoming.rows.map((row) => row.user_id))];
      await client.query(
        `SELECT user_id FROM "User" WHERE user_id = ANY($1::integer[]) ORDER BY user_id FOR UPDATE`,
        [userIds],
      );

      for (const reservation of upcoming.rows) {
        await client.query(
          `UPDATE "User" SET credit_balance = credit_balance + $2 WHERE user_id = $1`,
          [reservation.user_id, resource.required_credits],
        );
        await client.query(
          `INSERT INTO "CreditTransaction" (user_id, amount, transaction_type) VALUES ($1, $2, 'refund')`,
          [reservation.user_id, resource.required_credits],
        );
        await skipPendingReservationReminders(
          client,
          reservation.reservation_id,
          "Reservation was cancelled because the resource was removed.",
        );
        notificationIds.push(await createReservationCancellationNotification(client, {
          userId: reservation.user_id,
          reservationId: reservation.reservation_id,
          message: `Your reservation for ${resource.name} on ${reservation.start_time}–${reservation.end_time} was cancelled because the resource was removed by an administrator. ${resource.required_credits} credits were refunded.`,
        }));
      }

      await client.query(
        `UPDATE "Notification" SET reservation_id = NULL WHERE notification_id = ANY($1::integer[])`,
        [notificationIds],
      );
    }

    await client.query(`DELETE FROM "Resource" WHERE resource_id = $1`, [resourceId]);
    if (resource.image_id !== null) {
      await client.query(`DELETE FROM "ImageMetadata" WHERE image_id = $1`, [resource.image_id]);
    }
    await client.query("COMMIT");
    committed = true;

    if (bucket && resource.object_key) {
      try {
        await bucket.delete(resource.object_key);
      } catch (error) {
        console.error(`R2 cleanup failed for ${resource.object_key}:`, error);
      }
    }
    return {
      ok: true,
      value: { cancelledReservations: upcoming.rows.length },
      notificationIds,
    };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Building management. The Building table already stores every field an admin
// can change, so these writes do not add columns.
// ---------------------------------------------------------------------------

const BUILDING_NAME_MAX = 120;
const BUILDING_ADDRESS_MAX = 200;
const BUILDING_PLACE_ID_MAX = 255;

export type AdminBuildingQuery = PageQuery & { search: string };

export type AdminBuilding = {
  id: number;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  googlePlaceId: string | null;
  resourceCount: number;
};

export type AdminBuildingInput = {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  googlePlaceId: string | null;
};

type BuildingRow = {
  building_id: number;
  building_name: string;
  address: string;
  latitude: string | number;
  longitude: string | number;
  google_place_id: string | null;
  resource_count: string | number;
};

function mapBuilding(row: BuildingRow): AdminBuilding {
  return {
    id: row.building_id,
    name: row.building_name,
    address: row.address,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    googlePlaceId: row.google_place_id,
    resourceCount: Number(row.resource_count),
  };
}

function parseCoordinate(
  value: unknown,
  field: "latitude" | "longitude",
  min: number,
  max: number,
  errors: Record<string, string>,
): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value.trim())
      : Number.NaN;

  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    errors[field] = field === "latitude"
      ? "Latitude must be a number from -90 to 90."
      : "Longitude must be a number from -180 to 180.";
    return undefined;
  }

  return Math.round(numeric * 1_000_000) / 1_000_000;
}

export function parseAdminBuildingQuery(params: URLSearchParams): Validation<AdminBuildingQuery> {
  const page = parsePage(params);
  if (!page.ok) return page;
  return {
    ok: true,
    value: { ...page.value, search: (params.get("search") ?? "").trim().slice(0, 100) },
  };
}

export function parseAdminBuilding(body: unknown): FieldValidation<AdminBuildingInput> {
  const values = asRecord(body);
  if (!values) return { ok: false, fieldErrors: { form: "Enter the building details." } };

  const errors: Record<string, string> = {};
  const name = typeof values.name === "string" ? values.name.trim() : "";
  const address = typeof values.address === "string" ? values.address.trim() : "";
  const placeValue = values.googlePlaceId === undefined || values.googlePlaceId === null
    ? ""
    : values.googlePlaceId;
  const place = typeof placeValue === "string" ? placeValue.trim() : null;

  if (!name || name.length > BUILDING_NAME_MAX) {
    errors.name = `Enter a name up to ${BUILDING_NAME_MAX} characters.`;
  }
  if (!address || address.length > BUILDING_ADDRESS_MAX) {
    errors.address = `Enter an address up to ${BUILDING_ADDRESS_MAX} characters.`;
  }
  if (place === null || place.length > BUILDING_PLACE_ID_MAX) {
    errors.googlePlaceId = `Enter a Google place id up to ${BUILDING_PLACE_ID_MAX} characters, or leave it blank.`;
  }

  const latitude = parseCoordinate(values.latitude, "latitude", -90, 90, errors);
  const longitude = parseCoordinate(values.longitude, "longitude", -180, 180, errors);
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };

  return {
    ok: true,
    value: {
      name,
      address,
      latitude: latitude as number,
      longitude: longitude as number,
      googlePlaceId: place ? place : null,
    },
  };
}

const BUILDING_COLUMNS = `
  b.building_id, b.building_name, b.address, b.latitude, b.longitude, b.google_place_id,
  (SELECT COUNT(*) FROM "Resource" AS r WHERE r.building_id = b.building_id) AS resource_count
`;

export async function listAdminBuildings(
  client: DatabaseClient,
  query: AdminBuildingQuery,
): Promise<Page<AdminBuilding>> {
  const result = await client.query<BuildingRow & { total: string | number }>(
    `
      SELECT
        ${BUILDING_COLUMNS},
        COUNT(*) OVER() AS total
      FROM "Building" AS b
      WHERE ($1 = '' OR b.building_name ILIKE '%' || $1 || '%' OR b.address ILIKE '%' || $1 || '%')
      ORDER BY b.building_name, b.building_id
      LIMIT $2 OFFSET $3
    `,
    [escapeLike(query.search), query.pageSize, (query.page - 1) * query.pageSize],
  );

  return {
    items: result.rows.map(mapBuilding),
    total: result.rows.length > 0 ? Number(result.rows[0].total) : 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function createBuilding(
  client: DatabaseClient,
  input: AdminBuildingInput,
): Promise<AdminBuilding> {
  const result = await client.query<BuildingRow>(
    `
      INSERT INTO "Building" AS b (building_name, address, latitude, longitude, google_place_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING ${BUILDING_COLUMNS}
    `,
    [input.name, input.address, input.latitude, input.longitude, input.googlePlaceId],
  );
  return mapBuilding(result.rows[0]);
}

export async function updateBuilding(
  client: DatabaseClient,
  buildingId: number,
  input: AdminBuildingInput,
): Promise<AdminResult<AdminBuilding>> {
  const result = await client.query<BuildingRow>(
    `
      UPDATE "Building" AS b
      SET building_name = $2, address = $3, latitude = $4, longitude = $5, google_place_id = $6
      WHERE b.building_id = $1
      RETURNING ${BUILDING_COLUMNS}
    `,
    [buildingId, input.name, input.address, input.latitude, input.longitude, input.googlePlaceId],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, status: 404, error: "Building not found." };
  return { ok: true, value: mapBuilding(row) };
}

export async function deleteBuilding(
  client: DatabaseClient,
  buildingId: number,
): Promise<AdminResult<null>> {
  const existing = await client.query<{ building_id: number }>(
    `SELECT building_id FROM "Building" WHERE building_id = $1`,
    [buildingId],
  );
  if (!existing.rows[0]) return { ok: false, status: 404, error: "Building not found." };

  const resources = await client.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM "Resource" WHERE building_id = $1`,
    [buildingId],
  );
  const resourceCount = Number(resources.rows[0]?.count ?? 0);
  if (resourceCount > 0) {
    return {
      ok: false,
      status: 409,
      error: `This building still has ${resourceCount} resource${resourceCount === 1 ? "" : "s"}. Move or delete them before deleting the building.`,
    };
  }

  await client.query(`DELETE FROM "Building" WHERE building_id = $1`, [buildingId]);
  return { ok: true, value: null };
}
