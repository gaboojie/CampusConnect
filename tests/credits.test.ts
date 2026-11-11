import { describe, expect, it, vi } from "vitest";
import { createApp } from "../backend/index";
import type { DatabaseClient, DatabaseQueryResult } from "../db/client";
import {
  CREDIT_PAGE_SIZE,
  FIND_RESERVATION_CHARGE_SQL,
  parseCreditTransactionQuery,
  REFUND_CREDITS_SQL,
} from "../db/repositories/credits";
import { cancelAffectedReservations } from "../db/repositories/listings";
import { FakeReadDatabase, authHeaders, expectReadOnly } from "./support/fakeReadDatabase";

const SESSION_USER = 6;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

const summaryRow = {
  credit_balance: 14,
  credit_last_reset: "2026-10-01",
  spent: 10,
  refunded: 4,
  granted: 20,
  transaction_count: 6,
  history_total: 14,
};

const transactionRows = [
  {
    transaction_id: 92,
    amount: -2,
    transaction_type: "reservation_charge",
    created_at: "2026-10-06T16:00:00",
    balance_after: 14,
    reservation_id: 47,
    resource_id: 2,
    resource_name: "Newman Group Study Room 2",
    building_name: "Carol M. Newman Library",
    start_time: "2026-10-14T10:00:00",
    end_time: "2026-10-14T12:00:00",
  },
  {
    transaction_id: 98,
    amount: 2,
    transaction_type: "refund",
    created_at: "2026-10-08T18:30:00",
    balance_after: 16,
    reservation_id: null,
    resource_id: null,
    resource_name: null,
    building_name: null,
    start_time: null,
    end_time: null,
  },
];

function creditDatabase() {
  return new FakeReadDatabase()
    .respond("SELECT u.credit_balance", [summaryRow])
    .respond("WITH history AS", transactionRows)
    .respond("SELECT COUNT(*)::integer AS total", [{ total: 34 }]);
}

async function get(database: FakeReadDatabase, path: string, headers: Record<string, string> = authHeaders) {
  const app = createApp({ createDatabaseClient: () => database.createClient() });
  return app.request(`http://localhost${path}`, { headers }, database.environment());
}

describe("credit endpoints require a session", () => {
  it.each(["/api/credits", "/api/credits/transactions"])("GET %s returns 401 without a cookie", async (path) => {
    const database = creditDatabase();
    const response = await get(database, path, {});

    expect(response.status).toBe(401);
    expect(database.queries).toEqual([]);
  });
});

describe("GET /api/credits", () => {
  it("returns the session user's balance and totals", async () => {
    const database = creditDatabase();
    const response = await get(database, "/api/credits");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: {
        balance: 14,
        creditLastReset: "2026-10-01",
        spent: 10,
        refunded: 4,
        granted: 20,
        received: 24,
        transactionCount: 6,
        historyMatchesBalance: true,
      },
    });
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0].values).toEqual([SESSION_USER]);
    expectReadOnly(database.queries);
  });

  it("flags a history that does not add up to the stored balance", async () => {
    const database = new FakeReadDatabase().respond("SELECT u.credit_balance", [{ ...summaryRow, history_total: 16 }]);
    const body = (await (await get(database, "/api/credits")).json()) as { summary: { historyMatchesBalance: boolean } };

    expect(body.summary.historyMatchesBalance).toBe(false);
  });

  it("ignores a user id in the query string", async () => {
    const database = creditDatabase();
    await get(database, "/api/credits?userId=7&user_id=7");

    expect(database.queries[0].values).toEqual([SESSION_USER]);
  });

  it("returns 503 when the database fails", async () => {
    const database = creditDatabase();
    database.failWith = new Error("down");

    expect((await get(database, "/api/credits")).status).toBe(503);
  });
});

