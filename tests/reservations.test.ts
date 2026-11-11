import { describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "../backend/auth";
import type { DatabaseClient, DatabaseQueryResult } from "../db/client";
import { createApp } from "../backend/index";
import { LOCK_RESOURCE_SQL, LOCK_USER_SQL } from "../db/repositories/reservations";
import {
  CHARGE_RESERVATION_SQL,
  FIND_RESERVATION_CHARGE_SQL,
  PAIRING_STAMP_TAKEN_SQL,
  REFUND_CREDITS_SQL,
} from "../db/repositories/credits";

// Times are local campus "YYYY-MM-DD HH:MM" strings, which compare correctly as text.
const NOW = "2026-10-14 12:00";

type FakeReservation = {
  id: number;
  userId: number;
  resourceId: number;
  start: string;
  end: string;
  status: string;
  // Stands in for the microsecond created_at timestamp used to pair charges.
  createdAt: string;
};

type FakeCreditTransaction = {
  id: number;
  userId: number;
  amount: number;
  type: string;
  createdAt: string;
};

type FakeResource = {
  name: string;
  maxMinutes: number | null;
  requiredCredits: number;
  // Daily availability window.
  opensAt: string;
  closesAt: string;
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const LOCK_RESOURCE = normalize(LOCK_RESOURCE_SQL);
const LOCK_USER = normalize(LOCK_USER_SQL);
const STAMP_TAKEN = normalize(PAIRING_STAMP_TAKEN_SQL);
const CHARGE = normalize(CHARGE_RESERVATION_SQL);
const FIND_CHARGE = normalize(FIND_RESERVATION_CHARGE_SQL);
const REFUND = normalize(REFUND_CREDITS_SQL);
const HOUR_MS = 60 * 60 * 1000;
const epoch = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}:00Z`);

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
    [1, { name: "Newman Group Study Room 1", maxMinutes: 120, requiredCredits: 2, opensAt: "08:00", closesAt: "23:00" }],
    [2, { name: "Squires Meeting Room B", maxMinutes: null, requiredCredits: 3, opensAt: "08:00", closesAt: "23:00" }],
  ]);
  balances = new Map<number, number>([[6, 20], [7, 20]]);
  credits: FakeCreditTransaction[] = [];
  nextTransactionId = 500;
  // Every transaction gets its own "CURRENT_TIMESTAMP" unless this forces one.
  fixedStamp: string | null = null;
  // Makes the user lock report a different balance than the one the charge sees.
  lockReportsBalance: number | null = null;
  private stampCount = 0;
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

  addReservation(reservation: Omit<FakeReservation, "id" | "createdAt"> & { id?: number; createdAt?: string }) {
    const id = reservation.id ?? this.nextId++;
    const row = { ...reservation, id, createdAt: reservation.createdAt ?? `legacy-${id}` };
    this.reservations.push(row);
    return row;
  }

  // Records the charge a booking would have written (balance already reflects it).
  addCharge(reservation: FakeReservation, credits: number) {
    this.credits.push({
      id: this.nextTransactionId++,
      userId: reservation.userId,
      amount: -credits,
      type: "reservation_charge",
      createdAt: reservation.createdAt,
    });
  }

  creditsOf(userId: number, type?: string) {
    return this.credits.filter((row) => row.userId === userId && (!type || row.type === type));
  }

  private pairedCharge(reservation: FakeReservation) {
    const charges = this.credits.filter(
      (row) => row.userId === reservation.userId && row.type === "reservation_charge" && row.createdAt === reservation.createdAt,
    );
    const twins = this.reservations.filter(
      (row) => row.userId === reservation.userId && row.createdAt === reservation.createdAt,
    );
    return {
      charge_count: charges.length,
      charge_credits: charges.length ? -Math.min(...charges.map((row) => row.amount)) : null,
      reservation_count: twins.length,
      paired: charges.length === 1 && twins.length === 1 && charges[0].amount < 0 ? -charges[0].amount : null,
    };
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

  private row(reservation: FakeReservation, options: { seeCharge?: boolean } = {}) {
    const resource = this.resources.get(reservation.resourceId)!;
    return {
      refund_window_open: epoch(reservation.start) - epoch(NOW) >= 24 * HOUR_MS,
      credits_charged: options.seeCharge === false ? null : this.pairedCharge(reservation).paired,
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
    // Undo log for the open transaction, replayed in reverse on ROLLBACK.
    let undo: Array<() => void> = [];
    let stamp = "";
    const setBalance = (userId: number, value: number) => {
      const previous = this.balances.get(userId)!;
      undo.push(() => this.balances.set(userId, previous));
      this.balances.set(userId, value);
    };
    const pushCredit = (row: Omit<FakeCreditTransaction, "id">) => {
      const entry = { id: this.nextTransactionId++, ...row };
      this.credits.push(entry);
      undo.push(() => this.credits.splice(this.credits.indexOf(entry), 1));
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
              role: "student",
              created_at: new Date("2026-08-24T10:00:00Z"),
              credit_balance: 20,
              credit_last_reset: new Date("2026-10-01T00:00:00Z"),
              email_notifications_on: true,
              is_banned: false,
            }];
      }

      this.log.push({ client: clientId, text: query, values });
      if (this.failOn?.(query)) throw new Error("database exploded");
      // Yield so parallel requests interleave query by query.
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (query === "BEGIN") {
        undo = [];
        stamp = this.fixedStamp ?? `stamp-${++this.stampCount}`;
        return [];
      }
      if (query === "COMMIT" || query === "ROLLBACK") {
        if (query === "ROLLBACK") while (undo.length) undo.pop()!();
        undo = [];
        releaseAll();
        return [];
      }
      if (query === LOCK_RESOURCE) {
        const id = values[0] as number;
        if (this.locksEnabled) held.push(await this.acquire(`resource:${id}`));
        const resource = this.resources.get(id);
        return resource ? [{ resource_id: id, required_credits: resource.requiredCredits }] : [];
      }
      if (query === LOCK_USER) {
        const id = values[0] as number;
        if (this.locksEnabled) held.push(await this.acquire(`user:${id}`));
        return [{ is_banned: this.bannedUsers.has(id), credit_balance: this.lockReportsBalance ?? this.balances.get(id) }];
      }
      if (query === STAMP_TAKEN) {
        const userId = values[0] as number;
        const taken =
          this.reservations.some((row) => row.userId === userId && row.createdAt === stamp) ||
          this.credits.some((row) => row.userId === userId && row.type === "reservation_charge" && row.createdAt === stamp);
        return [{ taken }];
      }
      if (query === CHARGE) {
        const [userId, credits, reservationId] = values as [number, number, number];
        const balance = this.balances.get(userId)!;
        // The guarded UPDATE is evaluated against the current balance.
        if (balance < credits) return [];
        setBalance(userId, balance - credits);
        const reservation = this.reservations.find((row) => row.id === reservationId && row.userId === userId);
        if (!reservation) return [];
        pushCredit({ userId, amount: -credits, type: "reservation_charge", createdAt: reservation.createdAt });
        return [{ balance_after: balance - credits }];
      }
      if (query === FIND_CHARGE) {
        const reservation = this.reservations.find((row) => row.id === values[0]);
        if (!reservation) return [];
        const { paired: _paired, ...match } = this.pairedCharge(reservation);
        return [match];
      }
      if (query === REFUND) {
        const [userId, credits] = values as [number, number];
        const balance = this.balances.get(userId)! + credits;
        setBalance(userId, balance);
        pushCredit({ userId, amount: credits, type: "refund", createdAt: stamp });
        return [{ balance_after: balance }];
      }
      if (query.startsWith("SELECT $2::timestamp >")) {
        return this.checks(values);
      }

      const byId = (id: unknown) => this.reservations.find((reservation) => reservation.id === id);

      if (query.startsWith('SELECT user_id, resource_id FROM "Reservation"')) {
        const reservation = byId(values[0]);
        return reservation ? [{ user_id: reservation.userId, resource_id: reservation.resourceId }] : [];
      }
      if (query.startsWith("SELECT status, start_time <=")) {
        const reservation = byId(values[0]);
        if (reservation && this.locksEnabled) held.push(await this.acquire(`reservation:${reservation.id}`));
        return reservation
          ? [{
              status: reservation.status,
              started: reservation.start <= NOW,
              refund_window_open: epoch(reservation.start) - epoch(NOW) >= 24 * HOUR_MS,
            }]
          : [];
      }
      if (query.includes('INSERT INTO "Reservation"')) {
        const [userId, resourceId, start, end] = values as [number, number, string, string];
        const reservation = this.addReservation({ userId, resourceId, start, end, status: "confirmed", createdAt: stamp });
        undo.push(() => this.reservations.splice(this.reservations.indexOf(reservation), 1));
        // The INSERT's own select cannot see a charge written by a later statement.
        return [this.row(reservation, { seeCharge: false })];
      }
      if (query.includes('INSERT INTO "Notification"')) {
        return [{ notification_id: this.nextNotificationId++ }];
      }
      if (query.includes('UPDATE "Notification"')) {
        return [];
      }
      if (query.includes("SET start_time = $2::timestamp")) {
        const reservation = byId(values[0])!;
        const previous = { start: reservation.start, end: reservation.end };
        undo.push(() => Object.assign(reservation, previous));
        reservation.start = values[1] as string;
        reservation.end = values[2] as string;
        return [this.row(reservation)];
      }
      if (query.includes("SET status = 'cancelled'")) {
        const reservation = byId(values[0])!;
        if (reservation.status !== "confirmed") return [];
        undo.push(() => (reservation.status = "confirmed"));
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
        creditsCharged: 2,
        refundEligible: true,
      },
      credits: { charged: 2, refunded: 0, balance: 18 },
    });

    const queries = database.queries();
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toBe(LOCK_RESOURCE);
    expect(queries[2]).toBe(LOCK_USER);
    expect(queries[3]).toMatch(/^SELECT \$2::timestamp >/);
    expect(queries[4]).toBe(STAMP_TAKEN);
    expect(queries[5]).toMatch(/INSERT INTO "Reservation"/);
    expect(queries[5]).toMatch(/'confirmed'/);
    expect(queries[6]).toBe(CHARGE);
    expect(queries[7]).toMatch(/INSERT INTO "Notification"/);
    expect(database.log[7].values[1]).toBe("reservation_reminder");
    expect(queries[8]).toMatch(/UPDATE "Notification"/);
    expect(queries[9]).toBe("COMMIT");
    expect(queries).toHaveLength(10);
    expect(database.log[3].values).toEqual([1, "2026-10-20 10:00", "2026-10-20 11:00", MAYA]);
    expect(database.log[6].values).toEqual([MAYA, 2, 100]);
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
    const lockAt = queries.findIndex((text) => /FROM "Reservation" WHERE reservation_id = \$1 FOR UPDATE$/.test(text));
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toMatch(/^SELECT user_id, resource_id FROM "Reservation"/);
    expect(queries[2]).toBe(LOCK_RESOURCE);
    expect(queries[3]).toBe(LOCK_USER);
    expect(lockAt).toBe(4);
    expect(queries[5]).toMatch(/SET status = 'cancelled' WHERE reservation_id = \$1 AND status = 'confirmed'/);
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
      creditsCharged: null,
      refundEligible: false,
    });
    expect(database.log[0].values).toEqual([MAYA]);
  });

  it("returns 503 when the database fails", async () => {
    const { database, request } = await setup();
    database.failOn = () => true;
    await expectRejected(await request("GET", "/api/reservations/mine"), 503, /Unable to load/);
  });
});

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

type CreditBody = {
  reservation: { id: number; status: string; creditsCharged: number | null; refundEligible: boolean };
  credits: { charged: number; refunded: number; balance: number; refundStatus?: string };
};

const otherSlot = { date: "2026-10-21", start: "10:00", end: "11:00" };
const isCreditWrite = (text: string) => text === CHARGE || text === REFUND;
const cancellationMessage = (database: FakeReservationDatabase) =>
  database.log.find((entry) => entry.values.includes("reservation_cancelled"))?.values[2] as string | undefined;

describe("booking charges", () => {
  it("deducts the resource's credits once and pairs the charge with the reservation", async () => {
    const { database, request } = await setup();
    const response = await request("POST", "/api/reservations", { resourceId: 2, ...slot });

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreditBody;
    expect(body.credits).toEqual({ charged: 3, refunded: 0, balance: 17 });
    expect(body.reservation.creditsCharged).toBe(3);
    expect(database.balances.get(MAYA)).toBe(17);

    const charges = database.creditsOf(MAYA);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amount: -3, type: "reservation_charge" });
    // Same transaction timestamp as the reservation: this is the pairing key.
    expect(charges[0].createdAt).toBe(database.reservations[0].createdAt);
  });

  it("allows a booking that uses the exact remaining balance", async () => {
    const { database, request } = await setup();
    database.balances.set(MAYA, 2);

    expect((await request("POST", "/api/reservations", { resourceId: 1, ...slot })).status).toBe(201);
    expect(database.balances.get(MAYA)).toBe(0);
  });

  it("returns 409 for insufficient credits, rolls back, and writes nothing", async () => {
    const { database, request } = await setup();
    database.balances.set(MAYA, 1);

    await expectRejected(
      await request("POST", "/api/reservations", { resourceId: 1, ...slot }),
      409,
      /costs 2 credits, but you have 1 credit\./,
    );
    expect(database.queries().at(-1)).toBe("ROLLBACK");
    expect(database.queries().some(isWrite)).toBe(false);
    expect(database.reservations).toEqual([]);
    expect(database.credits).toEqual([]);
    expect(database.balances.get(MAYA)).toBe(1);
  });

  it("reports a slot problem before a credit problem", async () => {
    const { database, request } = await setup();
    database.balances.set(MAYA, 0);

    await expectRejected(
      await request("POST", "/api/reservations", { resourceId: 1, ...slot, start: "06:00", end: "07:00" }),
      409,
      /isn't open/,
    );
  });

  it.each([
    ["the charge", (query: string) => query === CHARGE],
    ["the reminder notification after the charge", (query: string) => query.includes('INSERT INTO "Notification"')],
  ])("rolls back the reservation and the charge when %s fails", async (_name, failOn) => {
    const { database, request } = await setup();
    database.failOn = failOn;

    await expectRejected(await request("POST", "/api/reservations", { resourceId: 1, ...slot }), 503, /Unable to save/);
    expect(database.queries().at(-1)).toBe("ROLLBACK");
    expect(database.reservations).toEqual([]);
    expect(database.credits).toEqual([]);
    expect(database.balances.get(MAYA)).toBe(20);
  });

  it("rolls back when the guarded charge writes nothing", async () => {
    const { database, request } = await setup();
    // The balance check passes, but the guarded UPDATE sees too few credits.
    database.balances.set(MAYA, 1);
    database.lockReportsBalance = 20;

    expect((await request("POST", "/api/reservations", { resourceId: 1, ...slot })).status).toBe(503);
    expect(database.queries().at(-1)).toBe("ROLLBACK");
    expect(database.reservations).toEqual([]);
    expect(database.credits).toEqual([]);
    expect(database.balances.get(MAYA)).toBe(1);
  });

  it("refuses a second booking that would reuse the same pairing timestamp", async () => {
    const { database, request } = await setup();
    database.fixedStamp = "same-microsecond";

    expect((await request("POST", "/api/reservations", { resourceId: 1, ...slot })).status).toBe(201);
    await expectRejected(
      await request("POST", "/api/reservations", { resourceId: 1, ...otherSlot }),
      409,
      /at the same moment/,
    );
    expect(database.reservations).toHaveLength(1);
    expect(database.creditsOf(MAYA)).toHaveLength(1);
    expect(database.balances.get(MAYA)).toBe(18);
  });

  it("does not move credits when a reservation is rescheduled", async () => {
    const { database, request } = await setup();
    await request("POST", "/api/reservations", { resourceId: 1, ...slot });
    database.log = [];

    const response = await request("PATCH", `/api/reservations/${database.reservations[0].id}`, otherSlot);
    expect(response.status).toBe(200);
    const body = (await response.json()) as CreditBody;
    expect(body.credits).toBeUndefined();
    expect(body.reservation.creditsCharged).toBe(2);
    expect(database.log.some((entry) => isCreditWrite(entry.text))).toBe(false);
    expect(database.balances.get(MAYA)).toBe(18);
    expect(database.credits).toHaveLength(1);
  });

  it("charges the resource owner and administrators like everyone else", async () => {
    // The booking path has no owner or role exemption: every user is charged.
    const { database, request } = await setup();
    await request("POST", "/api/reservations", { resourceId: 1, ...slot }, liamHeaders);
    expect(database.balances.get(LIAM)).toBe(18);
  });
});

describe("concurrent credit spending", () => {
  it("lets only one of two parallel bookings spend the last credits", async () => {
    const { database, request } = await setup();
    database.balances.set(MAYA, 2);

    const responses = await Promise.all([
      request("POST", "/api/reservations", { resourceId: 1, ...slot }),
      request("POST", "/api/reservations", { resourceId: 1, ...otherSlot }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(database.balances.get(MAYA)).toBe(0);
    expect(database.reservations).toHaveLength(1);
    expect(database.creditsOf(MAYA, "reservation_charge")).toHaveLength(1);
  });

  it("spends credits correctly across five parallel bookings of different resources", async () => {
    const { database, request } = await setup();
    database.balances.set(MAYA, 7);
    const slots = ["10:00", "11:00", "12:00", "13:00", "14:00"].map((start, index) => ({
      resourceId: index % 2 ? 2 : 1,
      date: `2026-10-2${index}`,
      start,
      end: `${Number(start.slice(0, 2)) + 1}:00`,
    }));

    const responses = await Promise.all(slots.map((body) => request("POST", "/api/reservations", body)));
    const created = responses.filter((response) => response.status === 201).length;

    const spent = database.creditsOf(MAYA, "reservation_charge").reduce((sum, row) => sum - row.amount, 0);
    expect(created).toBeGreaterThanOrEqual(2);
    expect(created).toBe(database.reservations.length);
    expect(database.balances.get(MAYA)).toBe(7 - spent);
    expect(database.balances.get(MAYA)).toBeGreaterThanOrEqual(0);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(5 - created);
  });

  it("still never overspends without the row locks, because the charge is guarded", async () => {
    const { database, request } = await setup();
    database.balances.set(MAYA, 2);
    database.locksEnabled = false;

    const responses = await Promise.all([
      request("POST", "/api/reservations", { resourceId: 1, ...slot }),
      request("POST", "/api/reservations", { resourceId: 1, ...otherSlot }),
    ]);

    // Both passed the unlocked balance check; the guarded UPDATE stopped one.
    expect(responses.map((response) => response.status).sort()).toEqual([201, 503]);
    expect(database.balances.get(MAYA)).toBe(0);
    expect(database.reservations).toHaveLength(1);
  });
});

describe("cancellation refunds", () => {
  async function chargedReservation(start: string, credits = 2) {
    const context = await setup();
    const reservation = context.database.addReservation({
      userId: MAYA,
      resourceId: 1,
      start,
      end: `${start.slice(0, 11)}${String(Number(start.slice(11, 13)) + 1).padStart(2, "0")}:00`,
      status: "confirmed",
    });
    context.database.addCharge(reservation, credits);
    context.database.balances.set(MAYA, 20 - credits);
    return { ...context, reservation };
  }

  it("refunds the full charge when cancelled more than 24 hours ahead", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00");
    const response = await request("POST", `/api/reservations/${reservation.id}/cancel`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as CreditBody;
    expect(body.credits).toEqual({ charged: 0, refunded: 2, balance: 20, refundStatus: "refunded" });
    expect(database.balances.get(MAYA)).toBe(20);
    expect(database.creditsOf(MAYA, "refund")).toEqual([
      expect.objectContaining({ amount: 2, type: "refund" }),
    ]);
    expect(cancellationMessage(database)).toMatch(/2 credits refunded\.$/);
  });

  it("refunds a cancellation exactly 24 hours before the start", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-15 12:00");
    const body = (await (await request("POST", `/api/reservations/${reservation.id}/cancel`)).json()) as CreditBody;

    expect(body.credits.refundStatus).toBe("refunded");
    expect(database.balances.get(MAYA)).toBe(20);
  });

  it("does not refund a cancellation less than 24 hours before the start", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-15 11:45");
    const response = await request("POST", `/api/reservations/${reservation.id}/cancel`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as CreditBody;
    expect(body.reservation.status).toBe("cancelled");
    expect(body.credits).toEqual({ charged: 0, refunded: 0, balance: 18, refundStatus: "late" });
    expect(database.creditsOf(MAYA, "refund")).toEqual([]);
    expect(database.queries()).not.toContain(FIND_CHARGE);
    expect(cancellationMessage(database)).toMatch(/less than 24 hours before the start time are not refunded/);
  });

  it("refunds what was paid even if the owner changed the price afterwards", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00", 2);
    database.resources.get(1)!.requiredCredits = 9;

    await request("POST", `/api/reservations/${reservation.id}/cancel`);
    expect(database.creditsOf(MAYA, "refund")[0].amount).toBe(2);
  });

  it("does not refund a legacy reservation that was never charged", async () => {
    const { database, request } = await setup();
    const { id } = database.addReservation({ userId: MAYA, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed" });

    const body = (await (await request("POST", `/api/reservations/${id}/cancel`)).json()) as CreditBody;
    expect(body.reservation.status).toBe("cancelled");
    expect(body.credits).toEqual({ charged: 0, refunded: 0, balance: 20, refundStatus: "not_charged" });
    expect(database.credits).toEqual([]);
    expect(database.queries()).not.toContain(REFUND);
    expect(cancellationMessage(database)).toMatch(/No credits were charged for this booking/);
  });

  it("does not guess when two reservations share the charge's timestamp", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { database, request } = await setup();
    const first = database.addReservation({ userId: MAYA, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed", createdAt: "shared" });
    database.addReservation({ userId: MAYA, resourceId: 2, start: "2026-10-22 10:00", end: "2026-10-22 11:00", status: "confirmed", createdAt: "shared" });
    database.addCharge(first, 2);

    const body = (await (await request("POST", `/api/reservations/${first.id}/cancel`)).json()) as CreditBody;
    expect(body.credits.refundStatus).toBe("unverified");
    expect(database.creditsOf(MAYA, "refund")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refund skipped for reservation/));
    expect(cancellationMessage(database)).toMatch(/could not be verified automatically/);
    warn.mockRestore();
  });

  it("does not guess when two charges share the reservation's timestamp", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00");
    database.addCharge(reservation, 2);

    const body = (await (await request("POST", `/api/reservations/${reservation.id}/cancel`)).json()) as CreditBody;
    expect(body.credits.refundStatus).toBe("unverified");
    expect(database.creditsOf(MAYA, "refund")).toEqual([]);
    warn.mockRestore();
  });

  it("never matches another user's charge", async () => {
    const { database, request } = await setup();
    const mine = database.addReservation({ userId: MAYA, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed", createdAt: "t1" });
    const theirs = database.addReservation({ userId: LIAM, resourceId: 2, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed", createdAt: "t1" });
    database.addCharge(theirs, 3);

    const body = (await (await request("POST", `/api/reservations/${mine.id}/cancel`)).json()) as CreditBody;
    expect(body.credits.refundStatus).toBe("not_charged");
    expect(database.balances.get(MAYA)).toBe(20);
  });

  it("refunds once when the same reservation is cancelled twice", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00");

    expect((await request("POST", `/api/reservations/${reservation.id}/cancel`)).status).toBe(200);
    await expectRejected(await request("POST", `/api/reservations/${reservation.id}/cancel`), 409, /has been cancelled/);
    expect(database.creditsOf(MAYA, "refund")).toHaveLength(1);
    expect(database.balances.get(MAYA)).toBe(20);
  });

  it("refunds once when two cancel requests race", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00");

    const responses = await Promise.all([
      request("POST", `/api/reservations/${reservation.id}/cancel`),
      request("POST", `/api/reservations/${reservation.id}/cancel`),
      request("POST", `/api/reservations/${reservation.id}/cancel`),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    expect(database.creditsOf(MAYA, "refund")).toHaveLength(1);
    expect(database.balances.get(MAYA)).toBe(20);
  });

  it("rolls back the cancellation and the refund together", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00");
    database.failOn = (query) => query.includes('INSERT INTO "Notification"');

    expect((await request("POST", `/api/reservations/${reservation.id}/cancel`)).status).toBe(503);
    expect(reservation.status).toBe("confirmed");
    expect(database.creditsOf(MAYA, "refund")).toEqual([]);
    expect(database.balances.get(MAYA)).toBe(18);
  });

  it("takes the resource, user, then reservation locks before cancelling", async () => {
    const { database, request, reservation } = await chargedReservation("2026-10-20 10:00");
    await request("POST", `/api/reservations/${reservation.id}/cancel`);

    const queries = database.queries();
    const reservationLock = queries.findIndex((text) => text.startsWith("SELECT status, start_time <="));
    expect(queries.indexOf(LOCK_RESOURCE)).toBeLessThan(queries.indexOf(LOCK_USER));
    expect(queries.indexOf(LOCK_USER)).toBeLessThan(reservationLock);
    expect(reservationLock).toBeLessThan(queries.indexOf(REFUND));
  });

  it("books, cancels, and rebooks with a consistent balance and history", async () => {
    const { database, request } = await setup();
    await request("POST", "/api/reservations", { resourceId: 2, ...slot });
    await request("POST", `/api/reservations/${database.reservations[0].id}/cancel`);
    await request("POST", "/api/reservations", { resourceId: 2, ...slot });

    const history = database.creditsOf(MAYA).map((row) => [row.type, row.amount]);
    expect(history).toEqual([["reservation_charge", -3], ["refund", 3], ["reservation_charge", -3]]);
    expect(database.balances.get(MAYA)).toBe(20 + history.reduce((sum, [, amount]) => sum + (amount as number), 0));
  });
});

describe("reservation list credit fields", () => {
  it("reports the paid credits and whether cancelling now would be refunded", async () => {
    const { database, request } = await setup();
    const charged = database.addReservation({ id: 1, userId: MAYA, resourceId: 1, start: "2026-10-20 10:00", end: "2026-10-20 11:00", status: "confirmed" });
    const late = database.addReservation({ id: 2, userId: MAYA, resourceId: 2, start: "2026-10-15 09:00", end: "2026-10-15 10:00", status: "confirmed" });
    database.addReservation({ id: 3, userId: MAYA, resourceId: 1, start: "2026-10-22 10:00", end: "2026-10-22 11:00", status: "confirmed" });
    database.addCharge(charged, 2);
    database.addCharge(late, 3);

    const body = (await (await request("GET", "/api/reservations/mine")).json()) as {
      upcoming: Array<{ id: number; creditsCharged: number | null; refundEligible: boolean }>;
    };
    expect(body.upcoming.map(({ id, creditsCharged, refundEligible }) => ({ id, creditsCharged, refundEligible }))).toEqual([
      { id: 2, creditsCharged: 3, refundEligible: false },
      { id: 1, creditsCharged: 2, refundEligible: true },
      { id: 3, creditsCharged: null, refundEligible: false },
    ]);
  });
});
