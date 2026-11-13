import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import { parseCalendarQuery } from "../db/repositories/calendar";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

// The fake session user is id 6.
const resourceRow = {
  resource_id: 3,
  name: "Study Room",
  building_id: 1,
  building_name: "Newman Library",
  category_id: 2,
  category_name: "Study Room",
  capacity: 4,
  required_credits: 2,
  max_minutes: "120",
  total: "1",
};

function setup(role: string, resources: unknown[] = [resourceRow]) {
  const database = new FakeReadDatabase();
  database.sessionRole = role;
  database
    .respond("SELECT to_char(", [{ today: "2026-11-07", now_minutes: "600" }])
    .respond("SELECT r.resource_id", resources)
    .respond("WITH occurrences AS", [
      { resource_id: 3, start_minute: "480", end_minute: "1020" },
    ])
    .respond("SELECT rv.reservation_id", [
      { reservation_id: 70, resource_id: 3, user_id: 6, username: "maya_r", status: "confirmed", start_minute: "540", end_minute: "600" },
      { reservation_id: 71, resource_id: 3, user_id: 9, username: "jordan_p", status: "confirmed", start_minute: "660", end_minute: "720" },
    ])
    .respond("SELECT mp.resource_id", [
      { resource_id: 3, reason: "Cleaning", start_minute: "900", end_minute: "960" },
    ]);
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const get = (path: string) =>
    app.request(`http://localhost${path}`, { headers: authHeaders }, database.environment());
  return { database, get };
}

describe("calendar query validation", () => {
  it("defaults to today, no filters, and the default limit", () => {
    expect(parseCalendarQuery(new URLSearchParams(""))).toEqual({
      ok: true,
      value: { date: null, search: "", categoryId: null, buildingId: null, resourceId: null, limit: 30 },
    });
  });

  it("caps the limit", () => {
    const result = parseCalendarQuery(new URLSearchParams("limit=9999"));
    expect(result.ok && result.value.limit).toBe(50);
  });

  it.each(["date=2026-13-40", "date=tomorrow", "category=0", "building=abc", "resource=-1", "limit=0"])(
    "rejects %s",
    (query) => {
      expect(parseCalendarQuery(new URLSearchParams(query)).ok).toBe(false);
    },
  );
});

describe("GET /api/calendar", () => {
  it("requires a session", async () => {
    const database = new FakeReadDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const response = await app.request("http://localhost/api/calendar", {}, database.environment());
    expect(response.status).toBe(401);
  });

  it("gives students open windows and bookings without exposing other people", async () => {
    const { get, database } = setup("student");

    const response = await get("/api/calendar?date=2026-11-09");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      date: "2026-11-09",
      today: "2026-11-07",
      nowMinutes: 600,
      total: 1,
      resources: [{
        id: 3,
        name: "Study Room",
        building: { name: "Newman Library" },
        maxReservationMinutes: 120,
        windows: [{ start: 480, end: 1020 }],
        maintenance: [{ start: 900, end: 960, reason: "Cleaning" }],
        bookings: [
          { start: 540, end: 600, mine: true, id: null, userId: null, username: null },
          { start: 660, end: 720, mine: false, id: null, userId: null, username: null },
        ],
      }],
    });
    expect(JSON.stringify(body)).not.toMatch(/jordan_p|maya_r/);
    expectReadOnly(database.queries);
  });

  it("shows administrators who booked each slot", async () => {
    const { get } = setup("admin");

    const body = (await (await get("/api/calendar?date=2026-11-09")).json()) as {
      resources: Array<{ bookings: Array<{ id: number | null; username: string | null }> }>;
    };

    expect(body.resources[0].bookings).toMatchObject([
      { id: 70, userId: 6, username: "maya_r" },
      { id: 71, userId: 9, username: "jordan_p" },
    ]);
  });

  it("uses today when no date is given and binds the filters", async () => {
    const { get, database } = setup("student");

    const body = (await (await get("/api/calendar?search=50%25_off&category=2&building=1")).json()) as { date: string };

    expect(body.date).toBe("2026-11-07");
    const resourceQuery = database.queries.find((query) => query.text.startsWith("SELECT r.resource_id"));
    expect(resourceQuery?.values).toEqual(["50\\%\\_off", 2, 1, null, 30]);
    const windowsQuery = database.queries.find((query) => query.text.startsWith("WITH occurrences"));
    expect(windowsQuery?.values).toEqual([[3], "2026-11-07"]);
  });

  it("returns an empty list without querying bookings when nothing matches", async () => {
    const { get, database } = setup("student", []);

    const body = await (await get("/api/calendar?search=nothing")).json();

    expect(body).toMatchObject({ total: 0, resources: [] });
    expect(database.queries.some((query) => query.text.startsWith("SELECT rv.reservation_id"))).toBe(false);
  });

  it("rejects a bad date", async () => {
    const { get } = setup("student");
    expect((await get("/api/calendar?date=2026-02-31")).status).toBe(400);
  });
});
