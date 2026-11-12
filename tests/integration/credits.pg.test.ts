// Real-PostgreSQL tests for credit charging, refunds, and their concurrency.
//
// Skipped unless CREDITS_PG_TEST_URL is set. They write data, so they refuse to
// run unless the database name starts with "campusconnect_credits_test": point
// them only at a throwaway database loaded with db/migrations/001_schema.sql and
// 002_seed.sql, never at the shared dev or production databases.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../db/client";
import {
  applyMonthlyCreditResets,
  findReservationCharge,
  getCreditSummary,
  listCreditTransactions,
} from "../../db/repositories/credits";
import { cancelAffectedReservations } from "../../db/repositories/listings";
import { cancelReservation, createReservation } from "../../db/repositories/reservations";

const url = process.env.CREDITS_PG_TEST_URL;
const REQUIRED_DATABASE_PREFIX = "campusconnect_credits_test";

const clients: Client[] = [];
async function connect(): Promise<DatabaseClient> {
  const client = new Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  return client as unknown as DatabaseClient;
}

let admin: DatabaseClient;
let resourceId: number;
let cheapResourceId: number;
let dayCounter = 0;

// A fresh, non-overlapping one-hour slot on a future day for every booking.
function nextSlot() {
  dayCounter += 1;
  const date = new Date(Date.UTC(2027, 0, 1 + dayCounter)).toISOString().slice(0, 10);
  return { start: `${date} 10:00`, end: `${date} 11:00` };
}

async function createUser(balance: number): Promise<number> {
  const name = `credit_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const result = await admin.query<{ user_id: number }>(
    `
      INSERT INTO "User" (username, email, password_hash, role, credit_balance, credit_last_reset,
        is_banned, can_add_resources, email_notifications_on, email_verified_at)
      VALUES ($1, $2, NULL, 'student', $3, CURRENT_DATE, FALSE, TRUE, FALSE, CURRENT_TIMESTAMP)
      RETURNING user_id
    `,
    [name, `${name}@example.com`, balance],
  );
  const userId = result.rows[0].user_id;
  await admin.query(
    `INSERT INTO "CreditTransaction" (user_id, amount, transaction_type) VALUES ($1, $2, 'initial_grant')`,
    [userId, balance],
  );
  return userId;
}

async function insertResource(credits: number): Promise<number> {
  const owner = await createUser(20);
  const result = await admin.query<{ resource_id: number }>(
    `
      INSERT INTO "Resource" (owner_id, building_id, category_id, name, description,
        location_description, max_reservation_time, required_credits, capacity)
      VALUES ($1, (SELECT MIN(building_id) FROM "Building"), (SELECT MIN(category_id) FROM "ResourceCategory"),
        $2, 'Integration test resource', 'Test location', NULL, $3, 4)
      RETURNING resource_id
    `,
    [owner, `Credit test room ${credits} ${Date.now()} ${Math.random()}`, credits],
  );
  const id = result.rows[0].resource_id;
  await admin.query(
    `
      INSERT INTO "ResourceAvailability" (resource_id, start_time, end_time, repeats_until, repeats_offset)
      VALUES ($1, '2026-11-01 08:00', '2026-11-01 22:00', '2028-12-31 22:00', interval '1 day')
    `,
    [id],
  );
  return id;
}

// One availability-change transaction, as updateListing runs it: lock the
// resource, replace the availability so nothing fits, cancel and refund.
async function closeResource(resource: number): Promise<number[]> {
  const client = await connect();
  await client.query("BEGIN");
  try {
    await client.query(`SELECT resource_id FROM "Resource" WHERE resource_id = $1 FOR UPDATE`, [resource]);
    await client.query(`DELETE FROM "ResourceAvailability" WHERE resource_id = $1`, [resource]);
    const ids = await cancelAffectedReservations(client, resource, "Credit test room");
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function balanceOf(userId: number): Promise<number> {
  const result = await admin.query<{ credit_balance: number }>(
    `SELECT credit_balance FROM "User" WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0].credit_balance;
}

async function countCredits(userId: number, type: string): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `SELECT COUNT(*)::integer AS count FROM "CreditTransaction" WHERE user_id = $1 AND transaction_type = $2`,
    [userId, type],
  );
  return result.rows[0].count;
}

