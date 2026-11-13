import { describe, expect, it } from "vitest";
import type { DatabaseClient, DatabaseQueryResult } from "../db/client";
import {
  APPLY_MONTHLY_CREDITS_SQL,
  FIND_DUE_MONTHLY_CREDITS_SQL,
  INSERT_MONTHLY_CREDIT_TRANSACTIONS_SQL,
  applyMonthlyCreditResets,
} from "../db/repositories/credits";
import { scheduled, runMonthlyCreditSweep } from "../backend/index";

type Query = { text: string; values: readonly unknown[] };

function fakeClient(options: {
  due?: Array<{ user_id: number; periods_due: number }>;
  failOnInsert?: boolean;
} = {}) {
  const queries: Query[] = [];
  const client: DatabaseClient = {
    connect: async () => {},
    end: async () => {},
    query: async <T = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<DatabaseQueryResult<T>> => {
      queries.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 } as DatabaseQueryResult<T>;
      }
      if (text === FIND_DUE_MONTHLY_CREDITS_SQL) {
        return { rows: options.due ?? [], rowCount: options.due?.length ?? 0 } as DatabaseQueryResult<T>;
      }
      if (text === INSERT_MONTHLY_CREDIT_TRANSACTIONS_SQL && options.failOnInsert) {
        throw new Error("insert failed");
      }
      if (text === APPLY_MONTHLY_CREDITS_SQL || text === INSERT_MONTHLY_CREDIT_TRANSACTIONS_SQL) {
        return { rows: [], rowCount: 1 } as DatabaseQueryResult<T>;
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  return { client, queries };
}

describe("applyMonthlyCreditResets", () => {
  it("adds 20 credits for one completed period without resetting the balance", async () => {
    const database = fakeClient({ due: [{ user_id: 7, periods_due: 1 }] });

    await expect(applyMonthlyCreditResets(database.client)).resolves.toEqual({
      usersProcessed: 1,
      periodsGranted: 1,
      creditsGranted: 20,
    });

    expect(database.queries).toContainEqual({
      text: APPLY_MONTHLY_CREDITS_SQL,
      values: [7, 20, 30],
    });
    expect(database.queries).toContainEqual({
      text: INSERT_MONTHLY_CREDIT_TRANSACTIONS_SQL,
      values: [7, 20, 1],
    });
    expect(database.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("catches up every completed period with one transaction per period", async () => {
    const database = fakeClient({ due: [{ user_id: 7, periods_due: 3 }] });

    await expect(applyMonthlyCreditResets(database.client)).resolves.toMatchObject({
      usersProcessed: 1,
      periodsGranted: 3,
      creditsGranted: 60,
    });
    expect(database.queries).toContainEqual({
      text: APPLY_MONTHLY_CREDITS_SQL,
      values: [7, 60, 90],
    });
    expect(database.queries).toContainEqual({
      text: INSERT_MONTHLY_CREDIT_TRANSACTIONS_SQL,
      values: [7, 20, 3],
    });
  });

  it("does nothing when no active user is due", async () => {
    const database = fakeClient();

    await expect(applyMonthlyCreditResets(database.client)).resolves.toEqual({
      usersProcessed: 0,
      periodsGranted: 0,
      creditsGranted: 0,
    });
    expect(database.queries.some((query) => query.text === APPLY_MONTHLY_CREDITS_SQL)).toBe(false);
    expect(database.queries.some((query) => query.text === INSERT_MONTHLY_CREDIT_TRANSACTIONS_SQL)).toBe(false);
  });

  it("rolls back the complete sweep when a transaction insert fails", async () => {
    const database = fakeClient({ due: [{ user_id: 7, periods_due: 1 }], failOnInsert: true });

    await expect(applyMonthlyCreditResets(database.client)).rejects.toThrow("insert failed");
    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("filters banned and deleted accounts in the database query", () => {
    expect(FIND_DUE_MONTHLY_CREDITS_SQL).toMatch(/is_banned = FALSE/);
    expect(FIND_DUE_MONTHLY_CREDITS_SQL).toMatch(/is_account_deleted = FALSE/);
    expect(FIND_DUE_MONTHLY_CREDITS_SQL).toMatch(/FOR UPDATE/);
  });
});

describe("runMonthlyCreditSweep", () => {
  it("uses the configured database connection and closes the client", async () => {
    const database = fakeClient();
    let connectionString = "";

    await expect(
      runMonthlyCreditSweep(
        { DB: { connectionString: "postgres://credit-test" } as Hyperdrive },
        (connection) => {
          connectionString = connection;
          return database.client;
        },
      ),
    ).resolves.toEqual({ usersProcessed: 0, periodsGranted: 0, creditsGranted: 0 });

    expect(connectionString).toBe("postgres://credit-test");
    expect(database.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("dispatches the daily cron to the monthly credit sweep", async () => {
    const database = fakeClient();

    await scheduled(
      { cron: "0 6 * * *" } as ScheduledController,
      { DB: { connectionString: "postgres://credit-test" } as Hyperdrive } as never,
      () => database.client,
    );

    expect(database.queries.at(0)?.text).toBe("BEGIN");
    expect(database.queries.at(-1)?.text).toBe("COMMIT");
  });
});
