import type { DatabaseClient } from "../client";
import { CAMPUS_NOW_SQL, localTimestampSql, type Validation } from "./resources";

// Credit rules (from the documented seed-data rules in 002_seed.sql):
//   * Each successful booking deducts the resource's required_credits once.
//   * Cancelling at least 24 hours before the start is fully refunded; later
//     cancellations and no-shows are not refunded.
//   * System-caused cancellations (availability changes) are always fully refunded.
//   * Rescheduling does not change the charge.
export const REFUND_NOTICE_HOURS = 24;
export const REFUND_WINDOW_SQL = `interval '${REFUND_NOTICE_HOURS} hours'`;

export const CREDIT_TRANSACTION_TYPES = [
  "initial_grant",
  "reservation_charge",
  "refund",
  "monthly_reset",
] as const;
export type CreditTransactionType = (typeof CREDIT_TRANSACTION_TYPES)[number];

export const CREDIT_FILTERS = {
  all: [...CREDIT_TRANSACTION_TYPES],
  charges: ["reservation_charge"],
  refunds: ["refund"],
  grants: ["initial_grant", "monthly_reset"],
} as const satisfies Record<string, readonly CreditTransactionType[]>;
export type CreditFilter = keyof typeof CREDIT_FILTERS;

export const CREDIT_PAGE_SIZE = 20;
const MAX_CREDIT_PAGE_SIZE = 50;
const MAX_CREDIT_PAGE = 10_000;

// ---------------------------------------------------------------------------
// Pairing a reservation with its charge
//
// "CreditTransaction" has no reservation_id column. A booking therefore writes
// its reservation and its charge in the same database transaction with the same
// created_at value: the reservation stores the campus time of the transaction
// and the charge copies that exact value from the reservation row. Both columns
// are `timestamp` (microsecond precision).
//
// A timestamp match is NOT treated as a foreign key. A reservation is considered
// charged only when, for that user, exactly one reservation and exactly one
// 'reservation_charge' row share the timestamp, and the charge is negative.
// Anything else (no match, or more than one candidate) is reported as missing or
// ambiguous, and no automatic refund is issued. Amounts are never used to match.
// ---------------------------------------------------------------------------

// Adds a one-row "charge" relation for the reservation alias `rv`.
export function pairedChargeJoinSql(rv: string): string {
  return `
    LEFT JOIN LATERAL (
      SELECT
        COUNT(ct.transaction_id)::integer AS charge_count,
        (-MIN(ct.amount))::integer AS charge_credits,
        (
          SELECT COUNT(*)::integer
          FROM "Reservation" AS twin
          WHERE twin.user_id = ${rv}.user_id
            AND twin.created_at = ${rv}.created_at
        ) AS reservation_count
      FROM "CreditTransaction" AS ct
      WHERE ct.user_id = ${rv}.user_id
        AND ct.transaction_type = 'reservation_charge'
        AND ct.created_at = ${rv}.created_at
    ) AS charge ON TRUE
  `;
}

// The credits paid for the reservation, or NULL when no single charge pairs with it.
export const PAIRED_CHARGE_CREDITS_SQL = `
  CASE
    WHEN charge.charge_count = 1 AND charge.reservation_count = 1 AND charge.charge_credits > 0
    THEN charge.charge_credits
  END
`;

export type ChargeMatch =
  | { status: "matched"; credits: number }
  | { status: "missing" }
  | { status: "ambiguous"; chargeCount: number; reservationCount: number };

export const FIND_RESERVATION_CHARGE_SQL = `
  SELECT charge.charge_count, charge.charge_credits, charge.reservation_count
  FROM "Reservation" AS rv
  ${pairedChargeJoinSql("rv")}
  WHERE rv.reservation_id = $1
`;

export async function findReservationCharge(
  client: DatabaseClient,
  reservationId: number,
): Promise<ChargeMatch> {
  const result = await client.query<{
    charge_count: number;
    charge_credits: number | null;
    reservation_count: number;
  }>(FIND_RESERVATION_CHARGE_SQL, [reservationId]);
  const row = result.rows[0];

  if (!row || row.charge_count === 0) return { status: "missing" };
  if (
    row.charge_count === 1 &&
    row.reservation_count === 1 &&
    row.charge_credits !== null &&
    row.charge_credits > 0
  ) {
    return { status: "matched", credits: row.charge_credits };
  }
  return {
    status: "ambiguous",
    chargeCount: row.charge_count,
    reservationCount: row.reservation_count,
  };
}

