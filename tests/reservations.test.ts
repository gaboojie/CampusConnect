import { describe, expect, it } from "vitest";
import { hashSessionToken } from "../backend/auth";
import type { DatabaseClient, DatabaseQueryResult } from "../db/client";
import { createApp } from "../backend/index";
import { LOCK_RESOURCE_SQL, LOCK_USER_SQL } from "../db/repositories/reservations";

// Times are local campus "YYYY-MM-DD HH:MM" strings, which compare correctly as text.
const NOW = "2026-10-14 12:00";

type FakeReservation = {
  id: number;
  userId: number;
  resourceId: number;
  start: string;
  end: string;
  status: string;
};

type FakeResource = {
  name: string;
  maxMinutes: number | null;
  // Daily availability window.
  opensAt: string;
  closesAt: string;
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const LOCK_RESOURCE = normalize(LOCK_RESOURCE_SQL);
const LOCK_USER = normalize(LOCK_USER_SQL);

const toMinutes = (stamp: string) => {
  const [hours, minutes] = stamp.slice(-5).split(":").map(Number);
  return hours * 60 + minutes;
};
const iso = (stamp: string) => `${stamp.replace(" ", "T")}:00`;
const overlaps = (a: { start: string; end: string }, start: string, end: string) =>
  a.start < end && a.end > start;

// A small in-memory model of the reservation tables. It understands exactly the
// queries db/repositories/reservations.ts sends, evaluates the slot checks in JavaScript,
// and implements row locks: FOR UPDATE / FOR NO KEY UPDATE wait until the
// holding client sends COMMIT or ROLLBACK.
class FakeReservationDatabase {
  sessions = new Map<string, number>();
  bannedUsers = new Set<number>();
  resources = new Map<number, FakeResource>([
    [1, { name: "Newman Group Study Room 1", maxMinutes: 120, opensAt: "08:00", closesAt: "23:00" }],
    [2, { name: "Squires Meeting Room B", maxMinutes: null, opensAt: "08:00", closesAt: "23:00" }],
  ]);
  maintenance: Array<{ resourceId: number; start: string; end: string }> = [];
  reservations: FakeReservation[] = [];
  nextId = 100;
  nextNotificationId = 1000;
  locksEnabled = true;
  // Every query, tagged with the client that sent it.
  log: Array<{ client: number; text: string; values: readonly unknown[] }> = [];
  failOn: ((query: string) => boolean) | null = null;

  private lockQueues = new Map<string, Promise<void>>();
  private clientCount = 0;

  async addSession(token: string, userId: number) {
    this.sessions.set(await hashSessionToken(token), userId);
  }

  addReservation(reservation: Omit<FakeReservation, "id"> & { id?: number }) {
    const row = { id: reservation.id ?? this.nextId++, ...reservation };
    this.reservations.push(row);
    return row;
  }

  // Queries sent by the first request's endpoint client. The session lookup runs
  // on a separate client and is not logged.
  queries() {
    const client = this.log[0]?.client;
    return this.log.filter((entry) => entry.client === client).map((entry) => entry.text);
  }

  // Waits for the lock, then returns its release function.
  private async acquire(key: string): Promise<() => void> {
    const previous = this.lockQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => current);
    this.lockQueues.set(key, chained);
    await previous;
    return release;
  }

  private row(reservation: FakeReservation) {
    const resource = this.resources.get(reservation.resourceId)!;
    return {
      reservation_id: reservation.id,
      status: reservation.status,
      start_time: iso(reservation.start),
      end_time: iso(reservation.end),
      created_at: "2026-10-10T09:00:00",
      resource_id: reservation.resourceId,
      resource_name: resource.name,
      building_id: 1,
      building_name: "Carol M. Newman Library",
      can_modify: reservation.status === "confirmed" && reservation.start > NOW,
      is_upcoming: reservation.end > NOW,
    };
  }

  private checks(values: readonly unknown[]) {
    const [resourceId, start, end, userId, exclude] = values as [number, string, string, number, number?];
    const resource = this.resources.get(resourceId);
    if (!resource) return [];

    const maxMinutes = resource.maxMinutes ?? 240;
    const active = this.reservations.filter(
      (reservation) =>
        reservation.status !== "cancelled" &&
        reservation.id !== exclude &&
        overlaps(reservation, start, end),
    );

    return [
      {
        in_future: start > NOW,
        too_long: toMinutes(end) - toMinutes(start) > maxMinutes,
        max_minutes: maxMinutes,
        fits_availability: start.slice(-5) >= resource.opensAt && end.slice(-5) <= resource.closesAt,
        maintenance_conflict: this.maintenance.some(
          (period) => period.resourceId === resourceId && overlaps(period, start, end),
        ),
        self_conflict: active.some((reservation) => reservation.userId === userId),
        resource_conflict: active.some((reservation) => reservation.resourceId === resourceId),
      },
    ];
  }

  createClient(): DatabaseClient {
    const clientId = ++this.clientCount;
    const held: Array<() => void> = [];
    const releaseAll = () => {
      while (held.length) held.pop()!();
    };

    const run = async (query: string, values: readonly unknown[]): Promise<unknown[]> => {
      if (query.startsWith("SELECT u.user_id")) {
        const userId = this.sessions.get(values[0] as string);
        return userId === undefined
          ? []
          : [{
              user_id: userId,
              username: `user${userId}`,
              email: `user${userId}@vt.edu`,
              phone_number: null,
              role: "student",
              created_at: new Date("2026-08-24T10:00:00Z"),
              credit_balance: 20,
              credit_last_reset: new Date("2026-10-01T00:00:00Z"),
              email_notifications_on: true,
              text_notifications_on: false,
              is_banned: false,
            }];
      }

      this.log.push({ client: clientId, text: query, values });
      if (this.failOn?.(query)) throw new Error("database exploded");
      // Yield so parallel requests interleave query by query.
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (query === "BEGIN") return [];
      if (query === "COMMIT" || query === "ROLLBACK") {
        releaseAll();
        return [];
      }
      if (query === LOCK_RESOURCE) {
        const id = values[0] as number;
        if (this.locksEnabled) held.push(await this.acquire(`resource:${id}`));
        return this.resources.has(id) ? [{ resource_id: id }] : [];
      }
      if (query === LOCK_USER) {
        const id = values[0] as number;
        if (this.locksEnabled) held.push(await this.acquire(`user:${id}`));
        return [{ is_banned: this.bannedUsers.has(id) }];
      }
      if (query.startsWith("SELECT $2::timestamp >")) {
        return this.checks(values);
      }

      const byId = (id: unknown) => this.reservations.find((reservation) => reservation.id === id);

      if (query.startsWith('SELECT user_id, resource_id FROM "Reservation"')) {
        const reservation = byId(values[0]);
        return reservation ? [{ user_id: reservation.userId, resource_id: reservation.resourceId }] : [];
      }
      if (query.startsWith("SELECT status, start_time <=") || query.startsWith("SELECT user_id, status, start_time <=")) {
        const reservation = byId(values[0]);
        if (reservation && this.locksEnabled) held.push(await this.acquire(`reservation:${reservation.id}`));
        return reservation
          ? [{ user_id: reservation.userId, status: reservation.status, started: reservation.start <= NOW }]
          : [];
      }
      if (query.includes('INSERT INTO "Reservation"')) {
        const [userId, resourceId, start, end] = values as [number, number, string, string];
        return [this.row(this.addReservation({ userId, resourceId, start, end, status: "confirmed" }))];
      }
      if (query.includes('INSERT INTO "Notification"')) {
        return [{ notification_id: this.nextNotificationId++ }];
      }
      if (query.includes('UPDATE "Notification"')) {
        return [];
      }
      if (query.includes("SET start_time = $2::timestamp")) {
        const reservation = byId(values[0])!;
        reservation.start = values[1] as string;
        reservation.end = values[2] as string;
        return [this.row(reservation)];
      }
      if (query.includes("SET status = 'cancelled'")) {
        const reservation = byId(values[0])!;
        reservation.status = "cancelled";
        return [this.row(reservation)];
      }
      if (query.includes("WHERE rv.user_id = $1")) {
        return this.reservations
          .filter((reservation) => reservation.userId === values[0])
          .sort((a, b) => a.start.localeCompare(b.start))
          .map((reservation) => this.row(reservation));
      }

      throw new Error(`Unhandled fake query: ${query}`);
    };

    return {
      connect: async () => {},
      end: async () => releaseAll(),
      query: async <T = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<DatabaseQueryResult<T>> => {
        const rows = (await run(normalize(text), values)) as T[];
        return { rows, rowCount: rows.length };
      },
    };
  }

  environment() {
    return {
      APP_ENV: "dev",
      DB: { connectionString: "fake://database" },
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    };
  }
}

