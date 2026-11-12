import type { DatabaseClient } from "../client";
import {
  CAMPUS_NOW_SQL,
  localTimestampSql,
  maintenanceOverlapSql,
  parsePositiveId,
  parseSlot,
  reservationOverlapSql,
  slotFitsAvailabilitySql,
  type Slot,
  type Validation,
} from "./resources";
import {
  createReservationCancellationNotification,
  createReservationReminderNotification,
  skipPendingReservationReminders,
} from "./notifications";
import {
  chargeReservation,
  PAIRED_CHARGE_CREDITS_SQL,
  pairedChargeJoinSql,
  pairingStampTaken,
  pluralCredits,
  REFUND_WINDOW_SQL,
  refundReservationCharge,
  refundSentence,
  type RefundOutcome,
  type RefundStatus,
} from "./credits";

export const MIN_RESERVATION_MINUTES = 15;
// Used when a resource does not set its own max_reservation_time.
export const DEFAULT_MAX_RESERVATION_SQL = "interval '4 hours'";

export type Reservation = {
  id: number;
  resource: { id: number; name: string };
  building: { id: number; name: string };
  startTime: string;
  endTime: string;
  status: string;
  createdAt: string;
  canModify: boolean;
  // Credits paid for this booking, or null when no single charge pairs with it
  // (for example, bookings made before credits were charged).
  creditsCharged: number | null;
  // Cancelling now would return creditsCharged.
  refundEligible: boolean;
  // Set when a finished, non-cancelled reservation has not been reviewed yet.
  canReviewResource?: boolean;
  // Set after this reservation has received its resource review.
  resourceReviewSubmitted?: boolean;
};

// Credit movement caused by one reservation request.
export type CreditChange = {
  charged: number;
  refunded: number;
  balance: number;
  refundStatus?: RefundStatus;
};

export type MyReservations = {
  upcoming: Reservation[];
  past: Reservation[];
};

export type ServiceResult<T> =
  | { ok: true; value: T; notificationIds?: number[]; credits?: CreditChange }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      error: string;
      details?: ReservationErrorDetails;
    };

export type ReservationErrorDetails = {
  code: "minimum_user_review_score";
  minUserReviewScore: number;
  userReviewScore: number | null;
  userReviewCount: number;
};

type ReservationRow = {
  reservation_id: number;
  status: string;
  start_time: string;
  end_time: string;
  created_at: string;
  resource_id: number;
  resource_name: string;
  building_id: number;
  building_name: string;
  can_modify: boolean;
  is_upcoming: boolean;
  refund_window_open: boolean;
  credits_charged: number | null;
  can_review_resource?: boolean;
  resource_review_submitted?: boolean;
};

type CheckRow = {
  in_future: boolean;
  too_long: boolean;
  max_minutes: number | string;
  fits_availability: boolean;
  maintenance_conflict: boolean;
  self_conflict: boolean;
  resource_conflict: boolean;
};

const fail = (status: 400 | 403 | 404 | 409, error: string) =>
  ({ ok: false, status, error }) as const;

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export function parseReservationSlot(body: unknown): Validation<Slot> {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const slot = parseSlot(input.date, input.start, input.end);

  if (!slot.ok) return slot;
  if (!slot.value) {
    return { ok: false, error: "Choose a date, start time, and end time." };
  }

  const minutes = (text: string) => {
    const [hours, mins] = text.slice(-5).split(":").map(Number);
    return hours * 60 + mins;
  };
  if (minutes(slot.value.end) - minutes(slot.value.start) < MIN_RESERVATION_MINUTES) {
    return {
      ok: false,
      error: `Reservations must be at least ${MIN_RESERVATION_MINUTES} minutes long.`,
    };
  }

  return { ok: true, value: slot.value };
}

