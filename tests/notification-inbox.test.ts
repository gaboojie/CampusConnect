import { describe, expect, it } from "vitest";
import { createApp } from "../backend/index";
import { parseInboxQuery } from "../db/repositories/inbox";
import { FakeReadDatabase, authHeaders } from "./support/fakeReadDatabase";

// The fake session user is id 6.
function setup() {
  const database = new FakeReadDatabase();
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const request = (path: string, method = "GET") =>
    app.request(`http://localhost${path}`, { method, headers: authHeaders }, database.environment());
  return { database, request };
}

describe("inbox query validation", () => {
  it("defaults to all notifications, first page", () => {
    expect(parseInboxQuery(new URLSearchParams(""))).toEqual({
      ok: true,
      value: { filter: "all", page: 1, pageSize: 20 },
    });
  });

  it.each(["filter=read", "page=0", "page=abc", "pageSize=51", "pageSize=0"])("rejects %s", (query) => {
    expect(parseInboxQuery(new URLSearchParams(query)).ok).toBe(false);
  });
});

describe("GET /api/notifications", () => {
  it("requires a session", async () => {
    const database = new FakeReadDatabase();
    const app = createApp({ createDatabaseClient: () => database.createClient() });
    const response = await app.request("http://localhost/api/notifications", {}, database.environment());
    expect(response.status).toBe(401);
  });

  it("returns the user's delivered notifications with counts", async () => {
    const { database, request } = setup();
    database
      .respond("SELECT COUNT(*) FILTER", [{ total: "2", unread: "1" }])
      .respond("SELECT n.notification_id", [
        {
          notification_id: 12,
          notification_type: "reservation_cancelled",
          message: "Your reservation was cancelled.",
          reservation_id: null,
          delivered_at: "2026-11-07T09:30:00",
          is_read: false,
        },
        {
          notification_id: 9,
          notification_type: "reservation_reminder",
          message: "Reminder: your reservation starts soon.",
          reservation_id: 40,
          delivered_at: "2026-11-06T13:00:00",
          is_read: true,
        },
      ]);

    const response = await request("/api/notifications");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          id: 12,
          type: "reservation_cancelled",
          message: "Your reservation was cancelled.",
          reservationId: null,
          deliveredAt: "2026-11-07T09:30:00",
          isRead: false,
        },
        {
          id: 9,
          type: "reservation_reminder",
          message: "Reminder: your reservation starts soon.",
          reservationId: 40,
          deliveredAt: "2026-11-06T13:00:00",
          isRead: true,
        },
      ],
      unreadCount: 1,
      total: 2,
      page: 1,
      pageSize: 20,
    });
  });

  it("only reads the signed-in user's rows and applies filter and paging", async () => {
    const { database, request } = setup();
    database.respond("SELECT COUNT(*) FILTER", [{ total: "0", unread: "0" }]).respond("SELECT n.notification_id", []);

    await request("/api/notifications?filter=unread&page=3&pageSize=10");

    const list = database.queries.find((query) => query.text.includes("SELECT n.notification_id"));
    expect(list?.values).toEqual([6, true, 10, 20]);
    const counts = database.queries.find((query) => query.text.includes("COUNT(*) FILTER"));
    expect(counts?.values).toEqual([6, true]);
  });

  it("hides reminders that are not yet due or whose reservation is not confirmed", async () => {
    const { database, request } = setup();
    database.respond("SELECT COUNT(*) FILTER", [{ total: "0", unread: "0" }]).respond("SELECT n.notification_id", []);

    await request("/api/notifications");

    const list = database.queries.find((query) => query.text.includes("SELECT n.notification_id"))?.text ?? "";
    expect(list).toMatch(/COALESCE\(n\.scheduled_for, n\.created_at\) <=/);
    expect(list).toMatch(/rv\.status = 'confirmed'/);
  });

  it("rejects a bad filter", async () => {
    const { request } = setup();
    expect((await request("/api/notifications?filter=archived")).status).toBe(400);
  });
});

describe("marking notifications read", () => {
  it("marks one of the user's notifications read", async () => {
    const { database, request } = setup();
    database.respond('UPDATE "Notification" SET read_at', [{ notification_id: 12 }]);

    const response = await request("/api/notifications/12/read", "POST");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: true });
    const update = database.queries.find((query) => query.text.includes('UPDATE "Notification"'));
    expect(update?.values).toEqual([12, 6]);
  });

  it("returns 404 for someone else's or a missing notification", async () => {
    const { database, request } = setup();
    database.respond('UPDATE "Notification" SET read_at', []);

    expect((await request("/api/notifications/99/read", "POST")).status).toBe(404);
  });

  it("rejects a bad id", async () => {
    const { request } = setup();
    expect((await request("/api/notifications/abc/read", "POST")).status).toBe(400);
  });

  it("marks everything read and reports how many changed", async () => {
    const { database, request } = setup();
    database.respond('UPDATE "Notification" AS target', [{ notification_id: 1 }, { notification_id: 2 }]);

    const response = await request("/api/notifications/read-all", "POST");

    expect(await response.json()).toEqual({ updated: 2 });
    const update = database.queries.find((query) => query.text.includes('UPDATE "Notification" AS target'));
    expect(update?.values).toEqual([6]);
  });
});