const MAYA = 6;
const LIAM = 7;
const cookie = (token: string) => ({ cookie: `campusconnect_session=${token}` });
const mayaHeaders = cookie("maya-token");
const liamHeaders = cookie("liam-token");

async function setup() {
  const database = new FakeReservationDatabase();
  await database.addSession("maya-token", MAYA);
  await database.addSession("liam-token", LIAM);
  const app = createApp({ createDatabaseClient: () => database.createClient() });

  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = mayaHeaders,
  ) =>
    app.request(
      `http://localhost${path}`,
      {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      },
      database.environment(),
    );

  return { app, database, request };
}

const slot = { date: "2026-10-20", start: "10:00", end: "11:00" };
// Row locks ("FOR UPDATE") are not writes.
const isWrite = (text: string) => /INSERT INTO|UPDATE "Reservation"|DELETE FROM/.test(text);

async function expectRejected(response: Response, status: number, message: RegExp) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error: string };
  expect(body.error).toMatch(message);
}

describe("reservation endpoints require a session", () => {
  it.each([
    ["POST", "/api/reservations"],
    ["GET", "/api/reservations/mine"],
    ["PATCH", "/api/reservations/1"],
    ["POST", "/api/reservations/1/cancel"],
  ])("%s %s returns 401 without a cookie", async (method, path) => {
    const { database, request } = await setup();
    const response = await request(method, path, method === "GET" ? undefined : {}, {});

    expect(response.status).toBe(401);
    expect(database.log).toEqual([]);
  });
});

