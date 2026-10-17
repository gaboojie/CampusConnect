import type { DatabaseClient } from "./db";
import type { Validation } from "./resources";

// Read-only queries behind the /api/admin/* endpoints. The password hash, session
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
  phoneNumber: string | null;
  role: string;
  createdAt: string;
  emailVerifiedAt: string | null;
  creditBalance: number;
  isBanned: boolean;
  canAddResources: boolean;
  emailNotificationsOn: boolean;
  textNotificationsOn: boolean;
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
  phone_number: string | null;
  role: string;
  created_at: string | Date;
  email_verified_at: string | Date | null;
  credit_balance: number;
  credit_last_reset?: string | Date;
  is_banned: boolean;
  can_add_resources: boolean;
  email_notifications_on: boolean;
  text_notifications_on: boolean;
  total?: string | number;
};

function serializeAdminUser(row: UserRow): AdminUser {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    phoneNumber: row.phone_number,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    emailVerifiedAt: iso(row.email_verified_at),
    creditBalance: row.credit_balance,
    isBanned: row.is_banned,
    canAddResources: row.can_add_resources,
    emailNotificationsOn: row.email_notifications_on,
    textNotificationsOn: row.text_notifications_on,
    status: row.is_banned ? "banned" : row.email_verified_at ? "active" : "unverified",
  };
}

const USER_COLUMNS = `
  u.user_id, u.username, u.email, u.phone_number, u.role, u.created_at,
  u.email_verified_at, u.credit_balance, u.credit_last_reset, u.is_banned,
  u.can_add_resources, u.email_notifications_on, u.text_notifications_on
`;

export async function listUsers(
  client: DatabaseClient,
  query: AdminUserQuery,
): Promise<Page<AdminUser>> {
  const result = await client.query<UserRow>(
    `
      SELECT ${USER_COLUMNS}, COUNT(*) OVER() AS total
      FROM "User" AS u
      WHERE ($1 = '' OR u.username ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
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

export async function getStats(client: DatabaseClient): Promise<AdminStats> {
  const [users, roles, resources, reservations] = await Promise.all([
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
  };
}
