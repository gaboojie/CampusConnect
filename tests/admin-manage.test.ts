import { describe, expect, it, vi } from "vitest";
import { createApp } from "../backend/index";
import { parseAdminCreateUser, parseAdminUpdateUser } from "../db/repositories/admin";
import { FakeReadDatabase, authHeaders } from "./support/fakeReadDatabase";

// The fake session user is id 6 (maya_r); setup() gives them the requested role.
const SESSION_USER_ID = 6;

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
  can_add_resources: true,
  email_notifications_on: true,
};

function setup(role = "admin") {
  const database = new FakeReadDatabase();
  database.sessionRole = role;
  database.respond((query) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(query), []);
  const bucket = { delete: vi.fn(async () => {}) };
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(
      `http://localhost${path}`,
      {
        method,
        headers: { ...authHeaders, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { ...database.environment(), RESOURCE_IMAGES: bucket },
    );
  return { database, bucket, send };
}

// Answers the three queries getUserDetail runs.
function respondWithUserDetail(database: FakeReadDatabase, row: Record<string, unknown>) {
  database
    .respond("SELECT u.user_id", [row])
    .respond('SELECT COUNT(*) AS count FROM "Resource"', [{ count: "0" }])
    .respond("SELECT status, COUNT(*)", []);
}

const sqlOf = (database: FakeReadDatabase, prefix: string) =>
  database.queries.filter((query) => query.text.startsWith(prefix));

describe("admin user input validation", () => {
  it("defaults a new account to a student who can list resources", () => {
    const result = parseAdminCreateUser({ username: "new_user", email: "New@VT.edu", password: "longenough" });
    expect(result).toEqual({
      ok: true,
      value: {
        username: "new_user",
        email: "new@vt.edu",
        password: "longenough",
        role: "student",
        canAddResources: true,
        emailNotificationsOn: true,
      },
    });
  });

  it("reports every invalid field when creating", () => {
    const result = parseAdminCreateUser({ username: "a", email: "a@gmail.com", password: "short", role: "owner" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors).sort()).toEqual(["email", "password", "role", "username"]);
  });

  it("requires at least one valid change when updating", () => {
    expect(parseAdminUpdateUser({}).ok).toBe(false);
    expect(parseAdminUpdateUser({ isBanned: "yes" }).ok).toBe(false);
    expect(parseAdminUpdateUser({ role: "owner" }).ok).toBe(false);
    expect(parseAdminUpdateUser({ isBanned: true, role: "staff" })).toEqual({
      ok: true,
      value: { isBanned: true, role: "staff" },
    });
  });
});

describe("admin write access", () => {
  it.each(["student", "staff"])("returns 403 for a %s", async (role) => {
    const { send, database } = setup(role);
    expect((await send("POST", "/api/admin/users", { username: "x" })).status).toBe(403);
    expect((await send("PATCH", "/api/admin/users/7", { isBanned: true })).status).toBe(403);
    expect((await send("GET", "/api/admin/resources")).status).toBe(403);
    expect((await send("DELETE", "/api/admin/resources/3")).status).toBe(403);
    expect(database.queries).toEqual([]);
  });
});

describe("POST /api/admin/users", () => {
  const body = { username: "new_user", email: "new@vt.edu", password: "longenough", role: "staff" };

  it("creates a verified account with a hashed password and the starting credits", async () => {
    const { send, database } = setup();
    database.respond('INSERT INTO "User"', [{ user_id: 9 }]).respond('INSERT INTO "CreditTransaction"', []);
    respondWithUserDetail(database, { ...userRow, user_id: 9, username: "new_user", email: "new@vt.edu", role: "staff" });

    const response = await send("POST", "/api/admin/users", body);
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toMatchObject({ user: { userId: 9, username: "new_user", role: "staff" } });
    expect(JSON.stringify(json)).not.toMatch(/password|longenough/i);

    const [insert] = sqlOf(database, 'INSERT INTO "User"');
    expect(insert.text).toContain("email_verified_at");
    expect(insert.values.slice(0, 2)).toEqual(["new_user", "new@vt.edu"]);
    expect(String(insert.values[2])).toMatch(/^pbkdf2_sha256\$/);
    expect(insert.values).not.toContain("longenough");
    expect(insert.values.slice(3)).toEqual(["staff", 20, true, true]);
    expect(sqlOf(database, 'INSERT INTO "CreditTransaction"')[0].values).toEqual([9, 20]);
    expect(database.queries.map((query) => query.text)).toContain("COMMIT");
  });

  it("rejects invalid input without touching the database", async () => {
    const { send, database } = setup();
    const response = await send("POST", "/api/admin/users", { username: "a", email: "a@gmail.com", password: "x" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ fieldErrors: { username: expect.any(String), email: expect.any(String) } });
    expect(database.queries).toEqual([]);
  });

  it("returns 409 for a duplicate username or email and rolls back", async () => {
    const { send, database } = setup();
    database.respond('INSERT INTO "User"', () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    });

    const response = await send("POST", "/api/admin/users", body);
    expect(response.status).toBe(409);
    expect(database.queries.map((query) => query.text)).toContain("ROLLBACK");
  });
});

describe("PATCH /api/admin/users/:id", () => {
  it("updates only the supplied fields", async () => {
    const { send, database } = setup();
    database
      .respond("SELECT is_account_deleted", [{ is_account_deleted: false }])
      .respond('UPDATE "User" SET', []);
    respondWithUserDetail(database, { ...userRow, role: "staff", is_banned: true });

    const response = await send("PATCH", "/api/admin/users/7", { isBanned: true, role: "staff" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { userId: 7, role: "staff", isBanned: true, status: "banned" } });
    const [update] = sqlOf(database, 'UPDATE "User" SET');
    expect(update.text).toContain("role = $2, is_banned = $3");
    expect(update.text).not.toContain("username");
    expect(update.values).toEqual([7, "staff", true]);
  });

  it("stops an administrator from banning or demoting themselves", async () => {
    const { send, database } = setup();
    const ban = await send("PATCH", `/api/admin/users/${SESSION_USER_ID}`, { isBanned: true });
    const demote = await send("PATCH", `/api/admin/users/${SESSION_USER_ID}`, { role: "student" });

    expect(ban.status).toBe(409);
    expect(demote.status).toBe(409);
    expect(database.queries).toEqual([]);
  });

  it("lets an administrator edit their own non-privileged fields", async () => {
    const { send, database } = setup();
    database
      .respond("SELECT is_account_deleted", [{ is_account_deleted: false }])
      .respond('UPDATE "User" SET', []);
    respondWithUserDetail(database, { ...userRow, user_id: SESSION_USER_ID, role: "admin" });

    const response = await send("PATCH", `/api/admin/users/${SESSION_USER_ID}`, { role: "admin", canAddResources: false });
    expect(response.status).toBe(200);
  });

  it("returns 404 for an unknown user and 409 for a deleted account", async () => {
    const missing = setup();
    missing.database.respond("SELECT is_account_deleted", []);
    expect((await missing.send("PATCH", "/api/admin/users/99", { isBanned: true })).status).toBe(404);

    const deleted = setup();
    deleted.database.respond("SELECT is_account_deleted", [{ is_account_deleted: true }]);
    expect((await deleted.send("PATCH", "/api/admin/users/7", { isBanned: true })).status).toBe(409);
    expect(sqlOf(deleted.database, 'UPDATE "User"')).toEqual([]);
  });

  it("validates the id and the body", async () => {
    const { send, database } = setup();
    expect((await send("PATCH", "/api/admin/users/abc", { isBanned: true })).status).toBe(400);
    expect((await send("PATCH", "/api/admin/users/7", {})).status).toBe(400);
    expect((await send("PATCH", "/api/admin/users/7", { role: "owner" })).status).toBe(400);
    expect(database.queries).toEqual([]);
  });

  it("returns 409 when the new username or email is taken", async () => {
    const { send, database } = setup();
    database.respond("SELECT is_account_deleted", [{ is_account_deleted: false }]);
    database.respond('UPDATE "User" SET', () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    });
    expect((await send("PATCH", "/api/admin/users/7", { username: "taken_name" })).status).toBe(409);
  });
});