async function setResetAnchor(userId: number, daysAgo: number): Promise<void> {
  await admin.query(
    `UPDATE "User"
     SET credit_last_reset = (now() AT TIME ZONE 'America/New_York')::date - $2::integer
     WHERE user_id = $1`,
    [userId, daysAgo],
  );
}

async function isolateMonthlySweep(userIds: number[]): Promise<void> {
  await admin.query(
    `UPDATE "User"
     SET credit_last_reset = (now() AT TIME ZONE 'America/New_York')::date
     WHERE NOT (user_id = ANY($1::integer[]))`,
    [userIds],
  );
}

async function historyTotal(userId: number): Promise<number> {
  const result = await admin.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0)::integer AS total FROM "CreditTransaction" WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0].total;
}

async function book(userId: number, resource = resourceId, slot = nextSlot()) {
  const client = await connect();
  return createReservation(client, userId, { resourceId: resource, slot });
}

// Inserts a reservation (and optionally its paired charge) directly, starting
// `hoursAhead` hours from now in campus time.
async function insertReservation(userId: number, hoursAhead: number, chargeCredits: number | null) {
  await admin.query("BEGIN");
  const inserted = await admin.query<{ reservation_id: number }>(
    `
      INSERT INTO "Reservation" (user_id, resource_id, start_time, end_time, status, created_at)
      VALUES ($1, $2,
        date_trunc('minute', (now() AT TIME ZONE 'America/New_York')) + $3::integer * interval '1 minute',
        date_trunc('minute', (now() AT TIME ZONE 'America/New_York')) + ($3::integer + 60) * interval '1 minute',
        'confirmed', (now() AT TIME ZONE 'America/New_York'))
      RETURNING reservation_id
    `,
    [userId, resourceId, Math.round(hoursAhead * 60)],
  );
  const reservationId = inserted.rows[0].reservation_id;
  if (chargeCredits !== null) {
    await admin.query(
      `
        INSERT INTO "CreditTransaction" (user_id, amount, transaction_type, created_at)
        SELECT $1, -$2::integer, 'reservation_charge', created_at FROM "Reservation" WHERE reservation_id = $3
      `,
      [userId, chargeCredits, reservationId],
    );
    await admin.query(`UPDATE "User" SET credit_balance = credit_balance - $2 WHERE user_id = $1`, [userId, chargeCredits]);
  }
  await admin.query("COMMIT");
  return reservationId;
}

