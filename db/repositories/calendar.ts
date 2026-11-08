import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, isCalendarDate, parsePositiveId, type Validation } from "./resources";

// Day-grid availability: for one campus date, each resource's open windows,
// bookings and maintenance, all as minutes since midnight (0–1440) in campus time.

export const CALENDAR_DEFAULT_LIMIT = 30;
export const CALENDAR_MAX_LIMIT = 50;

export type CalendarQuery = {
  // null means "today" in campus time.
  date: string | null;
  search: string;
  categoryId: number | null;
  buildingId: number | null;
  resourceId: number | null;
  limit: number;
};

export type CalendarSpan = { start: number; end: number };

export type CalendarBooking = CalendarSpan & {
  // Only administrators receive the reservation id and the booker's username.
  id: number | null;
  userId: number | null;
  username: string | null;
  status: string;
  mine: boolean;
};

export type CalendarResource = {
  id: number;
  name: string;
  building: { id: number; name: string };
  category: { id: number; name: string };
  capacity: number;
  requiredCredits: number;
  maxReservationMinutes: number | null;
  windows: CalendarSpan[];
  bookings: CalendarBooking[];
  maintenance: Array<CalendarSpan & { reason: string }>;
};

export type DayCalendar = {
  date: string;
  today: string;
  nowMinutes: number;
  total: number;
  limit: number;
  resources: CalendarResource[];
};

function optionalId(raw: string, label: string): Validation<number | null> {
  if (!raw) return { ok: true, value: null };
  const id = parsePositiveId(raw);
  return id === null
    ? { ok: false, error: `${label} must be a positive whole number.` }
    : { ok: true, value: id };
}