export function parseCreateReservation(
  body: unknown,
): Validation<{ resourceId: number; slot: Slot }> {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawId = input.resourceId;
  const resourceId =
    typeof rawId === "number" || typeof rawId === "string" ? parsePositiveId(String(rawId)) : null;

  if (resourceId === null) {
    return { ok: false, error: "Choose a valid resource." };
  }

  const slot = parseReservationSlot(body);
  if (!slot.ok) return slot;

  return { ok: true, value: { resourceId, slot: slot.value } };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function reservationSelectSql(source: string): string {
  return `
    SELECT
      rv.reservation_id,
      rv.status,
      ${localTimestampSql("rv.start_time")} AS start_time,
      ${localTimestampSql("rv.end_time")} AS end_time,
      ${localTimestampSql("rv.created_at")} AS created_at,
      r.resource_id,
      r.name AS resource_name,
      b.building_id,
      b.building_name,
      (rv.status = 'confirmed' AND rv.start_time > ${CAMPUS_NOW_SQL}) AS can_modify,
      (rv.end_time > ${CAMPUS_NOW_SQL}) AS is_upcoming,
      (rv.start_time - ${CAMPUS_NOW_SQL} >= ${REFUND_WINDOW_SQL}) AS refund_window_open,
      ${PAIRED_CHARGE_CREDITS_SQL} AS credits_charged,
      (
        rv.status IN ('confirmed', 'completed')
        AND rv.end_time <= ${CAMPUS_NOW_SQL}
        AND resource_review.review_id IS NULL
      ) AS can_review_resource,
      (resource_review.review_id IS NOT NULL) AS resource_review_submitted
    FROM ${source} AS rv
    JOIN "Resource" AS r ON r.resource_id = rv.resource_id
    JOIN "Building" AS b ON b.building_id = r.building_id
    LEFT JOIN "ResourceReview" AS resource_review
      ON resource_review.reservation_id = rv.reservation_id
    ${pairedChargeJoinSql("rv")}
  `;
}

export const LOCK_RESOURCE_SQL = `
  SELECT resource_id, required_credits, min_user_review_score
  FROM "Resource"
  WHERE resource_id = $1
  FOR UPDATE
`;

// Serializes one user's bookings across different resources so two parallel
// requests cannot both pass the self-overlap check. NO KEY UPDATE does not block
// foreign-key inserts that reference the user (sessions, notifications). The
// balance it returns is the latest committed value, because the row is locked.
export const LOCK_USER_SQL = `
  SELECT
    u.is_banned,
    u.credit_balance,
    (
      SELECT ROUND(AVG(rr.rating)::numeric, 2)::float8
      FROM "UserReview" AS rr
      WHERE rr.reviewee_user_id = u.user_id
    ) AS user_review_score,
    (
      SELECT COUNT(*)::integer
      FROM "UserReview" AS rr
      WHERE rr.reviewee_user_id = u.user_id
    ) AS user_review_count
  FROM "User" AS u
  WHERE u.user_id = $1
  FOR NO KEY UPDATE
`;

// All slot rules in one round trip, evaluated while the locks are held.
// $1 resource, $2 start, $3 end, $4 user, $5 reservation to ignore (updates only).
export function buildSlotChecksSql(excludeReservation: boolean): string {
  const start = "$2::timestamp";
  const end = "$3::timestamp";
  const exclude = excludeReservation ? "$5::integer" : undefined;
  const maxLength = `COALESCE(r.max_reservation_time, ${DEFAULT_MAX_RESERVATION_SQL})`;

  return `
    SELECT
      ${start} > ${CAMPUS_NOW_SQL} AS in_future,
      (${end} - ${start}) > ${maxLength} AS too_long,
      (EXTRACT(EPOCH FROM ${maxLength}) / 60)::integer AS max_minutes,
      ${slotFitsAvailabilitySql("r.resource_id", start, end)} AS fits_availability,
      ${maintenanceOverlapSql("r.resource_id", start, end)} AS maintenance_conflict,
      EXISTS (
        SELECT 1
        FROM "Reservation" AS mine
        WHERE mine.user_id = $4
          AND mine.status <> 'cancelled'
          AND mine.start_time < ${end}
          AND mine.end_time > ${start}${exclude ? `\n          AND mine.reservation_id <> ${exclude}` : ""}
      ) AS self_conflict,
      ${reservationOverlapSql("r.resource_id", start, end, exclude)} AS resource_conflict
    FROM "Resource" AS r
    WHERE r.resource_id = $1
  `;
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts = [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

// The first failed rule decides the error, from most to least fundamental.
function slotProblem(check: CheckRow): ServiceResult<never> | null {
  if (!check.in_future) {
    return fail(409, "That time has already passed. Choose a time in the future.");
  }
  if (check.too_long) {
    return fail(
      400,
      `This resource can be reserved for at most ${formatMinutes(Number(check.max_minutes))} at a time.`,
    );
  }
  if (!check.fits_availability) {
    return fail(409, "The resource isn't open for that whole time. Check its hours and try again.");
  }
  if (check.maintenance_conflict) {
    return fail(409, "The resource is scheduled for maintenance during that time.");
  }
  if (check.self_conflict) {
    return fail(409, "You already have another reservation that overlaps that time.");
  }
  if (check.resource_conflict) {
    return fail(409, "Someone else has already reserved this resource during that time.");
  }
  return null;
}

function toReservation(row: ReservationRow): Reservation {
  const creditsCharged = row.credits_charged ?? null;
  const reviewState = row.can_review_resource === true
    ? { canReviewResource: true }
    : row.resource_review_submitted === true
      ? { resourceReviewSubmitted: true }
      : {};
  return {
    id: row.reservation_id,
    resource: { id: row.resource_id, name: row.resource_name },
    building: { id: row.building_id, name: row.building_name },
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    createdAt: row.created_at,
    canModify: row.can_modify,
    creditsCharged,
    refundEligible: row.can_modify && Boolean(row.refund_window_open) && creditsCharged !== null,
    ...reviewState,
  };
}

function lockedStateProblem(row: { status: string; started: boolean }): ServiceResult<never> | null {
  if (row.status === "cancelled") {
    return fail(409, "This reservation has been cancelled and can no longer be changed.");
  }
  if (row.status !== "confirmed") {
    return fail(409, "This reservation is already over and can no longer be changed.");
  }
  if (row.started) {
    return fail(409, "This reservation has already started and can no longer be changed.");
  }
  return null;
}

async function inTransaction<T>(
  client: DatabaseClient,
  work: () => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
  await client.query("BEGIN");

  try {
    const result = await work();
    await client.query(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type LockedResourceAndUser = {
  requiredCredits: number;
  creditBalance: number;
  minUserReviewScore: number | null;
  userReviewScore: number | null;
  userReviewCount: number;
};

// Takes the resource lock, then the user lock (always in this order), and
// rejects suspended accounts unless told otherwise.
async function lockResourceAndUser(
  client: DatabaseClient,
  resourceId: number,
  userId: number,
  options: { rejectBanned: boolean } = { rejectBanned: true },
): Promise<ServiceResult<LockedResourceAndUser>> {
  const resource = await client.query<{
    required_credits: number;
    min_user_review_score: number | string | null;
  }>(LOCK_RESOURCE_SQL, [resourceId]);
  if (resource.rows.length === 0) {
    return fail(404, "Resource not found.");
  }

  const user = await client.query<{
    is_banned: boolean;
    credit_balance: number;
    user_review_score: number | string | null;
    user_review_count: number | string;
  }>(LOCK_USER_SQL, [userId]);
  const row = user.rows[0];
  if (!row || (options.rejectBanned && row.is_banned)) {
    return fail(403, "Your account is suspended and cannot make reservations.");
  }

  return {
    ok: true,
    value: {
      requiredCredits: resource.rows[0].required_credits,
      creditBalance: row.credit_balance,
      minUserReviewScore: resource.rows[0].min_user_review_score === null
        ? null
        : Number(resource.rows[0].min_user_review_score),
      userReviewScore: row.user_review_score === null || row.user_review_score === undefined
        ? null
        : Number(row.user_review_score),
      userReviewCount: Number(row.user_review_count ?? 0),
    },
  };
}

function minimumReviewScoreFailure(
  minimum: number | null,
  score: number | null,
  count: number,
): ServiceResult<never> | null {
  if (minimum === null || (score !== null && score >= minimum)) return null;

  return {
    ok: false,
    status: 409,
    error: `You need an average review score of at least ${minimum.toFixed(2)} to reserve this resource.`,
    details: {
      code: "minimum_user_review_score",
      minUserReviewScore: minimum,
      userReviewScore: score,
      userReviewCount: count,
    },
  };
}

async function checkSlot(
  client: DatabaseClient,
  resourceId: number,
  slot: Slot,
  userId: number,
  excludeReservationId?: number,
): Promise<ServiceResult<never> | null> {
  const exclude = excludeReservationId !== undefined;
  const values: unknown[] = [resourceId, slot.start, slot.end, userId];
  if (exclude) values.push(excludeReservationId);

  const result = await client.query<CheckRow>(buildSlotChecksSql(exclude), values);
  const check = result.rows[0];
  if (!check) {
    return fail(404, "Resource not found.");
  }
  return slotProblem(check);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function createReservation(
  client: DatabaseClient,
  userId: number,
  input: { resourceId: number; slot: Slot },
): Promise<ServiceResult<Reservation>> {
  return inTransaction<Reservation>(client, async () => {
    const locked = await lockResourceAndUser(client, input.resourceId, userId);
    if (!locked.ok) return locked;

    const reviewProblem = minimumReviewScoreFailure(
      locked.value.minUserReviewScore,
      locked.value.userReviewScore,
      locked.value.userReviewCount,
    );
    if (reviewProblem) return reviewProblem;

    const problem = await checkSlot(client, input.resourceId, input.slot, userId);
    if (problem) return problem;

    const { requiredCredits, creditBalance } = locked.value;
    if (creditBalance < requiredCredits) {
      return fail(
        409,
        `This booking costs ${pluralCredits(requiredCredits)}, but you have ${pluralCredits(creditBalance)}.`,
      );
    }

    // The charge is paired with the reservation by their shared created_at, so
    // that timestamp must be unused for this user. Only two of the user's
    // requests starting in the same microsecond can collide.
    if (await pairingStampTaken(client, userId)) {
      return fail(409, "Another booking request was being processed at the same moment. Please try again.");
    }

    const inserted = await client.query<ReservationRow>(
      `
        WITH inserted AS (
          INSERT INTO "Reservation" (user_id, resource_id, start_time, end_time, status, created_at)
          VALUES ($1, $2, $3::timestamp, $4::timestamp, 'confirmed', ${CAMPUS_NOW_SQL})
          RETURNING *
        )
        ${reservationSelectSql("inserted")}
      `,
      [userId, input.resourceId, input.slot.start, input.slot.end],
    );
    const reservationId = inserted.rows[0].reservation_id;

    const balance = await chargeReservation(client, {
      userId,
      reservationId,
      credits: requiredCredits,
    });

    const notificationId = await createReservationReminderNotification(client, reservationId);

    // The select above ran in the same statement as the INSERT, so it could not
    // see the charge yet.
    const row = { ...inserted.rows[0], credits_charged: requiredCredits };
    return {
      ok: true,
      value: toReservation(row),
      notificationIds: [notificationId],
      credits: { charged: requiredCredits, refunded: 0, balance },
    };
  });
}

export async function rescheduleReservation(
  client: DatabaseClient,
  userId: number,
  reservationId: number,
  slot: Slot,
): Promise<ServiceResult<Reservation>> {
  return inTransaction<Reservation>(client, async () => {
    const existing = await client.query<{ user_id: number; resource_id: number }>(
      `
        SELECT user_id, resource_id
        FROM "Reservation"
        WHERE reservation_id = $1
      `,
      [reservationId],
    );
    const owner = existing.rows[0];
    if (!owner) return fail(404, "Reservation not found.");
    if (owner.user_id !== userId) return fail(403, "That reservation belongs to someone else.");

    const locked = await lockResourceAndUser(client, owner.resource_id, userId);
    if (!locked.ok) return locked;

    // Re-read under a row lock: a cancel or reschedule may have landed since the
    // unlocked read above.
    const current = await client.query<{ status: string; started: boolean }>(
      `
        SELECT status, start_time <= ${CAMPUS_NOW_SQL} AS started
        FROM "Reservation"
        WHERE reservation_id = $1
        FOR UPDATE
      `,
      [reservationId],
    );
    if (!current.rows[0]) return fail(404, "Reservation not found.");
    const stateProblem = lockedStateProblem(current.rows[0]);
    if (stateProblem) return stateProblem;

    const problem = await checkSlot(client, owner.resource_id, slot, userId, reservationId);
    if (problem) return problem;

    const updated = await client.query<ReservationRow>(
      `
        WITH updated AS (
          UPDATE "Reservation"
          SET start_time = $2::timestamp, end_time = $3::timestamp
          WHERE reservation_id = $1
          RETURNING *
        )
        ${reservationSelectSql("updated")}
      `,
      [reservationId, slot.start, slot.end],
    );

    await skipPendingReservationReminders(
      client,
      reservationId,
      "Reservation was rescheduled.",
    );
    const notificationId = await createReservationReminderNotification(client, reservationId);

    return {
      ok: true,
      value: toReservation(updated.rows[0]),
      notificationIds: [notificationId],
    };
  });
}

export async function cancelReservation(
  client: DatabaseClient,
  userId: number,
  reservationId: number,
): Promise<ServiceResult<Reservation>> {
  return inTransaction<Reservation>(client, async () => {
    const existing = await client.query<{ user_id: number; resource_id: number }>(
      `
        SELECT user_id, resource_id
        FROM "Reservation"
        WHERE reservation_id = $1
      `,
      [reservationId],
    );
    const owner = existing.rows[0];
    if (!owner) return fail(404, "Reservation not found.");
    if (owner.user_id !== userId) return fail(403, "That reservation belongs to someone else.");

    // Same order as booking and rescheduling: resource, user, then reservation.
    // Cancelling was never blocked for suspended accounts, so it still is not.
    const locked = await lockResourceAndUser(client, owner.resource_id, userId, { rejectBanned: false });
    if (!locked.ok) return locked;

    const current = await client.query<{ status: string; started: boolean; refund_window_open: boolean }>(
      `
        SELECT status, start_time <= ${CAMPUS_NOW_SQL} AS started,
          (start_time - ${CAMPUS_NOW_SQL} >= ${REFUND_WINDOW_SQL}) AS refund_window_open
        FROM "Reservation"
        WHERE reservation_id = $1
        FOR UPDATE
      `,
      [reservationId],
    );
    const row = current.rows[0];
    if (!row) return fail(404, "Reservation not found.");

    const stateProblem = lockedStateProblem(row);
    if (stateProblem) return stateProblem;

    // The confirmed -> cancelled transition happens once; the refund below is
    // tied to it, so a reservation can never be refunded twice.
    const updated = await client.query<ReservationRow>(
      `
        WITH updated AS (
          UPDATE "Reservation"
          SET status = 'cancelled'
          WHERE reservation_id = $1 AND status = 'confirmed'
          RETURNING *
        )
        ${reservationSelectSql("updated")}
      `,
      [reservationId],
    );
    const cancelled = updated.rows[0];
    if (!cancelled) {
      return fail(409, "This reservation has been cancelled and can no longer be changed.");
    }

    const outcome: RefundOutcome = row.refund_window_open
      ? await refundReservationCharge(client, { userId, reservationId })
      : { status: "late", credits: 0, balance: null };

    await skipPendingReservationReminders(
      client,
      reservationId,
      "Reservation was cancelled.",
    );
    const notificationId = await createReservationCancellationNotification(client, {
      userId,
      reservationId,
      message: `You cancelled your reservation for ${cancelled.resource_name} in ${cancelled.building_name} on ${cancelled.start_time}–${cancelled.end_time}. ${refundSentence(outcome)}`,
    });

    return {
      ok: true,
      value: toReservation(cancelled),
      notificationIds: [notificationId],
      credits: {
        charged: 0,
        refunded: outcome.credits,
        balance: outcome.balance ?? locked.value.creditBalance,
        refundStatus: outcome.status,
      },
    };
  });
}

export async function listMyReservations(
  client: DatabaseClient,
  userId: number,
): Promise<MyReservations> {
  const result = await client.query<ReservationRow>(
    `
      ${reservationSelectSql('"Reservation"')}
      WHERE rv.user_id = $1
      ORDER BY rv.start_time ASC, rv.reservation_id ASC
    `,
    [userId],
  );

  const upcoming = result.rows.filter((row) => row.is_upcoming).map(toReservation);
  const past = result.rows
    .filter((row) => !row.is_upcoming)
    .map(toReservation)
    .reverse();

  return { upcoming, past };
}