describe("GET /api/credits/transactions", () => {
  it("returns a page of the session user's history", async () => {
    const database = creditDatabase();
    const response = await get(database, "/api/credits/transactions");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          id: 92,
          type: "reservation_charge",
          amount: -2,
          createdAt: "2026-10-06T16:00:00",
          balanceAfter: 14,
          reservation: {
            id: 47,
            resource: { id: 2, name: "Newman Group Study Room 2" },
            building: { name: "Carol M. Newman Library" },
            startTime: "2026-10-14T10:00:00",
            endTime: "2026-10-14T12:00:00",
          },
        },
        {
          id: 98,
          type: "refund",
          amount: 2,
          createdAt: "2026-10-08T18:30:00",
          balanceAfter: 16,
          reservation: null,
        },
      ],
      total: 34,
      page: 1,
      pageSize: CREDIT_PAGE_SIZE,
    });

    const [list, count] = database.queries;
    expect(list.values).toEqual([
      SESSION_USER,
      ["initial_grant", "reservation_charge", "refund", "monthly_reset"],
      20,
      0,
    ]);
    expect(count.values).toEqual([SESSION_USER, ["initial_grant", "reservation_charge", "refund", "monthly_reset"]]);
    expect(list.text).toMatch(/WHERE ct\.user_id = \$1/);
    expect(list.text).toMatch(/SUM\(ct\.amount\) OVER \(ORDER BY ct\.transaction_id\)/);
    expectReadOnly(database.queries);
  });

  it.each([
    ["charges", ["reservation_charge"]],
    ["refunds", ["refund"]],
    ["grants", ["initial_grant", "monthly_reset"]],
    ["all", ["initial_grant", "reservation_charge", "refund", "monthly_reset"]],
  ])("filters by type=%s", async (type, types) => {
    const database = creditDatabase();
    await get(database, `/api/credits/transactions?type=${type}`);

    expect(database.queries[0].values[1]).toEqual(types);
    expect(database.queries[1].values[1]).toEqual(types);
  });

  it("pages with an offset and caps the page size", async () => {
    const database = creditDatabase();
    const body = (await (await get(database, "/api/credits/transactions?page=3")).json()) as { page: number };

    expect(body.page).toBe(3);
    expect(database.queries[0].values.slice(2)).toEqual([20, 40]);

    const capped = creditDatabase();
    await get(capped, "/api/credits/transactions?pageSize=500");
    expect(capped.queries[0].values[2]).toBe(50);
  });

  it("only ever queries the session user, whatever the query string says", async () => {
    const database = creditDatabase();
    await get(database, "/api/credits/transactions?userId=7&user_id=7&type=refunds");

    for (const query of database.queries) {
      expect(query.values[0]).toBe(SESSION_USER);
    }
  });

  it.each([
    ["page=0", /Page must be/],
    ["page=abc", /Page must be/],
    ["page=-1", /Page must be/],
    ["page=10001", /Page must be/],
    ["pageSize=0", /Page size must be/],
    ["type=bonus", /Type must be one of/],
    ["type=__proto__", /Type must be one of/],
  ])("returns 400 for %s without querying", async (query, message) => {
    const database = creditDatabase();
    const response = await get(database, `/api/credits/transactions?${query}`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
    expect(database.queries).toEqual([]);
  });

  it("returns 503 when the database fails", async () => {
    const database = creditDatabase();
    database.failWith = new Error("down");

    expect((await get(database, "/api/credits/transactions")).status).toBe(503);
  });
});

describe("parseCreditTransactionQuery", () => {
  it("defaults to all types, page 1, 20 per page", () => {
    expect(parseCreditTransactionQuery(new URLSearchParams())).toEqual({
      ok: true,
      value: { filter: "all", page: 1, pageSize: 20 },
    });
  });
});

// ---------------------------------------------------------------------------
// Availability-change cancellations (system-caused, always refundable)
// ---------------------------------------------------------------------------

type Affected = { reservation_id: number; user_id: number; start_time: string; end_time: string };

