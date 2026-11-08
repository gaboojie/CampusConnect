import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, localTimestampSql, parsePositiveId, type Validation } from "./resources";
import { RESERVATION_REMINDER_NOTIFICATION } from "./notifications";

// The in-app notification inbox. A notification appears once its delivery time
// (scheduled_for, or created_at when unscheduled) has passed, so a reminder that is
// due in two days stays hidden until then. Reminders for reservations that are no
// longer confirmed are hidden too.

export const INBOX_DEFAULT_PAGE_SIZE = 20;
export const INBOX_MAX_PAGE_SIZE = 50;
const MAX_PAGE = 500;

export type InboxFilter = "all" | "unread";

export type InboxQuery = {
  filter: InboxFilter;
  page: number;
  pageSize: number;
};

export type InboxNotification = {
  id: number;
  type: string;
  message: string;
  reservationId: number | null;
  // Campus wall-clock time the notification was delivered.
  deliveredAt: string;
  isRead: boolean;
};

export type Inbox = {
  items: InboxNotification[];
  unreadCount: number;
  total: number;
  page: number;
  pageSize: number;
};

const DELIVERED_AT = "COALESCE(n.scheduled_for, n.created_at)";

const VISIBLE_SQL = `
  n.user_id = $1
  AND ${DELIVERED_AT} <= ${CAMPUS_NOW_SQL}
  AND (n.notification_type <> '${RESERVATION_REMINDER_NOTIFICATION}' OR rv.status = 'confirmed')
`;

function parsePositiveInteger(raw: string | null, fallback: number, max: number, label: string): Validation<number> {
  if (raw === null || raw.trim() === "") return { ok: true, value: fallback };
  const value = parsePositiveId(raw.trim());
  if (value === null || value > max) {
    return { ok: false, error: `${label} must be a whole number from 1 to ${max}.` };
  }
  return { ok: true, value };
}

export function parseInboxQuery(params: URLSearchParams): Validation<InboxQuery> {
  const filter = (params.get("filter") ?? "all").trim();
  if (filter !== "all" && filter !== "unread") {
    return { ok: false, error: "Filter must be all or unread." };
  }

  const page = parsePositiveInteger(params.get("page"), 1, MAX_PAGE, "Page");
  if (!page.ok) return page;
  const pageSize = parsePositiveInteger(params.get("pageSize"), INBOX_DEFAULT_PAGE_SIZE, INBOX_MAX_PAGE_SIZE, "Page size");
  if (!pageSize.ok) return pageSize;

  return { ok: true, value: { filter, page: page.value, pageSize: pageSize.value } };
}

export async function listInbox(client: DatabaseClient, userId: number, query: InboxQuery): Promise<Inbox> {
  const counts = await client.query<{ total: string | number; unread: string | number }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE $2::boolean = FALSE OR n.read_at IS NULL) AS total,
        COUNT(*) FILTER (WHERE n.read_at IS NULL) AS unread
      FROM "Notification" AS n
      LEFT JOIN "Reservation" AS rv ON rv.reservation_id = n.reservation_id
      WHERE ${VISIBLE_SQL}
    `,
    [userId, query.filter === "unread"],
  );

  const rows = await client.query<{
    notification_id: number;
    notification_type: string;
    message: string;
    reservation_id: number | null;
    delivered_at: string;
    is_read: boolean;
  }>(
    `
      SELECT
        n.notification_id,
        n.notification_type,
        n.message,
        n.reservation_id,
        ${localTimestampSql(DELIVERED_AT)} AS delivered_at,
        (n.read_at IS NOT NULL) AS is_read
      FROM "Notification" AS n
      LEFT JOIN "Reservation" AS rv ON rv.reservation_id = n.reservation_id
      WHERE ${VISIBLE_SQL}
        AND ($2::boolean = FALSE OR n.read_at IS NULL)
      ORDER BY ${DELIVERED_AT} DESC, n.notification_id DESC
      LIMIT $3 OFFSET $4
    `,
    [userId, query.filter === "unread", query.pageSize, (query.page - 1) * query.pageSize],
  );

  return {
    items: rows.rows.map((row) => ({
      id: row.notification_id,
      type: row.notification_type,
      message: row.message,
      reservationId: row.reservation_id,
      deliveredAt: row.delivered_at,
      isRead: row.is_read,
    })),
    unreadCount: Number(counts.rows[0]?.unread ?? 0),
    total: Number(counts.rows[0]?.total ?? 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}

// Marks one of the user's own notifications read. Returns false when it does not exist
// or belongs to someone else; marking an already-read one is fine and keeps its time.
export async function markInboxNotificationRead(
  client: DatabaseClient,
  userId: number,
  notificationId: number,
): Promise<boolean> {
  const result = await client.query(
    `
      UPDATE "Notification"
      SET read_at = COALESCE(read_at, ${CAMPUS_NOW_SQL})
      WHERE notification_id = $1
        AND user_id = $2
      RETURNING notification_id
    `,
    [notificationId, userId],
  );
  return result.rows.length > 0;
}

// Marks every unread notification the user can currently see read (not hidden or future
// ones). Returns how many changed.
export async function markAllInboxNotificationsRead(client: DatabaseClient, userId: number): Promise<number> {
  const result = await client.query(
    `
      UPDATE "Notification" AS target
      SET read_at = ${CAMPUS_NOW_SQL}
      WHERE target.notification_id IN (
        SELECT n.notification_id
        FROM "Notification" AS n
        LEFT JOIN "Reservation" AS rv ON rv.reservation_id = n.reservation_id
        WHERE ${VISIBLE_SQL}
          AND n.read_at IS NULL
      )
      RETURNING target.notification_id
    `,
    [userId],
  );
  return result.rows.length;
}
