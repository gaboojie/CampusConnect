import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import { parseAdminReservationQuery, parseAdminUserQuery } from "../db/repositories/admin";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

const userRow = {
  user_id: 7,
  username: "alex_k",
  email: "alex.k@vt.edu",
  role: "student",
  created_at: "2026-08-24T10:00:00Z",
  email_verified_at: "2026-08-24T10:05:00Z",
  credit_balance: 12,
  credit_last_reset: "2026-10-01",
  is_banned: false,
  can_add_resources: false,
  email_notifications_on: true,
  total: "31",
};

function setup(role: string) {
  const database = new FakeReadDatabase();
  database.sessionRole = role;
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const get = (path: string, headers: Record<string, string> = authHeaders) =>
    app.request(`http://localhost${path}`, { headers }, database.environment());
  return { database, get };
}

describe("admin query validation", () => {
  it("defaults to page 1 of 25 and caps the page size", () => {
    expect(parseAdminUserQuery(new URLSearchParams(""))).toEqual({
      ok: true,
      value: { page: 1, pageSize: 25, search: "", role: null, status: null },
    });
    const capped = parseAdminUserQuery(new URLSearchParams("pageSize=5000"));
    expect(capped.ok && capped.value.pageSize).toBe(100);
  });

  it.each(["role=owner", "status=gone", "page=0", "pageSize=abc"])("rejects user query %s", (query) => {
    expect(parseAdminUserQuery(new URLSearchParams(query)).ok).toBe(false);
  });

  it("rejects an unknown reservation status", () => {
    expect(parseAdminReservationQuery(new URLSearchParams("status=lost")).ok).toBe(false);
  });
});

describe("admin API access", () => {
  it("requires a session", async () => {
    const { get, database } = setup("admin");
    expect((await get("/api/admin/users", {})).status).toBe(401);
    expect(database.queries).toEqual([]);
  });

  it.each(["student", "staff"])("returns 403 for a %s", async (role) => {
    const { get, database } = setup(role);
    for (const path of ["/api/admin/stats", "/api/admin/users", "/api/admin/users/7", "/api/admin/reservations"]) {
      expect((await get(path)).status).toBe(403);
    }
    expect(database.queries).toEqual([]);
  });
});

describe("GET /api/admin/users", () => {
  it("lists users without secrets and reports the total", async () => {
    const { get, database } = setup("admin");
    database.respond("SELECT u.user_id", [userRow, { ...userRow, user_id: 8, username: "pending", email_verified_at: null }]);

    const response = await get("/api/admin/users?search=al&role=student&status=active&page=2");
    const body = (await response.json()) as { items: Record<string, unknown>[]; total: number; page: number };

    expect(response.status).toBe(200);
    expect(body.total).toBe(31);
    expect(body.page).toBe(2);
    expect(body.items[0]).toMatchObject({ userId: 7, username: "alex_k", status: "active" });
    expect(body.items[1]).toMatchObject({ status: "unverified" });
    expect(JSON.stringify(body)).not.toMatch(/password|token/i);
    expect(database.queries.at(-1)?.values).toEqual(["al", "student", "active", 25, 25]);
    expectReadOnly(database.queries.slice(1));
  });

  it("escapes LIKE wildcards in the search term", async () => {
    const { get, database } = setup("admin");
    database.respond("SELECT u.user_id", []);
    await get("/api/admin/users?search=50%25_off");
    expect(database.queries.at(-1)?.values[0]).toBe("50\\%\\_off");
  });

  it("rejects invalid filters", async () => {
    const { get } = setup("admin");
    expect((await get("/api/admin/users?role=owner")).status).toBe(400);
  });
});

describe("GET /api/admin/users/:id", () => {
  it("returns details with counts", async () => {
    const { get, database } = setup("admin");
    database
      .respond("SELECT u.user_id", [userRow])
      .respond('SELECT COUNT(*) AS count FROM "Resource"', [{ count: "2" }])
      .respond("SELECT status, COUNT(*)", [{ status: "confirmed", count: "3" }]);

    const response = await get("/api/admin/users/7");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { userId: 7, resourcesOwned: 2, reservationCounts: { confirmed: 3 }, creditLastReset: "2026-10-01" },
    });
  });

  it("returns 404 for an unknown user and 400 for a bad id", async () => {
    const { get, database } = setup("admin");
    database.respond("SELECT u.user_id", []);
    expect((await get("/api/admin/users/999")).status).toBe(404);
    expect((await get("/api/admin/users/abc")).status).toBe(400);
  });
});

describe("GET /api/admin/stats", () => {
  it("summarizes users, resources, and reservations", async () => {
    const { get, database } = setup("admin");
    database
      .respond("SELECT COUNT(*) AS total", [{ total: "10", verified: "8", unverified: "2", banned: "1" }])
      .respond("SELECT role, COUNT(*)", [{ role: "admin", count: "1" }, { role: "student", count: "9" }])
      .respond('SELECT COUNT(*) AS count FROM "Resource"', [{ count: "22" }])
      .respond("SELECT status, COUNT(*)", [{ status: "confirmed", count: "4" }, { status: "cancelled", count: "1" }]);

    const response = await get("/api/admin/stats");
    expect(await response.json()).toEqual({
      stats: {
        users: { total: 10, verified: 8, unverified: 2, banned: 1, byRole: { admin: 1, student: 9 } },
        resources: { total: 22 },
        reservations: { total: 5, byStatus: { confirmed: 4, cancelled: 1 } },
      },
    });
  });
});

describe("GET /api/admin/reservations", () => {
  it("lists reservations", async () => {
    const { get, database } = setup("admin");
    database.respond("SELECT r.reservation_id", [
      {
        reservation_id: 1,
        status: "confirmed",
        start_time: "2026-10-20 09:00:00",
        end_time: "2026-10-20 10:00:00",
        created_at: "2026-10-15 08:00:00",
        user_id: 7,
        username: "alex_k",
        resource_id: 3,
        resource_name: "Study Room",
        total: "1",
      },
    ]);

    const body = await (await get("/api/admin/reservations?status=confirmed")).json();
    expect(body).toMatchObject({
      total: 1,
      items: [{ id: 1, startTime: "2026-10-20T09:00:00", user: { username: "alex_k" }, resource: { name: "Study Room" } }],
    });
  });

  it("reports an unavailable database", async () => {
    // No responder is registered, so the list query itself fails.
    const { get } = setup("admin");
    expect((await get("/api/admin/users")).status).toBe(503);
  });
});
