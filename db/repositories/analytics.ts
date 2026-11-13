import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, localTimestampSql } from "./resources";

// Read-only queries behind GET /api/analytics/me. Every query is scoped to the
// session user through $1; no caller-supplied id is ever used.

// Each reservation falls into exactly one outcome. Stored statuses win; only
// 'confirmed' rows are classified by time, because nothing moves a confirmed
// reservation to 'completed' once it ends. 'past' therefore means "the booked
// time has ended", not verified attendance. Unrecognized statuses become
// 'other' so they are still counted in the total instead of being misfiled.
export const RESERVATION_OUTCOMES = [
  "upcoming",
  "in_progress",
  "completed",
  "past",
  "no_show",
  "cancelled",
  "other",
] as const;

export type ReservationOutcome = (typeof RESERVATION_OUTCOMES)[number];
export type OutcomeCounts = Record<ReservationOutcome, number>;

export const ANALYTICS_MONTHS = 6;
export const TOP_RESOURCE_LIMIT = 5;

// Reservations whose booked time has ended and that were not cancelled or
// missed. Drives the "Past" card and "Past Reserved Hours".
const PAST_OUTCOMES_SQL = "('completed', 'past')";
// Every recognized, non-cancelled reservation. Drives the category and
// top-resource reports.
const BOOKED_OUTCOMES_SQL = "('upcoming', 'in_progress', 'completed', 'past', 'no_show')";

const MY_RESERVATIONS_CTE = `
  mine AS (
    SELECT
      rv.reservation_id,
      rv.resource_id,
      rv.start_time,
      CASE
        WHEN rv.status = 'cancelled' THEN 'cancelled'
        WHEN rv.status = 'no_show' THEN 'no_show'
        WHEN rv.status = 'completed' THEN 'completed'
        WHEN rv.status = 'confirmed' AND rv.end_time <= ${CAMPUS_NOW_SQL} THEN 'past'
        WHEN rv.status = 'confirmed' AND rv.start_time <= ${CAMPUS_NOW_SQL} THEN 'in_progress'
        WHEN rv.status = 'confirmed' THEN 'upcoming'
        ELSE 'other'
      END AS outcome,
      EXTRACT(EPOCH FROM rv.end_time - rv.start_time) / 3600.0 AS hours
    FROM "Reservation" AS rv
    WHERE rv.user_id = $1
  )
`;

// The current campus month and the five before it, by reservation start time.
const WINDOW_START_SQL = `(date_trunc('month', ${CAMPUS_NOW_SQL}) - interval '${ANALYTICS_MONTHS - 1} months')`;
const WINDOW_END_SQL = `(date_trunc('month', ${CAMPUS_NOW_SQL}) + interval '1 month')`;

export const OVERVIEW_SQL = `
  WITH ${MY_RESERVATIONS_CTE}
  SELECT
    COUNT(*) AS total,
    ${RESERVATION_OUTCOMES.map((outcome) => `COUNT(*) FILTER (WHERE outcome = '${outcome}') AS ${outcome}`).join(",\n    ")},
    COALESCE(ROUND(SUM(hours) FILTER (WHERE outcome IN ${PAST_OUTCOMES_SQL})::numeric, 2), 0) AS past_reserved_hours,
    COUNT(*) FILTER (WHERE start_time < ${WINDOW_START_SQL}) AS before_window,
    COUNT(*) FILTER (WHERE start_time >= ${WINDOW_END_SQL}) AS after_window
  FROM mine
`;

export const MONTHLY_SQL = `
  WITH ${MY_RESERVATIONS_CTE},
  months AS (
    SELECT generate_series(
      ${WINDOW_START_SQL},
      date_trunc('month', ${CAMPUS_NOW_SQL}),
      interval '1 month'
    ) AS month_start
  )
  SELECT
    to_char(m.month_start, 'YYYY-MM') AS month,
    mine.outcome,
    COUNT(mine.reservation_id) AS count
  FROM months AS m
  LEFT JOIN mine ON date_trunc('month', mine.start_time) = m.month_start
  GROUP BY m.month_start, mine.outcome
  ORDER BY m.month_start, mine.outcome
`;

export const CATEGORY_SQL = `
  WITH ${MY_RESERVATIONS_CTE}
  SELECT
    c.category_id,
    c.category_name,
    COUNT(*) AS reservations,
    ROUND(SUM(mine.hours)::numeric, 2) AS hours
  FROM mine
  JOIN "Resource" AS r ON r.resource_id = mine.resource_id
  JOIN "ResourceCategory" AS c ON c.category_id = r.category_id
  WHERE mine.outcome IN ${BOOKED_OUTCOMES_SQL}
  GROUP BY c.category_id, c.category_name
  ORDER BY reservations DESC, hours DESC, c.category_name
`;