describe("POST /api/reservations", () => {
  it("creates a confirmed reservation inside one locked transaction", async () => {
    const { database, request } = await setup();
    const response = await request("POST", "/api/reservations", { resourceId: 1, ...slot });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      reservation: {
        id: 100,
        resource: { id: 1, name: "Newman Group Study Room 1" },
        building: { id: 1, name: "Carol M. Newman Library" },
        startTime: "2026-10-20T10:00:00",
        endTime: "2026-10-20T11:00:00",
        status: "confirmed",
        createdAt: "2026-10-10T09:00:00",
        canModify: true,
      },
    });

    const queries = database.queries();
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toBe(LOCK_RESOURCE);
    expect(queries[2]).toBe(LOCK_USER);
    expect(queries[3]).toMatch(/^SELECT \$2::timestamp >/);
    expect(queries[4]).toMatch(/INSERT INTO "Reservation"/);
    expect(queries[4]).toMatch(/'confirmed'/);
    expect(queries[7]).toBe("COMMIT");
    expect(queries[5]).toMatch(/INSERT INTO "Notification"/);
    expect(database.log[5].values[1]).toBe("reservation_reminder");
    expect(queries[6]).toMatch(/UPDATE "Notification"/);
    expect(queries).toHaveLength(8);
    expect(database.log[3].values).toEqual([1, "2026-10-20 10:00", "2026-10-20 11:00", MAYA]);
  });

  it("never touches credits", async () => {
    const { database, request } = await setup();
    await request("POST", "/api/reservations", { resourceId: 1, ...slot });

    for (const { text } of database.log) {
      expect(text).not.toMatch(/CreditTransaction|credit_balance/);
    }
  });

  it.each([
    ["a missing body", undefined, /valid resource/],
    ["malformed JSON", "{not json", /valid resource/],
    ["a bad resource id", { resourceId: "abc", ...slot }, /valid resource/],
    ["a zero resource id", { resourceId: 0, ...slot }, /valid resource/],
    ["a missing date", { resourceId: 1, start: "10:00", end: "11:00" }, /together/],
    ["an impossible date", { resourceId: 1, ...slot, date: "2026-02-30" }, /valid YYYY-MM-DD/],
    ["a bad time", { resourceId: 1, ...slot, start: "9am" }, /HH:MM/],
    ["end before start", { resourceId: 1, ...slot, end: "09:00" }, /after the start/],
    ["end equal to start", { resourceId: 1, ...slot, end: "10:00" }, /after the start/],
    ["a slot shorter than 15 minutes", { resourceId: 1, ...slot, end: "10:10" }, /at least 15 minutes/],
  ])("returns 400 for %s without opening a transaction", async (_name, body, message) => {
    const { database, request } = await setup();
    await expectRejected(await request("POST", "/api/reservations", body ?? ""), 400, message);
    expect(database.log).toEqual([]);
  });

  it("returns 400 when the slot is longer than the resource's own limit", async () => {
    const { database, request } = await setup();
    const response = await request("POST", "/api/reservations", { resourceId: 1, ...slot, end: "12:30" });

    await expectRejected(response, 400, /at most 2 hours/);
    expect(database.queries().at(-1)).toBe("ROLLBACK");
  });

  it("uses a 4 hour limit when the resource sets none", async () => {
    const { request } = await setup();

    expect((await request("POST", "/api/reservations", { resourceId: 2, ...slot, end: "14:00" })).status).toBe(201);
    await expectRejected(
      await request("POST", "/api/reservations", { resourceId: 2, date: "2026-10-21", start: "10:00", end: "14:15" }),
      400,
      /at most 4 hours/,
    );
  });

  it("returns 404 for a resource that does not exist", async () => {
    const { database, request } = await setup();
    await expectRejected(await request("POST", "/api/reservations", { resourceId: 999, ...slot }), 404, /Resource not found/);
    expect(database.queries()).toEqual(["BEGIN", LOCK_RESOURCE, "ROLLBACK"]);
  });

  it("returns 403 for a suspended account", async () => {
    const { database, request } = await setup();
    database.bannedUsers.add(MAYA);

    await expectRejected(await request("POST", "/api/reservations", { resourceId: 1, ...slot }), 403, /suspended/);
    expect(database.queries().some(isWrite)).toBe(false);
    expect(database.reservations).toEqual([]);
  });

  describe("conflicts return 409, roll back, and write nothing", () => {
    it.each([
      ["a slot in the past", () => {}, { ...slot, date: "2026-10-14", start: "09:00", end: "10:00" }, /already passed/],
      ["a slot outside the open hours", () => {}, { ...slot, start: "06:00", end: "07:00" }, /isn't open/],
      ["a slot running past closing", () => {}, { ...slot, start: "22:30", end: "23:30" }, /isn't open/],
      [
        "a maintenance overlap",
        (db: FakeReservationDatabase) =>
          db.maintenance.push({ resourceId: 1, start: "2026-10-20 10:30", end: "2026-10-20 12:00" }),
        slot,
        /maintenance/,
      ],
      [
        "another user's reservation",
        (db: FakeReservationDatabase) =>
          db.addReservation({ userId: LIAM, resourceId: 1, start: "2026-10-20 09:30", end: "2026-10-20 10:30", status: "confirmed" }),
        slot,
        /Someone else has already reserved/,
      ],
      [
        "the user's own booking of another resource",
        (db: FakeReservationDatabase) =>
          db.addReservation({ userId: MAYA, resourceId: 2, start: "2026-10-20 10:45", end: "2026-10-20 11:30", status: "confirmed" }),
        slot,
        /You already have another reservation/,
      ],
    ])("%s", async (_name, arrange, body, message) => {
      const { database, request } = await setup();
      arrange(database);
      const before = database.reservations.length;

      await expectRejected(await request("POST", "/api/reservations", { resourceId: 1, ...body }), 409, message);

      const queries = database.queries();
      expect(queries.at(-1)).toBe("ROLLBACK");
      expect(queries.some(isWrite)).toBe(false);
      expect(database.reservations).toHaveLength(before);
    });
  });

  it("ignores cancelled reservations and allows back-to-back slots", async () => {
    const { database, request } = await setup();
    database.addReservation({ userId: LIAM, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "cancelled" });
    database.addReservation({ userId: LIAM, resourceId: 1, start: "2026-10-20 09:00", end: "2026-10-20 10:00", status: "confirmed" });
    database.addReservation({ userId: LIAM, resourceId: 1, start: "2026-10-20 11:00", end: "2026-10-20 12:00", status: "confirmed" });

    expect((await request("POST", "/api/reservations", { resourceId: 1, ...slot })).status).toBe(201);
  });

  it("returns 503 and rolls back when the database fails mid-transaction", async () => {
    const { database, request } = await setup();
    database.failOn = (query) => query.includes("INSERT INTO");

    await expectRejected(await request("POST", "/api/reservations", { resourceId: 1, ...slot }), 503, /Unable to save/);
    expect(database.queries().at(-1)).toBe("ROLLBACK");
  });
});