export function parseCalendarQuery(params: URLSearchParams): Validation<CalendarQuery> {
  const date = (params.get("date") ?? "").trim();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isCalendarDate(date))) {
    return { ok: false, error: "Date must be a valid YYYY-MM-DD date." };
  }

  const category = optionalId((params.get("category") ?? "").trim(), "Category");
  if (!category.ok) return category;
  const building = optionalId((params.get("building") ?? "").trim(), "Building");
  if (!building.ok) return building;
  const resource = optionalId((params.get("resource") ?? "").trim(), "Resource");
  if (!resource.ok) return resource;

  const limitRaw = (params.get("limit") ?? "").trim();
  if (limitRaw && (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1)) {
    return { ok: false, error: "Limit must be a positive whole number." };
  }

  return {
    ok: true,
    value: {
      date: date || null,
      search: (params.get("search") ?? "").trim().slice(0, 100),
      categoryId: category.value,
      buildingId: building.value,
      resourceId: resource.value,
      limit: limitRaw ? Math.min(Number(limitRaw), CALENDAR_MAX_LIMIT) : CALENDAR_DEFAULT_LIMIT,
    },
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Clips a timestamp range to the day and returns minutes since midnight.
const DAY_START = "$2::date::timestamp";
const DAY_END = "($2::date::timestamp + interval '1 day')";
const minutesIn = (column: string) =>
  `(EXTRACT(EPOCH FROM (${column} - ${DAY_START})) / 60)::integer`;
const clippedStart = (column: string) => minutesIn(`GREATEST(${column}, ${DAY_START})`);
const clippedEnd = (column: string) => minutesIn(`LEAST(${column}, ${DAY_END})`);

// Every occurrence of every availability window that touches the day. A window
// repeats every repeats_offset until repeats_until, as in the weekly-hours query.
const WINDOWS_SQL = `
  WITH occurrences AS (
    SELECT
      a.resource_id,
      a.start_time + k * COALESCE(a.repeats_offset, interval '0') AS occurrence_start,
      CASE
        WHEN a.repeats_offset IS NULL THEN a.end_time
        ELSE a.start_time + k * a.repeats_offset + (a.end_time - a.start_time)
      END AS occurrence_end
    FROM "ResourceAvailability" AS a
    CROSS JOIN LATERAL generate_series(
      CASE
        WHEN a.repeats_offset IS NULL THEN 0
        ELSE GREATEST(0, FLOOR(
          EXTRACT(EPOCH FROM (${DAY_START} - a.start_time))
          / NULLIF(EXTRACT(EPOCH FROM a.repeats_offset), 0)
        )::integer)
      END,
      CASE
        WHEN a.repeats_offset IS NULL THEN 0
        ELSE FLOOR(
          EXTRACT(EPOCH FROM (${DAY_END} - a.start_time))
          / NULLIF(EXTRACT(EPOCH FROM a.repeats_offset), 0)
        )::integer
      END
    ) AS k
    WHERE a.resource_id = ANY($1::integer[])
      AND (
        a.repeats_offset IS NULL
        OR a.repeats_until IS NULL
        OR a.start_time + k * a.repeats_offset <= a.repeats_until
      )
  )
  SELECT
    resource_id,
    ${clippedStart("occurrence_start")} AS start_minute,
    ${clippedEnd("occurrence_end")} AS end_minute
  FROM occurrences
  WHERE occurrence_start < ${DAY_END} AND occurrence_end > ${DAY_START}
  ORDER BY resource_id, start_minute
`;

export async function getDayCalendar(
  client: DatabaseClient,
  query: CalendarQuery,
  viewer: { userId: number; isAdmin: boolean },
): Promise<DayCalendar> {
  const clock = await client.query<{ today: string; now_minutes: number | string }>(
    `
      SELECT
        to_char(${CAMPUS_NOW_SQL}, 'YYYY-MM-DD') AS today,
        (EXTRACT(HOUR FROM ${CAMPUS_NOW_SQL}) * 60 + EXTRACT(MINUTE FROM ${CAMPUS_NOW_SQL}))::integer AS now_minutes
    `,
  );
  const today = clock.rows[0].today;
  const nowMinutes = Number(clock.rows[0].now_minutes);
  const date = query.date ?? today;

  const found = await client.query<{
    resource_id: number;
    name: string;
    building_id: number;
    building_name: string;
    category_id: number;
    category_name: string;
    capacity: number;
    required_credits: number;
    max_minutes: number | string | null;
    total: string | number;
  }>(
    `
      SELECT
        r.resource_id, r.name, b.building_id, b.building_name, c.category_id, c.category_name,
        r.capacity, r.required_credits,
        (EXTRACT(EPOCH FROM r.max_reservation_time) / 60)::integer AS max_minutes,
        COUNT(*) OVER() AS total
      FROM "Resource" AS r
      JOIN "Building" AS b ON b.building_id = r.building_id
      JOIN "ResourceCategory" AS c ON c.category_id = r.category_id
      WHERE ($1 = '' OR r.name ILIKE '%' || $1 || '%' OR b.building_name ILIKE '%' || $1 || '%')
        AND ($2::integer IS NULL OR r.category_id = $2)
        AND ($3::integer IS NULL OR r.building_id = $3)
        AND ($4::integer IS NULL OR r.resource_id = $4)
      ORDER BY b.building_name, r.name, r.resource_id
      LIMIT $5
    `,
    [escapeLike(query.search), query.categoryId, query.buildingId, query.resourceId, query.limit],
  );

  const resources: CalendarResource[] = found.rows.map((row) => ({
    id: row.resource_id,
    name: row.name,
    building: { id: row.building_id, name: row.building_name },
    category: { id: row.category_id, name: row.category_name },
    capacity: row.capacity,
    requiredCredits: row.required_credits,
    maxReservationMinutes: row.max_minutes === null ? null : Number(row.max_minutes),
    windows: [],
    bookings: [],
    maintenance: [],
  }));
  const result: DayCalendar = {
    date,
    today,
    nowMinutes,
    total: found.rows.length > 0 ? Number(found.rows[0].total) : 0,
    limit: query.limit,
    resources,
  };
  if (resources.length === 0) return result;

  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const ids = resources.map((resource) => resource.id);

  const [windows, bookings, maintenance] = await Promise.all([
    client.query<{ resource_id: number; start_minute: number | string; end_minute: number | string }>(
      WINDOWS_SQL,
      [ids, date],
    ),
    client.query<{
      reservation_id: number;
      resource_id: number;
      user_id: number;
      username: string;
      status: string;
      start_minute: number | string;
      end_minute: number | string;
    }>(
      `
        SELECT
          rv.reservation_id, rv.resource_id, rv.user_id, u.username, rv.status,
          ${clippedStart("rv.start_time")} AS start_minute,
          ${clippedEnd("rv.end_time")} AS end_minute
        FROM "Reservation" AS rv
        JOIN "User" AS u ON u.user_id = rv.user_id
        WHERE rv.resource_id = ANY($1::integer[])
          AND rv.status <> 'cancelled'
          AND rv.start_time < ${DAY_END}
          AND rv.end_time > ${DAY_START}
        ORDER BY rv.resource_id, rv.start_time
      `,
      [ids, date],
    ),
    client.query<{ resource_id: number; reason: string; start_minute: number | string; end_minute: number | string }>(
      `
        SELECT
          mp.resource_id, mp.reason,
          ${clippedStart("mp.start_time")} AS start_minute,
          ${clippedEnd("mp.end_time")} AS end_minute
        FROM "MaintenancePeriod" AS mp
        WHERE mp.resource_id = ANY($1::integer[])
          AND mp.start_time < ${DAY_END}
          AND mp.end_time > ${DAY_START}
        ORDER BY mp.resource_id, mp.start_time
      `,
      [ids, date],
    ),
  ]);

  for (const row of windows.rows) {
    byId.get(row.resource_id)?.windows.push({ start: Number(row.start_minute), end: Number(row.end_minute) });
  }
  for (const row of bookings.rows) {
    byId.get(row.resource_id)?.bookings.push({
      start: Number(row.start_minute),
      end: Number(row.end_minute),
      status: row.status,
      mine: row.user_id === viewer.userId,
      id: viewer.isAdmin ? row.reservation_id : null,
      userId: viewer.isAdmin ? row.user_id : null,
      username: viewer.isAdmin ? row.username : null,
    });
  }
  for (const row of maintenance.rows) {
    byId.get(row.resource_id)?.maintenance.push({
      start: Number(row.start_minute),
      end: Number(row.end_minute),
      reason: row.reason,
    });
  }
  return result;
}