export const TOP_RESOURCES_SQL = `
  WITH ${MY_RESERVATIONS_CTE}
  SELECT
    r.resource_id,
    r.name AS resource_name,
    b.building_id,
    b.building_name,
    COUNT(*) AS reservations,
    ROUND(SUM(mine.hours)::numeric, 2) AS hours,
    ${localTimestampSql("MAX(mine.start_time)")} AS last_reserved_at
  FROM mine
  JOIN "Resource" AS r ON r.resource_id = mine.resource_id
  JOIN "Building" AS b ON b.building_id = r.building_id
  WHERE mine.outcome IN ${BOOKED_OUTCOMES_SQL}
  GROUP BY r.resource_id, r.name, b.building_id, b.building_name
  ORDER BY reservations DESC, hours DESC, r.name, r.resource_id
  LIMIT ${TOP_RESOURCE_LIMIT}
`;

export type UserAnalytics = {
  overview: {
    total: number;
    upcoming: number;
    // Recorded 'completed' plus confirmed reservations whose time has ended.
    past: number;
    cancelled: number;
    pastReservedHours: number;
    byOutcome: OutcomeCounts;
  };
  monthly: {
    months: Array<{ month: string; total: number; byOutcome: OutcomeCounts }>;
    // Reservations that start outside the charted months, so none go unaccounted for.
    beforeWindow: number;
    afterWindow: number;
  };
  categories: Array<{ id: number; name: string; reservations: number; hours: number }>;
  topResources: Array<{
    id: number;
    name: string;
    building: { id: number; name: string };
    reservations: number;
    hours: number;
    lastReservedAt: string;
  }>;
};

type Count = string | number;

type OverviewRow = Record<ReservationOutcome, Count> & {
  total: Count;
  past_reserved_hours: Count;
  before_window: Count;
  after_window: Count;
};

function emptyOutcomes(): OutcomeCounts {
  return Object.fromEntries(RESERVATION_OUTCOMES.map((outcome) => [outcome, 0])) as OutcomeCounts;
}

function isOutcome(value: string): value is ReservationOutcome {
  return (RESERVATION_OUTCOMES as readonly string[]).includes(value);
}

export async function getMyAnalytics(
  client: DatabaseClient,
  userId: number,
): Promise<UserAnalytics> {
  const [overview, monthly, categories, topResources] = await Promise.all([
    client.query<OverviewRow>(OVERVIEW_SQL, [userId]),
    client.query<{ month: string; outcome: string | null; count: Count }>(MONTHLY_SQL, [userId]),
    client.query<{ category_id: number; category_name: string; reservations: Count; hours: Count }>(
      CATEGORY_SQL,
      [userId],
    ),
    client.query<{
      resource_id: number;
      resource_name: string;
      building_id: number;
      building_name: string;
      reservations: Count;
      hours: Count;
      last_reserved_at: string;
    }>(TOP_RESOURCES_SQL, [userId]),
  ]);

  const totals = overview.rows[0];
  const byOutcome = emptyOutcomes();
  for (const outcome of RESERVATION_OUTCOMES) {
    byOutcome[outcome] = Number(totals?.[outcome] ?? 0);
  }

  const months = new Map<string, OutcomeCounts>();
  for (const row of monthly.rows) {
    const counts = months.get(row.month) ?? emptyOutcomes();
    months.set(row.month, counts);
    // An empty month comes back as a single row with a NULL outcome.
    if (row.outcome === null) continue;
    counts[isOutcome(row.outcome) ? row.outcome : "other"] += Number(row.count);
  }

  return {
    overview: {
      total: Number(totals?.total ?? 0),
      upcoming: byOutcome.upcoming,
      past: byOutcome.completed + byOutcome.past,
      cancelled: byOutcome.cancelled,
      pastReservedHours: Number(totals?.past_reserved_hours ?? 0),
      byOutcome,
    },
    monthly: {
      months: [...months].map(([month, counts]) => ({
        month,
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
        byOutcome: counts,
      })),
      beforeWindow: Number(totals?.before_window ?? 0),
      afterWindow: Number(totals?.after_window ?? 0),
    },
    categories: categories.rows.map((row) => ({
      id: row.category_id,
      name: row.category_name,
      reservations: Number(row.reservations),
      hours: Number(row.hours),
    })),
    topResources: topResources.rows.map((row) => ({
      id: row.resource_id,
      name: row.resource_name,
      building: { id: row.building_id, name: row.building_name },
      reservations: Number(row.reservations),
      hours: Number(row.hours),
      lastReservedAt: row.last_reserved_at,
    })),
  };
}