describe("concurrent booking", () => {
  it("lets exactly one of two simultaneous requests for the same slot succeed", async () => {
    const { database, request } = await setup();

    const responses = await Promise.all([
      request("POST", "/api/reservations", { resourceId: 1, ...slot }, mayaHeaders),
      request("POST", "/api/reservations", { resourceId: 1, ...slot }, liamHeaders),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(database.reservations).toHaveLength(1);
  });

  it("blocks one user's parallel bookings of different resources via the user lock", async () => {
    const { database, request } = await setup();

    const responses = await Promise.all([
      request("POST", "/api/reservations", { resourceId: 1, ...slot }),
      request("POST", "/api/reservations", { resourceId: 2, ...slot }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(database.reservations).toHaveLength(1);
  });

  it("would double-book without the locks (the test above is meaningful)", async () => {
    const { database, request } = await setup();
    database.locksEnabled = false;

    const responses = await Promise.all([
      request("POST", "/api/reservations", { resourceId: 1, ...slot }, mayaHeaders),
      request("POST", "/api/reservations", { resourceId: 1, ...slot }, liamHeaders),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
  });
});

describe("PATCH /api/reservations/:id", () => {
  let futureId: number;
  const newSlot = { date: "2026-10-21", start: "14:00", end: "15:30" };

  async function withReservation() {
    const context = await setup();
    futureId = context.database.addReservation({
      userId: MAYA,
      resourceId: 1,
      start: "2026-10-20 10:00",
      end: "2026-10-20 11:00",
      status: "confirmed",
    }).id;
    return context;
  }

  it("moves the reservation, taking the locks before the checks", async () => {
    const { database, request } = await withReservation();
    const response = await request("PATCH", `/api/reservations/${futureId}`, newSlot);

    expect(response.status).toBe(200);
    const { reservation } = (await response.json()) as { reservation: { startTime: string; endTime: string } };
    expect(reservation.startTime).toBe("2026-10-21T14:00:00");
    expect(reservation.endTime).toBe("2026-10-21T15:30:00");

    const queries = database.queries();
    const checksAt = queries.findIndex((text) => text.startsWith("SELECT $2::timestamp >"));
    expect(queries[0]).toBe("BEGIN");
    expect(queries.indexOf(LOCK_RESOURCE)).toBeGreaterThan(0);
    expect(queries.indexOf(LOCK_RESOURCE)).toBeLessThan(queries.indexOf(LOCK_USER));
    expect(queries.indexOf(LOCK_USER)).toBeLessThan(checksAt);
    expect(queries.findIndex((text) => text.endsWith("FOR UPDATE") && text.includes('"Reservation"'))).toBeLessThan(checksAt);
    expect(queries.findIndex(isWrite)).toBeGreaterThan(checksAt);
    expect(queries.some((text) => text.includes("email_status = 'skipped'"))).toBe(true);
    expect(database.log.some((entry) => entry.values.includes("reservation_reminder"))).toBe(true);
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("ignores the reservation being updated when checking overlaps", async () => {
    const { database, request } = await withReservation();
    const response = await request("PATCH", `/api/reservations/${futureId}`, { ...slot, end: "11:30" });

    expect(response.status).toBe(200);
    const checks = database.log.find((entry) => entry.text.startsWith("SELECT $2::timestamp >"))!;
    expect(checks.values[4]).toBe(futureId);
    expect(checks.text).toMatch(/rv\.reservation_id <> \$5::integer/);
    expect(checks.text).toMatch(/mine\.reservation_id <> \$5::integer/);
  });

  it("returns 409 when the new slot collides with someone else", async () => {
    const { database, request } = await withReservation();
    database.addReservation({ userId: LIAM, resourceId: 1, start: "2026-10-21 15:00", end: "2026-10-21 16:00", status: "confirmed" });

    await expectRejected(await request("PATCH", `/api/reservations/${futureId}`, newSlot), 409, /Someone else/);
    expect(database.reservations.find((reservation) => reservation.id === futureId)!.start).toBe("2026-10-20 10:00");
    expect(database.queries().at(-1)).toBe("ROLLBACK");
  });

  it("returns 409 for maintenance, closed hours, and the past", async () => {
    const { database, request } = await withReservation();
    database.maintenance.push({ resourceId: 1, start: "2026-10-21 15:00", end: "2026-10-21 17:00" });

    await expectRejected(await request("PATCH", `/api/reservations/${futureId}`, newSlot), 409, /maintenance/);
    await expectRejected(
      await request("PATCH", `/api/reservations/${futureId}`, { ...newSlot, start: "23:00", end: "23:30" }),
      409,
      /isn't open/,
    );
    await expectRejected(
      await request("PATCH", `/api/reservations/${futureId}`, { date: "2026-10-13", start: "10:00", end: "11:00" }),
      409,
      /already passed/,
    );
  });

  it("returns 403 for someone else's reservation before locking anything", async () => {
    const { database, request } = await withReservation();

    await expectRejected(await request("PATCH", `/api/reservations/${futureId}`, newSlot, liamHeaders), 403, /someone else/);
    expect(database.queries()).not.toContain(LOCK_RESOURCE);
    expect(database.queries().some(isWrite)).toBe(false);
  });

  it("returns 404 for a missing reservation", async () => {
    const { request } = await setup();
    await expectRejected(await request("PATCH", "/api/reservations/555", newSlot), 404, /Reservation not found/);
  });

  it.each([
    ["cancelled", "2026-10-20 10:00", /has been cancelled/],
    ["completed", "2026-10-20 10:00", /already over/],
    ["no_show", "2026-10-20 10:00", /already over/],
    ["confirmed", "2026-10-14 11:30", /already started/],
  ])("returns 409 for a %s reservation starting %s", async (status, start, message) => {
    const { database, request } = await setup();
    const { id } = database.addReservation({ userId: MAYA, resourceId: 1, start, end: "2026-10-20 13:00", status });

    await expectRejected(await request("PATCH", `/api/reservations/${id}`, newSlot), 409, message);
    expect(database.queries().some(isWrite)).toBe(false);
  });

  it.each([
    ["a non-numeric id", "/api/reservations/abc", newSlot, /positive whole number/],
    ["a missing body", "/api/reservations/1", undefined, /Choose a date/],
    ["end before start", "/api/reservations/1", { ...newSlot, end: "13:00" }, /after the start/],
  ])("returns 400 for %s", async (_name, path, body, message) => {
    const { database, request } = await setup();
    await expectRejected(await request("PATCH", path, body ?? ""), 400, message);
    expect(database.log).toEqual([]);
  });

  it("returns 403 when the account is suspended", async () => {
    const { database, request } = await withReservation();
    database.bannedUsers.add(MAYA);

    await expectRejected(await request("PATCH", `/api/reservations/${futureId}`, newSlot), 403, /suspended/);
  });
});

describe("POST /api/reservations/:id/cancel", () => {
  it("sets the status to cancelled without deleting the row", async () => {
    const { database, request } = await setup();
    const { id } = database.addReservation({ userId: MAYA, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed" });

    const response = await request("POST", `/api/reservations/${id}/cancel`);

    expect(response.status).toBe(200);
    const { reservation } = (await response.json()) as { reservation: { status: string; canModify: boolean } };
    expect(reservation).toMatchObject({ status: "cancelled", canModify: false });
    expect(database.reservations).toHaveLength(1);

    const queries = database.queries();
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toMatch(/FROM "Reservation" WHERE reservation_id = \$1 FOR UPDATE$/);
    expect(queries[2]).toMatch(/SET status = 'cancelled'/);
    expect(queries.some((text) => text.includes("email_status = 'skipped'"))).toBe(true);
    expect(database.log.some((entry) => entry.values.includes("reservation_cancelled"))).toBe(true);
    expect(queries.join(" ")).not.toMatch(/DELETE/);
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("frees the slot for someone else", async () => {
    const { database, request } = await setup();
    const { id } = database.addReservation({ userId: MAYA, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed" });

    await request("POST", `/api/reservations/${id}/cancel`);
    expect((await request("POST", "/api/reservations", { resourceId: 1, ...slot }, liamHeaders)).status).toBe(201);
  });

  it("returns 403 for someone else's reservation", async () => {
    const { database, request } = await setup();
    const { id } = database.addReservation({ userId: LIAM, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed" });

    await expectRejected(await request("POST", `/api/reservations/${id}/cancel`), 403, /someone else/);
    expect(database.reservations[0].status).toBe("confirmed");
    expect(database.queries().at(-1)).toBe("ROLLBACK");
  });

  it("returns 404 for a missing reservation and 400 for a bad id", async () => {
    const { request } = await setup();
    await expectRejected(await request("POST", "/api/reservations/555/cancel"), 404, /not found/);
    await expectRejected(await request("POST", "/api/reservations/0/cancel"), 400, /positive whole number/);
  });

  it.each([
    ["cancelled", "2026-10-20 10:00", /has been cancelled/],
    ["completed", "2026-10-01 10:00", /already over/],
    ["confirmed", "2026-10-14 11:00", /already started/],
  ])("returns 409 for a %s reservation starting %s", async (status, start, message) => {
    const { database, request } = await setup();
    const { id } = database.addReservation({ userId: MAYA, resourceId: 1, start, end: "2026-10-20 13:00", status });

    await expectRejected(await request("POST", `/api/reservations/${id}/cancel`), 409, message);
    expect(database.reservations[0].status).toBe(status);
  });
});

describe("GET /api/reservations/mine", () => {
  it("splits the user's reservations into upcoming and past", async () => {
    const { database, request } = await setup();
    database.addReservation({ id: 1, userId: MAYA, resourceId: 1, start: "2026-09-03 18:00", end: "2026-09-03 20:00", status: "completed" });
    database.addReservation({ id: 2, userId: MAYA, resourceId: 1, start: "2026-10-01 18:00", end: "2026-10-01 19:00", status: "no_show" });
    database.addReservation({ id: 3, userId: MAYA, resourceId: 2, start: "2026-10-22 09:00", end: "2026-10-22 10:00", status: "confirmed" });
    database.addReservation({ id: 4, userId: MAYA, resourceId: 1, start: "2026-10-20 09:00", end: "2026-10-20 10:00", status: "cancelled" });
    database.addReservation({ id: 5, userId: MAYA, resourceId: 1, start: "2026-10-14 11:00", end: "2026-10-14 13:00", status: "confirmed" });
    database.addReservation({ id: 6, userId: LIAM, resourceId: 1, start: "2026-10-21 09:00", end: "2026-10-21 10:00", status: "confirmed" });

    const response = await request("GET", "/api/reservations/mine");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      upcoming: Array<{ id: number; canModify: boolean; status: string }>;
      past: Array<{ id: number }>;
    };

    expect(body.upcoming.map((reservation) => reservation.id)).toEqual([5, 4, 3]);
    expect(body.past.map((reservation) => reservation.id)).toEqual([2, 1]);
    // In progress, cancelled, and future-confirmed respectively.
    expect(body.upcoming.map((reservation) => reservation.canModify)).toEqual([false, false, true]);
    expect(body.upcoming[2]).toEqual({
      id: 3,
      resource: { id: 2, name: "Squires Meeting Room B" },
      building: { id: 1, name: "Carol M. Newman Library" },
      startTime: "2026-10-22T09:00:00",
      endTime: "2026-10-22T10:00:00",
      status: "confirmed",
      createdAt: "2026-10-10T09:00:00",
      canModify: true,
    });
    expect(database.log[0].values).toEqual([MAYA]);
  });

  it("returns 503 when the database fails", async () => {
    const { database, request } = await setup();
    database.failOn = () => true;
    await expectRejected(await request("GET", "/api/reservations/mine"), 503, /Unable to load/);
  });
});