// True when another reservation or charge of this user already uses the current
// transaction's campus timestamp. Run after the user row lock is held, as its own
// statement, so it sees every booking committed before the lock was granted.
export const PAIRING_STAMP_TAKEN_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM "Reservation"
      WHERE user_id = $1 AND created_at = ${CAMPUS_NOW_SQL}
    )
    OR EXISTS (
      SELECT 1 FROM "CreditTransaction"
      WHERE user_id = $1
        AND transaction_type = 'reservation_charge'
        AND created_at = ${CAMPUS_NOW_SQL}
    ) AS taken
`;

export async function pairingStampTaken(client: DatabaseClient, userId: number): Promise<boolean> {
  const result = await client.query<{ taken: boolean }>(PAIRING_STAMP_TAKEN_SQL, [userId]);
  return Boolean(result.rows[0]?.taken);
}

// ---------------------------------------------------------------------------
// Credit writes. Each one updates the balance and inserts the history row in a
// single statement, so they cannot drift apart. Callers must already hold the
// user's row lock and run inside a transaction.
// ---------------------------------------------------------------------------

// $1 user, $2 credits (positive), $3 reservation. The charge copies the
// reservation's created_at. The balance guard is a backstop for the caller's
// own balance check.
export const CHARGE_RESERVATION_SQL = `
  WITH charged AS (
    UPDATE "User"
    SET credit_balance = credit_balance - $2::integer
    WHERE user_id = $1 AND credit_balance >= $2::integer
    RETURNING user_id, credit_balance
  )
  INSERT INTO "CreditTransaction" (user_id, amount, transaction_type, created_at)
  SELECT charged.user_id, -$2::integer, 'reservation_charge', rv.created_at
  FROM charged
  JOIN "Reservation" AS rv ON rv.reservation_id = $3 AND rv.user_id = charged.user_id
  RETURNING (SELECT credit_balance FROM charged) AS balance_after
`;

// Returns the balance after the charge. Throws when nothing was written, which
// makes the caller's transaction roll back (a data-modifying CTE always runs, so
// a half-applied charge must never be committed).
export async function chargeReservation(
  client: DatabaseClient,
  input: { userId: number; reservationId: number; credits: number },
): Promise<number> {
  const result = await client.query<{ balance_after: number }>(CHARGE_RESERVATION_SQL, [
    input.userId,
    input.credits,
    input.reservationId,
  ]);
  const balance = result.rows[0]?.balance_after;
  if (balance === undefined) {
    throw new Error(`Credit charge for reservation ${input.reservationId} was not recorded.`);
  }
  return balance;
}

// $1 user, $2 credits (positive).
export const REFUND_CREDITS_SQL = `
  WITH refunded AS (
    UPDATE "User"
    SET credit_balance = credit_balance + $2::integer
    WHERE user_id = $1
    RETURNING user_id, credit_balance
  )
  INSERT INTO "CreditTransaction" (user_id, amount, transaction_type, created_at)
  SELECT user_id, $2::integer, 'refund', ${CAMPUS_NOW_SQL}
  FROM refunded
  RETURNING (SELECT credit_balance FROM refunded) AS balance_after