describe("DELETE /api/admin/users/:id", () => {
  function respondForAccountDelete(database: FakeReadDatabase, lookup: unknown[]) {
    database
      .respond("SELECT username, is_account_deleted", lookup)
      .respond("SELECT u.username, u.profile_image_id", [
        { username: "alex_k", profile_image_id: null, object_key: null },
      ])
      .respond((query) => query.startsWith("DELETE FROM"), [])
      .respond('UPDATE "User" SET password_hash = NULL', []);
  }

  it("soft-deletes the account the same way self-service deletion does", async () => {
    const { send, database } = setup();
    respondForAccountDelete(database, [{ username: "alex_k", is_account_deleted: false }]);

    const response = await send("DELETE", "/api/admin/users/7");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    const update = sqlOf(database, 'UPDATE "User" SET password_hash = NULL')[0];
    expect(update.text).toContain("is_account_deleted = TRUE");
    expect(update.values).toEqual([7]);
    expect(sqlOf(database, 'DELETE FROM "User"')).toEqual([]);
    expect(database.queries.map((query) => query.text).at(-1)).toBe("COMMIT");
  });

  it("refuses to delete the signed-in administrator", async () => {
    const { send, database } = setup();
    expect((await send("DELETE", `/api/admin/users/${SESSION_USER_ID}`)).status).toBe(409);
    expect(database.queries).toEqual([]);
  });

  it("returns 404 for an unknown user and 409 for an already deleted one", async () => {
    const missing = setup();
    respondForAccountDelete(missing.database, []);
    expect((await missing.send("DELETE", "/api/admin/users/99")).status).toBe(404);

    const gone = setup();
    respondForAccountDelete(gone.database, [{ username: "alex_k", is_account_deleted: true }]);
    expect((await gone.send("DELETE", "/api/admin/users/7")).status).toBe(409);
    expect(sqlOf(gone.database, 'UPDATE "User"')).toEqual([]);
  });

  it("requires an administrator and a valid id", async () => {
    const student = setup("student");
    expect((await student.send("DELETE", "/api/admin/users/7")).status).toBe(403);
    expect(student.database.queries).toEqual([]);
    expect((await setup().send("DELETE", "/api/admin/users/abc")).status).toBe(400);
  });
});

