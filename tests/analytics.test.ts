import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import type { DatabaseClient } from "../db/client";
import {
  CATEGORY_SQL,
  MONTHLY_SQL,
  OVERVIEW_SQL,
  RESERVATION_OUTCOMES,
  TOP_RESOURCES_SQL,
} from "../db/repositories/analytics";
import { CAMPUS_NOW_SQL } from "../db/repositories/resources";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

// The fake session user (maya_r).
const SESSION_USER_ID = 6;

const isOverview = (query: string) => query.includes("AS past_reserved_hours");
const isMonthly = (query: string) => query.includes("generate_series");
const isCategory = (query: string) => query.includes('JOIN "ResourceCategory"');
const isTopResources = (query: string) => query.includes('JOIN "Building"');

const MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];

const zeroOverview = {
  total: "0",
  upcoming: "0",
  in_progress: "0",
  completed: "0",
  past: "0",
  no_show: "0",
  cancelled: "0",
  other: "0",
  past_reserved_hours: "0",
  before_window: "0",
  after_window: "0",
};

const emptyMonths = MONTHS.map((month) => ({ month, outcome: null, count: "0" }));

function setup(options: { banned?: boolean } = {}) {
  const database = new FakeReadDatabase();
  const createDatabaseClient = (): DatabaseClient => {
    const client = database.createClient();
    if (!options.banned) return client;
    // Report the session user as banned.
    const query = (async (text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values);
      if (!text.includes('FROM "Session"')) return result;
      return { ...result, rows: result.rows.map((row) => ({ ...row, is_banned: true })) };
    }) as DatabaseClient["query"];
    return { ...client, query };
  };
  const app = createApp({ createDatabaseClient });
  const get = (path: string, headers: Record<string, string> = authHeaders) =>
    app.request(`http://localhost${path}`, { headers }, database.environment());
  return { database, get };
}

function respondEmpty(database: FakeReadDatabase) {
  database
    .respond(isOverview, [zeroOverview])
    .respond(isMonthly, emptyMonths)
    .respond(isCategory, [])
    .respond(isTopResources, []);
}