`;

export async function refundCredits(
  client: DatabaseClient,
  input: { userId: number; credits: number },
): Promise<number> {
  const result = await client.query<{ balance_after: number }>(REFUND_CREDITS_SQL, [
    input.userId,
    input.credits,
  ]);
  const balance = result.rows[0]?.balance_after;
  if (balance === undefined) {
    throw new Error(`Credit refund for user ${input.userId} was not recorded.`);
  }
  return balance;
}

export type RefundStatus = "refunded" | "late" | "not_charged" | "unverified";

export type RefundOutcome = { status: RefundStatus; credits: number; balance: number | null };

// Refunds the paired charge of a reservation the caller has just cancelled.
// Callers guarantee the status moved from 'confirmed' to 'cancelled' in this
// transaction, which is what makes a second refund impossible.
export async function refundReservationCharge(
  client: DatabaseClient,
  input: { userId: number; reservationId: number },
): Promise<RefundOutcome> {
  const match = await findReservationCharge(client, input.reservationId);

  if (match.status === "missing") {
    return { status: "not_charged", credits: 0, balance: null };
  }
  if (match.status === "ambiguous") {
    console.warn(
      `Credit refund skipped for reservation ${input.reservationId}: ` +
        `${match.chargeCount} charge(s) and ${match.reservationCount} reservation(s) share its timestamp.`,
    );
    return { status: "unverified", credits: 0, balance: null };
  }

  const balance = await refundCredits(client, { userId: input.userId, credits: match.credits });
  return { status: "refunded", credits: match.credits, balance };
}

export function pluralCredits(credits: number): string {
  return `${credits} credit${credits === 1 ? "" : "s"}`;
}

// Sentence appended to cancellation notifications.
export function refundSentence(outcome: RefundOutcome): string {
  switch (outcome.status) {
    case "refunded":
      return `${pluralCredits(outcome.credits)} refunded.`;
    case "late":
      return `Cancellations less than ${REFUND_NOTICE_HOURS} hours before the start time are not refunded.`;
    case "not_charged":
      return "No credits were charged for this booking, so no refund was issued.";
    case "unverified":
      return "The original credit charge could not be verified automatically, so no refund was issued. Please contact an administrator.";
  }
}

// ---------------------------------------------------------------------------
// Reads for the My Credits page. Every query is scoped to the session user.
// ---------------------------------------------------------------------------

export type CreditSummary = {
  balance: number;
  creditLastReset: string;
  spent: number;
  refunded: number;
  granted: number;
  received: number;
  transactionCount: number;
  // The history adds up to the stored balance, so a running balance is reliable.
  historyMatchesBalance: boolean;
};

export async function getCreditSummary(
  client: DatabaseClient,
  userId: number,
): Promise<CreditSummary | null> {
  const result = await client.query<{
    credit_balance: number;
    credit_last_reset: string;
    spent: number;
    refunded: number;
    granted: number;
    transaction_count: number;
    history_total: number;
  }>(
    `
      SELECT
        u.credit_balance,
        to_char(u.credit_last_reset, 'YYYY-MM-DD') AS credit_last_reset,
        COALESCE(-SUM(ct.amount) FILTER (WHERE ct.transaction_type = 'reservation_charge'), 0)::integer AS spent,
        COALESCE(SUM(ct.amount) FILTER (WHERE ct.transaction_type = 'refund'), 0)::integer AS refunded,
        COALESCE(SUM(ct.amount) FILTER (WHERE ct.transaction_type IN ('initial_grant', 'monthly_reset')), 0)::integer AS granted,
        COUNT(ct.transaction_id)::integer AS transaction_count,
        COALESCE(SUM(ct.amount), 0)::integer AS history_total
      FROM "User" AS u
      LEFT JOIN "CreditTransaction" AS ct ON ct.user_id = u.user_id
      WHERE u.user_id = $1
      GROUP BY u.user_id, u.credit_balance, u.credit_last_reset
    `,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    balance: row.credit_balance,
    creditLastReset: row.credit_last_reset,
    spent: row.spent,
    refunded: row.refunded,
    granted: row.granted,
    received: row.granted + row.refunded,
    transactionCount: row.transaction_count,
    historyMatchesBalance: row.history_total === row.credit_balance,
  };
}

export type CreditTransactionQuery = { filter: CreditFilter; page: number; pageSize: number };

export function parseCreditTransactionQuery(
  params: URLSearchParams,
): Validation<CreditTransactionQuery> {
  const pageRaw = (params.get("page") ?? "").trim();
  const sizeRaw = (params.get("pageSize") ?? "").trim();
  const filterRaw = (params.get("type") ?? "").trim() || "all";

  if (pageRaw && (!/^\d+$/.test(pageRaw) || Number(pageRaw) < 1 || Number(pageRaw) > MAX_CREDIT_PAGE)) {
    return { ok: false, error: "Page must be a positive whole number." };
  }
  if (sizeRaw && (!/^\d+$/.test(sizeRaw) || Number(sizeRaw) < 1)) {
    return { ok: false, error: "Page size must be a positive whole number." };
  }
  if (!Object.hasOwn(CREDIT_FILTERS, filterRaw)) {
    return { ok: false, error: "Type must be one of: all, charges, refunds, grants." };
  }

  return {
    ok: true,
    value: {
      filter: filterRaw as CreditFilter,
      page: pageRaw ? Number(pageRaw) : 1,
      pageSize: sizeRaw ? Math.min(Number(sizeRaw), MAX_CREDIT_PAGE_SIZE) : CREDIT_PAGE_SIZE,
    },
  };
}

export type CreditTransactionItem = {
  id: number;
  type: string;
  amount: number;
  createdAt: string;
  // Running balance after this transaction (ordered by transaction id).
  balanceAfter: number;
  // Only for charges that pair with exactly one reservation; null otherwise.
  reservation: {
    id: number;
    resource: { id: number; name: string };
    building: { name: string };
    startTime: string;
    endTime: string;
  } | null;
};

export type CreditTransactionPage = {
  items: CreditTransactionItem[];
  total: number;
  page: number;
  pageSize: number;
};

type CreditTransactionRow = {
  transaction_id: number;
  amount: number;
  transaction_type: string;
  created_at: string;
  balance_after: number;
  reservation_id: number | null;
  resource_id: number | null;
  resource_name: string | null;
  building_name: string | null;
  start_time: string | null;
  end_time: string | null;
};

// $1 user, $2 transaction types, $3 limit, $4 offset.
// The running balance is computed over the user's whole history before the type
// filter and pagination, in transaction_id order. A user's credit writes all hold
// that user's row lock, so their ids follow the order they were committed.
export const LIST_CREDIT_TRANSACTIONS_SQL = `
  WITH history AS (
    SELECT
      ct.transaction_id,
      ct.user_id,
      ct.amount,
      ct.transaction_type,
      ct.created_at,
      SUM(ct.amount) OVER (ORDER BY ct.transaction_id)::integer AS balance_after
    FROM "CreditTransaction" AS ct
    WHERE ct.user_id = $1
  )
  SELECT
    h.transaction_id,
    h.amount,
    h.transaction_type,
    ${localTimestampSql("h.created_at")} AS created_at,
    h.balance_after,
    booking.reservation_id,
    booking.resource_id,
    booking.resource_name,
    booking.building_name,
    booking.start_time,
    booking.end_time
  FROM history AS h
  LEFT JOIN LATERAL (
    SELECT
      rv.reservation_id,
      r.resource_id,
      r.name AS resource_name,
      b.building_name,
      ${localTimestampSql("rv.start_time")} AS start_time,
      ${localTimestampSql("rv.end_time")} AS end_time
    FROM "Reservation" AS rv
    JOIN "Resource" AS r ON r.resource_id = rv.resource_id
    JOIN "Building" AS b ON b.building_id = r.building_id
    ${pairedChargeJoinSql("rv")}
    WHERE h.transaction_type = 'reservation_charge'
      AND rv.user_id = h.user_id
      AND rv.created_at = h.created_at
      AND ${PAIRED_CHARGE_CREDITS_SQL} IS NOT NULL
  ) AS booking ON TRUE
  WHERE h.transaction_type = ANY($2::varchar[])
  ORDER BY h.transaction_id DESC
  LIMIT $3 OFFSET $4