describe("GET /api/admin/resources", () => {
  it("lists resources with owner, building, and upcoming counts", async () => {
    const { send, database } = setup();
    database.respond("SELECT r.resource_id", [
      {
        resource_id: 3,
        name: "Study Room",
        building_id: 1,
        building_name: "Newman Library",
        category_id: 2,
        category_name: "Study Room",
        owner_id: 7,
        username: "alex_k",
        created_at: "2026-09-01T12:00:00Z",
        upcoming: "2",
        total: "1",
      },
    ]);

    const response = await send("GET", "/api/admin/resources?search=50%25_off&page=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ id: 3, name: "Study Room", owner: { id: 7, username: "alex_k" }, upcomingReservations: 2 }],
    });
    expect(database.queries.at(-1)?.values[0]).toBe("50\\%\\_off");
  });

  it("rejects a bad page", async () => {
    const { send } = setup();
    expect((await send("GET", "/api/admin/resources?page=0")).status).toBe(400);
  });
});

describe("GET /api/admin/resources/:id", () => {
  const detailRow = {
    resource_id: 3,
    name: "Study Room",
    description: "A quiet room.",
    location_description: "Second floor",
    capacity: 4,
    required_credits: 2,
    max_reservation_minutes: 120,
    created_at: "2026-09-01T12:00:00",
    category_id: 2,
    category_name: "Study Room",
    category_description: "Rooms for studying",
    building_id: 1,
    building_name: "Newman Library",
    address: "560 Drillfield Dr",
    building_latitude: "37.2284",
    building_longitude: "-80.4234",
    owner_username: "alex_k",
    image_id: null,
    image_alt_text: null,
    average_rating: null,
    review_count: 0,
  };

  function respondWithDetails(database: FakeReadDatabase, resourceRows: unknown[] = [detailRow]) {
    database
      .respond("SELECT r.resource_id, r.name, r.description", resourceRows)
      .respond("SELECT feature_name", [{ feature_name: "Whiteboard", description: "Wall mounted" }])
      .respond("WITH week AS", [])
      .respond("SELECT maintenance_id", [])
      .respond("SELECT rr.review_id", [])
      .respond("SELECT u.user_id, u.username", [{ user_id: 7, username: "alex_k" }])
      .respond("SELECT status, COUNT(*)", [{ status: "confirmed", count: "3" }])
      .respond('SELECT COUNT(*) AS count FROM "Reservation"', [{ count: "2" }]);
  }

  it("returns the public details plus owner and reservation counts", async () => {
    const { send, database } = setup();
    respondWithDetails(database);

    const response = await send("GET", "/api/admin/resources/3");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: {
        id: 3,
        name: "Study Room",
        features: [{ name: "Whiteboard" }],
        owner: { id: 7, username: "alex_k" },
        reservationCounts: { confirmed: 3 },
        upcomingReservations: 2,
      },
    });
  });

  it("returns 404 for an unknown resource and 400 for a bad id", async () => {
    const { send, database } = setup();
    respondWithDetails(database, []);
    expect((await send("GET", "/api/admin/resources/99")).status).toBe(404);
    expect((await send("GET", "/api/admin/resources/abc")).status).toBe(400);
  });
});

