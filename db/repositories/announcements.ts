import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, MAX_PAGE_SIZE, localTimestampSql, type Validation } from "./resources";

export const ANNOUNCEMENT_TYPES = ["maintenance", "new"] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

const DEFAULT_ANNOUNCEMENT_LIMIT = 50;
const NEW_RESOURCE_WINDOW_DAYS = 30;

export type AnnouncementQuery = {
  type: AnnouncementType | null;
  limit: number;
};

export type Announcement = {
  id: string;
  type: AnnouncementType;
  title: string;
  message: string;
  date: string;
  resourceId: number;
};

export function parseAnnouncementQuery(params: URLSearchParams): Validation<AnnouncementQuery> {
  const typeRaw = (params.get("type") ?? "").trim();
  if (typeRaw && !ANNOUNCEMENT_TYPES.includes(typeRaw as AnnouncementType)) {
    return { ok: false, error: "Type must be one of: maintenance, new." };
  }

  const limitRaw = (params.get("limit") ?? "").trim();
  if (limitRaw && (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1)) {
    return { ok: false, error: "Limit must be a positive whole number." };
  }

  return {
    ok: true,
    value: {
      type: (typeRaw || null) as AnnouncementType | null,
      limit: limitRaw ? Math.min(Number(limitRaw), MAX_PAGE_SIZE) : DEFAULT_ANNOUNCEMENT_LIMIT,
    },
  };
}

type AnnouncementRow = {
  type: AnnouncementType;
  source_id: number;
  resource_id: number;
  resource_name: string;
  building_name: string;
  event_date: string;
  is_current: boolean;
  starts_label: string;
  ends_label: string | null;
  reason: string | null;
};

const DATE_LABEL_FORMAT = "Mon FMDD, YYYY FMHH12:MI AM";

// The feed is derived from existing rows only: current/upcoming MaintenancePeriod rows
// and resources whose created_at falls in the last 30 days.
export const ANNOUNCEMENTS_SQL = `
  SELECT *
  FROM (
    SELECT
      'maintenance' AS type,
      m.maintenance_id AS source_id,
      r.resource_id,
      r.name AS resource_name,
      b.building_name,
      m.start_time AS sort_time,
      ${localTimestampSql("m.start_time")} AS event_date,
      m.start_time <= ${CAMPUS_NOW_SQL} AS is_current,
      to_char(m.start_time, '${DATE_LABEL_FORMAT}') AS starts_label,
      to_char(m.end_time, '${DATE_LABEL_FORMAT}') AS ends_label,
      m.reason
    FROM "MaintenancePeriod" AS m
    JOIN "Resource" AS r ON r.resource_id = m.resource_id
    JOIN "Building" AS b ON b.building_id = r.building_id
    WHERE m.end_time > ${CAMPUS_NOW_SQL}

    UNION ALL

    SELECT
      'new' AS type,
      r.resource_id AS source_id,
      r.resource_id,
      r.name AS resource_name,
      b.building_name,
      r.created_at AS sort_time,
      ${localTimestampSql("r.created_at")} AS event_date,
      FALSE AS is_current,
      to_char(r.created_at, '${DATE_LABEL_FORMAT}') AS starts_label,
      NULL AS ends_label,
      NULL AS reason
    FROM "Resource" AS r
    JOIN "Building" AS b ON b.building_id = r.building_id
    WHERE r.created_at >= ${CAMPUS_NOW_SQL} - interval '${NEW_RESOURCE_WINDOW_DAYS} days'
  ) AS feed
  WHERE $1::text IS NULL OR feed.type = $1::text
  ORDER BY feed.sort_time DESC, feed.type, feed.source_id DESC
  LIMIT $2
`;

function toAnnouncement(row: AnnouncementRow): Announcement {
  const place = `${row.resource_name} in ${row.building_name}`;

  if (row.type === "maintenance") {
    const verb = row.is_current ? "is under maintenance" : "will be under maintenance";
    const reason = row.reason ? ` Reason: ${row.reason}` : "";
    return {
      id: `maintenance-${row.source_id}`,
      type: "maintenance",
      title: `${row.is_current ? "Maintenance in progress" : "Scheduled maintenance"}: ${row.resource_name}`,
      message: `${place} ${verb} from ${row.starts_label} to ${row.ends_label}.${reason}`,
      date: row.event_date,
      resourceId: row.resource_id,
    };
  }

  return {
    id: `new-${row.source_id}`,
    type: "new",
    title: `New resource: ${row.resource_name}`,
    message: `${place} was added on ${row.starts_label} and is now listed on CampusConnect.`,
    date: row.event_date,
    resourceId: row.resource_id,
  };
}

export async function getAnnouncements(
  client: DatabaseClient,
  query: AnnouncementQuery,
): Promise<Announcement[]> {
  const result = await client.query<AnnouncementRow>(ANNOUNCEMENTS_SQL, [query.type, query.limit]);
  return result.rows.map(toAnnouncement);
}
