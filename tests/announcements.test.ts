import { describe, expect, it } from "vitest";
import { createApp } from "../worker/index";
import { parseAnnouncementQuery } from "../worker/announcements";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

const maintenanceRow = {
  type: "maintenance",
  source_id: 5,
  resource_id: 15,
  resource_name: "War Memorial Racquetball Court 2",
  building_name: "War Memorial Hall",
  event_date: "2026-10-13T07:00:00",
  is_current: true,
  starts_label: "Oct 13, 2026 7:00 AM",
  ends_label: "Oct 15, 2026 10:00 PM",
  reason: "Wall panel repair.",
};

const upcomingRow = {
  ...maintenanceRow,
  source_id: 6,
  resource_id: 22,
  resource_name: "Squires Meeting Room B",
  building_name: "Squires Student Center",
  event_date: "2026-10-20T09:00:00",
  is_current: false,
  starts_label: "Oct 20, 2026 9:00 AM",
  ends_label: "Oct 20, 2026 9:00 PM",
  reason: "Projector replacement.",
};

const newRow = {
  type: "new",
  source_id: 23,
  resource_id: 23,
  resource_name: "Torgersen Project Room 3",
  building_name: "Torgersen Hall",
  event_date: "2026-10-10T09:00:00",
  is_current: false,
  starts_label: "Oct 10, 2026 9:00 AM",
  ends_label: null,
  reason: null,
};

function setup(rows: unknown[] = [upcomingRow, newRow, maintenanceRow]) {
  const database = new FakeReadDatabase().respond("SELECT * FROM (", rows);
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const get = (path: string, headers: Record<string, string> = authHeaders) =>
    app.request(`http://localhost${path}`, { headers }, database.environment());
  return { database, get };
}

describe("announcement query validation", () => {
  it("defaults to all types and 50 items", () => {
    expect(parseAnnouncementQuery(new URLSearchParams(""))).toEqual({
      ok: true,
      value: { type: null, limit: 50 },
    });
  });

  it("caps the limit at 50", () => {
    expect(parseAnnouncementQuery(new URLSearchParams("type=new&limit=1000"))).toEqual({
      ok: true,
      value: { type: "new", limit: 50 },
    });
  });

  it.each(["type=admin", "type='; DROP TABLE x; --", "limit=0", "limit=abc"])("rejects %s", (query) => {
    expect(parseAnnouncementQuery(new URLSearchParams(query)).ok).toBe(false);
  });
});

describe("GET /api/announcements", () => {
  it("requires a session", async () => {
    const { get, database } = setup();
    expect((await get("/api/announcements", {})).status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("returns a combined feed built from maintenance periods and new resources", async () => {
    const { get, database } = setup();
    const response = await get("/api/announcements");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      announcements: [
        {
          id: "maintenance-6",
          type: "maintenance",
          title: "Scheduled maintenance: Squires Meeting Room B",
          message:
            "Squires Meeting Room B in Squires Student Center will be under maintenance from Oct 20, 2026 9:00 AM to Oct 20, 2026 9:00 PM. Reason: Projector replacement.",
          date: "2026-10-20T09:00:00",
          resourceId: 22,
        },
        {
          id: "new-23",
          type: "new",
          title: "New resource: Torgersen Project Room 3",
          message:
            "Torgersen Project Room 3 in Torgersen Hall was added on Oct 10, 2026 9:00 AM and is now listed on CampusConnect.",
          date: "2026-10-10T09:00:00",
          resourceId: 23,
        },
        {
          id: "maintenance-5",
          type: "maintenance",
          title: "Maintenance in progress: War Memorial Racquetball Court 2",
          message:
            "War Memorial Racquetball Court 2 in War Memorial Hall is under maintenance from Oct 13, 2026 7:00 AM to Oct 15, 2026 10:00 PM. Reason: Wall panel repair.",
          date: "2026-10-13T07:00:00",
          resourceId: 15,
        },
      ],
    });

    const [query] = database.queries;
    expect(query.values).toEqual([null, 50]);
    expect(query.text).toContain('FROM "MaintenancePeriod" AS m');
    expect(query.text).toContain("m.end_time > (now() AT TIME ZONE 'America/New_York')");
    expect(query.text).toContain("r.created_at >= (now() AT TIME ZONE 'America/New_York') - interval '30 days'");
    expect(query.text).toContain("ORDER BY feed.sort_time DESC");
    expectReadOnly(database.queries);
  });

  it("passes the type filter and limit as parameters", async () => {
    const { get, database } = setup([maintenanceRow]);
    const response = await get("/api/announcements?type=maintenance&limit=10");

    expect(response.status).toBe(200);
    expect(((await response.json()) as { announcements: unknown[] }).announcements).toHaveLength(1);
    expect(database.queries[0].values).toEqual(["maintenance", 10]);
    expect(database.queries[0].text).not.toContain("'maintenance' AS type WHERE");
  });

  it("rejects an unknown type without querying", async () => {
    const { get, database } = setup();
    const response = await get("/api/announcements?type=admin");

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("Type must be one of: maintenance, new.");
    expect(database.queries).toEqual([]);
  });

  it("reports database failures as 503", async () => {
    const { get, database } = setup();
    database.failWith = new Error("timeout");

    const response = await get("/api/announcements");
    expect(response.status).toBe(503);
  });
});