describe("DELETE /api/admin/resources/:id", () => {
  const resourceRow = { name: "Study Room", required_credits: 2, image_id: 5, object_key: "resources/3/photo.jpg" };

  type DeleteScenario = { found?: unknown[]; active?: unknown[]; upcoming?: unknown[]; failDelete?: boolean };

  // First matching responder wins, so every outcome is configured here up front.
  function respondForDelete(database: FakeReadDatabase, options: DeleteScenario = {}) {
    let nextNotification = 41;
    database
      .respond("SELECT r.name, r.required_credits", options.found ?? [resourceRow])
      .respond((query) => query.includes("AND start_time <="), options.active ?? [])
      .respond((query) => query.includes("AND start_time >") && query.includes("FOR UPDATE"), options.upcoming ?? [])
      .respond('SELECT user_id FROM "User"', [])
      .respond('UPDATE "User" SET credit_balance', [])
      .respond('INSERT INTO "CreditTransaction"', [])
      .respond('UPDATE "Notification" SET email_status', [])
      .respond('INSERT INTO "Notification"', () => [{ notification_id: nextNotification++ }])
      .respond('UPDATE "Notification" SET email_workflow_id', [])
      .respond('UPDATE "Notification" SET reservation_id = NULL', [])
      .respond('DELETE FROM "Resource"', () => {
        if (options.failDelete) throw new Error("boom");
        return [];
      })
      .respond('DELETE FROM "ImageMetadata"', []);
  }

  const upcoming = [
    { reservation_id: 70, user_id: 7, start_time: "2026-12-01T09:00:00", end_time: "2026-12-01T10:00:00" },
    { reservation_id: 71, user_id: 8, start_time: "2026-12-02T09:00:00", end_time: "2026-12-02T10:00:00" },
  ];

  it("deletes the resource, refunds and notifies bookers, and removes the image", async () => {
    const { send, database, bucket } = setup();
    respondForDelete(database, { upcoming });

    const response = await send("DELETE", "/api/admin/resources/3");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, cancelledReservations: 2 });
    expect(sqlOf(database, 'UPDATE "User" SET credit_balance').map((query) => query.values)).toEqual([
      [7, 2],
      [8, 2],
    ]);
    expect(sqlOf(database, 'INSERT INTO "CreditTransaction"').map((query) => query.values)).toEqual([
      [7, 2],
      [8, 2],
    ]);
    expect(sqlOf(database, 'INSERT INTO "Notification"')).toHaveLength(2);

    // Notices must be detached before the reservations vanish with the resource.
    const order = database.queries.map((query) => query.text);
    const detach = order.findIndex((text) => text.startsWith('UPDATE "Notification" SET reservation_id = NULL'));
    const remove = order.findIndex((text) => text.startsWith('DELETE FROM "Resource"'));
    expect(detach).toBeGreaterThan(-1);
    expect(detach).toBeLessThan(remove);
    expect(sqlOf(database, 'UPDATE "Notification" SET reservation_id = NULL')[0].values).toEqual([[41, 42]]);

    expect(order.at(-1)).toBe("COMMIT");
    expect(bucket.delete).toHaveBeenCalledWith("resources/3/photo.jpg");
  });

  it("deletes a resource with no upcoming reservations without refunds", async () => {
    const { send, database } = setup();
    respondForDelete(database, { found: [{ ...resourceRow, image_id: null, object_key: null }] });

    const response = await send("DELETE", "/api/admin/resources/3");

    expect(await response.json()).toEqual({ deleted: true, cancelledReservations: 0 });
    expect(sqlOf(database, 'INSERT INTO "CreditTransaction"')).toEqual([]);
    expect(sqlOf(database, 'DELETE FROM "ImageMetadata"')).toEqual([]);
  });

  it("returns 404 for an unknown resource", async () => {
    const { send, database } = setup();
    respondForDelete(database, { found: [] });
    expect((await send("DELETE", "/api/admin/resources/3")).status).toBe(404);
    expect(sqlOf(database, 'DELETE FROM "Resource"')).toEqual([]);
  });

  it("refuses while a reservation is in progress", async () => {
    const { send, database, bucket } = setup();
    respondForDelete(database, { active: [{ start_time: "2026-11-07T09:00:00", end_time: "2026-11-07T10:00:00" }] });

    const response = await send("DELETE", "/api/admin/resources/3");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("in progress") });
    expect(sqlOf(database, 'DELETE FROM "Resource"')).toEqual([]);
    expect(database.queries.map((query) => query.text)).toContain("ROLLBACK");
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("rolls back and keeps the image when a statement fails", async () => {
    const { send, database, bucket } = setup();
    respondForDelete(database, { upcoming, failDelete: true });

    const response = await send("DELETE", "/api/admin/resources/3");

    expect(response.status).toBe(503);
    expect(database.queries.map((query) => query.text)).toContain("ROLLBACK");
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  it("validates the id", async () => {
    const { send, database } = setup();
    expect((await send("DELETE", "/api/admin/resources/abc")).status).toBe(400);
    expect(database.queries).toEqual([]);
  });
});