describe("analytics SQL", () => {
  const all = [OVERVIEW_SQL, MONTHLY_SQL, CATEGORY_SQL, TOP_RESOURCES_SQL];

  it("scopes every query to the $1 user and classifies by campus time", () => {
    for (const sql of all) {
      expect(sql).toContain("WHERE rv.user_id = $1");
      expect(sql).toContain(CAMPUS_NOW_SQL);
      expect(sql).not.toMatch(/\$2/);
    }
  });

  it("checks stored statuses before deriving outcomes from time", () => {
    const branches = [
      "rv.status = 'cancelled' THEN 'cancelled'",
      "rv.status = 'no_show' THEN 'no_show'",
      "rv.status = 'completed' THEN 'completed'",
      "rv.status = 'confirmed' AND rv.end_time <=",
      "rv.status = 'confirmed' AND rv.start_time <=",
      "rv.status = 'confirmed' THEN 'upcoming'",
      "ELSE 'other'",
    ];
    const positions = branches.map((branch) => OVERVIEW_SQL.indexOf(branch));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("counts every outcome in the overview", () => {
    for (const outcome of RESERVATION_OUTCOMES) {
      expect(OVERVIEW_SQL).toContain(`FILTER (WHERE outcome = '${outcome}') AS ${outcome}`);
    }
    expect(OVERVIEW_SQL).toMatch(/past_reserved_hours/);
    expect(OVERVIEW_SQL).toContain("outcome IN ('completed', 'past')");
  });

  it("excludes cancelled and unknown statuses from the category and resource reports", () => {
    for (const sql of [CATEGORY_SQL, TOP_RESOURCES_SQL]) {
      expect(sql).toContain("mine.outcome IN ('upcoming', 'in_progress', 'completed', 'past', 'no_show')");
    }
    expect(TOP_RESOURCES_SQL).toMatch(/LIMIT 5/);
  });
});

describe("GET /api/analytics/me access", () => {
  it("requires a session and runs no queries without one", async () => {
    const { database, get } = setup();
    expect((await get("/api/analytics/me", {})).status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it("returns 403 for a banned account before any analytics query", async () => {
    const { database, get } = setup({ banned: true });
    expect((await get("/api/analytics/me")).status).toBe(403);
    expect(database.queries.filter((query) => !query.text.includes('FROM "Session"'))).toEqual([]);
  });

  it("only ever queries the session user, ignoring a user id in the URL", async () => {
    const { database, get } = setup();
    respondEmpty(database);

    const response = await get("/api/analytics/me?userId=7&user_id=7");
    expect(response.status).toBe(200);

    const analyticsQueries = database.queries.filter((query) => !query.text.includes('FROM "Session"'));
    expect(analyticsQueries).toHaveLength(4);
    for (const query of analyticsQueries) {
      expect(query.values).toEqual([SESSION_USER_ID]);
    }
    expectReadOnly(analyticsQueries);
  });

  it("returns 503 when the database fails", async () => {
    const { database, get } = setup();
    database.failWith = new Error("connection lost");
    const response = await get("/api/analytics/me");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Unable to load your activity right now." });
  });
});

describe("GET /api/analytics/me response", () => {
  it("returns zeros, six empty months, and empty lists for a user with no reservations", async () => {
    const { database, get } = setup();
    respondEmpty(database);

    const { analytics } = (await (await get("/api/analytics/me")).json()) as { analytics: Record<string, any> };

    expect(analytics.overview).toEqual({
      total: 0,
      upcoming: 0,
      past: 0,
      cancelled: 0,
      pastReservedHours: 0,
      byOutcome: { upcoming: 0, in_progress: 0, completed: 0, past: 0, no_show: 0, cancelled: 0, other: 0 },
    });
    expect(analytics.monthly.months.map((month: { month: string }) => month.month)).toEqual(MONTHS);
    expect(analytics.monthly.months.every((month: { total: number }) => month.total === 0)).toBe(true);
    expect(analytics.monthly).toMatchObject({ beforeWindow: 0, afterWindow: 0 });
    expect(analytics.categories).toEqual([]);
    expect(analytics.topResources).toEqual([]);
  });

  it("keeps recorded completions separate from time-derived past reservations", async () => {
    const { database, get } = setup();
    database
      .respond(isOverview, [
        {
          ...zeroOverview,
          total: "10",
          upcoming: "2",
          in_progress: "1",
          completed: "3",
          past: "1",
          no_show: "1",
          cancelled: "1",
          other: "1",
          past_reserved_hours: "4.50",
          before_window: "1",
          after_window: "1",
        },
      ])
      .respond(isMonthly, [
        ...emptyMonths.slice(0, 4),
        { month: "2026-10", outcome: "completed", count: "2" },
        { month: "2026-10", outcome: "no_show", count: "1" },
        { month: "2026-11", outcome: "past", count: "1" },
        { month: "2026-11", outcome: "in_progress", count: "1" },
        { month: "2026-11", outcome: "upcoming", count: "1" },
        { month: "2026-11", outcome: "cancelled", count: "1" },
        // A label the API does not know is still counted, as "other".
        { month: "2026-11", outcome: "mystery", count: "1" },
      ])
      .respond(isCategory, [{ category_id: 1, category_name: "Group Study Room", reservations: "6", hours: "8.25" }])
      .respond(isTopResources, [
        {
          resource_id: 4,
          resource_name: "Newman Group Study Room 4",
          building_id: 1,
          building_name: "Carol M. Newman Library",
          reservations: "3",
          hours: "6.00",
          last_reserved_at: "2026-11-12T18:00:00",
        },
      ]);

    const { analytics } = (await (await get("/api/analytics/me")).json()) as { analytics: Record<string, any> };

    expect(analytics.overview).toEqual({
      total: 10,
      upcoming: 2,
      past: 4,
      cancelled: 1,
      pastReservedHours: 4.5,
      byOutcome: { upcoming: 2, in_progress: 1, completed: 3, past: 1, no_show: 1, cancelled: 1, other: 1 },
    });

    const months = analytics.monthly.months as Array<{ month: string; total: number; byOutcome: Record<string, number> }>;
    expect(months.map((month) => month.month)).toEqual(MONTHS);
    expect(months[4]).toEqual({
      month: "2026-10",
      total: 3,
      byOutcome: { upcoming: 0, in_progress: 0, completed: 2, past: 0, no_show: 1, cancelled: 0, other: 0 },
    });
    expect(months[5].byOutcome).toMatchObject({ past: 1, in_progress: 1, upcoming: 1, cancelled: 1, other: 1 });
    // Charted months plus the reservations outside the window account for every reservation.
    const charted = months.reduce((sum, month) => sum + month.total, 0);
    expect(charted + analytics.monthly.beforeWindow + analytics.monthly.afterWindow).toBe(analytics.overview.total);

    expect(analytics.categories).toEqual([{ id: 1, name: "Group Study Room", reservations: 6, hours: 8.25 }]);
    expect(analytics.topResources).toEqual([
      {
        id: 4,
        name: "Newman Group Study Room 4",
        building: { id: 1, name: "Carol M. Newman Library" },
        reservations: 3,
        hours: 6,
        lastReservedAt: "2026-11-12T18:00:00",
      },
    ]);
  });
});