describe.skipIf(!url)("credits against real PostgreSQL", () => {
  beforeAll(async () => {
    admin = await connect();
    const name = await admin.query<{ name: string }>("SELECT current_database() AS name");
    if (!name.rows[0].name.startsWith(REQUIRED_DATABASE_PREFIX)) {
      throw new Error(`Refusing to run: database must start with "${REQUIRED_DATABASE_PREFIX}".`);
    }

    resourceId = await insertResource(3);
    cheapResourceId = await insertResource(1);
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
  });

  it("uses timestamp columns, so created_at keeps microseconds", async () => {
    const result = await admin.query<{ table_name: string; data_type: string }>(
      `
        SELECT table_name, data_type FROM information_schema.columns
        WHERE column_name = 'created_at' AND table_name IN ('Reservation', 'CreditTransaction')
        ORDER BY table_name
      `,
    );
    expect(result.rows).toEqual([
      { table_name: "CreditTransaction", data_type: "timestamp without time zone" },
      { table_name: "Reservation", data_type: "timestamp without time zone" },
    ]);
  });

  it("adds 20 credits per completed period and is idempotent", async () => {
    const userId = await createUser(7);
    await isolateMonthlySweep([userId]);
    await setResetAnchor(userId, 90);

    const first = await applyMonthlyCreditResets(admin);
    expect(first).toMatchObject({ usersProcessed: 1, periodsGranted: 3, creditsGranted: 60 });
    expect(await balanceOf(userId)).toBe(67);
    expect(await countCredits(userId, "monthly_reset")).toBe(3);
    expect(await balanceOf(userId)).toBe(await historyTotal(userId));

    const second = await applyMonthlyCreditResets(admin);
    expect(second).toEqual({ usersProcessed: 0, periodsGranted: 0, creditsGranted: 0 });
    expect(await balanceOf(userId)).toBe(67);
    expect(await countCredits(userId, "monthly_reset")).toBe(3);
  });

  it("does not grant banned or deleted accounts", async () => {
    const banned = await createUser(7);
    const deleted = await createUser(7);
    await isolateMonthlySweep([banned, deleted]);
    await setResetAnchor(banned, 30);
    await setResetAnchor(deleted, 30);
    await admin.query(`UPDATE "User" SET is_banned = TRUE WHERE user_id = $1`, [banned]);
    await admin.query(`UPDATE "User" SET is_account_deleted = TRUE WHERE user_id = $1`, [deleted]);

    const result = await applyMonthlyCreditResets(admin);
    expect(result.usersProcessed).toBe(0);
    expect(await balanceOf(banned)).toBe(7);
    expect(await balanceOf(deleted)).toBe(7);
    expect(await countCredits(banned, "monthly_reset")).toBe(0);
    expect(await countCredits(deleted, "monthly_reset")).toBe(0);
  });

  it("does not double-credit when two sweeps run concurrently", async () => {
    const userId = await createUser(7);
    await isolateMonthlySweep([userId]);
    await setResetAnchor(userId, 60);

    const results = await Promise.all([
      applyMonthlyCreditResets(await connect()),
      applyMonthlyCreditResets(await connect()),
    ]);

    expect(results.reduce((total, result) => total + result.periodsGranted, 0)).toBe(2);
    expect(await balanceOf(userId)).toBe(47);
    expect(await countCredits(userId, "monthly_reset")).toBe(2);
    expect(await balanceOf(userId)).toBe(await historyTotal(userId));
  });

  it("writes the reservation and its charge with the identical campus-time timestamp", async () => {
    const userId = await createUser(20);
    const result = await book(userId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stamps = await admin.query<{ reservation_stamp: string; charge_stamp: string; amount: number; drift_seconds: number }>(
      `
        SELECT to_char(rv.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS reservation_stamp,
               to_char(ct.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS charge_stamp,
               ct.amount,
               ABS(EXTRACT(EPOCH FROM (rv.created_at - (now() AT TIME ZONE 'America/New_York'))))::integer AS drift_seconds
        FROM "Reservation" rv
        JOIN "CreditTransaction" ct ON ct.user_id = rv.user_id AND ct.transaction_type = 'reservation_charge'
        WHERE rv.reservation_id = $1
      `,
      [result.value.id],
    );
    expect(stamps.rows).toHaveLength(1);
    expect(stamps.rows[0].charge_stamp).toBe(stamps.rows[0].reservation_stamp);
    expect(stamps.rows[0].amount).toBe(-3);
    expect(stamps.rows[0].drift_seconds).toBeLessThan(120);
    expect(result.credits).toEqual({ charged: 3, refunded: 0, balance: 17 });
    expect(await findReservationCharge(admin, result.value.id)).toEqual({ status: "matched", credits: 3 });
    expect(await balanceOf(userId)).toBe(await historyTotal(userId));
  });

  it("rejects insufficient credits and leaves no reservation or charge behind", async () => {
    const userId = await createUser(2);
    const result = await book(userId);

    expect(result).toMatchObject({ ok: false, status: 409 });
    const reservations = await admin.query(`SELECT 1 FROM "Reservation" WHERE user_id = $1`, [userId]);
    expect(reservations.rows).toHaveLength(0);
    expect(await countCredits(userId, "reservation_charge")).toBe(0);
    expect(await balanceOf(userId)).toBe(2);
  });

  it("lets exactly one of many parallel bookings spend the last credits", async () => {
    const userId = await createUser(3);
    const results = await Promise.all(Array.from({ length: 6 }, () => book(userId)));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.status === 409)).toHaveLength(5);
    expect(await balanceOf(userId)).toBe(0);
    expect(await countCredits(userId, "reservation_charge")).toBe(1);
    expect(await balanceOf(userId)).toBe(await historyTotal(userId));
  });

  it("spends exactly what the balance allows across parallel bookings of two resources", async () => {
    const userId = await createUser(10);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => book(userId, index % 2 ? cheapResourceId : resourceId)),
    );

    const balance = await balanceOf(userId);
    expect(balance).toBeGreaterThanOrEqual(0);
    // Some request was refused, and a refusal means the balance was below its cost (at most 3).
    expect(balance).toBeLessThan(3);
    expect(balance).toBe(await historyTotal(userId));
    const reservations = await admin.query(`SELECT 1 FROM "Reservation" WHERE user_id = $1`, [userId]);
    expect(reservations.rows).toHaveLength(results.filter((result) => result.ok).length);
    expect(await countCredits(userId, "reservation_charge")).toBe(reservations.rows.length);
  });

  it("refunds once when many cancel requests race", async () => {
    const userId = await createUser(20);
    const booked = await book(userId);
    if (!booked.ok) throw new Error(booked.error);

    const results = await Promise.all(
      Array.from({ length: 5 }, async () => cancelReservation(await connect(), userId, booked.value.id)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await countCredits(userId, "refund")).toBe(1);
    expect(await balanceOf(userId)).toBe(20);
    expect(await balanceOf(userId)).toBe(await historyTotal(userId));
  });

  it("refunds once, without deadlocking, when a user cancel races an availability change", async () => {
    // Repeated so both orders (user first, owner first) are likely exercised.
    const winners = { user: 0, owner: 0 };
    for (let round = 0; round < 6; round += 1) {
      const resource = await insertResource(2);
      const userId = await createUser(20);
      const booked = await book(userId, resource);
      if (!booked.ok) throw new Error(booked.error);

      const [cancelled, closed] = await Promise.all([
        (async () => cancelReservation(await connect(), userId, booked.value.id))(),
        closeResource(resource),
      ]);

      // Exactly one of the two cancelled it; the other saw it already cancelled.
      expect(Number(cancelled.ok) + closed.length).toBe(1);
      winners[cancelled.ok ? "user" : "owner"] += 1;
      expect(await countCredits(userId, "refund")).toBe(1);
      expect(await balanceOf(userId)).toBe(20);
      expect(await balanceOf(userId)).toBe(await historyTotal(userId));
    }
    console.info(`Cancel race winners: ${winners.user} user cancel(s), ${winners.owner} availability change(s).`);
  });

  it("refunds every affected user once when an availability change cancels several bookings", async () => {
    const resource = await insertResource(2);
    const users = [await createUser(20), await createUser(20), await createUser(20)];
    for (const userId of users) {
      const booked = await book(userId, resource);
      if (!booked.ok) throw new Error(booked.error);
    }
    const legacyUser = await createUser(20);
    await admin.query(
      `
        INSERT INTO "Reservation" (user_id, resource_id, start_time, end_time, status)
        VALUES ($1, $2, '2028-06-01 10:00', '2028-06-01 11:00', 'confirmed')
      `,
      [legacyUser, resource],
    );

    const ids = await closeResource(resource);
    const again = await closeResource(resource);

    expect(ids).toHaveLength(4);
    expect(again).toEqual([]);
    for (const userId of users) {
      expect(await countCredits(userId, "refund")).toBe(1);
      expect(await balanceOf(userId)).toBe(20);
    }
    expect(await countCredits(legacyUser, "refund")).toBe(0);
    expect(await balanceOf(legacyUser)).toBe(20);
  });

  it("refunds 24+ hours ahead, not inside 24 hours, and never refunds uncharged or ambiguous bookings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const userId = await createUser(20);

    // 24 hours and 1 minute after the start of the current minute: still at least 24 hours away when cancelled.
    const early = await insertReservation(userId, 24 + 1 / 60, 2);
    const late = await insertReservation(userId, 23.5, 2);
    const legacy = await insertReservation(userId, 48, null);

    const earlyResult = await cancelReservation(await connect(), userId, early);
    const lateResult = await cancelReservation(await connect(), userId, late);
    const legacyResult = await cancelReservation(await connect(), userId, legacy);

    expect(earlyResult.ok && earlyResult.credits?.refundStatus).toBe("refunded");
    expect(lateResult.ok && lateResult.credits?.refundStatus).toBe("late");
    expect(legacyResult.ok && legacyResult.credits?.refundStatus).toBe("not_charged");
    expect(await countCredits(userId, "refund")).toBe(1);
    expect(await balanceOf(userId)).toBe(18);

    // Two reservations sharing one timestamp: the match is ambiguous, so no refund.
    await admin.query("BEGIN");
    const twins = await admin.query<{ reservation_id: number }>(
      `
        INSERT INTO "Reservation" (user_id, resource_id, start_time, end_time, status, created_at)
        VALUES ($1, $2, '2028-03-01 10:00', '2028-03-01 11:00', 'confirmed', (now() AT TIME ZONE 'America/New_York')),
               ($1, $2, '2028-03-02 10:00', '2028-03-02 11:00', 'confirmed', (now() AT TIME ZONE 'America/New_York'))
        RETURNING reservation_id
      `,
      [userId, resourceId],
    );
    await admin.query(
      `INSERT INTO "CreditTransaction" (user_id, amount, transaction_type, created_at)
       VALUES ($1, -3, 'reservation_charge', (now() AT TIME ZONE 'America/New_York'))`,
      [userId],
    );
    await admin.query(`UPDATE "User" SET credit_balance = credit_balance - 3 WHERE user_id = $1`, [userId]);
    await admin.query("COMMIT");

    const ambiguous = await cancelReservation(await connect(), userId, twins.rows[0].reservation_id);
    expect(ambiguous.ok && ambiguous.credits?.refundStatus).toBe("unverified");
    expect(await countCredits(userId, "refund")).toBe(1);
    warn.mockRestore();
  });

  it("returns a reliable running balance and pairs charges in the history", async () => {
    const userId = await createUser(20);
    const first = await book(userId);
    const second = await book(userId, cheapResourceId);
    if (!first.ok || !second.ok) throw new Error("booking failed");
    await cancelReservation(await connect(), userId, first.value.id);

    const summary = await getCreditSummary(admin, userId);
    expect(summary).toMatchObject({ balance: 19, spent: 4, refunded: 3, granted: 20, received: 23, historyMatchesBalance: true });

    const page = await listCreditTransactions(admin, userId, { filter: "all", page: 1, pageSize: 20 });
    expect(page.total).toBe(4);
    expect(page.items.map((item) => [item.type, item.amount, item.balanceAfter])).toEqual([
      ["refund", 3, 19],
      ["reservation_charge", -1, 16],
      ["reservation_charge", -3, 17],
      ["initial_grant", 20, 20],
    ]);
    expect(page.items[0].reservation).toBeNull();
    expect(page.items[1].reservation?.id).toBe(second.value.id);
    expect(page.items[2].reservation?.id).toBe(first.value.id);

    const charges = await listCreditTransactions(admin, userId, { filter: "charges", page: 1, pageSize: 1 });
    expect(charges.total).toBe(2);
    expect(charges.items).toHaveLength(1);
    // The running balance is computed before the filter.
    expect(charges.items[0].balanceAfter).toBe(16);
  });

  it("finds seed charges paired with seed reservations and every seed history adding up", async () => {
    const seed = await admin.query<{ charges: number; paired: number; mismatched_users: number }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM "CreditTransaction" WHERE transaction_type = 'reservation_charge' AND transaction_id <= 105) AS charges,
          (SELECT COUNT(*)::integer FROM "CreditTransaction" ct
            WHERE ct.transaction_type = 'reservation_charge' AND ct.transaction_id <= 105
              AND (SELECT COUNT(*) FROM "Reservation" rv WHERE rv.user_id = ct.user_id AND rv.created_at = ct.created_at) = 1) AS paired,
          (SELECT COUNT(*)::integer FROM "User" u
            WHERE u.user_id <= 25
              AND u.credit_balance <> (SELECT COALESCE(SUM(amount), 0) FROM "CreditTransaction" WHERE user_id = u.user_id)) AS mismatched_users
      `,
    );
    console.info(`Seed pairing: ${seed.rows[0].paired} of ${seed.rows[0].charges} seed charges pair with one reservation.`);
    expect(seed.rows[0].mismatched_users).toBe(0);
    expect(seed.rows[0].paired).toBe(seed.rows[0].charges);
  });
});