`;

export const COUNT_CREDIT_TRANSACTIONS_SQL = `
  SELECT COUNT(*)::integer AS total
  FROM "CreditTransaction"
  WHERE user_id = $1 AND transaction_type = ANY($2::varchar[])
`;

export async function listCreditTransactions(
  client: DatabaseClient,
  userId: number,
  query: CreditTransactionQuery,
): Promise<CreditTransactionPage> {
  const types = [...CREDIT_FILTERS[query.filter]];
  const offset = (query.page - 1) * query.pageSize;

  const rows = await client.query<CreditTransactionRow>(LIST_CREDIT_TRANSACTIONS_SQL, [
    userId,
    types,
    query.pageSize,
    offset,
  ]);
  const count = await client.query<{ total: number }>(COUNT_CREDIT_TRANSACTIONS_SQL, [userId, types]);

  return {
    items: rows.rows.map((row) => ({
      id: row.transaction_id,
      type: row.transaction_type,
      amount: row.amount,
      createdAt: row.created_at,
      balanceAfter: row.balance_after,
      reservation:
        row.reservation_id === null || row.resource_id === null
          ? null
          : {
              id: row.reservation_id,
              resource: { id: row.resource_id, name: row.resource_name ?? "" },
              building: { name: row.building_name ?? "" },
              startTime: row.start_time ?? "",
              endTime: row.end_time ?? "",
            },
    })),
    total: count.rows[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}
