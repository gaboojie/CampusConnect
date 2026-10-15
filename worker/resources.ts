import type { DatabaseClient } from "./db";

// Timestamps are stored as campus wall-clock time (timestamp without time zone),
// so "now" must be converted to campus time instead of using the server clock.
export const CAMPUS_NOW_SQL = "(now() AT TIME ZONE 'America/New_York')";

export const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 12;
const MAX_OFFSET = 10_000;
const MAX_SEARCH_LENGTH = 100;
const MAX_FEATURES = 10;
const MAX_FEATURE_LENGTH = 100;
const MAX_CAPACITY = 10_000;
const MAX_INTEGER_ID = 2_147_483_647;
const SHORT_DESCRIPTION_LENGTH = 160;
const RECENT_REVIEW_LIMIT = 5;
const UPCOMING_MAINTENANCE_LIMIT = 10;

export const RESOURCE_SORTS = ["name", "rating", "capacity"] as const;
export type ResourceSort = (typeof RESOURCE_SORTS)[number];

export type ResourceSearch = {
  q: string | null;
  categoryId: number | null;
  buildingId: number | null;
  features: string[];
  minCapacity: number | null;
  // Local campus timestamps, e.g. "2026-10-14 18:00".
  slot: { start: string; end: string } | null;
  sort: ResourceSort;
  limit: number;
  offset: number;
};

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export type ResourceSummary = {
  id: number;
  name: string;
  category: { id: number; name: string };
  building: { id: number; name: string };
  capacity: number;
  shortDescription: string;
  averageRating: number | null;
  reviewCount: number;
  thumbnailUrl: string | null;
};