function scriptedClient(options: {
  affected: Affected[];
  charges: Record<number, { charge_count: number; charge_credits: number | null; reservation_count: number }>;
  alreadyCancelled?: number[];
}) {
  const log: Array<{ text: string; values: readonly unknown[] }> = [];
  const balances = new Map<number, number>([[6, 10], [7, 10]]);
  let notificationId = 900;

  const client: DatabaseClient = {
    connect: async () => {},
    end: async () => {},
    query: async <T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<DatabaseQueryResult<T>> => {
      const query = normalize(text);
      log.push({ text: query, values });
      let rows: unknown[] = [];

      if (query.startsWith("SELECT rv.reservation_id, rv.user_id")) rows = options.affected;
      else if (query.startsWith('SELECT user_id FROM "User"')) rows = [];
      else if (query.startsWith('UPDATE "Reservation" SET status = \'cancelled\'')) {
        rows = options.alreadyCancelled?.includes(values[0] as number) ? [] : [{}];
      } else if (query === normalize(FIND_RESERVATION_CHARGE_SQL)) {
        rows = [options.charges[values[0] as number] ?? { charge_count: 0, charge_credits: null, reservation_count: 1 }];
      } else if (query === normalize(REFUND_CREDITS_SQL)) {
        const [userId, credits] = values as [number, number];
        balances.set(userId, balances.get(userId)! + credits);
        rows = [{ balance_after: balances.get(userId) }];
      } else if (query.includes('INSERT INTO "Notification"')) rows = [{ notification_id: notificationId++ }];
      else if (query.startsWith('UPDATE "Notification"')) rows = [];
      else throw new Error(`Unhandled scripted query: ${query}`);

      return { rows: rows as T[], rowCount: rows.length };
    },
  };

  const refunds = () => log.filter((entry) => entry.text === normalize(REFUND_CREDITS_SQL)).map((entry) => entry.values);
  const messages = () =>
    log.filter((entry) => entry.text.includes('INSERT INTO "Notification"')).map((entry) => entry.values[2] as string);
  return { client, log, balances, refunds, messages };
}

const affected = (reservationId: number, userId: number): Affected => ({
  reservation_id: reservationId,
  user_id: userId,
  start_time: "2026-10-20T10:00:00",
  end_time: "2026-10-20T11:00:00",
});

describe("availability-change cancellations", () => {
  it("refunds the paired charge, even inside 24 hours, and not the current price", async () => {
    const script = scriptedClient({
      affected: [affected(1, 6)],
      charges: { 1: { charge_count: 1, charge_credits: 3, reservation_count: 1 } },
    });

    const ids = await cancelAffectedReservations(script.client, 12, "Quiet study room");

    expect(ids).toEqual([900]);
    expect(script.refunds()).toEqual([[6, 3]]);
    expect(script.balances.get(6)).toBe(13);
    expect(script.messages()[0]).toMatch(/availability changed\. 3 credits refunded\.$/);
  });

  it("does not refund a reservation that was never charged", async () => {
    const script = scriptedClient({ affected: [affected(2, 7)], charges: {} });

    await cancelAffectedReservations(script.client, 12, "Quiet study room");

    expect(script.refunds()).toEqual([]);
    expect(script.balances.get(7)).toBe(10);
    expect(script.messages()[0]).toMatch(/No credits were charged for this booking/);
  });

  it("does not refund when the charge cannot be identified reliably", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const script = scriptedClient({
      affected: [affected(3, 6)],
      charges: { 3: { charge_count: 2, charge_credits: 2, reservation_count: 1 } },
    });

    await cancelAffectedReservations(script.client, 12, "Quiet study room");

    expect(script.refunds()).toEqual([]);
    expect(script.messages()[0]).toMatch(/could not be verified automatically/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips reservations another transaction already cancelled", async () => {
    const script = scriptedClient({
      affected: [affected(4, 6), affected(5, 6)],
      charges: {
        4: { charge_count: 1, charge_credits: 2, reservation_count: 1 },
        5: { charge_count: 1, charge_credits: 2, reservation_count: 1 },
      },
      alreadyCancelled: [4],
    });

    const ids = await cancelAffectedReservations(script.client, 12, "Quiet study room");

    expect(ids).toHaveLength(1);
    expect(script.refunds()).toEqual([[6, 2]]);
    expect(script.log.some((entry) => entry.text === normalize(FIND_RESERVATION_CHARGE_SQL) && entry.values[0] === 4)).toBe(false);
  });

  it("handles a mix of users and keeps the existing lock order", async () => {
    const script = scriptedClient({
      affected: [affected(6, 6), affected(7, 7), affected(8, 7)],
      charges: {
        6: { charge_count: 1, charge_credits: 1, reservation_count: 1 },
        8: { charge_count: 1, charge_credits: 4, reservation_count: 1 },
      },
    });

    await cancelAffectedReservations(script.client, 12, "Quiet study room");

    expect(script.refunds()).toEqual([[6, 1], [7, 4]]);
    const texts = script.log.map((entry) => entry.text);
    // Reservations are locked first, then their users, then any write happens.
    expect(texts[0]).toMatch(/FOR UPDATE$/);
    expect(texts[1]).toMatch(/^SELECT user_id FROM "User" .* ORDER BY user_id FOR UPDATE$/);
    expect(script.log[1].values).toEqual([[6, 7]]);
  });
});