export type ResourceSearchResult = {
  resources: ResourceSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type ResourceFilters = {
  categories: Array<{ id: number; name: string }>;
  buildings: Array<{ id: number; name: string }>;
  features: string[];
};

export type ResourceDetails = {
  id: number;
  name: string;
  description: string;
  locationDescription: string;
  category: { id: number; name: string; description: string };
  building: { id: number; name: string; address: string };
  latitude: number;
  longitude: number;
  capacity: number;
  requiredCredits: number;
  maxReservationMinutes: number | null;
  ownerUsername: string;
  createdAt: string;
  averageRating: number | null;
  reviewCount: number;
  features: Array<{ name: string; description: string }>;
  weeklyHours: Array<{
    date: string;
    weekday: string;
    windows: Array<{ opensAt: string; closesAt: string }>;
  }>;
  upcomingMaintenance: Array<{
    id: number;
    startTime: string;
    endTime: string;
    reason: string;
  }>;
  images: Array<{ id: number; altText: string | null; url: string | null }>;
  recentReviews: Array<{
    id: number;
    rating: number;
    reason: string | null;
    createdAt: string;
    reviewerUsername: string | null;
  }>;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const INTEGER_PATTERN = /^\d+$/;

// Formats a timestamp column as an ISO-like local string without a "Z" suffix,
// so clients read it as campus wall-clock time.
export function localTimestampSql(column: string): string {
  return `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS')`;
}

export function parsePositiveId(raw: string | undefined | null): number | null {
  if (!raw || !INTEGER_PATTERN.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_INTEGER_ID ? value : null;
}

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseInteger(
  raw: string | null,
  name: string,
  min: number,
  max: number,
): Validation<number | null> {
  if (raw === null || raw.trim() === "") return { ok: true, value: null };
  const trimmed = raw.trim();
  if (!INTEGER_PATTERN.test(trimmed) || Number(trimmed) < min || Number(trimmed) > max) {
    return { ok: false, error: `${name} must be a whole number between ${min} and ${max}.` };
  }
  return { ok: true, value: Number(trimmed) };
}

function parseId(raw: string | null, name: string): Validation<number | null> {
  if (raw === null || raw.trim() === "") return { ok: true, value: null };
  const value = parsePositiveId(raw.trim());
  return value === null
    ? { ok: false, error: `${name} must be a valid id.` }
    : { ok: true, value };
}

export type Slot = { start: string; end: string };

// Parses a same-day slot from "YYYY-MM-DD" + "HH:MM" + "HH:MM" into local campus
// timestamps. All three blank means no slot.
export function parseSlot(
  rawDate: unknown,
  rawStart: unknown,
  rawEnd: unknown,
): Validation<Slot | null> {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const date = text(rawDate);
  const start = text(rawStart);
  const end = text(rawEnd);

  if (!date && !start && !end) return { ok: true, value: null };
  if (!date || !start || !end) {
    return { ok: false, error: "Choose a date, start time, and end time together." };
  }
  if (!isCalendarDate(date)) {
    return { ok: false, error: "Date must be a valid YYYY-MM-DD date." };
  }
  if (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) {
    return { ok: false, error: "Times must use the 24-hour HH:MM format." };
  }
  if (end <= start) {
    return { ok: false, error: "End time must be after the start time." };
  }
  return { ok: true, value: { start: `${date} ${start}`, end: `${date} ${end}` } };
}

export function parseResourceSearch(params: URLSearchParams): Validation<ResourceSearch> {
  const q = (params.get("q") ?? "").trim();
  if (q.length > MAX_SEARCH_LENGTH) {
    return { ok: false, error: `Search text must be ${MAX_SEARCH_LENGTH} characters or fewer.` };
  }

  const categoryId = parseId(params.get("category"), "Category");
  if (!categoryId.ok) return categoryId;
  const buildingId = parseId(params.get("building"), "Building");
  if (!buildingId.ok) return buildingId;

  const features = [
    ...new Set(params.getAll("feature").map((feature) => feature.trim()).filter(Boolean)),
  ];
  if (features.length > MAX_FEATURES) {
    return { ok: false, error: `Choose at most ${MAX_FEATURES} features.` };
  }
  if (features.some((feature) => feature.length > MAX_FEATURE_LENGTH)) {
    return { ok: false, error: "Feature names are too long." };
  }

  const minCapacity = parseInteger(params.get("minCapacity"), "Minimum capacity", 1, MAX_CAPACITY);
  if (!minCapacity.ok) return minCapacity;

  const slot = parseSlot(params.get("date"), params.get("start"), params.get("end"));
  if (!slot.ok) return slot;

  const sortRaw = (params.get("sort") ?? "").trim() || "name";
  if (!RESOURCE_SORTS.includes(sortRaw as ResourceSort)) {
    return { ok: false, error: "Sort must be one of: name, rating, capacity." };
  }

  // Oversized page sizes are capped rather than rejected.
  const limitRaw = params.get("limit");
  const limitDigits = limitRaw?.trim() ?? "";
  if (limitDigits !== "" && (!INTEGER_PATTERN.test(limitDigits) || Number(limitDigits) < 1)) {
    return { ok: false, error: "Limit must be a positive whole number." };
  }
  const limit = limitDigits === ""
    ? DEFAULT_PAGE_SIZE
    : Math.min(Number(limitDigits), MAX_PAGE_SIZE);

  const offset = parseInteger(params.get("offset"), "Offset", 0, MAX_OFFSET);
  if (!offset.ok) return offset;

  return {
    ok: true,
    value: {
      q: q || null,
      categoryId: categoryId.value,
      buildingId: buildingId.value,
      features,
      minCapacity: minCapacity.value,
      slot: slot.value,
      sort: sortRaw as ResourceSort,
      limit,
      offset: offset.value ?? 0,
    },
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Slot predicates shared by resource search and reservations. Arguments are SQL
// expressions (a column or a bound parameter), never user text.

// The slot must fit inside one occurrence of an availability window. For a
// repeating window, the candidate occurrence is the latest one starting at or
// before the slot start: start_time + floor((slot_start - start_time) / offset) * offset.
export function slotFitsAvailabilitySql(resourceId: string, start: string, end: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM "ResourceAvailability" AS a
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN a.repeats_offset IS NULL THEN a.start_time
          ELSE a.start_time + FLOOR(
            EXTRACT(EPOCH FROM (${start} - a.start_time))
            / NULLIF(EXTRACT(EPOCH FROM a.repeats_offset), 0)
          )::integer * a.repeats_offset
        END AS occurrence_start
      ) AS o
      WHERE a.resource_id = ${resourceId}
        AND o.occurrence_start >= a.start_time
        AND o.occurrence_start <= ${start}
        AND ${end} <= o.occurrence_start + (a.end_time - a.start_time)
        AND (
          a.repeats_offset IS NULL
          OR a.repeats_until IS NULL
          OR o.occurrence_start <= a.repeats_until
        )
    )
  `;
}

// A non-cancelled reservation of the resource overlaps the slot. Pass
// excludeReservationId to ignore the reservation being rescheduled.
export function reservationOverlapSql(
  resourceId: string,
  start: string,
  end: string,
  excludeReservationId?: string,
): string {
  return `
    EXISTS (
      SELECT 1
      FROM "Reservation" AS rv
      WHERE rv.resource_id = ${resourceId}
        AND rv.status <> 'cancelled'
        AND rv.start_time < ${end}
        AND rv.end_time > ${start}${
          excludeReservationId ? `\n        AND rv.reservation_id <> ${excludeReservationId}` : ""
        }
    )
  `;
}

export function maintenanceOverlapSql(resourceId: string, start: string, end: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM "MaintenancePeriod" AS mp
      WHERE mp.resource_id = ${resourceId}
        AND mp.start_time < ${end}
        AND mp.end_time > ${start}
    )
  `;
}

// Builds the shared FROM/WHERE clause. Every user value is bound as a parameter;
// only fixed SQL fragments are concatenated.
export function buildResourceSearchFilter(search: ResourceSearch): {
  whereSql: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  const conditions: string[] = [];
  const param = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (search.q) {
    const pattern = param(`%${escapeLikePattern(search.q)}%`);
    conditions.push(
      `(r.name ILIKE ${pattern} ESCAPE '\\' OR r.description ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (search.categoryId !== null) {
    conditions.push(`r.category_id = ${param(search.categoryId)}`);
  }
  if (search.buildingId !== null) {
    conditions.push(`r.building_id = ${param(search.buildingId)}`);
  }
  if (search.minCapacity !== null) {
    conditions.push(`r.capacity >= ${param(search.minCapacity)}`);
  }
  if (search.features.length > 0) {
    const features = param(search.features);
    conditions.push(`
      r.resource_id IN (
        SELECT f.resource_id
        FROM "ResourceFeature" AS f
        WHERE f.feature_name = ANY(${features}::text[])
        GROUP BY f.resource_id
        HAVING COUNT(DISTINCT f.feature_name) = cardinality(${features}::text[])
      )
    `);
  }
  if (search.slot) {
    const start = `${param(search.slot.start)}::timestamp`;
    const end = `${param(search.slot.end)}::timestamp`;

    conditions.push(slotFitsAvailabilitySql("r.resource_id", start, end));
    conditions.push(`NOT ${reservationOverlapSql("r.resource_id", start, end)}`);
    conditions.push(`NOT ${maintenanceOverlapSql("r.resource_id", start, end)}`);
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

const ORDER_BY: Record<ResourceSort, string> = {
  name: "r.name ASC, r.resource_id ASC",
  rating: "average_rating DESC NULLS LAST, review_count DESC, r.name ASC, r.resource_id ASC",
  capacity: "r.capacity DESC, r.name ASC, r.resource_id ASC",
};

export function buildResourceSearchQueries(search: ResourceSearch): {
  count: { text: string; values: unknown[] };
  page: { text: string; values: unknown[] };
} {
  const { whereSql, values } = buildResourceSearchFilter(search);
  const limitParam = `$${values.length + 1}`;
  const offsetParam = `$${values.length + 2}`;

  return {
    count: {
      text: `
        SELECT COUNT(*)::integer AS total
        FROM "Resource" AS r
        ${whereSql}
      `,
      values,
    },
    page: {
      text: `
        SELECT
          r.resource_id,
          r.name,
          r.description,
          r.capacity,
          c.category_id,
          c.category_name,
          b.building_id,
          b.building_name,
          rating.average_rating,
          COALESCE(rating.review_count, 0) AS review_count
        FROM "Resource" AS r
        JOIN "ResourceCategory" AS c ON c.category_id = r.category_id
        JOIN "Building" AS b ON b.building_id = r.building_id
        LEFT JOIN (
          SELECT
            resource_id,
            ROUND(AVG(rating)::numeric, 2)::float8 AS average_rating,
            COUNT(*)::integer AS review_count
          FROM "ResourceReview"
          GROUP BY resource_id
        ) AS rating ON rating.resource_id = r.resource_id
        ${whereSql}
        ORDER BY ${ORDER_BY[search.sort]}
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      values: [...values, search.limit, search.offset],
    },
  };
}

type ResourceSummaryRow = {
  resource_id: number;
  name: string;
  description: string;
  capacity: number;
  category_id: number;
  category_name: string;
  building_id: number;
  building_name: string;
  average_rating: number | string | null;
  review_count: number | string;
};

function toNumberOrNull(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function shortenDescription(description: string): string {
  if (description.length <= SHORT_DESCRIPTION_LENGTH) return description;
  return `${description.slice(0, SHORT_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

export async function searchResources(
  client: DatabaseClient,
  search: ResourceSearch,
): Promise<ResourceSearchResult> {
  const queries = buildResourceSearchQueries(search);
  const countResult = await client.query<{ total: number | string }>(
    queries.count.text,
    queries.count.values,
  );
  const pageResult = await client.query<ResourceSummaryRow>(
    queries.page.text,
    queries.page.values,
  );

  return {
    resources: pageResult.rows.map((row) => ({
      id: row.resource_id,
      name: row.name,
      category: { id: row.category_id, name: row.category_name },
      building: { id: row.building_id, name: row.building_name },
      capacity: row.capacity,
      shortDescription: shortenDescription(row.description),
      averageRating: toNumberOrNull(row.average_rating),
      reviewCount: Number(row.review_count),
      // No route serves R2 images yet; the UI shows a placeholder.
      thumbnailUrl: null,
    })),
    total: Number(countResult.rows[0]?.total ?? 0),
    limit: search.limit,
    offset: search.offset,
  };
}

export async function getResourceFilters(client: DatabaseClient): Promise<ResourceFilters> {
  const categories = await client.query<{ category_id: number; category_name: string }>(
    `
      SELECT category_id, category_name
      FROM "ResourceCategory"
      ORDER BY category_name
    `,
  );
  const buildings = await client.query<{ building_id: number; building_name: string }>(
    `
      SELECT building_id, building_name
      FROM "Building"
      ORDER BY building_name
    `,
  );
  const features = await client.query<{ feature_name: string }>(
    `
      SELECT DISTINCT feature_name
      FROM "ResourceFeature"
      ORDER BY feature_name
    `,
  );

  return {
    categories: categories.rows.map((row) => ({ id: row.category_id, name: row.category_name })),
    buildings: buildings.rows.map((row) => ({ id: row.building_id, name: row.building_name })),
    features: features.rows.map((row) => row.feature_name),
  };
}

type ResourceDetailRow = {
  resource_id: number;
  name: string;
  description: string;
  location_description: string;
  latitude: number | string;
  longitude: number | string;
  capacity: number;
  required_credits: number;
  max_reservation_minutes: number | null;
  created_at: string;
  category_id: number;
  category_name: string;
  category_description: string;
  building_id: number;
  building_name: string;
  address: string;
  owner_username: string;
  image_id: number | null;
  image_alt_text: string | null;
  average_rating: number | string | null;
  review_count: number | string;
};

// Weekly hours are not stored per weekday: ResourceAvailability holds a window that
// repeats every repeats_offset until repeats_until. This expands each window's
// occurrences that start during the next 7 campus days.
export const WEEKLY_HOURS_SQL = `
  WITH week AS (
    SELECT
      ${CAMPUS_NOW_SQL}::date::timestamp AS week_start,
      ${CAMPUS_NOW_SQL}::date::timestamp + interval '7 days' AS week_end
  ),
  days AS (
    SELECT w.week_start + n * interval '1 day' AS day_start
    FROM week AS w
    CROSS JOIN generate_series(0, 6) AS n
  ),
  occurrences AS (
    SELECT
      a.start_time + k * COALESCE(a.repeats_offset, interval '0') AS occurrence_start,
      a.end_time - a.start_time AS duration
    FROM "ResourceAvailability" AS a
    CROSS JOIN week AS w
    CROSS JOIN LATERAL generate_series(
      CASE
        WHEN a.repeats_offset IS NULL THEN 0
        ELSE GREATEST(0, CEIL(
          EXTRACT(EPOCH FROM (w.week_start - a.start_time))
          / NULLIF(EXTRACT(EPOCH FROM a.repeats_offset), 0)
        )::integer)
      END,
      CASE
        WHEN a.repeats_offset IS NULL THEN 0
        ELSE FLOOR(
          EXTRACT(EPOCH FROM (w.week_end - a.start_time))
          / NULLIF(EXTRACT(EPOCH FROM a.repeats_offset), 0)
        )::integer
      END
    ) AS k
    WHERE a.resource_id = $1
      AND (
        a.repeats_offset IS NULL
        OR a.repeats_until IS NULL
        OR a.start_time + k * a.repeats_offset <= a.repeats_until
      )
  )
  SELECT
    to_char(d.day_start, 'YYYY-MM-DD') AS day,
    to_char(d.day_start, 'FMDay') AS weekday,
    to_char(o.occurrence_start, 'HH24:MI') AS opens_at,
    to_char(o.occurrence_start + o.duration, 'HH24:MI') AS closes_at
  FROM days AS d
  LEFT JOIN occurrences AS o
    ON o.occurrence_start >= d.day_start
    AND o.occurrence_start < d.day_start + interval '1 day'
  ORDER BY d.day_start, o.occurrence_start
`;

export async function getResourceDetails(
  client: DatabaseClient,
  resourceId: number,
): Promise<ResourceDetails | null> {
  const resourceResult = await client.query<ResourceDetailRow>(
    `
      SELECT
        r.resource_id,
        r.name,
        r.description,
        r.location_description,
        r.latitude,
        r.longitude,
        r.capacity,
        r.required_credits,
        (EXTRACT(EPOCH FROM r.max_reservation_time) / 60)::integer AS max_reservation_minutes,
        ${localTimestampSql("r.created_at")} AS created_at,
        c.category_id,
        c.category_name,
        c.description AS category_description,
        b.building_id,
        b.building_name,
        b.address,
        u.username AS owner_username,
        img.image_id,
        img.alt_text AS image_alt_text,
        rating.average_rating,
        COALESCE(rating.review_count, 0) AS review_count
      FROM "Resource" AS r
      JOIN "ResourceCategory" AS c ON c.category_id = r.category_id
      JOIN "Building" AS b ON b.building_id = r.building_id
      JOIN "User" AS u ON u.user_id = r.owner_id
      LEFT JOIN "ImageMetadata" AS img ON img.image_id = r.resource_image_id
      LEFT JOIN (
        SELECT
          resource_id,
          ROUND(AVG(rating)::numeric, 2)::float8 AS average_rating,
          COUNT(*)::integer AS review_count
        FROM "ResourceReview"
        WHERE resource_id = $1
        GROUP BY resource_id
      ) AS rating ON rating.resource_id = r.resource_id
      WHERE r.resource_id = $1
    `,
    [resourceId],
  );
  const resource = resourceResult.rows[0];

  if (!resource) {
    return null;
  }

  const features = await client.query<{ feature_name: string; description: string }>(
    `
      SELECT feature_name, description
      FROM "ResourceFeature"
      WHERE resource_id = $1
      ORDER BY feature_name, feature_id
    `,
    [resourceId],
  );
  const hours = await client.query<{
    day: string;
    weekday: string;
    opens_at: string | null;
    closes_at: string | null;
  }>(WEEKLY_HOURS_SQL, [resourceId]);
  const maintenance = await client.query<{
    maintenance_id: number;
    start_time: string;
    end_time: string;
    reason: string;
  }>(
    `
      SELECT
        maintenance_id,
        ${localTimestampSql("start_time")} AS start_time,
        ${localTimestampSql("end_time")} AS end_time,
        reason
      FROM "MaintenancePeriod"
      WHERE resource_id = $1
        AND end_time > ${CAMPUS_NOW_SQL}
      ORDER BY start_time, maintenance_id
      LIMIT ${UPCOMING_MAINTENANCE_LIMIT}
    `,
    [resourceId],
  );
  const reviews = await client.query<{
    review_id: number;
    rating: number;
    reason: string | null;
    created_at: string;
    reviewer_username: string | null;
  }>(
    `
      SELECT
        rr.review_id,
        rr.rating,
        rr.reason,
        ${localTimestampSql("rr.created_at")} AS created_at,
        CASE WHEN rr.is_anonymous_review THEN NULL ELSE u.username END AS reviewer_username
      FROM "ResourceReview" AS rr
      JOIN "User" AS u ON u.user_id = rr.reviewer_user_id
      WHERE rr.resource_id = $1
      ORDER BY rr.created_at DESC, rr.review_id DESC
      LIMIT ${RECENT_REVIEW_LIMIT}
    `,
    [resourceId],
  );

  const weeklyHours: ResourceDetails["weeklyHours"] = [];
  for (const row of hours.rows) {
    let day = weeklyHours.at(-1);
    if (!day || day.date !== row.day) {
      day = { date: row.day, weekday: row.weekday, windows: [] };
      weeklyHours.push(day);
    }
    if (row.opens_at && row.closes_at) {
      day.windows.push({ opensAt: row.opens_at, closesAt: row.closes_at });
    }
  }

  return {
    id: resource.resource_id,
    name: resource.name,
    description: resource.description,
    locationDescription: resource.location_description,
    category: {
      id: resource.category_id,
      name: resource.category_name,
      description: resource.category_description,
    },
    building: {
      id: resource.building_id,
      name: resource.building_name,
      address: resource.address,
    },
    latitude: Number(resource.latitude),
    longitude: Number(resource.longitude),
    capacity: resource.capacity,
    requiredCredits: resource.required_credits,
    maxReservationMinutes: toNumberOrNull(resource.max_reservation_minutes),
    ownerUsername: resource.owner_username,
    createdAt: resource.created_at,
    averageRating: toNumberOrNull(resource.average_rating),
    reviewCount: Number(resource.review_count),
    features: features.rows.map((row) => ({
      name: row.feature_name,
      description: row.description,
    })),
    weeklyHours,
    upcomingMaintenance: maintenance.rows.map((row) => ({
      id: row.maintenance_id,
      startTime: row.start_time,
      endTime: row.end_time,
      reason: row.reason,
    })),
    // Image metadata exists, but no route serves R2 objects yet, so url stays null.
    images: resource.image_id === null
      ? []
      : [{ id: resource.image_id, altText: resource.image_alt_text, url: null }],
    recentReviews: reviews.rows.map((row) => ({
      id: row.review_id,
      rating: row.rating,
      reason: row.reason,
      createdAt: row.created_at,
      reviewerUsername: row.reviewer_username,
    })),
  };
}
